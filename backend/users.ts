import {buildHandlers} from "./legacy.js";
import {
    adminUsersPatch,
    changePassword,
    checkUseragent, emailConfirm,
    getAllUsers, getEmailByToken,
    getUserByToken,
    getUserByUsername,
    getUserIdByToken,
    isAdmin,
    isUniqueCodeforcesHandle,
    isUniqueEmail,
    isUniqueUsername,
    makeAdmin,
    patchUser,
    pushProfile,
    register, registerStart, removeEmailConfirm,
    signInHeadless,
    signOut, updateLastRefreshTimestamp
} from "./sql/users.sql.js";
import {searchUsers} from "./sql/search.sql.js";
import {any, email, object, optional, string} from "parsium";
import {checkAuth, checkAuthRetData} from "./authChecker.js";
import {generateAccessToken, verifyAppToken, verifyRefreshToken} from "./jwt.js";
import {parseAttributes} from "./attributes.js";

const router = buildHandlers({
    get: {
        async "/me"(request, response) {
            if (typeof request.headers.authorization !== "string") {
                response.status(401);
                response.end("");
                return;
            }
            let {authorization: token} = request.headers;
            let user = await getUserByToken(token, ["username", "codeforcesHandle", "firstName", "lastName", "isAdmin", "attributes"]);
            if (!user) {
                response.status(401);
                response.end("");
                return;
            }
            response.end(user);
        },
        async "/users/:username"(request, response) {
            if (typeof request.params.username !== "string") {
                response.status(400);
                response.end("");
                return;
            }
            let user = await getUserByUsername(request.params.username);
            if (!user) {
                response.status(404);
                response.end("");
                return;
            }
            response.end(user);
        },
        async "/users/is-unique/username/:username"(request, response) {
            if (typeof request.params.username !== "string") {
                response.status(400);
                response.end("");
                return;
            }
            if (await isUniqueUsername(request.params.username)) response.end("1");
            else response.end("0");
        },
        async "/users/is-unique/email/:email"(request, response) {
            if (typeof request.params.email !== "string") {
                response.status(400);
                response.end("");
                return;
            }
            if (await isUniqueEmail(request.params.email)) response.end("1");
            else response.end("0");
        },
        async "/users/is-unique/codeforces-handle/:codeforcesHandle"(request, response) {
            if (typeof request.params.codeforcesHandle !== "string") {
                response.status(400);
                response.end("");
                return;
            }
            if (await isUniqueCodeforcesHandle(request.params.codeforcesHandle)) response.end("1");
            else response.end("0");
        },
        async "/search/:username"(request, response) {
            if (typeof request.params.username !== "string") {
                response.status(400);
                response.end();
                return;
            }
            response.end(await searchUsers(request.params.username));
        },
        async "/users"(_, response) {
            response.end(await getAllUsers(["id", "username", "firstName", "lastName", "codeforcesHandle", "isAdmin"]));
        },
        async "/is-admin"(request, response) {
            if (typeof request.headers.authorization !== "string" || !(await isAdmin(request.headers.authorization))) {
                response.end("0");
                return;
            }
            response.end("1");
        }
    },
    patch: {
        async "/me"(request, response) {
            if (typeof request.body !== "object") {
                response.status(400);
                response.end("");
                return;
            }
            if (typeof request.headers.authorization !== "string") {
                response.status(401);
                response.end("");
                return;
            }
            let {authorization: token} = request.headers;
            let id = await getUserIdByToken(token);
            if (!id) {
                response.status(401);
                response.end("");
                return;
            }
            // Атрибуты профиля валидируются целиком до записи: половина полей
            // в базе и половина в authentik — худший из вариантов рассинхрона.
            let attributes: Record<string, unknown> | undefined;
            if ("attributes" in request.body) {
                const parsed = parseAttributes(request.body.attributes);
                if (!parsed.ok) {
                    response.status(422);
                    response.end("missing" in parsed ? JSON.stringify({missing: parsed.missing}) : JSON.stringify({invalid: parsed.invalid}));
                    return;
                }
                attributes = parsed.attributes;
            }
            let promises: Array<Promise<any>> = [];
            if (typeof request.body.username === "string") {
                if (request.body.username.length < 4) {
                    response.status(400);
                    response.end("");
                    return;
                }
                promises.push(patchUser(id, {username: request.body.username}));
            }
            if (typeof request.body.codeforcesHandle === "string") {
                promises.push(patchUser(id, {codeforcesHandle: request.body.codeforcesHandle, codeforcesHandleLowerCase: request.body.codeforcesHandle.toLowerCase()}));
            }
            if (typeof request.body.firstName === "string") {
                promises.push(patchUser(id, {firstName: request.body.firstName}));
            }
            if (typeof request.body.lastName === "string") {
                promises.push(patchUser(id, {lastName: request.body.lastName}));
            }
            if (attributes !== undefined) {
                promises.push(patchUser(id, {attributes}));
            }
            await Promise.all(promises);
            // Профиль синхронизируем одним запросом после всех локальных правок.
            // authentik — источник истины для username, и расхождение здесь
            // означает потерянный вход под новым именем, поэтому неудачу
            // поднимаем в 503: клиент должен повторить, а не жить с разной
            // правдой в двух системах.
            const sync = await pushProfile(id);
            if (!sync.ok) {
                console.error("authentik: профиль не синхронизирован", id, sync.detail);
                response.status(sync.transport ? 503 : 500);
                response.end("authentik");
                return;
            }
            response.end("");
        },
        async "/users"(request, response) {
            if (typeof request.headers.authorization !== "string" || !(await isAdmin(request.headers.authorization))) {
                response.status(401);
                response.end();
                return;
            }
            if (typeof request.body !== "object" || !Array.isArray(request.body)) {
                response.status(400);
                response.end();
                return;
            }
            await adminUsersPatch(request.body);
            response.end();
        },
        async "/admin"(request, response) {
            if (typeof request.headers.authorization !== "string" || !(await isAdmin(request.headers.authorization))) {
                response.status(401);
                response.end();
                return;
            }
            console.log(typeof request.body, request.body);
            if (typeof request.body !== "number") {
                response.status(400);
                response.end();
                return;
            }
            await makeAdmin(request.body);
            response.end();
        }
    }
});

router.post("/users/register-start", {
    bodyValidator: object({
        email: email()
    })
}, async (request, response) => {
    if (!(await isUniqueEmail(request.body.email))) {
        response.status(409);
        response.end();
        return;
    }
    await registerStart(request.body.email.toLowerCase())
    response.end();
});

router.post("/users/email-confirm", {
    bodyValidator: object({
        email: email(),
        code: string({min: 6, max: 6})
    })
}, async (request, response) => {
    let token = await emailConfirm(request.body.email.toLowerCase(), request.body.code);
    if (!token) {
        response.status(401);
        response.end();
        return;
    }
    response.end(token);
});

router.post("/users/register", {
    bodyValidator: object({
        username: string(),
        codeforcesHandle: optional(string()),
        firstName: string(),
        lastName: string(),
        emailToken: string(),
        password: string(),
        // Состав проверяется в parseAttributes: поля описаны в attributes.ts, и
        // собирать их форму здесь вторым списком означало бы рассинхрон.
        attributes: optional(any<Record<string, unknown>>())
    }),
    headersValidator: object({
        "user-agent": string()
    })
}, async (request, response) => {
    if (request.body.username.length < 4 || request.body.password.length < 4) {
        response.status(400);
        response.end("");
        return;
    }
    const parsed = parseAttributes(request.body.attributes);
    if (!parsed.ok) {
        // 422: форма заполнена неверно, повторить тот же запрос бессмысленно.
        response.status(422);
        response.end("missing" in parsed ? JSON.stringify({missing: parsed.missing}) : JSON.stringify({invalid: parsed.invalid}));
        return;
    }
    if (!(await isUniqueUsername(request.body.username))) {
        response.status(409);
        response.end("username");
        return;
    }
    const email = await getEmailByToken(request.body.emailToken);
    if (!email) {
        response.status(409);
        response.end("email");
        return;
    }
    if (request.body.codeforcesHandle && !(await isUniqueCodeforcesHandle(request.body.codeforcesHandle))) {
        response.status(409);
        response.end("codeforcesHandle");
        return;
    }
    await removeEmailConfirm(request.body.emailToken);
    let token = await register({
        username: request.body.username,
        codeforcesHandle: request.body.codeforcesHandle,
        firstName: request.body.firstName,
        lastName: request.body.lastName,
        email,
        password: request.body.password,
        attributes: parsed.attributes
    }, request.headers["user-agent"], "main");
    if (!token) {
        // Единственная причина, по которой register возвращает null, — authentik
        // отверг создание учётки (строка уже откачена, см. sql/users.sql.ts).
        // 503, а не 500: это отказ внешней системы, и повтор может получиться.
        response.status(503);
        response.end("authentik");
        return;
    }
    response.status(201);
    response.expressResponse.cookie("refreshToken", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: "strict",
        path: "/api/refresh-token"
    });
    response.end("ok");
});

router.post("/users/signin", {
    bodyValidator: object({
        username: string(),
        password: string()
    }),
    headersValidator: object({
        "user-agent": string()
    })
}, async (request, response) => {
    // signInHeadless: пароль проверяет authentik своей цепочкой стадий, браузер
    // пользователя на authentik не уходит. Локальный bcrypt подключается только
    // когда authentik недоступен (см. backend/authentik.ts).
    let token = await signInHeadless(request.body.username, request.body.password, request.headers["user-agent"], "main");
    if (!token) {
        response.status(401);
        response.end("");
        return;
    }
    response.expressResponse.cookie("refreshToken", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: "strict",
        path: "/api/refresh-token"
    });
    response.end("ok");
});

router.patch("/me/password", {
    bodyValidator: object({
        old: string(),
        new: string()
    }),
    async authChecker(request, response) {
        return checkAuth(request.headers?.authorization, ["id"], response);
    }
}, async (request, response) => {
    let {old: oldPassword, new: newPassword} = request.body;
    let {id} = request.auth;
    if (newPassword.length < 4) {
        response.status(400);
        response.end("");
        return;
    }
    // Проверка старого пароля и запись нового — внутри, потому что порядок
    // нерассасываемый: сначала authentik подтверждает старый, потом новый
    // пишется туда же, и только затем обновляется локальное зеркало.
    const result = await changePassword(id, oldPassword, newPassword);
    if (!result.ok) {
        switch (result.reason) {
            case "invalid":
                // Прежний код отвечал 418 — сохраняем, фронт на него настроен.
                response.status(418);
                response.end("old");
                return;
            case "unavailable":
                // authentik лежит. Менять пароль нельзя даже локально: зеркала
                // разойдутся, и после починки сервиса вход в учётку закрылся бы.
                response.status(503);
                response.end("authentik");
                return;
            default:
                console.error("authentik: смена пароля отклонена", id, result.detail);
                response.status(500);
                response.end("");
                return;
        }
    }
    response.end();
});

router.get("/refresh-token", {
    headersValidator: object({
        "user-agent": string()
    })
}, async (request, response) => {
    const token = request.expressRequest.cookies.refreshToken as string | undefined;
    if (!token) {
        response.status(401);
        response.end();
        return;
    }
    const data = await verifyRefreshToken(token);
    if (!data || !(await checkUseragent(request.headers["user-agent"], data.jti))) {
        response.expressResponse.clearCookie("refreshToken", {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: "strict",
            path: "/api/refresh-token"
        });
        response.status(401);
        response.end();
        return;
    }
    await updateLastRefreshTimestamp(data.jti);
    response.end(await generateAccessToken(data.id, data.jti, data.app));
});

router.post("/refresh-token", {
    bodyValidator: string(),
    headersValidator: object({
        "user-agent": string(),
        authorization: optional(string())
    })
}, async (request, response) => {
    const data = await verifyRefreshToken(request.body);
    if (!data || !(await checkUseragent(request.headers["user-agent"], data.jti))) {
        response.status(401);
        response.end();
        return;
    }
    let app = "main";
    if ("authorization" in request.headers) {
        const data = await verifyAppToken(request.headers.authorization);
        if (data === false) {
            response.status(418);
            response.end();
            return;
        }
        app = data.app;
    }
    await updateLastRefreshTimestamp(data.jti);
    response.end(await generateAccessToken(data.id, data.jti, app));
});

router.post("/users/signout", {
    headersValidator: object({
        "user-agent": string()
    }),
    async authChecker(request, response) {
        return checkAuthRetData(request.headers?.authorization, response);
    }
}, async (request, response) => {
    await signOut(request.auth.jti);
    response.expressResponse.clearCookie("refreshToken", {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: "strict",
        path: "/api/refresh-token"
    });
    response.end();
});

export default router;