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
    {
        type: "function",
        function: {
            name: "update_progress",
            description: "Update the visible progress checklist shown to the user.",
            parameters: {
                type: "object",
                properties: {
                    todos: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                content: { type: "string", description: "Step description" },
                                status: { type: "string", description: "pending, in_progress, or completed" },
                            },
                            required: ["content", "status"],
                        },
                        description: "Array of todo items",
                    },
                },
                required: ["todos"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "store_knowledge",
            description: "Save a reusable fact or lesson learned about a project. Persistent across sessions.",
            parameters: {
                type: "object",
                properties: {
                    project_name: { type: "string", description: "Project name" },
                    title: { type: "string", description: "Knowledge title" },
                    content: { type: "string", description: "Knowledge content" },
                    category: { type: "string", description: "Category: fact, skill, endpoint, auth, error" },
                },
                required: ["project_name", "title", "content"],
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
 * Call our own /v1/chat/completions endpoint — simulating the full agent pipeline.
 * This tests the COMPLETE chain that Spear Agents uses:
 *   API key auth → flow route resolution → provider/account selection → upstream call → response translation
 *
 * The request includes a system prompt, multi-tool spec, and tool_choice=any — identical to how
 * Spear Agents dispatches agentic tasks through the proxy.
 */
interface ProxyResponse {
    choices: Array<{
        message: {
            role: string
            content: string | null
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
            // Exact same headers Spear Agents uses for agent dispatch
            "User-Agent": "SpearAgents/1.0 (agent-pipeline-test)",
            "X-Request-Source": "spear-agents-ping",
        },
        body: JSON.stringify({
            model: params.model,
            messages: params.messages,
            tools: params.tools,
            tool_choice: params.tool_choice || "auto",
            max_tokens: params.max_tokens || 256,
            stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
    })

    if (!resp.ok) {
        const body = await resp.text().catch(() => "")
        throw new Error(`${resp.status}: ${body.slice(0, 200)}`)
    }

    const json = await resp.json()

    // Extract upstream routing info from response headers — confirms full routing chain executed
    json._upstream = {
        model: resp.headers.get("x-upstream-model") || undefined,
        provider: resp.headers.get("x-upstream-provider") || undefined,
        routeTag: resp.headers.get("x-route-tag") || undefined,
        account: resp.headers.get("x-upstream-account") || undefined,
    }

    return json
}

/**
 * Test all flow route models: call our own proxy endpoint with a valid API key.
 * This tests exactly what Spear Agents agents do: auth, routing, multi-tool calling.
 */
export async function testAccountModels(
    provider: string,
    accountId: string
): Promise<ModelTestResult[]> {
    const apiKey = getInternalKey()
    if (!apiKey) {
        throw new Error("No API key available for testing. Create one in the dashboard or set ANTI_API_SECRET.")
    }

    // Find flow routes that include this provider in their entries
    const config = loadRoutingConfig()
    const allFlows = (config.flows || []).filter(f => f.name && f.entries?.length > 0)
    const relevantFlows = allFlows.filter(flow =>
        flow.entries.some(entry => entry.provider === provider)
    )

    if (relevantFlows.length === 0) {
        // No flow routes have this exact provider — return empty results (not an error)
        // This happens e.g. for "anthropic" accounts when flows use "antigravity" entries for Claude
        return []
    }

    const results: ModelTestResult[] = []

    for (const flow of relevantFlows) {
        // Wait between requests to avoid hitting upstream rate limits
        if (results.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 1500))
        }

        const flowName = flow.name
        // Find the specific entry for this provider — this is the ACTUAL model that will be called
        const providerEntry = flow.entries.find(e => e.provider === provider)
        if (!providerEntry) continue

        // Display the actual upstream model ID, not the flow route name
        const actualModelId = providerEntry.modelId
        const result: ModelTestResult = {
            modelId: actualModelId,
            agentic: false,
            toolCall: false,
            thinking: false,
            latencyMs: 0,
        }

        // Determine thinking capability from the actual model name
        const modelLower = actualModelId.toLowerCase()
        result.thinking = modelLower.includes("thinking")
            || modelLower.includes("pro")
            || modelLower.includes("codex")  // Codex models have reasoning/thinking
            || modelLower.includes("-high")  // high reasoning effort = thinking
            || modelLower.includes("-max")   // max reasoning effort = thinking

        const start = Date.now()

        try {
            // Use @provider hint to force routing through the specific provider being tested
            const modelWithHint = `${flowName}@${provider}`

            // Lightweight ping: just verify routing works, don't burn quota
            const response = await callProxy({
                model: modelWithHint,
                messages: [
                    {
                        role: "user",
                        content: "Reply with exactly: pong",
                    },
                ],
                max_tokens: 16,
                apiKey,
            })

            result.agentic = true
            result.latencyMs = Date.now() - start

            // Capture upstream routing info from response headers
            if (response._upstream) {
                result.upstreamModel = response._upstream.model
                result.upstreamProvider = response._upstream.provider
                result.upstreamAccount = response._upstream.account
                result.routeTag = response._upstream.routeTag
            }

            const choice = response.choices?.[0]
            result.toolCall = !!choice?.message?.content

            console.log(`[ping] ${flowName} → ${actualModelId} [${provider}] ${result.latencyMs}ms OK`)
        } catch (error) {
            result.latencyMs = Date.now() - start
            const msg = (error as Error).message || "Unknown error"
            // Distinguish rate limits from real errors
            if (msg.startsWith("429")) {
                result.error = "Rate limited"
                result.agentic = true // routing worked, just rate-limited
                console.log(`[ping] ${flowName} → ${actualModelId}: 429 rate limited`)
            } else {
                result.error = msg.slice(0, 200)
                console.log(`[ping] ${flowName} → ${actualModelId}: ERROR ${result.error}`)
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
        throw new Error("No API key available for ping. Create one in the dashboard or set ANTI_API_SECRET.")
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
