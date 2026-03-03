/**
 * Anthropic Chat Completion
 * Translates between internal format (OpenAI-style) and Anthropic Messages API
 * Uses Claude Code identity headers for Max subscription OAuth access
 */

import consola from "consola"
import { authStore } from "~/services/auth/store"
import { UpstreamError } from "~/lib/error"
import type { ProviderAccount } from "~/services/auth/types"
import type { ClaudeMessage, ClaudeContentBlock, ClaudeTool, ContentBlock } from "~/lib/translator"
import { refreshAnthropicToken } from "./oauth"

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models"
const CLAUDE_CODE_VERSION = "2.1.2"

// Token refresh lock to prevent concurrent refreshes
let refreshLock: Promise<void> | null = null

async function ensureValidToken(account: ProviderAccount): Promise<string> {
    const now = Date.now()

    // Token still valid (5 min buffer)
    if (account.expiresAt && now < account.expiresAt - 5 * 60 * 1000) {
        return account.accessToken
    }

    // Need refresh
    if (!account.refreshToken) {
        throw new Error(`Anthropic account ${account.id} has no refresh token`)
    }

    // Wait for any in-progress refresh
    if (refreshLock) {
        await refreshLock
        return account.accessToken
    }

    refreshLock = (async () => {
        try {
            consola.info(`Refreshing Anthropic token for ${account.id}`)
            const tokens = await refreshAnthropicToken(account.refreshToken!)
            account.accessToken = tokens.accessToken
            account.expiresAt = Date.now() + tokens.expiresIn * 1000 - 5 * 60 * 1000

            // Persist
            authStore.saveAccount({
                ...account,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken || account.refreshToken,
                expiresAt: account.expiresAt,
            })
        } finally {
            refreshLock = null
        }
    })()

    await refreshLock
    return account.accessToken
}

/**
 * Convert internal messages (OpenAI-style) to Anthropic Messages API format
 */
function convertMessages(messages: ClaudeMessage[]): {
    system?: string
    anthropicMessages: any[]
} {
    let system: string | undefined
    const anthropicMessages: any[] = []

    for (const msg of messages) {
        // Extract system message
        if (msg.role === "user" && typeof msg.content === "string" && messages.indexOf(msg) === 0) {
            // First message might be system-like, but we handle system separately
        }

        if (msg.role === "user") {
            if (typeof msg.content === "string") {
                anthropicMessages.push({ role: "user", content: msg.content })
            } else if (Array.isArray(msg.content)) {
                const blocks: any[] = []
                for (const block of msg.content) {
                    if (block.type === "text") {
                        blocks.push({ type: "text", text: block.text || "" })
                    } else if (block.type === "image" && block.source) {
                        blocks.push({
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: block.source.media_type,
                                data: block.source.data,
                            },
                        })
                    } else if (block.type === "tool_result") {
                        blocks.push({
                            type: "tool_result",
                            tool_use_id: block.tool_use_id,
                            content: block.content || "",
                            is_error: false,
                        })
                    }
                }
                if (blocks.length > 0) {
                    anthropicMessages.push({ role: "user", content: blocks })
                }
            }
        } else if (msg.role === "assistant") {
            if (typeof msg.content === "string") {
                anthropicMessages.push({ role: "assistant", content: msg.content })
            } else if (Array.isArray(msg.content)) {
                const blocks: any[] = []
                for (const block of msg.content) {
                    if (block.type === "text") {
                        blocks.push({ type: "text", text: block.text || "" })
                    } else if (block.type === "tool_use") {
                        blocks.push({
                            type: "tool_use",
                            id: block.id,
                            name: block.name,
                            input: block.input || {},
                        })
                    }
                }
                if (blocks.length > 0) {
                    anthropicMessages.push({ role: "assistant", content: blocks })
                }
            }
        }
    }

    return { system, anthropicMessages }
}

/**
 * Convert internal tools to Anthropic format
 */
function convertTools(tools?: ClaudeTool[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map(tool => ({
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.input_schema || { type: "object", properties: {} },
    }))
}

/**
 * Map Anthropic stop_reason to internal format
 */
function mapStopReason(reason?: string): string {
    switch (reason) {
        case "end_turn": return "end_turn"
        case "max_tokens": return "max_tokens"
        case "tool_use": return "tool_use"
        case "stop_sequence": return "end_turn"
        default: return "end_turn"
    }
}

/**
 * Map internal model name to Anthropic API model name
 * The proxy uses canonical names, but Anthropic API uses its own IDs
 */
function mapAnthropicModelName(model: string): string {
    // Direct mappings for common aliases
    const mappings: Record<string, string> = {
        "claude-opus-4-6-thinking": "claude-opus-4-20250918",
        "claude-opus-4-6": "claude-opus-4-20250918",
        "claude-opus-4.6": "claude-opus-4-20250918",
        "claude-opus-4-5-thinking": "claude-opus-4-20250514",
        "claude-opus-4-5": "claude-opus-4-20250514",
        "claude-opus-4.5": "claude-opus-4-20250514",
        "claude-sonnet-4-6": "claude-sonnet-4-20250918",
        "claude-sonnet-4.6": "claude-sonnet-4-20250918",
        "claude-sonnet-4-5": "claude-sonnet-4-20250514",
        "claude-sonnet-4.5": "claude-sonnet-4-20250514",
        "claude-sonnet-4": "claude-sonnet-4-20250514",
        "claude-haiku-4.5": "claude-haiku-4-20250414",
        "claude-haiku-4-5": "claude-haiku-4-20250414",
    }
    return mappings[model] || model
}

/**
 * Create a chat completion using the Anthropic Messages API
 * Returns the same format as createCopilotCompletion/createCodexCompletion
 */
export async function createAnthropicCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
): Promise<{
    contentBlocks: ContentBlock[]
    stopReason: string
    usage: { inputTokens: number; outputTokens: number }
}> {
    const accessToken = await ensureValidToken(account)
    const mappedModel = mapAnthropicModelName(model)

    const { system, anthropicMessages } = convertMessages(messages)
    const anthropicTools = convertTools(tools)

    const requestBody: any = {
        model: mappedModel,
        messages: anthropicMessages,
        max_tokens: maxTokens || 4096,
    }

    // For OAuth tokens, include Claude Code identity
    requestBody.system = [
        {
            type: "text",
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
            cache_control: { type: "ephemeral" },
        },
    ]
    if (system) {
        requestBody.system.push({
            type: "text",
            text: system,
            cache_control: { type: "ephemeral" },
        })
    }

    if (anthropicTools) {
        requestBody.tools = anthropicTools
    }

    // Enable adaptive thinking for Opus 4.6 / Sonnet 4.6
    if (model.includes("opus-4-6") || model.includes("opus-4.6") ||
        model.includes("sonnet-4-6") || model.includes("sonnet-4.6") ||
        model.includes("thinking")) {
        requestBody.thinking = { type: "adaptive" }
    }

    const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
            "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
            "x-app": "cli",
            "anthropic-dangerous-direct-browser-access": "true",
            accept: "application/json",
        },
        body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
        const errorText = await response.text()
        consola.error(`Anthropic error ${response.status} for model ${mappedModel}:`, errorText.slice(0, 500))
        throw new UpstreamError("anthropic", response.status, errorText, undefined)
    }

    const data = await response.json() as any

    // Convert Anthropic response to internal ContentBlock format
    const contentBlocks: ContentBlock[] = []

    if (Array.isArray(data.content)) {
        for (const block of data.content) {
            if (block.type === "text") {
                contentBlocks.push({ type: "text", text: block.text || "" })
            } else if (block.type === "tool_use") {
                contentBlocks.push({
                    type: "tool_use",
                    id: block.id,
                    name: block.name,
                    input: block.input || {},
                })
            }
            // Skip thinking blocks — they're internal to Claude
        }
    }

    authStore.markSuccess("anthropic", account.id)

    return {
        contentBlocks,
        stopReason: data.stop_reason === "tool_use" ? "tool_use" : mapStopReason(data.stop_reason),
        usage: {
            inputTokens: data.usage?.input_tokens || 0,
            outputTokens: data.usage?.output_tokens || 0,
        },
    }
}

/**
 * Fetch available models from Anthropic API
 */
export async function fetchAnthropicModels(accessToken: string): Promise<any[]> {
    try {
        const response = await fetch(ANTHROPIC_MODELS_URL, {
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
                "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
                "x-app": "cli",
            },
        })

        if (!response.ok) {
            consola.warn(`Failed to fetch Anthropic models: ${response.status}`)
            return []
        }

        const data = await response.json() as any
        return data.data || data.models || []
    } catch (e) {
        consola.warn("Error fetching Anthropic models:", e)
        return []
    }
}
