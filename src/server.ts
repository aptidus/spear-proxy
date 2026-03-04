/**
 * Anti-API HTTP服务器
 */

import { Hono } from "hono"
import { cors } from "hono/cors"
import { readFileSync } from "fs"
import { join } from "path"
import consola from "consola"

import { messageRoutes } from "./routes/messages/route"
import { openaiRoutes } from "./routes/openai/route"
import { authRouter } from "./routes/auth/route"
import { remoteRouter } from "./routes/remote/route"
import { routingRouter } from "./routes/routing/route"
import { logsRouter } from "./routes/logs/route"
import { AVAILABLE_MODELS } from "./lib/config"
import { getAggregatedQuota } from "./services/quota-aggregator"
import { initAuth, isAuthenticated } from "./services/antigravity/login"
import { accountManager } from "./services/antigravity/account-manager"
import { loadRoutingConfig } from "./services/routing/config"
import { getProviderModels } from "./services/routing/models"
import { importCodexAuthSources, removeCodexAuthArtifacts } from "./services/codex/oauth"
import { loadSettings, saveSettings } from "./services/settings"
import { pingAccount, testAccountModels } from "./services/ping"
import { summarizeUpstreamError, UpstreamError } from "./lib/error"
import { authStore } from "./services/auth/store"

import { formatLogTime, getRequestLogContext } from "./lib/logger"
import { initLogCapture, setLogCaptureEnabled } from "./lib/log-buffer"
import { getUsage, resetUsage } from "./services/usage-tracker"
import { isValidKey, isAdminKey, recordKeyUsage, createKey, deleteKey, listKeys, getKeyLabel } from "./services/api-keys"

export const server = new Hono()

initLogCapture()
setLogCaptureEnabled(loadSettings().captureLogs)
consola.level = 0

// 中间件 - 请求日志 (只记录重要请求)
server.use(async (c, next) => {
    await next()
    const status = c.res.status
    const reason = c.res.headers.get("X-Log-Reason") || undefined

    // Only log errors (skip dashboard auth 401s — those are just unauthenticated visitors)
    if (status >= 400) {
        const ctx = getRequestLogContext()
        const method = c.req.method
        const path = c.req.path

        const debugInfo = ` (${method} ${path}${reason ? ` - ${reason}` : ""})`
        if (ctx.model && ctx.provider) {
            const providerNames: Record<string, string> = {
                copilot: "GitHub Copilot",
                codex: "ChatGPT Codex",
                antigravity: "Antigravity",
            }
            const providerName = providerNames[ctx.provider] || ctx.provider
            const accountPart = ctx.account ? ` >> ${ctx.account}` : ""
            const routePart = ctx.routeTag ? `•${ctx.routeTag}` : ""
            console.log(`[${formatLogTime()}] ${status}: from ${ctx.model} > ${providerName}${accountPart}${routePart}${debugInfo}`)
        } else {
            console.log(`[${formatLogTime()}] ${status}: ${reason || "error"}${debugInfo}`)
        }
    }
    // All successful requests are silent (detailed 200 logs are handled elsewhere)
})
server.use(cors())

// API key authentication middleware
const API_SECRET = process.env.ANTI_API_SECRET
if (API_SECRET) {
    server.use(async (c, next) => {
        const path = c.req.path

        // Always public
        if (path === "/health" || path === "/oauth-callback") {
            return next()
        }

        // API endpoints: require Bearer token or x-api-key header
        if (path.startsWith("/v1/") || path.startsWith("/v1beta/") || path.startsWith("/v1internal") || path === "/messages") {
            const authHeader = c.req.header("Authorization") || ""
            const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim()
            const xApiKey = c.req.header("x-api-key") || ""
            const token = bearerToken || xApiKey
            if (!isValidKey(token)) {
                const ip = c.req.header("x-forwarded-for") || c.req.header("cf-connecting-ip") || "unknown"
                const ua = (c.req.header("user-agent") || "").slice(0, 80)
                const keyPreview = token ? `${token.slice(0, 8)}...` : "(empty)"
                console.log(`[${formatLogTime()}] 401 rejected: key=${keyPreview} ip=${ip} ua=${ua} path=${path}`)
                return c.json({ error: { message: "Invalid API key", type: "authentication_error" } }, 401)
            }
            // Track key usage and store label for per-key usage tracking
            recordKeyUsage(token)
                ; (globalThis as any).__currentApiKey = getKeyLabel(token) || token
            // Mark admin key requests — grants direct model access (bypasses flow route enforcement)
            if (isAdminKey(token)) {
                ; (globalThis as any).__isAdminRequest = true
            } else {
                ; (globalThis as any).__isAdminRequest = false
            }
            return next()
        }

        // Dashboard & admin routes: check cookie or ?key= param
        const dashboardPaths = ["/", "/quota", "/api-docs.pdf", "/remote-panel", "/routing", "/settings", "/logs"]
        const isDashboard = dashboardPaths.some(p => path === p || path.startsWith(p + "/"))
        const isApi = path.startsWith("/auth/") || path.startsWith("/remote/") || path.startsWith("/routing/")
            || path.startsWith("/accounts") || path.startsWith("/quota/") || path.startsWith("/bundle/")
            || path.startsWith("/usage") || path.startsWith("/tunnel/") || path.startsWith("/logs/")
            || path.startsWith("/keys/")

        if (isDashboard || isApi) {
            // Check cookie
            const cookie = c.req.header("Cookie") || ""
            const match = cookie.match(/anti_api_session=([^;]+)/)
            if (match && match[1] === API_SECRET) {
                return next()
            }

            // Check ?key= query param (sets cookie for future visits)
            const keyParam = new URL(c.req.url).searchParams.get("key")
            if (keyParam === API_SECRET) {
                c.header("Set-Cookie", `anti_api_session=${API_SECRET}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`)
                return next()
            }

            // Check Bearer token or x-api-key header (for programmatic access from Spear Agents etc.)
            const authHeader = c.req.header("Authorization") || ""
            const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim()
            const xApiKey = c.req.header("x-api-key") || ""
            const headerToken = bearerToken || xApiKey
            if (headerToken && (headerToken === API_SECRET || isValidKey(headerToken))) {
                return next()
            }

            // Unauthorized
            return c.html(`<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;background:#1a1a2e;color:#fff;flex-direction:column">
                <h1>🔒 Access Denied</h1>
                <p style="color:#888">Add <code>?key=YOUR_SECRET</code> to the URL to access the dashboard.</p>
            </body></html>`, 401)
        }

        return next()
    })
}

// API Key Management Routes
server.get("/keys/list", async (c) => {
    return c.json({ success: true, keys: listKeys() })
})

server.post("/keys/create", async (c) => {
    try {
        const body = await c.req.json() as { label?: string }
        const entry = createKey(body.label || "Untitled")
        return c.json({ success: true, key: entry })
    } catch (error) {
        return c.json({ success: false, error: (error as Error).message }, 500)
    }
})

server.post("/keys/delete", async (c) => {
    try {
        const body = await c.req.json() as { key: string }
        if (!body.key) return c.json({ success: false, error: "Missing key" }, 400)
        const deleted = deleteKey(body.key)
        return c.json({ success: deleted, message: deleted ? "Key deleted" : "Key not found" })
    } catch (error) {
        return c.json({ success: false, error: (error as Error).message }, 500)
    }
})

// 启动时自动加载已保存的认证
initAuth()
accountManager.load()

// 自动导入 Codex 账户 (从 ~/.codex/auth.json 和 ~/.cli-proxy-api/)
importCodexAuthSources().then(result => {
    if (result.accounts.length > 0) {
        consola.success(`Codex: Imported ${result.accounts.length} account(s) from ${result.sources.join(", ")}`)
    }
}).catch(err => {
    void err
})

// 根路径 - 重定向到配额面板
server.get("/", (c) => c.redirect("/quota"))

// Auth 路由
server.route("/auth", authRouter)

// OAuth callback - handles Google OAuth redirect on the main server port (required for Railway)
server.get("/oauth-callback", async (c) => {
    const code = c.req.query("code")
    const returnedState = c.req.query("state")
    const error = c.req.query("error")

    if (error) {
        return c.html(`<html><body><h1>Authentication Failed</h1><p>${error}</p><p>You can close this tab.</p></body></html>`)
    }

    if (!code || !returnedState) {
        return c.html(`<html><body><h1>Invalid Callback</h1><p>Missing code or state.</p></body></html>`)
    }

    const pendingState = (globalThis as any).__pendingOAuthState
    if (!pendingState || returnedState !== pendingState) {
        return c.html(`<html><body><h1>State Mismatch</h1><p>OAuth state mismatch. Please try again.</p></body></html>`)
    }

    try {
        const { exchangeCode, fetchUserInfo, getProjectID } = await import("./services/antigravity/oauth")
        const { saveAuth } = await import("./services/antigravity/login")
        const { generateMockProjectId } = await import("./services/antigravity/project-id")
        const { state } = await import("./lib/state")

        const redirectUri = (globalThis as any).__pendingOAuthRedirectUri
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
        accountManager.load()
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

        consola.success(`✓ OAuth login successful: ${userInfo.email}`)

        return c.html(`<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;background:#1a1a2e;color:#fff;flex-direction:column">
            <h1 style="color:#4ade80">✓ Authentication Successful</h1>
            <p>Logged in as <strong>${userInfo.email}</strong></p>
            <p style="color:#888">You can close this tab and return to the dashboard.</p>
            <script>setTimeout(() => window.close(), 3000)</script>
        </body></html>`)
    } catch (err) {
        consola.error("OAuth callback error:", err)
        return c.html(`<html><body><h1>Authentication Error</h1><p>${(err as Error).message}</p></body></html>`)
    }
})

// Remote 隧道控制路由
server.route("/remote", remoteRouter)

// Routing 配置路由
server.route("/routing", routingRouter)

// Logs
server.route("/logs", logsRouter)

// Remote 控制页面 - HTML
server.get("/remote-panel", async (c) => {
    try {
        const htmlPath = join(import.meta.dir, "../public/remote.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch (error) {
        return c.text("Remote panel not found", 404)
    }
})

// 获取公网IP
server.get("/remote/public-ip", async (c) => {
    try {
        const res = await fetch("https://api.ipify.org?format=json")
        const data = await res.json() as { ip: string }
        return c.json({ ip: data.ip })
    } catch (error) {
        return c.json({ error: "Failed to get IP" }, 500)
    }
})

// Settings API - 获取设置
server.get("/settings", (c) => {
    return c.json(loadSettings())
})

// Settings API - 保存设置
server.post("/settings", async (c) => {
    const body = await c.req.json()
    const updated = saveSettings(body)
    setLogCaptureEnabled(updated.captureLogs)
    return c.json(updated)
})

// Credential bundle export/import has been removed.
server.get("/bundle/export", (c) => {
    return c.json({ success: false, error: "Credential bundle export/import has been removed." }, 410)
})

server.post("/bundle/import", (c) => {
    return c.json({ success: false, error: "Credential bundle export/import has been removed." }, 410)
})

server.get("/usage", (c) => {
    return c.json(getUsage())
})

server.post("/usage/reset", (c) => {
    resetUsage()
    return c.json({ success: true })
})

// OpenAI 兼容端点
server.route("/v1/chat/completions", openaiRoutes)

// Anthropic兼容端点
server.route("/v1/messages", messageRoutes)

// 同时支持 v1beta (某些 GUI 工具使用)
server.route("/v1beta/messages", messageRoutes)

// 无前缀版本 for GUI tools
server.route("/messages", messageRoutes)

// 模型列表处理函数 - 兼容 OpenAI 和 Anthropic 格式
// Lists ALL models from ALL configured providers (no dedup).
// Overlapping models get provider-suffixed IDs (e.g., "claude-sonnet-4-5@anthropic")
// so clients can target a specific provider for testing.
const modelsHandler = (c: any) => {
    const now = new Date().toISOString()
    const routingConfig = loadRoutingConfig()

    // Only expose flow route model IDs — no raw provider model IDs with version numbers
    const models = (routingConfig.flows || [])
        .filter(flow => flow.name && flow.entries?.length > 0)
        .map(flow => ({
            id: flow.name,
            name: flow.name,
            owned_by: "spear-proxy",
        }))

    return c.json({
        object: "list",
        data: models.map(m => ({
            id: m.id,
            type: "model",           // Anthropic format
            object: "model",         // OpenAI format
            created_at: now,         // Anthropic format (RFC 3339)
            created: Date.now(),     // OpenAI format (unix timestamp)
            owned_by: m.owned_by,
            display_name: m.name,
        })),
        has_more: false,
        first_id: models[0]?.id,
        last_id: models[models.length - 1]?.id,
    })
}

// 模型列表端点
server.get("/v1/models", modelsHandler)
server.get("/v1beta/models", modelsHandler)
server.get("/models", modelsHandler)  // 无前缀版本 for GUI tools

// 配额面板 - HTML Dashboard
server.get("/quota", async (c) => {
    try {
        const htmlPath = join(import.meta.dir, "../public/quota.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch (error) {
        return c.text("Quota dashboard not found", 404)
    }
})

// API Documentation PDF Download
server.get("/api-docs.pdf", async (c) => {
    try {
        const pdfPath = join(import.meta.dir, "../public/api-docs.pdf")
        const pdf = readFileSync(pdfPath)
        c.header("Content-Type", "application/pdf")
        c.header("Content-Disposition", 'attachment; filename="anti-api-docs.pdf"')
        return c.body(pdf)
    } catch (error) {
        return c.text("PDF not found", 404)
    }
})

// 配额数据 - JSON API
server.get("/quota/json", async (c) => {
    try {
        const snapshot = await getAggregatedQuota()
        return c.json(snapshot)
    } catch (error) {
        return c.json({ error: "Failed to fetch quota" }, 500)
    }
})

// Ping model availability for a specific account
server.post("/accounts/ping", async (c) => {
    let body: { provider?: string; accountId?: string; modelId?: string } = {}
    try {
        body = await c.req.json()
    } catch {
        body = {}
    }

    const provider = (body.provider || "").toLowerCase()
    const accountId = body.accountId || ""
    const modelId = body.modelId

    if (!provider || !accountId) {
        return c.json({ success: false, error: "provider and accountId are required" }, 400)
    }
    if (!["antigravity", "codex", "copilot", "anthropic"].includes(provider)) {
        return c.json({ success: false, error: "Unsupported provider" }, 400)
    }

    try {
        const result = await pingAccount(provider as any, accountId, modelId)
        return c.json({
            success: true,
            provider,
            accountId,
            modelId: result.modelId,
            latencyMs: result.latencyMs,
        })
    } catch (error) {
        if (error instanceof UpstreamError) {
            const summary = summarizeUpstreamError(error)
            return c.json({
                success: false,
                provider,
                accountId,
                modelId: modelId || null,
                status: error.status,
                reason: summary.reason || null,
                error: summary.message,
            })
        }
        return c.json({
            success: false,
            provider,
            accountId,
            modelId: modelId || null,
            error: (error as Error).message,
        })
    }
})

// Test all flow route models end-to-end (auth → routing → upstream → tool calling)
// This is what agents actually do — call /v1/chat/completions with flow route model IDs
server.post("/accounts/test-models", async (c) => {
    let body: { provider?: string; accountId?: string } = {}
    try {
        body = await c.req.json()
    } catch {
        body = {}
    }

    // provider/accountId are used to filter which flow routes to test
    const provider = (body.provider || "").toLowerCase()
    const accountId = body.accountId || ""

    try {
        const results = await testAccountModels(provider, accountId)
        return c.json({
            success: true,
            provider: provider || "all",
            accountId: accountId || "flow-routes",
            results,
        })
    } catch (error) {
        if (error instanceof UpstreamError) {
            const summary = summarizeUpstreamError(error)
            return c.json({
                success: false,
                provider: provider || "all",
                accountId: accountId || "flow-routes",
                error: summary.message,
            })
        }
        return c.json({
            success: false,
            provider: provider || "all",
            accountId: accountId || "flow-routes",
            error: (error as Error).message,
        })
    }
})

// Debug: dump upstream model names from Antigravity
server.get("/accounts/upstream-models", async (c) => {
    const accounts = authStore.listAccounts("antigravity")
    const results: any[] = []
    for (const account of accounts) {
        try {
            const mgr = accountManager
            const acc = await mgr.getAccountById(account.id, { forceRefresh: true })
            if (!acc) {
                results.push({ email: account.email, error: "Account unavailable" })
                continue
            }
            const { fetchAntigravityModels } = await import("~/services/antigravity/quota-fetch")
            const data = await fetchAntigravityModels(acc.accessToken, acc.projectId)
            results.push({
                email: acc.email,
                projectId: acc.projectId,
                models: Object.keys(data.models),
                quota: data.models,
            })
        } catch (error) {
            results.push({ email: account.email, error: (error as Error).message })
        }
    }
    return c.json({ accounts: results })
})

// 删除账号 - API（同时清理 routing 配置）
server.delete("/accounts/:id", async (c) => {
    const accountId = c.req.param("id")
    const codexAccount = authStore.getAccount("codex", accountId) ||
        authStore.listAccounts("codex").find(acc => acc.email === accountId)
    const codexIdentifiers = new Set<string>()
    codexIdentifiers.add(accountId)
    if (codexAccount?.email) codexIdentifiers.add(codexAccount.email)

    // 先尝试从 accountManager 删除 (antigravity 内存管理)
    let success = accountManager.removeAccount(accountId)

    // 如果 accountManager 找不到，尝试直接从 authStore 删除
    // 这覆盖了 token 过期或通过其他方式添加的账号
    if (!success) {
        // 尝试所有 provider 类型
        for (const provider of ["antigravity", "codex", "copilot", "anthropic"] as const) {
            if (authStore.deleteAccount(provider, accountId)) {
                success = true
                break
            }
        }
    }

    if (success) {
        // 同时清理 routing 配置中的该账号
        try {
            const { loadRoutingConfig, saveRoutingConfig } = require("./services/routing/config")
            const config = loadRoutingConfig()
            let removedCount = 0
            const cleanedFlows = config.flows.map((flow: any) => ({
                ...flow,
                entries: flow.entries.filter((entry: any) => {
                    if (entry.accountId === accountId) {
                        removedCount++
                        return false
                    }
                    return true
                })
            }))
            const cleanedAccountRouting = config.accountRouting ? {
                ...config.accountRouting,
                routes: config.accountRouting.routes.map((route: any) => ({
                    ...route,
                    entries: route.entries.filter((entry: any) => {
                        if (entry.accountId === accountId) {
                            removedCount++
                            return false
                        }
                        return true
                    })
                }))
            } : config.accountRouting
            if (removedCount > 0) {
                saveRoutingConfig(cleanedFlows, undefined, cleanedAccountRouting)
            }
        } catch (e) {
            console.error("Failed to cleanup routing config:", e)
        }
        if (codexAccount) {
            removeCodexAuthArtifacts(Array.from(codexIdentifiers))
        }
        return c.json({ success: true, message: `Account ${accountId} removed` })
    }
    return c.json({ success: false, error: "Account not found" }, 404)
})

// 隧道状态 - 返回公共 URL
server.get("/tunnel/status", (c) => {
    const { state } = require("./lib/state")
    return c.json({
        active: !!state.publicUrl,
        url: state.publicUrl,
    })
})

// Embeddings 端点 - 占位（FlowDown 等客户端会请求）
server.post("/embeddings", (c) => c.json({
    error: { type: "not_supported", message: "Embeddings not supported" }
}, 501))
server.post("/v1/embeddings", (c) => c.json({
    error: { type: "not_supported", message: "Embeddings not supported" }
}, 501))

// Responses 端点 - 占位（OpenAI Responses API）
server.post("/responses", (c) => c.json({
    error: { type: "not_supported", message: "Responses API not supported" }
}, 501))
server.post("/v1/responses", (c) => c.json({
    error: { type: "not_supported", message: "Responses API not supported" }
}, 501))

// ==================== NATIVE ANTIGRAVITY PASSTHROUGH ====================
// Transparent proxy for OpenClaw, Claude Code, etc.
// Accepts native Antigravity/Gemini request format, injects stored OAuth token,
// forwards to Google as-is. Tools, streaming, everything works identically.
server.all("/v1internal*", async (c) => {
    const path = c.req.path
    if (!path.startsWith("/v1internal:streamGenerateContent")) {
        return c.json({ error: { message: "Not found", type: "invalid_request" } }, 404)
    }
    if (c.req.method !== "POST") {
        return c.json({ error: { message: "Method not allowed", type: "invalid_request" } }, 405)
    }
    const ANTIGRAVITY_BASE_URLS = [
        "https://daily-cloudcode-pa.googleapis.com",
        "https://daily-cloudcode-pa.sandbox.googleapis.com",
        "https://cloudcode-pa.googleapis.com",
    ]
    const ENDPOINT = "/v1internal:streamGenerateContent"

    try {
        // Get a valid account with OAuth token
        const account = await accountManager.getNextAvailableAccount()
        if (!account) {
            return c.json({ error: { message: "No Antigravity account available", type: "server_error" } }, 503)
        }

        const requestBody = await c.req.text()
        const altParam = c.req.query("alt") || "sse"
        const { getAntigravityUserAgent } = require("./lib/antigravity-client")
        const userAgent = getAntigravityUserAgent()

        // Try each base URL until one works
        let lastError: any = null
        for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
            const url = `${baseUrl}${ENDPOINT}?alt=${altParam}`
            try {
                const fetchOpts: any = {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${account.accessToken}`,
                        "User-Agent": userAgent,
                        "Accept": altParam === "sse" ? "text/event-stream" : "application/json",
                    },
                    body: requestBody,
                }
                const relayProxy = process.env.RELAY_PROXY_URL
                if (relayProxy) fetchOpts.proxy = relayProxy
                const response = await fetch(url, fetchOpts)

                if (!response.ok && response.status >= 500) {
                    lastError = await response.text()
                    continue // Try next endpoint
                }

                // Stream the response back to client
                const headers: Record<string, string> = {}
                response.headers.forEach((value, key) => {
                    if (key.toLowerCase() !== "transfer-encoding") {
                        headers[key] = value
                    }
                })

                if (account.accountId) accountManager.markSuccess(account.accountId)

                return new Response(response.body, {
                    status: response.status,
                    headers,
                })
            } catch (err) {
                lastError = err
                continue
            }
        }

        return c.json({ error: { message: `All Antigravity endpoints failed: ${lastError}`, type: "upstream_error" } }, 502)
    } catch (error: any) {
        return c.json({ error: { message: error.message, type: "server_error" } }, 500)
    }
})


// 健康检查
server.get("/health", (c) => c.json({
    status: "ok",
    authenticated: isAuthenticated(),
}))
