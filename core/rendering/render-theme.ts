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
  const label = String(engine).toLowerCase() === "svg" ? "SVG" : "HTML"
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
  #container { width: fit-content; padding: 50px; position: relative; z-index: 1; }
  .card {
    width: 1200px;
    min-height: 800px;
    padding: 40px 45px 30px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: rgba(255,255,255,.76);
    border: 1.5px solid rgba(244,219,216,.88);
    border-radius: 40px;
    box-shadow: 0 30px 70px -15px rgba(244,190,190,.27), 0 15px 35px -20px rgba(0,0,0,.08), inset 0 1.5px 2px rgba(255,255,255,.92);
    backdrop-filter: blur(35px) saturate(140%);
  }
  .window-header { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 5px 0 22px; margin-bottom: 25px; border-bottom: 1.5px dashed rgba(244,219,216,.62); }
  .window-buttons { width: 100px; display: flex; gap: 8px; }
  .window-buttons span { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 1px 2px rgba(0,0,0,.12); }
  .window-buttons span:nth-child(1) { background: #ff5f56; }
  .window-buttons span:nth-child(2) { background: #ffbd2e; }
  .window-buttons span:nth-child(3) { background: #27c93f; }
  .window-title { flex: 1; text-align: center; }
  .window-title span { display: inline-block; max-width: 780px; padding: 7px 30px; overflow: hidden; color: #c8a7a4; background: rgba(255,255,255,.76); border: 1px solid rgba(255,180,190,.38); border-radius: 24px; box-shadow: 0 6px 15px rgba(255,143,163,.09), inset 0 1px 2px rgba(255,255,255,.92); font-size: 20px; font-weight: 800; letter-spacing: 2px; text-overflow: ellipsis; white-space: nowrap; }
  .window-tag { width: 100px; color: #c8a7a4; font-size: 11px; font-weight: 800; letter-spacing: .4px; text-align: right; text-transform: uppercase; }
  .document-subtitle { margin: 0 0 24px; color: ${renderTheme.muted}; font-size: 19px; font-weight: 650; text-align: center; }
  footer { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: auto; padding-top: 20px; color: #c8a7a4; border-top: 1.5px dashed rgba(244,219,216,.62); font-size: 14px; font-weight: 700; }
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
