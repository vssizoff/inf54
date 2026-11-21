import {buildHandlers} from "./legacy.js";
import {
    adminUsersPatch,
    emailConfirm,
    getAllUsers,
    getEmailByToken,
    getUserByToken,
    getUserByUsername,
    isAdmin,
    isUniqueCodeforcesHandle,
    isUniqueEmail,
    isUniqueUsername,
    makeAdmin,
    patchUser,
    register,
    registerStart,
    removeEmailConfirm
} from "./sql/users.sql.js";
import {searchUsers} from "./sql/search.sql.js";
import {email, object, optional, string} from "parsium";
import {checkAuth} from "./authChecker.js";
import {
    createAuthentikUser,
    exchangeCode,
    refreshTokens, revokeToken,
    setAuthentikPassword,
    updateAuthentikProfile
} from "./authentik";
import {verifyAccessToken} from "./jwt";

const router = buildHandlers({
    get: {
        async "/me"(request, response) {
            if (typeof request.headers.authorization !== "string") {
                response.status(401);
                response.end("");
                return;
            }
            let {authorization: token} = request.headers;
            let user = await getUserByToken(token, ["username", "codeforcesHandle", "firstName", "lastName", "isAdmin"]);
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
            let id = await verifyAccessToken(token);
            if (!id) {
                response.status(401);
                response.end("");
                return;
            }
            let promises: Array<Promise<any>> = [];
            if (typeof request.body.username === "string") {
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
            if (typeof request.body.firstName === "string" || typeof request.body.lastName === "string") {
                promises.push(updateAuthentikProfile(id, {name: `${request.body.lastName} ${request.body.firstName}`}));
            }
            await Promise.all(promises);
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
        password: string()
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
    const authentikId = (await createAuthentikUser({username: request.body.username, email, name: `${request.body.lastName} ${request.body.lastName}`})).pk;
    await setAuthentikPassword(authentikId, request.body.password);
    await register({...request.body, email, authentikId});
    response.status(201);
    response.end("ok");
});

router.post("/users/signin", {
    bodyValidator: object({
        code: string()
    }),
    headersValidator: object({
        "user-agent": string()
    })
}, async (request, response) => {
    let token = (await exchangeCode(request.body.code))?.refresh_token;
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
        // old: string(),
        new: string()
    }),
    async authChecker(request, response) {
        return checkAuth(request.headers?.authorization, ["id", "authentikId"], response);
    }
}, async (request, response) => {
    if (!request.auth.authentikId) return;
    await setAuthentikPassword(request.auth.authentikId, request.body.new);
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
    const data = await refreshTokens(token);
    if (data === null) {
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
    if (data.refresh_token) {
        response.expressResponse.cookie("refreshToken", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: "strict",
            path: "/api/refresh-token"
        });
    }
    response.end(data.access_token);
});

router.post("/users/signout", {
    headersValidator: object({
        "user-agent": string()
    }),
    // async authChecker(request, response) {
    //     return checkAuthRetData(request.headers?.authorization, response);
    // }
}, async (request, response) => {
    if (request.expressRequest.cookies.refreshToken) await revokeToken(request.expressRequest.cookies.refreshToken);
    response.expressResponse.clearCookie("refreshToken", {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: "strict",
        path: "/api/refresh-token"
    });
    response.expressResponse.clearCookie("authentik_csrf");
    response.expressResponse.clearCookie("authentik_device");
    response.expressResponse.clearCookie("authentik_session");
    response.expressResponse.clearCookie("authentik_user_switching");
    response.end();
});

router.post("/users/signin/cleanup", {}, async (_, response) => {
    response.expressResponse.clearCookie("authentik_csrf");
    response.expressResponse.clearCookie("authentik_device");
    response.expressResponse.clearCookie("authentik_session");
    response.expressResponse.clearCookie("authentik_user_switching");
    response.end();
});

export default router;