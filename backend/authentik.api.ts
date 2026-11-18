/**
 * Admin API authentik (токен сервисной учётки).
 *
 * Используется для того, чего headless-flow делать не может или не стоит:
 * заводить пользователя при регистрации, менять пароль при восстановлении,
 * находить учётку по username/атрибутам.
 *
 * Два неочевидных места, вытекших из исходников 2026.8:
 *
 *  * **`password` при создании игнорируется.** В `UserSerializer` поля
 *    `password`/`password_hash`/`permissions` добавляются только когда в контексте
 *    есть `SERIALIZER_CONTEXT_BLUEPRINT`, то есть при импорте blueprint'а. Через
 *    обычный API их не передать. Попытка прислать их молча отбрасывается, и
 *    пользователь остаётся с unusable password — вход в него невозможен, причём
 *    без ошибки. Поэтому создание и установка пароля — два разных вызова
 *    (`createUser` + `setPassword`), и второй обязателен.
 *
 *  * **`set_password_hash` не годится для переноса наших bcrypt-хэшей.** Он
 *    принимает только значение в формате Django (`validate_password_hash`),
 *    строка `$2b$12$...` не пройдёт валидацию. Отсюда ленная миграция: пароль
 *    переносим только когда он известен в открытом виде, то есть при входе через
 *    форму. См. `ensureUserForLocal` в authentik.ts.
 *
 * Требуемые права сервисной учётки: `authentik_core.add_user`,
 * `authentik_core.change_user`, `authentik_core.delete_user`,
 * `authentik_core.reset_user_password` (последнее — именно для `set_password`).
 */

import {AuthentikError} from "./authentik.error.js";

/**
 * Профиль пользователя, достаточный для входа.
 *
 * Отдельный тип, потому что flow executor после стадии user_login отвечает
 * `/core/users/me/`, а не полным объектом из Admin API: path и is_active там
 * отсутствуют, и объявлять их обязательными значило бы врать о форме ответа.
 */
export interface AkUserSummary {
    uid: string;
    username: string;
    name: string;
    email: string;
    attributes: Record<string, unknown>;
}

export interface AkUser extends AkUserSummary {
    path: string;
    is_active: boolean;
}

interface Paginated<T> {
    results: T[];
    count?: number;
}

export interface CreateUserInput {
    username: string;
    name: string;
    email: string;
    path?: string;
    attributes?: Record<string, unknown>;
    isActive?: boolean;
}

export class AuthentikApi {
    constructor(
        private readonly baseUrl: string,
        private readonly token: string,
        private readonly timeout: number = 8000
    ) {}

    private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
        if (!this.token) {
            throw new AuthentikError("AK_API_TOKEN не задан", 0, "", false);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
            const response = await fetch(`${this.baseUrl}/api/v3${path}`, {
                ...init,
                signal: controller.signal,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    ...(init.headers ?? {})
                }
            });
            const text = await response.text();
            if (!response.ok) {
                // 401/403 на токене — это сломанная конфигурация, а не отказ
                // пользователю; transport=true, чтобы вход не блокировался
                // навсегда из-за протухшего токена.
                if (response.status === 401 || response.status === 403) {
                    throw AuthentikError.misconfigured(
                        `нет доступа к authentik API (${response.status}): проверьте AK_API_TOKEN и права сервисной учётки`,
                        response.status,
                        text
                    );
                }
                throw AuthentikError.fromResponse(response.status, text);
            }
            return (text ? JSON.parse(text) : {}) as T;
        } catch (error) {
            if (error instanceof AuthentikError) throw error;
            throw AuthentikError.unreachable(`запрос к authentik API не прошёл: ${path}`, error);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Та учётка, к которой относится токен из `AK_API_TOKEN`.
     *
     * Отдельный вход нужен диагностике (`ak-check.ts`, шаг 1) и проверке при
     * старте: права токена смотрятся в админке глазами, а «кто я вообще» из
     * ответа API — нет. 403 на этом запросе означает, что у service account
     * сняты права `authentik_core.view_user`, и дальше `findUserBy*` тоже не
     * работает.
     *
     * Форма ответа не плоская: `/core/users/me/` сериализуется
     * `SessionUserSerializer`, который оборачивает профиль в ключ `user`
     * (плоский `User` ждали бы от Admin API `/core/users/<uid>/`). Поле
     * `users` заполняется только при user switching; с обычным токеном там [].
     */
    async whoami(): Promise<AkUserSummary & {is_active?: boolean; is_superuser?: boolean} | null> {
        // `call` сам подставляет префикс /api/v3, поэтому путь относительно него:
        // /core/users/me/, а не /api/v3/core/users/me/.
        const payload = await this.call<{user?: AkUserSummary & {is_active?: boolean; is_superuser?: boolean}}>(
            "/core/users/me/"
        );
        const user = payload.user;
        if (!user?.uid || !user?.username) return null;
        return {
            uid: user.uid,
            username: user.username,
            email: user.email ?? "",
            name: user.name ?? "",
            attributes: user.attributes ?? {},
            is_active: user.is_active,
            is_superuser: user.is_superuser,
        };
    }

    /** Точный поиск по username (фильтр `username` есть в `UsersFilter`). */
    async findUserByUsername(username: string): Promise<AkUser | null> {
        const page = await this.call<Paginated<AkUser>>(
            `/core/users/?username=${encodeURIComponent(username)}`
        );
        return page.results?.[0] ?? null;
    }

    /**
     * Поиск по атрибуту — основной способ найти учётку по нашему `id`.
     *
     * Фильтр `attributes` принимает JSON вида `{"key":"value"}` и фильтрует по
     * точному совпадению вложенного ключа `attributes__<key>`. Пишем туда
     * `inf54UserId`, чтобы пережить смену username: он в наших краях правится
     * через /me, и искать по нему было бы хрупко.
     */
    async findUserByInf54Id(id: number): Promise<AkUser | null> {
        const filter = encodeURIComponent(JSON.stringify({inf54UserId: String(id)}));
        const page = await this.call<Paginated<AkUser>>(`/core/users/?attributes=${filter}`);
        return page.results?.[0] ?? null;
    }

    async findUserByUid(uid: string): Promise<AkUser | null> {
        try {
            return await this.call<AkUser>(`/core/users/${encodeURIComponent(uid)}/`);
        } catch (error) {
            if (error instanceof AuthentikError && error.status === 404) return null;
            throw error;
        }
    }

    /**
     * Создать пользователя без пароля.
     *
     * Пароль сюда не передаём сознательно: как объяснено в шапке модуля, поле
     * `password` в этом контексте игнорируется, и молчаливый отказ хуже явной
     * последовательности «создать → set_password». Вызывающий код обязан сразу
     * вызвать `setPassword`.
     */
    async createUser(input: CreateUserInput): Promise<AkUser> {
        return await this.call<AkUser>("/core/users/", {
            method: "POST",
            body: JSON.stringify({
                username: input.username,
                name: input.name,
                email: input.email,
                path: input.path ?? "inf54",
                is_active: input.isActive ?? true,
                attributes: input.attributes ?? {},
                // internal, а не external: external означает «привнесён из
                // внешнего источника» (LDAP/OIDC-source) и для наших учёток не
                // соответствует смыслу. Внутренний тип гарантированно проходит
                // штатную проверку пароля в stages/password.
                type: "internal"
            })
        });
    }

    /**
     * Установить пароль в открытом виде.
     *
     * `hashed: false` не отправляем: сериализатор `UserPasswordSetSerializer`
     * знает только поле `password`, лишнее поле DRF отбросит, а `set_password`
     * всё равно хэшит вход.
     */
    async setPassword(uid: string, password: string): Promise<void> {
        await this.call<void>(`/core/users/${encodeURIComponent(uid)}/set_password/`, {
            method: "POST",
            body: JSON.stringify({password})
        });
    }

    /**
     * Изменить профиль учётки.
     *
     * `username` здесь обязателен по смыслу, хотя API и позволяет его не присылать:
     * вход идёт по username, который смотрит authentik, поэтому правка у нас без
     * синхронизации там отрезает пользователю доступ.
     */
    async patchUser(
        uid: string,
        patch: Partial<Pick<AkUser, "username" | "name" | "email" | "is_active" | "path">> & {attributes?: Record<string, unknown>}
    ): Promise<AkUser> {
        return await this.call<AkUser>(`/core/users/${encodeURIComponent(uid)}/`, {
            method: "PATCH",
            body: JSON.stringify(patch)
        });
    }

    async deleteUser(uid: string): Promise<void> {
        await this.call<void>(`/core/users/${encodeURIComponent(uid)}/`, {method: "DELETE"});
    }
}

/**
 * Единственный экземпляр на процесс.
 *
 * Коннектов к authentik много (вход, регистрация, восстановление), а создавать
 * клиента в каждом вызове значило бы терять переиспользование keep-alive
 * соединений в bun. Конфигурация читается из окружения при старте и не меняется.
 */
export const akApi = new AuthentikApi(
    process.env.AK_URL ?? "http://authentik:9000",
    process.env.AK_API_TOKEN ?? "",
    Number(process.env.AK_TIMEOUT ?? 8000)
);
