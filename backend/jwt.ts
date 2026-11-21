import {createRemoteJWKSet, jwtVerify} from 'jose'
import {db} from "./sql/index.sql";

const AUTHENTIK_URL = process.env.AUTHENTIK_URL!
const JWKS_URL = `${AUTHENTIK_URL}/application/o/inf54/jwks/`

const JWKS = createRemoteJWKSet(new URL(JWKS_URL))

export interface JwtAccessPayload {
    iss: "http://authentik:9000/application/o/inf54/",
    sub: string,
    aud: string,
    exp: number,
    iat: number,
    auth_time: number,
    acr: string,
    jti: string,
    email: string,
    email_verified: boolean,
    name: string,
    given_name: string,
    preferred_username: string,
    nickname: string,
    groups: Array<string>,
    azp: string,
    uid: string,
    scope: string,
}

export async function verifyAccessToken(token: string | undefined | null): Promise<null | number> {
    if (token === undefined || token === null) {
        return null;
    }
    let payload: JwtAccessPayload;
    try {
        payload = (await jwtVerify(token, JWKS, {
            issuer: `${AUTHENTIK_URL}/application/o/inf54/`,
            audience: process.env.OIDC_CLIENT_ID,
        })).payload as unknown as JwtAccessPayload;
    }
    catch (error) {
        console.error(error);
        return null;
    }
    let user = await db.selectFrom("users").where("authentikSub", '=', payload.sub).select("id").executeTakeFirst()
    if (user === undefined) {
        user = await db.updateTable("users").where("username", '=', payload.nickname)
            .set({authentikSub: payload.sub}).returning("id").executeTakeFirst();
        if (user === undefined) {
            throw new Error(`User ${payload.nickname} (sub ${payload.sub}) not found`);
        }
    }
    return user.id;
}