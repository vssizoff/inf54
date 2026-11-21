import {config} from "@/config.ts";

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
    const state = crypto.randomUUID()
    const nonce = crypto.randomUUID()

    // Сохраняем state для проверки на callback
    sessionStorage.setItem('oidc_state', state)

    const authorizeUrl = new URL(`${window.location.origin}/application/o/authorize/`)
    authorizeUrl.searchParams.set('client_id', config.OIDC_CLIENT_ID)
    authorizeUrl.searchParams.set('redirect_uri', config.OIDC_REDIRECT_URI)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('scope', 'openid email profile offline_access')
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('nonce', nonce)
    authorizeUrl.searchParams.set('prompt', 'none') // Ключевой параметр!

    console.log(authorizeUrl.toString());
    window.location.href = authorizeUrl.toString();
}

export async function submitLogin(username: string, password: string): Promise<boolean> {
    const challenge = await requestExecutor("POST", {
        component: "ak-stage-identification",
        uid_field: username
    });
    // console.log(challenge);
    const challenge2 = await requestExecutor<{final_redirect?: boolean}>("POST", {
        component: "ak-stage-password",
        password: password
    });
    // console.log(challenge2, !challenge2.final_redirect);
    if (!challenge2.final_redirect) return false;
    await initiateOidcAfterFlow();
    return true;
}