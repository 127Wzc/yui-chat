import { configStore } from "../../config/store.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import { renderDynamicPanel, renderHelpMenu } from "../../core/rendering/render-service.js"
import { renderHtmlToPng, renderMarkdownHtmlToPng, renderMarkmapHtmlToPng, renderUrlToPng } from "../../core/rendering/render-html-service.js"
import { buildNextHelpMenu } from "../help-menu.js"
import { deliverRenderedImage, renderAndDeliverImage } from "../../core/rendering/render-delivery.js"
import type { UnknownRecord } from "../../core/message/types.js"
import { linkSafetyConfig } from "../../core/network/link-safety-policy.js"
import { matchPluginCommand, pluginCommand } from "../../core/message/command-prefixes.js"

interface CommandOptions {
  e: UnknownRecord
  reply: (...args: unknown[]) => unknown
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : text(error)
}

function parseRenderPayload(msg: unknown = ""): UnknownRecord {
  const match = matchPluginCommand(msg, "渲染(帮助菜单|菜单|帮助|能力|工具|MarkdownHTML|markdownhtml|Markdown|markdown|思维导图HTML|思维导图html|MarkmapHTML|markmaphtml|思维导图|词云|动态|面板)([\\s\\S]*)")
  const type = match?.[1] || ""
  const body = String(match?.[2] || "").trim()
  const lines = body.split("\n").map(line => line.trimEnd()).filter(line => line.trim())
  const title = lines[0] || ""
  const content = lines.length > 1 ? lines.slice(1).join("\n") : body
  return { type: type.toLowerCase(), body, title, content }
}

function parseDynamicPanelPayload(input: UnknownRecord = {}): UnknownRecord {
  const metrics = []
  const statusLines = []
  for (const raw of String(input.content || input.body || "").split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const metric = line.match(/^([^:=：]{1,20})\s*[:=：]\s*(.{1,32})$/)
    if (metric && metrics.length < 8) metrics.push({ label: metric[1].trim(), value: metric[2].trim() })
    else statusLines.push(line)
  }
  return {
    title: input.title || "动态面板",
    subtitle: "Yui Chat 图片渲染",
    metrics,
    sections: [{ title: "状态", lines: statusLines.length ? statusLines : ["暂无动态内容。"] }],
  }
}

export async function runRenderImageCommand({ e, reply }: CommandOptions): Promise<unknown> {
  const config = await configStore.load()
  const input = parseRenderPayload(e?.msg)
  if (input.type === "帮助菜单" || input.type === "菜单") {
    const lines = String(input.content || input.body || "").split("\n").map(line => line.trim()).filter(Boolean)
    const menu = buildNextHelpMenu(config)
    const image = await renderHelpMenu({
      ...menu,
      title: input.title || "Yui Chat 帮助菜单",
      subtitle: lines.length ? "自定义帮助菜单" : "常用命令、管理入口和统一模板渲染",
      groups: lines.length ? [{ title: "自定义命令", lines }] : menu.groups,
    }, config)
    return deliverRenderedImage(image, { e, config }, { label: "帮助菜单图片" })
  }
  if (input.type === "帮助" || input.type === "能力" || input.type === "工具" || !input.type) {
    const image = await renderDynamicPanel({
      title: "Yui Chat 统一渲染",
      subtitle: "业务只选择模板并传 JSON 数据；缓存、安全校验和发送由统一服务处理。",
      metrics: [{ label: "默认工具", value: "render_image" }, { label: "缓存", value: "render" }, { label: "后端", value: record(record(config).response).render ? text(record(record(config).response).render && record(record(record(config).response).render).engine) || "sharp-svg" : "sharp-svg" }],
      sections: [{ title: "主入口", lines: ["render_image({ template, data })：模型工具统一入口", `${pluginCommand("图片模式")}：普通聊天自动使用统一图片卡片`, `${pluginCommand("渲染帮助菜单")}：发送默认帮助菜单图`, `${pluginCommand("对话列表")}：渲染当前活跃会话列表`] }, { title: "受控附加能力", lines: [`Markdown、思维导图、词云和动态面板可通过 ${pluginCommand("渲染")} 命令生成。`, "URL/HTML 截图是 master-only 高风险能力，默认关闭。"] }],
    }, config)
    return deliverRenderedImage(image, { e, config }, { label: "渲染工具说明图" })
  }
  if (!input.body) return reply(["请输入要渲染的内容：", `${pluginCommand("渲染Markdown")} 标题`, "# 一级标题", "", pluginCommand("渲染帮助菜单"), `${pluginCommand("chat")} 帮我总结一下 - 发起 AI 对话`, "", `${pluginCommand("渲染思维导图")} 标题`, "# 根节点", "## 分支", "", `${pluginCommand("渲染词云")} 标题`, "工具 渲染 配置 知识库 工具 渲染", "", `${pluginCommand("渲染动态")} 状态`, "工具=7", "缓存=OK", "动态状态图片渲染正常"].join("\n"), true)
  if (input.type === "markdown") return renderAndDeliverImage("markdown", { title: input.title || "Markdown 渲染", markdown: input.content || input.body, footer: "Yui Chat · Command Render" }, { e, config }, { label: "Markdown 图片" })
  if (input.type === "markdownhtml") {
    const image = await renderMarkdownHtmlToPng({ title: input.title || "Markdown HTML 渲染", markdown: input.content || input.body, footer: "Yui Chat · HTML Command Render" }, config)
    return deliverRenderedImage(image, { e, config }, { label: "Markdown HTML 图片" })
  }
  if (input.type === "思维导图") return renderAndDeliverImage("mindmap", { title: input.title || "思维导图", markdown: input.content || input.body }, { e, config }, { label: "思维导图图片" })
  if (input.type === "思维导图html" || input.type === "markmaphtml") {
    const image = await renderMarkmapHtmlToPng({ title: input.title || "HTML 思维导图", markdown: input.content || input.body }, config)
    return deliverRenderedImage(image, { e, config }, { label: "Markmap HTML 图片" })
  }
  if (input.type === "词云") return renderAndDeliverImage("word-cloud", { title: input.title || "词云", text: input.content || input.body }, { e, config }, { label: "词云图片" })
  if (input.type === "动态" || input.type === "面板") return renderAndDeliverImage("dynamic-panel", parseDynamicPanelPayload(input), { e, config }, { label: "动态面板图片" })
  return reply(`未知渲染类型，请使用 ${pluginCommand("渲染帮助")} 查看。`, true)
}

export async function runUrlScreenshotCommand({ e, reply }: CommandOptions): Promise<unknown> {
  const url = String(matchPluginCommand(e?.msg, "截图URL\\s+([\\s\\S]+)")?.[1] || "").trim()
  const config = await configStore.load()
  const html = record(record(record(config).response).render).html ? record(record(record(record(config).response).render).html) : {}
  const linkSafety = linkSafetyConfig(config)
  if (html.enabled !== true) return reply("URL 截图后端默认关闭。请在 response.render.html.enabled 开启后再使用；链接范围由 security.linkSafety 统一控制。", true)
  if (!linkSafety.screenshotAllowedHosts.length) return reply("URL 截图尚未配置允许域名，请先设置 security.linkSafety.screenshotAllowedHosts。", true)
  try {
    const image = await renderUrlToPng(url, {}, config)
    return deliverRenderedImage(image, { e, config }, { label: "URL 截图" })
  } catch (err) {
    hostRuntime.logger?.warn?.("[yui-chat] URL 截图失败", err)
    return reply(`URL 截图失败：${errorMessage(err)}`, true)
  }
}

export async function runHtmlScreenshotCommand({ e, reply }: CommandOptions): Promise<unknown> {
  const html = String(matchPluginCommand(e?.msg, "截图HTML\\s+([\\s\\S]+)")?.[1] || "").trim()
  const config = await configStore.load()
  const htmlConfig = record(record(record(config).response).render).html ? record(record(record(record(config).response).render).html) : {}
  if (htmlConfig.enabled !== true) return reply("HTML 截图后端默认关闭。请在 response.render.html.enabled 开启后再使用。", true)
  try {
    const image = await renderHtmlToPng(html, { name: "command-html" }, config)
    return deliverRenderedImage(image, { e, config }, { label: "HTML 截图" })
  } catch (err) {
    hostRuntime.logger?.warn?.("[yui-chat] HTML 截图失败", err)
    return reply(`HTML 截图失败：${errorMessage(err)}`, true)
  }
}
