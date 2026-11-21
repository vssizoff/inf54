import {sendRecoveryMail} from "./mail.js";
import {BackendiumRouter} from "backendium";
import {email, object, string} from "parsium";
import cryptoRandomString from "crypto-random-string";
import {getIdByEmail} from "./sql/users.sql.js";
import {db} from "./sql/index.sql";
import {setAuthentikPassword} from "./authentik";

let router = new BackendiumRouter;

let urlKeys = new Map<string, number>();

router.patch("/recovery/:key", {
    paramsValidator: object({
        key: string()
    }),
    bodyValidator: object({
        password: string()
    }),
    headersValidator: object({
        "user-agent": string()
    })
}, async (request, response) => {
    if (!urlKeys.has(request.params.key)) {
        response.status(401);
        response.end();
        return;
    }
    const id = urlKeys.get(request.params.key);
    if (!id) return;
    const {authentikId} = await db.selectFrom("users").where("id", "=", id).select("authentikId").executeTakeFirstOrThrow();
    if (!authentikId) {
        response.status(500);
        response.end();
        return;
    }
    await setAuthentikPassword(authentikId, request.body.password);
    response.end();
});

router.patch("/recovery", {
    bodyValidator: object({
        email: email()
    })
}, async (request, response) => {
    let id = await getIdByEmail(request.body.email);
    if (!id) {
        response.status(404);
        response.end();
        return;
    }
    let key = "";
    do {
        key = cryptoRandomString({length: 128, type: 'url-safe'});
    } while (urlKeys.has(key));
    let link = `https://inf54.ru/recovery/${key}`;
    urlKeys.set(key, id);
    setTimeout(() => {
        if (!urlKeys.has(key)) return;
        urlKeys.delete(key);
    }, 1800000)
    await sendRecoveryMail(request.body.email, link);
    response.end();
});

export default router;