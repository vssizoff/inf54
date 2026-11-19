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

export async function submitLogin(username: string, password: string): Promise<boolean> {
    const challenge = await requestExecutor("POST", {
        component: "ak-stage-identification",
        uid_field: username
    });
    // console.log(challenge);
    const challenge2 = await requestExecutor<{response_errors?: {password?: [{code: string}]}}>("POST", {
        component: "ak-stage-password",
        password: password
    });
    // console.log(challenge2, (challenge2.response_errors?.password ?? [])[0]?.code);
    return (challenge2.response_errors?.password ?? [])[0]?.code !== "invalid";
}