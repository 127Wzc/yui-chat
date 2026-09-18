import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
await fs.mkdir(path.join(root, "cache"), { recursive: true })
const runtimeRoot = await fs.mkdtemp(path.join(root, "cache", "silent-tools-check-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.env.YUI_CHAT_PLUGIN_ROOT = root
process.chdir(path.resolve(root, "../.."))
global.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {}, blue: v => v, cyan: v => v, red: v => v }
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = { image: value => ({ type: "image", value }) }
global.plugin = class { constructor(options = {}) { this.options = options } }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

try {
  const { configStore } = await import("../output/runtime/config/store.js")
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { toolRegistry: registry } = await import("../output/runtime/tools/support/registry.js")
  const { backgroundTaskService } = await import("../output/runtime/core/scheduling/background-task-service.js")
  const { chatService } = await import("../output/runtime/core/chat/chat-service.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { customToolManager } = await import("../output/runtime/tools/custom/manager.js")
  const config = structuredClone(defaults)
  config.tools.enabled = true
  config.tools.policy.allowCustomTools = true
  config.tools.boundaryAccess.enabled = false
  config.tools.promptSelection.enabled = false
  config.chat.execution.background = { enabled: true, maxConcurrent: 4, maxQueue: 10 }
  configStore.get = () => config
  configStore.load = async () => structuredClone(config)
  const e = { isGroup: true, isMaster: true, group_id: "silent-group", user_id: "silent-user", sender: { role: "owner" } }
  const context = { config, e }
  function register(name, execute, extra = {}) {
    config.tools.enabledTools.push(name)
    registry.register({ name, source: "custom", description: name, parameters: { type: "object", properties: {} },
      execution: { effect: "read", backgroundSilent: true, timeoutMs: 1000 }, execute, ...extra })
  }
  async function submit(name, extra = {}) {
    const completion = deferred()
    const result = await registry.execute(name, {}, { ...context, ...extra, execution: { ...extra.execution, onBackgroundComplete: completion.resolve } })
    assert.equal(result.status, "accepted")
    assert.equal(result.metadata.backgroundSilent, true)
    assert.equal(result.metadata.messageSendPlan, undefined)
    return { result, completion: completion.promise }
  }

  const gate = deferred()
  register("silent_wait", async () => { await gate.promise; return "done" })
  const parent = new AbortController()
  const wait = await submit("silent_wait", { signal: parent.signal, agent: { signal: parent.signal } })
  parent.abort()
  assert.notEqual(backgroundTaskService.get(wait.result.metadata.taskId).status, "ok")
  gate.resolve()
  assert.equal((await wait.completion).status, "ok", "normal parent completion must not cancel detached work")

  register("silent_failure", async () => { throw new Error("expected failure") })
  const failed = await submit("silent_failure")
  assert.equal((await failed.completion).status, "error")

  let sends = 0
  register("message_send", async args => { assert.equal(args.parts[0].type, "image"); sends++; return { status: "success", content: "sent" } }, {
    execution: { effect: "non_idempotent", repeatPolicy: "dedupe", maxAttempts: 1 },
  })
  const plan = { status: "success", metadata: { messageSendPlan: { parts: [{ type: "image", source: { kind: "url", value: "https://example.com/sticker.png" } }] } } }
  register("silent_picture", async () => plan, { autoDelivery: { via: "message_send", continueConversation: true } })
  const picture = await submit("silent_picture")
  assert.equal((await picture.completion).status, "ok")
  assert.equal(sends, 1)

  const modelDenied = await submit("silent_picture", { channel: { modelConfig: { toolPolicy: { mode: "allowlist", allow: ["silent_picture"] } } } })
  assert.equal((await modelDenied.completion).status, "error")
  assert.equal(sends, 1, "automatic delivery must respect model tool policy")

  const revokeGate = deferred()
  register("silent_revoke", async () => { await revokeGate.promise; return plan }, { autoDelivery: { via: "message_send" } })
  const revoke = await submit("silent_revoke")
  config.tools.policy.allowCustomTools = false
  revokeGate.resolve()
  assert.equal((await revoke.completion).status, "error")
  config.tools.policy.allowCustomTools = true
  assert.equal(sends, 1, "revocation must prevent late delivery")

  const timeoutGate = deferred()
  register("silent_timeout", async () => { await timeoutGate.promise; return plan }, { autoDelivery: { via: "message_send" } })
  const timeout = await submit("silent_timeout")
  await sleep(1100)
  assert.equal((await timeout.completion).status, "error")
  timeoutGate.resolve()
  await sleep(10)
  assert.equal(sends, 1, "timed out work must never deliver a late image")

  // A queued task must preserve the caller's asynchronous authorization guard.
  const queueGate = deferred()
  const queuePolicy = { backgroundQueue: () => ({ queueKey: "silent-auth", maxConcurrent: 1, maxQueue: 2 }) }
  register("silent_auth_blocker", async () => { await queueGate.promise; return "done" }, queuePolicy)
  let guardedExecutions = 0, callerAllowed = true
  register("silent_auth", async () => { guardedExecutions++; return plan }, { ...queuePolicy, autoDelivery: { via: "message_send" } })
  const beforeInvoke = async () => { await Promise.resolve(); if (!callerAllowed) throw new Error("caller access revoked") }
  const blocker = await submit("silent_auth_blocker")
  const guarded = await submit("silent_auth", { execution: { beforeInvoke } })
  assert.equal(guarded.result.metadata.backgroundStatus, "queued")
  callerAllowed = false
  queueGate.resolve()
  await blocker.completion
  assert.equal((await guarded.completion).status, "error")
  assert.equal(guardedExecutions, 0)
  assert.equal(sends, 1)

  // Revoking caller access while the tool runs must also prevent its delivery.
  const lateGate = deferred(), lateStarted = deferred()
  callerAllowed = true
  register("silent_auth_late", async () => { lateStarted.resolve(); await lateGate.promise; return plan }, { autoDelivery: { via: "message_send" } })
  const late = await submit("silent_auth_late", { execution: { beforeInvoke } })
  await lateStarted.promise
  callerAllowed = false
  lateGate.resolve()
  assert.equal((await late.completion).status, "error")
  assert.equal(sends, 1)

  // Action delivery uses its saved authorization, including revocation checks.
  config.actions.items.silent_picture_action = { enabled: true, tool: "silent_picture", minRole: "master", scope: "all" }
  const actionPicture = await submit("silent_picture", { actionId: "silent_picture_action" })
  assert.equal((await actionPicture.completion).status, "ok")
  assert.equal(sends, 2)
  const actionGate = deferred(), actionStarted = deferred()
  register("silent_action_revoke", async () => { actionStarted.resolve(); await actionGate.promise; return plan }, { autoDelivery: { via: "message_send" } })
  config.actions.items.silent_revoke_action = { enabled: true, tool: "silent_action_revoke", minRole: "master", scope: "all" }
  const actionRevoke = await submit("silent_action_revoke", { actionId: "silent_revoke_action" })
  await actionStarted.promise
  config.actions.items.silent_revoke_action.enabled = false
  actionGate.resolve()
  assert.equal((await actionRevoke.completion).status, "error")
  assert.equal(sends, 2)

  const fullGate = deferred()
  register("silent_full", async () => { await fullGate.promise; return "done" }, { backgroundQueue: () => ({ queueKey: "silent-full", maxConcurrent: 1, maxQueue: 0 }) })
  const running = await submit("silent_full")
  const dropped = await registry.execute("silent_full", {}, context)
  assert.equal(dropped.metadata.backgroundStatus, "dropped")
  assert.equal(dropped.status, "accepted")
  fullGate.resolve(); await running.completion

  // Main conversation must continue even when a silent tool is the only call,
  // and must summarize ordinary tool results without waiting for decoration.
  for (const mixed of [false, true]) {
    const modelGate = deferred()
    register("silent_search", async () => { await modelGate.promise; return "done" })
    register("ordinary_tool", async () => "ordinary result", { execution: { effect: "read" } })
    let requests = 0
    const adapter = { id: "silent-model", supportsTools: true, supportsVision: false, supportsStreaming: false,
      async sendMessage() {
        requests++
        if (requests === 1) return { id: "first", text: "", toolCalls: [
          { id: "silent-call", name: "silent_search", arguments: {} },
          ...(mixed ? [{ id: "ordinary-call", name: "ordinary_tool", arguments: {} }] : []),
        ], usage: { input: 1, output: 1, total: 2 } }
        return { id: "final", text: "正常主对话回复", toolCalls: [], usage: { input: 1, output: 1, total: 2 } }
      } }
    adapterRegistry.register(adapter)
    const response = await chatService.runModelStepWithChannel({ e, prompt: "聊聊天", config, history: [],
      step: { id: "reply", task: "replyer", mode: "final" },
      channel: { id: adapter.id, type: adapter.id, model: "mock", modelConfig: { toolUse: true }, timeoutMs: 1000 },
    })
    assert.equal(response.text, "正常主对话回复")
    assert.equal(requests, 2)
    const trace = response.toolChain.find(t => t.name === "silent_search")
    assert.equal(trace.requiresFinalReply, false)
    assert.notEqual(backgroundTaskService.get(trace.metadata.taskId)?.status, "ok")
    modelGate.resolve(); await sleep(10)
    registry.tools.delete("silent_search"); registry.tools.delete("ordinary_tool")
  }

  // The editor's one switch overrides source defaults, including a false value.
  register("ordinary_background", async () => "done", {
    backgroundMessage: "任务已经开始。", requiresFinalReply: true,
    execution: { effect: "read", background: true },
  })
  let ordinaryRequests = 0
  adapterRegistry.register({ id: "ordinary-background", supportsTools: true, supportsVision: false, supportsStreaming: false,
    async sendMessage() { ordinaryRequests++; return { id: "ordinary", text: "", toolCalls: [{ id: "ordinary-bg", name: "ordinary_background", arguments: {} }], usage: { input: 1, output: 1, total: 2 } } },
  })
  const ordinaryResponse = await chatService.runModelStepWithChannel({ e, prompt: "开始任务", config, history: [],
    step: { id: "reply", task: "replyer", mode: "final" },
    channel: { id: "ordinary-background", type: "ordinary-background", model: "mock", modelConfig: { toolUse: true }, timeoutMs: 1000 },
  })
  assert.equal(ordinaryRequests, 1)
  assert.equal(ordinaryResponse.text, "任务已经开始。", "ordinary background tools retain their existing start reply")

  const draft = await customToolManager.createTemplate("silent-editor", { dryRun: true })
  draft.source += '\ntools[0].execution = { backgroundSilent: true }\n'
  draft.manifest.tools[0].execution = { backgroundSilent: true }
  draft.manifest.tools[0].executionByAction = { pick: { effect: "read", backgroundSilent: false } }
  const created = await customToolManager.createPackage({ manifest: draft.manifest, source: draft.source })
  let loaded = await customToolManager.loadTools()
  assert.equal(loaded.tools.find(t => t.name === draft.toolName).common.execution.backgroundSilent, true)
  assert.equal(loaded.tools.find(t => t.name === draft.toolName).common.executionByAction.pick.backgroundSilent, true)
  const pkg = await customToolManager.getPackage(created.id)
  const { applyCustomBuilder, customBuilderFromManifest } = await import("../output/runtime/web/client/features/tools/custom-builder.js")
  pkg.manifest = applyCustomBuilder(pkg.manifest, { ...customBuilderFromManifest(pkg.manifest), backgroundSilent: "false" })
  await customToolManager.updatePackage(created.id, { manifest: pkg.manifest, source: pkg.source })
  loaded = await customToolManager.loadTools()
  assert.equal(loaded.tools.find(t => t.name === draft.toolName).common.execution.backgroundSilent, false)
  assert.equal(loaded.tools.find(t => t.name === draft.toolName).common.executionByAction.pick.backgroundSilent, false)
  await customToolManager.dispose()
  console.log("ok silent background: nonblocking, failures, auto-delivery, revocation, timeout, full queue, model continuation, editor override")
} finally {
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}
process.exit(0)
