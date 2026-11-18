/**
 * Клиент authentik для схемы «вход без его интерфейса» (headless).
 *
 * ## Почему не OIDC
 *
 * Штатный OIDC-флоу всегда показывает пользователю страницы authentik, а по
 * требованию сервиса он не должен видеть ничего, кроме наших форм. В 2026.8 нет
 * grant_type=password (запрос сводится к client_credentials), поэтому «обменять
 * логин/пароль на токен одним POST'ом» тоже невозможно.
 *
 * Остаётся Flow Executor API — тот же механизм, на котором работает веб-интерфейс
 * authentik, но вызываемый сервером. Наш backend сам проходит цепочку стадий,
 * держа cookie-сессию executor'а, и получает от authentik только вердикт.
 * Браузер пользователя на authentik не ходит никогда: ни /if/flow/, ни
 * /application/o/authorize/. Отсюда следует важное:
 *
 *   - id_token не выдаётся, поэтому проверять подписи, discovery и JWKS нечего —
 *     этот слой здесь отсутствует намеренно;
 *   - источник истины о пароле — authentik, а локальный bcrypt-хэш в `users`
 *     служит только фолбэком на время простоя authentik;
 *   - сессия executor'а живёт на стороне backend'а и после входа нам не нужна:
 *     пользователь выходит через нашу же ручку signout.
 *
 * ## Разделение ответственности
 *
 *   - authentik: пароль, username, email, name, кастомные атрибуты профиля;
 *   - inf54: `id`, `isAdmin`, `codeforcesHandle`, собственные сессии и JWT.
 *
 * Связка — `users.authentikUid`. Остальные сервисы (contest/event/discussion)
 * продолжают ходить через внутренний SSO `/api/apps/oauth`, их логика здесь не
 * задействована.
 *
 * ## Верификация результата входа
 *
 * Мы не считаем вход успешным только потому, что flow завершился. После этого
 * отдельным запросом `/core/users/me/` с той же cookie-сессией спрашиваем, кто
 * именно в ней сидит, и сверяем с тем, что ввёл пользователь (username или email
 * — IdentificationStage принимает оба). Это закрывает случай, когда цепочку
 * стадий развернуло политикой в другую учётку.
 *
 * ## Когда положено откатываться на локальный bcrypt
 *
 * Только при транспортном сбое (authentik не отвечает, 5xx, таймаут). При
 * неверном пароле отката нет: иначе обход политик authentik (например,
 * reputation-политики) превращается в бесплатный брутфорс локального хэша.
 * Различение делает `AuthentikError.transport`.
 */

import {AuthentikError} from "./authentik.error.js";
import {FlowExecutorSession} from "./authentik.executor.js";
import {akApi, type AkUser, type AkUserSummary} from "./authentik.api.js";

const AK_URL = process.env.AK_URL ?? "http://authentik:9000";
const AK_API_TOKEN = process.env.AK_API_TOKEN ?? "";
/** Slug flow'а аутентификации, который ведёт наш вход. Заводится в Web UI authentik. */
const AK_AUTH_FLOW = process.env.AK_AUTH_FLOW ?? "inf54-login";
/** Путь, в котором authentik создаёт наших пользователей (для фильтрации в админке). */
const AK_USER_PATH = process.env.AK_USER_PATH ?? "inf54";
const AK_TIMEOUT = Number(process.env.AK_TIMEOUT ?? 8000);

export {AuthentikError, akApi};
export type {AkUser, AkUserSummary};
export {AK_USER_PATH, AK_URL, AK_TIMEOUT, AK_AUTH_FLOW};

/**
 * Активен ли authentik.
 *
 * Проверяем только наличие API-токена: client secret для headless-входа не нужен
 * вовсе. Если токена нет, сервис работает ровно так же, как до интеграции, — по
 * локальному bcrypt. Так интеграцию включают без риска сломать вход.
 */
export function akEnabled(): boolean {
    return AK_API_TOKEN.length > 0;
}

/** Результат попытки входа. */
export type AuthResult =
    | {ok: true; user: AkUserSummary}
    /** Пароль не подошёл или доступ запрещён политикой. Фолбэк запрещён. */
    | {ok: false; transport: false; reason: "invalid" | "denied" | "unsupported"; detail?: string}
    /** До authentik не дошли: сеть, 5xx, таймаут. Разрешён локальный фолбэк. */
    | {ok: false; transport: true; detail: string};

/**
 * Проверить пару логин/пароль штатной цепочкой стадий authentik.
 *
 * Возвращает различённый результат, а не бросает исключение: вызывающий код
 * обязан понимать, «неверный пароль» или «authentik лежит», и вести себя по-разному.
 */
export async function authenticateUser(username: string, password: string): Promise<AuthResult> {
    if (!akEnabled()) {
        return {ok: false, transport: true, detail: "authentik выключен (нет AK_API_TOKEN)"};
    }
    const session = new FlowExecutorSession(AK_URL, AK_TIMEOUT);
    try {
        const outcome = await session.runFlow(AK_AUTH_FLOW, {username, password});
        if (!outcome.ok) {
            return {ok: false, transport: false, reason: outcome.reason, detail: outcome.detail};
        }
        // Flow завершился, но кто в сессии — спрашиваем у authentik.
        const me = await session.whoAmI();
        if (!me) {
            return {ok: false, transport: false, reason: "denied", detail: "сессия осталась анонимной"};
        }
        // Сверяем идентификатор, который ввёл пользователь. Он может быть и
        // email: identification stage ищет по тому списку полей, что задан в
        // `user_fields` (у нас username и email), поэтому требовать совпадения
        // именно с username значило бы сломать вход по почте. По имени (`name`)
        // сопоставления нет намеренно: в 2026.8 поле `name` вообще не входит в
        // допустимые значения `user_fields`, а имена не уникальны — такое
        // сравнение разрешало бы входить в чужую учётку.
        const identifier = username.trim().toLowerCase();
        const matches = identifier === me.username.toLowerCase() || identifier === me.email.toLowerCase();
        if (!matches) {
            // Цепочка стадий привела не в ту учётку (политика, source, user switch).
            return {
                ok: false,
                transport: false,
                reason: "denied",
                detail: `authentik вернул другого пользователя: ${me.username}`
            };
        }
        return {ok: true, user: me};
    } catch (error) {
        if (error instanceof AuthentikError && error.transport) {
            return {ok: false, transport: true, detail: error.toString()};
        }
        // Неожиданный ответ/конфигурация: считаем отказом аутентификации, но
        // громко пишем в лог — такие случаи означают рассинхрон версий authentik.
        console.error("authentik: неожиданная ошибка flow executor'а", error);
        return {
            ok: false,
            transport: false,
            reason: "unsupported",
            detail: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Минимальный набор полей локальной строки, нужный для синхронизации профиля.
 *
 * Принимаем структуру, а не id, чтобы не дёргать базу повторно из каждого места,
 * где меняется профиль (регистрация, вход, /me, восстановление).
 */
export interface LocalProfile {
    id: number;
    username: string;
    email: string;
    firstName: string;
    lastName: string;
    attributes?: Record<string, unknown>;
    /** Уже известная привязка; null — учётки в authentik пока нет. */
    authentikUid?: string | null;
}

/** Собрать `name` authentik из наших имени/фамилии. */
function akName(local: LocalProfile): string {
    return `${local.firstName} ${local.lastName}`.trim() || local.username;
}

/** Атрибуты, которые мы пишем в authentik: наш id переживает смену username. */
function akAttributes(local: LocalProfile): Record<string, unknown> {
    // Строка, а не число: фильтр `attributes` в Admin API сравнивает значения
    // JSONField точно, и `5` (число) не совпадёт с искомой `"5"`.
    return {inf54UserId: String(local.id), ...(local.attributes ?? {})};
}

/**
 * Найти учётку authentik для локального пользователя.
 *
 * Порядок поиска важен: сначала по атрибуту `inf54UserId`, и только потом по
 * username. Username у нас правится через /me, и после смены поиск по нему
 * перестал бы находить ту же учётку — привязка потерялась бы, а повторная
 * регистрация упёрлась бы в занятый email.
 */
async function findAkUser(local: LocalProfile): Promise<AkUser | null> {
    if (local.authentikUid) {
        const byUid = await akApi.findUserByUid(local.authentikUid);
        if (byUid) return byUid;
        // Привязка есть, а учётки нет — значит её удалили в authentik. Падаем
        // вниз, чтобы создать заново, а не считать это недоступностью сервиса.
    }
    const byId = await akApi.findUserByInf54Id(local.id);
    if (byId) return byId;
    return akApi.findUserByUsername(local.username);
}

/**
 * Ленная миграция и регистрация: убедиться, что учётка в authentik есть.
 *
 * До интеграции пароли жили только в bcrypt-хэше у нас, а в authentik их нет:
 * `set_password_hash` принимает только формат Django, так что импортировать
 * `$2b$...` туда нельзя. Поэтому заводим учётку при первом успешном входе,
 * когда raw-пароль ещё известен — он только что пришёл из формы.
 *
 * Локальный хэш при этом НЕ удаляем: он зеркало, по которому вход продолжается,
 * пока authentik лежит.
 *
 * Возвращает uid учётки в authentik (существующей или вновь созданной).
 */
export async function ensureUserForLocal(local: LocalProfile, password: string): Promise<string> {
    const existing = await findAkUser(local);
    if (existing) {
        // Синхронизируем профиль, но пароль не перезаписываем: его мог сменить
        // администратор прямо в authentik, и наша копия тогда устарела.
        await akApi.patchUser(existing.uid, {
            username: local.username,
            name: akName(local),
            email: local.email,
            attributes: akAttributes(local)
        }).catch(error => console.warn("authentik: patchUser failed", local.username, String(error)));
        return existing.uid;
    }
    const created = await akApi.createUser({
        username: local.username,
        name: akName(local),
        email: local.email,
        attributes: akAttributes(local),
        path: AK_USER_PATH
    });
    // Обязательный второй шаг: POST /core/users/ поле password не принимает
    // (оно доступно только в контексте blueprint'а), без этого вызова учётка
    // осталась бы с unusable password и вход в неё был бы невозможен.
    await akApi.setPassword(created.uid, password);
    return created.uid;
}

/**
 * Обновить профиль в authentik (username, email, имя, атрибуты).
 *
 * Вызывается из /me: authentik — источник истины для этих полей, а вход идёт по
 * его username, поэтому локальная правка без синхронизации означала бы, что
 * пользователь не сможет войти под новым именем.
 *
 * Если учётки в authentik ещё нет, молча выходим: создавать её без пароля
 * смысла нет, это сделает `ensureUserForLocal` при первом входе.
 */
export async function syncProfile(local: LocalProfile): Promise<void> {
    if (!akEnabled()) return;
    const existing = await findAkUser(local);
    if (!existing) {
        console.warn("authentik: профиль изменён локально, учётка ещё не создана", local.username);
        return;
    }
    await akApi.patchUser(existing.uid, {
        username: local.username,
        name: akName(local),
        email: local.email,
        attributes: akAttributes(local)
    });
}

/**
 * Сменить пароль в authentik.
 *
 * Отдельная функция, а не вызов `setPassword` из роутера, потому что здесь
 * есть развилка: если учётки ещё нет (регистрация прошла во время простоя
 * authentik), новый пароль — как раз то, чем её надо создать.
 *
 * Возвращает актуальный uid. Бросает `AuthentikError`, если authentik не
 * ответил: вызывающий код обязан не писать локальный хэш в этом случае, иначе
 * зеркала разойдутся и пользователь потеряет доступ после починки сервиса.
 */
export async function setPasswordFor(local: LocalProfile, newPassword: string): Promise<string> {
    const existing = await findAkUser(local);
    if (!existing) {
        // Пароль известен в открытом виде — можно создать учётку целиком.
        return ensureUserForLocal({...local, authentikUid: null}, newPassword);
    }
    await akApi.setPassword(existing.uid, newPassword);
    return existing.uid;
}
