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
const { store, confirmState, settleConfirm, hasUnsavedChanges, loadInitial, refreshSlices, refreshTab, applyConfigResponse } = await import(new URL(storeImport, panelUrl))
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
  if (String(url).endsWith("/api/memory/capture-defaults")) return { ok: true, status: 200, json: async () => ({ capture: { defaultPromptTemplate: "fixture extraction prompt" } }) }
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
// First paint only needs configuration and diagnostics; overlapping refreshes share a request.
const entered = apiCalls.length
await loadInitial("advanced")
assert.deepEqual(apiCalls.slice(entered).map(call => call.url.replace(/^\/yui-chat/, "")).sort(), ["/api/config", "/api/diagnostics"])
const concurrent = apiCalls.length
await Promise.all([refreshSlices(["config"]), refreshSlices(["config"])])
assert.equal(apiCalls.length - concurrent, 1)

const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
let state
const langfuseProps = reactive({ section: "sampling" })
const mounted = renderer.createApp({ setup() { state = LangfusePanel.setup(langfuseProps); return () => null } })
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
  const savingCalls = apiCalls.length
  await state.save()
  await nextTick()
  assert.deepEqual(apiCalls.slice(savingCalls).map(call => call.method), ["PATCH"], "saving must reuse the response without page-wide GET refreshes")
  assert(!Object.hasOwn(patches.at(-1), "logging.langfuse.baseUrl"), "sampling does not resubmit connection settings")
  assert.equal(patches.at(-1)["logging.langfuse.sampleRate"], 0.5)
  assert(!Object.hasOwn(patches.at(-1), "logging.langfuse.publicKey"))
  assert(!Object.hasOwn(patches.at(-1), "logging.langfuse.secretKey"))
  assert.equal(state.dirty.value, false)
  state.draft.monthlyUnitLimit = 41000
  langfuseProps.section = "connection"
  state.draft.baseUrl = " http://127.0.0.1:3000/telemetry/ "
  await state.save()
  await nextTick()
  assert.equal(patches.at(-1)["logging.langfuse.baseUrl"], "http://127.0.0.1:3000/telemetry/", "custom deployment URL is editable and trimmed")
  assert.equal(state.draft.baseUrl, "http://127.0.0.1:3000/telemetry/")
  assert.equal(state.draft.monthlyUnitLimit, 41000, "saving connection preserves another subsection's draft")
  assert(!Object.hasOwn(patches.at(-1), "logging.langfuse.monthlyUnitLimit"))
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
  assert.equal(store.dirtyScopes["system:langfuse"], true)
  langfuseProps.section = "sampling"
  await state.save()
  await nextTick()
  assert.equal(store.dirtyScopes["system:langfuse"], undefined)
  const unchangedCalls = apiCalls.length
  await state.save()
  assert.equal(apiCalls.length, unchangedCalls, "unchanged settings do not issue requests")
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
  page.draft.captureRetentionDays = 5
  page.selectSection("memory-capture", "extraction")
  await page.saveCaptureDefaults()
  await settleUi()
  assert(!Object.hasOwn(patches.at(-1), "memory.groupCapture.defaultRetentionDays"))
  assert.equal(page.draft.captureRetentionDays, 5)
  assert.equal(patches.at(-1)["memory.groupCapture.defaultTokenLimit"], 12000)
  assert.equal(page.isDirty("memory-capture"), true)
  page.selectSection("memory-capture", "retention")
  await page.saveCaptureDefaults()
  page.draft.captureRetentionDays = 0
  await page.saveCaptureDefaults()
  assert.equal(patches.at(-1)["memory.groupCapture.defaultRetentionDays"], 0)
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
  assert(!Object.hasOwn(patches.at(-1), "response.render.system.engine"))
  assert.equal(patches.at(-1)["logging.level"], "debug")
  assert.equal(page.isDirty("developer"), true)
  page.selectSection("developer", "render")
  await page.saveDeveloperSettings()
  assert.deepEqual(patches.at(-1), { "response.render.system.engine": "svg" })
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

// A save retains its original target even when another subsection becomes active before the response.
store.systemSettingsSection = "memory-capture/extraction"
store.developerMode = true
let switchingPage
const switchingApp = renderer.createApp({ setup() { switchingPage = AdvancedTab.setup(); return () => null } })
switchingApp.mount({})
await settleUi()
async function saveWhileSwitching(save, switchSection) {
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const began = new Promise(resolve => { started = resolve })
  global.fetch = async (url, options) => {
    const response = responseFor(url, options)
    if (options?.method === "PATCH") { started(); await gate }
    return response
  }
  const saving = save()
  try { await began; switchSection(); await settleUi() }
  finally { release(); await saving; global.fetch = async (url, options) => responseFor(url, options) }
  await settleUi()
}
try {
  switchingPage.selectSection("memory-capture", "retention")
  switchingPage.draft.captureRetentionDays = 9
  switchingPage.selectSection("memory-capture", "extraction")
  switchingPage.draft.captureTokenLimit = 13000
  await saveWhileSwitching(() => switchingPage.saveCaptureDefaults(), () => switchingPage.selectSection("memory-capture", "retention"))
  assert.equal(saved.memory.groupCapture.defaultTokenLimit, 13000)
  assert.equal(switchingPage.draft.captureRetentionDays, 9)
  assert.equal(switchingPage.isDirty("memory-retention"), true)
  assert.equal(switchingPage.isDirty("memory-extraction"), false)
  assert.deepEqual(patches.at(-1), { "memory.groupCapture.defaultTokenLimit": 13000 })

  switchingPage.selectSection("developer", "logs")
  switchingPage.draft.loggingLevel = "warn"
  switchingPage.systemRenderPanel.value = { getPatch: () => ({ "response.render.system.engine": "html" }) }
  await saveWhileSwitching(() => switchingPage.saveDeveloperSettings(), () => switchingPage.selectSection("developer", "render"))
  assert.equal(saved.logging.level, "warn")
  assert.equal(switchingPage.isDirty("developer-render"), true, "a logs save must not mark the pending render draft as saved")
  assert.equal(switchingPage.isDirty("developer-logs"), false)
  assert.deepEqual(patches.at(-1), { "logging.level": "warn" })

  switchingPage.selectSection("link-safety", "screenshot")
  switchingPage.draft.linkScreenshotAllowedHosts = "pending.example"
  switchingPage.selectSection("link-safety", "network")
  switchingPage.draft.linkAllowPrivateHosts = false
  switchingPage.draft.linkTrustedPrivateDnsBypass = false
  await saveWhileSwitching(() => switchingPage.saveLinkSafety(), () => switchingPage.selectSection("link-safety", "screenshot"))
  assert.equal(switchingPage.draft.linkScreenshotAllowedHosts, "pending.example")
  assert.equal(switchingPage.isDirty("link-screenshot"), true)
  assert.equal(switchingPage.isDirty("link-network"), false)
  assert(Object.keys(patches.at(-1)).every(key => !key.includes("screenshot")))
} finally { switchingApp.unmount(); global.fetch = nativeFetch }

global.fetch = async (url, options) => responseFor(url, options)
const { PersonaTab } = await import("../output/runtime/web/client/features/persona/persona-tab.js")
let persona
const personaApp = renderer.createApp({ setup() { persona = PersonaTab.setup(); return () => null } })
personaApp.mount({})
try {
  persona.draft.personaFirstPerson = "fixture-persona"
  persona.draft.ttsVoice = "pending-voice"
  const calls = apiCalls.length
  await persona.save()
  await settleUi()
  assert.deepEqual(patches.at(-1), { "persona.firstPerson": "fixture-persona" })
  assert.deepEqual(apiCalls.slice(calls).map(call => call.method), ["PATCH"])
  assert.equal(persona.draft.ttsVoice, "pending-voice")
  assert.equal(persona.isDirty.value, true)
  persona.activeSection.value = "advanced"
  persona.interactionMenu.value = "reply"
  persona.replyMenu.value = "voice"
  await persona.save()
  await settleUi()
  assert.deepEqual(patches.at(-1), { "response.tts.voice": "pending-voice" })
  assert.equal(persona.isDirty.value, false)
  persona.activeSection.value = "basic"
  persona.draft.personaAliases = "alpha,beta"
  await persona.save()
  await settleUi()
  assert.equal(persona.draft.personaAliases, "alpha, beta")
  assert.equal(persona.isDirty.value, false, "saved aliases adopt the normalized baseline")
  const normalizedCalls = apiCalls.length
  await persona.save()
  assert.equal(apiCalls.length, normalizedCalls)
  persona.draft.personaAliases = "alpha,  beta"
  await persona.save()
  assert.equal(apiCalls.length, normalizedCalls, "format-only edits normalize without a request")
  assert.equal(persona.isDirty.value, false)
  const savedFetch = global.fetch
  let releaseSave, saveStarted
  const saveGate = new Promise(resolve => { releaseSave = resolve })
  const started = new Promise(resolve => { saveStarted = resolve })
  global.fetch = async (url, options) => {
    const response = responseFor(url, options)
    if (options?.method === "PATCH") { saveStarted(); await saveGate }
    return response
  }
  persona.draft.personaFirstPerson = "submitted-name"
  const pendingSave = persona.save()
  await started
  persona.draft.personaFirstPerson = "newer-draft"
  persona.draft.ttsVoice = "another-pending-voice"
  releaseSave()
  await pendingSave
  await settleUi()
  assert.equal(persona.draft.personaFirstPerson, "newer-draft", "a save response preserves input typed while saving")
  assert.equal(persona.draft.ttsVoice, "another-pending-voice")
  assert.equal(persona.isDirty.value, true)
  global.fetch = savedFetch
} finally { personaApp.unmount(); global.fetch = nativeFetch; delete store.dirtyScopes["tab:persona"] }

// A provider edit consumes its own response, with no config/provider re-fetch.
global.fetch = async (url, options) => {
  apiCalls.push({ url: String(url), method: options?.method || "GET", body: options?.body ? JSON.parse(options.body) : null })
  return { ok: true, status: 200, json: async () => ({ ok: true, config: { ...structuredClone(saved), apiProviders: [{ name: "fixture-provider", baseURL: "https://new.example" }] }, diagnostics: { channels: [{ id: "fixture-model", provider: "fixture-provider" }] } }) }
}
const { ProviderEditor } = await import("../output/runtime/web/client/features/providers/provider-editors.js")
let provider
const providerApp = renderer.createApp({ setup() { provider = ProviderEditor.setup({ provider: { name: "fixture-provider", baseURL: "https://old.example" } }, { emit() {} }); return () => null } })
providerApp.mount({})
try {
  const unchanged = apiCalls.length
  await provider.save()
  assert.equal(apiCalls.length, unchanged)
  provider.draft.baseURL = "https://new.example"
  const calls = apiCalls.length
  await provider.save()
  assert.deepEqual(apiCalls.slice(calls).map(call => call.method), ["PATCH"])
  assert.deepEqual(apiCalls.at(-1).body, { baseURL: "https://new.example" })
  assert.equal(store.providers.channels[0].id, "fixture-model")
  const { ModelEditor } = await import("../output/runtime/web/client/features/providers/provider-editors.js")
  let model
  const modelApp = renderer.createApp({ setup() { model = ModelEditor.setup({ model: { name: "embedding-fixture", modelIdentifier: "embedding-fixture", purpose: "embedding", adapter: "embeddings", capabilities: { chat: false, embedding: true } } }, { emit() {} }); return () => null } })
  modelApp.mount({})
  await settleUi()
  const unchangedModel = apiCalls.length
  await model.save()
  assert.equal(apiCalls.length, unchangedModel)
  model.draft.priceIn = 3
  await model.save()
  assert.deepEqual(apiCalls.at(-1).body, { priceIn: 3 }, "editing one model field must preserve inherited defaults and untouched parameters")
  modelApp.unmount()
} finally { providerApp.unmount(); global.fetch = nativeFetch; store.config = structuredClone(saved) }

// The tools entry waits for its catalog before one shared matrix read, with no duplicate during hydration.
let matrixReads = 0
global.fetch = async () => { matrixReads++; return { ok: true, status: 200, json: async () => ({ matrix: { roles: [], rows: [] } }) } }
store.tools = null
store.sliceLoading.tools = true
const { ToolsTab } = await import("../output/runtime/web/client/features/tools/tools-tab.js")
const toolsApp = renderer.createApp({ setup() { ToolsTab.setup(); return () => null } })
toolsApp.mount({})
await settleUi()
assert.equal(matrixReads, 0)
store.tools = { tools: [] }
await settleUi()
assert.equal(matrixReads, 0)
store.sliceLoading.tools = false
await settleUi()
assert.equal(matrixReads, 1)
store.config = structuredClone(saved)
await settleUi()
assert.equal(matrixReads, 1, "unrelated configuration updates must not reload the tool access matrix")
toolsApp.unmount()
global.fetch = nativeFetch

// Both filter panels share the entry loader's reads rather than re-fetching on mount.
const filterReads = []
let filterVersion = 1, filterGate = null, submittedFilters
const filterResponse = () => ({ filtering: { enabled: true, filters: [{ id: `rule-${filterVersion}`, name: "fixture", enabled: true, stage: "output", priority: 0, implementation: { type: "filter", id: "fixture", arguments: {} } }] }, implementations: [{ id: "fixture", source: "builtin", stages: ["output"], parameters: { type: "object", properties: {} } }], stages: [], templates: [] })
global.fetch = async (url, options = {}) => {
  filterReads.push(String(url))
  if (String(url).endsWith("/message-filters") && filterGate) await filterGate
  const response = String(url).endsWith("/custom-filters") ? { custom: { catalog: [{ id: `custom-${filterVersion}` }] }, implementations: [] }
    : filterResponse()
  if (options.method === "PUT") { submittedFilters = JSON.parse(options.body); response.filtering = submittedFilters }
  return { ok: true, status: 200, json: async () => response }
}
store.filters = null
const initialFilters = refreshSlices(["filters"])
const { MessageFiltersPanel } = await import("../output/runtime/web/client/features/filters/message-filters-panel.js")
const { CustomFiltersPanel } = await import("../output/runtime/web/client/features/filters/custom-panel.js")
const filtersApp = renderer.createApp({ setup() { MessageFiltersPanel.setup({}, { emit() {} }); CustomFiltersPanel.setup({}); return () => null } })
filtersApp.mount({})
await initialFilters
await settleUi()
assert.deepEqual(filterReads.map(url => url.replace(/^\/yui-chat/, "")).sort(), ["/api/custom-filters", "/api/message-filters"])
filtersApp.unmount()
filterVersion = 2
let releaseFilters
filterGate = new Promise(resolve => { releaseFilters = resolve })
const reentryRead = refreshSlices(["filters"])
let rulesPanel, customPanel
const cachedFiltersApp = renderer.createApp({ setup() { rulesPanel = MessageFiltersPanel.setup({}, { emit() {} }); customPanel = CustomFiltersPanel.setup({}); return () => null } })
cachedFiltersApp.mount({})
await settleUi()
assert.equal(rulesPanel.loading.value, true, "cached entry waits for the already running refresh")
releaseFilters()
await reentryRead
await settleUi()
assert.equal(rulesPanel.filters.value[0].id, "rule-2")
assert.equal(customPanel.catalog.value[0].id, "custom-2")
filterGate = null
filterVersion = 3
await refreshSlices(["filters"])
await settleUi()
assert.equal(rulesPanel.filters.value[0].id, "rule-3", "a refresh updates the mounted rule chain")
assert.equal(customPanel.catalog.value[0].id, "custom-3")
await rulesPanel.toggleFilter(0, false)
assert.equal(submittedFilters.filters[0].id, "rule-3", "saving uses the refreshed chain rather than an old snapshot")
assert.equal(store.filters.custom.catalog[0].id, "custom-3", "rule writes preserve the shared Custom catalog")
rulesPanel.editFilter(rulesPanel.filters.value[0], 0)
rulesPanel.editor.name = "edited-rule"
store.filters = { ...store.filters, filtering: { enabled: true, filters: [{ ...rulesPanel.filters.value[0], id: "inserted-rule" }, rulesPanel.filters.value[0]] } }
await settleUi()
await rulesPanel.saveFilter()
assert.deepEqual(submittedFilters.filters.map(rule => rule.id), ["inserted-rule", "rule-3"], "refreshing order during editing must not replace a different rule")
assert.equal(submittedFilters.filters[1].name, "edited-rule")
cachedFiltersApp.unmount()
global.fetch = nativeFetch

// Header refresh includes visible lazy panels, and removes their dependencies on unmount/navigation.
const lazyReads = []
let runVersion = 1, mcpEnabledFixture = false, mcpGate = null, failMcpToggle = false
global.fetch = async (url, options = {}) => {
  lazyReads.push(String(url).replace(/^\/yui-chat/, ""))
  if (options.method === "PATCH") {
    if (failMcpToggle) throw new Error("fixture MCP toggle failed")
    mcpEnabledFixture = saved.mcp.enabled = JSON.parse(options.body).patch["mcp.enabled"]
  }
  if (String(url).endsWith("/api/mcp") && mcpGate) await mcpGate
  const response = String(url).endsWith("/subagent/runs") ? { runs: [{ task: `run-${runVersion}` }] }
    : String(url).endsWith("/api/mcp") ? { config: { enabled: mcpEnabledFixture, servers: { [`server-${runVersion}`]: { enabled: false } } } }
      : { config: structuredClone(saved), tools: [], channels: [] }
  return { ok: true, status: 200, json: async () => response }
}
store.activeTab = "providers"
const { ModelRoutingBuilder } = await import("../output/runtime/web/client/features/providers/provider-routing.js")
let subAgent
const subApp = renderer.createApp({ setup() { subAgent = ModelRoutingBuilder.components.SubAgentConfig.setup({ cfg: saved }); return () => null } })
subApp.mount({})
await settleUi()
lazyReads.length = 0
runVersion = 2
await refreshTab()
assert.deepEqual(lazyReads.sort(), ["/api/config", "/api/providers", "/api/subagent/runs"])
assert.equal(subAgent.runs.value[0].task, "run-2")
store.activeTab = "tools"
lazyReads.length = 0
await refreshTab()
assert.deepEqual(lazyReads.sort(), ["/api/config", "/api/tools"], "navigation does not refresh a previous page's lazy panels")
subApp.unmount()
const { McpPanel } = await import("../output/runtime/web/client/features/tools/mcp-panel.js")
let mcpPanel
store.mcp = { config: { enabled: false, servers: {} } }
const enabledConfig = structuredClone(saved)
enabledConfig.mcp.enabled = true
applyConfigResponse({ config: enabledConfig })
mcpEnabledFixture = true
let releaseMcp
mcpGate = new Promise(resolve => { releaseMcp = resolve })
const mcpApp = renderer.createApp({ setup() { mcpPanel = McpPanel.setup(); return () => null } })
mcpApp.mount({})
assert.equal(mcpPanel.draft.mcpEnabled, "false", "the old cache exists before the remote response")
releaseMcp()
await settleUi()
assert.equal(mcpPanel.draft.mcpEnabled, "true", "the async MCP response updates the displayed switch")
mcpGate = null
lazyReads.length = 0
runVersion = 3
mcpEnabledFixture = false
await refreshTab()
await settleUi()
assert.deepEqual(lazyReads.sort(), ["/api/config", "/api/mcp", "/api/tools"])
assert.equal(mcpPanel.serverList.value[0].id, "server-3")
assert.equal(mcpPanel.draft.mcpEnabled, "false", "header refresh also synchronizes the switch")
failMcpToggle = true
await mcpPanel.toggleGlobal(true)
assert.equal(mcpPanel.draft.mcpEnabled, "false", "failed saves restore the displayed switch")
failMcpToggle = false
await mcpPanel.toggleGlobal(true)
await settleUi()
assert.equal(mcpPanel.draft.mcpEnabled, "true")
const readsBeforeCancel = lazyReads.length
const cancelToggle = mcpPanel.toggleGlobal(false)
settleConfirm(false)
await cancelToggle
assert.equal(lazyReads.length, readsBeforeCancel)
assert.equal(mcpPanel.draft.mcpEnabled, "true", "canceling a disable preserves the saved switch")
mcpApp.unmount()
lazyReads.length = 0
await refreshTab()
assert.deepEqual(lazyReads.sort(), ["/api/config", "/api/tools"], "closed lazy panels no longer add header requests")
global.fetch = nativeFetch
store.activeTab = "advanced"

// Skill runtime settings and source are separate writes; saving one must not rewrite the other.
global.window = { addEventListener() {}, removeEventListener() {} }
const skillFixture = { id: "scope-skill", manifest: { id: "scope-skill", name: "scope-skill", description: "fixture", enabled: false }, source: "# Fixture", runtimeConfig: { limit: 1 } }
const skillWrites = []
global.fetch = async (url, options = {}) => {
  if (options.method === "PUT") {
    skillWrites.push(String(url))
    const body = JSON.parse(options.body)
    if (String(url).endsWith("/runtime-config")) skillFixture.runtimeConfig = body.value
    else { skillFixture.manifest = body.manifest; skillFixture.source = body.source }
  }
  return { ok: true, status: 200, json: async () => String(url).includes("/api/skills/") ? { result: structuredClone(skillFixture) } : { tools: [] } }
}
const { ExtensionPanel } = await import("../output/runtime/web/client/features/tools/extension-panel.js")
let extension
const extensionApp = renderer.createApp({ setup() { extension = ExtensionPanel.setup(); return () => null } })
extensionApp.mount({})
try {
  await extension.openSkill("scope-skill", "edit")
  assert.equal(extension.editor.id, "scope-skill")
  await extension.saveEditor()
  assert.deepEqual(skillWrites, [])
  extension.editor.runtimeConfigText = '{"limit":2}'
  await extension.saveEditor()
  assert.deepEqual(skillWrites.map(url => url.replace(/^\/yui-chat/, "")), ["/api/skills/scope-skill/runtime-config"])
  await extension.openSkill("scope-skill", "edit")
  extension.editor.source += "\nupdated"
  skillWrites.length = 0
  await extension.saveEditor()
  assert.deepEqual(skillWrites.map(url => url.replace(/^\/yui-chat/, "")), ["/api/skills/scope-skill"])
} finally { extensionApp.unmount(); delete global.window; global.fetch = nativeFetch }

// Unrelated config refreshes must not reset a tool's pending credentials or execution limits.
const { ToolConfigurationPanel } = await import("../output/runtime/web/client/features/tools/tool-configuration-panel.js")
const { GlobalToolSettingsPanel } = await import("../output/runtime/web/client/features/tools/global-tool-settings-panel.js")
let toolConfig, globalTools, saveTool
const toolConfigApp = renderer.createApp({ setup() {
  toolConfig = ToolConfigurationPanel.setup({ tool: { name: "custom-fixture", common: { configSchema: { type: "object", properties: { apiKey: { type: "string", default: "" } } } }, runtimeConfig: { apiKey: "********" } } }, { emit() {}, expose(actions) { saveTool = actions.saveAll } })
  globalTools = GlobalToolSettingsPanel.setup({ open: true }, { emit() {} })
  return () => null
} })
toolConfigApp.mount({})
let unchangedToolCalls = 0
global.fetch = async () => { unchangedToolCalls++; throw Error("unchanged tool must not make a request") }
await saveTool()
assert.equal(unchangedToolCalls, 0)
global.fetch = nativeFetch
toolConfig.runtimeDraft.apiKey = "pending-fixture-key"
globalTools.draft.maxToolCalls = 77
store.config = { ...structuredClone(saved), logging: { ...saved.logging, level: "warn" } }
await settleUi()
assert.equal(toolConfig.runtimeDraft.apiKey, "pending-fixture-key")
assert.equal(globalTools.draft.maxToolCalls, 77)
toolConfigApp.unmount()

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
