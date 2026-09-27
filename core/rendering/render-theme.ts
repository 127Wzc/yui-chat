type UnknownRecord = Record<string, unknown>

export const renderTheme = {
  page: "#fff8f8",
  pageGradient: ["#ffe5e7", "#ffeae0", "#f4e6ff", "#e2fbfb"],
  card: "#ffffff",
  cardLine: "#f4dbd8",
  cardSoft: "#fff5f4",
  ink: "#4a3735",
  muted: "#a88d8b",
  accent: "#ff8fa3",
  accentStrong: "#d9657d",
  accentSoft: "#ffe5e7",
  blue: "#7d73c1",
  violet: "#a36bb7",
  rose: "#d9657d",
  gold: "#c99c4d",
  code: "#4a3735",
} as const

export const renderFooterToken = "__YUI_RENDER_FOOTER__"

export function renderFooter(engine: unknown = "html", fallback = false): string {
  const label = ({ svg: "SVG", html: "HTML", markdown: "Markdown", mindmap: "Mindmap", text: "文本卡片" } as Record<string, string>)[String(engine).toLowerCase()] || "HTML"
  return `Yui Chat · ${label}${fallback ? "（HTML 不可用，已回退 SVG）" : ""}`
}

function escapeXml(value: unknown = ""): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function compact(value: unknown, max = 80): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function svgText(value: unknown, x: number, y: number, options: UnknownRecord = {}): string {
  const size = Number(options.size) || 20
  const fill = String(options.fill || renderTheme.ink)
  const weight = options.weight ? ` font-weight="${escapeXml(options.weight)}"` : ""
  const anchor = options.anchor ? ` text-anchor="${escapeXml(options.anchor)}"` : ""
  const family = options.mono === true
    ? "Menlo, Consolas, 'Noto Sans SC', monospace"
    : "Outfit, Nunito, 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif"
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-family="${family}"${weight}${anchor}>${escapeXml(value)}</text>`
}

export interface SvgFrameOptions {
  width: number
  height: number
  title?: unknown
  subtitle?: unknown
  body?: string
  tag?: unknown
  footer?: unknown
}

/** Markdown HTML 的统一底座样式，Markmap 与其他 HTML 模板共用。 */
export const htmlRenderBaseCss = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html {
    min-width: fit-content;
    min-height: 100%;
    background: ${renderTheme.page} linear-gradient(135deg, ${renderTheme.pageGradient[0]} 0%, ${renderTheme.pageGradient[1]} 34%, ${renderTheme.pageGradient[2]} 69%, ${renderTheme.pageGradient[3]} 100%);
    background-repeat: no-repeat;
    background-size: cover;
  }
  body {
    margin: 0;
    min-width: fit-content;
    min-height: 100vh;
    overflow: hidden;
    background: transparent;
    color: ${renderTheme.ink};
    font-family: "Outfit", "Nunito", -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
    position: relative;
  }
  body::before {
    content: "";
    position: absolute;
    inset: 0;
    opacity: .025;
    pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  #container { width: fit-content; padding: 10px; position: relative; z-index: 1; }
  .card {
    width: 1200px;
    min-height: 0;
    padding: 12px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: linear-gradient(135deg, #fff0f3 0%, #fff6f7 60%, #f9eff8 100%);
    border: 1.5px solid rgba(244,219,216,.88);
    border-radius: 18px;
    box-shadow: 0 30px 70px -15px rgba(244,190,190,.27), 0 15px 35px -20px rgba(0,0,0,.08), inset 0 1.5px 2px rgba(255,255,255,.92);
    backdrop-filter: blur(35px) saturate(140%);
  }
  .window-header { display: flex; align-items: center; gap: 12px; min-height: 24px; margin-bottom: 10px; }
  .window-buttons { display: flex; flex-shrink: 0; align-items: center; gap: 6px; }
  .window-buttons span { width: 10px; height: 10px; border-radius: 50%; box-shadow: inset 0 1px 2px rgba(0,0,0,.1); }
  .window-buttons span:nth-child(1) { background: #ff5f56; }
  .window-buttons span:nth-child(2) { background: #ffbd2e; }
  .window-buttons span:nth-child(3) { background: #27c93f; }
  .window-title { flex: 1; min-width: 0; color: #a98784; font-size: 18px; font-weight: 700; overflow-wrap: anywhere; }
  .window-tag { margin-left: auto; color: #b99c99; font-size: 11px; }
  .document-subtitle { margin: 0; color: ${renderTheme.muted}; font-size: 12px; font-weight: 400; }
  #render-card > #content { flex: 1; padding: 0; min-width: 0; }
  #render-card > footer { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; margin-top: 10px; padding: 0; color: #b99c99; font-size: 11px; }

`

/** SVG 回退也使用与 Markdown HTML 相同的渐变、白卡、窗口头和脚注。 */
export function buildSvgFrame({ width, height, title = "Yui Chat", subtitle = "", body = "", tag = "YUI CHAT", footer = renderFooterToken }: SvgFrameOptions): string {
  const safeWidth = Math.max(320, Math.round(width))
  const safeHeight = Math.max(240, Math.round(height))
  const center = safeWidth / 2
  const titleWidth = Math.min(680, Math.max(300, safeWidth - 360))
  const titleX = center - titleWidth / 2
  const headerLineY = 148
  const subtitleY = 184
  const footerLineY = safeHeight - 72
  const content = body || ""
  return `<svg width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="yui-page-gradient" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${renderTheme.pageGradient[0]}"/><stop offset="34%" stop-color="${renderTheme.pageGradient[1]}"/><stop offset="69%" stop-color="${renderTheme.pageGradient[2]}"/><stop offset="100%" stop-color="${renderTheme.pageGradient[3]}"/>
      </linearGradient>
      <filter id="yui-card-shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#f4bebe" flood-opacity="0.28"/></filter>
    </defs>
    <rect width="100%" height="100%" fill="url(#yui-page-gradient)"/>
    <rect x="28" y="28" width="${safeWidth - 56}" height="${safeHeight - 56}" rx="40" fill="${renderTheme.card}" fill-opacity="0.82" stroke="${renderTheme.cardLine}" stroke-width="2" filter="url(#yui-card-shadow)"/>
    <circle cx="72" cy="72" r="7" fill="#ff5f56"/><circle cx="96" cy="72" r="7" fill="#ffbd2e"/><circle cx="120" cy="72" r="7" fill="#27c93f"/>
    <rect x="${titleX}" y="51" width="${titleWidth}" height="42" rx="22" fill="#ffffff" fill-opacity="0.78" stroke="${renderTheme.accent}" stroke-opacity="0.38"/>
    ${svgText(compact(title, 70), center, 79, { size: 20, fill: "#c8a7a4", weight: 800, anchor: "middle" })}
    ${svgText(compact(tag, 16), safeWidth - 72, 76, { size: 11, fill: "#c8a7a4", weight: 800, anchor: "end" })}
    <line x1="56" y1="${headerLineY}" x2="${safeWidth - 56}" y2="${headerLineY}" stroke="${renderTheme.cardLine}" stroke-width="2" stroke-dasharray="8 10"/>
    ${subtitle ? svgText(compact(subtitle, 120), center, subtitleY, { size: 19, fill: renderTheme.muted, weight: 650, anchor: "middle" }) : ""}
    ${content}
    <line x1="56" y1="${footerLineY}" x2="${safeWidth - 56}" y2="${footerLineY}" stroke="${renderTheme.cardLine}" stroke-width="2" stroke-dasharray="8 10"/>
    ${svgText(footer, center, safeHeight - 38, { size: 17, fill: "#c8a7a4", weight: 700, anchor: "middle" })}
  </svg>`
}

/** Markdown 与 HTML 内容共用的正文排版。 */
export const htmlRenderDocumentCss = `
  article { flex: 1; padding: 10px 20px; color: #4a3735; font-size: 24px; line-height: 1.72; }
  h1, h2, h3, h4, h5, h6 { color: #ff8fa3; line-height: 1.28; padding-bottom: 10px; margin: 1.5em 0 .7em; border-bottom: 2px dashed rgba(244,219,216,.58); }
  h1 { font-size: 42px; }
  h2 { font-size: 34px; }
  h3 { font-size: 29px; }
  h4 { font-size: 25px; }
  h5, h6 { font-size: 23px; }
  article > :first-child { margin-top: .45em; }
  p { margin: 12px 0 18px; }
  strong { color: #3e2d2c; font-weight: 800; }
  ul, ol { margin: 12px 0 22px; padding-left: 38px; }
  li { margin: 9px 0; padding-left: 3px; }
  li::marker { color: #ff8fa3; font-weight: 800; }
  blockquote { margin: 22px 0; padding: 16px 22px; color: #715b59; background: rgba(255,255,255,.52); border: 1px solid rgba(244,219,216,.72); border-left: 6px solid #ff8fa3; border-radius: 0 16px 16px 0; }
  blockquote > :first-child { margin-top: 0; }
  blockquote > :last-child { margin-bottom: 0; }
  a { color: #d9657d; text-decoration-color: rgba(217,101,125,.45); text-underline-offset: 4px; }
  code { padding: 3px 8px; color: #9e4e60; background: rgba(255,255,255,.66); border: 1px solid rgba(244,219,216,.7); border-radius: 8px; font-family: Menlo, Consolas, "Noto Sans Mono CJK SC", monospace; font-size: .82em; }
  pre { margin: 22px 0; padding: 20px 22px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; color: #f8e9ec; background: #4a3735; border: 1px solid rgba(244,219,216,.65); border-radius: 16px; box-shadow: 0 8px 22px rgba(74,55,53,.1); font-size: 18px; line-height: 1.62; }
  pre code { padding: 0; color: inherit; background: transparent; border: 0; font-size: inherit; }
  table { width: 100%; margin: 22px 0; overflow: hidden; border-spacing: 0; border-collapse: separate; border: 1px solid rgba(244,219,216,.8); border-radius: 14px; }
  th, td { padding: 13px 16px; border-right: 1px solid rgba(244,219,216,.62); border-bottom: 1px solid rgba(244,219,216,.62); text-align: left; }
  th { color: #b75d70; background: rgba(255,229,231,.55); font-weight: 800; }
  tr:last-child td { border-bottom: 0; }
  th:last-child, td:last-child { border-right: 0; }
  hr { height: 0; margin: 30px 0; border: 0; border-top: 1.5px dashed rgba(244,219,216,.75); }
  img { max-width: 100%; height: auto; border-radius: 16px; }
  .katex { font-size: 1.15em; }
  .katex-block { margin: 24px 0; }
  .katex-display { margin: 0; padding: 22px 24px; overflow-x: auto; overflow-y: hidden; background: rgba(255,255,255,.58); border: 1px solid rgba(244,219,216,.75); border-radius: 16px; box-shadow: 0 5px 16px rgba(244,190,190,.11); font-size: 1.18em !important; }
  .katex-error { display: inline-block; padding: 4px 8px; color: #a33d50; background: #fff0f2; border-radius: 8px; font-family: Menlo, Consolas, monospace; font-size: .8em; }
  .mermaid { display: flex; justify-content: center; margin: 28px 0; padding: 24px; overflow-x: auto; background: rgba(255,255,255,.48); border: 1px dashed rgba(244,219,216,.88); border-radius: 20px; }
  .render-error { margin: 18px 0; padding: 16px 20px; color: #a33d50; background: #fff0f2; border: 1px solid #efb5bf; border-radius: 12px; }
`
