/**
 * Auth 路由
 */

import { Hono } from "hono"
import { isAuthenticated, getUserInfo, setAuth, clearAuth, startOAuthLogin } from "~/services/antigravity/login"
import { accountManager } from "~/services/antigravity/account-manager"
import { state } from "~/lib/state"
import { authStore } from "~/services/auth/store"
import { debugCodexOAuth, importCodexAuthSources, startCodexCliLogin, getCodexCliLoginStatus } from "~/services/codex/oauth"
import { startCopilotDeviceFlow, pollCopilotSession, importCopilotAuthFiles } from "~/services/copilot/oauth"
import { startAnthropicOAuth, completeAnthropicOAuth, getAnthropicSession } from "~/services/anthropic/oauth"

export const authRouter = new Hono()

// 获取认证状态
authRouter.get("/status", (c) => {
    const userInfo = getUserInfo()
    return c.json({
        authenticated: isAuthenticated(),
        email: userInfo.email,
        name: userInfo.name,
    })
})

authRouter.get("/accounts", (c) => {
    accountManager.load()
    return c.json({
        accounts: {
            antigravity: authStore.listSummaries("antigravity"),
            codex: authStore.listSummaries("codex"),
            copilot: authStore.listSummaries("copilot"),
            anthropic: authStore.listSummaries("anthropic"),
        },
    })
})

// Credential export/import has been removed.
authRouter.get("/export", (c) => {
    return c.json({ success: false, error: "Credential bundle export/import has been removed." }, 410)
})

// Credential export/import has been removed.
authRouter.post("/import", (c) => {
    return c.json({ success: false, error: "Credential bundle export/import has been removed." }, 410)
})

// 登录（触发 OAuth 或设置 token）
authRouter.post("/login", async (c) => {
    try {
        // 尝试解析 body，如果为空则触发 OAuth
        let body: { accessToken?: string; refreshToken?: string; email?: string; name?: string; provider?: string; force?: boolean } = {}
        try {
            const text = await c.req.text()
            if (text && text.trim()) {
                body = JSON.parse(text)
            }
        } catch {
            // body 为空或无效 JSON
        }

        const provider = (body.provider || "antigravity").toLowerCase()
        const forceInteractive = body.force === true

        if (provider === "copilot") {
            if (!forceInteractive) {
                const imported = importCopilotAuthFiles()
                if (imported.length > 0) {
                    return c.json({
                        success: true,
                        status: "success",
                        provider: "copilot",
                        source: "import",
                        login: imported[0].login,
                    })
                }
            }
            const session = await startCopilotDeviceFlow()
            return c.json({
                success: true,
                status: "pending",
                provider: "copilot",
                device_code: session.deviceCode,
                user_code: session.userCode,
                verification_uri: session.verificationUri,
                interval: session.interval,
            })
        }

        if (provider === "codex") {
            if (forceInteractive) {
                // 使用浏览器 OAuth 登录获取完整权限的 token
                try {
                    const { startCodexOAuthLogin } = await import("~/services/codex/oauth")
                    const account = await startCodexOAuthLogin()
                    return c.json({
                        success: true,
                        provider: "codex",
                        status: "success",
                        source: "browser-oauth",
                        account: {
                            id: account.id,
                            email: account.email,
                            source: account.authSource,
                        },
                    })
                } catch (error) {
                    return c.json({ success: false, error: (error as Error).message }, 400)
                }
            }

            const result = await importCodexAuthSources()
            if (result.accounts.length > 0) {
                return c.json({
                    success: true,
                    provider: "codex",
                    status: "success",
                    source: "import",
                    count: result.accounts.length,
                    sources: result.sources,
                    accounts: result.accounts.map(account => ({
                        id: account.id,
                        email: account.email,
                        source: account.authSource,
                    })),
                })
            }
            return c.json({
                success: false,
                error: "Codex auth files not found. Use force=true to login via browser.",
            }, 400)
        }

        if (provider === "anthropic") {
            const session = await startAnthropicOAuth()
            return c.json({
                success: true,
                status: "pending",
                provider: "anthropic",
                session_id: session.id,
                auth_url: session.authUrl,
            })
        }

        // 默认 Antigravity
        if (!body.accessToken) {
            // Railway-compatible flow: use localhost redirect (the only URI Google allows),
            // then have user paste the redirect URL back
            const { generateState, generateAuthURL } = await import("~/services/antigravity/oauth")
            const oauthState = generateState()
            const redirectUri = "http://localhost:51121/oauth-callback"
            const authUrl = generateAuthURL(redirectUri, oauthState)

                // Store pending oauth state for the exchange endpoint
                ; (globalThis as any).__pendingOAuthState = oauthState
                ; (globalThis as any).__pendingOAuthRedirectUri = redirectUri

            return c.json({
                success: true,
                status: "pending",
                provider: "antigravity",
                auth_url: authUrl,
            })
        }

        setAuth(body.accessToken, body.refreshToken, body.email, body.name)
        accountManager.addAccount({
            id: body.email || `account-${Date.now()}`,
            email: body.email || "unknown",
            accessToken: body.accessToken,
            refreshToken: body.refreshToken || "",
            expiresAt: state.tokenExpiresAt || 0,
            projectId: state.cloudaicompanionProject,
        })
        return c.json({
            success: true,
            authenticated: true,
            provider: "antigravity",
            email: body.email,
            name: body.name,
        })
    } catch (error) {
        return c.json({ error: (error as Error).message }, 500)
    }
})

authRouter.get("/copilot/status", async (c) => {
    const deviceCode = c.req.query("device_code")
    if (!deviceCode) {
        return c.json({ success: false, error: "device_code required" }, 400)
    }
    const session = await pollCopilotSession(deviceCode)
    return c.json({
        success: session.status !== "error",
        status: session.status,
        message: session.message,
        account: session.account ? {
            id: session.account.id,
            login: session.account.login,
            email: session.account.email,
        } : undefined,
    })
})

authRouter.get("/codex/status", async (c) => {
    const sessionId = c.req.query("session_id")
    if (!sessionId) {
        return c.json({ success: false, error: "session_id required" }, 400)
    }
    const result = await getCodexCliLoginStatus(sessionId)
    return c.json({
        success: result.status !== "error",
        status: result.status,
        message: result.message,
        verification_uri: result.verificationUri,
        user_code: result.userCode,
        accounts: result.accounts?.map(account => ({
            id: account.id,
            email: account.email,
            source: account.authSource,
        })),
    })
})

authRouter.get("/codex/debug", async (c) => {
    try {
        const result = await debugCodexOAuth()
        return c.json({ success: true, ...result })
    } catch (error) {
        return c.json({ success: false, error: (error as Error).message }, 500)
    }
})

// Anthropic OAuth exchange (code#state paste flow)
authRouter.post("/anthropic/exchange", async (c) => {
    try {
        const body = await c.req.json() as { session_id: string; auth_code: string }
        if (!body.session_id || !body.auth_code) {
            return c.json({ success: false, error: "session_id and auth_code required" }, 400)
        }
        const session = await completeAnthropicOAuth(body.session_id, body.auth_code)
        return c.json({
            success: true,
            authenticated: true,
            provider: "anthropic",
            email: session.account?.email,
        })
    } catch (error) {
        return c.json({ success: false, error: (error as Error).message }, 500)
    }
})

// Exchange OAuth code for tokens (Railway code-paste flow)
authRouter.post("/exchange", async (c) => {
    try {
        const body = await c.req.json() as { redirect_url?: string; code?: string; state?: string }

        let code = body.code
        let returnedState = body.state

        // Parse code+state from pasted redirect URL if provided
        if (body.redirect_url) {
            try {
                const url = new URL(body.redirect_url)
                code = url.searchParams.get("code") || undefined
                returnedState = url.searchParams.get("state") || undefined
            } catch {
                return c.json({ success: false, error: "Invalid URL" }, 400)
            }
        }

        if (!code) {
            return c.json({ success: false, error: "No authorization code found" }, 400)
        }

        const pendingState = (globalThis as any).__pendingOAuthState
        if (pendingState && returnedState && returnedState !== pendingState) {
            return c.json({ success: false, error: "State mismatch" }, 400)
        }

        const { exchangeCode, fetchUserInfo, getProjectID } = await import("~/services/antigravity/oauth")
        const { saveAuth } = await import("~/services/antigravity/login")
        const { generateMockProjectId } = await import("~/services/antigravity/project-id")

        const redirectUri = (globalThis as any).__pendingOAuthRedirectUri || "http://localhost:51121/oauth-callback"
        const tokens = await exchangeCode(code, redirectUri)
        const userInfo = await fetchUserInfo(tokens.accessToken)
        const projectId = await getProjectID(tokens.accessToken)
        const resolvedProjectId = projectId || generateMockProjectId()

        // Save to state
        state.accessToken = tokens.accessToken
        state.antigravityToken = tokens.accessToken
        state.refreshToken = tokens.refreshToken
        state.tokenExpiresAt = Date.now() + tokens.expiresIn * 1000
        state.userEmail = userInfo.email
        state.userName = userInfo.email.split("@")[0]
        state.cloudaicompanionProject = resolvedProjectId
        saveAuth()

        // Register account
        accountManager.addAccount({
            id: userInfo.email,
            email: userInfo.email,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: Date.now() + tokens.expiresIn * 1000,
            projectId: resolvedProjectId,
        })

            // Clear pending state
            ; (globalThis as any).__pendingOAuthState = null
            ; (globalThis as any).__pendingOAuthRedirectUri = null

        return c.json({
            success: true,
            authenticated: true,
            provider: "antigravity",
            email: userInfo.email,
        })
    } catch (error) {
        return c.json({ success: false, error: (error as Error).message }, 500)
    }
})

// 登出
authRouter.post("/logout", (c) => {
    clearAuth()
    return c.json({ success: true, authenticated: false })
})
