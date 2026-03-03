/**
 * Anthropic OAuth (Claude Pro/Max subscription)
 * PKCE authorization code flow via claude.ai
 */

import consola from "consola"
import { createHash, randomBytes } from "node:crypto"
import { authStore } from "~/services/auth/store"
import type { ProviderAccount } from "~/services/auth/types"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
const SCOPES = "org:create_api_key user:profile user:inference"

/** Proxy-aware fetch — routes through residential relay if RELAY_PROXY_URL is set */
function proxyFetch(url: string, options: RequestInit): Promise<Response> {
    const fetchOptions: any = { ...options }
    const proxyUrl = process.env.RELAY_PROXY_URL
    if (proxyUrl) {
        fetchOptions.proxy = proxyUrl
    }
    return fetch(url, fetchOptions)
}

export interface AnthropicAuthSession {
    id: string
    state: string
    codeVerifier: string
    authUrl: string
    status: "pending" | "success" | "error"
    message?: string
    account?: ProviderAccount
    expiresAt: number
}

const sessions = new Map<string, AnthropicAuthSession>()

function base64UrlEncode(buffer: Buffer): string {
    return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
    const verifier = base64UrlEncode(randomBytes(32))
    const challengeBuffer = createHash("sha256").update(verifier).digest()
    const challenge = base64UrlEncode(challengeBuffer)
    return { verifier, challenge }
}

export async function startAnthropicOAuth(): Promise<AnthropicAuthSession> {
    const { verifier, challenge } = await generatePKCE()
    const id = randomBytes(16).toString("hex")

    const authParams = new URLSearchParams({
        code: "true",
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: verifier,
    })

    const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`

    const session: AnthropicAuthSession = {
        id,
        state: verifier,
        codeVerifier: verifier,
        authUrl,
        status: "pending",
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
    }

    sessions.set(id, session)
    return session
}

export async function completeAnthropicOAuth(
    sessionId: string,
    authCode: string
): Promise<AnthropicAuthSession> {
    const session = sessions.get(sessionId)
    if (!session) {
        throw new Error("Session not found")
    }

    try {
        // authCode format: code#state
        const parts = authCode.split("#")
        const code = parts[0]
        const state = parts[1]

        const tokenResponse = await proxyFetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                grant_type: "authorization_code",
                client_id: CLIENT_ID,
                code,
                state,
                redirect_uri: REDIRECT_URI,
                code_verifier: session.codeVerifier,
            }),
        })

        if (!tokenResponse.ok) {
            const error = await tokenResponse.text()
            throw new Error(`Token exchange failed: ${error}`)
        }

        const tokenData = (await tokenResponse.json()) as {
            access_token: string
            refresh_token: string
            expires_in: number
        }

        const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000

        // Decode the access token to get user info (it's a JWT)
        let email = "anthropic-user"
        try {
            const payload = tokenData.access_token.split(".")[1]
            const decoded = JSON.parse(Buffer.from(payload, "base64").toString())
            email = decoded.email || decoded.sub || "anthropic-user"
        } catch {
            // fallback
        }

        const account: ProviderAccount = {
            id: email,
            provider: "anthropic",
            email,
            label: email,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt,
            createdAt: new Date().toISOString(),
        }

        authStore.saveAccount(account)
        session.status = "success"
        session.account = account

        consola.success(`Anthropic account authenticated: ${email}`)
        return session
    } catch (e) {
        session.status = "error"
        session.message = (e as Error).message
        throw e
    }
}

export async function refreshAnthropicToken(refreshToken: string): Promise<{
    accessToken: string
    refreshToken: string
    expiresIn: number
}> {
    const response = await proxyFetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: refreshToken,
        }),
    })

    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Anthropic token refresh failed: ${error}`)
    }

    const data = (await response.json()) as {
        access_token: string
        refresh_token: string
        expires_in: number
    }

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
    }
}

export function getAnthropicSession(id: string): AnthropicAuthSession | undefined {
    return sessions.get(id)
}
