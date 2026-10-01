import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { pluginRoot, tempDir, yunzaiRoot } from "../../config/store.js"
import { fetchSafeHttp } from "../network/safe-http-client.js"
import { assertSafeHttpUrl, linkSafetyConfig, matchesAllowedHost } from "../network/link-safety-policy.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { errorSummary } from "../shared/error-details.js"
import { htmlRenderBaseCss, htmlRenderDocumentCss, renderFooter, renderTheme } from "./render-theme.js"

type UnknownRecord = Record<string, unknown>

interface RenderViewport {
  width: number
  height: number
}

interface HtmlRenderConfig extends UnknownRecord {
  urlEnabled: boolean
  allowPrivateHosts: boolean
  allowedUrlHosts: unknown[]
  maxUrlLength: number
  maxHtmlChars: number
  timeoutMs: number
  waitUntil: string
  waitMs: number
  viewport: RenderViewport
  deviceScaleFactor: number
}

interface RenderInput extends UnknownRecord {
  name?: unknown
  title?: unknown
  subtitle?: unknown
  markdown?: unknown
  content?: unknown
  footer?: unknown
  viewport?: unknown
  deviceScaleFactor?: unknown
  waitMs?: unknown
  waitForRenderComplete?: unknown
  fullPage?: unknown
  waitUntil?: unknown
}

interface RenderRequest {
  url(): string
  continue(): Promise<unknown> | unknown
  abort(reason?: string): Promise<unknown> | unknown
}

interface RenderFrame {
  name(): string
  evaluate<T>(pageFunction: () => T | Promise<T>): Promise<T>
}

interface RenderPage {
  frames?(): RenderFrame[]
  setRequestInterception?(enabled: boolean): Promise<unknown>
  on?(event: "request", handler: (request: RenderRequest) => Promise<unknown>): void
  on?(event: "error", handler: (error: unknown) => void): void
  setViewport(options: RenderViewport & { deviceScaleFactor: number }): Promise<unknown>
  goto(url: string, options: { timeout: number; waitUntil: string }): Promise<unknown>
  evaluate?<T>(pageFunction: (limit: number) => T | Promise<T>, arg: number): Promise<T>
  screenshot(options: { fullPage: boolean; type: "png"; clip?: { x: number; y: number; width: number; height: number } }): Promise<Uint8Array>
  close(): Promise<unknown>
}

interface RenderBrowser {
  newPage?(): Promise<RenderPage | null>
  isConnected?(): boolean
  once?(event: "disconnected", handler: () => void): void
  process?(): { pid?: number; exitCode?: number | null; signalCode?: string | null } | null
}

interface PuppeteerRenderer {
  browserInit(): Promise<RenderBrowser | null | false>
  browser?: RenderBrowser | null | false
  lock?: boolean
  browserInitPromise?: unknown
  restart?(force: boolean): unknown
}

interface HostRendererLoader {
  getRenderer(name?: string): PuppeteerRenderer | null | undefined
}

interface HostRendererLoaderModule {
  default: HostRendererLoader
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const htmlRenderDir = path.join(tempDir, "render-html")
const renderResourceDir = path.join(pluginRoot, "resources/render")
let sharedRendererPromise: Promise<PuppeteerRenderer> | null = null
let sharedBrowserPromise: Promise<RenderBrowser | null | false> | null = null
const browserRecoveries = new WeakMap<RenderBrowser, Promise<RenderBrowser>>()
const browserIds = new WeakMap<RenderBrowser, number>()
let nextBrowserId = 0

interface RenderTrace {
  id: string
  kind: "html" | "url"
  stage: string
  startedAt: number
  renderer?: PuppeteerRenderer
}

function htmlConfig(config: unknown = {}): HtmlRenderConfig {
  const root = record(config)
  const response = record(root.response)
  const render = record(response.render)
  const safety = linkSafetyConfig(config)
  return {
    urlEnabled: record(render.url).enabled === true,
    maxUrlLength: 2048,
    maxHtmlChars: 200000,
    timeoutMs: 30000,
    waitUntil: "networkidle2",
    waitMs: 500,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    ...record(render.html),
    allowPrivateHosts: safety.allowPrivateHosts,
    allowedUrlHosts: [...safety.screenshotAllowedHosts],
  }
}

export function isAllowedRenderHost(hostname: unknown = "", allowedHosts: unknown[] = []): boolean {
  return matchesAllowedHost(hostname, allowedHosts)
}

function assertAllowedRenderHost(inputUrl: string | URL = "", cfg: HtmlRenderConfig): URL {
  const url = inputUrl instanceof URL ? inputUrl : new URL(text(inputUrl || ""))
  const allowedHosts = Array.isArray(cfg.allowedUrlHosts) ? cfg.allowedUrlHosts : []
  if (!allowedHosts.length) {
    throw new Error("URL 截图未配置允许域名，请设置 security.linkSafety.screenshotAllowedHosts。")
  }
  if (!isAllowedRenderHost(url.hostname, allowedHosts)) {
    throw new Error(`URL 截图域名未在允许列表中：${url.hostname}`)
  }
  return url
}

function escapeHtml(value: unknown = ""): string {
  return text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function safeJsonScript(value: unknown = ""): string {
  return JSON.stringify(text(value || "")).replace(/<\//g, "<\\/")
}

function resourceUrl(...segments: unknown[]): string {
  return pathToFileURL(path.join(renderResourceDir, ...segments.map(segment => text(segment)))).toString()
}

function compactText(value: unknown = "", max = 120): string {
  const compact = text(value || "").replace(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact
}

/** 兼容模型常用的 LaTeX 定界符，同时避开 fenced code 中的源码示例。 */
export function normalizeMarkdownMathDelimiters(value: unknown = ""): string {
  let fenced = false
  return text(value).split("\n").map(line => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced
      return line
    }
    if (fenced) return line
    return line.split(/(`+[^`]*`+)/g).map(segment => {
      if (segment.startsWith("`")) return segment
      return segment
        .replace(/\\\[/g, () => "$$")
        .replace(/\\\]/g, () => "$$")
        .replace(/\\\(/g, () => "$")
        .replace(/\\\)/g, () => "$")
    }).join("")
  }).join("\n")
}

function buildDocumentFrame(title: unknown, subtitle: unknown, content: string, footer = renderFooter("html"), format = "HTML"): string {
  const visibleTitle = !title || /^(?:HTML|Markdown) 渲染$/.test(text(title)) ? "" : text(title)
  return `<div id="container"><main class="card" id="render-card">
    <header class="window-header"><div class="window-buttons" aria-hidden="true"><span></span><span></span><span></span></div><div class="window-title">${escapeHtml(visibleTitle)}</div><div class="window-tag">${escapeHtml(format)}</div></header>
    <article id="content">${content}</article>
    <footer>${subtitle ? `<span class="document-subtitle">${escapeHtml(subtitle)}</span>` : ""}<span>${escapeHtml(footer)}</span></footer>
  </main></div>`
}

/** 内容使用独立文档保留 CSS 与脚本，不能影响统一外框。 */
export function buildThemedHtml(html: string, input: RenderInput = {}): string {
  const contentStyles = `<meta charset="utf-8"><style>${htmlRenderDocumentCss}
    html { background: transparent; } body { margin: 0; color: #4a3735; font: 24px/1.72 sans-serif; }
  </style>`
  const contentDocument = /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, match => `${match}${contentStyles}`)
    : `<!doctype html><html><head>${contentStyles}</head><body>${html}</body></html>`
  const content = `<iframe name="yui-html-content" id="html-content-frame" sandbox="allow-scripts" srcdoc="${escapeHtml(contentDocument)}" style="display:block;width:100%;height:1px;border:0;margin:0"></iframe>`
  const frame = buildDocumentFrame(compactText(input.title || "HTML 渲染", 100), compactText(input.subtitle, 160), content)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${htmlRenderBaseCss}\n${htmlRenderDocumentCss}</style></head><body>${frame}</body></html>`
}

async function fitHtmlContent(page: RenderPage): Promise<void> {
  const frame = page.frames?.().find(frame => frame.name() === "yui-html-content")
  if (!frame || !page.evaluate) return
  // 先扩展内容宽度，再测量重排后的高度；不采用调用方的视口裁切尺寸。
  for (let pass = 0; pass < 2; pass++) {
    const size = await frame.evaluate(async () => {
      await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 1000))])
      const bounds = [...document.body.querySelectorAll("*")].map(element => element.getBoundingClientRect())
      return {
        width: (() => {
          const roots = [...document.body.children].filter(element => !["STYLE", "SCRIPT", "LINK"].includes(element.tagName))
          const root = roots.length === 1 ? roots[0].getBoundingClientRect() : null
          // 单一固定宽度画布可能居中于更宽的 body；收拢宿主后由浏览器重新布局。
          if (root && root.width >= 240 && root.width < document.body.clientWidth) return Math.ceil(root.width)
          return Math.ceil(Math.max(document.body.scrollWidth, ...bounds.map(rect => rect.right)))
        })(),
        height: Math.ceil(Math.max(document.body.scrollHeight, ...bounds.map(rect => rect.bottom))),
      }
    })
    if (size.width > 16000 || size.height > 16000) throw new Error("HTML 内容尺寸过大，请缩小内容后重试。")
    await page.evaluate(width => {
      const card = document.getElementById("render-card")!
      const content = document.getElementById("html-content-frame")!
      const frameWidth = card.getBoundingClientRect().width - content.getBoundingClientRect().width
      card.style.width = `${Math.max(320, Math.ceil(width + frameWidth))}px`
    }, size.width)
    await page.evaluate(height => {
      document.getElementById("html-content-frame")!.style.height = `${Math.max(1, height)}px`
    }, size.height)
  }
}

export async function renderThemedHtmlToPng(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const cfg = htmlConfig(config)
  const source = text(input.html ?? input.content)
  if (!source.trim()) throw new Error("HTML 内容不能为空。")
  if (source.length > Math.max(1000, numberValue(cfg.maxHtmlChars, 200000))) throw new Error("HTML 内容超过 response.render.html.maxHtmlChars 限制。")
  const result = await renderHtmlDocumentToPng(buildThemedHtml(source, input), {
    ...input,
    viewport: { width: 1300, height: 900 },
    fullPage: true,
  }, config, false)
  return { ...result, meta: { ...record(result.meta), engine: "html", renderer: "html-puppeteer", requestedEngine: "html", fallback: false } }
}

function buildMarkdownHtml(input: RenderInput = {}, config: unknown = {}): string {
  const cfg = htmlConfig(config)
  const title = compactText(input.title || "Markdown 渲染", 100)
  const subtitle = compactText(input.subtitle || "", 160)
  const markdown = normalizeMarkdownMathDelimiters(input.markdown || input.content || "").slice(0, Math.max(1000, numberValue(cfg.maxHtmlChars, 200000)))
  const footer = renderFooter("markdown")
  const katexCssUrl = resourceUrl("math/css/katex.min.css")
  const katexJsUrl = resourceUrl("math/js/katex.min.js")
  const markdownItUrl = resourceUrl("math/js/markdown-it.min.js")
  const mermaidUrl = resourceUrl("math/js/mermaid.min.js")
  const katexPluginUrl = resourceUrl("math/js/index.js")
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${katexCssUrl}">
<style>
${htmlRenderBaseCss}
${htmlRenderDocumentCss}
</style>
<script src="${katexJsUrl}"></script>
<script src="${markdownItUrl}"></script>
<script src="${katexPluginUrl}"></script>
<script src="${mermaidUrl}"></script>
</head>
<body>
${buildDocumentFrame(title, subtitle, '<p>渲染中...</p>', footer, 'Markdown')}
<script type="application/json" id="markdown-data">${safeJsonScript(markdown)}</script>
<script>
  (async function renderMarkdown() {
    const done = detail => { document.documentElement.dataset.yuiRenderComplete = "true"; window.dispatchEvent(new CustomEvent("yui-chat-render-complete", { detail })); };
    try {
      const raw = JSON.parse(document.getElementById("markdown-data").textContent || '""');
      if (typeof window.markdownit !== "function" || typeof window.markdownitKatex !== "function" || typeof window.katex !== "object") {
        throw new Error("Markdown 或 KaTeX 本地资源加载失败");
      }
      const md = window.markdownit({ html: false, breaks: true, linkify: true });
      md.use(window.markdownitKatex, { throwOnError: false });
      const defaultFenceRenderer = md.renderer.rules.fence;
      md.renderer.rules.fence = function(tokens, idx, options, env, self) {
        const token = tokens[idx];
        const language = String(token.info || "").trim().split(/\\s+/)[0].toLowerCase();
        if (language === "mermaid") return '<div class="mermaid">' + md.utils.escapeHtml(token.content) + '</div>\\n';
        return defaultFenceRenderer(tokens, idx, options, env, self);
      };
      const content = document.getElementById("content");
      content.innerHTML = md.render(raw || "暂无内容");
      if (window.mermaid && content.querySelector(".mermaid")) {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            fontFamily: "Outfit, Nunito, PingFang SC, sans-serif",
            fontSize: "20px",
            primaryColor: "#ffe5e7",
            primaryTextColor: "#4a3735",
            primaryBorderColor: "#ff8fa3",
            lineColor: "#ff8fa3",
            secondaryColor: "#fcd373",
            tertiaryColor: "#e2fbfb"
          }
        });
        await window.mermaid.run({ querySelector: ".mermaid" });
      }
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      setTimeout(() => done({ ok: true, type: "markdown-html" }), 100);
    } catch (err) {
      document.getElementById("content").innerHTML = '<div class="render-error">Markdown HTML 渲染失败：' + String(err && err.message || err).replace(/[<>&]/g, "") + '</div>';
      done({ ok: false, type: "markdown-html" });
    }
  })();
</script>
</body>
</html>`
}

function buildMarkmapHtml(input: RenderInput = {}, config: unknown = {}): string {
  const cfg = htmlConfig(config)
  const title = compactText(input.title || "思维导图", 100)
  const markdown = text(input.markdown || input.content || "").slice(0, Math.max(1000, numberValue(cfg.maxHtmlChars, 200000)))
  const d3Url = resourceUrl("markmap/d3.js")
  const libUrl = resourceUrl("markmap/markmap-lib.js")
  const viewUrl = resourceUrl("markmap/markmap-view.js")
  const fontsUrl = resourceUrl("markmap/fonts/fonts.css")
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${fontsUrl}">
<style>
${htmlRenderBaseCss}
  .markmap-content { flex: 1; min-height: 620px; display: flex; padding: 0 12px; }
  #markmap { width: 100%; min-height: 620px; overflow: visible; }
  #markmap text { fill: ${renderTheme.ink}; }
  #markmap .markmap-node > circle { stroke: ${renderTheme.accent}; stroke-width: 3px; fill: #fff !important; }
  #markmap .markmap-foreign div { color: ${renderTheme.ink}; background: transparent !important; border: 0 !important; border-radius: 0; box-shadow: none; padding: 2px 0; text-shadow: 0 1px 0 rgba(255,255,255,.96), 0 0 4px rgba(255,248,248,.88); }
</style>
<script src="${d3Url}"></script>
<script src="${libUrl}"></script>
<script src="${viewUrl}"></script>
</head>
<body>
<div id="container">
  <main class="card" id="render-card">
    <header class="window-header">
      <div class="window-buttons"><span></span><span></span><span></span></div>
      <div class="window-title"><span>${escapeHtml(title)}</span></div>
      <div class="window-tag">Mindmap</div>
    </header>
    <article class="markmap-content" id="content"><svg id="markmap"></svg></article>
    <footer>${escapeHtml(renderFooter("mindmap"))}</footer>
  </main>
</div>
<script type="application/json" id="markdown-data">${safeJsonScript(markdown)}</script>
<script>
  (function renderMarkmap() {
    const done = detail => { document.documentElement.dataset.yuiRenderComplete = "true"; window.dispatchEvent(new CustomEvent("yui-chat-render-complete", { detail })); };
    try {
      const markdown = JSON.parse(document.getElementById("markdown-data").textContent || '""');
      const { Transformer, Markmap } = window.markmap || {};
      const transformer = new Transformer();
      const { root } = transformer.transform(markdown || "# 空思维导图");
      const svg = document.getElementById("markmap");
      const colors = ["${renderTheme.accent}", "${renderTheme.blue}", "${renderTheme.violet}", "${renderTheme.rose}", "${renderTheme.gold}"];
      const color = window.d3.scaleOrdinal(colors);
      const mm = Markmap.create(svg, {
        autoFit: true,
        color: node => color(node.state.path || node.state.key),
        nodeMinHeight: 42,
        spacingHorizontal: 120,
        spacingVertical: 14,
        paddingX: 22,
        style: id => \`
          \${id} * { font-family: Outfit, Nunito, "Noto Sans SC", "PingFang SC", sans-serif !important; }
          \${id} path.markmap-link { stroke: ${renderTheme.accent}; stroke-width: 3px; stroke-linecap: round; opacity: .78; }
          \${id} .markmap-node > circle { stroke: ${renderTheme.accent}; stroke-width: 3px; fill: #fff !important; }
          \${id} .markmap-foreign div { font-size: 19px; font-weight: 700; color: ${renderTheme.ink}; line-height: 1.35; padding: 2px 0; background: transparent !important; border: 0 !important; border-radius: 0; box-shadow: none; text-shadow: 0 1px 0 rgba(255,255,255,.96), 0 0 4px rgba(255,248,248,.88); }
        \`
      }, root);
      setTimeout(() => {
        mm.fit();
        const rect = mm.state && mm.state.rect;
        if (rect) {
          const idealW = Math.max(1200, Math.round(rect.x2 - rect.x1 + 260));
          const idealH = Math.max(760, Math.round(rect.y2 - rect.y1 + 220));
          const card = document.getElementById("render-card");
          card.style.width = idealW + "px";
          card.style.minHeight = idealH + "px";
          svg.style.height = Math.max(620, idealH - 190) + "px";
          setTimeout(() => { mm.fit(); done({ ok: true, type: "markmap-html", width: idealW, height: idealH }); }, 120);
        } else {
          done({ ok: true, type: "markmap-html" });
        }
      }, 160);
    } catch (err) {
      document.body.innerHTML = '<main style="padding:32px;font:20px sans-serif;color:#a35d00">Markmap 渲染失败：' + String(err && err.message || err).replace(/[<>&]/g, "") + '</main>';
      done({ ok: false, type: "markmap-html" });
    }
  })();
</script>
</body>
</html>`
}

export async function assertSafeRenderUrl(inputUrl: string, config: unknown = {}): Promise<string> {
  const cfg = htmlConfig(config)
  const parsed = new URL(String(inputUrl || ""))
  if (["http:", "https:"].includes(parsed.protocol)) assertAllowedRenderHost(parsed, cfg)
  return assertSafeHttpUrl(inputUrl, {
    maxUrlLength: cfg.maxUrlLength,
    allowPrivateHosts: cfg.allowPrivateHosts,
  })
}

async function loadHostPuppeteerRenderer(): Promise<PuppeteerRenderer> {
  if (!sharedRendererPromise) {
    sharedRendererPromise = (async () => {
      const loaderModule = pathToFileURL(path.join(yunzaiRoot, "lib/renderer/loader.js")).href
      const mod = await import(loaderModule) as unknown as HostRendererLoaderModule
      const renderer = mod.default?.getRenderer?.("puppeteer")
      if (!renderer?.browserInit) throw new Error("Yunzai Puppeteer 渲染后端不可用。")
      return renderer
    })().catch(error => {
      sharedRendererPromise = null
      throw error
    })
  }
  return sharedRendererPromise
}

function renderErrorSummary(error: unknown): string {
  // Chromium 错误可能带页面 URL；不记录正文、URL 查询参数或浏览器端点。
  return errorSummary(error).replace(/(?:https?|wss?|file):\/\/\S+/gi, "<url>")
}

function browserState(browser: RenderBrowser | null): UnknownRecord {
  if (!browser) return { browserId: null }
  const process = browser.process?.()
  return {
    browserId: browserIds.get(browser) ?? null,
    connected: browser.isConnected?.() ?? "unknown",
    pid: process?.pid ?? null,
    exitCode: process?.exitCode ?? null,
    signalCode: process?.signalCode ?? null,
  }
}

function renderLog(level: "info" | "warn" | "debug", message: string, trace: RenderTrace, browser: RenderBrowser | null, error?: unknown): void {
  hostRuntime.logger?.[level]?.(`[yui-chat] ${message}`, {
    renderId: trace.id, kind: trace.kind, stage: trace.stage,
    elapsedMs: Date.now() - trace.startedAt, ...browserState(browser),
    hostLocked: trace.renderer?.lock ?? "unknown",
    hostInitPending: Boolean(trace.renderer?.browserInitPromise),
    hostOwnsBrowser: trace.renderer?.browser === undefined ? "unknown" : trace.renderer.browser === browser,
    ...(error === undefined ? {} : { error: renderErrorSummary(error) }),
  })
}

function observeBrowser(browser: RenderBrowser): void {
  if (browserIds.has(browser)) return
  browserIds.set(browser, ++nextBrowserId)
  browser.once?.("disconnected", () => {
    hostRuntime.logger?.warn?.("[yui-chat] 渲染浏览器连接断开", browserState(browser))
  })
}

async function beforeDeadline<T>(pending: Promise<T>, deadline: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Puppeteer ${stage}等待超时。`)), Math.max(0, deadline - Date.now()))
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function loadRenderBrowser(deadline: number): Promise<RenderBrowser> {
  const renderer = await beforeDeadline(loadHostPuppeteerRenderer(), deadline, "渲染后端")
  while (Date.now() < deadline) {
    // 只合并正在进行的获取，每次渲染都向宿主索取当前实例。
    if (!sharedBrowserPromise) {
      sharedBrowserPromise = Promise.resolve().then(() => renderer.browserInit()).finally(() => {
        sharedBrowserPromise = null
      })
    }
    const browser = await beforeDeadline(sharedBrowserPromise, deadline, "浏览器初始化")
    if (browser) {
      observeBrowser(browser)
      return browser
    }
    if (!renderer.lock && !renderer.browserInitPromise) throw new Error("Puppeteer 浏览器初始化失败。")
    // 旧版宿主初始化锁占用时返回 false，新版会直接等待 browserInitPromise。
    await beforeDeadline(new Promise(resolve => setTimeout(resolve, 100)), deadline, "宿主重启")
  }
  throw new Error("Puppeteer 等待宿主浏览器超时。")
}

function isBrowserConnectionError(error: unknown, browser: RenderBrowser | null): boolean {
  return browser?.isConnected?.() === false
    || text(record(error).name) === "ConnectionClosedError"
    || /connection (?:is )?closed|browser (?:has )?disconnected/i.test(text(record(error).message))
}

function recoverRenderBrowser(failedBrowser: RenderBrowser, deadline: number, trace: RenderTrace): Promise<RenderBrowser> {
  const pending = browserRecoveries.get(failedBrowser)
  if (pending) return beforeDeadline(pending, deadline, "并发连接恢复")
  const recovery = (async () => {
    const renderer = await beforeDeadline(loadHostPuppeteerRenderer(), deadline, "渲染后端")
    renderLog("warn", "渲染浏览器开始恢复", trace, failedBrowser)
    // 只请求宿主重启仍由它持有的失效实例；不能关闭已替换的浏览器。
    if (renderer.browser === failedBrowser && !renderer.lock && !renderer.browserInitPromise && renderer.restart) {
      await beforeDeadline(Promise.resolve(renderer.restart(true)), deadline, "宿主浏览器重启")
    }
    const browser = await loadRenderBrowser(deadline)
    if (browser === failedBrowser || browser.isConnected?.() === false) {
      throw new Error("Puppeteer 宿主仍返回失效的浏览器实例。")
    }
    renderLog("info", "渲染浏览器恢复成功", trace, browser)
    return browser
  })().catch(error => {
    renderLog("warn", "渲染浏览器恢复失败", trace, failedBrowser, error)
    throw error
  }).finally(() => {
    browserRecoveries.delete(failedBrowser)
  })
  browserRecoveries.set(failedBrowser, recovery)
  return recovery
}

async function closeRenderPage(page: RenderPage, trace: RenderTrace, browser: RenderBrowser): Promise<void> {
  try {
    await beforeDeadline(page.close(), Date.now() + 1000, "页面清理")
  } catch (error) {
    renderLog(isBrowserConnectionError(error, browser) ? "debug" : "warn", "渲染页面清理失败", trace, browser, error)
  }
}

async function createRenderPage(browser: RenderBrowser, deadline: number, trace: RenderTrace): Promise<RenderPage> {
  let abandoned = false
  const pending = Promise.resolve().then(() => browser.newPage?.()).then(async page => {
    if (!page) throw new Error("Puppeteer 页面创建失败。")
    // newPage 不能取消，超时后到达的页面仍须回收。
    if (abandoned) await closeRenderPage(page, trace, browser)
    return page
  })
  try {
    return await beforeDeadline(pending, deadline, "页面创建")
  } catch (error) {
    abandoned = true
    throw error
  }
}

async function withRenderPage<T>(cfg: HtmlRenderConfig, kind: RenderTrace["kind"], render: (page: RenderPage, trace: RenderTrace) => Promise<T>): Promise<T> {
  const trace: RenderTrace = { id: randomUUID().slice(0, 8), kind, stage: "browser-init", startedAt: Date.now() }
  const timeout = Math.min(10000, Math.max(100, numberValue(cfg.timeoutMs, 30000)))
  let browser: RenderBrowser | null = null
  let page: RenderPage | null = null
  let recoveryAttempted = false
  try {
    const deadline = Date.now() + timeout
    trace.renderer = await beforeDeadline(loadHostPuppeteerRenderer(), deadline, "渲染后端")
    browser = await loadRenderBrowser(deadline)
    trace.stage = "page-create"
    try {
      if (browser.isConnected?.() === false) throw new Error("Puppeteer browser disconnected.")
      page = await createRenderPage(browser, deadline, trace)
    } catch (error) {
      if (!isBrowserConnectionError(error, browser)) throw error
      renderLog("warn", "渲染页面创建时连接失效", trace, browser, error)
      recoveryAttempted = true
      const recoveryDeadline = Date.now() + Math.min(3000, timeout)
      trace.stage = "browser-recovery"
      browser = await recoverRenderBrowser(browser, recoveryDeadline, trace)
      trace.stage = "page-create-retry"
      page = await createRenderPage(browser, recoveryDeadline, trace)
    }
    const activeBrowser = browser
    page.on?.("error", error => renderLog("warn", "渲染页面崩溃", trace, activeBrowser, error))
    return await render(page, trace)
  } catch (error) {
    renderLog("warn", "浏览器渲染失败", trace, browser, error)
    const failedStage = trace.stage
    if (browser && !recoveryAttempted && isBrowserConnectionError(error, browser)) {
      // 已经加载的页面不重放，恢复只为后续调用服务。
      trace.stage = "browser-recovery"
      try {
        await recoverRenderBrowser(browser, Date.now() + Math.min(3000, timeout), trace)
      } catch {
        // recoverRenderBrowser 已记录恢复失败；保留原始渲染错误供回退使用。
      }
    }
    throw new Error(`Puppeteer 渲染失败 [renderId=${trace.id} kind=${kind} stage=${failedStage}]: ${renderErrorSummary(error)}`)
  } finally {
    if (page && browser) await closeRenderPage(page, trace, browser)
  }
}

async function persistHtml(html: string = "", name: unknown = "render"): Promise<string> {
  await fs.mkdir(htmlRenderDir, { recursive: true })
  const prefix = text(name || "render").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "render"
  const file = path.join(htmlRenderDir, `${prefix}-${randomUUID()}.html`)
  await fs.writeFile(file, html, "utf8")
  return file
}

async function waitForRenderComplete(page: RenderPage, timeoutMs = 3000): Promise<void> {
  const timeout = Math.min(3000, Math.max(100, numberValue(timeoutMs, 3000)))
  if (typeof page.evaluate !== "function") {
    await new Promise(resolve => setTimeout(resolve, timeout))
    return
  }
  await page.evaluate((limit: number) => new Promise(resolve => {
    if (document.documentElement.dataset.yuiRenderComplete === "true") return resolve(true)
    const timer = window.setTimeout(() => resolve(false), limit)
    window.addEventListener("yui-chat-render-complete", () => {
      window.clearTimeout(timer)
      resolve(true)
    }, { once: true })
  }), timeout)
}

function isAllowedLocalFileUrl(requestUrl: string = "", opts: UnknownRecord = {}): boolean {
  try {
    const parsed = new URL(requestUrl)
    if (parsed.protocol !== "file:") return false
    const file = path.resolve(fileURLToPath(parsed))
    const allowedDirs = [
      path.resolve(htmlRenderDir),
      path.resolve(renderResourceDir),
      ...(Array.isArray(opts.allowFileDirs) ? opts.allowFileDirs : []).map(dir => path.resolve(text(dir))),
    ]
    return allowedDirs.some(dir => file === dir || file.startsWith(`${dir}${path.sep}`))
  } catch {
    return false
  }
}

async function guardPageRequests(page: RenderPage, cfg: HtmlRenderConfig, opts: UnknownRecord = {}): Promise<void> {
  if (!page?.setRequestInterception) return
  const allowFileUrl = opts.allowFileUrl || ""
  await page.setRequestInterception(true)
  page.on?.("request", async request => {
    const requestUrl = request.url()
    try {
      if (allowFileUrl && requestUrl === allowFileUrl) return request.continue()
      const parsed = new URL(requestUrl)
      if (parsed.protocol === "file:" && isAllowedLocalFileUrl(requestUrl, opts)) return request.continue()
      if (["about:", "data:", "blob:"].includes(parsed.protocol)) return request.continue()
      if (opts.requireAllowedUrlHost && ["http:", "https:"].includes(parsed.protocol)) {
        assertAllowedRenderHost(parsed, cfg)
      }
      await assertSafeHttpUrl(requestUrl, {
        maxUrlLength: cfg.maxUrlLength,
        allowPrivateHosts: cfg.allowPrivateHosts,
      })
      return request.continue()
    } catch {
      return Promise.resolve(request.abort("blockedbyclient")).catch(() => undefined).then(() => undefined)
    }
  })
}

async function renderHtmlDocumentToPng(html: string = "", input: RenderInput = {}, config: unknown = {}, truncate = true): Promise<UnknownRecord> {
  const cfg = htmlConfig(config)
  const source = truncate ? text(html || "").slice(0, Math.max(1000, numberValue(cfg.maxHtmlChars, 200000))) : html
  const file = await persistHtml(source, input.name || "html")
  const fileUrl = pathToFileURL(file).toString()
  try {
    return await withRenderPage(cfg, "html", async (page, trace) => {
      trace.stage = "request-guard"
      await guardPageRequests(page, cfg, { allowFileUrl: fileUrl })
      trace.stage = "viewport"
      const viewport = record(input.viewport)
      await page.setViewport({
        width: numberValue(viewport.width || cfg.viewport.width, 1280),
        height: numberValue(viewport.height || cfg.viewport.height, 720),
        deviceScaleFactor: numberValue(input.deviceScaleFactor || cfg.deviceScaleFactor, 1),
      })
      trace.stage = "page-load"
      await page.goto(fileUrl, { timeout: cfg.timeoutMs, waitUntil: cfg.waitUntil })
      trace.stage = "render-wait"
      if (input.waitForRenderComplete === true) {
        await waitForRenderComplete(page, 3000)
      } else {
        const waitMs = numberValue(input.waitMs ?? cfg.waitMs, 0)
        if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 3000)))
      }
      trace.stage = "layout"
      await fitHtmlContent(page)
      const clip = await page.evaluate?.(() => {
        const container = document.getElementById("container")
        if (!container) return undefined
        const rect = container.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: Math.ceil(rect.width), height: Math.ceil(rect.height) }
      }, 0)
      trace.stage = "screenshot"
      const buffer = await page.screenshot({ fullPage: clip ? false : input.fullPage !== false, type: "png", ...(clip ? { clip } : {}) })
      const meta = { file, engine: "html-puppeteer" }
      return { buffer, meta }
    })
  } finally {
    await fs.unlink(file).catch(error => {
      if (record(error).code !== "ENOENT") hostRuntime.logger?.warn?.("[yui-chat] 渲染临时文件清理失败", renderErrorSummary(error))
    })
  }
}

function svgViewport(svg: string): RenderViewport {
  const tag = svg.match(/<svg\b[^>]*>/i)?.[0] || ""
  const read = (name: string, fallback: number): number => {
    const value = tag.match(new RegExp(`${name}=["']([0-9.]+)`))?.[1]
    return numberValue(value, fallback)
  }
  return {
    width: Math.min(2400, Math.max(320, Math.ceil(read("width", 1280)))),
    height: Math.min(2400, Math.max(240, Math.ceil(read("height", 900)))),
  }
}

/** 将插件生成的 SVG 包装进受控 HTML 页面，以便统一使用 HTML 优先策略。 */
export async function renderSvgToPng(svg: string = "", kind = "render", meta: UnknownRecord = {}, config: unknown = {}): Promise<UnknownRecord> {
  const viewport = svgViewport(svg)
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; padding: 0; width: max-content; min-height: 100%; background: ${renderTheme.page}; }
  body > svg { display: block; }
</style>
</head>
<body>${svg}</body>
</html>`
  const result = await renderHtmlDocumentToPng(html, {
    name: `${text(kind || "render")}-html`,
    viewport,
    fullPage: true,
    waitMs: 0,
  }, config)
  return {
    ...result,
    meta: { ...record(result.meta), ...meta, engine: "html-puppeteer" },
  }
}

export async function renderMarkdownHtmlToPng(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const html = buildMarkdownHtml(input, config)
  return renderHtmlDocumentToPng(html, {
    name: input.name || "markdown-html",
    viewport: { width: 1300, height: 900 },
    fullPage: true,
    waitMs: input.waitMs ?? 900,
    waitForRenderComplete: true,
  }, config)
}

export async function renderMarkmapHtmlToPng(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const html = buildMarkmapHtml(input, config)
  return renderHtmlDocumentToPng(html, {
    name: input.name || "markmap-html",
    viewport: input.viewport || { width: 1280, height: 860 },
    fullPage: input.fullPage !== false,
    waitMs: input.waitMs ?? 1200,
    waitForRenderComplete: true,
  }, config)
}

export async function renderUrlToPng(inputUrl: string = "", input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const cfg = htmlConfig(config)
  if (!cfg.urlEnabled) throw new Error("URL 图片渲染后端未启用。")
  const safeUrl = await assertSafeRenderUrl(inputUrl, config)
  return withRenderPage(cfg, "url", async (page, trace) => {
    trace.stage = "request-guard"
    await guardPageRequests(page, cfg, { requireAllowedUrlHost: true })
    trace.stage = "viewport"
    const viewport = record(input.viewport)
    await page.setViewport({
      width: numberValue(viewport.width || cfg.viewport.width, 1280),
      height: numberValue(viewport.height || cfg.viewport.height, 720),
      deviceScaleFactor: numberValue(input.deviceScaleFactor || cfg.deviceScaleFactor, 1),
    })
    trace.stage = "page-load"
    await page.goto(safeUrl, { timeout: cfg.timeoutMs, waitUntil: text(input.waitUntil || cfg.waitUntil) })
    trace.stage = "render-wait"
    const waitMs = numberValue(input.waitMs ?? cfg.waitMs, 0)
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, cfg.timeoutMs)))
    trace.stage = "screenshot"
    const buffer = await page.screenshot({ fullPage: input.fullPage !== false, type: "png" })
    const meta = { url: safeUrl, engine: "url-puppeteer" }
    return { buffer, meta }
  })
}

export async function fetchHtmlForRender(inputUrl: string = "", config: unknown = {}): Promise<string> {
  const cfg = htmlConfig(config)
  const response = await fetchSafeHttp(inputUrl, {
    allowPrivateHosts: cfg.allowPrivateHosts,
    maxBytes: Math.max(4096, numberValue(cfg.maxHtmlChars, 200000)) * 4,
    maxUrlLength: cfg.maxUrlLength,
    timeoutMs: cfg.timeoutMs,
    headers: { "User-Agent": "Yui-Chat-Render/0.1" },
  })
  if (!response.ok) throw new Error(`HTML 获取失败：HTTP ${response.status}`)
  const body = await response.text()
  return body.slice(0, Math.max(1000, numberValue(cfg.maxHtmlChars, 200000)))
}

export const renderHtmlService = {
  assertSafeRenderUrl,
  isAllowedRenderHost,
  renderThemedHtmlToPng,
  renderMarkdownHtmlToPng,
  renderMarkmapHtmlToPng,
  renderUrlToPng,
  fetchHtmlForRender,
}

/** 内置帮助模板只插入转义文本，复用工具的 HTML 后端、主题和缓存。 */
export function buildHelpMenuHtml(input: UnknownRecord): string {
  const groups = Array.isArray(input.groups) ? input.groups : []
  const blocks = groups.map(value => {
    const group = record(value)
    const commands = Array.isArray(group.commands) ? group.commands : Array.isArray(group.lines) ? group.lines : []
    return `<section><h2>${escapeHtml(text(group.title || group.name || "帮助分组"))}</h2><div class="commands">${commands.map(value => {
      const item = typeof value === "string" ? {command:value} : record(value)
      return `<article><b>${escapeHtml(text(item.command || item.cmd || item.example))}</b><p>${escapeHtml(text(item.description || item.desc || item.label))}${item.permission === "master" && group.permission !== "master" ? ' · 主人' : ''}</p></article>`
    }).join("")}</div></section>`
  }).join("")
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${htmlRenderBaseCss}
  body{margin:0;padding:24px;background:${renderTheme.page};color:${renderTheme.ink};font-family:Arial,"Microsoft YaHei",sans-serif;width:1048px;box-sizing:border-box}
  header{padding:0 4px 16px}h1{font-size:30px;margin:0 0 6px}header p,footer{color:${renderTheme.muted};font-size:14px;margin:0}
  main{display:grid;gap:14px}section{background:${renderTheme.card};border:1px solid ${renderTheme.cardLine};border-radius:16px;padding:16px 20px;break-inside:avoid}
  h2{font-size:20px;margin:0 0 8px;color:${renderTheme.accentStrong}}.commands{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:26px}
  article{padding:9px 0;border-top:1px solid ${renderTheme.cardLine};min-width:0}b{display:block;font-size:17px;line-height:1.4;overflow-wrap:anywhere}article p{font-size:14px;line-height:1.4;margin:3px 0 0;color:${renderTheme.muted}}footer{padding:14px 4px 0;text-align:right}
  </style><header><h1>${escapeHtml(text(input.title))}</h1><p>${escapeHtml(text(input.subtitle))}</p></header><main>${blocks}</main><footer>${escapeHtml(renderFooter("html"))}</footer></html>`
}

export async function renderHelpMenuHtml(input: UnknownRecord, config: unknown = {}): Promise<UnknownRecord> {
  return renderHtmlDocumentToPng(buildHelpMenuHtml(input), {name:"help-menu",viewport:{width:1048,height:800},fullPage:true}, config)
}
