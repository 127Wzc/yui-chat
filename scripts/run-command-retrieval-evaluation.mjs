import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import Database from "better-sqlite3"

// Explicit, opt-in live evaluation. Only command knowledge is sent to the configured
// embedding/rerank providers. All application writes use disposable database copies.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const output = path.resolve(option("--output", path.join(root, "cache/retrieval-evaluation-20261123")))
const workerMode = option("--worker", "")
const probe = args.includes("--probe")
const modes = ["lexical", "hybrid", "hybrid-rerank"]
const digest = value => crypto.createHash("sha256").update(value).digest("hex")
const selector = c => JSON.stringify([c.pluginKey, c.fnc, c.regexp, c.regexpFlags || ""])
const writeJson = (file, value) => fs.writeFile(path.join(output, file), JSON.stringify(value, null, 2) + "\n")
const fixtureFile = path.join(root, "scripts/fixtures/command-retrieval-source-benchmark.json")
const rawFixture = await fs.readFile(fixtureFile, "utf8")
const dataset = JSON.parse(rawFixture)

// Binding decisions are made before retrieval. Flattened source paths are accepted
// only when function and complete regex match. The two version variants are separately
// disclosed and never substituted into the strict, original-selector score.
const aliases = {
  "system-restart": { pluginKey: "other", fnc: "restart", regexp: "^#重启$", reason: "source path flattened; identical function and regex" },
  "system-stop": { pluginKey: "other", fnc: "stop", regexp: "^#关机$", reason: "source path flattened; identical function and regex" },
  "system-exit": { pluginKey: "other", fnc: "exit", regexp: "^#停(机|止)$", reason: "source path flattened; identical function and regex" },
  "system-recall": { pluginKey: "system", fnc: "recall", regexp: "^#?撤回$", reason: "source path flattened; identical function and regex" },
  "group-speak-rank": { pluginKey: "other", fnc: "speakRank", regexp: "^#发言(排行)?榜", reason: "source path flattened; identical function and regex" },
  "miao-detail": { pluginKey: "miao-plugin", fnc: "profileDetail", regexp: "^#*([^#]+)\\s*(详细|详情|面板|面版|圣遗物|遗器|武器[1-7]?|伤害([1-9]+\\d*)?)\\s*(\\d{9,10})*(.*[换].*)?$", reason: "snapshot variant: same character-detail handler; fewer change aliases" },
  "king-online": { pluginKey: "GloryOfKings-Plugin", fnc: "list", regexp: "^#(谁在(打游戏|玩王者|上号|排位)|王者在线(列表|状态)?|在线列表)$", reason: "snapshot variant: same online-list handler; lacks 打王者 alias" },
}

function bindings(documents) {
  const bySelector = new Map()
  for (const doc of documents) {
    const c = JSON.parse(doc.metadata_json).command || {}
    const key = selector(c)
    bySelector.set(key, [...(bySelector.get(key) || []), { ...c, documentId: doc.id }])
  }
  return dataset.targets.map(target => {
    const exactRows = bySelector.get(selector(target.selector)) || []
    assert(exactRows.length < 2, `ambiguous target selector: ${target.id}`)
    const exact = exactRows[0]
    const alias = aliases[target.id]
    const aliasRows = alias ? bySelector.get(selector({ ...alias, regexpFlags: "" })) || [] : []
    assert(aliasRows.length < 2, `ambiguous alias selector: ${target.id}`)
    const mapped = exact || aliasRows[0]
    return {
      targetId: target.id,
      status: exact ? "exact" : mapped ? "reviewed-alias" : "absent",
      original: target.selector,
      snapshot: mapped ? { pluginKey: mapped.pluginKey, fnc: mapped.fnc, regexp: mapped.regexp, regexpFlags: mapped.regexpFlags || "" } : null,
      commandId: mapped?.id || null,
      documentId: mapped?.documentId || null,
      reason: exact ? "full selector match" : mapped ? alias.reason : "target is not in this knowledge snapshot",
    }
  })
}

async function worker() {
  assert(modes.includes(workerMode))
  const privateRoot = path.join(output, ".private", workerMode)
  const storage = path.join(privateRoot, "data/yui-chat/storage")
  await fs.mkdir(storage, { recursive: true, mode: 0o700 })
  for (const name of ["state", "vectors"]) await fs.copyFile(path.join(output, ".private", `${name}.sqlite3`), path.join(storage, `${name}.sqlite3`))
  process.env.YUI_CHAT_RUNTIME_ROOT = privateRoot
  // Keep remote tracing disabled: the live providers receive only the retrieval
  // payload; the copied logs/config are never uploaded to an observability service.
  const db = new Database(path.join(storage, "state.sqlite3"))
  const stored = JSON.parse(db.prepare("SELECT overrides_json FROM runtime_config WHERE id=1").get().overrides_json)
  stored.logging = { ...stored.logging, enabled: false, langfuse: { ...stored.logging?.langfuse, enabled: false } }
  stored.knowledge ||= {}
  stored.knowledge.commandRetrieval = { ...stored.knowledge.commandRetrieval, mode: workerMode === "lexical" ? "lexical" : "hybrid" }
  stored.knowledge.retrieval = { ...stored.knowledge.retrieval, rerankEnabled: workerMode === "hybrid-rerank" }
  db.prepare("UPDATE runtime_config SET overrides_json=? WHERE id=1").run(JSON.stringify(stored))
  db.close()
  const runtime = relative => import(pathToFileURL(path.join(root, "output/runtime", relative)).href)
  const { configStore } = await runtime("config/store.js")
  const { sqliteClient } = await runtime("core/storage/sqlite/client.js")
  const { commandImports } = await runtime("knowledge/command-import.js")
  const { buildCommandDoc } = await runtime("knowledge/command-document-builder.js")
  const { cleanCommandRetrievalText } = await runtime("knowledge/command-retrieval-text.js")
  const { prepareCommandCompleteness } = await runtime("knowledge/command-completeness.js")
  const { buildCommandRecommendations } = await runtime("knowledge/command-query-service.js")
  const { commandPrefixes } = await runtime("core/message/command-prefixes.js")
  const { recommendCommandHybrid } = await runtime("knowledge/command-hybrid-retrieval.js")
  const { adapterRegistry } = await runtime("models/adapters/registry.js")
  const { modelLogStore } = await runtime("core/observability/model-log.js")
  let calls = []
  // Transparent instrumentation: invoke the unchanged real adapter, never generate
  // synthetic vectors/scores or intercept network responses.
  for (const method of ["embedTexts", "rerank"]) {
    const original = adapterRegistry[method].bind(adapterRegistry)
    adapterRegistry[method] = async options => {
      const started = performance.now()
      const call = { operation: method, model: options.channel?.model, ok: false }
      calls.push(call)
      try {
        const result = await original(options)
        call.ok = true
        call.usage = result.usage
        return result
      } catch (error) {
        // Provider messages can contain addresses or credentials; keep only class.
        call.errorType = error?.name || "Error"
        call.errorCode = error?.code || error?.cause?.code || null
        call.httpStatus = error?.status || error?.response?.status || null
        call.errorCategory = /ENOTFOUND|EAI_AGAIN|dns|resolve|getaddrinfo/i.test(String(error?.message) + String(error?.cause?.message)) ? "dns" : /401|unauthorized|invalid.*key/i.test(String(error?.message)) ? "authentication" : /403|forbidden/i.test(String(error?.message)) ? "forbidden" : /fetch|connect|ECONN|network/i.test(String(error?.message)) ? "network" : "other"
        throw error
      } finally { call.latencyMs = performance.now() - started }
    }
  }
  try {
    await configStore.load()
    assert(sqliteClient.status.available, "isolated state unavailable")
    if (workerMode !== "lexical") assert(sqliteClient.status.vector.available, "vector extension unavailable")
    const imported = await commandImports.list()
    let commands = imported.map(row => {
      const command = { ...row.metadata, id: row.id, title: row.title, metadata: row.metadata, retrievalText: cleanCommandRetrievalText(row.retrievalText, row.metadata), sourceId: row.sourceId, suggestedCommand: typeof row.metadata.suggestedCommand === "string" ? row.metadata.suggestedCommand : row.title, description: row.metadata.description || row.title, imported: true, enabled: row.enabled, commandEnabled: row.commandEnabled, pluginEnabled: row.pluginEnabled }
      return { ...buildCommandDoc(command), ...command }
    })
    await prepareCommandCompleteness(commands)
    const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"))
    const mapping = new Map(manifest.bindings.filter(b => b.commandId).map(b => [b.targetId, b]))
    const observer = {
      searchableCommands() { return commands.filter(row => row.enabled !== false) },
      recommendCommands(query, options) {
        return buildCommandRecommendations(this.searchableCommands(), query, { ...options, commandPrefixes: commandPrefixes(configStore.get()), minRelevance: configStore.get().knowledge?.retrieval?.minRelevance })
      },
    }
    const selected = probe ? dataset.cases.filter(c => c.kind === "positive").slice(0, 2) : dataset.cases
    const rows = []
    let consecutiveProviderFailures = 0
    for (const c of selected) {
      const removed = (c.context.deletedTargets || []).map(id => mapping.get(id)).filter(Boolean)
      const removedIds = new Set(removed.map(b => b.commandId))
      const savedDocs = [], savedChunks = []
      const originalCommands = commands
      // Remove only from the disposable snapshot; leaving stale vectors deliberately
      // exercises the production document join's exclusion of deleted knowledge.
      for (const binding of removed) {
        savedDocs.push(await sqliteClient.get("SELECT * FROM knowledge_documents WHERE id=?", [binding.documentId]))
        savedChunks.push(...await sqliteClient.all("SELECT * FROM knowledge_chunks WHERE document_id=?", [binding.documentId]))
      }
      if (removed.length) {
        await sqliteClient.transaction(removed.map(b => ({ sql: "DELETE FROM knowledge_documents WHERE id=?", params: [b.documentId] })))
        commands = commands.filter(row => !removedIds.has(row.id))
      }
      const event = { user_id: "retrieval-evaluation", group_id: c.context.channel === "group" ? "retrieval-evaluation" : "", isGroup: c.context.channel === "group", isMaster: c.context.role === "master" }
      const row = { caseId: c.id, kind: c.kind, queryType: c.queryType, split: c.split, query: c.query, status: "ok", deletionTargetsPresent: removed.length, deletionTargetsRequested: (c.context.deletedTargets || []).length }
      try {
        calls = []
        const started = performance.now()
        const result = await recommendCommandHybrid(observer, c.query, { event, limit: dataset.k, signal: AbortSignal.timeout(30000) })
        row.latencyMs = performance.now() - started
        row.calls = structuredClone(calls)
        row.retrieval = result.retrieval
        row.results = result.results.map(r => ({ id: r.id, pluginKey: r.pluginKey, fnc: r.fnc, regexp: r.regexp, regexpFlags: r.regexpFlags || "", suggestedCommand: r.recommendation?.command || r.suggestedCommand || "", priority: r.priority ?? null, pluginOrder: r.pluginOrder ?? null, ruleOrder: r.ruleOrder ?? null, retrievalMethod: r.retrievalMethod, fusionScore: r.fusionScore, vectorSimilarity: r.vectorSimilarity, rerankScore: r.rerankScore }))
        // Immediately repeat the identical query to measure application-cache latency
        // separately. The first call in a new process is the cold-query observation.
        const valid = workerMode === "lexical" || result.retrieval.vectorAvailable === true
        const rerankValid = workerMode !== "hybrid-rerank" || result.retrieval.rerank === "applied" || result.retrieval.rerank === "disabled" && !result.retrieval.candidates
        if (valid && rerankValid) {
          calls = []
          const warmStarted = performance.now()
          const warm = await recommendCommandHybrid(observer, c.query, { event, limit: dataset.k, signal: AbortSignal.timeout(30000) })
          row.warmLatencyMs = performance.now() - warmStarted
          row.warmCalls = structuredClone(calls)
          row.warmRetrieval = warm.retrieval
          row.warmResultsEqual = JSON.stringify(warm.results.map(r => r.id)) === JSON.stringify(result.results.map(r => r.id))
        }
      } catch (error) {
        row.status = "error"
        row.reason = error?.name || "Error"
        row.calls = structuredClone(calls)
      } finally {
        if (removed.length) {
          const inserts = [...savedDocs.map(doc => ({ sql: `INSERT INTO knowledge_documents(${Object.keys(doc).join(",")}) VALUES(${Object.keys(doc).map(() => "?").join(",")})`, params: Object.values(doc) })), ...savedChunks.map(chunk => ({ sql: `INSERT INTO knowledge_chunks(${Object.keys(chunk).join(",")}) VALUES(${Object.keys(chunk).map(() => "?").join(",")})`, params: Object.values(chunk) }))]
          await sqliteClient.transaction(inserts)
        }
        commands = originalCommands
      }
      rows.push(row)
      await writeJson(`${workerMode}${probe ? "-probe" : ""}.json`, { run: { datasetSha256: digest(rawFixture), corpusIdentity: manifest.corpusIdentity, mode: workerMode, ordering: "relevance-with-command-priority", settings: manifest.settings }, rows })
      if (rows.length % 10 === 0 || probe) console.log(JSON.stringify({ mode: workerMode, completed: rows.length, total: selected.length, last: c.id, vector: row.retrieval?.vectorAvailable, rerank: row.retrieval?.rerank, calls: row.calls?.map(v => ({ operation: v.operation, ok: v.ok, latencyMs: Math.round(v.latencyMs) })) }))
      consecutiveProviderFailures = row.calls?.some(call => !call.ok) ? consecutiveProviderFailures + 1 : 0
      if (consecutiveProviderFailures >= 3) throw new Error("three consecutive provider failures; partial results preserved, no bulk fallback evaluation")
      if (probe && (row.status !== "ok" || workerMode !== "lexical" && row.retrieval.vectorAvailable !== true || workerMode === "hybrid-rerank" && row.retrieval.rerank !== "applied")) throw new Error("live provider probe did not exercise the requested retrieval mode")
    }
  } finally {
    await modelLogStore.stop({ flush: false })
    await sqliteClient.close()
    await fs.rm(privateRoot, { recursive: true, force: true })
  }
}

async function parent() {
  await fs.mkdir(output, { recursive: true })
  const privateDir = path.join(output, ".private")
  await fs.mkdir(privateDir, { recursive: true, mode: 0o700 })
  await fs.chmod(privateDir, 0o700)
  const stateSnapshot = path.join(privateDir, "state.sqlite3")
  const hasSnapshot = await fs.access(stateSnapshot).then(() => true, () => false)
  if (!hasSnapshot) {
    for (const name of ["state", "vectors"]) {
      const source = new Database(path.resolve(root, "../../data/yui-chat/storage", `${name}.sqlite3`), { readonly: true, fileMustExist: true })
      try { await source.backup(path.join(privateDir, `${name}.sqlite3`)) }
      finally { source.close() }
      await fs.chmod(path.join(privateDir, `${name}.sqlite3`), 0o600)
    }
  }
  const snapshot = new Database(path.join(privateDir, "state.sqlite3"), { readonly: true, fileMustExist: true })
  const documents = snapshot.prepare("SELECT * FROM knowledge_documents WHERE knowledge_base_id='builtin-commands' ORDER BY id").all()
  const config = JSON.parse(snapshot.prepare("SELECT overrides_json FROM runtime_config WHERE id=1").get().overrides_json)
  const base = snapshot.prepare("SELECT * FROM knowledge_bases WHERE id='builtin-commands'").get()
  const baseConfig = JSON.parse(base.retrieval_json)
  const sourceAudit = []
  for (const file of dataset.files) {
    try { sourceAudit.push({ file: file.file, status: digest(await fs.readFile(path.resolve(root, "../..", file.file))) === file.sha256 ? "verified" : "changed" }) }
    catch (error) { if (error.code !== "ENOENT") throw error; sourceAudit.push({ file: file.file, status: "missing" }) }
  }
  const manifest = {
    createdAt: new Date().toISOString(), datasetSha256: digest(rawFixture),
    corpusIdentity: digest(JSON.stringify(documents.map(d => [d.id, d.content_hash, d.metadata_json]))),
    corpus: { documents: documents.length, plugins: new Set(documents.map(d => JSON.parse(d.metadata_json).command?.pluginKey)).size, chunks: snapshot.prepare("SELECT count(*) n FROM knowledge_chunks WHERE knowledge_base_id='builtin-commands'").get().n },
    settings: { k: dataset.k, concurrency: 1, embedding: config.models.find(m => m.name === baseConfig.embeddingModel)?.modelIdentifier, dimensions: baseConfig.dimensions, reranker: config.models.find(m => m.name === config.knowledge.retrieval.rerankModel)?.modelIdentifier, retrievalOverrides: config.knowledge.retrieval, commandRetrievalOverrides: config.knowledge.commandRetrieval || {}, perQueryTimeoutMs: 30000, cold: "fresh worker per mode; unique first query; local SQLite/OS caches not flushed", warm: "immediate identical query; application embedding/rerank caches active", policyReview: "retrieval only; no final-answer or real command execution evaluation" },
    bindings: bindings(documents), sourceAudit,
  }
  snapshot.close()
  await writeJson("manifest.json", manifest)
  const selectedModes = option("--modes", modes.join(",")).split(",")
  assert(selectedModes.every(mode => modes.includes(mode)), "unknown evaluation mode")
  for (const mode of selectedModes) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--output", output, "--worker", mode, ...(probe ? ["--probe"] : [])], { cwd: root, stdio: "inherit", env: process.env })
      child.once("error", reject)
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${mode} exited with code ${code}`)))
    })
  }
  // Keep the private baseline only while explicitly resuming a multi-mode run.
  // Default complete runs remove credentials and copied personal data on success.
  if (!probe && selectedModes.length === modes.length) await fs.rm(privateDir, { recursive: true, force: true })
}

try { if (workerMode) await worker(); else await parent() }
catch (error) { console.error(JSON.stringify({ error: error?.name || "Error", message: String(error?.message || "evaluation failed").replace(/https?:\/\/\S+/g, "[redacted-url]") })); process.exitCode = 1 }
