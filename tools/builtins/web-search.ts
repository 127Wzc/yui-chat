import { configStore } from "../../config/store.js"
import { fetchWithTimeout } from "../../core/network/fetch-timeout.js"
import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"

const webSearchSourceIds = ["baidu-ai", "tavily"] as const
type WebSearchSourceId = (typeof webSearchSourceIds)[number]

interface WebSearchContext extends ToolExecutionContext {
  toolConfig?: UnknownRecord
  config?: UnknownRecord
  searchRouting?: { webSearch?: { strategy?: string } }
  searchCapabilities?: {
    webSearch?: {
      hosted?: (query: string, args: UnknownRecord, context?: WebSearchContext) => Promise<{ text?: string; sources?: SearchResult[] }>
    }
  }
}

interface SearchResult extends UnknownRecord {
  title: string
  url: string
  content: string
  score?: number
  publishedAt?: string
}

function sourceNodeText(result: SearchResult, index: number): string {
  return [
    `${index + 1}. ${result.title || "无标题"}`,
    result.publishedAt ? `发布时间：${result.publishedAt}` : "",
    result.content ? `摘要：${result.content.slice(0, 600)}` : "",
    `链接：${result.url}`,
  ].filter(Boolean).join("\n")
}

function searchResultWithForwardSources(content: UnknownRecord, results: SearchResult[]): UnknownRecord {
  return {
    status: "success",
    content,
    executedCount: 0,
    retryAllowed: true,
    metadata: {
      messageSendAppendPlan: {
        parts: [{
          type: "forward",
          nodes: results.map((result, index) => ({
            nickname: `搜索来源 ${index + 1}`,
            parts: [{ type: "text", text: sourceNodeText(result, index) }],
          })),
        }],
      },
    },
  }
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => Boolean(item) && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function errorMessage(error: unknown): string {
  return text(record(error).message || error || "请求失败")
}

function searchStrategy(args: UnknownRecord, cfg: UnknownRecord, context: WebSearchContext): "preferred" | "fallback" | "parallel" {
  const mode = text(args.searchMode).toLowerCase()
  if (mode === "fast") return "preferred"
  if (mode === "balanced") return "fallback"
  if (mode === "deep") return "parallel"
  const configured = text(context.searchRouting?.webSearch?.strategy || cfg.strategy).toLowerCase()
  if (configured === "preferred" || configured === "parallel") return configured
  return "fallback"
}

function resultKey(result: SearchResult): string {
  return result.url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase()
}

/**
 * 多渠道结果按层轮询，避免排在最前面的渠道先耗尽 maxResults。
 * URL 去重仍在全渠道共享，且每个渠道内部的原始排序保持不变。
 */
function mergeResultChannels(groups: SearchResult[][], limit: number): SearchResult[] {
  const merged: SearchResult[] = []
  const seen = new Set<string>()
  const depth = Math.max(0, ...groups.map(group => group.length))
  for (let index = 0; index < depth && merged.length < limit; index++) {
    for (const group of groups) {
      const item = group[index]
      if (!item) continue
      const key = resultKey(item)
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(item)
      if (merged.length >= limit) break
    }
  }
  return merged
}

async function responseJson(response: Response): Promise<UnknownRecord> {
  const body = await response.text()
  let payload: unknown = {}
  try {
    payload = body ? JSON.parse(body) : {}
  } catch {
    payload = { message: body.slice(0, 300) }
  }
  if (!response.ok) {
    const value = record(payload)
    throw new Error(`HTTP ${response.status}${value.message || value.error ? `：${text(value.message || value.error).slice(0, 300)}` : ""}`)
  }
  return record(payload)
}

async function searchBaiduAi(query: string, args: UnknownRecord, cfg: UnknownRecord, context: WebSearchContext): Promise<SearchResult[]> {
  const apiKey = text(cfg.baiduApiKey).trim()
  if (!apiKey) throw new Error("未配置百度 AI 搜索 API Key")
  const topK = Math.max(1, Math.min(Number(args.maxResults || cfg.maxResults || 5), 50))
  const payload: UnknownRecord = {
    messages: [{ role: "user", content: query.slice(0, 72) }],
    search_source: "baidu_search_v2",
    resource_type_filter: [{ type: "web", top_k: topK }],
  }
  const recency = text(args.timeRange).toLowerCase()
  const recencyMap: Record<string, string> = { week: "week", month: "month", halfyear: "semiyear", year: "year" }
  if (recencyMap[recency]) payload.search_recency_filter = recencyMap[recency]
  const sites = text(args.site).replace(/\|/g, ",").split(",").map(item => item.trim()).filter(Boolean).slice(0, 100)
  if (sites.length) payload.search_filter = { match: { site: sites } }
  const response = await fetchWithTimeout("https://qianfan.baidubce.com/v2/ai_search/web_search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Appbuilder-Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    timeoutMs: Number(cfg.timeoutMs) || 30000,
    signal: context.agent?.signal,
  })
  const data = await responseJson(response)
  return records(data.references).map(item => ({
    title: text(item.title || "无标题").slice(0, 180),
    url: text(item.url).trim(),
    content: text(item.content || item.snippet || "").slice(0, 1600),
    publishedAt: text(item.date || item.published_time || item.publish_time).trim() || undefined,
  })).filter(item => /^https?:\/\//i.test(item.url)).slice(0, topK)
}

async function searchTavily(query: string, args: UnknownRecord, cfg: UnknownRecord, context: WebSearchContext): Promise<SearchResult[]> {
  const apiKey = text(cfg.tavilyApiKey).trim()
  if (!apiKey) throw new Error("未配置 Tavily API Key")
  const maxResults = Math.max(1, Math.min(Number(args.maxResults || cfg.maxResults || 5), 20))
  const topic = ["general", "news"].includes(text(args.topic)) ? text(args.topic) : "general"
  const depth = ["basic", "advanced"].includes(text(args.searchDepth)) ? text(args.searchDepth) : "basic"
  const payload: UnknownRecord = { query, max_results: maxResults, topic, search_depth: depth }
  if (topic === "news") payload.days = Math.max(1, Math.min(Number(args.days || 3), 30))
  const timeRange = text(args.timeRange).toLowerCase()
  if (["day", "week", "month", "year"].includes(timeRange)) payload.time_range = timeRange
  if (/^\d{4}-\d{2}-\d{2}$/.test(text(args.startDate))) payload.start_date = text(args.startDate)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text(args.endDate))) payload.end_date = text(args.endDate)
  const response = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: Number(cfg.timeoutMs) || 30000,
    signal: context.agent?.signal,
  })
  const data = await responseJson(response)
  return records(data.results).map(item => ({
    title: text(item.title || "无标题").slice(0, 180),
    url: text(item.url).trim(),
    content: text(item.content || item.snippet || "").slice(0, 1600),
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : undefined,
    publishedAt: text(item.published_date || item.publishedAt).trim() || undefined,
  })).filter(item => /^https?:\/\//i.test(item.url)).slice(0, maxResults)
}

export class WebSearchTool {
  name = "web_search"
  source = "builtin"
  tags = ["search", "web", "realtime", "news"]
  execution = { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe", maxAttempts: 2, parallelSafe: true }
  description = "Search current web information through administrator-enabled providers. source=auto uses the configured order and falls back between Baidu AI Search and Tavily. Use this for current facts, news, or information that requires web retrieval. The runtime appends every returned source as merged-forward nodes to the following message_send; synthesize the answer as normal text and do not duplicate the source URLs in that text."
  configSchema = {
    type: "object",
    properties: {
      baiduApiKey: { type: "string", title: "百度 AI 搜索 API Key", secret: true, description: "千帆 / AppBuilder AI Search 密钥。" },
      tavilyApiKey: { type: "string", title: "Tavily API Key", secret: true, description: "Tavily Search API 密钥。" },
    },
  }
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "Complete natural-language search query." },
      source: { type: "string", enum: ["auto", ...webSearchSourceIds], default: "auto", description: "Provider. auto follows administrator configuration and fallback." },
      searchMode: { type: "string", enum: ["auto", "fast", "balanced", "deep"], default: "auto", description: "Execution profile. deep searches all administrator-enabled channels in parallel; auto follows model and tool policy." },
      maxResults: { type: "number", description: "Maximum results to return. Defaults to configured value." },
      topic: { type: "string", enum: ["general", "news"], default: "general", description: "Tavily topic." },
      searchDepth: { type: "string", enum: ["basic", "advanced"], default: "basic", description: "Tavily search depth." },
      timeRange: { type: "string", enum: ["day", "week", "month", "halfyear", "year"], description: "Optional recency filter." },
      days: { type: "number", description: "Tavily news lookback days." },
      site: { type: "string", description: "Baidu AI site filter, comma or pipe separated." },
      startDate: { type: "string", description: "Tavily start date in YYYY-MM-DD." },
      endDate: { type: "string", description: "Tavily end date in YYYY-MM-DD." },
    },
    required: ["query"],
  }

  async execute(args: UnknownRecord = {}, context: WebSearchContext = {}): Promise<UnknownRecord | string> {
    const query = text(args.query).trim()
    if (!query) return "缺少网络搜索关键词。"
    const config = record(context.config || configStore.get())
    const cfg = { ...record(record(record(config.tools).builtin).webSearch), ...record(context.toolConfig) }
    const enabled = (Array.isArray(cfg.enabledSources) ? cfg.enabledSources : webSearchSourceIds)
      .map(item => text(item))
      .filter((item): item is WebSearchSourceId => webSearchSourceIds.includes(item as WebSearchSourceId))
    if (!enabled.length) return "实时网络搜索没有启用任何渠道。"
    const requested = text(args.source || "auto").toLowerCase()
    if (requested !== "auto" && !enabled.includes(requested as WebSearchSourceId)) return `网络搜索渠道 ${requested} 未启用。`
    const configured = enabled.includes(text(cfg.defaultSource) as WebSearchSourceId) ? text(cfg.defaultSource) as WebSearchSourceId : enabled[0]
    const first = requested === "auto" ? configured : requested as WebSearchSourceId
    const strategy = requested === "auto" ? searchStrategy(args, cfg, context) : "preferred"
    const plan = strategy === "preferred" ? [first] : [first, ...enabled.filter(source => source !== first)]
    const failures: UnknownRecord[] = []
    const channelResults: UnknownRecord[] = []
    let hostedDigest = ""
    const runLocal = async (source: WebSearchSourceId): Promise<SearchResult[]> => {
      const startedAt = Date.now()
      try {
        const results = source === "baidu-ai"
          ? await searchBaiduAi(query, args, cfg, context)
          : await searchTavily(query, args, cfg, context)
        channelResults.push({ implementation: `local:${source}`, executionOwner: "agent", resultKind: "search-results", status: results.length ? "ok" : "empty", durationMs: Date.now() - startedAt, resultCount: results.length })
        if (!results.length) failures.push({ source, error: "没有返回有效结果" })
        return results
      } catch (error) {
        const message = errorMessage(error)
        channelResults.push({ implementation: `local:${source}`, executionOwner: "agent", resultKind: "search-results", status: "failed", durationMs: Date.now() - startedAt, resultCount: 0, error: message })
        failures.push({ source, error: message })
        return []
      }
    }
    const runHosted = async (): Promise<SearchResult[]> => {
      const hosted = context.searchCapabilities?.webSearch?.hosted
      if (!hosted) return []
      const startedAt = Date.now()
      try {
        const result = await hosted(query, args, context)
        hostedDigest = text(result.text).trim()
        const sources = Array.isArray(result.sources) ? result.sources : []
        channelResults.push({ implementation: "openai:web_search", executionOwner: "provider", resultKind: "assistant-message", status: sources.length || result.text ? "ok" : "empty", durationMs: Date.now() - startedAt, resultCount: sources.length })
        if (!sources.length && !result.text) failures.push({ source: "openai:web_search", error: "没有返回有效结果" })
        return sources.map(item => ({ ...item, content: text(item.content) }))
      } catch (error) {
        const message = errorMessage(error)
        channelResults.push({ implementation: "openai:web_search", executionOwner: "provider", resultKind: "assistant-message", status: "failed", durationMs: Date.now() - startedAt, resultCount: 0, error: message })
        failures.push({ source: "openai:web_search", error: message })
        return []
      }
    }
    if (strategy === "parallel") {
      const tasks: Array<Promise<SearchResult[]>> = plan.map(source => runLocal(source))
      if (context.searchCapabilities?.webSearch?.hosted) tasks.unshift(runHosted())
      const rows = mergeResultChannels(await Promise.all(tasks), Math.max(1, Math.min(Number(args.maxResults || cfg.maxResults || 5), 20)))
      if (rows.length) {
        return searchResultWithForwardSources({
          query,
          source: "multiple",
          strategy,
          aggregationRequired: true,
          channelResults,
          failures,
          ...(hostedDigest ? { hostedDigest } : {}),
          results: rows,
          hint: "综合各渠道证据做一次最终回答；hostedDigest 是 OpenAI 上游已整理的证据摘要，只需使用一次，不要逐来源重复。相同链接已合并，运行时会把来源以合并转发节点追加到随后的 message_send。",
        }, rows)
      }
      if (hostedDigest) {
        return {
          query,
          source: "openai:web_search",
          strategy,
          aggregationRequired: true,
          channelResults,
          failures,
          results: [],
          hostedDigest,
          hint: "上游返回了搜索摘要但没有结构化来源。请基于摘要作答，并明确说明当前代理没有转发来源字段。",
        }
      }
      return { query, strategy, channelResults, results: [], failures, message: `网络搜索失败：${failures.map(item => `${item.source}: ${item.error}`).join("；")}` }
    }
    if (context.searchCapabilities?.webSearch?.hosted) {
      const results = await runHosted()
      if (results.length) {
        return searchResultWithForwardSources({
          query,
          source: "openai:web_search",
          strategy,
          aggregationRequired: true,
          channelResults,
          ...(hostedDigest ? { hostedDigest } : {}),
          results,
          hint: "根据 OpenAI 托管搜索摘要和来源做一次最终回答；hostedDigest 只需使用一次，运行时会把来源以合并转发节点追加到随后的 message_send。",
        }, results)
      }
      if (hostedDigest) {
        return {
          query,
          source: "openai:web_search",
          strategy,
          aggregationRequired: true,
          channelResults,
          results: [],
          hostedDigest,
          hint: "上游返回了搜索摘要但没有结构化来源。请基于摘要作答，并明确说明当前代理没有转发来源字段。",
        }
      }
      if (strategy === "preferred") {
        return { query, strategy, channelResults, results: [], failures, message: `网络搜索失败：${failures.map(item => `${item.source}: ${item.error}`).join("；")}` }
      }
    }
    for (const source of plan) {
      const results = await runLocal(source)
      if (results.length) {
        const content = {
          query,
          source,
          strategy,
          aggregationRequired: true,
          channelResults,
          results,
          hint: "根据这些实时搜索结果整理正文；运行时会把全部来源以合并转发节点追加到随后的 message_send，正文无需重复罗列 URL。需要阅读全文可继续调用 website_fetch。",
        }
        return searchResultWithForwardSources(content, results)
      }
    }
    return { query, strategy, channelResults, results: [], failures, message: `网络搜索失败：${failures.map(item => `${item.source}: ${item.error}`).join("；")}` }
  }
}
