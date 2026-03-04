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
 * Call our own /v1/chat/completions endpoint as if we were an agent.
 * This tests the full path: API key auth → routing → upstream → response translation.
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
    _upstream?: { model?: string; provider?: string; routeTag?: string }
}

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
            // Mimic how Spear Agents calls us
            "User-Agent": "SpearAgents/1.0 (ping-test)",
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

    // Extract upstream routing info from response headers
    json._upstream = {
        model: resp.headers.get("x-upstream-model") || undefined,
        provider: resp.headers.get("x-upstream-provider") || undefined,
        routeTag: resp.headers.get("x-route-tag") || undefined,
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

    // Only test flow routes that include this provider+account in their entries
    const config = loadRoutingConfig()
    const allFlows = (config.flows || []).filter(f => f.name && f.entries?.length > 0)
    const relevantFlows = allFlows.filter(flow =>
        flow.entries.some(entry =>
            entry.provider === provider && (entry.accountId === accountId || entry.accountId === "auto")
        )
    )
    // If no flows match this account specifically, test all flows (backward compat)
    const flowModels = (relevantFlows.length > 0 ? relevantFlows : allFlows).map(f => f.name).filter(Boolean)

    if (flowModels.length === 0) {
        throw new Error("No flow routes configured. Add flow routes in the routing dashboard.")
    }

    const results: ModelTestResult[] = []

    for (const modelId of flowModels) {
        const result: ModelTestResult = {
            modelId,
            agentic: false,
            toolCall: false,
            thinking: false,
            latencyMs: 0,
        }

        const start = Date.now()

        try {
            // Test with tools + tool_choice=any to force tool usage (like real agents)
            const response = await callProxy({
                model: modelId,
                messages: [
                    {
                        role: "user",
                        content: "Read the file at /tmp/test.txt and then search for TODO comments in the /workspace directory. Use the appropriate tools.",
                    },
                ],
                tools: AGENT_TOOLS,
                tool_choice: "any",
                max_tokens: 256,
                apiKey,
            })

            result.agentic = true
            result.latencyMs = Date.now() - start

            // Capture actual upstream model/provider from response headers
            if (response._upstream) {
                result.upstreamModel = response._upstream.model
                result.upstreamProvider = response._upstream.provider
            }

            // Check if model returned tool calls
            const choice = response.choices?.[0]
            const toolCalls = choice?.message?.tool_calls || []
            const hasToolUse = toolCalls.length > 0

            const upstreamInfo = result.upstreamModel ? ` → ${result.upstreamModel} [${result.upstreamProvider || "?"}]` : ""
            console.log(`[ping] ${modelId}${upstreamInfo}: tool_use=${hasToolUse} tools=${JSON.stringify(toolCalls.map(tc => tc.function?.name))} finish=${choice?.finish_reason}`)

            if (hasToolUse) {
                result.toolCall = true
            }

            // Infer thinking capability from actual upstream model name (more accurate) or flow route name
            const checkModel = (result.upstreamModel || modelId).toLowerCase()
            result.thinking = checkModel.includes("thinking") || checkModel.includes("pro")
        } catch (error) {
            result.latencyMs = Date.now() - start
            result.error = (error as Error).message?.slice(0, 200) || "Unknown error"
            console.log(`[ping] ${modelId}: ERROR ${result.error}`)
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
