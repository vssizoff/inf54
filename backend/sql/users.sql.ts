import randomstring from "randomstring";
import {Database, db} from "./index.sql.js";
import bcrypt from "bcrypt";
import {SelectExpression} from "kysely";
import {UpdateObjectExpression} from "kysely/dist/cjs/parser/update-set-parser.js";
import {generateRefreshToken, verifyAccessToken} from "../jwt.js";
import useragent from "useragent";
import isMobile from "is-mobile";
import {sendConfirmationEmail} from "../mail";
import cryptoRandomString from 'crypto-random-string';
// Фасад headless-интеграции с authentik. Импорт однонаправленный: authentik.*
// ничего от слоя БД не знает, поэтому цикла не возникает.
import {
    akEnabled,
    AuthentikError,
    authenticateUser,
    ensureUserForLocal,
    type LocalProfile,
    setPasswordFor,
    syncProfile,
    type AkUserSummary
} from "../authentik.js";

export function generateRandomString() {
    return randomstring.generate({length: 256, charset: ["alphanumeric", '@', '#', '%', '^', '&', '*', ':', ';']});
}

export function generateToken() {
    return `${generateRandomString()}.${Date.now()}`;
}

export async function registerStart(email: string) {
    const code = cryptoRandomString({length: 6});
    const token = generateToken();
    let date = new Date();
    date.setMinutes(date.getMinutes() + 10);
    await db.insertInto("emailConfirmations").values({
        email, code, token, expires: date
    }).executeTakeFirstOrThrow();
    await sendConfirmationEmail(email, code);
    return code;
}

export async function emailConfirm(email: string, code: string) {
    let data = await db.selectFrom("emailConfirmations").select(["token", "expires"]).limit(1)
        .where(({and, eb}) => and([eb("email", '=', email), eb("code", '=', code)]))
        .executeTakeFirst();
    if (!data || new Date() > data.expires) return null;
    db.updateTable("emailConfirmations").set({code: ""})
        .where(({and, eb}) => and([eb("email", '=', email), eb("code", '=', code)]))
    return data.token;
}

export async function getEmailByToken(token: string) {
    let data = await db.selectFrom("emailConfirmations").select(["email"]).limit(1)
        .where(({and, eb}) => and([eb("token", '=', token)]))
        .executeTakeFirst();
    if (!data) return null;
    return data.email;
}

export async function removeEmailConfirm(token: string) {
    await db.deleteFrom("emailConfirmations").where("token", '=', token).execute();
}

export async function register({username, codeforcesHandle, firstName, lastName, email, password, attributes}: {username: string, codeforcesHandle?: string, firstName: string, lastName: string, email: string, password: string, attributes?: Record<string, unknown>}, useragent: string, app: string): Promise<string | null> {
    let passwordHash = await bcrypt.hash(password, 12);
    let {id} = await db.insertInto("users").values({
        username,
        codeforcesHandle,
        codeforcesHandleLowerCase: codeforcesHandle?.toLowerCase(),
        firstName,
        lastName,
        email: email.toLowerCase(),
        passwordHash,
        attributes: attributes ?? {},
        isAdmin: false
    }).returning(["id"]).executeTakeFirstOrThrow();
    // Строка уже нужна с id: он попадает в authentik как атрибут inf54UserId, по
    // которому потом ищется привязка (см. findAkUser).
    const local: LocalProfile = {id, username, email: email.toLowerCase(), firstName, lastName, attributes: attributes ?? {}};
    if (akEnabled()) {
        try {
            const uid = await ensureUserForLocal(local, password);
            await setAuthentikUid(id, uid);
        } catch (error) {
            if (error instanceof AuthentikError && error.transport) {
                // authentik лежит: регистрируем только локально, ленная миграция
                // догонит при первом входе (он в этот момент тоже идёт по bcrypt).
                console.warn("authentik недоступен, пользователь заведён только локально:", username, String(error));
            } else {
                // Осмысленный отказ (занятый username/email, право, валидация).
                // Оставлять строку нельзя: войти такой учётка не сможет —
                // authentik её не знает, а фолбэк на bcrypt при отказе запрещён.
                await db.deleteFrom("users").where("id", '=', id).execute();
                console.error("authentik: регистрация отменена:", username, String(error));
                return null;
            }
        }
    }
    return signInById(id, useragent, app);
}

export async function signInById(id: number, useragentStr: string, app: string): Promise<string | null> {
    const ua = useragent.parse(useragentStr);
    const jti = (await db.insertInto("sessions").values({
        userId: id,
        device: ua.device.family,
        os: ua.os.family,
        browser: ua.family,
        mobile: isMobile({ua: useragentStr, tablet: true}),
        lastRefresh: new Date()
    }).returning(["id"]).executeTakeFirstOrThrow()).id;
    return generateRefreshToken(id, jti, app);
}

export async function signIn(username: string, password: string, useragent: string, app: string, passwordHash?: string | null): Promise<string | null> {
    let passHash: string | null;
    if (passwordHash !== undefined) passHash = passwordHash;
    else {
        let {passwordHash} = await db.selectFrom("users").select("passwordHash").where("username", '=', username).executeTakeFirstOrThrow();
        passHash = passwordHash;
    }
    // null — пользователь заведён напрямую в authentik, локального хэша нет.
    // Сравнивать не с чем, и пустая строка в качестве хэша тоже не допустима:
    // bcrypt.compare("", "") бросает, а некоторые реализации возвращают true.
    if (!passHash) return null;
    if (!(await bcrypt.compare(password, passHash))) return null;
    let {id} = await db.selectFrom("users").select("id").where("username", '=', username).executeTakeFirstOrThrow();
    return signInById(id, useragent, app);
}

export async function isUniqueUsername(username: string): Promise<boolean> {
    return !Boolean(await db.selectFrom("users").where("username", '=', username).select("id").executeTakeFirst());
}

export async function isUniqueCodeforcesHandle(codeforcesHandle: string): Promise<boolean> {
    return !Boolean(await db.selectFrom("users").where("codeforcesHandleLowerCase", '=', codeforcesHandle.toLowerCase()).select("id").executeTakeFirst());
}

export async function isUniqueEmail(email: string): Promise<boolean> {
    return !Boolean(await db.selectFrom("users").where("email", '=', email.toLowerCase()).select("id").executeTakeFirst());
}

export async function getUserByUsername(username: string, select: Array<SelectExpression<Database, "users">> = ["username", "codeforcesHandle", "firstName", "lastName", "isAdmin"]) {
    return db.selectFrom("users").where("username", '=', String(username)).select(select).executeTakeFirst();
}

export async function getUserIdByToken(token: string): Promise<number | null> {
    // let sessions = await db.selectFrom("sessions").where("token", '=', token).select("userId").execute();
    // if (!sessions.length) return null;
    // return sessions[0].userId;
    let data = await verifyAccessToken(token);
    if (!data) return null;
    return data.id;
}

export async function getUserByToken(token: string, select: Array<SelectExpression<Database, "users">> = ["id", "username", "codeforcesHandle", "firstName", "lastName", "isAdmin"]) {
    let id = await getUserIdByToken(token);
    if (!id) return null;
    return db.selectFrom("users").where("id", '=', id).select(select).executeTakeFirstOrThrow();
}

export async function patchUser(id: number, patch: UpdateObjectExpression<Database, "users", "users">) {
    await db.updateTable("users").set(patch).where("id", '=', id).executeTakeFirstOrThrow();
}

export async function patchUserPassword(id: number, password: string) {
    await db.updateTable("users").set({passwordHash: await bcrypt.hash(password, 12)}).where("id", '=', id).executeTakeFirstOrThrow();
}

export async function signOut(jti: number) {
    await db.deleteFrom("sessions").where("id", '=', jti).execute();
}

export async function getCodeforcesHandleUserIdMap(): Promise<{[key: string]: number}> {
    return Object.fromEntries((await db.selectFrom("users").select(["id", "codeforcesHandleLowerCase"]).execute()).map(({id, codeforcesHandleLowerCase}) => [codeforcesHandleLowerCase, id]));
}

export async function getUserById(id: number, select: Array<SelectExpression<Database, "users">> = ["id"]) {
    return db.selectFrom("users").where("id", '=', id).select(select).executeTakeFirst();
}

export async function getUsernameById(id: number): Promise<string | undefined> {
    return (await getUserById(id, ["username"]))?.username;
}

export async function getIdByEmail(email: string): Promise<number | undefined> {
    return (await db.selectFrom("users").where("email", '=', email.toLowerCase()).select(["id"]).executeTakeFirst())?.id;
}

export async function getUserIdByUsername(username: string): Promise<number | undefined> {
    return (await getUserByUsername(username, ["id"]))?.id;
}

export async function getAllUsers(select: Array<SelectExpression<Database, "users">> = ["username"]) {
    return db.selectFrom("users").select(select).execute();
}

export async function adminUsersPatch(data: Array<{id: number, codeforcesHandle?: string}>) {
    await Promise.all(data.map(async ({id, codeforcesHandle}) => {
        if (codeforcesHandle) await db.updateTable("users").where("id", '=', id).set({codeforcesHandle, codeforcesHandleLowerCase: codeforcesHandle.toLowerCase()}).execute();
    }));
}

export async function isAdmin(token: string): Promise<boolean> {
    let userId = await getUserIdByToken(token);
    if (!userId) return false;
    let isAdmin = await db.selectFrom("users").where("id", '=', userId).select(["isAdmin"]).executeTakeFirstOrThrow();
    return isAdmin.isAdmin;
}

export async function makeAdmin(id: number) {
    await db.updateTable("users").where("id", '=', id).set({isAdmin: true}).execute();
}

export async function checkUseragent(useragentStr: string, jti: number) {
    // const data = await db.selectFrom("sessions")
    //     .where("id", '=', jti)
    //     .select(["device", "os", "browser", "mobile"])
    //     .executeTakeFirstOrThrow();
    // const ua = useragent.parse(useragentStr);
    // const current = {
    //     device: ua.device.family,
    //     os: ua.os.family,
    //     browser: ua.family,
    //     mobile: isMobile({ua: useragentStr, tablet: true})
    // } as const;
    // for (const key in current) {
    //     // @ts-ignore
    //     if (data[key] !== current[key]) return false;
    // }
    return true;
}

export async function updateLastRefreshTimestamp(jti: number) {
    await db.updateTable("sessions").where("id", '=', jti).set({lastRefresh: new Date()}).execute();
}

/* ------------------------------------------------------------------ *
 * Authentik: чтение/запись привязки и точка входа
 * ------------------------------------------------------------------ */

/**
 * Колонки, общие для всех выборок «строка пользователя + привязка к authentik».
 *
 * Держим списком, потому что три таких запроса различаются только условием, а
 * расхождение в наборах полей позже превратилось бы в разные типы результатов.
 */
const AUTH_USER_COLUMNS = ["id", "username", "email", "firstName", "lastName", "passwordHash", "authentikUid", "attributes", "isAdmin"] as const;

/**
 * Строка пользователя вместе с привязкой к authentik.
 *
 * Отдельная выборка, а не расширение getUserByUsername: последняя используется
 * в публичном профиле, и тащить туда authentikUid/passwordHash значит отдать
 * их наружу через /users/:username.
 */
export async function getAuthUserByUsername(username: string) {
    return db.selectFrom("users")
        .select(AUTH_USER_COLUMNS)
        .where("username", '=', username)
        .executeTakeFirst();
}

export async function getAuthUserByAuthentikUid(uid: string) {
    return db.selectFrom("users")
        .select(AUTH_USER_COLUMNS)
        .where("authentikUid", '=', uid)
        .executeTakeFirst();
}

/**
 * Та же строка, но по email.
 *
 * Нужен потому, что IdentificationStage с пустым `user_identification_field`
 * принимает и логин, и почту: пользователь вправе ввести email, и тогда поиск
 * только по username не нашёл бы его строку.
 */
export async function getAuthUserByEmail(email: string) {
    return db.selectFrom("users")
        .select(AUTH_USER_COLUMNS)
        .where("email", '=', email.toLowerCase())
        .executeTakeFirst();
}

/** Записать привязку к authentik (ленная миграция и регистрация). */
export async function setAuthentikUid(id: number, uid: string) {
    await db.updateTable("users").set({authentikUid: uid}).where("id", '=', id).execute();
}

/**
 * Единственная точка входа для сервиса.
 *
 * Порядок такой, а не «сначала локально, потом authentik», потому что authentik —
 * источник истины о пароле, и именно он должен держать reputation/throttling.
 * Локальный bcrypt участвует только когда до authentik не дошли.
 *
 * Возвращает тот же refreshToken, что signIn, либо null при отказе.
 */
export async function signInHeadless(username: string, password: string, useragentStr: string, app: string): Promise<string | null> {
    if (!akEnabled()) {
        return signIn(username, password, useragentStr, app);
    }
    const result = await authenticateUser(username, password);
    if (result.ok) {
        const uid = result.user.uid;
        let local = await getAuthUserByAuthentikUid(uid);
        if (!local) {
            // authentik знает учётку, нашей базы она не достигла: такое бывает у
            // старых пользователей до ленной миграции и после смены username.
            // Идентификатор из формы может быть email, поэтому пробуем обе ветки.
            local = await getAuthUserByUsername(username) ?? await getAuthUserByEmail(username);
        }
        if (!local) {
            // Пользователь есть в authentik, но не у нас. Не создаём его молча:
            // профиль (id, isAdmin, codeforcesHandle) формируют наши ручки, и
            // пустая строка здесь рано или поздно сломала бы турниры.
            console.warn("authentik: пользователь аутентифицирован, но отсутствует в базе inf54", username);
            return null;
        }
        if (local.authentikUid !== uid) await setAuthentikUid(local.id, uid);
        await mergeAuthentikProfile(local, result.user);
        return signInById(local.id, useragentStr, app);
    }
    if (!result.transport) {
        // Осмысленный отказ authentik. Фолбэк запрещён: иначе обход его политик
        // превращается в брутфорс нашего более слабого локального хэша.
        return null;
    }
    // Transport-сбой: authentik лежит, входим по локальному хэшу и чиним
    // привязку позже. Пишем в лог — режим деградации должен быть заметен.
    console.warn("authentik недоступен, вход по локальному bcrypt:", result.detail);
    // Идентификатор в форме может быть email, поэтому строку ищем по обоим полям:
    // signIn внутри берёт хэш через executeTakeFirstOrThrow и на неизвестном
    // логине бросает, а режим деградации обязан отвечать 401, а не 500.
    const local = await getAuthUserByUsername(username) ?? await getAuthUserByEmail(username);
    if (!local) return null;
    const token = await signIn(local.username, password, useragentStr, app, local.passwordHash);
    if (!token) return null;
    if (!local.authentikUid) {
        // Пользователь есть, пароль верный, а в authentik учётки нет — заводим
        // сейчас, пока raw-пароль известен. Неудача не мешает входу.
        await ensureUserForLocal(local, password).catch(error =>
            console.warn("authentik: ленная миграция не прошла", local.username, String(error)));
    }
    return token;
}

/**
 * Обновить локальное зеркало профиля тем, что вернул authentik при входе.
 *
 * Поля берём только те, что однозначно представимы: email и атрибуты. `name`
 * в authentik — одна строка, а у нас firstName/lastName, и reverse-сплит по
 * первому пробелу терял бы данные на фамилиях с пробелом. Имя синхронизируется
 * в обратную сторону из /me (см. pushProfile), а правки напрямую в админке
 * authentik для имени просто не переносятся сюда.
 */
async function mergeAuthentikProfile(local: NonNullable<Awaited<ReturnType<typeof getAuthUserByUsername>>>, ak: AkUserSummary) {
    // inf54UserId — наш служебный ключ, в кэше он не нужен.
    const attributes: Record<string, unknown> = {...(ak.attributes ?? {})};
    delete attributes.inf54UserId;
    const same = local.email === ak.email && JSON.stringify(local.attributes) === JSON.stringify(attributes);
    if (same) return;
    await db.updateTable("users")
        .set({email: ak.email, attributes})
        .where("id", '=', local.id)
        .execute();
}

/** То же, что getAuthUserByUsername, но по id — для /me и восстановления. */
export async function getAuthUserById(id: number) {
    return db.selectFrom("users")
        .select(AUTH_USER_COLUMNS)
        .where("id", '=', id)
        .executeTakeFirst();
}

/**
 * Результат записи в authentik.
 *
 * `transport` снова разделяет «сервис лежит» и «сервис отказал»: первое
 * предлагает повторить позже, второе — чинить конфигурацию или данные.
 */
export type AkWriteResult =
    | {ok: true}
    | {ok: false; transport: true; detail: string}
    | {ok: false; transport: false; detail: string};

/** Итог смены пароля: отдельно «не подошёл старый», отдельно «не смогли записать». */
export type ChangePasswordResult =
    | {ok: true}
    | {ok: false; reason: "invalid"}
    | {ok: false; reason: "unavailable"; detail: string}
    | {ok: false; reason: "error"; detail: string};

/** Итог сброса пароля (старый не спрашивается). */
export type ResetPasswordResult =
    | {ok: true}
    | {ok: false; reason: "unavailable" | "error"; detail: string};

function writeFailure(error: unknown): AkWriteResult {
    if (error instanceof AuthentikError) {
        return {ok: false, transport: error.transport, detail: error.toString()};
    }
    return {ok: false, transport: false, detail: String(error)};
}

/** Свернуть AkWriteResult в форму с причиной: роутерам нужно различать 503 и 500. */
function asReset(result: AkWriteResult): ResetPasswordResult {
    if (result.ok) return {ok: true};
    return result.transport
        ? {ok: false, reason: "unavailable", detail: result.detail}
        : {ok: false, reason: "error", detail: result.detail};
}

/**
 * Сменить пароль, проверив старый.
 *
 * Ключевое решение: локальный хэш пишется ТОЛЬКО после того, как authentik
 * принял новый пароль. Если бы мы при простое authentik писали только его,
 * зеркала разошлись бы: пользователь вошёл бы по новому паролю в наш bcrypt,
 * а когда authentik ожил, цепочка стадий отвергла бы тот же пароль — и вход
 * закрылся бы навсегда, потому что фолбэк при отказе запрещён. Поэтому во
 * время простоя смена пароля просто недоступна.
 */
export async function changePassword(id: number, oldPassword: string, newPassword: string): Promise<ChangePasswordResult> {
    const local = await getAuthUserById(id);
    if (!local) return {ok: false, reason: "invalid"};
    if (!akEnabled()) {
        await patchUserPassword(id, newPassword);
        return {ok: true};
    }
    const check = await authenticateUser(local.username, oldPassword);
    if (!check.ok) {
        if (check.transport) return {ok: false, reason: "unavailable", detail: check.detail};
        // Неверный старый пароль или политика. Различать для клиента незачем.
        return {ok: false, reason: "invalid"};
    }
    try {
        const uid = await setPasswordFor(local, newPassword);
        if (local.authentikUid !== uid) await setAuthentikUid(id, uid);
        await patchUserPassword(id, newPassword);
        return {ok: true};
    } catch (error) {
        return asReset(writeFailure(error));
    }
}

/**
 * Сбросить пароль без знания старого (восстановление по ссылке из письма).
 *
 * Право на такой сброс даёт ссылка из почты, поэтому политика та же: сначала
 * authentik, потом зеркало. При недоступности authentik сброс отклоняется —
 * иначе восстановленный пароль работал бы у нас, но не там.
 */
export async function resetPassword(id: number, newPassword: string): Promise<ResetPasswordResult> {
    const local = await getAuthUserById(id);
    if (!local) return {ok: false, reason: "error", detail: `пользователь ${id} не найден`};
    if (!akEnabled()) {
        await patchUserPassword(id, newPassword);
        return {ok: true};
    }
    try {
        const uid = await setPasswordFor(local, newPassword);
        if (local.authentikUid !== uid) await setAuthentikUid(id, uid);
        await patchUserPassword(id, newPassword);
        return {ok: true};
    } catch (error) {
        return asReset(writeFailure(error));
    }
}

/**
 * Вытолкнуть изменённый профиль в authentik (после PATCH /me).
 *
 * Отдельная функция, потому что роутер меняет поля по одному запросом к базе, а
 * в authentik нужен один итоговый PATCH: последовательность из трёх вызовов
 * оставила бы учётку в промежуточном состоянии при ошибке на втором.
 */
export async function pushProfile(id: number): Promise<AkWriteResult> {
    const local = await getAuthUserById(id);
    if (!local) return {ok: false, transport: false, detail: `пользователь ${id} не найден`};
    if (!akEnabled()) return {ok: true};
    try {
        await syncProfile(local);
        return {ok: true};
    } catch (error) {
        return writeFailure(error);
    }
}