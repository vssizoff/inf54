/**
 * Кастомные поля профиля, которые запрашивает форма регистрации.
 *
 * Единственный источник истины о составе этих полей: по нему строятся
 * валидатор `/users/register`, ответ `/users/:username` и форма
 * `RegistrationView.vue`. Добавить поле = дописать один объект сюда и
 * соответствующий `v-model` во фронтенде; больше трогать нечего.
 *
 * ## Где физически живут значения
 *
 * Авторомитетная копия — в `authentik.users.attributes` (JSONField), то есть поля
 * едут в authentik вместе с созданием учётки (`akApi.createUser`). Это даёт то,
 * ради чего вообще затевалась интеграция: профиль смотрятся и правятся в одной
 * админке, а политики могут опираться на них в тех же атрибутах.
 *
 * В базе inf54 есть колонка `users.attributes` (jsonb) — её зеркало. Оно нужно
 * для чтений: список пользователей рендерится одной выборкой, без N обращений к
 * API authentik. Зеркало обновляется при регистрации, при `/me` и при входе
 * (см. mergeAuthentikProfile в sql/users.sql.ts).
 *
 * ## Почему не enrollment flow
 *
 * Заводить эти поля через Prompt Stage (`field_key = attributes.school`) в
 * flow'е регистрации не нужно: регистрация идёт через Admin API, а не через
 * executor, и атрибуты передаются прямо в теле запроса. Flow понадобился бы
 * только если бы регистрацию прогоняли headless-цепочкой стадий — тогда
 * пришлось бы дублировать состав полей в конфиге стадии, и он рассинхронизировался
 * бы с этим файлом.
 */

export type AttributeKind = "text" | "number" | "select";

export interface AttributeField {
    /** Ключ в объекте attributes. Совпадает с именем поля во фронтенде. */
    key: string;
    /** Подпись над полем. */
    label: string;
    kind: AttributeKind;
    required: boolean;
    /** Для kind === "select". */
    choices?: ReadonlyArray<string>;
    /** Ограничения длины/диапазона, общие для бэкенда и атрибута `maxlength` во фронтенде. */
    min?: number;
    max?: number;
    /** Регулярка для текстовых полей, если нужен формат строже, чем «любая строка». */
    pattern?: RegExp;
    /** Сообщение, когда pattern не подошёл. */
    patternMessage?: string;
    placeholder?: string;
    hint?: string;
}

/**
 * Состав полей.
 *
 * Имена ключей попадают в authentik как есть, поэтому их стоит менять только
 * вместе с миграцией уже созданных учёток: старые значения останутся под
 * прежним ключом и перестанут читаться нашим UI.
 */
export const ATTRIBUTE_FIELDS: ReadonlyArray<AttributeField> = [
    {
        key: "school",
        label: "Школа",
        kind: "text",
        required: true,
        min: 2,
        max: 128,
        placeholder: "Гимназия № 154",
        hint: "Название школы как в официальном реестре"
    },
    {
        key: "gradeClass",
        label: "Класс",
        kind: "text",
        required: true,
        min: 1,
        max: 8,
        // Цифра параллели и необязательная буква класса: 9, 9А, 11Б
        pattern: /^\d{1,2}[А-Яа-яA-Za-z]?$/,
        patternMessage: "Класс указывается как «9» или «9А»",
        placeholder: "9А"
    },
    {
        key: "teacher",
        label: "Учитель",
        kind: "text",
        required: false,
        min: 2,
        max: 128,
        placeholder: "Иванова И. И.",
        hint: "Куратор, к которому можно обращаться по вопросам участия"
    },
    {
        key: "city",
        label: "Город",
        kind: "text",
        required: false,
        min: 1,
        max: 64,
        placeholder: "Челябинск"
    }
] as const;

/** Значение одного поля после валидации. Числа храним числами, а не строками. */
export type AttributeValue = string | number;

export type AttributesParseResult =
    | {ok: true; attributes: Record<string, AttributeValue>}
    /** Поле обязательно, но его нет или оно пустое. */
    | {ok: false; missing: Array<string>}
    /** Поле прислали, но значение не проходит ограничения. */
    | {ok: false; invalid: Array<{key: string; message: string}>};

function validateOne(field: AttributeField, raw: unknown): {ok: true; value?: AttributeValue} | {ok: false; message: string} {
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
        if (field.required) return {ok: false, message: "required"};
        // Необязательное поле не попадаёт в объект: пустая строка и отсутствие
        // поля должны означать одно и то же, иначе фильтр по атрибуту в
        // authentik начал бы различать их.
        return {ok: true, value: undefined};
    }
    if (field.kind === "number") {
        const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
        if (!Number.isFinite(n)) return {ok: false, message: "ожидалось число"};
        if (field.min !== undefined && n < field.min) return {ok: false, message: `не меньше ${field.min}`};
        if (field.max !== undefined && n > field.max) return {ok: false, message: `не больше ${field.max}`};
        return {ok: true, value: n};
    }
    if (typeof raw !== "string") return {ok: false, message: "ожидалась строка"};
    const value = raw.trim();
    if (field.min !== undefined && value.length < field.min) return {ok: false, message: `не короче ${field.min} символов`};
    if (field.max !== undefined && value.length > field.max) return {ok: false, message: `не длиннее ${field.max} символов`};
    if (field.pattern && !field.pattern.test(value)) return {ok: false, message: field.patternMessage ?? "неверный формат"};
    if (field.choices && !field.choices.includes(value)) return {ok: false, message: "значение вне списка"};
    return {ok: true, value};
}

/**
 * Проверить присланный объект атрибутов и вернуть нормализованный.
 *
 * Неизвестные ключи отбрасываются молча: их проброс в authentik означал бы, что
 * любой клиент может наполнять JSONField произвольными данными, которые потом
 * увидят администраторы и политики.
 */
export function parseAttributes(raw: unknown): AttributesParseResult {
    const source = (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : {};
    const attributes: Record<string, AttributeValue> = {};
    const missing: string[] = [];
    const invalid: Array<{key: string; message: string}> = [];
    for (const field of ATTRIBUTE_FIELDS) {
        const result = validateOne(field, source[field.key]);
        if (!result.ok) {
            if (result.message === "required") missing.push(field.key);
            else invalid.push({key: field.key, message: result.message});
            continue;
        }
        if (result.value !== undefined) attributes[field.key] = result.value;
    }
    // Порядок важен: сначала сообщаем о недостающих обязательных полях, иначе
    // клиент, приславший пустую форму, получил бы список «слишком коротких»
    // значений вместо «заполните обязательное».
    if (missing.length) return {ok: false, missing};
    if (invalid.length) return {ok: false, invalid};
    return {ok: true, attributes};
}
