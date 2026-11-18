import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:http"
import { once } from "node:events"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-langfuse-"))
process.env.YUI_CHAT_PLUGIN_ROOT = root
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.chdir(path.resolve(root, "../.."))
global.logger = Object.fromEntries(["mark", "info", "warn", "error", "debug"].map(name => [name, () => {}]))
global.Bot = { express: null, wsf: {}, uin: [] }
global.plugin = class {}

const originalFetch = global.fetch
const requests = []
let responseStatus = 200, partialRejected = 0, sqliteClient, singleton
let privateServer, privateOrigin = ""
const reporters = []
global.fetch = async (url, options) => {
  if (privateOrigin && String(url).startsWith(privateOrigin + "/")) return originalFetch(url, options)
  assert.equal(String(url), "https://cloud.langfuse.com/api/public/otel/v1/traces", "tests must never contact Cloud or model providers")
  requests.push({ url: String(url), ...options, body: JSON.parse(options.body) })
  return new Response(JSON.stringify({ partialSuccess: { rejectedSpans: String(partialRejected) } }), { status: responseStatus })
}
const attrs = span => Object.fromEntries(span.attributes.map(item => [item.key, item.value.stringValue ?? item.value.doubleValue]))
const spans = request => request.body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
const usage = { input: 10, output: 2, total: 12, cached: 3, reasoning: 1, source: "reported", inputKnown: true, outputKnown: true, totalKnown: true }
const channel = { id: "fixture", name: "fixture", type: "langfuse-fixture", model: "fixture-model", apiProvider: "fixture-provider", apiKey: "private-provider-key" }
const event = { user_id: "private-user-10001", self_id: "private-bot-10002", isGroup: true, group_id: "private-group-10003" }
const callOptions = { operation: "chat", channel, input: [{ role: "user", content: "hello" }], purpose: "chat" }

try {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  assert.equal(defaults.logging.langfuse.baseUrl, "https://jp.cloud.langfuse.com")
  const { configStore } = await import("../output/runtime/config/store.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { normalizeLangfuseBaseUrl } = await import("../output/runtime/config/langfuse.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  const { LangfuseReporter, langfuseReporter, langfuseContent } = await import("../output/runtime/core/observability/langfuse.js")
  singleton = langfuseReporter
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { chatService } = await import("../output/runtime/core/chat/chat-service.js")
  const { conversationStore } = await import("../output/runtime/core/chat/conversation-store.js")
  const { modelLogStore } = await import("../output/runtime/core/observability/model-log.js")
  await configStore.load()
  await configStore.update(config => {
    config.logging.level = "off"
    Object.assign(config.logging.langfuse, { enabled: true, baseUrl: "https://cloud.langfuse.com", publicKey: "pk-lf-fixture", secretKey: "sk-lf-fixture", backgroundSampleRate: 1 })
  })
  modelLogStore.configure(configStore.get())
  const settings = () => structuredClone(configStore.get().logging.langfuse)
  const fixture = (name, patch = {}, send) => {
    const config = { logging: { langfuse: { ...settings(), publicKey: `pk-lf-${name}`, ...patch } } }
    let now = Date.UTC(2026, 0, 20)
    const sent = []
    const reporter = new LangfuseReporter({ config: () => config, now: () => now, send: send || (async (_settings, items) => { sent.push(...structuredClone(items)) }) })
    reporters.push(reporter)
    return { reporter, config, sent, advance: ms => { now += ms }, setTime: value => { now = value } }
  }
  const invoke = async (reporter, e = event, options = callOptions, result = { text: "reply", usage }) => {
    await reporter.withConversation(e, "chat", async () => reporter.complete(await reporter.begin(options), result))
    await reporter.flush()
  }

  // Real Registry entry points, actual SQLite outbox, and OTLP HTTP serialization.
  adapterRegistry.register({
    id: channel.type, protocol: "fixture", supportsTools: true, supportsRerank: true, supportsImageGeneration: true, supportsDecision: true,
    async sendMessage() { return { id: "fixture", text: "reply", toolCalls: [], usage } },
    async embedTexts({ texts }) { return { vectors: texts.map(() => [0.123456789, 0.987654321]), dimensions: 2, usage } },
    async rerank({ documents }) { return { results: documents.map((_, index) => ({ index, score: 1 / (index + 1) })), usage } },
    async generateImages() { return { images: [], usage } },
    async decide() { return { answers: { reply: true }, usage } },
  })
  await singleton.withConversation(event, "firstPerson", async () => {
    await adapterRegistry.embedTexts({ channel, texts: ["document-a", "document-b"] })
    await adapterRegistry.rerank({ channel, query: "query", documents: ["document-a", "document-b"] })
    await adapterRegistry.sendMessage({ channel, messages: [{ role: "user", content: "DO-NOT-UPLOAD-THIS" }] })
    await adapterRegistry.generateImages({ channel, prompt: "DO-NOT-UPLOAD-IMAGE-PROMPT" })
    await adapterRegistry.decide({ channel, state: "DO-NOT-UPLOAD-STATE", questions: { reply: "Should reply?" } })
  })
  await singleton.flush()
  assert.equal(requests.length, 1)
  const first = spans(requests[0])
  assert.equal(first.length, 5, "one observation per real model invocation, no wrappers")
  assert.equal(new Set(first.map(span => span.traceId)).size, 1)
  assert.equal(first.filter(span => !span.parentSpanId).length, 1)
  const rootSpan = first.find(span => !span.parentSpanId)
  assert(first.every(span => !span.parentSpanId || span.parentSpanId === rootSpan.spanId))
  assert.deepEqual(new Set(first.map(span => attrs(span)["langfuse.observation.type"])), new Set(["generation", "embedding", "retriever"]))
  assert(first.every(span => attrs(span)["langfuse.observation.model.name"] === channel.model))
  assert.equal(attrs(first.find(span => span.name === "yui-chat.embedding"))["langfuse.observation.metadata.input_count"], 2, "batch input stays one observation")
  assert.equal((await singleton.stats()).reservedUnits, 6, "one Trace plus five model observations")
  assert.equal(requests[0].headers.Authorization, `Basic ${Buffer.from("pk-lf-fixture:sk-lf-fixture").toString("base64")}`)
  assert.equal(requests[0].headers["x-langfuse-ingestion-version"], "4")
  assert.equal(requests[0].redirect, "error")
  const body = JSON.stringify(requests[0].body)
  for (const secret of ["DO-NOT-UPLOAD", event.user_id, event.self_id, event.group_id, "private-provider-key", "sk-lf-fixture", "pk-lf-fixture", "0.123456789"]) assert(!body.includes(secret), secret)
  assert(!first.some(span => attrs(span)["langfuse.observation.input"]), "content disabled by default")
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS n FROM ai_runs")).n, 0, "Cloud telemetry does not turn on local usage logging")

  const traceId = first[0].traceId
  const sessionId = attrs(first[0])["langfuse.session.id"]
  await invoke(singleton, event, { ...callOptions, channel: { ...channel, id: "changed", model: "other-model" } })
  assert.equal(spans(requests.at(-1))[0].traceId, traceId, "turns and model switches reuse session")
  const historyKey = `fixture:g:${event.group_id}:${event.user_id}`
  await conversationStore.save({ id: historyKey, history: [{ role: "user", content: "old" }] })
  await sqliteClient.run("UPDATE conversations SET expires_at=0 WHERE conversation_key=?", [historyKey])
  assert.equal(await conversationStore.get(historyKey), null)
  await invoke(singleton)
  assert.equal(spans(requests.at(-1))[0].traceId, traceId, "history TTL must not rotate telemetry session")
  await chatService.clearAll({ preserveObservationSessions: true })
  await singleton.stop()
  await sqliteClient.close()
  await sqliteClient.init(defaults)
  const restarted = fixture("unused")
  restarted.config.logging.langfuse = settings()
  await invoke(restarted.reporter)
  assert.equal(restarted.sent[0].traceId, traceId, "durable identity survives process/reporter restart")
  assert.equal(attrs(restarted.sent[0])["langfuse.session.id"], sessionId)
  await chatService.clear(event)
  await invoke(restarted.reporter)
  assert.notEqual(restarted.sent.at(-1).traceId, traceId, "explicit end rotates even if no history remains")
  const beforeDelete = restarted.sent.at(-1).traceId
  await chatService.clearByKeys([historyKey])
  await invoke(restarted.reporter)
  assert.notEqual(restarted.sent.at(-1).traceId, beforeDelete)
  const beforeAll = restarted.sent.at(-1).traceId
  await chatService.clearAll()
  await invoke(restarted.reporter)
  assert.notEqual(restarted.sent.at(-1).traceId, beforeAll)
  for (const changed of [{ user_id: "other-user" }, { self_id: "other-bot" }, { group_id: "other-group" }, { isGroup: false }]) await invoke(restarted.reporter, { ...event, ...changed })
  assert.equal(new Set(restarted.sent.slice(-5).map(span => span.traceId)).size, 5, "account/user/group/private scopes isolate")

  const concurrent = fixture("concurrent")
  const calls = await Promise.all([1, 2].map(() => concurrent.reporter.withConversation(event, "chat", () => concurrent.reporter.begin(callOptions))))
  concurrent.reporter.complete(calls[1], { text: "second finishes first", usage })
  concurrent.reporter.complete(calls[0], { text: "first finishes last", usage })
  await concurrent.reporter.flush()
  assert.equal(new Set(concurrent.sent.map(span => span.traceId)).size, 1)
  assert.equal(concurrent.sent.filter(span => !span.parentSpanId).length, 1, "concurrent first calls claim one actual root")
  assert.equal((await concurrent.reporter.stats()).reservedUnits, 3)
  // Late calls from the ended conversation remain attached to their original identity.
  const late = await concurrent.reporter.withConversation(event, "chat", () => concurrent.reporter.begin(callOptions))
  await concurrent.reporter.resetScopes([`g:${event.group_id}:${event.user_id}`])
  await invoke(concurrent.reporter)
  const newTrace = concurrent.sent.at(-1).traceId
  concurrent.reporter.complete(late, { text: "late", usage })
  await concurrent.reporter.flush()
  assert.notEqual(concurrent.sent.at(-1).traceId, newTrace)

  const limited = fixture("limit", { monthlyUnitLimit: 2 })
  await invoke(limited.reporter)
  await invoke(limited.reporter)
  assert.equal(limited.sent.length, 1)
  assert.equal((await limited.reporter.stats()).reservedUnits, 2)
  limited.config.logging.langfuse.environment = "test"
  await invoke(limited.reporter)
  assert.equal(limited.sent.length, 1, "changing environment cannot evade budget")
  limited.config.logging.langfuse.baseUrl = "HTTPS://CLOUD.LANGFUSE.COM:443/"
  await invoke(limited.reporter)
  assert.equal(limited.sent.length, 1, "equivalent Cloud URL spellings cannot reset budget")
  limited.setTime(Date.UTC(2026, 1, 1))
  await invoke(limited.reporter)
  assert.equal(limited.sent.length, 2, "UTC monthly budget resets")
  const zero = fixture("zero", { monthlyUnitLimit: 0 })
  await invoke(zero.reporter)
  assert.equal(zero.sent.length, 0)
  const sampled = fixture("sampled", { sampleRate: 0, backgroundSampleRate: 0 })
  await invoke(sampled.reporter)
  sampled.reporter.complete(await sampled.reporter.begin(callOptions), { text: "background", usage })
  await sampled.reporter.flush()
  assert.equal(sampled.sent.length, 0)
  assert.equal((await sampled.reporter.stats()).skipped, 2)
  const disabled = fixture("disabled", { enabled: false })
  assert.equal(await disabled.reporter.begin(callOptions), null)
  assert.equal(await concurrent.reporter.begin({ ...callOptions, purpose: "model-test" }), null)

  let fail = true
  const attempts = []
  const retry = fixture("retry", {}, async (_settings, items) => { attempts.push(structuredClone(items)); if (fail) throw new Error("sensitive transport failure") })
  await invoke(retry.reporter)
  assert.equal((await retry.reporter.stats()).retrying, 1)
  await retry.reporter.flush()
  assert.equal(attempts.length, 1, "retry backoff")
  retry.advance(5001)
  fail = false
  await retry.reporter.flush()
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[1], attempts[0], "retry uses immutable span and IDs")
  assert.equal((await retry.reporter.stats()).pending, 0)

  const backlog = fixture("backlog", { monthlyUnitLimit: 2 }, async () => { throw new Error("offline") })
  await invoke(backlog.reporter)
  backlog.setTime(Date.UTC(2026, 1, 1))
  backlog.config.logging.langfuse.monthlyUnitLimit = 1
  await backlog.reporter.flush()
  assert.equal((await backlog.reporter.stats()).reservedUnits, 0, "old backlog must reserve delivery-month budget")
  backlog.config.logging.langfuse.monthlyUnitLimit = 2
  await backlog.reporter.flush()
  assert.equal((await backlog.reporter.stats()).reservedUnits, 2)
  await sqliteClient.run("DELETE FROM langfuse_outbox", [])

  const fullQueue = fixture("full-queue")
  const multibyte = JSON.stringify({ padding: "测".repeat(3 * 1024 * 1024) })
  assert(multibyte.length < 8 * 1024 * 1024 && Buffer.byteLength(multibyte) > 8 * 1024 * 1024)
  await sqliteClient.run("INSERT INTO langfuse_outbox(id,target,payload_json,budget_month,units,created_at) VALUES('byte-cap','other-target',?,'2026-01',1,0)", [multibyte])
  await invoke(fullQueue.reporter)
  assert.equal(fullQueue.sent.length, 0, "queue size must count UTF-8 bytes, not Chinese character count")
  assert.equal((await fullQueue.reporter.stats()).reservedUnits, 0)
  await sqliteClient.run("DELETE FROM langfuse_outbox WHERE id='byte-cap'", [])

  const durable = fixture("write-failure")
  const toWrite = await durable.reporter.withConversation(event, "chat", () => durable.reporter.begin(callOptions))
  const transaction = sqliteClient.transaction.bind(sqliteClient)
  sqliteClient.transaction = async () => { throw new Error("disk unavailable") }
  try {
    durable.reporter.complete(toWrite, { text: "retained", usage })
    await assert.rejects(durable.reporter.flush())
    const status = await durable.reporter.stats()
    assert.equal(status.buffered, 1)
    assert(status.writeFailures > 0)
    assert(!JSON.stringify(status).includes("disk unavailable"))
  } finally { sqliteClient.transaction = transaction }
  await durable.reporter.flush()
  assert.equal(durable.sent.length, 1, "write failure cannot silently clear pending buffer")

  const content = fixture("content", { captureContent: true })
  await invoke(content.reporter, event, { ...callOptions, input: [{ role: "user", content: "hi sk-lf-fixture https://private.example/secret?token=abc" }, { apiKey: "private", embedding: [0.123456789], image_url: "data:image/png;base64," + "A".repeat(400) }] }, { text: "reply", toolCalls: [{ id: "call-1", name: "search", arguments: { q: "topic" } }], usage })
  const captured = attrs(content.sent[0])
  assert(Array.isArray(JSON.parse(captured["langfuse.observation.input"])))
  assert.equal(JSON.parse(captured["langfuse.observation.output"])[0].tool_calls[0].function.arguments, '{"q":"topic"}')
  for (const hidden of ["sk-lf-fixture", "private.example", "0.123456789", "AAAA"]) assert(!JSON.stringify(content.sent).includes(hidden))
  const estimated = { input: 20, output: 5, total: 25, cached: 0, reasoning: 0, source: "estimated", inputKnown: false, outputKnown: false, totalKnown: false }
  await invoke(content.reporter, event, callOptions, { text: "estimated", usage: estimated })
  assert(!attrs(content.sent.at(-1))["langfuse.observation.usage_details"], "estimates cannot masquerade as reported tokens")
  const failedCall = await content.reporter.withConversation(event, "chat", () => content.reporter.begin(callOptions))
  content.reporter.complete(failedCall, null, new Error("sk-lf-fixture sensitive-prompt"))
  await content.reporter.flush()
  assert.equal(content.sent.at(-1).status.code, 2)
  assert(!JSON.stringify(content.sent.at(-1)).includes("sensitive-prompt"))
  assert.equal(langfuseContent({ secret: "private" }).secret, "<omitted>")
  assert.equal(langfuseContent(new Uint8Array([1, 2, 3])), "<omitted-binary>")
  assert(!JSON.stringify(configStore.getPublic()).includes("sk-lf-fixture"))
  assert(!JSON.stringify(configStore.getPublic()).includes("pk-lf-fixture"))
  for (const baseUrl of ["https://langfuse.example.com", "http://localhost:3000", "http://192.168.1.8:3000/telemetry/", "https://langfuse.example.com:8443/team-a", "http://[::1]:3000"]) {
    const config = structuredClone(configStore.get())
    config.logging.langfuse.baseUrl = baseUrl
    assert.equal(validateConfig(config).ok, true, baseUrl)
  }
  assert.equal(normalizeLangfuseBaseUrl(" HTTPS://LANGFUSE.EXAMPLE.COM:443/telemetry/// "), "https://langfuse.example.com/telemetry")
  for (const baseUrl of ["ftp://langfuse.example.com", "file:///tmp/langfuse", "https://user:pass@langfuse.example.com", "https://langfuse.example.com?token=secret", "https://langfuse.example.com#project", "not-a-url", "https://langfuse.example.com\n", "https://langfuse.example.com\\path"]) assert.equal(normalizeLangfuseBaseUrl(baseUrl), null, baseUrl)
  for (const patch of [{ baseUrl: "ftp://langfuse.example.com" }, { baseUrl: "https://user:pass@langfuse.example.com" }, { baseUrl: "https://langfuse.example.com?token=secret" }, { sampleRate: 2 }, { monthlyUnitLimit: 50001 }, { secretKey: "bad\nkey" }, { environment: "Invalid Env" }]) {
    const config = structuredClone(configStore.get())
    Object.assign(config.logging.langfuse, patch)
    assert.equal(validateConfig(config).ok, false, JSON.stringify(patch))
  }

  // Exercise the default transport's HTTP and partial-success failure handling.
  singleton.start()
  responseStatus = 429
  await invoke(singleton)
  assert.equal((await singleton.stats()).retrying, 1)
  const retrySpanId = spans(requests.at(-1))[0].spanId
  responseStatus = 200
  partialRejected = 1
  await sqliteClient.run("UPDATE langfuse_outbox SET next_attempt_at=0", [])
  await singleton.flush()
  assert.equal((await singleton.stats()).retrying, 1, "partial rejection must remain queued")
  partialRejected = 0
  await sqliteClient.run("UPDATE langfuse_outbox SET next_attempt_at=0", [])
  await singleton.flush()
  assert.equal(spans(requests.at(-1))[0].spanId, retrySpanId)
  assert.equal((await singleton.stats()).pending, 0)

  // Real HTTP against a local self-hosted fixture: port, proxy prefix and redirect refusal.
  const privateRequests = []
  let redirectPrivate = false
  privateServer = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    privateRequests.push({ path: request.url, authorization: request.headers.authorization, ingestion: request.headers["x-langfuse-ingestion-version"], body: JSON.parse(Buffer.concat(chunks).toString()) })
    if (redirectPrivate) { response.writeHead(302, { Location: "/redirected-observations" }); response.end(); return }
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end("{}")
  })
  privateServer.listen(0, "127.0.0.1")
  await once(privateServer, "listening")
  privateOrigin = `http://127.0.0.1:${privateServer.address().port}`
  const privateConfig = { logging: { langfuse: { ...settings(), baseUrl: privateOrigin + "/telemetry/", publicKey: "pk-lf-private-fixture" } } }
  const privateReporter = new LangfuseReporter({ config: () => privateConfig })
  reporters.push(privateReporter)
  await invoke(privateReporter)
  assert.equal(privateRequests[0].path, "/telemetry/api/public/otel/v1/traces")
  assert.equal(privateRequests[0].authorization, `Basic ${Buffer.from("pk-lf-private-fixture:sk-lf-fixture").toString("base64")}`)
  assert.equal(privateRequests[0].ingestion, "4")
  const privateTraceId = spans(privateRequests[0])[0].traceId
  privateConfig.logging.langfuse.baseUrl = privateOrigin + "/telemetry"
  await invoke(privateReporter)
  assert.equal(spans(privateRequests[1])[0].traceId, privateTraceId, "trailing slash cannot rotate the session")
  privateConfig.logging.langfuse.baseUrl = privateOrigin + "/tenant-b"
  await invoke(privateReporter)
  assert.equal(privateRequests[2].path, "/tenant-b/api/public/otel/v1/traces")
  assert.notEqual(spans(privateRequests[2])[0].traceId, privateTraceId, "proxy paths identify distinct deployments")
  assert.equal((await privateReporter.stats()).reservedUnits, 2, "separate deployment budget")
  redirectPrivate = true
  await invoke(privateReporter)
  assert.equal((await privateReporter.stats()).retrying, 1)
  assert(!privateRequests.some(request => request.path === "/redirected-observations"), "credentials must not follow redirects")
  redirectPrivate = false
  await sqliteClient.run("UPDATE langfuse_outbox SET next_attempt_at=0", [])
  await privateReporter.flush()
  assert.equal((await privateReporter.stats()).pending, 0)

  // Render the real settings panel; stored keys must not populate its password fields.
  global.location = { pathname: "/yui-chat", hash: "", search: "" }
  global.localStorage = { getItem: () => null }
  const { createSSRApp } = await import("vue")
  const { renderToString } = await import("vue/server-renderer")
  const { components } = await import("../output/runtime/web/client/ui/components.js")
  const { LangfusePanel } = await import("../output/runtime/web/client/features/advanced/langfuse-panel.js")
  const clientSource = await fs.readFile(path.join(root, "output/runtime/web/client/features/advanced/langfuse-panel.js"), "utf8")
  const clientVersion = clientSource.match(/store\.js(\?v=[^"']+)/)?.[1] || ""
  const { store } = await import("../output/runtime/web/client/app/store/store.js" + clientVersion)
  store.config = configStore.getPublic()
  store.diagnostics = { runtime: { langfuse: await singleton.stats() } }
  const app = createSSRApp(LangfusePanel)
  for (const [name, component] of Object.entries(components)) app.component(name, component)
  const html = await renderToString(app)
  assert(html.includes("Langfuse 观测") && html.includes("已配置，留空保留"))
  assert(!html.includes("sk-lf-fixture") && !html.includes("pk-lf-fixture"))
  assert(html.includes('type="password"') && html.includes('type="checkbox"'))
  console.log("Langfuse checks passed: registry/OTLP, session lifecycle, concurrency, sampling, quota, durable retry, redaction, settings UI")
} finally {
  responseStatus = 200
  partialRejected = 0
  await singleton?.stop()
  for (const reporter of reporters) await reporter.stop()
  if (privateServer) await new Promise(resolve => privateServer.close(resolve))
  await sqliteClient?.close()
  global.fetch = originalFetch
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}
// 宿主被只读导入时会注册自身定时器；所有 fixture 资源已在 finally 关闭。
process.exit(0)
