import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { compile, createRenderer, createSSRApp, h, inject, nextTick, reactive, ref } from "vue"
import { renderToString } from "vue/server-renderer"

global.location = { hash: "", pathname: "/yui-chat", search: "" }
global.localStorage = { getItem: () => null, setItem() {} }
const panelUrl = new URL("../output/runtime/web/client/features/tools/render-panel.js", import.meta.url)
const { RenderPanel } = await import(panelUrl)
const storeImport = (await fs.readFile(panelUrl, "utf8")).match(/from "([^\"]*store\/store\.js[^\"]*)"/)[1]
const { store, confirmState } = await import(new URL(storeImport, panelUrl))
const { defaults } = await import("../output/runtime/config/defaults.js")
const { BehaviorDrawer } = await import("../output/runtime/web/client/features/tools/behavior-drawer.js")
const { GlobalToolSettingsPanel } = await import("../output/runtime/web/client/features/tools/global-tool-settings-panel.js")
const { ToolConfigurationPanel } = await import("../output/runtime/web/client/features/tools/tool-configuration-panel.js")
const { ToolsTab } = await import("../output/runtime/web/client/features/tools/tools-tab.js")
const { ToolDetailModal } = await import("../output/runtime/web/client/features/tools/tool-detail-modal.js")
const clone = value => JSON.parse(JSON.stringify(value))
const calls = []
let holdPatch = false, releasePatch
const runtimeTool = { name: "runtime_fixture", common: { configSchema: { properties: { apiKey: { type: "string", secret: true }, limit: { type: "integer", default: 3 } } } }, runtimeConfig: { apiKey: "********", limit: 3 } }
global.fetch = async (url, options = {}) => {
  const method = options.method || "GET"
  const body = options.body ? JSON.parse(options.body) : undefined
  calls.push({ url: String(url), method, body })
  if (method === "PATCH") {
    const config = clone(store.config)
    for (const [path, value] of Object.entries(body.patch)) {
      const keys = path.split(".")
      let target = config
      for (const key of keys.slice(0, -1)) target = target[key] ||= {}
      target[keys.at(-1)] = value
    }
    const success = { ok: true, status: 200, json: async () => ({ ok: true, config, changedPaths: Object.keys(body.patch) }) }
    if (holdPatch) return new Promise(resolve => { releasePatch = accepted => resolve(accepted ? success : { ok: false, status: 500, json: async () => ({ error: "fixture save failure" }) }) })
    return success
  }
  if (method === "PUT") {
    const updated = { ...clone(runtimeTool), runtimeConfig: { apiKey: "********", limit: body.value.limit } }
    return { ok: true, status: 200, json: async () => ({ ok: true, config: clone(store.config), tools: [updated] }) }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, tools: [], render: { catalog: [] } }) }
}
const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
store.config = clone(defaults)
let parent, renderView, closed = 0
const guardApp = renderer.createApp({ setup() { parent = BehaviorDrawer.setup({ open: false, target: null }, { emit: () => closed++ }); return () => null } })
guardApp.mount({})
const events = []
const renderApp = renderer.createApp({ setup() {
  renderView = RenderPanel.setup({}, { emit(event, value) {
    events.push([event, value])
    if (event === "saving") parent.renderSaving.value = value
    if (event === "dirty") parent.renderDirty.value = value
  } })
  return () => null
} })
renderApp.mount({})
try {
  await nextTick()
  let before = calls.length
  await renderView.saveSettings()
  assert.equal(calls.length, before, "unchanged rendering settings do not send requests")
  const systemEngine = ref("svg")
  renderView.systemRenderPanel.value = { getPatch: () => ({ "response.render.system.engine": systemEngine.value }) }
  renderView.settings.aiEngine = "svg"
  holdPatch = true
  const pending = renderView.saveSettings()
  assert.equal(renderView.saving.value, true)
  assert.equal(parent.busy.value, true, "child saving state reaches the popup synchronously")
  before = calls.length
  await renderView.saveSettings()
  parent.selectSection("advanced")
  await parent.close()
  await parent.back()
  assert.equal(calls.length, before, "double save does not send a second request")
  assert.equal(parent.activeSection.value, "common")
  assert.equal(closed, 0)
  assert.equal(confirmState.open, false, "saving blocks close without opening another confirmation")
  const snapshotApp = createSSRApp({ ...RenderPanel, setup: () => renderView })
  snapshotApp.component("Panel", { template: '<section><slot name="actions"/><slot/></section>' })
  snapshotApp.component("Field", { props: ["label"], template: '<label>{{label}}<input /></label>' })
  snapshotApp.component("Icon", { template: "<span/>" })
  snapshotApp.component("PillList", { template: "<span/>" })
  snapshotApp.component("SideDrawer", { template: "<span/>" })
  const savingHtml = await renderToString(snapshotApp)
  assert.match(savingHtml, /<fieldset\b[^>]*disabled/, "both tool and system engine inputs inherit the disabled state")
  assert.match(savingHtml, /<button\b[^>]*disabled[^>]*>[^]*?渲染预览/, "opening preview is disabled during save")
  releasePatch(false)
  await pending; await nextTick()
  assert.equal(parent.busy.value, false)
  assert.equal(renderView.saving.value, false)
  assert.equal(renderView.settings.aiEngine, "svg")
  assert.equal(systemEngine.value, "svg")
  assert.equal(renderView.dirty.value, true, "failed saves retain both rendering drafts")
  parent.selectSection("advanced")
  assert.equal(parent.activeSection.value, "advanced")
  before = calls.length
  const retry = renderView.saveSettings()
  releasePatch(true)
  await retry; await nextTick()
  assert.equal(renderView.dirty.value, false)
  assert.deepEqual(calls.slice(before).map(call => call.method), ["PATCH"], "both engine settings share one save with no follow-up GET")
  assert(events.some(([event, value]) => event === "saving" && value === true))
  assert.deepEqual(events.filter(([event]) => event === "saving").at(-1), ["saving", false])
} finally { renderApp.unmount(); guardApp.unmount(); holdPatch = false }

const runtimeProps = reactive({ tool: clone(runtimeTool) })
let runtimeView
const runtimeEvents = []
const runtimeApp = renderer.createApp({ setup() {
  runtimeView = ToolConfigurationPanel.setup(runtimeProps, { emit(event, value) { runtimeEvents.push([event, value]); if (event === "updated") runtimeProps.tool = value }, expose() {} })
  return () => null
} })
runtimeApp.mount({})
try {
  runtimeView.runtimeDraft.apiKey = "new-fixture-key"
  runtimeView.runtimeDraft.limit = "5"
  const before = calls.length
  await runtimeView.saveAll(); await nextTick()
  assert.deepEqual(calls.slice(before).map(call => call.method), ["PUT"], "runtime variables reuse the write response without rereading the tool list")
  assert.equal(runtimeView.runtimeDraft.apiKey, "********")
  assert.equal(runtimeView.runtimeDraft.limit, "5")
  assert.equal(store.tools.tools[0].runtimeConfig.limit, 5)
  assert.deepEqual(runtimeEvents.filter(([event]) => event === "dirty").at(-1), ["dirty", false])
  const after = calls.length
  await runtimeView.saveAll()
  assert.equal(calls.length, after, "saving unchanged normalized runtime values is a no-op")
} finally { runtimeApp.unmount() }

const globalConfig = clone(defaults)
globalConfig.tools.policy.allowMcpTools = false
store.config = globalConfig
let globalView
const globalApp = renderer.createApp({ setup() { globalView = GlobalToolSettingsPanel.setup({ open: true }, { emit() {} }); return () => null } })
globalApp.mount({})
try {
  globalView.draft.maxToolCalls = 21
  globalView.draft.backgroundConcurrent = 6.6
  let before = calls.length
  await globalView.save(); await nextTick()
  assert.equal(confirmState.open, false, "unchanged disabled sources do not cause a confirmation for budget-only saves")
  assert.deepEqual(calls.slice(before).map(call => call.method), ["PATCH"], "budget-only settings do not refresh the tool catalog")
  assert.equal(globalView.draft.backgroundConcurrent, 7, "normalize from the save response")
  assert.equal(globalView.isDirty(), false)
  globalView.draft.allowMcpTools = "true"
  before = calls.length
  await globalView.save(); await nextTick()
  assert.deepEqual(calls.slice(before).map(call => [call.method, call.url]), [["PATCH", "/yui-chat/api/config"], ["GET", "/yui-chat/api/tools"]], "visibility changes refresh only the affected catalog once")
  before = calls.length
  await globalView.save()
  assert.equal(calls.length, before)
} finally { globalApp.unmount() }

// 挂载真实外层页面及配置子组件，覆盖注入、事件与列表写回触发的间接请求。
global.HTMLElement = class {}
const pageRenderer = createRenderer({ createElement: () => ({ style: {}, closest: () => null }), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
const empty = { render: () => null }
const popup = { props: ["open"], setup(props, { slots }) { return () => props.open ? h("section", [slots.default?.(), slots.actions?.()]) : null } }
let page, behavior, detail, pageRender, pageRuntime, reloadAccess
let failMatrix = false, holdMatrix = false, releaseMatrix
let pageTools = [
  { ...clone(runtimeTool), enabled: true, common: { ...clone(runtimeTool.common), source: "builtin", policy: {}, provenance: {} } },
  { name: "render_image", enabled: true, common: { source: "builtin", policy: {}, provenance: {} } },
]
const behaviorCatalog = () => ({ tools: pageTools.map(tool => ({ name: tool.name, label: tool.name, source: "builtin", inherited: {}, actions: {}, capabilities: { effect: "read", backgroundAvailable: true } })), settings: {} })
const previousFetch = global.fetch
global.fetch = async (url, options = {}) => {
  const path = String(url), method = options.method || "GET"
  if (method === "PATCH") return previousFetch(url, options)
  calls.push({ url: path, method })
  const response = body => ({ ok: true, status: 200, json: async () => body })
  if (path.endsWith("/access-matrix")) {
    if (holdMatrix) return new Promise(resolve => { releaseMatrix = () => resolve(response({ matrix: { rows: [] } })) })
    return failMatrix ? { ok: false, status: 500, json: async () => ({ error: "fixture matrix failure" }) } : response({ matrix: { rows: [] } })
  }
  if (path.endsWith("/behavior")) {
    if (method === "PUT") pageTools = pageTools.map(tool => ({ ...tool, common: { ...tool.common, execution: { timeoutMs: 45000 } } }))
    return response({ ...behaviorCatalog(), behavior: behaviorCatalog(), ...(method === "PUT" ? { tools: clone(pageTools), config: clone(store.config) } : {}) })
  }
  if (method === "PUT") {
    const value = JSON.parse(options.body).value
    pageTools = pageTools.map(tool => tool.name === runtimeTool.name ? { ...tool, runtimeConfig: { ...value, apiKey: "********" } } : tool)
    return response({ config: clone(store.config), tools: clone(pageTools) })
  }
  return response({ render: { catalog: [] } })
}
store.config = clone(defaults)
store.tools = { tools: clone(pageTools) }
store.activeTab = "tools"
const pageApp = pageRenderer.createApp({
  ...ToolsTab,
  components: {
    ...ToolsTab.components,
    ToolListPanel: { setup() { reloadAccess = inject("reloadCapabilityAccess"); return () => null } },
    GlobalToolSettingsPanel: empty,
    BehaviorConfigButton: empty,
    BehaviorDrawer: {
      ...BehaviorDrawer,
      setup(props, context) { behavior = BehaviorDrawer.setup(props, context); return behavior },
      components: {
        ...BehaviorDrawer.components,
        BehaviorFields: empty,
        RenderPanel: { ...RenderPanel, setup(props, context) { pageRender = RenderPanel.setup(props, context); return pageRender } },
        ToolConfigurationPanel: { ...ToolConfigurationPanel, setup(props, context) { pageRuntime = ToolConfigurationPanel.setup(props, context); return pageRuntime } },
      },
    },
    ToolDetailModal: { ...ToolDetailModal, setup(props, context) { detail = ToolDetailModal.setup(props, context); return detail } },
  },
  setup(...args) { page = ToolsTab.setup(...args); return page },
})
pageApp.component("SideDrawer", popup)
pageApp.component("Panel", { setup(_props, { slots }) { return () => h("section", [slots.actions?.(), slots.default?.()]) } })
for (const name of ["Icon", "Field", "Switch", "PillList", "JsonBlock"]) pageApp.component(name, empty)
const flushPage = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick() }
const matrixCalls = start => calls.slice(start).filter(call => call.url.endsWith("/access-matrix"))
pageApp.mount({})
try {
  await flushPage()
  await page.openToolDetail({ name: runtimeTool.name, action: "config" }); await flushPage()
  assert.equal(page.behaviorOpen.value, true)
  assert.equal(page.showToolDetail.value, false)
  pageRuntime.runtimeDraft.apiKey = "fixture-new-secret"
  pageRuntime.runtimeDraft.limit = "8"
  let before = calls.length
  await pageRuntime.saveAll(); await flushPage()
  assert.deepEqual(calls.slice(before).map(call => call.method), ["PUT"], "runtime save remains one request with the real outer page mounted")
  assert.equal(pageRuntime.runtimeDraft.apiKey, "********")
  assert.equal(behavior.runtimeDirty.value, false)
  behavior.change("timeoutMs", 45000)
  before = calls.length
  await behavior.save(); await flushPage()
  assert.deepEqual(calls.slice(before).map(call => call.method), ["PUT"], "execution changes do not query permissions")

  before = calls.length
  store.tools = clone(store.tools)
  store.config = clone(store.config)
  store.sliceLoading.tools = true; await flushPage()
  store.sliceLoading.tools = false; await flushPage()
  assert.equal(matrixCalls(before).length, 0, "an unchanged catalog/config refresh does not query permissions")
  const budgetConfig = clone(store.config)
  budgetConfig.chat.execution.maxToolCalls++
  store.config = budgetConfig; await flushPage()
  assert.equal(matrixCalls(before).length, 0, "budget updates do not query permissions")

  for (const update of [
    () => { store.tools = { tools: [...store.tools.tools, { name: "new_fixture", enabled: true, common: { source: "builtin" } }] } },
    () => { store.tools.tools[0].enabled = false },
    () => { store.tools.tools[0].common.policy.requiresMaster = true },
    () => { const config = clone(store.config); config.tools.policy.allowExternalNetwork = false; store.config = config },
    () => { const config = clone(store.config); config.tools.boundaryAccess.roles.user.allowedTools.push(runtimeTool.name); store.config = config },
    () => { const config = clone(store.config); config.tools.runtimeVariables.persona_punish = { enabled: true }; store.config = config },
  ]) {
    before = calls.length
    update(); await flushPage(); await reloadAccess(); await flushPage()
    assert.equal(matrixCalls(before).length, 1, "actual catalog, enablement or policy changes query once, including an explicit reload")
  }
  holdMatrix = true
  before = calls.length
  store.tools.tools[0].enabled = true; await flushPage()
  let finished = false
  const duplicate = reloadAccess().then(() => { finished = true })
  await nextTick()
  assert.equal(finished, false, "explicit reload waits for the shared in-flight request")
  assert.equal(matrixCalls(before).length, 1)
  releaseMatrix(); await duplicate; holdMatrix = false
  failMatrix = true
  before = calls.length
  store.tools.tools[0].enabled = false; await flushPage()
  failMatrix = false
  await reloadAccess(); await flushPage()
  assert.equal(matrixCalls(before).length, 2, "a failed query can retry with unchanged inputs")

  await behavior.close(); await flushPage()
  await page.openToolDetail({ name: "render_image" }); await flushPage()
  assert.equal(page.showToolDetail.value, true)
  assert.deepEqual(detail.tabs.value.map(tab => tab.id), ["overview", "configuration", "source"], "details have no duplicate rendering form")
  detail.selectTab("configuration"); await flushPage()
  assert.equal(page.showToolDetail.value, false, "the real detail close event closes the details")
  assert.equal(page.behaviorOpen.value, true)
  assert.deepEqual(page.behaviorTarget.value, { scope: "tools", id: "render_image" })
  assert.equal(behavior.activeSection.value, "specific")
  pageRender.settings.aiEngine = "svg"
  holdPatch = true
  let pending = pageRender.saveSettings()
  assert.equal(behavior.busy.value, true, "the mounted rendering child locks the outer popup")
  behavior.selectSection("advanced"); await behavior.close(); await flushPage()
  assert.equal(page.behaviorOpen.value, true)
  assert.equal(behavior.activeSection.value, "specific")
  releasePatch(false); await pending; await flushPage()
  assert.equal(pageRender.saving.value, false)
  assert.equal(pageRender.settings.aiEngine, "svg")
  const retainedRender = pageRender
  behavior.selectSection("advanced"); await flushPage()
  behavior.selectSection("specific"); await flushPage()
  assert.equal(pageRender, retainedRender, "switching categories retains the failed rendering draft")
  before = calls.length
  pending = pageRender.saveSettings(); releasePatch(true); await pending; await flushPage()
  assert.deepEqual(calls.slice(before).map(call => call.method), ["PATCH"], "render retry has no permission or list follow-up request")
  assert.equal(behavior.renderDirty.value, false)
  await behavior.close(); await flushPage()
  assert.equal(page.behaviorOpen.value, false)
} finally { pageApp.unmount(); global.fetch = previousFetch; holdPatch = false }
compile(RenderPanel.template, { onError(error) { throw error } })
console.log("ok tool saves: rendering save lock, failed drafts, unified entry, mounted outer-page request counts, permission change/dedup/retry, conditional catalog refresh and no-op saves")
