import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { pluginRoot, tempDir, yunzaiRoot } from "../../config/store.js"
import { fetchSafeHttp } from "../network/safe-http-client.js"
import { assertSafeHttpUrl, linkSafetyConfig, matchesAllowedHost } from "../network/link-safety-policy.js"
import { htmlRenderBaseCss, renderFooter, renderTheme } from "./render-theme.js"

type UnknownRecord = Record<string, unknown>

interface RenderViewport {
  width: number
  height: number
}

interface HtmlRenderConfig extends UnknownRecord {
  enabled: boolean
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

interface RenderPage {
  setRequestInterception?(enabled: boolean): Promise<unknown>
  on?(event: string, handler: (request: RenderRequest) => Promise<unknown>): void
  setViewport(options: RenderViewport & { deviceScaleFactor: number }): Promise<unknown>
  goto(url: string, options: { timeout: number; waitUntil: string }): Promise<unknown>
  evaluate?<T>(pageFunction: (limit: number) => T | Promise<T>, arg: number): Promise<T>
  screenshot(options: { fullPage: boolean; type: "png" }): Promise<Uint8Array>
  close(): Promise<unknown>
}

interface RenderBrowser {
  newPage?(): Promise<RenderPage | null>
  isConnected?(): boolean
}

interface PuppeteerRenderer {
  browserInit(): Promise<RenderBrowser | null | false>
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
let sharedBrowserPromise: Promise<RenderBrowser> | null = null
let sharedBrowser: RenderBrowser | null = null

function htmlConfig(config: unknown = {}): HtmlRenderConfig {
  const root = record(config)
  const response = record(root.response)
  const render = record(response.render)
  const safety = linkSafetyConfig(config)
  return {
    enabled: false,
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

function buildMarkdownHtml(input: RenderInput = {}, config: unknown = {}): string {
  const cfg = htmlConfig(config)
  const title = compactText(input.title || "Markdown 渲染", 100)
  const subtitle = compactText(input.subtitle || "", 160)
  const markdown = normalizeMarkdownMathDelimiters(input.markdown || input.content || "").slice(0, Math.max(1000, numberValue(cfg.maxHtmlChars, 200000)))
  const footer = renderFooter("html")
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
</style>
<script src="${katexJsUrl}"></script>
<script src="${markdownItUrl}"></script>
<script src="${katexPluginUrl}"></script>
<script src="${mermaidUrl}"></script>
</head>
<body>
<div id="container">
  <main class="card" id="render-card">
    <header class="window-header">
      <div class="window-buttons"><span></span><span></span><span></span></div>
      <div class="window-title"><span>${escapeHtml(title)}</span></div>
      <div class="window-tag">HTML</div>
    </header>
    ${subtitle ? `<p class="document-subtitle">${escapeHtml(subtitle)}</p>` : ""}
    <article id="content"><p>渲染中...</p></article>
    <footer>${escapeHtml(footer)}</footer>
  </main>
</div>
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
      <div class="window-tag">HTML</div>
    </header>
    <article class="markmap-content" id="content"><svg id="markmap"></svg></article>
    <footer>${escapeHtml(renderFooter("html"))}</footer>
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

async function loadRenderBrowser(): Promise<RenderBrowser> {
  if (sharedBrowser && sharedBrowser.isConnected?.() !== false) return sharedBrowser
  if (sharedBrowser) {
    sharedBrowser = null
    sharedRendererPromise = null
  }
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = (async () => {
      const renderer = await loadHostPuppeteerRenderer()
      const browser = await renderer.browserInit()
      if (!browser) throw new Error("Puppeteer 浏览器初始化失败。")
      sharedBrowser = browser
      return browser
    })().catch(error => {
      sharedRendererPromise = null
      throw error
    }).finally(() => {
      sharedBrowserPromise = null
    })
  }
  return sharedBrowserPromise
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

async function renderHtmlDocumentToPng(html: string = "", input: RenderInput = {}, config: unknown = {}, requireEnabled = true): Promise<UnknownRecord> {
  const cfg = htmlConfig(config)
  if (requireEnabled && cfg.enabled === false) throw new Error("HTML 图片渲染后端未启用。")
  const source = text(html || "").slice(0, Math.max(1000, numberValue(cfg.maxHtmlChars, 200000)))
  const file = await persistHtml(source, input.name || "html")
  const fileUrl = pathToFileURL(file).toString()
  let page: RenderPage | null = null
  try {
    const browser = await loadRenderBrowser()
    page = browser.newPage ? await browser.newPage() : null
    if (!page) {
      sharedBrowserPromise = null
      sharedBrowser = null
      throw new Error("Puppeteer 页面创建失败。")
    }
    await guardPageRequests(page, cfg, { allowFileUrl: fileUrl })
    const viewport = record(input.viewport)
    await page.setViewport({
      width: numberValue(viewport.width || cfg.viewport.width, 1280),
      height: numberValue(viewport.height || cfg.viewport.height, 720),
      deviceScaleFactor: numberValue(input.deviceScaleFactor || cfg.deviceScaleFactor, 1),
    })
    await page.goto(fileUrl, { timeout: cfg.timeoutMs, waitUntil: cfg.waitUntil })
    if (input.waitForRenderComplete === true) {
      await waitForRenderComplete(page, 3000)
    } else {
      const waitMs = numberValue(input.waitMs ?? cfg.waitMs, 0)
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 3000)))
    }
    const buffer = await page.screenshot({ fullPage: input.fullPage !== false, type: "png" })
    const meta = { file, engine: "html-puppeteer" }
    return { buffer, meta }
  } finally {
    await page?.close?.().catch(() => {})
    await fs.unlink(file).catch(() => {})
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
export async function renderSvgToPng(svg: string = "", kind = "render", meta: UnknownRecord = {}, config: unknown = {}, requireEnabled = true): Promise<UnknownRecord> {
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
  }, config, requireEnabled)
  return {
    ...result,
    meta: { ...record(result.meta), ...meta, engine: "html-puppeteer" },
  }
}

export async function renderHtmlToPng(html: string = "", input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  return renderHtmlDocumentToPng(html, input, config, true)
}

export async function renderMarkdownHtmlToPng(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const html = buildMarkdownHtml(input, config)
  return renderHtmlDocumentToPng(html, {
    name: input.name || "markdown-html",
    viewport: input.viewport || { width: 1300, height: 900 },
    fullPage: input.fullPage !== false,
    waitMs: input.waitMs ?? 900,
    waitForRenderComplete: true,
  }, config, false)
}

export async function renderMarkmapHtmlToPng(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const html = buildMarkmapHtml(input, config)
  return renderHtmlDocumentToPng(html, {
    name: input.name || "markmap-html",
    viewport: input.viewport || { width: 1280, height: 860 },
    fullPage: input.fullPage !== false,
    waitMs: input.waitMs ?? 1200,
    waitForRenderComplete: true,
  }, config, false)
}

export async function renderUrlToPng(inputUrl: string = "", input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const cfg = htmlConfig(config)
  if (cfg.enabled === false) throw new Error("URL 图片渲染后端未启用。")
  const safeUrl = await assertSafeRenderUrl(inputUrl, config)
  const browser = await loadRenderBrowser()
  const page = await browser.newPage?.()
  if (!page) throw new Error("Puppeteer 页面创建失败。")
  try {
    await guardPageRequests(page, cfg, { requireAllowedUrlHost: true })
    const viewport = record(input.viewport)
    await page.setViewport({
      width: numberValue(viewport.width || cfg.viewport.width, 1280),
      height: numberValue(viewport.height || cfg.viewport.height, 720),
      deviceScaleFactor: numberValue(input.deviceScaleFactor || cfg.deviceScaleFactor, 1),
    })
    await page.goto(safeUrl, { timeout: cfg.timeoutMs, waitUntil: text(input.waitUntil || cfg.waitUntil) })
    const waitMs = numberValue(input.waitMs ?? cfg.waitMs, 0)
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, cfg.timeoutMs)))
    const buffer = await page.screenshot({ fullPage: input.fullPage !== false, type: "png" })
    const meta = { url: safeUrl, engine: "url-puppeteer" }
    return { buffer, meta }
  } finally {
    await page.close().catch(() => {})
  }
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
  renderHtmlToPng,
  renderMarkdownHtmlToPng,
  renderMarkmapHtmlToPng,
  renderUrlToPng,
  fetchHtmlForRender,
}
