import superagent from 'superagent';
import {db} from "./sql/index.sql";

const AUTHENTIK_URL = process.env.AUTHENTIK_URL!;
const AUTHENTIK_TOKEN = process.env.AUTHENTIK_TOKEN!;
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID!;
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET!;
const OIDC_REDIRECT_URI = process.env.OIDC_REDIRECT_URI!;        // https://app.example.com/api/auth/callback

type CreateUserData = {
    username: string
    email: string
    name?: string
    attributes?: Record<string, unknown>
}

type AuthentikUser = {
    pk: number
    username: string
    email: string
    name: string
    attributes: Record<string, unknown>
}

export class AuthentikError extends Error {
    constructor(
        public status: number,
        public body: unknown,
        public path: string,
    ) {
        super(`authentik ${path} → ${status}: ${JSON.stringify(body)}`)
    }
}

function base(path: string) {
    return `${AUTHENTIK_URL}${path}`
}

function authHeaders() {
    return { Authorization: `Bearer ${AUTHENTIK_TOKEN}` }
}

/**
 * Создаёт пользователя в authentik.
 * Пароль НЕ задаётся — только отдельным вызовом set_password.
 */
export async function createAuthentikUser(data: CreateUserData): Promise<AuthentikUser> {
    try {
        const res = await superagent
            .post(base('/api/v3/core/users/'))
            .set(authHeaders())
            .send({
                username: data.username,
                email: data.email,
                name: data.name ?? '',
                is_active: true,
                attributes: data.attributes ?? {},
            })
        return res.body as AuthentikUser
    } catch (err) {
        throw mapError(err, '/api/v3/core/users/')
    }
}

/**
 * Устанавливает пароль существующему пользователю.
 */
export async function setAuthentikPassword(
    userId: number,
    password: string,
): Promise<void> {
    try {
        await superagent
            .post(base(`/api/v3/core/users/${userId}/set_password/`))
            .set(authHeaders())
            .send({ password })
    } catch (err) {
        throw mapError(err, `/api/v3/core/users/${userId}/set_password/`)
    }
}

/**
 * Поиск пользователя по email или username.
 */
export async function findAuthentikUser(query: {
    email?: string
    username?: string
}): Promise<AuthentikUser[]> {
    try {
        const req = superagent
            .get(base('/api/v3/core/users/'))
            .set(authHeaders())
            .query({
                ...(query.email ? { email: query.email } : {}),
                ...(query.username ? { username: query.username } : {}),
            })
        const res = await req
        return ((res.body?.results ?? []) as AuthentikUser[])
    } catch (err) {
        throw mapError(err, '/api/v3/core/users/')
    }
}

function mapError(err: unknown, path: string): Error {
    // superagent бросает Error с полем .response для 4xx/5xx
    const e = err as { response?: { status: number; body: unknown }; status?: number }
    if (e?.response) {
        return new AuthentikError(e.response.status, e.response.body, path)
    }
    if (err instanceof Error) return err
    return new Error(`authentik ${path} failed: ${String(err)}`)
}

export type TokenResponse = {
    access_token: string
    id_token?: string
    refresh_token?: string
    token_type: string
    expires_in: number
}

export class OidcError extends Error {
    constructor(public status: number, public body: any) {
        super(`OIDC error ${status}: ${JSON.stringify(body)}`)
    }
    get code(): string | undefined {
        return this.body?.error
    }
}

function mapError2(err: unknown): Error {
    const e = err as { response?: { status: number; body: unknown } }
    if (e?.response) return new OidcError(e.response.status, e.response.body)
    return err instanceof Error ? err : new Error(String(err))
}

/** Обмен authorization code на токены (вызывается из /api/auth/callback) */
export async function exchangeCode(code: string): Promise<TokenResponse | null> {
    try {
        const res = await superagent
            .post(`${AUTHENTIK_URL}/application/o/token/`)
            .auth(OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)
            .type('form') // Важно: application/x-www-form-urlencoded
            .send({
                // client_id: OIDC_CLIENT_ID,
                // client_secret: OIDC_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: OIDC_REDIRECT_URI
            })
            .timeout({ response: 5000, deadline: 10000 })
        return res.body as TokenResponse
    } catch (err) {
        const e = err as { response?: { status: number; body?: { error?: string } } }

        // OAuth2 стандартная ошибка для некорректного, истёкшего или уже использованного code
        if (e.response?.status === 400 && e.response.body?.error === 'invalid_grant') {
            return null
        }

        // throw mapError2(err)
        console.error(err);
        return null;
    }
}

/** Обновление токенов через refresh grant (вызывается из /api/auth/refresh) */
export async function refreshTokens(refreshToken: string): Promise<TokenResponse | null> {
    try {
        const res = await superagent
            .post(`${AUTHENTIK_URL}/application/o/token/`)
            .auth(OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)
            .type('form')
            .send({
                // client_id: OIDC_CLIENT_ID,
                // client_secret: OIDC_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                // scope НЕ передаём, чтобы сохранить исходные scopes (включая offline_access)
            })
            .timeout({ response: 5000, deadline: 10000 })
        return res.body as TokenResponse
    } catch (err) {
        const e = err as { response?: { status: number; body?: { error?: string } } }

        // OAuth2 стандартная ошибка для некорректного, отозванного или истёкшего refresh_token
        if (e.response?.status === 400 && e.response.body?.error === 'invalid_grant') {
            return null
        }

        console.error(err);
        return null;
    }
}

/** Отзыв refresh token при логауте */
export async function revokeToken(refreshToken: string): Promise<void> {
    try {
        await superagent
            .post(`${AUTHENTIK_URL}/application/o/revoke/`)
            .auth(OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)
            .type('form')
            .send({ token: refreshToken, token_type_hint: 'refresh_token' })
            .timeout({ response: 3000, deadline: 5000 })
    } catch (err) {
        // Best-effort: не ломаем логаут, если authentik недоступен
        console.warn('Token revocation failed:', mapError2(err).message)
    }
}

export async function updateAuthentikProfile(
    id: number,
    data: { name?: string; email?: string }
): Promise<void> {
    const {authentikId} = await db.selectFrom("users").where("id", "=", id).select("authentikId").executeTakeFirstOrThrow();
    if (!authentikId) return;
    try {
        await superagent
            .patch(base(`/api/v3/core/users/${authentikId}/`))
            .set(authHeaders())
            .send(data)
    } catch (err) {
        throw mapError(err, `/api/v3/core/users/${authentikId}/`)
    }
}