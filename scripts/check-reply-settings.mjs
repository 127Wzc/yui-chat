import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createRenderer, createSSRApp } from "vue"
import { renderToString } from "vue/server-renderer"
import { defaults } from "../output/runtime/config/defaults.js"
import { schemaManifest } from "../output/runtime/config/schema.js"
import { validateConfig } from "../output/runtime/config/validator.js"
import { buildResponsesRequest } from "../output/runtime/models/adapters/openai/responses/request-adapter.js"

globalThis.location = { hash: "", pathname: "/yui-chat", search: "" }
globalThis.localStorage = { getItem: () => null }
const routingUrl = new URL("../output/runtime/web/client/features/providers/provider-routing.js", import.meta.url)
const { ModelRoutingBuilder } = await import(routingUrl)
const storeImport = (await fs.readFile(routingUrl, "utf8")).match(/from "([^\"]*store\/store\.js[^\"]*)"/)[1]
const { store, confirmState, settleConfirm } = await import(new URL(storeImport, routingUrl))
const { components } = await import("../output/runtime/web/client/ui/components.js")
assert.equal(defaults.modelTasks.replyer.maxTokens, 10000)
assert(schemaManifest.sections.some(section => section.fields.some(field => field.path === "modelTasks.replyer.maxTokens")))
for (const value of [0, -1, 1.5, 65537, Number.NaN]) {
  const config = structuredClone(defaults)
  config.modelTasks.replyer.maxTokens = value
  assert.equal(validateConfig(config).ok, false, `invalid output budget ${value}`)
}
for (const value of [1, 10000, 65536]) {
  const config = structuredClone(defaults)
  config.modelTasks.replyer.maxTokens = value
  assert.equal(validateConfig(config).ok, true, `valid output budget ${value}`)
}

const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null,
})
function mount(config) {
  let view
  const app = renderer.createApp({ setup() {
    view = ModelRoutingBuilder.setup({ cfg: config, modelNames: ["mock"], compact: false })
    return () => null
  } })
  app.mount({})
  return { view, unmount: () => app.unmount() }
}
const inherited = structuredClone(defaults)
delete inherited.modelTasks.replyer.maxTokens
const fallback = mount(inherited)
assert.equal(fallback.view.draft.replyerMaxTokens, 10000)
fallback.unmount()

const requests = []
let savedConfig = structuredClone(defaults)
savedConfig.modelTasks.replyer.maxTokens = 1024
let failSave = false
globalThis.fetch = async (url, options = {}) => {
  if (options.method === "PATCH") {
    requests.push(JSON.parse(options.body).patch)
    if (failSave) return { ok: false, status: 500, json: async () => ({ error: "fixture save failure" }) }
    for (const [key, value] of Object.entries(requests.at(-1))) {
      const parts = key.split(".")
      const leaf = parts.pop()
      let target = savedConfig
      for (const part of parts) target = target[part] ||= {}
      target[leaf] = value
    }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, config: structuredClone(savedConfig) }) }
}
store.activeTab = "providers"
const { view, unmount } = mount(structuredClone(savedConfig))
try {
  assert.equal(view.draft.replyerMaxTokens, 1024, "explicit limits are shown without changing them")
  view.showDrawer.value = true
  view.draft.replyerMaxTokens = 16384
  assert.equal(store.dirtyScopes["reply-settings"], true)
  await view.saveSimple()
  assert.equal(requests.at(-1)["modelTasks.replyer.maxTokens"], 16384)
  assert.equal(store.config.modelTasks.replyer.maxTokens, 16384)
  assert.equal(view.dirty.value, false)
  assert.equal(store.dirtyScopes["reply-settings"], undefined)
  const reloaded = mount(store.config)
  assert.equal(reloaded.view.draft.replyerMaxTokens, 16384, "saved values survive reopening the panel")
  reloaded.unmount()
  const body = buildResponsesRequest({
    channel: { type: "openai-responses", model: "fixture", params: { max_output_tokens: 1024 } },
    messages: [{ role: "user", content: "test" }], maxTokens: savedConfig.modelTasks.replyer.maxTokens,
  })
  assert.equal(body.max_output_tokens, 16384, "task output budgets override model params in the actual protocol body")
  const beforeInvalid = requests.length
  for (const value of [0, -1, 1.5, 65537, "", Number.NaN]) {
    view.draft.replyerMaxTokens = value
    await view.saveSimple()
    assert.equal(requests.length, beforeInvalid, "invalid limits are rejected before submitting")
  }
  view.draft.replyerMaxTokens = 12000
  failSave = true
  await view.saveSimple()
  assert.equal(view.dirty.value, true, "failed saves retain unsaved changes")
  assert.equal(store.dirtyScopes["reply-settings"], true)
  let closing = view.closeSettings()
  assert.equal(confirmState.open, true)
  settleConfirm(false)
  await closing
  assert.equal(view.showDrawer.value, true, "cancelling discard keeps the editor open")
  assert.equal(view.draft.replyerMaxTokens, 12000)
  closing = view.closeSettings()
  settleConfirm(true)
  await closing
  assert.equal(view.draft.replyerMaxTokens, 16384, "discard restores the last successfully saved draft")
  assert.equal(view.showDrawer.value, false)
  assert.equal(store.dirtyScopes["reply-settings"], undefined)
} finally {
  unmount()
}

const app = createSSRApp({ ...ModelRoutingBuilder, setup(props) {
  const state = ModelRoutingBuilder.setup(props)
  state.showDrawer.value = true
  return state
} }, { cfg: defaults, modelNames: ["mock"], compact: false })
for (const [name, component] of Object.entries(components)) app.component(name, name === "Dialog"
  ? { props: ["open"], template: '<div v-if="open"><slot /><slot name="footer" /></div>' } : component)
const html = await renderToString(app)
assert(html.includes("回复输出 Token 上限") && html.includes('value="10000"'))
assert(html.includes("思考与工具参数也计入") && html.includes("1–65536"))
assert.equal(store.dirtyScopes["reply-settings"], undefined)
console.log("ok reply settings: defaults, validation, Vue rendering, save/reopen, failure retention, discard protection and Responses request budget")
