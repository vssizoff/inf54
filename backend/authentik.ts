import superagent from 'superagent'

const AUTHENTIK_URL = "http://authentik"
const AUTHENTIK_TOKEN = process.env.AUTHENTIK_TOKEN!

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