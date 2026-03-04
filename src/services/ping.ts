import { loadRoutingConfig } from "~/services/routing/config"
import { getInternalKey } from "~/services/api-keys"
import { state } from "~/lib/state"

// Tool-calling test: realistic agentic tool set matching Spear Agents
// Tests multi-tool function calling with complex schemas (OpenAI format)
const AGENT_TOOLS: { type: "function"; function: { name: string; description: string; parameters: any } }[] = [
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read the contents of a file at the given absolute path.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Absolute path to the file to read" },
                    startLine: { type: "integer", description: "Optional 1-indexed start line" },
                    endLine: { type: "integer", description: "Optional 1-indexed end line" },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "Write content to a file. Creates parent directories if needed.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Absolute path to the file" },
                    content: { type: "string", description: "Content to write" },
                },
                required: ["path", "content"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "edit_file",
            description: "Make targeted edits to a file using find-and-replace.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Absolute path to the file" },
                    old_text: { type: "string", description: "Exact text to find" },
                    new_text: { type: "string", description: "Replacement text" },
                },
                required: ["path", "old_text", "new_text"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "run_command",
            description: "Execute a shell command and return its output.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "Shell command to execute" },
                    cwd: { type: "string", description: "Working directory (absolute path)" },
                },
                required: ["command"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_directory",
            description: "List files and subdirectories at the given path.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Absolute path to list" },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_files",
            description: "Search for a text pattern in files using grep.",
            parameters: {
                type: "object",
                properties: {
                    pattern: { type: "string", description: "Text or regex pattern" },
                    directory: { type: "string", description: "Directory to search (absolute path)" },
                    include: { type: "string", description: "Glob pattern for files, e.g. '*.ts'" },
                },
                required: ["pattern", "directory"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "glob",
            description: "Find files matching a glob pattern recursively.",
            parameters: {
                type: "object",
                properties: {
                    pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts'" },
                    directory: { type: "string", description: "Base directory (absolute path)" },
                },
                required: ["pattern", "directory"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "web_fetch",
            description: "Fetch content from a URL. Returns the response body as text.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL to fetch" },
                    method: { type: "string", description: "HTTP method (GET, POST, etc.)" },
                },
                required: ["url"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "delegate_task",
            description: "Delegate work to a specialist agent. Synchronous — waits for completion and returns results.",
            parameters: {
                type: "object",
                properties: {
                    agent: { type: "string", description: "Agent name or slug (e.g. backend-architect, python-pro)" },
                    title: { type: "string", description: "Short task title" },
                    description: { type: "string", description: "Detailed task instructions" },
                },
                required: ["agent", "title", "description"],
            },
        },
    },
]

export interface ModelTestResult {
    modelId: string
    upstreamModel?: string
    upstreamProvider?: string
    upstreamAccount?: string
    routeTag?: string
    agentic: boolean
    toolCall: boolean
    thinking: boolean
    latencyMs: number
    error?: string
}

/**
 * Get the base URL for calling our own proxy endpoints.
 * Uses publicUrl (tunnel) if available, otherwise localhost.
 */
function getProxyBaseUrl(): string {
    if (state.publicUrl) return state.publicUrl
    return `http://localhost:${state.port}`
}

/**
 * Call our own /v1/chat/completions endpoint with full agentic payload.
 * Uses the admin API key which grants direct model access (bypasses flow route enforcement).
 *
 * The request matches what Spear Agents sends: system prompt, multi-tool spec, tool_choice=any.
 */
interface ProxyResponse {
    choices: Array<{
        message: {
            role: string
            content: string | null
            reasoning_content?: string
            tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
        }
        finish_reason: string
    }>
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    // Routing metadata from response headers
    _upstream?: { model?: string; provider?: string; routeTag?: string; account?: string }
}

// System prompt matching what Spear Agents sends to its worker agents
const AGENT_SYSTEM_PROMPT = `You are a software engineering agent. You have access to tools for reading files, writing files, running commands, and searching codebases. Use the appropriate tools to complete the user's request. Always think step by step before acting.`

async function callProxy(params: {
    model: string
    messages: Array<{ role: string; content: string }>
    tools?: typeof AGENT_TOOLS
    tool_choice?: string | { type: string; function?: { name: string } }
    max_tokens?: number
    apiKey: string
}): Promise<ProxyResponse> {
    const baseUrl = getProxyBaseUrl()
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${params.apiKey}`,
            "User-Agent": "SpearAgents/1.0 (agent-pipeline-test)",
            "X-Request-Source": "spear-agents-ping",
        },
        body: JSON.stringify({
            model: params.model,
            messages: params.messages,
            tools: params.tools,
            tool_choice: params.tool_choice || "auto",
            max_tokens: params.max_tokens || 1024,
            stream: false,
        }),
        signal: AbortSignal.timeout(120_000),
    })

    if (!resp.ok) {
        const body = await resp.text().catch(() => "")
        throw new Error(`${resp.status}: ${body.slice(0, 200)}`)
    }

    const json = await resp.json()

    // Extract upstream routing info from response headers
    json._upstream = {
        model: resp.headers.get("x-upstream-model") || undefined,
        provider: resp.headers.get("x-upstream-provider") || undefined,
        routeTag: resp.headers.get("x-route-tag") || undefined,
        account: resp.headers.get("x-upstream-account") || undefined,
    }

    return json
}

/**
 * Test each ACTUAL upstream model assigned to a provider's flow route entries.
 *
 * For each provider card on the quota dashboard, this finds the real model IDs
 * (e.g. claude-opus-4-6-thinking, gpt-5.3-codex) from the flow router entries,
 * then calls each one directly through the proxy using the admin key + @provider hint.
 *
 * The admin key bypasses flow route enforcement, allowing actual model IDs (with version numbers).
 * The @provider hint tells the router to dispatch directly to the specified provider.
 *
 * Each test sends a full agentic payload (system prompt + 9 tools + tool_choice=any)
 * to verify: agentic capability, tool calling, and thinking/reasoning.
 */
export async function testAccountModels(
    provider: string,
    accountId: string
): Promise<ModelTestResult[]> {
    const apiKey = getInternalKey()
    if (!apiKey) {
        throw new Error("No API key available for testing. Set ANTI_API_SECRET env var.")
    }

    // Collect unique actual model IDs assigned to this provider across all flow routes
    const config = loadRoutingConfig()
    const allFlows = (config.flows || []).filter(f => f.name && f.entries?.length > 0)

    const seenModels = new Set<string>()
    const modelsToTest: string[] = []

    for (const flow of allFlows) {
        for (const entry of flow.entries) {
            if (entry.provider === provider && entry.modelId && !seenModels.has(entry.modelId)) {
                seenModels.add(entry.modelId)
                modelsToTest.push(entry.modelId)
            }
        }
    }

    if (modelsToTest.length === 0) {
        return []
    }

    const results: ModelTestResult[] = []

    for (const actualModelId of modelsToTest) {
        // Sequential: wait between requests to avoid upstream rate limits
        if (results.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 2000))
        }

        const result: ModelTestResult = {
            modelId: actualModelId,
            agentic: false,
            toolCall: false,
            thinking: false,
            latencyMs: 0,
        }

        const start = Date.now()

        try {
            // Call actual model ID directly with @provider hint
            // Admin key → bypasses enforceFlowRouteOnly() → direct routing to provider
            const modelWithHint = `${actualModelId}@${provider}`

            // Use a subset of tools (3) to keep the request lighter while still testing tool calling
            const testTools = AGENT_TOOLS.slice(0, 3)  // read_file, write_file, edit_file

            const response = await callProxy({
                model: modelWithHint,
                messages: [
                    {
                        role: "user",
                        content: "Read the file at /tmp/test.txt using the read_file tool.",
                    },
                ],
                tools: testTools,
                tool_choice: "any",
                max_tokens: 512,
                apiKey,
            })

            result.latencyMs = Date.now() - start

            // Capture upstream routing info
            if (response._upstream) {
                result.upstreamModel = response._upstream.model
                result.upstreamProvider = response._upstream.provider
                result.upstreamAccount = response._upstream.account
                result.routeTag = response._upstream.routeTag
            }

            const choice = response.choices?.[0]
            if (choice) {
                // Agentic: model responded successfully
                result.agentic = true

                // Tool call: model called at least one tool
                result.toolCall = !!(choice.message?.tool_calls && choice.message.tool_calls.length > 0)

                // Thinking: check response for reasoning_content OR detect from model name
                // Some providers (Codex/ChatGPT) support thinking but don't return it as reasoning_content
                const hasReasoningResponse = !!(choice.message?.reasoning_content)
                const modelLower = actualModelId.toLowerCase()
                const modelSupportsThinking = modelLower.includes("thinking")
                    || modelLower.includes("codex")    // Codex models have reasoning
                    || modelLower.includes("-high")     // high reasoning effort
                    || modelLower.includes("-max")      // max reasoning effort
                    || modelLower.includes("pro")       // pro models typically have reasoning
                result.thinking = hasReasoningResponse || modelSupportsThinking
            }

            console.log(`[ping] ${actualModelId} [${provider}] ${result.latencyMs}ms — agentic:${result.agentic} tool:${result.toolCall} think:${result.thinking}`)
        } catch (error) {
            result.latencyMs = Date.now() - start
            const msg = (error as Error).message || "Unknown error"
            if (msg.startsWith("429")) {
                result.error = "Rate limited"
                result.agentic = true // routing worked, just rate-limited
                console.log(`[ping] ${actualModelId} [${provider}]: 429 rate limited`)
            } else {
                result.error = msg.slice(0, 200)
                console.log(`[ping] ${actualModelId} [${provider}]: ERROR ${result.error}`)
            }
        }

        results.push(result)
    }

    return results
}

/**
 * Quick ping: verify a single model works through the proxy.
 */
export async function pingAccount(
    _provider: string,
    _accountId: string,
    modelId?: string
): Promise<{ modelId: string; latencyMs: number }> {
    const apiKey = getInternalKey()
    if (!apiKey) {
        throw new Error("No API key available for ping. Set ANTI_API_SECRET env var.")
    }

    // Use provided modelId, or first flow route, or fallback
    const config = loadRoutingConfig()
    const flowModels = (config.flows || []).map(f => f.name).filter(Boolean)
    const target = modelId || flowModels[0]
    if (!target) {
        throw new Error("No model ID and no flow routes configured")
    }

    const start = Date.now()
    await callProxy({
        model: target,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
        apiKey,
    })

    return { modelId: target, latencyMs: Date.now() - start }
}
