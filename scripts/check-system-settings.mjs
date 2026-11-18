import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { once } from "node:events"
import { createRenderer, createSSRApp, nextTick, reactive } from "vue"
import { renderToString } from "vue/server-renderer"
import { defaults } from "../output/runtime/config/defaults.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
global.location = { pathname: "/yui-chat", hash: "", search: "" }
global.localStorage = { getItem: () => null, setItem() {} }
const panelUrl = new URL("../output/runtime/web/client/features/advanced/langfuse-panel.js", import.meta.url)
const storeImport = (await fs.readFile(panelUrl, "utf8")).match(/from "([^\"]*store\/store\.js[^\"]*)"/)[1]
const { store, confirmState, settleConfirm, hasUnsavedChanges } = await import(new URL(storeImport, panelUrl))
const { LangfusePanel } = await import(panelUrl)
const { AdvancedTab } = await import("../output/runtime/web/client/features/advanced/advanced-tab.js")
const { components } = await import("../output/runtime/web/client/ui/components.js")
const saved = structuredClone(defaults)
Object.assign(saved.logging.langfuse, { enabled: true, publicKey: "********", secretKey: "********" })
const diagnostics = { summary: {}, runtime: { langfuse: { enabled: true, configured: true, month: "2026-11", monthlyUnitLimit: 45000, reservedUnits: 3200, pending: 2, retrying: 0, buffered: 0, sent: 133, skipped: 0 } } }
const patches = []
const apiCalls = []
let webToken = "web-fixture-token-12345"
let failSave = false
const nativeFetch = global.fetch
function responseFor(url, options = {}) {
  apiCalls.push({ url: String(url), method: options.method || "GET" })
  if (String(url).endsWith("/api/config/auth-token")) {
    if (options.method === "PUT") webToken = JSON.parse(options.body).authToken
    return { ok: true, status: 200, json: async () => ({ ok: true, authToken: webToken }) }
  }
  if (options.method === "PATCH") {
    const { patch } = JSON.parse(options.body)
    patches.push(patch)
    if (failSave) return { ok: false, status: 500, json: async () => ({ error: "fixture save failure" }) }
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split(".")
      const leaf = parts.pop()
      let target = saved
      for (const part of parts) target = target[part] ||= {}
      target[leaf] = /publicKey|secretKey/.test(leaf) ? "********" : value
    }
  }
  const body = String(url).includes("/api/diagnostics") ? { ok: true, diagnostics } : { ok: true, config: structuredClone(saved), meta: { loaded: true } }
  return { ok: true, status: 200, json: async () => body }
}
global.fetch = async (url, options) => responseFor(url, options)
store.activeTab = "advanced"
store.systemSettingsSection = "langfuse"
store.config = structuredClone(saved)
store.diagnostics = structuredClone(diagnostics)
store.configMeta = { loaded: true }
const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
let state
const mounted = renderer.createApp({ setup() { state = LangfusePanel.setup(); return () => null } })
mounted.mount({})
try {
  assert.equal(state.draft.baseUrl, "https://jp.cloud.langfuse.com")
  assert.equal(state.draft.publicKey, "")
  state.draft.sampleRate = 0.5
  await nextTick()
  assert.equal(store.dirtyScopes["system:langfuse"], true)
  // A settings refresh while editing must not discard the local draft.
  store.config = structuredClone(saved)
  await nextTick()
  assert.equal(state.draft.sampleRate, 0.5)
  await state.save()
  await nextTick()
  assert.equal(patches.at(-1)["logging.langfuse.baseUrl"], "https://jp.cloud.langfuse.com", "saving other settings retains the existing endpoint")
  assert.equal(patches.at(-1)["logging.langfuse.sampleRate"], 0.5)
  assert(!Object.hasOwn(patches.at(-1), "logging.langfuse.publicKey"))
  assert(!Object.hasOwn(patches.at(-1), "logging.langfuse.secretKey"))
  assert.equal(state.dirty.value, false)
  state.draft.baseUrl = " http://127.0.0.1:3000/telemetry/ "
  await state.save()
  await nextTick()
  assert.equal(patches.at(-1)["logging.langfuse.baseUrl"], "http://127.0.0.1:3000/telemetry/", "custom deployment URL is editable and trimmed")
  assert.equal(state.draft.baseUrl, "http://127.0.0.1:3000/telemetry/")
  state.draft.secretKey = "sk-lf-new-fixture"
  failSave = true
  await state.save()
  await nextTick()
  assert.equal(state.dirty.value, true)
  assert.equal(state.draft.secretKey, "sk-lf-new-fixture", "failed saves retain typed credentials")
  assert.equal(store.dirtyScopes["system:langfuse"], true)
  failSave = false
  await state.save()
  await nextTick()
  assert.equal(state.draft.secretKey, "")
  assert.equal(store.dirtyScopes["system:langfuse"], undefined)
} finally { mounted.unmount(); global.fetch = nativeFetch }

const render = async (component, props = {}) => {
  const app = createSSRApp(component, props)
  for (const [name, value] of Object.entries(components)) app.component(name, value)
  return renderToString(app)
}
const connection = await render(LangfusePanel, { section: "connection" })
assert(connection.includes("连接与凭证") && connection.includes("已配置，留空保留"))
assert(connection.includes("高级连接设置") && !connection.includes('<details class="config-details" open'))
assert(connection.includes('type="url"') && connection.includes("服务地址") && !connection.includes("Cloud 快捷地址") && connection.includes('value="http://127.0.0.1:3000/telemetry/"'))
assert(!connection.includes("对话采样比例") && !connection.includes('value="********"'))
const sampling = await render(LangfusePanel, { section: "sampling" })
assert(sampling.includes("每月 Units 上限") && !sampling.includes('type="password"'))
const status = await render(LangfusePanel, { section: "status" })
assert(status.includes("3,200") && status.includes('aria-label="本月已预留额度比例"') && !status.includes('type="password"'))
store.systemSettingsSection = "langfuse"
const advanced = await render(AdvancedTab)
assert(advanced.includes('aria-label="系统设置导航"') && advanced.includes('aria-label="Langfuse 观测分区"'))
assert.match(advanced, /class="[^"]*settings-rail-subitem[^"]*"[^>]*aria-current="page"/)
assert(!advanced.includes('label="系统与诊断分区"'))

// Exercise the actual page state: navigation, independent drafts and confirmed actions.
global.fetch = async (url, options) => responseFor(url, options)
saved.memory.groupCapture.defaultRetentionDays = 0
store.config = structuredClone(saved)
store.systemSettingsSection = "status"
store.memory = { capture: { defaultPromptTemplate: "fixture extraction prompt" } }
store.developerMode = false
const settleUi = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)) }
let page
const pageApp = renderer.createApp({ setup() { page = AdvancedTab.setup(); return () => null } })
const authReadsBefore = apiCalls.filter(call => call.url.endsWith("/auth-token")).length
pageApp.mount({})
try {
  await settleUi()
  assert.equal(page.activeSubsection.value, "overview")
  assert.equal(apiCalls.filter(call => call.url.endsWith("/auth-token")).length, authReadsBefore, "overview must not fetch credentials")
  assert.equal(page.draft.captureRetentionDays, 0, "permanent retention remains zero")
  assert.equal(hasUnsavedChanges(), false, "hydration must not mark defaults as edited")
  const expected = { status: 3, langfuse: 3, "link-safety": 2, backup: 2, "memory-capture": 5, developer: 4 }
  for (const [section, count] of Object.entries(expected)) assert.equal(page.subsections[section].length, count)
  page.selectSection("memory-capture", "extraction")
  page.draft.captureTokenLimit = 12000
  page.draft.captureModelName = "pending-extractor"
  page.selectSection("link-safety", "screenshot")
  page.draft.linkScreenshotAllowedHosts = "example.com"
  page.selectSection("memory-capture")
  await settleUi()
  assert.equal(page.activeSubsection.value, "extraction", "each primary remembers its last subsection")
  assert.equal(page.draft.captureTokenLimit, 12000)
  assert.equal(page.draft.linkScreenshotAllowedHosts, "example.com")
  assert(page.sectionDirty("memory-capture") && page.sectionDirty("link-safety"))
  page.selectSection("status", "address")
  page.draft.webPublicBaseUrl = "https://fixture.example/console/"
  await page.saveWebAddress()
  await settleUi()
  assert.equal(page.draft.webPublicBaseUrl, "https://fixture.example/console")
  assert.equal(page.isDirty("web-address"), false)
  assert.equal(page.draft.captureModelName, "pending-extractor", "saving a different group preserves the extraction draft")
  assert.equal(page.draft.linkScreenshotAllowedHosts, "example.com")
  assert.equal(page.isDirty("memory-capture"), true)
  await page.saveCaptureDefaults()
  await settleUi()
  assert.equal(patches.at(-1)["memory.groupCapture.defaultRetentionDays"], 0)
  assert.equal(patches.at(-1)["memory.groupCapture.defaultTokenLimit"], 12000)
  assert.equal(page.isDirty("memory-capture"), false)
  assert.equal(page.isDirty("link-safety"), true, "saving one domain does not clear another domain's dirty flag")
  page.selectSection("backup", "retention")
  page.draft.backupMaxFiles = 6
  failSave = true
  await page.saveBackupPolicy()
  await settleUi()
  assert.equal(page.draft.backupMaxFiles, 6)
  assert.equal(page.isDirty("backup"), true)
  failSave = false
  await page.saveBackupPolicy()
  await settleUi()
  assert.equal(page.isDirty("backup"), false)

  page.selectSection("status/credentials")
  await settleUi()
  assert.equal(page.webTokenLoaded.value, true)
  assert.equal(page.draft.webAuthToken, webToken)
  const readCount = apiCalls.filter(call => call.url.endsWith("/auth-token")).length
  page.draft.webAuthToken = "unsaved-web-fixture-token"
  page.selectSection("status", "overview")
  page.selectSection("status", "credentials")
  await settleUi()
  assert.equal(page.draft.webAuthToken, "unsaved-web-fixture-token")
  assert.equal(apiCalls.filter(call => call.url.endsWith("/auth-token")).length, readCount)
  const tokenSavesBefore = apiCalls.filter(call => call.method === "PUT").length
  let savingToken = page.saveWebAuthToken()
  assert.equal(confirmState.open, true)
  settleConfirm(false)
  await savingToken
  assert.equal(apiCalls.filter(call => call.method === "PUT").length, tokenSavesBefore)
  savingToken = page.saveWebAuthToken()
  settleConfirm(true)
  await savingToken
  await settleUi()
  assert.equal(page.isDirty("web-token"), false)

  page.selectSection("developer", "render")
  await page.toggleDeveloperMode(true)
  const renderDraft = reactive({ engine: "html" })
  page.systemRenderPanel.value = { getPatch: () => ({ "response.render.system.engine": renderDraft.engine }) }
  await settleUi()
  assert.equal(page.isDirty("developer"), false)
  renderDraft.engine = "svg"
  page.draft.loggingLevel = "debug"
  page.selectSection("memory-capture", "recall")
  page.selectSection("developer", "logs")
  assert.equal(renderDraft.engine, "svg")
  await page.saveDeveloperSettings()
  await settleUi()
  assert.equal(patches.at(-1)["response.render.system.engine"], "svg")
  assert.equal(patches.at(-1)["logging.level"], "debug")
  assert.equal(page.isDirty("developer"), false)
  page.showJsonDrawer.value = true
  const savedJson = page.draft.configJson
  page.draft.configJson += "\n"
  let closing = page.closeJsonDrawer()
  assert.equal(confirmState.open, true)
  settleConfirm(false)
  await closing
  assert.equal(page.showJsonDrawer.value, true)
  closing = page.closeJsonDrawer()
  settleConfirm(true)
  await closing
  assert.equal(page.showJsonDrawer.value, false)
  assert.equal(page.draft.configJson, savedJson)
  page.draft.loggingLevel = "warn"
  let disabling = page.toggleDeveloperMode(false)
  assert.equal(confirmState.open, true)
  settleConfirm(false)
  await disabling
  assert.equal(store.developerMode, true)
  assert.equal(page.draft.loggingLevel, "warn")
  disabling = page.toggleDeveloperMode(false)
  settleConfirm(true)
  page.systemRenderPanel.value = null // The real conditional child clears its ref on unmount.
  await disabling
  assert.equal(store.developerMode, false)
  assert.equal(page.draft.loggingLevel, "debug")
  assert.equal(page.isDirty("developer"), false)
  page.selectSection("invalid-section")
  assert.equal(page.activeSection.value, "developer")
} finally { pageApp.unmount(); global.fetch = nativeFetch }
assert.equal(hasUnsavedChanges(), false, "unmount clears the page's dirty registrations")

let renderState
const renderApp = renderer.createApp({ setup() { renderState = AdvancedTab.components.SystemRenderStrategyPanel.setup({}, { expose() {} }); return () => null } })
renderApp.mount({})
renderState.settings.engine = "html"
store.config = structuredClone(saved)
await settleUi()
assert.equal(renderState.settings.engine, "html", "unrelated configuration refreshes preserve the render draft")
renderApp.unmount()

for (const [section, child, heading] of [["status", "address", "访问地址"], ["link-safety", "screenshot", "截图域名"], ["backup", "retention", "保留策略"], ["memory-capture", "extraction", "提炼设置"], ["developer", "render", "渲染设置"]]) {
  store.systemSettingsSection = `${section}/${child}`
  store.developerMode = true
  const html = await render(AdvancedTab)
  assert(html.includes(`<h2>${heading}</h2>`), heading)
  assert.equal((html.match(/class="settings-rail-subnav"/g) || []).length, 1, "only the active primary expands")
}
store.developerMode = false
store.systemSettingsSection = "developer"
const gated = await render(AdvancedTab)
assert(gated.includes("高级配置已隐藏") && !gated.includes('aria-label="开发者设置分区"'))
console.log("ok system settings: six grouped menus, remembered selection, editable service URL, isolated drafts/saves, on-demand credentials, confirmations and rendering")

if (process.argv.includes("--serve")) {
  saved.memory.groupCapture.consolidation.modelName = ""
  const { default: express } = await import("express")
  const app = express()
  app.use(express.json())
  app.use("/assets", express.static(path.join(root, "output/runtime/web/client")))
  app.use(["/api", "/yui-chat/api"], (req, res) => {
    const result = responseFor(req.originalUrl, { method: req.method, body: JSON.stringify(req.body) })
    result.json().then(body => res.status(result.status).json(body))
  })
  app.get("/", (_req, res) => {
    const version = storeImport.match(/store\.js(\?v=[^"']+)/)?.[1] || ""
    res.type("html").send(`<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>系统设置 · 本地预览</title><link rel="stylesheet" href="/assets/app.css"><style>body{padding:28px}.preview-shell{max-width:1440px;margin:auto}.preview-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.preview-head h1{font-size:20px;margin:0}.preview-head p{margin:5px 0 0}@media(max-width:860px){body{padding:12px}}</style><script type="importmap">{"imports":{"vue":"/assets/vendor/vue.esm-browser.prod.js"}}</script><div id="app"></div><script type="module">import{createApp}from'vue';import{AdvancedTab}from'/assets/features/advanced/advanced-tab.js';import{components}from'/assets/ui/components.js';import{store}from'/assets/app/store/store.js${version}';store.config=${JSON.stringify(saved).replace(/</g, "\\u003c")};store.diagnostics=${JSON.stringify(diagnostics)};store.configMeta={loaded:true};store.memory={capture:{defaultPromptTemplate:"请根据群聊记录提炼有证据的记忆，保留明确的时间、归属与事实。"}};store.activeTab='advanced';store.systemSettingsSection='langfuse';const app=createApp({components:{AdvancedTab},methods:{theme(){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}},template:'<main class="preview-shell"><header class="preview-head"><div><h1>系统设置</h1><p class="muted small">配置、运行维护与模型观测</p></div><button class="btn outline" @click="theme">切换主题</button></header><AdvancedTab/><Toast/><ConfirmDialog/></main>'});for(const[n,c]of Object.entries(components))app.component(n,c);app.mount('#app')</script></html>`)
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  console.log(`preview http://127.0.0.1:${server.address().port}`)
  await new Promise(resolve => process.once("SIGTERM", resolve))
  await new Promise(resolve => server.close(resolve))
}
process.exit(0)
