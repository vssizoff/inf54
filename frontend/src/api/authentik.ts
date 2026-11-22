import {config} from "@/config.ts";
import axios from "axios";
import {SERVER_URL} from "@/serverConfig.ts";
import {useRouter} from "vue-router";

const FLOW = "inf54-sign-in";
const EXECUTOR = `/api/v3/flows/executor/${FLOW}/`;

async function requestExecutor<T>(method: "GET" | "POST", body: object | null = null): Promise<T> {
    const response = await fetch(EXECUTOR, body ? {
        method,
        credentials: "include",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    } : {
        method,
        credentials: "include"
    });

    return response.json();
}

export async function startLogin() {
    const challenge = await requestExecutor<{component: string}>("GET");
    return challenge.component === "ak-stage-identification";
}

async function initiateOidcAfterFlow() {
    const params = new URLSearchParams(window.location.search)
    let to = params.get("next") ?? `${window.location.origin}/me`;
    const state = crypto.randomUUID()
    const nonce = crypto.randomUUID()

    // Сохраняем state для проверки на callback
    sessionStorage.setItem('oidc_state', state)

    const redirectUri = new URL(config.OIDC_REDIRECT_URI);
    redirectUri.searchParams.set('next', to);
    console.log(redirectUri.toString());

    const authorizeUrl = new URL(`${window.location.origin}/application/o/authorize/`)
    authorizeUrl.searchParams.set('client_id', config.OIDC_CLIENT_ID)
    authorizeUrl.searchParams.set('redirect_uri', redirectUri.toString())
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('scope', 'openid email profile offline_access')
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('nonce', nonce)
    authorizeUrl.searchParams.set('prompt', 'none') // Ключевой параметр!

    console.log(authorizeUrl.toString());
    window.location.href = authorizeUrl.toString();
}

export async function submitLogin(username: string, password: string): Promise<boolean> {
    const response = await axios.post(`${SERVER_URL}/users/signin/migrate`, {username, password});
    if (response.status !== 200) return false;
    await requestExecutor("POST", {
        component: "ak-stage-identification",
        uid_field: username
    });
    const challenge2 = await requestExecutor<{final_redirect?: boolean}>("POST", {
        component: "ak-stage-password",
        password: password
    });
    if (!challenge2.final_redirect) return false;
    await initiateOidcAfterFlow();
    return true;
}

export async function signInCleanup() {
    await axios.post(`${SERVER_URL}/users/signin/cleanup`);
}