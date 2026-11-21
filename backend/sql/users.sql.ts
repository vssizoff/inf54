import randomstring from "randomstring";
import {Database, db} from "./index.sql.js";
import bcrypt from "bcrypt";
import {SelectExpression} from "kysely";
import {UpdateObjectExpression} from "kysely/dist/cjs/parser/update-set-parser.js";
import {verifyAccessToken} from "../jwt.js";
import {sendConfirmationEmail} from "../mail";
import cryptoRandomString from 'crypto-random-string';

export function generateRandomString() {
    return randomstring.generate({length: 256, charset: ["alphanumeric", '@', '#', '%', '^', '&', '*', ':', ';']});
}

export function generateToken() {
    return `${generateRandomString()}.${Date.now()}`;
}

export async function registerStart(email: string) {
    const code = cryptoRandomString({length: 6});
    const token = generateToken();
    let date = new Date();
    date.setMinutes(date.getMinutes() + 10);
    await db.insertInto("emailConfirmations").values({
        email, code, token, expires: date
    }).executeTakeFirstOrThrow();
    console.log(email, code);
    // await sendConfirmationEmail(email, code);
    return code;
}

export async function emailConfirm(email: string, code: string) {
    let data = await db.selectFrom("emailConfirmations").select(["token", "expires"]).limit(1)
        .where(({and, eb}) => and([eb("email", '=', email), eb("code", '=', code)]))
        .executeTakeFirst();
    if (!data || new Date() > data.expires) return null;
    db.updateTable("emailConfirmations").set({code: ""})
        .where(({and, eb}) => and([eb("email", '=', email), eb("code", '=', code)]))
    return data.token;
}

export async function getEmailByToken(token: string) {
    let data = await db.selectFrom("emailConfirmations").select(["email"]).limit(1)
        .where(({and, eb}) => and([eb("token", '=', token)]))
        .executeTakeFirst();
    if (!data) return null;
    return data.email;
}

export async function removeEmailConfirm(token: string) {
    await db.deleteFrom("emailConfirmations").where("token", '=', token).execute();
}

export async function register({username, codeforcesHandle, firstName, lastName, email, authentikId}: {username: string, codeforcesHandle?: string, firstName: string, lastName: string, email: string, authentikId: number}) {
    await db.insertInto("users").values({
        username,
        codeforcesHandle,
        codeforcesHandleLowerCase: codeforcesHandle?.toLowerCase(),
        firstName,
        lastName,
        email: email.toLowerCase(),
        isAdmin: false,
        authentikId
    }).executeTakeFirstOrThrow();
}

export async function isUniqueUsername(username: string): Promise<boolean> {
    return !Boolean(await db.selectFrom("users").where("username", '=', username).select("id").executeTakeFirst());
}

export async function isUniqueCodeforcesHandle(codeforcesHandle: string): Promise<boolean> {
    return !Boolean(await db.selectFrom("users").where("codeforcesHandleLowerCase", '=', codeforcesHandle.toLowerCase()).select("id").executeTakeFirst());
}

export async function isUniqueEmail(email: string): Promise<boolean> {
    return !Boolean(await db.selectFrom("users").where("email", '=', email.toLowerCase()).select("id").executeTakeFirst());
}

export async function getUserByUsername(username: string, select: Array<SelectExpression<Database, "users">> = ["username", "codeforcesHandle", "firstName", "lastName", "isAdmin"]) {
    return db.selectFrom("users").where("username", '=', String(username)).select(select).executeTakeFirst();
}

export async function getUserByToken(token: string, select: Array<SelectExpression<Database, "users">> = ["id", "username", "codeforcesHandle", "firstName", "lastName", "isAdmin"]) {
    let id = await verifyAccessToken(token);
    if (!id) return null;
    return db.selectFrom("users").where("id", '=', id).select(select).executeTakeFirstOrThrow();
}

export async function patchUser(id: number, patch: UpdateObjectExpression<Database, "users", "users">) {
    await db.updateTable("users").set(patch).where("id", '=', id).executeTakeFirstOrThrow();
}

export async function patchUserPassword(id: number, password: string) {
    await db.updateTable("users").set({passwordHash: await bcrypt.hash(password, 12)}).where("id", '=', id).executeTakeFirstOrThrow();
}

export async function getCodeforcesHandleUserIdMap(): Promise<{[key: string]: number}> {
    return Object.fromEntries((await db.selectFrom("users").select(["id", "codeforcesHandleLowerCase"]).execute()).map(({id, codeforcesHandleLowerCase}) => [codeforcesHandleLowerCase, id]));
}

export async function getUserById(id: number, select: Array<SelectExpression<Database, "users">> = ["id"]) {
    return db.selectFrom("users").where("id", '=', id).select(select).executeTakeFirst();
}

export async function getUsernameById(id: number): Promise<string | undefined> {
    return (await getUserById(id, ["username"]))?.username;
}

export async function getIdByEmail(email: string): Promise<number | undefined> {
    return (await db.selectFrom("users").where("email", '=', email.toLowerCase()).select(["id"]).executeTakeFirst())?.id;
}

export async function getUserIdByUsername(username: string): Promise<number | undefined> {
    return (await getUserByUsername(username, ["id"]))?.id;
}

export async function getAllUsers(select: Array<SelectExpression<Database, "users">> = ["username"]) {
    return db.selectFrom("users").select(select).execute();
}

export async function adminUsersPatch(data: Array<{id: number, codeforcesHandle?: string}>) {
    await Promise.all(data.map(async ({id, codeforcesHandle}) => {
        if (codeforcesHandle) await db.updateTable("users").where("id", '=', id).set({codeforcesHandle, codeforcesHandleLowerCase: codeforcesHandle.toLowerCase()}).execute();
    }));
}

export async function isAdmin(token: string): Promise<boolean> {
    let userId = await verifyAccessToken(token);
    if (!userId) return false;
    let isAdmin = await db.selectFrom("users").where("id", '=', userId).select(["isAdmin"]).executeTakeFirstOrThrow();
    return isAdmin.isAdmin;
}

export async function makeAdmin(id: number) {
    await db.updateTable("users").where("id", '=', id).set({isAdmin: true}).execute();
}