type UnknownRecord = Record<string, unknown>

export type ModelToolPolicyMode = "inherit" | "allowlist" | "denylist"
export type ModelToolSource = "auto" | "hosted" | "local" | "disabled"
export type ModelSearchStrategy = "preferred" | "fallback" | "parallel"
export type SearchToolCapability = "web_search" | "tool_search"

export interface ModelToolRoute {
  source: ModelToolSource
  strategy?: ModelSearchStrategy
}

export interface ModelToolPolicy {
  mode: ModelToolPolicyMode
  allow: string[]
  deny: string[]
  routes: Record<SearchToolCapability, ModelToolRoute>
}

export const hostedToolIds = {
  webSearch: "openai:web_search",
  fileSearch: "openai:file_search",
  toolSearch: "openai:tool_search",
} as const

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function stringList(value: unknown): string[] {
  return [...new Set((Array.isArray(value) ? value : []).map(item => text(item).trim()).filter(Boolean))]
}

function policyMode(value: unknown): ModelToolPolicyMode {
  const mode = text(value).trim().toLowerCase()
  return mode === "allowlist" || mode === "denylist" ? mode : "inherit"
}

function toolSource(value: unknown): ModelToolSource {
  const source = text(value).trim().toLowerCase()
  return source === "hosted" || source === "local" || source === "disabled" ? source : "auto"
}

function searchStrategy(value: unknown): ModelSearchStrategy {
  const strategy = text(value).trim().toLowerCase()
  return strategy === "preferred" || strategy === "parallel" ? strategy : "fallback"
}

/** Convert an execution identity to the stable capability governed by model policy. */
export function toolCapabilityId(value: unknown): string {
  const id = text(value).trim()
  if (!id) return ""
  if (id === "openai:web_search" || id === "local:web_search") return "web_search"
  if (id === "openai:tool_search" || id === "local:tool_search") return "tool_search"
  if (id === "openai:file_search" || id === "local:file_search") return "file_search"
  return id
}

export function resolveModelToolPolicy(modelConfig: unknown = {}): ModelToolPolicy {
  const policy = record(record(modelConfig).toolPolicy)
  const routes = record(policy.routes)
  const webSearch = record(routes.web_search)
  const toolSearch = record(routes.tool_search)
  return {
    mode: policyMode(policy.mode),
    allow: stringList(policy.allow),
    deny: stringList(policy.deny),
    routes: {
      web_search: {
        source: toolSource(webSearch.source),
        ...(webSearch.strategy === undefined ? {} : { strategy: searchStrategy(webSearch.strategy) }),
      },
      tool_search: { source: toolSource(toolSearch.source) },
    },
  }
}

/** Lists contain capability IDs only; implementation IDs are normalized at runtime. */
export function modelToolAllowed(modelConfig: unknown, toolId: unknown): boolean {
  const id = toolCapabilityId(toolId)
  if (!id) return false
  const policy = resolveModelToolPolicy(modelConfig)
  if (policy.mode === "inherit") return true
  return policy.mode === "allowlist" ? policy.allow.includes(id) : !policy.deny.includes(id)
}

export function filterToolsForModel<T extends { name?: unknown }>(tools: readonly T[] = [], modelConfig: unknown = {}): T[] {
  return tools.filter(tool => modelToolAllowed(modelConfig, tool.name))
}

export function modelToolRoute(modelConfig: unknown, capability: SearchToolCapability): ModelToolRoute {
  return resolveModelToolPolicy(modelConfig).routes[capability]
}
