import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { reactive, compile } from "vue"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-behavior-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.env.YUI_CHAT_PLUGIN_ROOT = root
process.chdir(path.resolve(root, "../.."))
global.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {} }
global.Bot = { express: null, wsf: {}, uin: [] }
global.plugin = class {}
let sqliteClient, modelLogStore
try {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { normalizeTool } = await import("../output/runtime/tools/support/contract.js")
  const { applyToolBehavior, behaviorEntry, updateBehaviorEntry, validateBehaviorConfig } = await import("../output/runtime/tools/support/behavior-settings.js")
  const config = structuredClone(defaults)
  const read = normalizeTool({ name: "behavior_read", source: "custom", packageId: "pkg", execution: { effect: "read", timeoutMs: 23000, maxAttempts: 3 }, execute: args => args })
  const write = normalizeTool({ name: "behavior_write", source: "custom", packageId: "pkg", execution: { effect: "non_idempotent", maxAttempts: 1 }, execute: () => "done" })
  const actionTool = normalizeTool({ name: "behavior_actions", source: "builtin", execution: { effect: "unknown" }, executionByAction: { lookup: { effect: "read", maxAttempts: 2 }, write: { effect: "non_idempotent", maxAttempts: 1, repeatPolicy: "dedupe" } }, execute() {} })
  assert.equal(applyToolBehavior(read, config), read, "no override preserves original defaults and object")
  assert.equal(read.common.execution.timeoutMs, 23000)
  assert.equal(write.common.execution.retryPolicy, "no_ambiguous_retry")
  assert.equal(write.common.execution.parallelSafe, false)
  updateBehaviorEntry(config, "customPackages", "pkg", { timeoutMs: 7000, parallelSafe: true, maxCount: 50 })
  assert.equal(applyToolBehavior(read, config).common.execution.timeoutMs, 7000)
  assert.equal(applyToolBehavior(write, config).common.execution.parallelSafe, false, "range setting never relabels writes as parallel queries")
  assert.equal(applyToolBehavior(read, config).common.execution.maxCount, 1, "count limit does not invent count support")
  updateBehaviorEntry(config, "tools", read.name, { timeoutMs: 11000, requiresFinalReply: false })
  assert.equal(applyToolBehavior(read, config).common.execution.timeoutMs, 11000)
  updateBehaviorEntry(config, "tools", read.name, { timeoutMs: null })
  assert.equal(applyToolBehavior(read, config).common.execution.timeoutMs, 7000)
  assert.equal(applyToolBehavior(read, config).common.requiresFinalReply, false)
  updateBehaviorEntry(config, "tools", read.name, {}, "", true)
  assert.equal(applyToolBehavior(read, config).common.requiresFinalReply, true)
  assert.deepEqual(behaviorEntry(config, "tools", read.name), { values: {}, actions: {} })
  const background = normalizeTool({ name: "bg", source: "builtin", execution: { background: true }, execute() {} })
  updateBehaviorEntry(config, "tools", "bg", { mode: "foreground" })
  assert.equal(applyToolBehavior(background, config).common.execution.background, false, "explicit foreground can disable a declared background default")
  const contextual = normalizeTool({ name: "contextual", source: "builtin", policy: { requiresModelContext: true }, execute() {} })
  updateBehaviorEntry(config, "tools", contextual.name, { mode: "silent" })
  assert.equal(applyToolBehavior(contextual, config).common.execution.backgroundSilent, false)
  updateBehaviorEntry(config, "tools", actionTool.name, { timeoutMs: 9000 })
  updateBehaviorEntry(config, "tools", actionTool.name, { timeoutMs: 4000 }, "lookup")
  const actions = applyToolBehavior(actionTool, config).common.executionByAction
  assert.equal(actions.lookup.timeoutMs, 4000)
  assert.equal(actions.write.timeoutMs, 9000)
  assert.equal(actions.write.repeatPolicy, "dedupe")
  assert.equal(actions.write.effect, "non_idempotent")
  updateBehaviorEntry(config, "tools", actionTool.name, {}, "lookup", true)
  assert.equal(applyToolBehavior(actionTool, config).common.executionByAction.lookup.timeoutMs, 9000)
  assert.equal(actionTool.common.executionByAction.lookup.timeoutMs, 60000, "declared defaults are never mutated")
  for (const values of [{ effect: "read" }, { maxAttempts: 0 }, { maxAttempts: "2" }, { timeoutMs: 999 }, { parallelSafe: "true" }, { mode: "invalid" }, { minPollIntervalMs: -1 }]) {
    assert.throws(() => validateBehaviorConfig({ tools: { example: { values } } }))
  }
  assert.throws(() => validateBehaviorConfig(JSON.parse('{"tools":{"__proto__":{"values":{}}}}')))
  assert.equal(validateConfig(config).ok, true)

  // 使用真实 SQLite、进程内鉴权路由和配置更新队列验证热应用与并发更新。
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  ;({ modelLogStore } = await import("../output/runtime/core/observability/model-log.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  await sqliteClient.init(await configStore.load())
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  await configStore.update(value => {
    value.web.authToken = "behavior-fixture-token"
    value.mcp.enabled = false
    value.mcp.servers = { "fixture.with.dot": { enabled: false, transport: "stdio", command: "disabled-fixture", execution: { effect: "read", timeoutMs: 18000 } } }
  })
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { customToolManager } = await import("../output/runtime/tools/custom/manager.js")
  const { McpToolAdapter } = await import("../output/runtime/mcp/index.js")
  toolRegistry.tools.clear()
  toolRegistry.register(read); toolRegistry.register(write); toolRegistry.register(actionTool); toolRegistry.register(contextual)
  customToolManager.catalog = [{ id: "pkg", tools: [{ name: "unloaded", execution: { effect: "read", timeoutMs: 27000 } }] }]
  const mcp = new McpToolAdapter("fixture.with.dot", null, { name: "query", inputSchema: {} }, configStore.get().mcp.servers["fixture.with.dot"])
  toolRegistry.register(mcp)
  const originalRegistryTool = toolRegistry.tools.get(read.name)
  const { registerToolBehaviorRoutes } = await import("../output/runtime/web/http/routes/capabilities/tool-behavior.js")
  const routes = new Map()
  const app = Object.fromEntries(["get", "put"].map(method => [method, (route, ...handlers) => routes.set(method.toUpperCase(), handlers)]))
  registerToolBehaviorRoutes(app)
  async function invoke(method, body = {}, authenticated = true, handlers = routes.get(method), params = {}) {
    let status = 200, payload
    const req = { method, body, params, query: {}, headers: authenticated ? { "yui-chat-token": "behavior-fixture-token" } : {}, socket: { remoteAddress: "127.0.0.1" } }
    const res = { status(value) { status = value; return this }, json(value) { payload = value; return this }, append() {} }
    async function next(index) { await handlers[index]?.(req, res, () => next(index + 1)) }
    await next(0)
    return { status, body: JSON.parse(JSON.stringify(payload)) }
  }
  const change = (body, authenticated = true) => invoke("PUT", body, authenticated)
  const target = { scope: "tools", id: read.name }
  assert.equal((await change({ targets: [target], changes: { timeoutMs: 7000 } }, false)).status, 401)
  assert.throws(() => validateBehaviorConfig({tools: {example: {actions: {query: {requiresFinalReply: false}}}}}))
  const before = JSON.stringify(configStore.get().tools.behavior)
  for (const body of [{ targets: [{ ...target, owner: {scope: "customPackages", id: "other"} }], changes: {timeoutMs: 3000} }, { targets: [{ scope: "tools", id: "__proto__" }], changes: {} }, { targets: [target], changes: { effect: "read" } }, { targets: [target], changes: { maxAttempts: 6 } }, { targets: [target], action: "missing", changes: { timeoutMs: 3000 } }, { targets: [target, { scope: "tools", id: "missing" }], changes: { timeoutMs: 3000 } }]) {
    assert.equal((await change(body)).status, 400)
    assert.equal(JSON.stringify(configStore.get().tools.behavior), before, "invalid batches do not persist partial edits")
  }
  const updates = await Promise.all([change({ targets: [target], changes: { timeoutMs: 12000 } }), change({ targets: [target], changes: { maxAttempts: 4 } })])
  assert(updates.every(result => result.status === 200), JSON.stringify(updates))
  assert.equal(toolRegistry.get(read.name).common.execution.timeoutMs, 12000)
  assert.equal(toolRegistry.get(read.name).common.execution.maxAttempts, 4)
  assert.equal(toolRegistry.tools.get(read.name), originalRegistryTool, "hot application does not rebuild or mutate definitions")
  assert.equal((await change({ targets: [{ scope: "customPackages", id: "pkg" }], changes: { mode: "silent" } })).status, 200)
  assert.equal(toolRegistry.get(write.name).common.execution.backgroundSilent, true)
  assert.equal((await change({ targets: [target, { scope: "tools", id: write.name }], changes: { requiresFinalReply: false } })).status, 200)
  assert.equal(toolRegistry.get(read.name).common.execution.maxAttempts, 4, "bulk edits preserve unrelated tool differences")
  assert.equal(toolRegistry.get(write.name).common.execution.maxAttempts, 1)
  assert.equal((await change({ targets: [{ scope: "mcpServers", id: "fixture.with.dot" }], changes: { timeoutMs: 13000 } })).status, 200)
  assert.equal(toolRegistry.get(mcp.name).common.execution.timeoutMs, 13000)
  assert.equal(configStore.get().mcp.servers["fixture.with.dot"].enabled, false)
  assert.equal(configStore.get().mcp.servers["fixture.with.dot"].execution.timeoutMs, 18000, "MCP source defaults and connection remain intact")
  assert.equal((await change({ targets: [{ scope: "tools", id: "unloaded" }], changes: { timeoutMs: 30000 } })).status, 200)
  assert(!toolRegistry.get("unloaded"), "saving unloaded metadata does not load or execute the extension")
  const { body: catalog } = await invoke("GET")
  const unloaded = catalog.tools.find(tool => tool.name === "unloaded")
  assert.equal(unloaded.loaded, false)
  assert.equal(unloaded.inherited.timeoutMs, 27000)
  assert.equal(catalog.settings.tools.unloaded.values.timeoutMs, 30000)
  assert(!JSON.stringify(catalog).includes("behavior-fixture-token"))
  assert.equal((await change({ targets: [target], edits: [{ reset: true, changes: { timeoutMs: 33000 } }] })).status, 200)
  assert.equal(toolRegistry.get(read.name).common.execution.timeoutMs, 33000, "reset followed by edits is one transaction")
  assert.equal(toolRegistry.get(read.name).common.execution.maxAttempts, 3)
  assert.equal((await change({ targets: [target], reset: true })).status, 200)
  assert.equal(toolRegistry.get(read.name).common.execution.timeoutMs, 23000)


  const mixed = await change({ targets: [target, {scope: "tools", id: contextual.name}], changes: {mode: "silent", maxCount: 20, maxPolls: 7} })
  assert.equal(mixed.status, 200)
  assert.equal(toolRegistry.get(read.name).common.execution.backgroundSilent, true)
  assert.equal(toolRegistry.get(contextual.name).common.execution.backgroundSilent, false)
  assert.deepEqual(behaviorEntry(configStore.get(), "tools", contextual.name).values, {}, "unsupported batch fields are not saved to the contextual tool")
  assert(!Object.hasOwn(behaviorEntry(configStore.get(), "tools", read.name).values, "maxCount"), "batch changes do not invent count or polling support")
  // 已有 JSON 覆盖也允许按项清除，不因其现在不适用而阻止恢复默认。
  await configStore.update(value => { value.tools.behavior.tools[contextual.name] = {values: {mode: "silent"}, actions: {}} })
  assert.equal((await change({targets: [{scope: "tools", id: contextual.name}], changes: {mode: null}})).status, 200)
  assert.deepEqual(behaviorEntry(configStore.get(), "tools", contextual.name).values, {})
  const actionTarget = {scope: "tools", id: actionTool.name}
  assert.equal((await change({targets: [actionTarget], action: "lookup", changes: {timeoutMs: 4000}})).status, 200)
  assert.equal((await change({targets: [actionTarget], edits: [{reset: true}]})).status, 200)
  assert.equal(toolRegistry.get(actionTool.name).common.executionByAction.lookup.timeoutMs, 60000, "whole-tool reset removes persisted action overrides")
  assert.equal((await change({targets: [actionTarget], edits: [{reset: true}, {action: "lookup", changes: {timeoutMs: 4500}}]})).status, 200)
  assert.equal(toolRegistry.get(actionTool.name).common.executionByAction.lookup.timeoutMs, 4500, "a new action edit made after resetting is retained")


  // 真实写接口复用一次刷新结果，不额外重建目录或唤醒无关队列。
  const { registerExtensionRoutes } = await import("../output/runtime/web/http/routes/capabilities/extensions.js")
  const extensionRoutes = new Map()
  registerExtensionRoutes(Object.fromEntries(["get", "post", "put", "patch", "delete"].map(method => [method, (path, ...handlers) => extensionRoutes.set(`${method}:${path}`, handlers)])))
  const { skillManager, createSkillPackage } = await import("../output/runtime/skills/index.js")
  const skillFixture = await createSkillPackage({manifest: {name: "save-fixture", description: "Use only for the save regression fixture.", enabled: false, configSchema: {type: "object", properties: {apiKey: {type: "string", secret: true}}}}, source: "Return the requested fixture result."})
  const originalScan = skillManager.listSkills, originalInit = toolRegistry.init
  let scans = 0, inits = 0
  skillManager.listSkills = function (...args) { scans++; return originalScan.apply(this, args) }
  toolRegistry.init = async () => { inits++; throw new Error("unexpected registry rebuild") }
  try {
    const result = await invoke("PUT", {value: {apiKey: "fixture-private-value"}}, true, extensionRoutes.get("put:/api/skills/:id/runtime-config"), {id: skillFixture.id})
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(scans, 2, "one schema read and one post-save scan; response reuses the refresh result")
    assert.equal(inits, 0)
    assert.equal(result.body.skill.runtimeConfig.apiKey, "********")
    assert(!JSON.stringify(result.body).includes("fixture-private-value"))
  } finally { skillManager.listSkills = originalScan; toolRegistry.init = originalInit }
  const { backgroundTaskService } = await import("../output/runtime/core/scheduling/background-task-service.js")
  const originalRefresh = backgroundTaskService.refresh
  let queueRefreshes = 0
  backgroundTaskService.refresh = () => { queueRefreshes++ }
  try {
    for (const queue of [false, true]) {
      const name = queue ? "queue_variable_fixture" : "variable_fixture"
      toolRegistry.register({name, source: "builtin", configSchema: {type: "object", properties: {limit: {type: "integer"}}}, ...(queue ? {backgroundQueue: () => ({})} : {}), execute() {}})
      const result = await invoke("PUT", {value: {limit: 2}}, true, extensionRoutes.get("put:/api/tools/:name/runtime-config"), {name})
      assert.equal(result.status, 200, JSON.stringify(result.body))
      assert.equal(queueRefreshes, queue ? 1 : 0, "only declared tool queues are refreshed by runtime-variable changes")
    }
  } finally { backgroundTaskService.refresh = originalRefresh }

  // 表单根据前置条件展开，不虚构能力；秒与毫秒转换使用同一套字段组件。
  const { BehaviorFields } = await import("../output/runtime/web/client/features/tools/behavior-fields.js")
  const props = reactive({ values: {}, inherited: { mode: "foreground", retryPolicy: "none", timeoutMs: 23000 }, capabilities: [{ effect: "non_idempotent", supportsCount: false, polling: false, autoDelivery: false, backgroundAvailable: true }], action: false, batch: false })
  const changes = []
  const form = BehaviorFields.setup(props, { emit: (...args) => changes.push(args) })
  const keys = () => form.groups.value.flatMap(group => group.fields.map(field => field.key))
  assert(keys().includes("requiresFinalReply"))
  for (const key of ["maxAttempts", "parallelSafe", "maxCount", "maxPolls", "continueConversation"]) assert(!keys().includes(key), key)
  props.values.retryPolicy = "safe"
  assert(keys().includes("maxAttempts"))
  props.values.mode = "silent"
  assert(!keys().includes("requiresFinalReply"))
  props.capabilities = [{ effect: "read", supportsCount: true, polling: true, autoDelivery: true, backgroundAvailable: true }]
  assert(keys().includes("parallelSafe") && keys().includes("maxCount") && keys().includes("maxPolls"))
  const timeout = form.groups.value.flatMap(group => group.fields).find(field => field.key === "timeoutMs")
  assert.equal(form.numberValue(timeout), 23)
  form.change(timeout, "12")
  assert.deepEqual(changes.pop(), ["change", "timeoutMs", 12000])
  form.change(timeout, "")
  assert.deepEqual(changes.pop(), ["change", "timeoutMs", null])
  props.capabilities = [{ effect: "read", backgroundAvailable: false }]
  assert(!keys().includes("mode"))
  props.inherited.retryPolicy = "safe"
  assert(keys().includes("requiresFinalReply") && keys().includes("retryPolicy") && keys().includes("maxAttempts"), "stale unsupported mode overrides must not hide foreground settings")
  compile(BehaviorFields.template, { onError(error) { throw error } })
  const { RuntimeVariableFields } = await import("../output/runtime/web/client/features/tools/runtime-variable-fields.js")
  compile(RuntimeVariableFields.template, { onError(error) { throw error } })
  console.log("ok tool behavior: declared defaults, layered/reset/action settings, conditional fields, atomic bulk and concurrent writes, hot application, unloaded metadata, auth and redaction")
} finally {
  await modelLogStore?.stop?.({ flush: true })
  await sqliteClient?.close?.()
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}

process.exit(0)
