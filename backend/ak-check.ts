/**
 * Диагностика связки inf54 ↔ authentik.
 *
 * Прогоняет ровно те четыре шага, что описаны в разделе 9.1 инструкции
 * `authentik/AUTHENTIK-SETUP.md`, и печатает, что сломалось, если сломалось.
 *
 * Важно: скрипт ходит по тем же функциям, что продакшн-код, а не дублирует их.
 * Админ API — `akApi` из authentik.ts, flow — `FlowExecutorSession`, вердикт
 * входа — `authenticateUser`. Если что-то из этого расходится с authentik,
 * скрипт падает там же, где упадёт вход пользователя, а не показывает зелёный
 * экран и скрывает поломку.
 *
 * Ничего не меняет в authentik: одни GET-ы плюс POST по executor'у с теми
 * данными, которые ты сам передал в AK_CHECK_LOGIN/AK_CHECK_PASSWORD. Учётную
 * запись не создаёт, группы не трогает, атрибуты не пишет.
 *
 * Запуск (образ oven/bun, исходники лежат в /app):
 *
 *   podman exec -it <backend-контейнер> bun ./ak-check.ts
 *
 * Шаг 4 требует реальных данных, поэтому он пропускается, пока не заданы
 * переменные. Пароль передаём только окружением: в argv он виден в `ps` и
 * остаётся в истории оболочки.
 *
 *   podman exec -it <backend-контейнер> \
 *     env AK_CHECK_LOGIN=<логин> AK_CHECK_PASSWORD=<пароль> bun ./ak-check.ts
 *
 * Код возврата: 0 — все выполненные шаги прошли, 1 — хотя бы один упал.
 * Пропущенные шаги не считаются падением: без токена и без данных входа
 * проверяется только конфиг flow, и этого достаточно на пустом стенде.
 */
import {AK_AUTH_FLOW, AK_TIMEOUT, AK_URL, AuthentikError, akApi, akEnabled, authenticateUser} from "./authentik.js";
import {FlowExecutorSession} from "./authentik.executor.js";

type Step = {
    title: string;
    /** null — шаг не выполнялся (нет токена или нет данных входа). */
    ok: boolean | null;
    note: string;
};

/** Короткое человекочитаемое пояснение к ошибке authentik. */
function describe(error: unknown): string {
    if (error instanceof AuthentikError) {
        const hint =
            error.status === 401 || error.status === 403
                ? "токен не принят или у service account нет прав"
                : error.status === 404
                  ? "адрес или slug не найдены"
                  : error.transport && error.status === 0
                    ? "authentik не отвечает"
                    : "";
        const body = error.body ? ` :: ${trimBody(error.body)}` : "";
        return `${error.message}${hint ? ` (${hint})` : ""}${body}`;
    }
    return error instanceof Error ? error.message : String(error);
}

/** Тело ответа обычно JSON с `detail` или словарём ошибок — вытаскиваем суть. */
function trimBody(body: string): string {
    const text = body.trim();
    if (!text.startsWith("{")) return text.slice(0, 240);
    try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const detail = typeof parsed.detail === "string" ? parsed.detail : "";
        if (detail) return detail.slice(0, 240);
        const parts = Object.entries(parsed).map(([field, value]) => {
            if (Array.isArray(value)) return `${field}: ${value.map(String).join(", ")}`;
            if (typeof value === "object" && value !== null) return `${field}: ${JSON.stringify(value)}`;
            return `${field}: ${String(value)}`;
        });
        return parts.join("; ").slice(0, 240);
    } catch {
        return text.slice(0, 240);
    }
}

/**
 * Шаг 1 и 2: admin API.
 *
 * Первый отвечает «кто я вообще» по токену, второй — что фильтр по нашим
 * атрибутам принимает запрос. Шаги разные, но падают одинаково: 401/403 на
 * любом из них означает одно и то же — токен перевыпустили или у service
 * account сняли права `view_user`. Поэтому по результату сразу видно, раздел 4
 * или раздел 5 чинить.
 */
async function stepWhoami(): Promise<Step> {
    const step: Step = {title: "admin api: кто этот токен", ok: null, note: ""};
    if (!akEnabled()) {
        step.note = "пропущено: AK_API_TOKEN пуст, admin API не используется";
        return step;
    }
    try {
        const me = await akApi.whoami();
        if (!me) {
            step.ok = false;
            step.note = "/core/users/me/ ответил без профиля (нет ключа user)";
            return step;
        }
        step.ok = true;
        step.note = `${me.username} · uid ${me.uid}${me.is_superuser ? " · superuser" : ""}`;
    } catch (error) {
        step.ok = false;
        step.note = describe(error);
    }
    return step;
}

/**
 * Шаг 2: поиск по атрибуту.
 *
 * Пробуем заведомо несуществующий `inf54UserId`, а не реальный: цель — убедиться,
 * что фильтр по атрибуту принимает запрос и возвращает пустой список, а не найти
 * кого-то. Ключ именно такой, как пишет его продакшн-код: `findUserByInf54Id`
 * ищет по `attributes__inf54UserId` и сравнивает строкой (`String(id)`), поэтому
 * промах даёт пустой `results`, а не ошибку. Значение берём в границах int32 —
 * 2147483647 заведомо не занято, и при этом остаётся правдоподобным id: за
 * пределы диапазона уходить незачем, а выглядит оно как опечатка.
 *
 * Если задан AK_CHECK_LOGIN, дополнительно проверяем точный поиск по username —
 * им же потом будет выполнен вход, так что ошибка видна заранее.
 */
async function stepSearch(): Promise<Step> {
    const step: Step = {title: "admin api: поиск по атрибуту", ok: null, note: ""};
    if (!akEnabled()) {
        step.note = "пропущено: AK_API_TOKEN пуст";
        return step;
    }
    const probeId = Number(process.env.AK_CHECK_INF54_ID ?? 2_147_483_647);
    const notes: string[] = [];
    try {
        const found = await akApi.findUserByInf54Id(probeId);
        notes.push(found ? `inf54UserId=${probeId} занят: ${found.username}` : `inf54UserId=${probeId} → пусто`);
        step.ok = true;
    } catch (error) {
        step.ok = false;
        notes.push(describe(error));
        step.note = notes.join("; ");
        return step;
    }
    const login = process.env.AK_CHECK_LOGIN ?? "";
    if (login) {
        try {
            const user = await akApi.findUserByUsername(login);
            notes.push(user ? `логин ${login} → uid ${user.uid}` : `логин ${login} → не найден`);
            // Не найденный логин — ещё не провал шага 2: поиск работает, просто
            // учётки нет. Провал будет на шаге 4, и там это написано внятно.
        } catch (error) {
            step.ok = false;
            notes.push(`username ${login}: ${describe(error)}`);
        }
    }
    step.note = notes.join("; ");
    return step;
}

/**
 * Шаг 3: первый challenge flow'а.
 *
 * Проверяем, что `AK_AUTH_FLOW` указывает на существующий flow и начинается он
 * с identification. Именно здесь ловится самая частая ошибка настройки: slug
 * есть в .env, а flow с таким slug в authentik не заведён (или его завели с
 * другим регистром/дефисом).
 */
async function stepFlow(): Promise<Step> {
    const step: Step = {title: `flow executor: ${AK_AUTH_FLOW}`, ok: false, note: ""};
    try {
        const session = new FlowExecutorSession(AK_URL, AK_TIMEOUT);
        const challenge = await session.initialChallenge(AK_AUTH_FLOW);
        if (challenge.component === "ak-stage-identification") {
            step.ok = true;
            step.note = challenge.passwordFields
                ? `200 · ak-stage-identification · password_fields=true (combo)`
                : "200 · ak-stage-identification · password_fields=false (пароль на отдельной стадии)";
            return step;
        }
        if (challenge.component === "ak-stage-access-denied") {
            step.note = "flow начинается с отказа: политика или denied_action перекрывают вход";
            return step;
        }
        step.note = challenge.component
            ? `неожиданная первая стадия: ${challenge.component}`
            : `ответ ${challenge.status} без challenge (compatibility mode или не тот slug)`;
    } catch (error) {
        step.note = describe(error);
    }
    return step;
}

/**
 * Шаг 4: пробный вход.
 *
 * Идём через `authenticateUser`, то есть ровно тем кодом, которым пользуется
 * `POST /auth/login`. Исходы разложены по-разному, потому что для диагностики
 * они означают разное: успех и честный отказ (`invalid`, `denied`) — связка
 * работает, а `unavailable` (transport) и `unsupported` — нет.
 */
async function stepLogin(): Promise<Step> {
    const step: Step = {title: "пробный вход", ok: null, note: ""};
    const login = process.env.AK_CHECK_LOGIN ?? "";
    const password = process.env.AK_CHECK_PASSWORD ?? "";
    if (!login || !password) {
        step.note = "пропущено: задай AK_CHECK_LOGIN и AK_CHECK_PASSWORD";
        return step;
    }
    if (!akEnabled()) {
        step.note = "пропущено: без AK_API_TOKEN вход идёт по локальному bcrypt, authentik не опрашивается";
        return step;
    }
    const started = Date.now();
    try {
        const result = await authenticateUser(login, password);
        const ms = Date.now() - started;
        if (result.ok) {
            step.ok = true;
            step.note = `${result.user.username} · uid ${result.user.uid} · ${ms} ms`;
            return step;
        }
        if (result.transport) {
            step.ok = false;
            step.note = `authentik не отвечал (${ms} ms): ${result.detail}`;
            return step;
        }
        if (result.reason === "unsupported") {
            step.ok = false;
            step.note = `flow содержит стадию, которую исполнитель не умеет (${ms} ms)${result.detail ? ` · ${result.detail}` : ""}`;
            return step;
        }
        // Отказ здесь — тоже пройденный шаг: цепочка стадий жива, данные дошли
        // до проверки пароля и вернулись честно. Шаг 4 отвечает на вопрос «работает
        // ли связка», а не «верный ли пароль».
        step.ok = true;
        const why =
            result.reason === "invalid" ? "пароль не подошёл (response_errors)" : "доступ отклонён стадией отказа";
        step.note = `${why} · ${ms} ms`;
        if (result.reason === "invalid") {
            step.note += "; если пароль точно верный — смотри attributes.inf54UserId";
        }
    } catch (error) {
        step.ok = false;
        step.note = describe(error);
    }
    return step;
}

function mark(ok: boolean | null): string {
    return ok === true ? "ok  " : ok === false ? "FAIL" : "skip";
}

async function main(): Promise<number> {
    const steps = [await stepWhoami(), await stepSearch(), await stepFlow(), await stepLogin()];
    const failed = steps.filter((step) => step.ok === false).length;

    console.log(`authentik: ${AK_URL} · flow: ${AK_AUTH_FLOW} · timeout: ${AK_TIMEOUT} ms · токен: ${akEnabled() ? "зад" : "пуст"}`);
    steps.forEach((step, index) => {
        console.log(`[${index + 1}/${steps.length}] ${mark(step.ok)} ${step.title} — ${step.note}`);
    });

    const adminApi = steps[0].ok === null ? "skip" : steps[0].ok && steps[1].ok ? "ok" : "fail";
    const flow = steps[2].ok ? "ok" : "fail";
    const login = steps[3].ok === null ? "skip" : steps[3].ok ? "ok" : "fail";
    console.log(`authentik: admin api ${adminApi} / flow ${flow} / login ${login}`);

    if (failed > 0) {
        console.log(`упало шагов: ${failed} — разбор по причинам в разделе 9.1 AUTHENTIK-SETUP.md`);
    }
    return failed === 0 ? 0 : 1;
}

// Без top-level await: tsconfig целиится в es2016, где он недоступен, а скрипт
// запускается и через `bun ./ak-check.ts`, и через собранный dist.
main().then(
    (code) => process.exit(code),
    (error) => {
        console.error(`ak-check: незавершённое исключение: ${describe(error)}`);
        process.exit(1);
    }
);
