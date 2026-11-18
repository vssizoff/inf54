import {db} from "./index.sql.js";
import {sql} from "kysely";

export default async function () {
    try {
        await db.schema.createTable("news")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("datetime", "timestamp", cb => cb.notNull())
            .addColumn("title", "varchar(50)", cb => cb.notNull())
            .addColumn("description", "text", cb => cb.notNull())
            .addColumn("img", "varchar(256)")
            .addColumn("fullText", "text", cb => cb.notNull()).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("newsImages")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("newId", "integer", cb => cb.notNull().references("news.id"))
            .addColumn("image", "varchar(256)", cb => cb.notNull()).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("emailConfirmations")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("email", "varchar(256)", cb => cb.notNull())
            .addColumn("code", "varchar(6)", cb => cb.notNull())
            .addColumn("token", "varchar(512)", cb => cb.notNull().unique())
            .addColumn("expires", "timestamp", cb => cb.notNull()).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("users")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("username", "varchar(50)", cb => cb.notNull().unique())
            .addColumn("codeforcesHandle", "varchar(50)")
            .addColumn("codeforcesHandleLowerCase", "varchar(50)")
            .addColumn("firstName", "varchar(50)", cb => cb.notNull())
            .addColumn("lastName", "varchar(50)", cb => cb.notNull())
            .addColumn("email", "varchar(64)", cb => cb.unique().notNull())
            // nullable: пароль хранится в authentik, локальный хэш — только фолбэк
            // для случаев, когда authentik недоступен (см. backend/authentik.ts)
            .addColumn("passwordHash", "varchar(256)")
            .addColumn("isAdmin", "boolean", cb => cb.notNull().defaultTo(false))
            // uid пользователя в authentik (стабилен для одного инстанса+юзера)
            .addColumn("authentikUid", "varchar(64)", cb => cb.unique())
            // кастомные атрибуты профиля; авторитетная копия лежит в authentik.attributes
            .addColumn("attributes", "jsonb", cb => cb.notNull().defaultTo("{}"))
            .execute();
    } catch (error) {}
    try {
        await db.schema.createTable("sessions")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("userId", "integer", cb => cb.notNull().references("users.id"))
            .addColumn("device", "text")
            .addColumn("os", "text")
            .addColumn("browser", "text")
            .addColumn("mobile", "boolean")
            .addColumn("lastRefresh", "timestamp", cb => cb.notNull())
            .execute();
    } catch (error) {}
    try {
        await db.schema.createTable("contestGroups")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("name", "varchar(512)", cb => cb.notNull())
            .addColumn("link", "varchar(512)", cb => cb.notNull()).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("contests")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("groupId", "varchar(16)")
            .addColumn("name", "varchar(512)", cb => cb.notNull())
            .addColumn("contestId", "integer", cb => cb.notNull())
            .addColumn("available", "boolean", cb => cb.defaultTo(true))
            .addColumn("solutionsPublishDatetime", "timestamp")
            .addColumn("solutionsVideoId", "varchar(64)")
            .addColumn("problemsPdfLink", "varchar(512)").execute();
    } catch (error) {}
    try {
        await db.schema.createTable("officialResults")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("contestId", "integer", cb => cb.notNull().references("contests.id"))
            .addColumn("user", "varchar(64)", cb => cb.notNull())
            .addColumn("result", "integer", cb => cb.notNull())
            .addColumn("datetime", "timestamp", cb => cb.notNull()).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("unofficialResults")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("contestId", "integer", cb => cb.notNull().references("contests.id"))
            .addColumn("user", "varchar(64)", cb => cb.notNull())
            .addColumn("result", "integer", cb => cb.notNull())
            .addColumn("datetime", "timestamp", cb => cb.notNull()).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("usersContests")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("user", "integer", cb => cb.notNull().references("users.id"))
            .addColumn("contest", "integer", cb => cb.notNull().references("contests.id"))
            .addColumn("place", "integer", cb => cb.notNull()).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("problems")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("contest", "integer", cb => cb.notNull().references("contests.id"))
            .addColumn("title", "varchar(512)", cb => cb.notNull())
            .addColumn("pdfLink", "varchar(512)")
            .addColumn("available", "boolean", cb => cb.defaultTo(true)).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("standings")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("contest", "integer", cb => cb.notNull().references("contests.id"))
            .addColumn("user", "integer", cb => cb.notNull().references("users.id"))
            .addColumn("task", "integer", cb => cb.notNull().references("problems.id"))
            .addColumn("status", "integer", cb => cb.notNull())
            .addColumn("available", "boolean", cb => cb.defaultTo(true))
            .addColumn("datetime", "timestamp", cb => cb.notNull())
            .addColumn("notOfficial", "boolean", cb => cb.defaultTo(false)).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("articleRepos")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("repo", "text", cb => cb.notNull().unique())
            .addColumn("user", "integer", cb => cb.notNull().references("users.id"))
            .addColumn("datetime", "timestamp", cb => cb.notNull()).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("articlePermissions")
            .addColumn("id", "serial", cb => cb.primaryKey().unique())
            .addColumn("article", "integer", cb => cb.notNull().references("articleRepos.id"))
            .addColumn("user", "integer", cb => cb.notNull().references("users.id"))
            .addColumn("read", "boolean", cb => cb.defaultTo(false))
            .addColumn("write", "boolean", cb => cb.defaultTo(false)).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("apps")
            .addColumn("id", "varchar(64)", cb => cb.notNull().primaryKey().unique())
            .addColumn("owner", "integer", cb => cb.notNull().references("users.id"))
            .addColumn("imgUrl", "varchar(256)", cb => cb.notNull())
            .addColumn("displayName", "varchar(128)", cb => cb.notNull())
            .addColumn("description", "varchar(512)", cb => cb.notNull()).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("events")
            .addColumn("id", "uuid", cb => cb.notNull().defaultTo(sql`gen_random_uuid()`).primaryKey().unique())
            .addColumn("imgUrl", "varchar(256)", cb => cb.notNull())
            .addColumn("displayName", "varchar(128)", cb => cb.notNull())
            .addColumn("description", "varchar(512)", cb => cb.notNull())
            .addColumn("autoAccept", "boolean", cb => cb.notNull().defaultTo(false))
            .addColumn("showInList", "boolean", cb => cb.notNull().defaultTo(true))
            .addColumn("opened", "boolean", cb => cb.notNull().defaultTo(true))
            .addColumn("editable", "boolean", cb => cb.notNull().defaultTo(true))
            .addColumn("account", "boolean", cb => cb.notNull().defaultTo(true))
            .addColumn("emailConfirm", "boolean", cb => cb.notNull().defaultTo(true))
            .addColumn("summaryUrl", "varchar(256)", cb => cb.notNull().defaultTo(""))
            .addColumn("formFields", "jsonb", cb => cb.notNull().defaultTo("{}"))
            .addColumn("registerStart", "timestamp")
            .addColumn("registerEnd", "timestamp")
            .addColumn("datetime", "timestamp").execute();
    } catch (error) {}
    try {
        await db.schema.createTable("eventAdmins")
            .addColumn("id", "serial", cb => cb.notNull().primaryKey().unique())
            .addColumn("event", "uuid", cb => cb.notNull().references("events.id"))
            .addColumn("user", "integer", cb => cb.notNull().references("users.id")).execute();
    } catch (error) {}
    try {
        await db.schema.createTable("eventParticipants")
            .addColumn("id", "serial", cb => cb.notNull().primaryKey().unique())
            .addColumn("event", "uuid", cb => cb.notNull().references("events.id"))
            .addColumn("user", "integer", cb => cb.references("users.id"))
            .addColumn("formFields", "jsonb", cb => cb.notNull())
            .addColumn("originalFormFields", "jsonb", cb => cb.notNull())
            .addColumn("accepted", "boolean", cb => cb.defaultTo(false))
            .addColumn("rejected", "boolean", cb => cb.defaultTo(false))
            .addColumn("visited", "boolean", cb => cb.defaultTo(false))
            .addColumn("datetime", "timestamp", cb => cb.notNull())
            .addColumn("editDatetime", "timestamp", cb => cb.notNull()).execute();
    } catch (error) {}

    // ---- миграция на authentik ------------------------------------------------
    // Все createTable выше обёрнуты в try/catch, поэтому на живой базе новые
    // колонки не появятся сами: их надо отдельно досказать. Выражения
    // idempotent ("if not exists"), блок можно безопасно гонять при каждом старте.
    //
    // passwordHash остаётся существующим и становится nullable только для новых
    // установок; на живой базе колонка и так NOT NULL, но мы намеренно НЕ снимаем
    // ограничение — существующие строки хранят bcrypt-хэш, который служит фолбэком.
    // Nullable нужна лишь для пользователей, созданных напрямую в authentik.
    for (const statement of [
        `alter table "users" add column if not exists "authentikUid" varchar(64)`,
        `alter table "users" add column if not exists "attributes" jsonb not null default '{}'::jsonb`,
        `alter table "users" alter column "passwordHash" drop not null`,
        // unique-индекс вместо inline-констрейнта: add constraint не поддерживает if not exists
        `create unique index if not exists "users_authentikUid_unique" on "users" ("authentikUid")`,
    ]) {
        try {
            await sql.raw(statement).execute(db);
        } catch (error) {
            // На чистой установке колонка уже создана вместе с таблицей, а на живой
            // базе drop not null может не пройти, если где-то остались пустые строки.
            // Роняем старт из-за этого не стоит: пишем в лог и идём дальше.
            console.warn("setup: migration statement failed:", statement, error);
        }
    }
}
