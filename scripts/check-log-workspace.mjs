import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { once } from "node:events"
import express from "express"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
await fs.mkdir(path.join(root, "cache"), { recursive: true })
const runtimeRoot = await fs.mkdtemp(path.join(root, "cache/log-workspace-"))
process.env.YUI_CHAT_PLUGIN_ROOT = root
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.chdir(path.resolve(root, "../.."))
global.logger = Object.fromEntries(["mark", "info", "warn", "error", "debug"].map(name => [name, () => {}]))
global.Bot = { express: null, wsf: {}, uin: [] }
global.plugin = class {}
let sqliteClient, server
try {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  await configStore.load()
  await sqliteClient.init(defaults)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  await configStore.update(config => { config.web.authToken = "log-workspace-fixture" })
  const { registerObservabilityRoutes } = await import("../output/runtime/web/http/routes/observability.js")
  const { artifactStore } = await import("../output/runtime/tools/support/artifact-store.js")
  const { modelLogStore } = await import("../output/runtime/core/observability/model-log.js")
  const now = Date.now()
  await sqliteClient.transaction(Array.from({ length: 56 }, (_, index) => ({
    sql: "INSERT INTO ai_runs(id, source, purpose, user_id, group_id, status, started_at, prompt_text, response_text, metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
    params: [`daily-${String(index).padStart(3, "0")}`, index < 55 ? "dailyStill.decision" : "firstPerson", "decision", "fixture-user", index < 54 ? "fixture-group" : "other-group", index === 0 ? "error" : "ok", now, index === 1 ? "测试输入正文" : "", index === 2 ? "测试返回正文" : "", JSON.stringify(index === 0 ? { error: "决策请求失败（403）：authentication_error" } : {})],
  })))
  for (let index = 0; index < 127; index++) {
    const scope = artifactStore.open({ key: `fixture-${index}`, sessionId: `session-${index}`, userId: index % 2 ? "member-a" : "member-b", groupId: "fixture-group" })
    scope.create({ kind: index % 2 ? "memory" : "text", title: `参考资料 ${index}`, source: index % 2 ? "memory_manage" : "web_search", value: index % 2 ? { scope: "self" } : { text: "完整内容" } })
  }
  const app = express()
  app.use(express.json())
  registerObservabilityRoutes(app)
  server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  const base = `http://127.0.0.1:${server.address().port}`
  const get = async url => {
    const response = await fetch(base + url, { headers: { "yui-chat-token": "log-workspace-fixture" } })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    return result
  }
  assert.equal((await fetch(base + "/api/artifacts?pageSize=20")).status, 401)
  assert.equal((await fetch(base + "/api/logs/runs")).status, 401)
  const seen = new Set()
  let cursor = ""
  do {
    const result = await get(`/api/logs/runs?source=dailyStill.decision&groupId=fixture-group&limit=10&cursor=${encodeURIComponent(cursor)}`)
    for (const item of result.items) { assert(!seen.has(item.id)); seen.add(item.id); assert.equal(item.source, "dailyStill.decision") }
    cursor = result.nextCursor
  } while (cursor)
  assert.equal(seen.size, 54, "same-timestamp cursor pages must neither repeat nor lose daily records")
  const failed = await get("/api/logs/runs?source=dailyStill.decision&status=error&query=authentication_error")
  assert.equal(failed.items.length, 1)
  assert((await get(`/api/logs/runs/${failed.items[0].id}`)).run.error_message.includes("403"))
  for (const query of ["测试输入正文", "测试返回正文"]) assert.equal((await get(`/api/logs/runs?query=${encodeURIComponent(query)}`)).items.length, 1)
  assert.equal(modelLogStore.matchesRun({ metadata_json: '{"error":"authentication_error"}' }, { query: "authentication_error" }), true)
  assert.equal((await get(`/api/logs/runs?from=${now + 1}`)).items.length, 0)
  const refs = new Set()
  for (let page = 1; page <= 7; page++) {
    const result = await get(`/api/artifacts?pageSize=20&page=${page}`)
    assert.equal(result.total, 127)
    for (const item of result.items) { assert(!refs.has(item.id)); refs.add(item.id); assert(!Object.hasOwn(item, "value")) }
  }
  assert.equal(refs.size, 127, "references beyond 100 must remain reachable")
  const filtered = await get("/api/artifacts?pageSize=20&kind=memory&source=memory_manage&userId=member-a&groupId=fixture-group")
  assert.equal(filtered.total, 63)
  assert.equal(filtered.items.length, 20)
  assert.equal((await get("/api/artifacts?pageSize=20&page=99&query=不存在")).page, 1)
  assert.equal((await get(`/api/artifacts?pageSize=20&from=${now + 60000}`)).total, 0)
  assert.equal((await get("/api/artifacts")).items.length, 127, "existing unpaged clients keep their complete list")

  global.location = { pathname: "/yui-chat", hash: "", search: "" }
  global.localStorage = { getItem: () => null }
  const { createSSRApp } = await import("vue")
  const { renderToString } = await import("vue/server-renderer")
  const { components } = await import("../output/runtime/web/client/ui/components.js")
  const { LogsTab } = await import("../output/runtime/web/client/features/logs/logs-tab.js")
  const { DailyStillTab } = await import("../output/runtime/web/client/features/daily-still/daily-still-tab.js")
  const clientSource = await fs.readFile(path.join(root, "output/runtime/web/client/features/daily-still/daily-still-tab.js"), "utf8")
  const clientVersion = clientSource.match(/store\.js(\?v=[^"\']+)/)?.[1] || ""
  const { store } = await import("../output/runtime/web/client/app/store/store.js" + clientVersion)
  store.config = structuredClone(defaults)
  store.dailyStill = { status: { scheduler: { attempts: 8, sent: 3, lastError: "403 <unsafe> authentication_error" } } }
  const render = async (component, props = {}) => {
    const app = createSSRApp(component, props)
    for (const [name, value] of Object.entries(components)) app.component(name, name === "SideDrawer" ? { props: ["open"], template: '<div v-if="open"><slot /><slot name="actions" /></div>' } : value)
    return renderToString(app)
  }
  const main = await render(LogsTab)
  assert(main.includes("日志分栏") && !main.includes("参考资料按用户"), "the default log view must not render the artifact table")
  const embedded = await render(LogsTab, { embedded: true, sourceScope: "dailyStill.decision" })
  assert(embedded.includes("判断记录") && !embedded.includes("日志统计总量") && !embedded.includes("日志分栏"))
  const daily = await render({ ...DailyStillTab, setup() { store.dailyStill = {status:{scheduler:{attempts:8,sent:3,lastError:"403 <unsafe> authentication_error"}}}; const state = DailyStillTab.setup(); state.statusOpen.value = true; return state } })
  assert(daily.includes("历史记录"), "daily history entry")
  assert(daily.includes("403 &lt;unsafe&gt; authentication_error"), "complete errors are escaped and visible")
  assert(!daily.includes("403 <unsafe>"))
  console.log("ok log workspace: authenticated HTTP, daily history/details, cursor paging, body/error search, 127 artifacts, filters and Vue rendering")

  if (process.argv.includes("--serve")) {
    app.use("/assets", express.static(path.join(root, "output/runtime/web/client")))
    app.get("/", (_req, res) => res.type("html").send(`<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/app.css"><script type="importmap">{"imports":{"vue":"/assets/vendor/vue.esm-browser.prod.js"}}</script><div id="app"></div><script type="module">import {createApp,ref} from 'vue';import {components} from '/assets/ui/components.js';import {store} from '/assets/app/store/store.js${clientVersion}';import {LogsTab} from '/assets/features/logs/logs-tab.js';import {DailyStillTab} from '/assets/features/daily-still/daily-still-tab.js';store.token='log-workspace-fixture';store.config=${JSON.stringify(defaults).replace(/</g,"\\u003c")};store.dailyStill={status:{scheduler:{attempts:8,sent:3,lastError:'403 authentication_error'}}};const app=createApp({components:{LogsTab,DailyStillTab},setup(){return {view:ref('logs')}},template:${JSON.stringify(`<main style="max-width:1440px;margin:auto;padding:24px"><RadioGroup v-model="view" :options="[{value:'logs',label:'日志与用量'},{value:'daily',label:'日常定格'}]" label="测试页面"/><LogsTab v-if="view==='logs'"/><DailyStillTab v-else/></main>`)}});for(const [name,c] of Object.entries(components))app.component(name,c);app.mount('#app')</script></html>`))
    console.log(`preview ${base}`)
    await new Promise(resolve => process.once("SIGTERM", resolve))
  }
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await sqliteClient?.close()
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}
