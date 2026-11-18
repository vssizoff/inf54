/**
 * Ошибка обращения к authentik с различением «не дошли» и «дошли, но отказ».
 *
 * Флаг `transport` — опора всей схемы отката. Если authentik не ответил (DNS,
 * соединение, таймаут, 5xx), пользователь ничего не потеряет, если мы проверим
 * пароль локальным bcrypt. Если же authentik ответил отказом, откатываться
 * нельзя: локальный хэш слабее защищён брутфорсом, чем живая цепочка стадий с
 * reputation-политиками и throttling.
 */
export class AuthentikError extends Error {
    readonly status: number;
    readonly body: string;
    /** true — запрос не дошёл до authentik или тот упал; false — осмысленный отказ. */
    readonly transport: boolean;

    constructor(message: string, status: number, body: string, transport: boolean) {
        super(message);
        this.name = "AuthentikError";
        this.status = status;
        this.body = body;
        this.transport = transport;
    }

    /** Сбой сети/таймаут/5xx: разрешает локальный фолбэк. */
    static unreachable(message: string, cause: unknown): AuthentikError {
        return new AuthentikError(message, 0, String(cause ?? ""), true);
    }

    /** Ответ сервера: 5xx считаем сбоем, остальные — отказом. */
    static fromResponse(status: number, body: string): AuthentikError {
        const transport = status >= 500;
        return new AuthentikError(`authentik ответил ${status}`, status, body, transport);
    }

    /** 401/403 на API-токене: это проблема конфигурации, а не пароль пользователя. */
    static misconfigured(message: string, status: number, body: string): AuthentikError {
        return new AuthentikError(message, status, body, true);
    }

    override toString(): string {
        return `${this.name}(status=${this.status}, transport=${this.transport}): ${this.message} :: ${this.body.slice(0, 512)}`;
    }
}
