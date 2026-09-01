import assert from "node:assert/strict"
import { once } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import Database from "better-sqlite3"

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-runtime-p1-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.env.YUI_CHAT_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."))

global.logger = {
  mark() {}, info() {}, warn() {}, error() {}, debug() {},
  blue: value => value, cyan: value => value, red: value => value,
}
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = { at: id => `[at:${id}]`, image: value => `[image:${value}]`, record: value => `[record:${value}]`, video: value => `[video:${value}]`, reply: value => `[reply:${value}]` }
global.plugin = class { constructor(options = {}) { this.options = options } }

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
}

async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function successfulStep(text) {
  return {
    id: `runtime-p1-${Date.now()}`,
    stepId: "reply",
    mode: "final",
    channel: "mock",
    adapter: "mock",
    text,
    usage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0, source: "reported" },
    modelCalls: [],
    toolChain: [],
    toolRounds: 0,
    status: "ok",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 0,
  }
}

let sqliteClient
let modelLogStore
let legacyWorker

try {
  const legacyFile = path.join(runtimeRoot, "legacy-state.sqlite3")
  const legacyVectorFile = path.join(runtimeRoot, "unused-vectors.sqlite3")
  let legacy = new Database(legacyFile)
  legacy.exec("CREATE TABLE legacy_messages(id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT")
  legacy.prepare("INSERT INTO legacy_messages(id, body) VALUES(?, ?)").run("legacy-1", "preserve me")
  const tablesBefore = tableNames(legacy)
  legacy.close()
  legacy = null
  const bytesBefore = await fs.readFile(legacyFile)

  legacyWorker = new Worker(new URL("../output/runtime/core/storage/sqlite/worker.js", import.meta.url), {
    type: "module",
    workerData: {
      stateFile: legacyFile,
      vectorFile: legacyVectorFile,
      options: { busyTimeoutMs: 500, synchronous: "FULL" },
    },
  })
  const exitPromise = withTimeout(once(legacyWorker, "exit"), 5000, "legacy SQLite worker exit")
  const [readyMessage] = await withTimeout(once(legacyWorker, "message"), 5000, "legacy SQLite worker response")
  assert.equal(readyMessage.type, "ready")
  assert.match(String(readyMessage.error || ""), /只支持全新数据库/, "legacy state database must be rejected")
  const [exitCode] = await exitPromise
  assert.equal(exitCode, 0, "a worker rejected during initialization must close its handles and exit normally")
  legacyWorker = null

  const bytesAfter = await fs.readFile(legacyFile)
  assert.deepEqual(bytesAfter, bytesBefore, "read-only legacy preflight must not change database bytes")
  const legacyProbe = new Database(legacyFile, { readonly: true, fileMustExist: true })
  try {
    assert.deepEqual(tableNames(legacyProbe), tablesBefore, "read-only legacy preflight must not add migration tables")
    assert.deepEqual(legacyProbe.prepare("SELECT id, body FROM legacy_messages").all(), [{ id: "legacy-1", body: "preserve me" }])
  } finally {
    legacyProbe.close()
  }

  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { configStore, dataDir } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  const { conversationStore } = await import("../output/runtime/core/chat/conversation-store.js")
  const { chatService } = await import("../output/runtime/core/chat/chat-service.js")
  ;({ modelLogStore } = await import("../output/runtime/core/observability/model-log.js"))

  await configStore.load()
  const restartSqlite = async () => {
    await sqliteClient.close()
    const status = await sqliteClient.init(defaults)
    assert.equal(status.available, true, "fresh SQLite runtime must restart")
  }
  // 预置损坏的向量库：init 必须把它改名 .corrupt 后重建，而不是拒绝启动或静默沿用坏文件。
  const storageDir = path.join(dataDir, "storage")
  await fs.mkdir(storageDir, { recursive: true })
  await fs.writeFile(path.join(storageDir, "vectors.sqlite3"), "definitely not a sqlite database")
  assert.equal((await sqliteClient.init(defaults)).available, true, "fresh SQLite runtime must initialize")
  assert.equal(sqliteClient.status.vector?.available, false, "corrupted vector db degrades to FTS for this boot")
  assert(
    (await fs.readdir(storageDir)).some(name => name.startsWith("vectors.sqlite3.corrupt.")),
    "corrupted vector db must be preserved under a .corrupt name",
  )
  await restartSqlite()
  assert.equal(sqliteClient.status.vector?.available, true, "renamed vector db must be rebuilt on the next start")
  await chatService.clearAll()

  // SQLite 会话保存期必须跟随 chat.conversationTtlMs，而不是硬编码 7 天。
  await configStore.update(config => { config.chat.conversationTtlMs = 90 * 60 * 1000 })
  const ttlKey = "runtime-p1:p:ttl-check"
  await conversationStore.save({ id: ttlKey, history: [{ role: "user", content: "ttl" }] })
  assert.equal(
    Number((await sqliteClient.get("SELECT expires_at - last_seen_at AS ttl FROM conversations WHERE conversation_key=?", [ttlKey]))?.ttl),
    90 * 60 * 1000,
    "conversation persistence must honor chat.conversationTtlMs",
  )
  await conversationStore.clearKeys([ttlKey])

  const saveAndLoad = async (key, text) => {
    await conversationStore.save({ id: key, history: [{ role: "user", content: text }, { role: "assistant", content: `reply:${text}` }] })
    assert.equal((await chatService.getHistory(key)).length, 2)
    assert(chatService.listConversations().some(item => item.key === key), `${key} must be present in memory before deletion`)
  }

  const byKey = "runtime-p1:p:clear-by-key"
  await saveAndLoad(byKey, "clearByKeys")
  assert.equal(await chatService.clearByKeys([byKey]), 1)
  assert(!chatService.listConversations().some(item => item.key === byKey), "clearByKeys must delete the memory entry")
  assert.equal(await conversationStore.get(byKey), null, "clearByKeys must delete the SQLite entry")
  await restartSqlite()
  assert.equal(await conversationStore.get(byKey), null, "clearByKeys deletion must survive a SQLite restart")

  const scopedA = "runtime-p1-a:p:scope-user"
  const scopedB = "runtime-p1-b:p:scope-user"
  const scopedKeep = "runtime-p1:p:scope-user-other"
  await saveAndLoad(scopedA, "clear scope A")
  await saveAndLoad(scopedB, "clear scope B")
  await saveAndLoad(scopedKeep, "keep scope")
  assert.equal(await chatService.clear({ isGroup: false, user_id: "scope-user" }), 2)
  assert(!chatService.listConversations().some(item => item.key === scopedA || item.key === scopedB), "clear must delete matching memory entries")
  assert(chatService.listConversations().some(item => item.key === scopedKeep), "clear must preserve a different scope")
  assert.equal(await conversationStore.get(scopedA), null, "clear must delete the first matching SQLite entry")
  assert.equal(await conversationStore.get(scopedB), null, "clear must delete the second matching SQLite entry")
  assert((await conversationStore.get(scopedKeep))?.history.length === 2, "clear must preserve a different SQLite scope")
  await restartSqlite()
  assert.equal(await conversationStore.get(scopedA), null, "clear deletion must survive a SQLite restart")
  assert.equal(await conversationStore.get(scopedB), null, "all clear matches must remain deleted after restart")

  // 作用域清理必须区分大小写：字母型 user_id 不得因 SQLite LIKE 的 ASCII
  // 大小写不敏感，误删仅大小写不同的其他用户会话。
  const caseLower = "runtime-p1:p:case-user"
  const caseUpper = "runtime-p1:p:CASE-user"
  await conversationStore.save({ id: caseLower, history: [{ role: "user", content: "lower" }] })
  await conversationStore.save({ id: caseUpper, history: [{ role: "user", content: "upper" }] })
  assert.deepEqual(
    await conversationStore.clearScopeKeys({ isGroup: false, userIds: ["case-user"] }),
    [caseLower],
    "clearScopeKeys must match user ids case-sensitively",
  )
  assert.equal((await conversationStore.get(caseUpper))?.history?.length, 1, "a key differing only by case must survive scoped clearing")
  await conversationStore.clearKeys([caseUpper])

  const allA = "runtime-p1:p:clear-all-a"
  const allB = "runtime-p1:g:clear-all-group:clear-all-b"
  await saveAndLoad(allA, "clear all A")
  await saveAndLoad(allB, "clear all B")
  assert((await chatService.clearAll()) >= 3, "clearAll must report the union of in-memory and persistent conversations")
  assert.equal(chatService.listConversations().length, 0, "clearAll must empty the memory map")
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM conversations")).total, 0, "clearAll must empty the SQLite table")
  await restartSqlite()
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM conversations")).total, 0, "clearAll deletion must survive a SQLite restart")

  const originalRunObservedStep = chatService.runObservedStep
  const originalConversationSave = conversationStore.save
  try {
    chatService.runObservedStep = async () => successfulStep("delayed save reply")
    const saveEntered = deferred()
    const releaseSave = deferred()
    conversationStore.save = async payload => {
      saveEntered.resolve()
      await releaseSave.promise
      return originalConversationSave.call(conversationStore, payload)
    }
    const keyRaceEvent = { isGroup: false, user_id: "race-key-user", sender: { nickname: "race key" } }
    const keyRaceKey = "mock:p:race-key-user"
    const keyRaceSend = chatService.send(keyRaceEvent, "race clearByKeys", {
      channelId: "mock",
      source: "runtime-p1-race",
      applyInputFilters: false,
      disableTools: true,
      persistMemory: false,
    })
    await withTimeout(saveEntered.promise, 5000, "conversation save entry")
    const keyRaceClear = chatService.clearByKeys([keyRaceKey])
    releaseSave.resolve()
    await keyRaceSend
    await keyRaceClear
    assert(!chatService.listConversations().some(item => item.key === keyRaceKey), "clearByKeys racing an in-flight save must remove the memory entry")
    assert.equal(await conversationStore.get(keyRaceKey), null, "clearByKeys racing an in-flight save must leave SQLite deleted")

    conversationStore.save = originalConversationSave
    const serializedKey = "mock:p:race-new-send-user"
    const serializedEvent = { isGroup: false, user_id: "race-new-send-user", sender: { nickname: "race new send" } }
    await conversationStore.save({ id: serializedKey, history: [{ role: "user", content: "OLD_HISTORY_MUST_NOT_BE_USED" }, { role: "assistant", content: "old reply" }] })
    chatService.conversations.delete(serializedKey)
    const originalClearKeys = conversationStore.clearKeys
    const deleteEntered = deferred()
    const releaseDelete = deferred()
    conversationStore.clearKeys = async keys => {
      deleteEntered.resolve()
      await releaseDelete.promise
      return originalClearKeys.call(conversationStore, keys)
    }
    let observedHistory = null
    chatService.runObservedStep = async options => {
      observedHistory = options.history
      return successfulStep("new send after clear")
    }
    const serializedClear = chatService.clearByKeys([serializedKey])
    await withTimeout(deleteEntered.promise, 5000, "serialized clear entry")
    const serializedSend = chatService.send(serializedEvent, "new prompt", {
      channelId: "mock",
      source: "runtime-p1-race",
      applyInputFilters: false,
      disableTools: true,
      persistMemory: false,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(observedHistory, null, "a new send must wait while the preceding clear is deleting")
    releaseDelete.resolve()
    await serializedClear
    await serializedSend
    assert.deepEqual(observedHistory, [], "a new send after clear must not receive the deleted history")
    assert(!(await conversationStore.get(serializedKey)).history.some(item => String(item.content).includes("OLD_HISTORY_MUST_NOT_BE_USED")), "a new send after clear must not persist deleted history")
    conversationStore.clearKeys = originalClearKeys

    // 同一会话 key 的并发发送不能互相整份覆盖：写回在串行队列内基于最新历史追加。
    const dualKey = "mock:p:race-dual-user"
    const dualEvent = { isGroup: false, user_id: "race-dual-user", sender: { nickname: "race dual" } }
    let dualEntered = 0
    const bothDualEntered = deferred()
    const releaseDual = deferred()
    chatService.runObservedStep = async ({ prompt: dualPrompt }) => {
      dualEntered += 1
      if (dualEntered >= 2) bothDualEntered.resolve()
      await releaseDual.promise
      return successfulStep(`dual reply ${dualPrompt}`)
    }
    const dualSendA = chatService.send(dualEvent, "dual prompt A", {
      channelId: "mock",
      source: "runtime-p1-race",
      applyInputFilters: false,
      disableTools: true,
      persistMemory: false,
    })
    const dualSendB = chatService.send(dualEvent, "dual prompt B", {
      channelId: "mock",
      source: "runtime-p1-race",
      applyInputFilters: false,
      disableTools: true,
      persistMemory: false,
    })
    await withTimeout(bothDualEntered.promise, 5000, "dual send entry")
    releaseDual.resolve()
    await Promise.all([dualSendA, dualSendB])
    const dualStored = await conversationStore.get(dualKey)
    assert.equal(dualStored?.history?.length, 4, "concurrent sends on one key must keep both turns")
    for (const marker of ["dual prompt A", "dual prompt B"]) {
      assert(dualStored.history.some(item => item.content === marker), `merged history must contain "${marker}"`)
    }

    // <EMPTY> 静默回复：不得写入历史，但必须延长持久层 expires_at，
    // 否则持续空回复的会话会在 SQLite 先过期。
    const emptyKey = "mock:p:empty-reply-user"
    const emptyEvent = { isGroup: false, user_id: "empty-reply-user", sender: { nickname: "empty reply" } }
    await conversationStore.save({ id: emptyKey, history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] })
    await sqliteClient.run("UPDATE conversations SET last_seen_at = last_seen_at - 600000, expires_at = expires_at - 600000 WHERE conversation_key = ?", [emptyKey])
    const emptyBefore = await sqliteClient.get("SELECT expires_at FROM conversations WHERE conversation_key = ?", [emptyKey])
    chatService.conversations.delete(emptyKey)
    chatService.runObservedStep = async () => successfulStep("<EMPTY>")
    const emptyResult = await chatService.send(emptyEvent, "stay silent", {
      channelId: "mock",
      source: "runtime-p1-race",
      applyInputFilters: false,
      disableTools: true,
      persistMemory: false,
    })
    assert.equal(emptyResult.text, "", "<EMPTY> replies must normalize to empty text")
    const emptyStored = await sqliteClient.get("SELECT history_json, expires_at FROM conversations WHERE conversation_key = ?", [emptyKey])
    assert(Number(emptyStored.expires_at) > Number(emptyBefore.expires_at), "an <EMPTY> reply must extend the persistent expires_at")
    assert.equal(JSON.parse(emptyStored.history_json).length, 2, "<EMPTY> turns must not append to the stored history")
    assert(!String(emptyStored.history_json).includes("EMPTY"), "<EMPTY> must not be written into the stored history")
    await chatService.clearByKeys([emptyKey])

    const scopeStarted = deferred()
    const releaseScopeReply = deferred()
    chatService.runObservedStep = async () => {
      scopeStarted.resolve()
      await releaseScopeReply.promise
      return successfulStep("scope reply still returns")
    }
    const scopeRaceEvent = { isGroup: false, user_id: "race-scope-user", sender: { nickname: "race scope" } }
    const scopeRaceKey = "mock:p:race-scope-user"
    const scopeRaceSend = chatService.send(scopeRaceEvent, "race scope clear", {
      channelId: "mock",
      source: "runtime-p1-race",
      applyInputFilters: false,
      disableTools: true,
      persistMemory: false,
    })
    await withTimeout(scopeStarted.promise, 5000, "scope race model step")
    assert.equal(await conversationStore.get(scopeRaceKey), null, "the racing scope key must not exist before clear")
    await chatService.clear(scopeRaceEvent)
    releaseScopeReply.resolve()
    assert.equal((await scopeRaceSend).text, "scope reply still returns", "a cleared in-flight request may still return its current reply")
    assert(!chatService.listConversations().some(item => item.key === scopeRaceKey), "scope clear must tombstone an in-flight key that was not yet in memory")
    assert.equal(await conversationStore.get(scopeRaceKey), null, "scope clear must prevent the in-flight key from being inserted into SQLite")

    const allStarted = deferred()
    const releaseAllReply = deferred()
    chatService.runObservedStep = async () => {
      allStarted.resolve()
      await releaseAllReply.promise
      return successfulStep("clear all reply still returns")
    }
    const allRaceEvent = { isGroup: false, user_id: "race-all-user", sender: { nickname: "race all" } }
    const allRaceKey = "mock:p:race-all-user"
    const allRaceSend = chatService.send(allRaceEvent, "race clear all", {
      channelId: "mock",
      source: "runtime-p1-race",
      applyInputFilters: false,
      disableTools: true,
      persistMemory: false,
    })
    await withTimeout(allStarted.promise, 5000, "clearAll race model step")
    await chatService.clearAll()
    releaseAllReply.resolve()
    assert.equal((await allRaceSend).text, "clear all reply still returns", "clearAll must not suppress the current reply")
    assert(!chatService.listConversations().some(item => item.key === allRaceKey), "clearAll must invalidate every in-flight conversation write")
    assert.equal(await conversationStore.get(allRaceKey), null, "clearAll must prevent a later SQLite resurrection")
    await restartSqlite()
    assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM conversations")).total, 0, "racing clears must remain deleted after restart")
  } finally {
    chatService.runObservedStep = originalRunObservedStep
    conversationStore.save = originalConversationSave
  }

  const logStart = Date.now()
  modelLogStore.start(configStore.get())
  const channel = {
    name: "runtime-p1-model",
    type: "mock",
    model: "runtime-p1-model",
    provider: { name: "runtime-p1-provider" },
    modelConfig: { name: "runtime-p1-model" },
  }
  const event = { isGroup: true, group_id: "runtime-p1-group", user_id: "runtime-p1-user" }
  const normalPrompt = "NORMAL_PROMPT_MUST_NOT_PERSIST api_key=NORMAL_PROMPT_SECRET"
  const normalResponse = "NORMAL_RESPONSE_MUST_NOT_PERSIST"
  const normalTrace = modelLogStore.createTrace({
    event,
    source: "runtime-p1-chat",
    purpose: "reply",
    conversationKey: "runtime-p1:p:log",
    prompt: normalPrompt,
    metadata: { authorization: "Bearer NORMAL_TRACE_CREDENTIAL" },
  })
  const normalCall = modelLogStore.beginModelCall({
    trace: normalTrace,
    event,
    source: "runtime-p1-chat",
    purpose: "reply",
    channel,
    messages: [{ role: "user", content: "NORMAL_CALL_INPUT_MUST_NOT_PERSIST cookie=NORMAL_COOKIE_SECRET" }],
    tools: [{ name: "snapshot_tool", common: { description: "快照测试工具", parameters: { type: "object", properties: {} }, source: "builtin", category: "network" } }],
    metadata: {
      apiKey: "NORMAL_CALL_CREDENTIAL",
      context: { phase: "initial", total: { messageCount: 1, chars: 64, tokenEstimate: 16 } },
    },
    snapshotMetadata: {
      context: {
        phase: "initial",
        total: { messageCount: 1, chars: 64, tokenEstimate: 16 },
        sections: [{ source: "current", label: "当前提问", count: 1, chars: 64, tokenEstimate: 16, content: "SNAPSHOT_ONLY_CONTEXT_DETAIL" }],
      },
    },
  })
  modelLogStore.completeModelCall(normalCall, { response: { text: normalResponse, usage: { input: 2, output: 3, total: 5, source: "reported" } } })
  modelLogStore.finishTrace(normalTrace, { status: "ok", response: normalResponse })

  const jsonSecret = "P1_JSON_SECRET_123"
  const basicSecret = "P1_BASIC_SECRET_456"
  const rawToken = "sk-p1rawsecret12345"
  const exactAddress = "上海市浦东新区世纪大道100号2栋301室"
  const separatedPhone = "138-0013-8000"
  const punctuatedPhone = "+86 (138) 1234.5678"
  const contextualAddress = "我住在上海市浦东新区花木路100号2栋301室"
  const retainedFact = "我喜欢手冲咖啡"
  const auditTrace = modelLogStore.createTrace({
    event,
    source: "group-memory-consolidation",
    purpose: "memory-consolidation",
    prompt: "AUDIT_RUN_PROMPT_MUST_NOT_PERSIST",
    metadata: { cookie: "AUDIT_TRACE_COOKIE" },
  })
  const auditCall = modelLogStore.beginModelCall({
    trace: auditTrace,
    event,
    source: "group-memory-consolidation",
    purpose: "memory-consolidation",
    channel,
    messages: [{
      role: "user",
      content: `${retainedFact}。电话：${separatedPhone}，备用电话：${punctuatedPhone}。收货地址：${exactAddress}。${contextualAddress}。{\"apiKey\":\"${jsonSecret}\"} Authorization: Basic ${basicSecret} token=${rawToken}`,
    }],
    metadata: { credential: "AUDIT_CALL_CREDENTIAL" },
  })
  modelLogStore.completeModelCall(auditCall, { response: { text: "AUDIT_RESPONSE_MUST_NOT_PERSIST", usage: { input: 4, output: 2, total: 6, source: "reported" } } })
  modelLogStore.finishTrace(auditTrace, { status: "ok", response: "AUDIT_RESPONSE_MUST_NOT_PERSIST" })
  assert.equal(await modelLogStore.flush(true), true, "model log queue must flush")

  const normalRunRow = await sqliteClient.get("SELECT prompt_text, response_text, metadata_json FROM ai_runs WHERE id=?", [normalTrace.id])
  const normalCallRow = await sqliteClient.get("SELECT input_text, metadata_json FROM model_call_events WHERE id=?", [normalCall.id])
  assert(normalRunRow.prompt_text.includes("NORMAL_PROMPT_MUST_NOT_PERSIST") && !normalRunRow.prompt_text.includes("NORMAL_PROMPT_SECRET"), "conversation log index must retain a redacted turn prompt")
  assert.deepEqual({ response: normalRunRow.response_text, input: normalCallRow.input_text }, { response: normalResponse, input: "" }, "ordinary model logs must retain the redacted final response while keeping legacy compact call input empty")
  assert(!`${normalRunRow.metadata_json} ${normalCallRow.metadata_json}`.includes("NORMAL_TRACE_CREDENTIAL"), "run credentials must be redacted from metadata")
  assert(!`${normalRunRow.metadata_json} ${normalCallRow.metadata_json}`.includes("NORMAL_CALL_CREDENTIAL"), "call credentials must be redacted from metadata")
  assert(!normalCallRow.metadata_json.includes("SNAPSHOT_ONLY_CONTEXT_DETAIL"), "compact model call metadata must not contain full context section content")
  const normalCallDetail = await modelLogStore.getModelCallDetail(normalCall.id)
  assert.equal(normalCallDetail.snapshot.message_count, 1, "model call detail must expose the captured message count")
  assert.equal(normalCallDetail.snapshot.tools[0].function.name, "snapshot_tool", "model call detail must expose the exact injected tool definition")
  assert(normalCallDetail.snapshot.messages[0].content.includes("NORMAL_CALL_INPUT_MUST_NOT_PERSIST") && !normalCallDetail.snapshot.messages[0].content.includes("NORMAL_COOKIE_SECRET"), "model call snapshots must redact secrets in context content")
  assert.equal(normalCallDetail.snapshot.request.metadata.context.sections[0].content, "SNAPSHOT_ONLY_CONTEXT_DETAIL", "model request detail must retain full context section content separately")
  const normalConversation = await modelLogStore.getConversation(normalTrace.id)
  assert.equal(normalConversation.items.length, 1, "conversation detail must expose the current top-level turn")
  assert(normalConversation.items[0].prompt_text.includes("NORMAL_PROMPT_MUST_NOT_PERSIST"), "conversation detail must expose the turn prompt")

  const auditRunRow = await sqliteClient.get("SELECT prompt_text, response_text, metadata_json FROM ai_runs WHERE id=?", [auditTrace.id])
  const auditCallRow = await sqliteClient.get("SELECT input_text, metadata_json FROM model_call_events WHERE id=?", [auditCall.id])
  assert.equal(auditRunRow.prompt_text, "", "memory audit runs must still omit the raw prompt")
  assert.equal(auditRunRow.response_text, "", "memory audit runs must still omit the raw response")
  assert(auditCallRow.input_text.includes(retainedFact), "memory consolidation audit must retain useful non-sensitive facts")
  assert(auditCallRow.input_text.includes("<redacted"), "memory consolidation audit must visibly redact sensitive values")
  for (const secret of [jsonSecret, basicSecret, rawToken, exactAddress, separatedPhone, punctuatedPhone, contextualAddress, "AUDIT_TRACE_COOKIE", "AUDIT_CALL_CREDENTIAL"]) {
    assert(!`${auditCallRow.input_text} ${auditRunRow.metadata_json} ${auditCallRow.metadata_json}`.includes(secret), `memory audit logs must not contain ${secret}`)
  }

  // 带筛选的日志清理必须同步扣减日汇总；扣到 0 的聚合行一并删除。
  assert((await modelLogStore.summary({ from: logStart })).totals.calls >= 2, "daily rollup must contain the logged calls before cleanup")
  const filteredCleanup = await modelLogStore.cleanup({ filters: { model: "runtime-p1-model" } })
  assert.equal(filteredCleanup.runs, 2)
  assert.equal(filteredCleanup.modelCalls, 2)
  assert.equal((await modelLogStore.summary({ from: logStart })).totals.calls, 0, "filtered log cleanup must decrement the daily rollup")
  assert.equal(Number((await sqliteClient.get("SELECT COUNT(*) AS total FROM ai_usage_daily"))?.total), 0, "empty rollup rows must be removed")
  assert.equal(Number((await sqliteClient.get("SELECT COUNT(*) AS total FROM ai_runs"))?.total), 0, "filtered cleanup must delete the matched runs")

  // 并发两次带筛选清理只能对日汇总扣减一次：第二次的 SELECT 快照必须在第一次
  // 删除之后取得（清理串行链），否则同一批终态调用会被扣两遍、殃及未命中的行。
  const logCleanupCall = (userId, tokens) => {
    const cleanupEvent = { isGroup: false, user_id: userId }
    const cleanupTrace = modelLogStore.createTrace({ event: cleanupEvent, source: "runtime-p1-cleanup", purpose: "cleanup-check" })
    const cleanupCall = modelLogStore.beginModelCall({
      trace: cleanupTrace,
      event: cleanupEvent,
      source: "runtime-p1-cleanup",
      purpose: "cleanup-check",
      channel: { name: "runtime-p1-cleanup-model", type: "mock", model: "runtime-p1-cleanup-model", modelConfig: { name: "runtime-p1-cleanup-model" } },
      messages: [{ role: "user", content: "cleanup fixture" }],
    })
    modelLogStore.completeModelCall(cleanupCall, { response: { text: "ok", usage: { input: tokens, output: tokens, total: tokens * 2, source: "reported" } } })
    modelLogStore.finishTrace(cleanupTrace, { status: "ok", response: "ok" })
  }
  logCleanupCall("cleanup-user-a", 2)
  logCleanupCall("cleanup-user-b", 5)
  assert.equal(await modelLogStore.flush(true), true, "cleanup fixtures must flush")
  assert.deepEqual(
    await sqliteClient.get("SELECT calls, input_tokens FROM ai_usage_daily WHERE model_name=? AND purpose=?", ["runtime-p1-cleanup-model", "cleanup-check"]),
    { calls: 2, input_tokens: 7 },
    "both cleanup fixtures must land in one rollup row",
  )
  const [concurrentCleanupA, concurrentCleanupB] = await Promise.all([
    modelLogStore.cleanup({ filters: { userId: "cleanup-user-a" } }),
    modelLogStore.cleanup({ filters: { userId: "cleanup-user-a" } }),
  ])
  assert.equal(concurrentCleanupA.runs + concurrentCleanupB.runs, 1, "concurrent filtered cleanups must delete the matched run exactly once")
  assert.deepEqual(
    await sqliteClient.get("SELECT calls, input_tokens FROM ai_usage_daily WHERE model_name=? AND purpose=?", ["runtime-p1-cleanup-model", "cleanup-check"]),
    { calls: 1, input_tokens: 5 },
    "concurrent filtered cleanups must decrement the rollup exactly once and spare the other user's usage",
  )
  await modelLogStore.cleanup({ filters: { model: "runtime-p1-cleanup-model" } })

  console.log("ok runtime-p1")
} finally {
  await legacyWorker?.terminate().catch(() => {})
  await modelLogStore?.stop({ flush: true }).catch(() => {})
  await sqliteClient?.close().catch(() => {})
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}

process.exit(0)
