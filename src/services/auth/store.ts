import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import consola from "consola"
import { parseRetryDelay } from "~/lib/retry"
import type { AuthProvider, ProviderAccount, ProviderAccountSummary } from "./types"
import { getDataDir } from "~/lib/data-dir"

const AUTH_DIR = join(getDataDir(), "auth")

interface StoredAuthFile {
    id: string
    type: string
    email?: string
    login?: string
    label?: string
    auth_source?: string
    access_token: string
    refresh_token?: string
    expires_at?: number
    project_id?: string
    created_at?: string
    updated_at?: string
    organization_id?: string
}

type RateLimitState = {
    rateLimitedUntil: number | null
    consecutiveFailures: number
}

const rateLimitState = new Map<string, RateLimitState>()

function ensureAuthDir(): void {
    if (!existsSync(AUTH_DIR)) {
        mkdirSync(AUTH_DIR, { recursive: true })
    }
}

function sanitizeFileKey(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function accountKey(provider: AuthProvider, id: string): string {
    return `${provider}:${id}`
}

function providerToStoredType(provider: AuthProvider): string {
    if (provider === "copilot") return "github-copilot"
    return provider
}

function storedTypeToProvider(type: string): AuthProvider | null {
    if (type === "github-copilot" || type === "copilot") return "copilot"
    if (type === "antigravity") return "antigravity"
    if (type === "codex") return "codex"
    if (type === "anthropic") return "anthropic"
    return null
}

function toSummary(account: ProviderAccount): ProviderAccountSummary {
    const displayName =
        account.label ||
        account.email ||
        account.login ||
        `${account.provider}-${account.id}`

    return {
        id: account.id,
        provider: account.provider,
        displayName,
        email: account.email,
        login: account.login,
        label: account.label,
        expiresAt: account.expiresAt,
    }
}

function loadAccountFromFile(path: string): ProviderAccount | null {
    try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as StoredAuthFile
        const provider = storedTypeToProvider(raw.type)
        if (!provider || !raw.access_token || !raw.id) {
            return null
        }
        return {
            id: raw.id,
            provider,
            email: raw.email,
            login: raw.login,
            label: raw.label,
            accessToken: raw.access_token,
            refreshToken: raw.refresh_token,
            expiresAt: raw.expires_at,
            projectId: raw.project_id,
            authSource: raw.auth_source as ProviderAccount["authSource"],
            createdAt: raw.created_at,
            updatedAt: raw.updated_at,
            organizationId: raw.organization_id,
        }
    } catch (error) {
        consola.warn("Failed to parse auth file:", path, error)
        return null
    }
}

function writeAccountFile(account: ProviderAccount): void {
    ensureAuthDir()

    const filename = `${providerToStoredType(account.provider)}-${sanitizeFileKey(account.id)}.json`
    const path = join(AUTH_DIR, filename)
    const now = new Date().toISOString()

    const payload: StoredAuthFile = {
        id: account.id,
        type: providerToStoredType(account.provider),
        email: account.email,
        login: account.login,
        label: account.label,
        auth_source: account.authSource,
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        expires_at: account.expiresAt,
        project_id: account.projectId,
        created_at: account.createdAt || now,
        updated_at: now,
        organization_id: account.organizationId,
    }

    writeFileSync(path, JSON.stringify(payload, null, 2))
}

export const authStore = {
    listAccounts(provider?: AuthProvider): ProviderAccount[] {
        ensureAuthDir()
        const files = readdirSync(AUTH_DIR).filter(f => f.endsWith(".json"))
        const accounts: ProviderAccount[] = []
        for (const file of files) {
            const account = loadAccountFromFile(join(AUTH_DIR, file))
            if (!account) continue
            if (provider && account.provider !== provider) continue
            accounts.push(account)
        }
        return accounts
    },

    listSummaries(provider?: AuthProvider): ProviderAccountSummary[] {
        return this.listAccounts(provider).map(toSummary)
    },

    getAccount(provider: AuthProvider, id: string): ProviderAccount | null {
        const accounts = this.listAccounts(provider)
        return accounts.find(acc => acc.id === id) || null
    },

    saveAccount(account: ProviderAccount): void {
        writeAccountFile(account)
    },

    deleteAccount(provider: AuthProvider, id: string): boolean {
        ensureAuthDir()
        const filename = `${providerToStoredType(provider)}-${sanitizeFileKey(id)}.json`
        const path = join(AUTH_DIR, filename)
        if (!existsSync(path)) return false
        try {
            unlinkSync(path)
            return true
        } catch (error) {
            consola.warn("Failed to delete auth file:", path, error)
            return false
        }
    },

    markRateLimited(
        provider: AuthProvider,
        id: string,
        statusCode: number,
        errorText: string,
        retryAfterHeader?: string
    ): number {
        const key = accountKey(provider, id)
        const existing = rateLimitState.get(key) || { rateLimitedUntil: null, consecutiveFailures: 0 }
        existing.consecutiveFailures += 1

        const retryDelay = parseRetryDelay(errorText, retryAfterHeader)
        const baseDelay = retryDelay ?? 30_000
        const delay = retryDelay ? Math.max(baseDelay + 500, 2_000) : baseDelay
        const nextUntil = Date.now() + delay
        existing.rateLimitedUntil = nextUntil
        rateLimitState.set(key, existing)

        consola.warn(
            `[${provider}] Account ${id} rate limited (status ${statusCode}) for ${Math.ceil(delay / 1000)}s`
        )
        return delay
    },

    isRateLimited(provider: AuthProvider, id: string): boolean {
        const key = accountKey(provider, id)
        const state = rateLimitState.get(key)
        if (!state || !state.rateLimitedUntil) return false
        if (state.rateLimitedUntil <= Date.now()) {
            rateLimitState.set(key, { ...state, rateLimitedUntil: null })
            return false
        }
        return true
    },

    markSuccess(provider: AuthProvider, id: string): void {
        const key = accountKey(provider, id)
        rateLimitState.set(key, { rateLimitedUntil: null, consecutiveFailures: 0 })
    },
}
