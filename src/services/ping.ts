import consola from "consola"
import type { ClaudeMessage } from "~/lib/translator"
import { authStore } from "~/services/auth/store"
import type { AuthProvider } from "~/services/auth/types"
import { createChatCompletionWithOptions } from "~/services/antigravity/chat"
import { accountManager } from "~/services/antigravity/account-manager"
import { fetchAntigravityModels } from "~/services/antigravity/quota-fetch"
import { createCodexCompletion } from "~/services/codex/chat"
import { createCopilotCompletion } from "~/services/copilot/chat"
import { createAnthropicCompletion } from "~/services/anthropic/chat"
import { getProviderModels } from "~/services/routing/models"
import { loadRoutingConfig } from "~/services/routing/config"
import { UpstreamError } from "~/lib/error"

const PING_MESSAGES: ClaudeMessage[] = [
    { role: "user", content: "ping" },
]

// Tool-calling test: asks model to use a tool
const TEST_TOOL: { name: string; description: string; input_schema: any } = {
    name: "get_weather",
    description: "Get the current weather for a location",
    input_schema: {
        type: "object",
        properties: {
            location: { type: "string", description: "City name" },
        },
        required: ["location"],
    },
}

const TOOL_TEST_MESSAGES: ClaudeMessage[] = [
    { role: "user", content: "What's the weather in Tokyo? Use the get_weather tool." },
]

export interface ModelTestResult {
    modelId: string
    agentic: boolean
    toolCall: boolean
    thinking: boolean
    latencyMs: number
    error?: string
}

/**
 * Test all models for a given account: agentic mode, tool calling, and thinking support
 */
export async function testAccountModels(
    provider: AuthProvider,
    accountId: string
): Promise<ModelTestResult[]> {
    // Only test models that are actually used in routing (flow routes + account routes)
    // Don't test all upstream models — that wastes quota and time
    const routingModels = getRoutingModelsForAccount(provider, accountId)

    // Deduplicate
    const seen = new Set<string>()
    const uniqueModels = routingModels.filter(id => {
        if (!id || seen.has(id)) return false
        seen.add(id)
        return true
    })

    // If no routing models, test a single default model to verify account works
    if (uniqueModels.length === 0) {
        if (provider === "antigravity") {
            uniqueModels.push("claude-sonnet-4-6")
        } else if (provider === "codex") {
            uniqueModels.push("gpt-4o")
        } else if (provider === "copilot") {
            uniqueModels.push("gpt-4o")
        } else if (provider === "anthropic") {
            uniqueModels.push("claude-sonnet-4-6-20250929")
        }
    }

    const account = (provider !== "antigravity") ? authStore.getAccount(provider, accountId) : null
    if (provider !== "antigravity" && !account) {
        throw new Error(`Account not found: ${accountId}`)
    }

    const results: ModelTestResult[] = []

    for (const modelId of uniqueModels) {
        const result: ModelTestResult = {
            modelId,
            agentic: false,
            toolCall: false,
            thinking: false,
            latencyMs: 0,
        }

        const start = Date.now()

        try {
            if (provider === "antigravity") {
                const response = await createChatCompletionWithOptions(
                    {
                        model: modelId,
                        messages: TOOL_TEST_MESSAGES,
                        tools: [TEST_TOOL],
                        toolChoice: { type: "auto" },
                        maxTokens: 256,
                    },
                    { accountId, allowRotation: false }
                )

                result.agentic = true
                result.latencyMs = Date.now() - start

                // Debug: log content blocks for models that don't return tool_use
                const hasToolUse = response.contentBlocks?.some(b => b.type === "tool_use")
                if (!hasToolUse) {
                    console.log(`[ping] ${modelId}: no tool_use in response. Blocks: ${JSON.stringify(response.contentBlocks?.map(b => ({ type: b.type, name: (b as any).name, text: b.type === "text" ? (b as any).text?.slice(0, 200) : undefined })))}`)
                }
                if (hasToolUse) {
                    result.toolCall = true
                }

                const lm = modelId.toLowerCase()
                result.thinking = lm.includes("thinking") || lm.includes("gemini-2.5-pro") ||
                    lm.includes("gemini-2-5-pro") || lm.includes("gemini-3-1-pro") ||
                    lm.includes("gemini-3-pro") || lm.includes("claude-sonnet-4-6") ||
                    lm.includes("claude-sonnet-4.6")
            } else if (provider === "codex") {
                await createCodexCompletion(account!, modelId, TOOL_TEST_MESSAGES, [TEST_TOOL], 256)
                result.agentic = true
                result.toolCall = true
                result.latencyMs = Date.now() - start
                result.thinking = modelId.toLowerCase().includes("thinking") || modelId.toLowerCase().includes("o1") || modelId.toLowerCase().includes("o3")
            } else if (provider === "copilot") {
                await createCopilotCompletion(account!, modelId, TOOL_TEST_MESSAGES, [TEST_TOOL], 256)
                result.agentic = true
                result.toolCall = true
                result.latencyMs = Date.now() - start
                result.thinking = modelId.toLowerCase().includes("thinking") || modelId.toLowerCase().includes("o1") || modelId.toLowerCase().includes("o3")
            } else if (provider === "anthropic") {
                await createAnthropicCompletion(account!, modelId, TOOL_TEST_MESSAGES, [TEST_TOOL], 256)
                result.agentic = true
                result.toolCall = true
                result.latencyMs = Date.now() - start
                result.thinking = modelId.toLowerCase().includes("thinking") || modelId.toLowerCase().includes("o1") || modelId.toLowerCase().includes("o3")
            }
        } catch (error) {
            result.latencyMs = Date.now() - start
            result.error = error instanceof UpstreamError
                ? `${error.status}: ${error.message}`.slice(0, 200)
                : (error as Error).message?.slice(0, 200) || "Unknown error"
        }

        results.push(result)
    }

    return results
}

export async function pingAccount(
    provider: AuthProvider,
    accountId: string,
    modelId?: string
): Promise<{ modelId: string; latencyMs: number }> {
    const routingModels = getRoutingModelsForAccount(provider, accountId)
    const providerModels = getProviderModels(provider).map(model => model.id)
    const antigravityModels = provider === "antigravity"
        ? await getAntigravityPingCandidates(accountId)
        : []
    const candidates = [
        modelId,
        ...routingModels,
        ...antigravityModels,
        ...providerModels,
    ].filter(Boolean) as string[]
    const seen = new Set<string>()
    const uniqueCandidates = candidates.filter(id => {
        if (seen.has(id)) return false
        seen.add(id)
        return true
    })

    if (uniqueCandidates.length === 0) {
        throw new Error(`No models available for provider "${provider}"`)
    }

    const account = provider === "antigravity" ? null : authStore.getAccount(provider, accountId)
    if (provider !== "antigravity" && !account) {
        throw new Error(`Account not found: ${accountId}`)
    }

    let lastError: unknown = null
    const maxAttempts = Math.min(uniqueCandidates.length, provider === "antigravity" ? 10 : 4)

    for (let i = 0; i < maxAttempts; i++) {
        const targetModel = uniqueCandidates[i]
        const start = Date.now()
        try {
            if (provider === "antigravity") {
                await createChatCompletionWithOptions(
                    {
                        model: targetModel,
                        messages: PING_MESSAGES,
                        maxTokens: 8,
                        toolChoice: { type: "none" },
                    },
                    { accountId, allowRotation: false }
                )
                return { modelId: targetModel, latencyMs: Date.now() - start }
            }

            if (provider === "codex") {
                await createCodexCompletion(account!, targetModel, PING_MESSAGES, undefined, 8)
                return { modelId: targetModel, latencyMs: Date.now() - start }
            }

            if (provider === "copilot") {
                await createCopilotCompletion(account!, targetModel, PING_MESSAGES, undefined, 8)
                return { modelId: targetModel, latencyMs: Date.now() - start }
            }

            if (provider === "anthropic") {
                await createAnthropicCompletion(account!, targetModel, PING_MESSAGES, undefined, 8)
                return { modelId: targetModel, latencyMs: Date.now() - start }
            }
        } catch (error) {
            lastError = error
            if (error instanceof UpstreamError && (error.status === 400 || error.status === 404)) {
                continue
            }
            throw error
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new Error(`No reachable models for provider "${provider}"`)
}

function getRoutingModelsForAccount(provider: AuthProvider, accountId: string): string[] {
    const config = loadRoutingConfig()
    const models: string[] = []

    for (const flow of config.flows || []) {
        for (const entry of flow.entries || []) {
            if (entry.provider === provider && entry.accountId === accountId) {
                models.push(entry.modelId)
            }
        }
    }

    const accountRouting = config.accountRouting?.routes || []
    for (const route of accountRouting) {
        if (!route.modelId) continue
        const hasMatch = (route.entries || []).some(entry => entry.provider === provider && entry.accountId === accountId)
        if (hasMatch) {
            models.push(route.modelId)
        }
    }

    return models
}

async function getAntigravityPingCandidates(accountId: string): Promise<string[]> {
    const account = await accountManager.getAccountById(accountId)
    if (!account) return []

    try {
        const result = await fetchAntigravityModels(account.accessToken, account.projectId)
        const entries = Object.entries(result.models || {})
        if (entries.length === 0) return []

        const sorted = entries
            .sort((a, b) => (b[1]?.remainingFraction ?? 0) - (a[1]?.remainingFraction ?? 0))
            .map(([modelId]) => modelId)

        const withRemaining = sorted.filter((modelId) => {
            const remaining = result.models[modelId]?.remainingFraction ?? 0
            return remaining > 0
        })

        return withRemaining.length > 0 ? withRemaining : sorted
    } catch {
        return []
    }
}
