/**
 * Кастомные поля профиля на стороне фронтенда.
 *
 * Состав и правила валидации задаются в `backend/attributes.ts` — он
 * единственный решает, что попадёт в authentik. Здесь лежит только то, что
 * нужно для отрисовки формы: подписи, подсказки, ограничения для атрибутов
 * полей и типы контролов. Добавлять поле сюда без правки в backend смысле нет:
 * бэкенд отбрасывает неизвестные ключи молча.
 *
 * `kind` соответствует компонентам termui: text/number → TermInput,
 * select → TermSelect.
 */

export type AttributeKind = "text" | "number" | "select";

export interface AttributeField {
    key: string;
    label: string;
    kind: AttributeKind;
    required: boolean;
    /** Мутабельный массив, а не ReadonlyArray: TermSelect принимает `options: any[]`. */
    choices?: string[];
    min?: number;
    max?: number;
    pattern?: RegExp;
    patternMessage?: string;
    placeholder?: string;
    hint?: string;
}

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
];

export type AttributeValues = Record<string, string>;

/** Пустой набор значений: поля управляются через v-model как строки. */
export function emptyAttributes(): AttributeValues {
    const values: AttributeValues = {};
    for (const field of ATTRIBUTE_FIELDS) values[field.key] = "";
    return values;
}

/** Заполнить значения из присланного сервером объекта атрибутов. */
export function attributesFromResponse(source: Record<string, unknown> | undefined | null): AttributeValues {
    const values = emptyAttributes();
    if (!source) return values;
    for (const field of ATTRIBUTE_FIELDS) {
        const raw = source[field.key];
        if (raw === undefined || raw === null) continue;
        values[field.key] = String(raw);
    }
    return values;
}

/** Ошибка по конкретному полю (ключ — name поля формы). */
export type AttributeErrors = Record<string, string>;

function validateField(field: AttributeField, raw: string): string {
    const value = raw.trim();
    if (!value) return field.required ? "Поле обязательно" : "";
    if (field.kind === "number") {
        const n = Number(value.replace(",", "."));
        if (!Number.isFinite(n)) return "Ожидалось число";
        if (field.min !== undefined && n < field.min) return `Не меньше ${field.min}`;
        if (field.max !== undefined && n > field.max) return `Не больше ${field.max}`;
        return "";
    }
    if (field.min !== undefined && value.length < field.min) return `Не короче ${field.min} символов`;
    if (field.max !== undefined && value.length > field.max) return `Не длиннее ${field.max} символов`;
    if (field.pattern && !field.pattern.test(value)) return field.patternMessage ?? "Неверный формат";
    if (field.choices && !field.choices.includes(value)) return "Значение вне списка";
    return "";
}

/** Проверить весь набор; пустой объект ошибок означает «можно отправлять». */
export function validateAttributes(values: AttributeValues): AttributeErrors {
    const errors: AttributeErrors = {};
    for (const field of ATTRIBUTE_FIELDS) {
        const message = validateField(field, values[field.key] ?? "");
        if (message) errors[field.key] = message;
    }
    return errors;
}

/**
 * Собрать тело запроса: пустые необязательные поля уходят, а не передаются как
 * «» — бэкенд трактовает их одинаково, но в JSON пустых строк быть не должно.
 */
export function attributesToPayload(values: AttributeValues): Record<string, string | number> {
    const payload: Record<string, string | number> = {};
    for (const field of ATTRIBUTE_FIELDS) {
        const raw = (values[field.key] ?? "").trim();
        if (!raw) continue;
        payload[field.key] = field.kind === "number" ? Number(raw.replace(",", ".")) : raw;
    }
    return payload;
}
