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

        const tokenData = (await tokenResponse.json()) as Record<string, any>
        // Log the full token response to see what fields are available
        const tokenKeys = Object.keys(tokenData)
        consola.info(`[anthropic] Token exchange response keys: ${tokenKeys.join(", ")}`)
        consola.info(`[anthropic] Token exchange full response:`, JSON.stringify({ ...tokenData, access_token: tokenData.access_token?.substring(0, 30) + "...", refresh_token: "***" }))

        const expiresAt = Date.now() + (tokenData.expires_in || 3600) * 1000 - 5 * 60 * 1000

        // Fetch user profile and organization info from Anthropic API
        let email = "anthropic-user"
        let organizationId: string | undefined

        // Try to get email from JWT payload first
        try {
            const payload = tokenData.access_token.split(".")[1]
            if (payload) {
                const decoded = JSON.parse(Buffer.from(payload, "base64").toString())
                if (decoded.email) email = decoded.email
                if (decoded.sub) email = decoded.sub
                if (decoded.organization_id) organizationId = decoded.organization_id
                consola.info(`[anthropic] JWT decoded:`, JSON.stringify(decoded).substring(0, 300))
            }
        } catch {
            // JWT decode failed, try API
        }

        // Try to fetch user/org info from API
        try {
            const profileRes = await proxyFetch("https://api.anthropic.com/v1/organizations", {
                headers: {
                    "Authorization": `Bearer ${tokenData.access_token}`,
                    "anthropic-version": "2023-06-01",
                    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
                    "user-agent": "claude-cli/2.1.2 (external, cli)",
                    "x-app": "cli",
                },
            })
            const profileBody = await profileRes.text()
            consola.info(`[anthropic] Orgs endpoint: ${profileRes.status}, body: ${profileBody.substring(0, 500)}`)

            if (profileRes.ok) {
                const orgData = JSON.parse(profileBody)
                // Could be an array of orgs or a single org object
                const org = Array.isArray(orgData) ? orgData[0] : (orgData.data?.[0] || orgData)
                if (org?.id) organizationId = org.id
                if (org?.name) email = org.name
                if (org?.email) email = org.email
            }
        } catch (profileErr) {
            consola.warn(`[anthropic] Failed to fetch org info:`, profileErr)
        }

        // Also try /v1/me or userinfo endpoint for email
        if (email === "anthropic-user") {
            try {
                const meRes = await proxyFetch("https://api.anthropic.com/v1/me", {
                    headers: {
                        "Authorization": `Bearer ${tokenData.access_token}`,
                        "anthropic-version": "2023-06-01",
                        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
                    },
                })
                const meBody = await meRes.text()
                consola.info(`[anthropic] /v1/me endpoint: ${meRes.status}, body: ${meBody.substring(0, 500)}`)
                if (meRes.ok) {
                    const meData = JSON.parse(meBody)
                    if (meData.email) email = meData.email
                    if (meData.name) email = meData.name
                }
            } catch {
                // ignore
            }
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
            organizationId,
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
