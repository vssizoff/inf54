type AppConfig = {
    AUTHENTIK_URL: string
    OIDC_CLIENT_ID: string
    OIDC_REDIRECT_URI: string
}

function loadConfig(): AppConfig {
    const cfg = (window as any).__CONFIG__ as AppConfig | undefined
    if (!cfg) {
        throw new Error('Runtime config not loaded. Check /config.js')
    }
    return cfg
}

export const config = loadConfig()