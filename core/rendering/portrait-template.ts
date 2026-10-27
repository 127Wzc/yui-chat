import type { PortraitReport } from "../../memory/portrait.js"
import { htmlRenderBaseCss, renderFooter, renderTheme } from "./render-theme.js"

const escape = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
const date = (v: number): string => v ? new Date(v).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未记录"

/** 模型只提供数据；管理台预览与图片渲染使用同一份转义后的文档内容。 */
export function buildPortraitHtml(report: PortraitReport): string {
  const clone = report.typeId === "clone" && Boolean(report.personaPrompt)
  const body = clone
    ? `<p class="persona">${escape(report.personaPrompt)}</p>`
    : `<p class="lead">${escape(report.summary)}</p>${report.keywords.length ? `<div class="keywords">${report.keywords.map(escape).join("　·　")}</div>` : ""}${report.sections.map((s, i) => `<section><h2>${String(i + 1).padStart(2, "0")} / ${escape(s.heading)}</h2><p>${escape(s.text)}</p></section>`).join("")}`
  return `<style>
  .portrait-document{padding:36px 42px;background:${renderTheme.card};color:${renderTheme.ink};font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;border-radius:12px;overflow-wrap:anywhere}
  .portrait-document .kicker{font-size:15px;letter-spacing:3px;color:${renderTheme.muted}}.portrait-document h1{font-size:38px;line-height:1.45;margin:16px 0 12px;letter-spacing:-.6px}.portrait-document .meta{color:${renderTheme.muted};font-size:18px;line-height:1.7}
  .portrait-document .lead{font-size:23px;line-height:1.85;margin:28px 0;padding-bottom:28px;border-bottom:1px solid ${renderTheme.cardLine}}.portrait-document .keywords{font-size:17px;color:${renderTheme.muted};margin:16px 0}
  .portrait-document section{margin-top:28px;break-inside:avoid}.portrait-document h2{font-size:23px;color:${renderTheme.accentStrong};margin:0 0 10px}.portrait-document section p,.portrait-document .persona{font-size:21px;line-height:1.85;margin:0;white-space:pre-wrap}.portrait-document .persona{margin-top:28px}
  </style><article class="portrait-document"><div class="kicker">YUI CHAT / PORTRAIT</div><h1>${escape(report.name)} · ${escape(report.type.name)}</h1><div class="meta">${date(report.createdAt)}</div>${body}</article>`
}

export function buildPortraitPreviewDocument(report: PortraitReport): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${htmlRenderBaseCss}html,body{min-width:0;min-height:0;overflow:auto}#container{width:100%;padding:12px}.card{width:100%;padding:12px}.window-header{margin-bottom:12px}footer{font-size:14px;color:${renderTheme.muted};padding-top:12px;text-align:right}.portrait-document{padding:24px!important}.portrait-document h1{font-size:28px!important}.portrait-document .lead{font-size:18px!important}.portrait-document section p,.portrait-document .persona{font-size:16px!important}</style><div id="container"><main class="card"><header class="window-header"><div class="window-buttons"><span></span><span></span><span></span></div><div class="window-title">聊天画像</div><div class="window-tag">HTML</div></header>${buildPortraitHtml(report)}<footer>${renderFooter("html")}</footer></main></div></html>`
}

/** 固定 HTML 模板沿用统一外框和后端，由 render-service 作为公开入口。 */
export async function renderPortraitReport(report: PortraitReport, config: unknown = {}): Promise<Record<string, unknown>> {
  const root = config as { response?: { render?: { enabled?: boolean } } }
  if (root?.response?.render?.enabled === false) throw new Error("图片渲染服务未启用。")
  const { renderThemedHtmlToPng } = await import("./render-html-service.js")
  return renderThemedHtmlToPng({ html: buildPortraitHtml(report), title: `${report.name} · 聊天画像`, name: "memory-portrait" }, config)
}
