/**
 * Headless-исполнитель flow'ов authentik (Flow Executor API).
 *
 * Протокол (см. https://api.goauthentik.io/flow-executor):
 *
 *   1. GET  /api/v3/flows/executor/<slug>/?query=   → первый challenge
 *   2. читаем `component`, отправляем POST с тем же `component` + поля стадии
 *   3. ответ — либо следующий challenge, либо RedirectChallenge
 *   4. повторяем, пока не получим финальный редирект или access-denied
 *
 * Три тонкости, без которых реализация разваливается:
 *
 *  * **Состояние в HTTP-сессии.** План flow'а лежит в django-session, ключ — в
 *    cookie `authentik_session`. Не переносить cookie между запросами — каждый
 *    POST начинает flow заново, и признак ровно один: после отправки пароля
 *    приходит тот же самый challenge. Поэтому `FlowExecutorSession` держит
 *    собственный jar.
 *
 *  * **`query` обязан быть одинаковым во всех запросах.** Executor переносит его
 *    в сессию и использует при построении редиректов и финального `next`. Мы
 *    ничего туда не кладём (`?query=` пустой) и держим строку неизменной:
 *    authentik сам подставит её в `to`, а любое расхождение сбрасывает план.
 *
 *  * **CSRF включается не сразу.** `SessionAuthentication` DRF пропускает
 *    запрос без проверки, если `request.user` анонимен (у `AnonymousUser`
 *    `is_active == False`). Значит все POST'ы до стадии user_login проходят без
 *    токена. Но после логина сессия становится аутентифицированной, и каждый
 *    последующий POST уже требует `X-authentik-csrf`. Отсюда условная отправка:
 *    заголовок добавляется только когда в jar появился cookie `authentik_csrf`.
 *    Иначе recovery/enrollment-цепочки, которые завершаются логином, начнут
 *    падать на 403 в самый неожиданный момент.
 *
 * Ещё одна ловушка: стадия может отклонить данные не телом, а редиректом.
 * Дефолт binding'а — `invalid_response_action=RETRY` (в модели это
 * `default=InvalidResponseAction.RETRY`), и тогда неверный пароль приходит как
 * тот же challenge с `response_errors` и HTTP 400 — штатная ветка выше. Но если
 * кто-нибудь поставит RESTART или RESTART_WITH_CONTEXT, ответом будет голый 302
 * на перезапуск flow, который fetch следует сам и приносит снова тот же
 * challenge, уже без ошибок. Без защиты это бесконечный цикл, поэтому считаем
 * повторы одной и той же стадии и превращаем второй повтор в явный отказ.
 */

import {AuthentikError} from "./authentik.error.js";
import type {AkUserSummary} from "./authentik.api.js";

/** Тело challenge'а: набор полей зависит от стадии, поэтому тип мягкий. */
interface Challenge {
    component?: string;
    /** Для xak-flow-redirect: куда вести дальше и завершён ли flow. */
    to?: string;
    final_redirect?: boolean;
    /** Ошибки валидации по полям, когда стадия приняла данные неверно. */
    response_errors?: Record<string, unknown>;
    /** identification: нужны ли поля пароля в том же запросе (combo-режим). */
    password_fields?: boolean;
    [key: string]: unknown;
}

const MAX_HOPS = 12;
/** Сколько раз одна стадия может попросить данные, прежде чем сочтём это отказом. */
const MAX_ATTEMPTS_PER_COMPONENT = 2;

export class FlowExecutorSession {
    private readonly jar = new Map<string, string>();

    constructor(
        private readonly baseUrl: string,
        private readonly timeout: number = 8000
    ) {}

    private url(path: string): string {
        if (/^https?:\/\//i.test(path)) return path;
        return new URL(path, this.baseUrl).toString();
    }

    private cookieHeader(): string {
        return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }

    private absorbCookies(response: Response) {
        // getSetCookie() нужен, потому что несколько Set-Cookie сливаются в одно
        // поле через ", " и обычный headers.get() их не различает: cookie
        // `authentik_session` и `authentik_csrf` приходят вместе.
        const raw = typeof response.headers.getSetCookie === "function"
            ? response.headers.getSetCookie()
            : [response.headers.get("set-cookie")].filter(Boolean) as string[];
        for (const line of raw) {
            const [pair] = line.split(";");
            const eq = pair?.indexOf("=");
            if (!pair || eq === undefined || eq <= 0) continue;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            if (value === "") this.jar.delete(name);
            else this.jar.set(name, value);
        }
    }

    private async request(url: string, init: RequestInit): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        const headers = new Headers(init.headers);
        headers.set("Accept", "application/json");
        const cookie = this.cookieHeader();
        if (cookie) headers.set("Cookie", cookie);
        // CSRF-заголовок нужен только после того, как сессия аутентифицирована.
        const csrf = this.jar.get("authentik_csrf");
        if (csrf) headers.set("X-authentik-csrf", csrf);
        try {
            const response = await fetch(url, {...init, headers, signal: controller.signal});
            this.absorbCookies(response);
            return response;
        } catch (error) {
            throw AuthentikError.unreachable(`запрос к authentik не прошёл: ${url}`, error);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Один шаг executor'а: GET без тела или POST с ответом стадии.
     *
     * Возвращает и статус, и тело, потому что authentik сообщает ошибки валидации
     * телом challenge'а с HTTP 400 (`ChallengeStageView.challenge_invalid`
     * дописывает `response_errors` в обычный challenge и отдаёт 400). Значит 400
     * — это не сбой соединения, а ответ стадии, и бросать на нём исключение
     * нельзя: мы потеряем разбор «неверный пароль».
     */
    private async challenge(url: string, body?: Record<string, unknown>): Promise<{status: number; challenge: Challenge}> {
        const response = await this.request(url, body
            ? {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(body)
            }
            : {method: "GET"});
        const text = await response.text().catch(() => "");
        // 5xx — серверная ошибка: аутентификацию нельзя считать проваленной.
        if (response.status >= 500) {
            throw AuthentikError.fromResponse(response.status, text);
        }
        if (!text) {
            if (!response.ok) throw AuthentikError.fromResponse(response.status, text);
            return {status: response.status, challenge: {}};
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            // HTML вместо JSON означает, что мы ушли не в API-ветку (например,
            // executor отдал страницу). Это рассинхрон версий, а не пароль.
            throw AuthentikError.misconfigured("authentik вернул не-JSON на flow executor'е", response.status, text);
        }
        // 400/422 — ошибки валидации стадии, разбираются вызывающим кодом.
        // Прочие 4xx (401/403/404) — конфигурация или протокол: исключение.
        if (!response.ok && response.status !== 400 && response.status !== 422) {
            throw AuthentikError.fromResponse(response.status, text);
        }
        return {status: response.status, challenge: parsed as Challenge};
    }

    /**
     * Первый challenge без пароля — проверить только, что flow существует и
     * начинается с ожидаемой стадии.
     *
     * Отдельный вход нужен диагностике (`ak-check.ts`, шаг 3): `runFlow` со
     * заведомо неверным паролем не отличает «slug не найден» (404) от «пароль
     * не подошёл» (response_errors), а выглядят они для наблюдающего одинаково
     * — «вход не работает». Здесь же видно конкретнее: 404 значит «flow с таким
     * slug не заведён», `component` без `ak-stage-identification` — «первая
     * стадия не та» (например, кто-то добавил captcha или поставил порядок
     * биндингов иначе).
     *
     * Ничего не пишет в authentik: GET по executor только создаёт flow session
     * и отдаёт challenge, событий `login_failed` от него не возникает.
     */
    async initialChallenge(flowSlug: string): Promise<{status: number; component: string; passwordFields: boolean}> {
        const step = await this.challenge(this.url(`/api/v3/flows/executor/${encodeURIComponent(flowSlug)}/?query=`));
        return {
            status: step.status,
            component: step.challenge.component ?? "",
            passwordFields: step.challenge.password_fields === true,
        };
    }

    /**
     * Прогнать flow аутентификации для пары логин/пароль.
     *
     * Возвращает вердикт, но не бросает исключение на «неверный пароль»:
     * различие «отказ» / «не дошли» критично для фолбэка на bcrypt.
     */
    async runFlow(flowSlug: string, credentials: {username: string; password: string}): Promise<
        {ok: true} | {ok: false; reason: "invalid" | "denied" | "unsupported"; detail?: string}
    > {
        // Пустой `query` — намеренно: держим его идентичным во всех запросах.
        const start = this.url(`/api/v3/flows/executor/${encodeURIComponent(flowSlug)}/?query=`);
        let step = await this.challenge(start);
        let url = start;
        const attempts = new Map<string, number>();

        for (let hop = 0; hop < MAX_HOPS; hop++) {
            const next = step.challenge;
            const component = next.component ?? "";

            // Ошибки валидации смотрим ПЕРВЫМИ, до разбора component: на 400
            // authentik возвращает тот же самый challenge, что показывал стадию,
            // и только дополняет его response_errors. Иначе приняли бы повтор
            // identification за новый шаг и ушли в бесконечный цикл.
            if (next.response_errors) {
                // Для password/identification это ровно «неверный пароль», для
                // прочих стадий — неверные данные пользователя.
                return {ok: false, reason: "invalid", detail: extractErrors(next.response_errors)};
            }

            if (component === "xak-flow-redirect") {
                if (next.final_redirect === true) return {ok: true};
                const to = next.to ?? "";
                // Редирект вне API executor'а — значит план исчерпан и authentik
                // указывает на UI-страницу (`/`, launch URL приложения). Идти туда
                // некуда: fetch принёс бы HTML, а попытка распарсить его дала бы
                // ложный «transport-сбой». Считаем flow завершённым и подтверждаем
                // его отдельно вызовом whoAmI() — вердикт берём не из редиректа, а
                // из состояния сессии.
                if (!to.includes("/api/v3/flows/executor/")) return {ok: true};
                url = this.url(to);
                step = await this.challenge(url);
                continue;
            }

            if (component === "ak-stage-access-denied") {
                return {ok: false, reason: "denied", detail: extractMessage(next)};
            }

            const seen = (attempts.get(component) ?? 0) + 1;
            attempts.set(component, seen);
            if (seen > MAX_ATTEMPTS_PER_COMPONENT) {
                // Второй повтор одной стадии без response_errors — это перезапуск
                // flow после неверных данных (invalid_response_action=RESTART или
                // RESTART_WITH_CONTEXT). При дефолтном RETRY сюда не попадаем:
                // отказ приходит телом с response_errors и обрабатывается выше.
                return {ok: false, reason: "invalid", detail: `стадия ${component} повторяется: данные отклонены`};
            }

            const body = this.answerFor(component, next, credentials);
            if (!body) {
                return {ok: false, reason: "unsupported", detail: `стадия ${component} не поддерживается headless-входом`};
            }
            step = await this.challenge(url, body);
        }
        return {ok: false, reason: "unsupported", detail: "flow не завершился за отведённое число шагов"};
    }

    /**
     * Собрать ответ стадии.
     *
     * Dispatch идёт по `component`, а не по фиксированному порядку: тот же flow
     * даёт разные последовательности в зависимости от политик, включённого MFA и
     * настроек identification (combo-режим с полем пароля).
     */
    private answerFor(component: string, challenge: Challenge, credentials: {username: string; password: string}): Record<string, unknown> | null {
        switch (component) {
            case "ak-stage-identification": {
                const body: Record<string, unknown> = {component, uid_field: credentials.username};
                // Combo-режим: у identification выбран password stage, и пароль
                // проверяется прямо здесь, отдельной стадии password не будет.
                if (challenge.password_fields === true) body.password = credentials.password;
                return body;
            }
            case "ak-stage-password":
                return {component, password: credentials.password};
            case "ak-stage-user-login":
                // Поле обязательное: remember_me запрашивается только когда
                // настроен remember_me_offset, но serializer требует его всегда.
                return {component, remember_me: false};
            default:
                return null;
        }
    }

    /**
     * Кто сидит в этой сессии.
     *
     * Отдельный запрос после завершения flow, а не доверие тому, что мы сами
     * отправили в identification: только так узнаём реальный uid и замечаем,
     * если политика развернула вход в другую учётку.
     */
    async whoAmI(): Promise<AkUserSummary | null> {
        const response = await this.request(this.url("/api/v3/core/users/me/"), {method: "GET"});
        if (response.status === 401 || response.status === 403) return null;
        if (!response.ok) throw AuthentikError.fromResponse(response.status, await response.text().catch(() => ""));
        const payload = await response.json() as {user?: {uid?: string; username?: string; email?: string; name?: string; attributes?: Record<string, unknown>}};
        const user = payload.user;
        if (!user?.uid || !user?.username) return null;
        return {
            uid: user.uid,
            username: user.username,
            email: user.email ?? "",
            name: user.name ?? "",
            attributes: user.attributes ?? {}
        };
    }
}

function extractMessage(challenge: Challenge): string {
    const detail = challenge["detail"] ?? challenge["title"];
    return typeof detail === "string" ? detail : "";
}

/** DRF отдаёт ошибки по полям; сводим к одной строке для логов и ответа клиенту. */
function extractErrors(errors: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(errors)) {
        if (typeof value === "string") parts.push(`${field}: ${value}`);
        else if (Array.isArray(value)) parts.push(`${field}: ${value.map(String).join(", ")}`);
        else parts.push(`${field}: ${JSON.stringify(value)}`);
    }
    return parts.join("; ");
}
