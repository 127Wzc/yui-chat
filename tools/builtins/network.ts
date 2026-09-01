import { configStore } from "../../config/store.js"
import { fetchSafeHttp } from "../../core/network/safe-http-client.js"
import { linkSafetyConfig } from "../../core/network/link-safety-policy.js"
import { fetchJson, jsonSnippet, textFromHtml } from "./shared.js"
import { pickBilibiliVideo, searchBilibiliVideos } from "./bilibili.js"
import { prepareBilibiliVideoResources } from "./media.js"
import { cacheImageCandidate, imageSourceIds, searchImageChannel, type ImageCandidate, type ImageSourceId } from "./image-channels.js"
import { WebSearchTool } from "./web-search.js"
import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"

interface NetworkToolContext extends ToolExecutionContext {
  toolConfig?: UnknownRecord
}

type ToolArgs = UnknownRecord

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function errorMessage(error: unknown): string {
  return text(record(error).message || error || "请求失败")
}

function decodeHtml(value: unknown = ""): string {
  return text(value)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
}

function unique(values: unknown[] = [], limit = 12): string[] {
  return [...new Set(values.map(item => text(item).trim()).filter(Boolean))].slice(0, limit)
}

function htmlAttributeValues(html: unknown = "", tag: string, attr: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, "gi")
  const out: string[] = []
  let match
  while ((match = re.exec(text(html)))) out.push(decodeHtml(match[1]))
  return out
}

function htmlTitle(html: unknown = ""): string {
  const title = text(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  return decodeHtml(title || "").replace(/\s+/g, " ").trim()
}

function htmlSummary(html: unknown = "", cfg: UnknownRecord = {}, maxChars = 6000): string {
  const title = htmlTitle(html)
  const text = textFromHtml(html, maxChars)
  const links = cfg.includeLinks === false ? [] : unique(htmlAttributeValues(html, "a", "href"), 12)
  const images = cfg.includeMedia === false ? [] : unique(htmlAttributeValues(html, "img", "src"), 8)
  const media = cfg.includeMedia === false
    ? []
    : unique([
        ...htmlAttributeValues(html, "video", "src"),
        ...htmlAttributeValues(html, "audio", "src"),
        ...htmlAttributeValues(html, "source", "src"),
      ], 8)
  return [
    title ? `title: ${title}` : "",
    `content:\n${text || "无可读正文。"}`,
    links.length ? `links:\n${links.map((url, index) => `${index + 1}. ${url}`).join("\n")}` : "",
    images.length ? `images:\n${images.map((url, index) => `${index + 1}. ${url}`).join("\n")}` : "",
    media.length ? `media:\n${media.map((url, index) => `${index + 1}. ${url}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n")
}

/** 天气工具：只负责调用高德查询接口，不缓存或修改模型配置。 */
export class WeatherTool {
  name = "weather"
  source = "builtin"
  description = "Query live weather using AMap district and weather APIs. Requires an AMap key configured as a runtime variable."
  configSchema = {
    type: "object",
    properties: {
      amapKey: { type: "string", title: "高德天气 Key", secret: true, description: "高德开放平台 Web 服务 API Key。" },
    },
  }
  parameters = {
    type: "object",
    properties: {
      city: { type: "string", description: "City, county, or district name." },
    },
    required: ["city"],
  }

  async execute(args: ToolArgs = {}, context: NetworkToolContext = {}): Promise<string> {
    const key = text(context.toolConfig?.amapKey)
    if (!key) return "天气工具未配置 amapKey，请在 Yui Chat 的工具运行变量中设置 weather.amapKey。"
    const city = text(args.city).trim()
    if (!city) return "缺少要查询的地点。"
    const district = record(await fetchJson(`https://restapi.amap.com/v3/config/district?keywords=${encodeURIComponent(city)}&subdistrict=1&key=${encodeURIComponent(key)}`))
    const match = Array.isArray(district.districts) ? record(district.districts[0]) : {}
    if (!match?.adcode) return `没有找到地点：${city}`
    const weather = record(await fetchJson(`https://restapi.amap.com/v3/weather/weatherInfo?city=${encodeURIComponent(text(match.adcode))}&key=${encodeURIComponent(key)}`))
    return jsonSnippet({
      city: match.name,
      adcode: match.adcode,
      weather: Array.isArray(weather.lives) ? weather.lives[0] || weather : weather,
    })
  }
}

/** 网页读取工具：通过安全 HTTP 客户端读取正文，不负责浏览器渲染。 */
export class WebsiteFetchTool {
  name = "website_fetch"
  source = "builtin"
  description = "Fetch a URL and return readable text or JSON snippet."
  parameters = {
    type: "object",
    properties: {
      url: { type: "string", description: "HTTP/HTTPS URL to fetch." },
      maxChars: { type: "number", description: "Maximum returned characters." },
    },
    required: ["url"],
  }

  async execute(args: ToolArgs = {}, context: NetworkToolContext = {}): Promise<string> {
    const config = record(context.config || configStore.get())
    const tools = record(config.tools)
    const builtin = record(tools.builtin)
    const cfg = record(builtin.websiteFetch)
    const safety = linkSafetyConfig(config)
    try {
      const response = await fetchSafeHttp(text(args.url), {
        allowPrivateHosts: safety.allowPrivateHosts,
        headers: { "User-Agent": text(cfg.userAgent) || "Yui-Chat/0.1" },
        maxBytes: Number(cfg.maxBytes) || 1024 * 1024,
        maxUrlLength: Number(cfg.maxUrlLength) || undefined,
        timeoutMs: Number(cfg.timeoutMs) || 15000,
        signal: context.agent?.signal,
      })
      const contentType = response.headers.get("content-type") || ""
      const body = await response.text()
      if (!response.ok) return `读取失败：HTTP ${response.status}\n${body.slice(0, 1000)}`
      const maxChars = Math.max(500, Math.min(Number(args.maxChars || cfg.maxChars || 6000), 20000))
      if (contentType.includes("application/json")) return body.slice(0, maxChars)
      return htmlSummary(body, cfg, maxChars)
    } catch (error) {
      return `读取失败：${errorMessage(error)}`
    }
  }
}

/** GitHub API 工具：只访问用户指定的 API 路径，并对返回 JSON 做长度裁剪。 */
export class GitHubApiTool {
  name = "github_api"
  source = "builtin"
  description = "Call GitHub REST API for repositories, issues, pulls, commits, users, or search. An optional token can be configured as a runtime variable to raise rate limits."
  configSchema = {
    type: "object",
    properties: {
      token: { type: "string", title: "GitHub Token", secret: true, description: "GitHub 个人访问令牌，可选，用于提高速率限制或访问私有资源。" },
      timeoutMs: { type: "number", title: "请求超时（ms）", default: 15000, minimum: 1000, maximum: 60000 },
    },
  }
  parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "GitHub API path, e.g. /repos/owner/repo/issues or /search/repositories?q=yunzai." },
    },
    required: ["path"],
  }

  async execute(args: ToolArgs = {}, context: NetworkToolContext = {}): Promise<string> {
    const config = record(configStore.get())
    const tools = record(config.tools)
    const builtin = record(tools.builtin)
    const cfg: UnknownRecord = { timeoutMs: record(builtin.github).timeoutMs, ...record(context.toolConfig) }
    const rawPath = text(args.path).trim()
    if (!rawPath) return "缺少 GitHub API path。"
    const apiPath = rawPath.startsWith("http")
      ? rawPath
      : `https://api.github.com${rawPath.startsWith("/") ? rawPath : `/${rawPath}`}`
    try {
      const data = await fetchJson(apiPath, {
        headers: {
          "Accept": "application/vnd.github+json",
          "User-Agent": "Yui-Chat/0.1",
          ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        },
        timeoutMs: Number(cfg.timeoutMs) || 15000,
      })
      return jsonSnippet(data)
    } catch (error) {
      return `GitHub API 请求失败：${errorMessage(error)}`
    }
  }
}

function automaticMessageSend(content: unknown, parts: UnknownRecord[], executedCount = 0): UnknownRecord {
  return {
    status: "success",
    content,
    executedCount,
    retryAllowed: true,
    metadata: {
      messageSendPlan: { parts },
    },
  }
}

/** B 站媒体工具：可只返回搜索候选，也可准备本地封面和视频后自动投递。 */
export class BilibiliMediaTool {
  name = "bilibili_media"
  source = "builtin"
  tags = ["search", "video", "bilibili", "media"]
  autoDelivery = { via: "message_send", batching: "merge", continueConversation: true }
  execution = { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe", maxAttempts: 2 }
  executionByAction = {
    send: {
      effect: "idempotent_write",
      repeatPolicy: "dedupe",
      operationFields: ["action", "keyword", "pick"],
      retryPolicy: "safe",
      maxAttempts: 2,
      dispatchMarking: "deferred",
    },
  }
  description = "Search Bilibili videos and optionally deliver one result. Use action=send when the user wants a video sent; it prepares a local cover and video, the runtime delivers them through message_send, then the current persona continues the conversation once. Use action=search only to list or compare candidates."
  configSchema = {
    type: "object",
    properties: {
      sendVideoFile: { type: "boolean", title: "允许下载 B 站视频本体", default: true },
      maxVideoBytes: { type: "number", title: "B 站视频大小上限（bytes）", default: 67108864, minimum: 1048576, maximum: 536870912 },
      timeoutMs: { type: "number", title: "B 站视频下载超时（ms）", default: 120000, minimum: 5000, maximum: 600000 },
    },
  }
  parameters = {
    type: "object",
    properties: {
      keyword: { type: "string", description: "Search keyword." },
      limit: { type: "number", description: "Maximum result count." },
      action: { type: "string", enum: ["search", "send"], default: "send", description: "Defaults to send. Use search only when the user wants candidates listed or compared without delivery." },
      pick: { type: "string", enum: ["first", "random"], description: "Which result to prepare and deliver when action=send. Defaults to first." },
    },
    required: ["keyword"],
  }

  async execute(args: ToolArgs = {}, context: NetworkToolContext = {}): Promise<string | UnknownRecord> {
    const keyword = text(args.keyword).trim()
    if (!keyword) return "缺少 B 站搜索关键词。"
    const action = text(args.action).trim().toLowerCase() || "send"
    const limit = Math.max(1, Math.min(Number(args.limit || 5), 10))
    const rows = await searchBilibiliVideos(keyword, limit)
    if (!rows.length) {
      const message = `没有搜索到 B 站视频：${keyword}`
      return action === "send"
        ? automaticMessageSend({ keyword, results: [], message }, [{ type: "text", text: message }], 1)
        : message
    }
    if (action === "send") {
      const picked = pickBilibiliVideo(rows, text(args.pick).toLowerCase() === "random" ? "random" : "first")
      if (!picked) {
        const message = `没有找到可发送的 B 站视频：${keyword}`
        return automaticMessageSend({ keyword, results: [], message }, [{ type: "text", text: message }], 1)
      }
      const prepared = await prepareBilibiliVideoResources({ id: picked.bvid || picked.aid || picked.url }, context)
      if (typeof prepared === "string") return automaticMessageSend(prepared, [{ type: "text", text: prepared }], 1)
      const resource = record(prepared)
      const title = text(resource.title || picked.title).trim() || "B 站视频"
      const author = text(resource.author || picked.author).trim()
      const url = text(resource.url || picked.url).trim()
      const summary = [title, author ? `UP：${author}` : "", url].filter(Boolean).join("\n")
      const parts: UnknownRecord[] = [{ type: "text", text: summary }]
      if (record(resource.coverSource).value) parts.push({ type: "image", source: resource.coverSource })
      if (record(resource.source).value) parts.push({ type: "video", source: resource.source })
      return automaticMessageSend({
        ...resource,
        hint: "已生成自动投递计划；运行时会立即通过 message_send 发送简介、封面和本地视频，全部投递结束后由当前人格统一自然续答，无需再次调用发送工具。",
      }, parts, 1)
    }
    return {
      keyword,
      results: rows.map((item, index) => ({
        index: index + 1,
        id: text(item.bvid || item.aid),
        title: text(item.title),
        author: text(item.author) || "unknown",
        duration: text(item.duration) || "-",
        play: item.play ?? null,
        url: text(item.url),
      })),
      hint: "这是候选列表。只有用户要求列出、比较或查看候选时才使用 action=search；需要直接发送时改用 action=send。",
    }
  }
}

/** 图片媒体工具：可返回候选，也可按顺序组装纯图片后自动投递。 */
export class ImageMediaTool {
  name = "image_media"
  source = "builtin"
  tags = ["search", "image", "media"]
  autoDelivery = { via: "message_send", batching: "merge", continueConversation: true }
  execution = { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe", maxAttempts: 2 }
  description = "Search enabled image channels (Bing, Baidu, optional SERP and Pixiv) and optionally deliver selected results. Defaults to action=send and caches selected images before message_send. Use action=search only to list or compare candidates. Pixiv R18 requests are rejected unless the administrator explicitly enables them."
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "Image search keywords." },
      source: { type: "string", enum: ["auto", ...imageSourceIds], default: "auto", description: "Search source. auto follows the configured channel order and fallback policy." },
      limit: { type: "number", description: "Maximum compact results. Default 5, capped by config." },
      action: { type: "string", enum: ["search", "send"], default: "send", description: "Defaults to send. Use search only when the user wants candidates listed or compared without delivery." },
      count: { type: "number", description: "Number of images to deliver for action=send. Defaults to 1, maximum 5." },
      pick: { type: "string", enum: ["first", "random"], description: "How to select images for action=send. Defaults to first." },
      r18: { type: "boolean", description: "Pixiv only. Search R18 illustrations. The administrator must enable the R18 gate first." },
    },
    required: ["query"],
  }

  async execute(args: ToolArgs = {}, context: NetworkToolContext = {}): Promise<string | UnknownRecord> {
    const config = record(context.config || configStore.get())
    const tools = record(config.tools)
    const builtin = record(tools.builtin)
    const cfg = { ...record(builtin.imageSearch), ...record(context.toolConfig) }
    const query = text(args.query).trim()
    if (!query) return "缺少图片搜索关键词。"
    const action = text(args.action).trim().toLowerCase() || "send"
    const maxResults = Math.max(1, Math.min(Number(cfg.maxResults || 5), 10))
    const limit = Math.max(1, Math.min(Number(args.limit || maxResults), maxResults))
    const enabledSources = (Array.isArray(cfg.enabledSources) ? cfg.enabledSources : ["bing", "baidu", "serp-bing", "serp-yandex", "pixiv"])
      .map(item => text(item))
      .filter((item): item is ImageSourceId => imageSourceIds.includes(item as ImageSourceId))
    if (!enabledSources.length) return "图片搜索没有启用任何渠道。"
    const wantsR18 = args.r18 === true
    if (wantsR18 && cfg.pixivR18 !== true) return "Pixiv R18 搜索未由管理员启用。"
    if (wantsR18 && !enabledSources.includes("pixiv")) return "Pixiv 渠道未启用，无法执行 R18 搜索。"
    const requested = wantsR18 ? "pixiv" : text(args.source || "auto").toLowerCase()
    if (requested !== "auto" && !enabledSources.includes(requested as ImageSourceId)) return `图片渠道 ${requested} 未启用。`
    const configuredSource = enabledSources.includes(text(cfg.defaultSource) as ImageSourceId) ? text(cfg.defaultSource) as ImageSourceId : enabledSources[0]
    const firstSource = requested === "auto" ? configuredSource : requested as ImageSourceId
    const sourcePlan = wantsR18 || cfg.fallbackEnabled === false
      ? [firstSource]
      : [firstSource, ...enabledSources.filter(source => source !== firstSource)]
    const rows: ImageCandidate[] = []
    const failures: UnknownRecord[] = []
    for (const source of sourcePlan) {
      try {
        const found = await searchImageChannel(source, query, limit - rows.length, cfg, { r18: wantsR18 })
        rows.push(...found.filter(item => !rows.some(current => current.url === item.url)))
        if (rows.length >= limit) break
      } catch (error) {
        failures.push({ source, error: errorMessage(error) })
      }
    }
    try {
      if (!rows.length) {
        const message = failures.length ? `图片搜索失败：${failures.map(item => `${item.source}: ${item.error}`).join("；")}` : `没有搜索到图片：${query}`
        return action === "send"
          ? automaticMessageSend({ query, sourcesTried: sourcePlan, results: [], message }, [{ type: "text", text: message }])
          : message
      }
      if (action === "send") {
        const count = Math.max(1, Math.min(Number(args.count || 1), 5, rows.length))
        const ordered = text(args.pick).toLowerCase() === "random"
          ? [...rows].sort(() => Math.random() - 0.5).slice(0, count)
          : rows.slice(0, count)
        const prepared: Array<{ candidate: ImageCandidate; source: UnknownRecord }> = []
        const cacheFailures: UnknownRecord[] = []
        for (const candidate of ordered) {
          try {
            prepared.push({ candidate, source: await cacheImageCandidate(candidate, cfg, config, context.agent?.signal) })
          } catch (error) {
            cacheFailures.push({ source: candidate.source, url: candidate.url, error: errorMessage(error) })
          }
        }
        if (!prepared.length) {
          const message = `已找到图片，但缓存失败：${cacheFailures.map(item => text(item.error)).join("；")}`
          return automaticMessageSend({ query, sourcesTried: sourcePlan, results: rows, cacheFailures, message }, [{ type: "text", text: message }])
        }
        const parts = prepared.map(item => ({ type: "image", source: item.source }))
        return automaticMessageSend({
          query,
          sourcesTried: sourcePlan,
          selected: prepared.map(({ candidate, source }, index) => ({
            index: index + 1,
            channel: candidate.source,
            title: text(candidate.title).slice(0, 100) || "image",
            originalUrl: candidate.url,
            source,
            ...(candidate.pageUrl ? { pageUrl: candidate.pageUrl } : {}),
            ...(candidate.artworkId ? { artworkId: candidate.artworkId, imageIndex: candidate.imageIndex || 0 } : {}),
            ...(candidate.author ? { author: candidate.author } : {}),
          })),
          ...(cacheFailures.length ? { cacheFailures } : {}),
          hint: "已生成纯图片自动投递计划；运行时会立即通过 message_send 发送，全部投递结束后由当前人格统一自然续答，无需再次调用发送工具。",
        }, parts)
      }
      // 工具自己控制输出体积和形态：URL 是公网稳定定位符，直接给模型即可，
      // 由模型决定发哪一张并原样传回 message_send。不再另开候选注册表。
      return {
        query,
        sourcesTried: sourcePlan,
        results: rows.map((row, index) => ({
          index: index + 1,
          channel: row.source,
          title: text(row.title).slice(0, 80) || "image",
          url: text(row.url),
          ...(row.width && row.height ? { size: `${row.width}x${row.height}` } : {}),
          ...(row.site ? { site: row.site } : {}),
          ...(row.pageUrl ? { pageUrl: row.pageUrl } : {}),
          ...(row.artworkId ? { artworkId: row.artworkId, imageIndex: row.imageIndex || 0 } : {}),
          ...(row.author ? { author: row.author } : {}),
          ...(row.r18 ? { r18: true } : {}),
        })),
        hint: "这是候选列表。只有用户要求列出、比较或查看候选时才使用 action=search；需要直接发送图片时改用 action=send。",
      }
    } catch (error) {
      return `图片搜索失败：${errorMessage(error)}`
    }
  }
}

export function createNetworkTools(): unknown[] {
  return [
    new WeatherTool(),
    new WebsiteFetchTool(),
    new GitHubApiTool(),
    new BilibiliMediaTool(),
    new ImageMediaTool(),
    new WebSearchTool(),
  ]
}
