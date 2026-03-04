import { Hono } from "hono"
import consola from "consola"
import { authStore } from "~/services/auth/store"
import { listCopilotModelsForAccount } from "~/services/copilot/chat"
import { getProviderModels, setDynamicCopilotModels } from "~/services/routing/models"
import { loadRoutingConfig, saveRoutingConfig, setActiveFlow, type RoutingEntry, type RoutingFlow, type AccountRoutingConfig } from "~/services/routing/config"
import { accountManager } from "~/services/antigravity/account-manager"
import { getAggregatedQuota } from "~/services/quota-aggregator"
import { readFileSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import type { AuthProvider, ProviderAccount, ProviderAccountSummary } from "~/services/auth/types"

export const routingRouter = new Hono()

function resolveAccountLabel(provider: AuthProvider, accountId: string, fallback?: string): string {
    if (accountId === "auto") return "auto"
    const account = authStore.getAccount(provider, accountId)
    return account?.label || fallback || `Account ${(accountId || "????").slice(-4)}`
}

function syncFlowLabels(flows: RoutingFlow[]): RoutingFlow[] {
    return flows.map(flow => ({
        ...flow,
        entries: flow.entries.map(entry => ({
            ...entry,
            accountLabel: resolveAccountLabel(entry.provider, entry.accountId, entry.accountLabel),
        })),
    }))
}

function syncAccountRoutingLabels(accountRouting?: AccountRoutingConfig): AccountRoutingConfig | undefined {
    if (!accountRouting) return accountRouting
    return {
        ...accountRouting,
        routes: accountRouting.routes.map(route => ({
            ...route,
            entries: route.entries.map(entry => ({
                ...entry,
                accountLabel: resolveAccountLabel(entry.provider, entry.accountId, entry.accountLabel),
            })),
        })),
    }
}

function listAccountsInOrder(provider: "antigravity" | "codex" | "copilot" | "anthropic"): ProviderAccount[] {
    const accounts = authStore.listAccounts(provider)
    return accounts.sort((a, b) => {
        const aTime = a.createdAt || ""
        const bTime = b.createdAt || ""
        if (aTime && bTime) {
            return aTime.localeCompare(bTime)
        }
        if (aTime) return -1
        if (bTime) return 1
        return 0
    })
}

function toSummary(account: ProviderAccount): ProviderAccountSummary {
    return {
        id: account.id || "",
        provider: account.provider,
        displayName: account.label || account.id || "Unknown Account",
        label: account.label,
        expiresAt: account.expiresAt,
    }
}

routingRouter.get("/", (c) => {
    try {
        const htmlPath = join(import.meta.dir, "../../../public/routing.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch {
        return c.text("Routing panel not found", 404)
    }
})

routingRouter.get("/config", async (c) => {
    try {
        accountManager.load()
        const config = loadRoutingConfig()
        const syncedConfig = {
            ...config,
            flows: syncFlowLabels(config.flows),
            accountRouting: syncAccountRoutingLabels(config.accountRouting),
        }

        const antigravityAccounts = listAccountsInOrder("antigravity")
        const codexAccounts = listAccountsInOrder("codex")
        const copilotAccounts = listAccountsInOrder("copilot")
        const anthropicAccounts = listAccountsInOrder("anthropic")

        const primaryCopilotAccount = copilotAccounts.find(account => !!account.accessToken)
        if (primaryCopilotAccount) {
            try {
                // Timeout after 5s to prevent /routing/config from hanging if Copilot API is slow
                const remoteModels = await Promise.race([
                    listCopilotModelsForAccount(primaryCopilotAccount),
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Copilot models sync timed out (5s)")), 5000)),
                ])
                if (remoteModels.length > 0) {
                    const dynamicModels = remoteModels.map(model => ({
                        id: model.id,
                        label: `Copilot - ${model.name?.trim() || model.id}`,
                    }))
                    setDynamicCopilotModels(dynamicModels)
                    consola.debug(`[routing] Copilot models synced (${dynamicModels.length}) from ${primaryCopilotAccount.id}`)
                } else {
                    consola.debug("[routing] Copilot models sync returned empty list; using fallback")
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                consola.warn(`[routing] Copilot models sync failed: ${message}`)
            }
        }

        const accounts = {
            antigravity: antigravityAccounts.map(toSummary),
            codex: codexAccounts.map(toSummary),
            copilot: copilotAccounts.map(toSummary),
            anthropic: anthropicAccounts.map(toSummary),
        }

        const models = {
            antigravity: antigravityAccounts.length > 0 ? getProviderModels("antigravity") : [],
            codex: codexAccounts.length > 0 ? getProviderModels("codex") : [],
            copilot: copilotAccounts.length > 0 ? getProviderModels("copilot") : [],
            anthropic: anthropicAccounts.length > 0 ? getProviderModels("anthropic") : [],
        }

        // Get quota data for displaying on model blocks
        let quota: Awaited<ReturnType<typeof getAggregatedQuota>> | null = null
        try {
            quota = await getAggregatedQuota()
        } catch {
            // Quota fetch is optional, continue without it
        }

        return c.json({ config: syncedConfig, accounts, models, quota })
    } catch (error) {
        consola.error("[routing/config] Fatal error:", error)
        // Return minimal valid response so the page still renders
        const config = loadRoutingConfig()
        return c.json({
            config: { flows: config.flows || [], accountRouting: config.accountRouting },
            accounts: { antigravity: [], codex: [], copilot: [], anthropic: [] },
            models: { antigravity: [], codex: [], copilot: [], anthropic: [] },
            quota: null,
        })
    }
})

routingRouter.post("/config", async (c) => {
    const body = await c.req.json<{ flows?: RoutingFlow[]; entries?: RoutingEntry[]; accountRouting?: AccountRoutingConfig }>()
    let flows: RoutingFlow[] = []

    if (Array.isArray(body.flows)) {
        flows = body.flows
    } else if (Array.isArray(body.entries)) {
        flows = [{ id: randomUUID(), name: "default", entries: body.entries }]
    } else {
        const existing = loadRoutingConfig()
        flows = existing.flows
    }

    const normalized = flows.map((flow, index) => ({
        id: flow.id || randomUUID(),
        name: (flow.name || `Flow ${index + 1}`).trim() || `Flow ${index + 1}`,
        entries: Array.isArray(flow.entries)
            ? flow.entries.map(entry => ({
                ...entry,
                id: entry.id || randomUUID(),
                label: entry.label || `${entry.provider}:${entry.modelId}`,
                accountLabel: resolveAccountLabel(entry.provider, entry.accountId, entry.accountLabel),
            }))
            : [],
    }))

    let accountRouting: AccountRoutingConfig | undefined
    if (body.accountRouting) {
        accountRouting = {
            smartSwitch: body.accountRouting.smartSwitch ?? false,
            routes: Array.isArray(body.accountRouting.routes)
                ? body.accountRouting.routes.map(route => ({
                    id: route.id || randomUUID(),
                    modelId: (route.modelId || "").trim(),
                    entries: Array.isArray(route.entries)
                        ? route.entries.map(entry => ({
                            ...entry,
                            id: entry.id || randomUUID(),
                            accountLabel: resolveAccountLabel(entry.provider, entry.accountId, entry.accountLabel),
                        }))
                        : [],
                }))
                : [],
        }
    }

    const config = saveRoutingConfig(normalized, undefined, accountRouting)
    return c.json({ success: true, config })
})

// 🆕 设置/清除激活的 flow
routingRouter.post("/active-flow", async (c) => {
    const body = await c.req.json<{ flowId: string | null }>()
    const config = setActiveFlow(body.flowId)
    return c.json({ success: true, config })
})

// 🆕 清理孤立账号（已删除但仍在 routing 中的账号）
routingRouter.post("/cleanup", async (c) => {
    const config = loadRoutingConfig()

    // 获取所有有效账号
    const validAntigravity = new Set(authStore.listSummaries("antigravity").map(a => a.id || a.email))
    const validCodex = new Set(authStore.listSummaries("codex").map(a => a.id || a.email))
    const validCopilot = new Set(authStore.listSummaries("copilot").map(a => a.id || a.email))

    let removedCount = 0

    // 清理每个 flow 中的孤立 entries
    const cleanedFlows = config.flows.map(flow => ({
        ...flow,
        entries: flow.entries.filter(entry => {
            let isValid = false
            if (entry.provider === "antigravity") {
                isValid = entry.accountId === "auto" || validAntigravity.has(entry.accountId)
            } else if (entry.provider === "codex") {
                isValid = validCodex.has(entry.accountId)
            } else if (entry.provider === "copilot") {
                isValid = validCopilot.has(entry.accountId)
            }
            if (!isValid) {
                removedCount++
            }
            return isValid
        })
    }))

    // 清理 account routing 中的孤立 entries
    const cleanedAccountRouting = config.accountRouting ? {
        ...config.accountRouting,
        routes: config.accountRouting.routes.map(route => ({
            ...route,
            entries: route.entries.filter(entry => {
                let isValid = false
                if (entry.provider === "antigravity") {
                    isValid = entry.accountId === "auto" || validAntigravity.has(entry.accountId)
                } else if (entry.provider === "codex") {
                    isValid = validCodex.has(entry.accountId)
                } else if (entry.provider === "copilot") {
                    isValid = validCopilot.has(entry.accountId)
                }
                if (!isValid) {
                    removedCount++
                }
                return isValid
            })
        }))
    } : config.accountRouting

    // 保存清理后的配置
    const newConfig = saveRoutingConfig(cleanedFlows, undefined, cleanedAccountRouting)

    // 同时清理 account-manager 的 rate limit 状态
    accountManager.clearAllRateLimits()

    return c.json({
        success: true,
        removedCount,
        config: newConfig
    })
})
