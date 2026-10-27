import type { PortraitReport } from "../../memory/portrait.js"
import { htmlRenderBaseCss, renderFooter, renderTheme } from "./render-theme.js"

const escape = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
const date = (v: number): string => v ? new Date(v).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未记录"

/** 模型只提供数据；管理台预览与图片渲染使用同一份转义后的文档内容。 */
export function buildPortraitHtml(report: PortraitReport): string {
  const clone = report.typeId === "clone" && Boolean(report.personaPrompt)
  const body = clone
    ? `<p class="persona">${escape(report.personaPrompt)}</p>`
    : `<p class="lead">${escape(report.summary)}</p>${report.keywords.length ? `<div class="keywords">${report.keywords.map(keyword => `<span>${escape(keyword)}</span>`).join("")}</div>` : ""}${report.sections.map((s, i) => `<section><h2>${String(i + 1).padStart(2, "0")} / ${escape(s.heading)}</h2><p>${escape(s.text)}</p></section>`).join("")}`
  return `<style>
  .portrait-document{padding:28px 42px 36px;background:${renderTheme.card};color:${renderTheme.ink};font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;border-radius:12px;overflow-wrap:anywhere}
  .portrait-document .portrait-header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:0 0 24px}.portrait-document .portrait-header h1{min-width:0;margin:0;padding:0;border:0;color:${renderTheme.accentStrong};font-size:23px;line-height:1.4;font-weight:700}.portrait-document .portrait-date{flex-shrink:0;color:${renderTheme.muted};font-size:14px;white-space:nowrap}
  .portrait-document .lead{font-size:23px;line-height:1.85;margin:0 0 24px;padding-bottom:24px;border-bottom:1px solid ${renderTheme.cardLine}}.portrait-document .keywords{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.portrait-document .keywords span{max-width:100%;padding:4px 12px;border:1px solid ${renderTheme.cardLine};border-radius:999px;background:${renderTheme.cardSoft};color:#a4485d;font-size:16px;font-weight:600;line-height:1.5}
  .portrait-document section{margin-top:28px;break-inside:avoid}.portrait-document h2{font-size:23px;color:${renderTheme.accentStrong};margin:0 0 10px}.portrait-document section p,.portrait-document .persona{font-size:21px;line-height:1.85;margin:0;white-space:pre-wrap}
  </style><article class="portrait-document"><header class="portrait-header"><h1>${escape(`${report.name} · ${report.type.name}`)}</h1><span class="portrait-date">${escape(date(report.createdAt))}</span></header>${body}</article>`
}

export function buildPortraitPreviewDocument(report: PortraitReport): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${htmlRenderBaseCss}html,body{min-width:0;min-height:0;overflow:auto}#container{width:100%;padding:12px}.card{width:100%;padding:12px}.window-header{margin-bottom:12px}footer{font-size:14px;color:${renderTheme.muted};padding-top:12px;text-align:right}.portrait-document{padding:24px!important}.portrait-document .portrait-header h1{font-size:20px!important}.portrait-document .lead{font-size:18px!important}.portrait-document section p,.portrait-document .persona{font-size:16px!important}</style><div id="container"><main class="card"><header class="window-header"><div class="window-buttons"><span></span><span></span><span></span></div><div class="window-title"></div><div class="window-tag"></div></header>${buildPortraitHtml(report)}<footer>${renderFooter("html")}</footer></main></div></html>`
}

/** 固定 HTML 模板沿用统一外框和后端，由 render-service 作为公开入口。 */
export async function renderPortraitReport(report: PortraitReport, config: unknown = {}): Promise<Record<string, unknown>> {
  const root = config as { response?: { render?: { enabled?: boolean } } }
  if (root?.response?.render?.enabled === false) throw new Error("图片渲染服务未启用。")
  const { renderThemedHtmlToPng } = await import("./render-html-service.js")
  return renderThemedHtmlToPng({ html: buildPortraitHtml(report), headerTag: "", name: "memory-portrait" }, config)
}
