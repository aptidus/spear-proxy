export type AuthProvider = "antigravity" | "codex" | "copilot" | "anthropic"
export type AuthSource = "codex-cli" | "cli-proxy"

export interface ProviderAccount {
    id: string
    provider: AuthProvider
    email?: string
    login?: string
    label?: string
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    projectId?: string
    authSource?: AuthSource
    createdAt?: string
    updatedAt?: string
}

export interface ProviderAccountSummary {
    id: string
    provider: AuthProvider
    displayName: string
    email?: string
    login?: string
    label?: string
    expiresAt?: number
}
