import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { compile, createRenderer, createSSRApp, nextTick, reactive } from "vue"
import { renderToString } from "vue/server-renderer"

global.location = { hash: "", pathname: "/yui-chat", search: "" }
global.localStorage = { getItem: () => null, setItem() {} }
const panelUrl = new URL("../output/runtime/web/client/features/tools/behavior-drawer.js", import.meta.url)
const { BehaviorDrawer } = await import(panelUrl)
const storeImport = (await fs.readFile(panelUrl, "utf8")).match(/from "([^\"]*store\/store\.js[^\"]*)"/)[1]
const { store, confirmState, settleConfirm } = await import(new URL(storeImport, panelUrl))
const { defaults } = await import("../output/runtime/config/defaults.js")
const config = structuredClone(defaults)
const values = { mode: "foreground", timeoutMs: 23000, requiresFinalReply: true, repeatPolicy: "bounded", retryPolicy: "safe", maxAttempts: 3, parallelSafe: true }
const catalog = { ok: true, settings: { tools: {}, customPackages: {}, mcpServers: {} }, tools: ["first", "second"].map(name => ({ name, label: name, source: "custom", loaded: true, parent: { scope: "customPackages", id: "pkg" }, inherited: { ...values }, actions: {lookup: {inherited: {...values}, baseInherited: {...values}, capabilities: {effect: "read", backgroundAvailable: true}}}, capabilities: { effect: "read", backgroundAvailable: true } })) }
const calls = []
let reads = 0
let failSave = false, failRead = false
global.fetch = async (url, options = {}) => {
  if (options.method === "PUT") {
    calls.push(JSON.parse(options.body))
    return { ok: !failSave, status: failSave ? 500 : 200, json: async () => failSave ? { error: "fixture failure" } : { ok: true, config, tools: [], behavior: structuredClone(catalog), skill: {id: "fixture-skill", configSchema: {type: "object", properties: {apiKey: {type: "string", secret: true}, limit: {type: "integer", default: 3}}}, runtimeConfig: {apiKey: "********", limit: 4}} } }
  }
  reads++
  if (failRead) return { ok: false, status: 500, json: async () => ({error: "fixture read failure"}) }
  if (String(url).includes("/api/skills/")) return { ok: true, status: 200, json: async () => ({result: {manifest: {configSchema: {type: "object", properties: {apiKey: {type: "string", secret: true}, limit: {type: "integer", default: 3}}}}, runtimeConfig: {apiKey: "********"}}}) }
  return { ok: true, status: 200, json: async () => structuredClone(catalog) }
}
store.config = config
const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
async function settle(view) {
  for (let i = 0; i < 30 && view.loading.value; i++) await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
  assert.equal(view.loading.value, false)
}
const props = reactive({ open: true, target: { scope: "tools", id: "first" } })
let view, closed = 0
const app = renderer.createApp({ setup() { view = BehaviorDrawer.setup(props, { emit: () => closed++ }); return () => null } })
app.mount({})
try {
  await settle(view)
  assert.equal(view.stage.value, 2)
  assert.equal(view.specificMounted.value, false, "runtime settings are mounted only when first expanded")
  assert.equal(view.inherited.value.timeoutMs, 23000)
  assert.deepEqual(view.values.value, {}, "displayed defaults are not stored as overrides")
  view.runtimeDirty.value = true
  view.change("timeoutMs", 12000)
  await nextTick()
  assert.equal(store.dirtyScopes["tool-behavior"], true)
  await view.save()
  assert.deepEqual(calls.at(-1), { targets: [{ scope: "tools", id: "first" }], edits: [{ action: "", reset: false, changes: { timeoutMs: 12000 } }] })
  assert.equal(view.dirty.value, false)
  assert.equal(view.runtimeDirty.value, true, "saving behavior does not discard the separate runtime draft")
  view.runtimeDirty.value = false
  view.change("maxAttempts", 4)
  failSave = true
  await view.save()
  assert.equal(view.dirty.value, true)
  assert.equal(view.values.value.maxAttempts, 4, "failed saves retain the draft")
  const closing = view.close()
  assert.equal(confirmState.open, true)
  settleConfirm(false)
  await closing
  assert.equal(closed, 0)
  failSave = false
  view.action.value = "lookup"
  view.change("timeoutMs", 4000)
  view.action.value = ""
  view.resetCurrent()
  await nextTick()
  assert.equal(store.dirtyScopes["tool-behavior"], true, "resetting while dirty retains navigation protection")
  view.change("timeoutMs", 33000)
  await view.save()
  assert.equal(calls.at(-1).edits[0].reset, true)
  assert.deepEqual(calls.at(-1).edits, [{action: "", reset: true, changes: {timeoutMs: 33000}}], "whole-tool reset discards earlier unsaved action drafts")
  view.resetCurrent()
  view.action.value = "lookup"
  view.change("timeoutMs", 4500)
  await view.save()
  assert.deepEqual(calls.at(-1).edits, [{action: "", reset: true, changes: {}}, {action: "lookup", reset: false, changes: {timeoutMs: 4500}}], "new action edits made after reset remain valid")
  view.action.value = ""
  view.change("timeoutMs", 19000)
  view.action.value = "lookup"
  view.change("timeoutMs", 5000)
  view.resetCurrent()
  await view.save()
  assert.deepEqual(calls.at(-1).edits, [{action: "", reset: false, changes: {timeoutMs: 19000}}, {action: "lookup", reset: true, changes: {}}], "resetting one action preserves the whole-tool draft")
  props.target = null
  await nextTick(); await settle(view)
  assert.equal(view.stage.value, 1, "batch configuration starts by selecting scope")
  view.toggle("first", true); view.toggle("second", true)
  view.stage.value = 2
  view.change("requiresFinalReply", false)
  view.change("timeoutMs", null)
  const batchSave = view.save()
  assert.equal(confirmState.open, true)
  settleConfirm(true)
  await batchSave
  assert.deepEqual(calls.at(-1).targets, ["first", "second"].map(id => ({scope: "tools", id, owner: {scope: "customPackages", id: "pkg"}})))
  assert.deepEqual(calls.at(-1).edits[0].changes, { requiresFinalReply: false, timeoutMs: null }, "batch mode submits only selected changes")
  assert(!store.dirtyScopes["tool-behavior"])
  failRead = true
  props.target = {scope: "tools", id: "second"}
  await nextTick(); await settle(view)
  assert.equal(view.single.value, undefined, "failed reload cannot display previous tool metadata")
  const failedReadCalls = calls.length
  view.change("timeoutMs", 15000)
  await view.save()
  assert.equal(calls.length, failedReadCalls, "cannot save before reading the target settings")
  failRead = false
  await view.reload()
  assert.equal(view.single.value.name, "second")
  catalog.tools.push({name: "image_media", label: "图片", source: "builtin", loaded: true, inherited: {...values}, actions: {}, capabilities: {effect: "read", backgroundAvailable: true}})
  store.tools = {tools: [{name: "image_media", common: {}, runtimeConfig: {}}]}
  props.target = {scope: "tools", id: "image_media"}
  await nextTick(); await settle(view)
  assert.deepEqual(view.sections.value.map(section => section.id), ["specific", "common", "limits", "advanced"])
  assert.equal(view.activeSection.value, "specific", "tool-specific configuration is the initial page")
  assert.equal(view.specificMounted.value, true)
  view.runtimeDirty.value = true
  view.selectSection("common")
  view.change("timeoutMs", 15000)
  view.selectSection("specific")
  assert.equal(view.specificMounted.value, true, "category switching retains the mounted runtime form")
  assert.equal(view.values.value.timeoutMs, 15000)
  assert.equal(view.runtimeDirty.value, true, "category switching preserves independent drafts")
  props.target = {scope: "skills", id: "fixture-skill"}
  await nextTick(); await settle(view)
  assert(view.skillRows.value.some(row => row.kind === "secret"))
  view.skillDraft.limit = "4"
  const readsBeforeSave = reads
  await view.save()
  assert.equal(reads, readsBeforeSave, "Skill save consumes its masked response without rereading the detail")
  assert.equal(view.skillDraft.apiKey, "********")
  assert(view.skillRows.value.some(row => row.kind === "secret"))
  assert.deepEqual(calls.at(-1), {value: {apiKey: "********", limit: 4}}, "Skill variables reuse the typed form and retain masked credentials")
  assert.equal(view.dirty.value, false)
} finally { app.unmount() }

for (const [file, name] of [["behavior-drawer", "BehaviorDrawer"], ["behavior-fields", "BehaviorFields"], ["behavior-config-button", "BehaviorConfigButton"], ["runtime-variable-fields", "RuntimeVariableFields"], ["global-tool-settings-panel", "GlobalToolSettingsPanel"], ["tool-configuration-panel", "ToolConfigurationPanel"], ["tool-detail-modal", "ToolDetailModal"], ["tools-tab", "ToolsTab"], ["tools-list-panel", "ToolListPanel"], ["extension-library-panel", "ExtensionLibraryPanel"], ["mcp-tools-panel", "McpToolsPanel"], ["mcp-panel", "McpPanel"], ["extension-editor-drawer", "ExtensionEditorDrawer"], ["render-panel", "RenderPanel"]]) {
  const component = (await import(`../output/runtime/web/client/features/tools/${file}.js`))[name]
  compile(component.template, { onError(error) { throw error } })
}
const { ToolConfigurationPanel } = await import("../output/runtime/web/client/features/tools/tool-configuration-panel.js")
let runtimeView
const runtimeApp = renderer.createApp({ setup() { runtimeView = ToolConfigurationPanel.setup({tool: {name: "image_media", common: {}, runtimeConfig: {}}}, {emit() {}, expose() {}}); return () => null } })
runtimeApp.mount({})
assert(!runtimeView.visibleGlobalFields.value.some(field => field.key === "downloadTimeoutMs"))
runtimeView.channelDraft.values.cacheSelectedImages = true
assert(runtimeView.visibleGlobalFields.value.some(field => field.key === "downloadTimeoutMs"))
runtimeApp.unmount()
const { RenderPanel } = await import("../output/runtime/web/client/features/tools/render-panel.js")
const renderEvents = []
let renderView
const renderApp = renderer.createApp({ setup() { renderView = RenderPanel.setup({}, {emit: (...args) => renderEvents.push(args)}); return () => null } })
renderApp.mount({})
renderView.settings.aiEngine = "svg"
await nextTick()
assert(renderEvents.some(([event, value]) => event === "dirty" && value === true), "render settings participate in drawer close protection")
renderApp.unmount()
const { BehaviorFields } = await import("../output/runtime/web/client/features/tools/behavior-fields.js")
async function renderFields(inherited, section) {
  const app = createSSRApp(BehaviorFields, { values: {}, inherited, section, capabilities: [{ effect: "read", backgroundAvailable: true }] })
  app.component("Field", { props: ["label"], template: "<label>{{label}}</label>" })
  return renderToString(app)
}
const foreground = await renderFields(values, "common")
assert(foreground.includes("执行后需要回复") && !foreground.includes("最多尝试次数"))
const limits = await renderFields(values, "limits")
assert(limits.includes("最多尝试次数") && !limits.includes("执行后需要回复"), "each tab renders only its own fields")
const silent = await renderFields({ ...values, mode: "silent", retryPolicy: "none" }, "limits")
assert(!silent.includes("最多尝试次数") && !silent.includes("<label>失败处理</label>"))
assert(!foreground.includes("<details"), "configuration categories no longer require nested disclosure clicks")
const {RuntimeVariableFields} = await import("../output/runtime/web/client/features/tools/runtime-variable-fields.js")
const variablesApp = createSSRApp({components: {RuntimeVariableFields}, data: () => ({rows: [{name: "a", kind: "text", label: "变量一"}, {name: "b", kind: "text", label: "变量二"}], draft: {a: "", b: ""}}), template: '<div class="form-grid"><RuntimeVariableFields :rows="rows" :draft="draft" /></div>'})
variablesApp.component("Field", {props: ["label"], template: '<label>{{label}}</label>'})
const variablesHtml = await renderToString(variablesApp)
assert.equal((variablesHtml.match(/class="form-grid"/g) || []).length, 1, "variable fields reuse the parent grid instead of nesting another grid")
assert(variablesHtml.includes("变量一") && variablesHtml.includes("变量二"))
const modalApp = createSSRApp(BehaviorDrawer, {open: false, target: {scope: "tools", id: "first"}})
modalApp.component("Field", {props: ["label"], template: "<label>{{label}}</label>"})
modalApp.component("Icon", {template: "<span />"})
modalApp.component("SideDrawer", {props: ["modal", "open"], template: '<aside :data-centered="modal"><slot /></aside>'})
assert((await renderToString(modalApp)).includes('data-centered="true"'), "tool configuration uses the same centered popup as tool details")
console.log("ok tool behavior client: default/action resets, sparse saves, failure drafts, filtered prerequisites, centered categories, specific-first layout and shared variable grid")
