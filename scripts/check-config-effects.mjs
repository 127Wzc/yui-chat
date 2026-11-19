import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-config-effects-"))
process.env.YUI_CHAT_PLUGIN_ROOT = root
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.chdir(path.resolve(root, "../.."))
global.logger = Object.fromEntries(["mark", "info", "warn", "error", "debug"].map(name => [name, () => {}]))
global.Bot = { express: null, wsf: {}, uin: [] }
global.plugin = class {}

const { configStore } = await import("../output/runtime/config/store.js")
const { sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js")
const { updateConfigAndApply } = await import("../output/runtime/web/http/runtime-config.js")
const { applyConfigPatch } = await import("../output/runtime/models/configuration/editor.js")
const { toolRegistry, ToolRegistry } = await import("../output/runtime/tools/support/registry.js")
const { mcpManager, McpManager } = await import("../output/runtime/mcp/index.js")
const { filterRegistry } = await import("../output/runtime/filters/core/registry.js")
const { initiativeGreetingScheduler } = await import("../output/runtime/core/persona/initiative-greeting.js")
const { stickerExpressionCoordinator } = await import("../output/runtime/core/persona/sticker-expression-coordinator.js")
const { scheduleTaskService } = await import("../output/runtime/core/scheduling/schedule-task-service.js")
const { groupCaptureStore } = await import("../output/runtime/memory/group-capture.js")
const { modelLogStore } = await import("../output/runtime/core/observability/model-log.js")
const { langfuseReporter } = await import("../output/runtime/core/observability/langfuse.js")
const { actionCommandStatus } = await import("../output/runtime/core/runtime/host-command-registry.js")

const calls = []
const restores = []
let failMcp = false
for (const [target, key, label] of [
  [toolRegistry, "init", "tools"], [toolRegistry, "refreshMcp", "mcp"], [filterRegistry, "init", "filters"],
  [initiativeGreetingScheduler, "start", "greeting"], [stickerExpressionCoordinator, "start", "sticker"],
  [scheduleTaskService, "start", "schedule"], [groupCaptureStore, "applyConfig", "retention"],
  [groupCaptureStore, "startScanner", "scanner"], [groupCaptureStore, "refreshPolicies", "policies"], [modelLogStore, "start", "logs"], [langfuseReporter, "start", "langfuse"],
]) {
  const original = target[key]
  target[key] = (...args) => { calls.push(label); if (label === "mcp" && failMcp) throw Error("injected MCP apply failure"); return label === "policies" ? original.apply(target, args) : false }
  restores.push(() => { target[key] = original })
}
const initialized = groupCaptureStore.initialized
groupCaptureStore.initialized = true
const patch = async values => {
  calls.length = 0
  const appliedAt = actionCommandStatus.appliedAt
  const result = await updateConfigAndApply(current => applyConfigPatch(current, values).next)
  assert.equal(actionCommandStatus.appliedAt, appliedAt, "ordinary settings must not re-register action commands")
  return result
}
try {
  await configStore.load()
  await sqliteClient.run("INSERT INTO group_memory_policies(group_id,enabled,created_at,updated_at) VALUES(?,1,1,1)", ["inherit-fixture"])
  await groupCaptureStore.refreshPolicies()
  await patch({ "logging.langfuse.sampleRate": 0.5 })
  assert.deepEqual(calls, ["langfuse"])
  await patch({ "logging.level": "debug" })
  assert.deepEqual(calls, ["logs"])
  await patch({ "web.publicBaseUrl": "https://fixture.example" })
  assert.deepEqual(calls, [])
  await patch({ "knowledge.enabled": false })
  assert.deepEqual(calls, [], "knowledge changes use the same diff-based apply without unrelated reloads")
  const revision = configStore.meta().revision
  await patch({ "web.publicBaseUrl": "https://fixture.example" })
  assert.deepEqual(calls, [])
  assert.equal(configStore.meta().revision, revision, "unchanged configuration must not publish another revision")
  assert.deepEqual(applyConfigPatch(configStore.get(), { "logging.level": "debug" }).changedPaths, [])
  await patch({ "memory.retrieval.resultLimit": 4 })
  assert.deepEqual(calls, ["policies"])
  assert.equal([...groupCaptureStore.policies.values()][0].retrievalResultLimit, 4)
  await patch({ "memory.groupCapture.consolidation.maxTokens": 50000 })
  assert.deepEqual(calls, ["policies"], "output limits update inherited policy without restarting extraction scheduling")
  assert.equal([...groupCaptureStore.policies.values()][0].maxTokens, 50000)
  await patch({ "memory.groupCapture.defaultRetentionDays": 10 })
  assert.deepEqual(calls, ["retention"])
  await patch({ "memory.groupCapture.consolidation.schedule.time": "04:00" })
  assert.deepEqual(calls, ["scanner"])
  await patch({ "persona.initiativeGreeting.prompt": "fixture greeting" })
  assert.deepEqual(calls, [], "prompt edits must not reset the greeting timer")
  await patch({ "persona.initiativeGreeting.intervalHours": 4 })
  assert.deepEqual(calls, ["greeting"])
  await patch({ "tools.builtin.scheduleTask.maxPerUser": 2 })
  assert.deepEqual(calls, [], "changing limits must not immediately dispatch due reminders")
  await patch({ "tools.builtin.scheduleTask.tickMs": 20000 })
  assert.deepEqual(calls, ["schedule"])
  await patch({ "tools.enabled": false })
  assert.deepEqual(calls, [], "tool permissions are evaluated from the current snapshot without reconnecting MCP")
  await patch({ "mcp.enabled": true })
  assert.deepEqual(calls, ["mcp"])
  await patch({ "persona.stickerExpression.idle.intervalSeconds": 7200 })
  assert.deepEqual(calls, ["sticker"])
  failMcp = true
  await assert.rejects(patch({ "mcp.enabled": false }), /injected MCP/)
  failMcp = false
  calls.length = 0
  await updateConfigAndApply(current => current)
  assert(calls.includes("tools") && calls.includes("logs") && calls.includes("scanner"), "a failed apply must trigger complete recovery even on an unchanged retry")
  // Exercise the real route handlers: a server edit cannot change the global MCP switch.
  const routes = new Map()
  const { registerMcpRoutes } = await import("../output/runtime/web/http/routes/capabilities/mcp.js")
  const { issueWebAccessToken } = await import("../output/runtime/web/http/auth.js")
  const session = issueWebAccessToken("config-effects-fixture")
  registerMcpRoutes({ get() {}, delete() {}, post(route, ...handlers) { routes.set(route, handlers) } })
  const invokeRoute = async (route, body, params = {}) => {
    let response
    const res = { status() { return this }, json(value) { response = value } }
    const req = { body, params, headers: { "yui-chat-token": session.token } }
    const [auth, handler] = routes.get(route)
    await auth(req, res, () => handler(req, res))
    assert.equal(response?.ok, true, JSON.stringify(response))
    return response
  }
  await invokeRoute("/api/mcp/server", { id: "scope-fixture", transport: "stdio", command: "node", enabled: false, mcpEnabled: true })
  assert.equal(configStore.get().mcp.enabled, false)
  await invokeRoute("/api/mcp/:id/enabled", { enabled: false, mcpEnabled: true }, { id: "scope-fixture" })
  assert.equal(configStore.get().mcp.enabled, false, "individual server actions must preserve the global switch")
  // Two existing connections: disabling A must leave B and its catalog attached.
  const manager = new McpManager()
  const closed = []
  const servers = Object.fromEntries(["a", "b"].map(name => [name, { enabled: true, transport: "stdio", command: "node", args: [] }]))
  await configStore.update(current => { current.mcp = { enabled: true, servers }; return current })
  const previousMcp = structuredClone(configStore.get().mcp)
  manager.initialized = true
  for (const name of ["a", "b"]) manager.clients.set(name, { close: async () => { closed.push(name) } })
  manager.catalog = [{ server: "a", name: "a-tool" }, { server: "b", name: "b-tool" }]
  const clientB = manager.clients.get("b")
  await configStore.update(current => { current.mcp.servers.a.enabled = false; return current })
  await manager.init(previousMcp)
  assert.deepEqual(closed, ["a"])
  assert.equal(manager.clients.get("b"), clientB)
  assert.deepEqual(manager.catalog.map(item => item.server), ["b"])
  await manager.destroy()

  // A concurrent Registry read during real MCP discovery must not consume the final catalog revision.
  const fixture = path.join(runtimeRoot, "revision-server.mjs")
  const listStarted = path.join(runtimeRoot, "revision-list-started"), listRelease = path.join(runtimeRoot, "revision-list-release")
  await fs.writeFile(fixture, `import readline from "node:readline";
import fs from "node:fs";
readline.createInterface({ input: process.stdin }).on("line", async line => {
  const req = JSON.parse(line); if (req.id === undefined) return;
  let result = {};
  if (req.method === "initialize") result = { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "revision-fixture", version: "1" } };
  if (req.method === "tools/list") {
    fs.writeFileSync(${JSON.stringify(listStarted)}, "1");
    while (!fs.existsSync(${JSON.stringify(listRelease)})) await new Promise(resolve => setTimeout(resolve, 5));
    result = { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");
});`)
  await configStore.update(current => { current.mcp = { enabled: true, servers: { revision: { enabled: true, transport: "stdio", command: process.execPath, args: [fixture] } } }; return current })
  const registry = new ToolRegistry()
  const discovering = registry.refreshMcp({ enabled: false, servers: {} })
  try {
    const deadline = Date.now() + 10000
    while (true) {
      try { await fs.access(listStarted); break } catch (error) {
        if (error.code !== "ENOENT" || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    assert.equal(registry.get("mcp_revision_echo"), null)
  } finally {
    await fs.writeFile(listRelease, "1")
    await discovering
  }
  assert(registry.get("mcp_revision_echo"), "discovered tools are registered even after a concurrent read")
  const enabledMcp = structuredClone(configStore.get().mcp)
  await configStore.update(current => { current.mcp.enabled = false; return current })
  await registry.refreshMcp(enabledMcp)
  assert.equal(registry.get("mcp_revision_echo"), null, "the disabled early return publishes the empty catalog too")
  console.log("ok config effects: changed fields, no-op saves, scoped hot application, stable timers and failed-apply recovery")
} finally {
  for (const restore of restores.reverse()) restore()
  groupCaptureStore.initialized = initialized
  await mcpManager.destroy()
  await sqliteClient.close()
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}
process.exit(0)
