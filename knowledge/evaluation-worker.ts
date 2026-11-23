import fs from "node:fs/promises"
import crypto from "node:crypto"
import { configStore } from "../config/store.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { commandImports } from "./command-import.js"
import { buildCommandDoc } from "./command-document-builder.js"
import { cleanCommandRetrievalText } from "./command-retrieval-text.js"
import { prepareCommandCompleteness } from "./command-completeness.js"
import { buildCommandRecommendations } from "./command-query-service.js"
import { commandPrefixes } from "../core/message/command-prefixes.js"
import { recommendCommandHybrid } from "./command-hybrid-retrieval.js"
import { modelLogStore } from "../core/observability/model-log.js"
import { adapterRegistry } from "../models/adapters/registry.js"
import { evaluationModelSignature } from "./evaluation-runner.js"

type Row = Record<string, any>
// A host crash must not leave an orphan issuing additional paid requests.
let finished = false
process.on("disconnect", () => { if (!finished) process.exit(1) })
// This module is only executed by an isolated child process, never imported by
// the host. No native command/tool dispatch or production configuration mutation.
async function main(): Promise<void> {
  const [inputFile, outputFile, mode] = process.argv.slice(2)
  if (!inputFile || !outputFile || !["lexical", "hybrid", "hybrid-rerank"].includes(mode)) throw new Error("invalid evaluation worker arguments")
  const input = JSON.parse(await fs.readFile(inputFile, "utf8")) as Row
  const rows: Row[] = []
  let cacheOnly = false, cacheMiss = false
  const guardWarmRequest = (): void => { if (cacheOnly) { cacheMiss = true; throw new Error("warm cache miss; no additional model request authorized") } }
  const embed = adapterRegistry.embedTexts.bind(adapterRegistry), rerank = adapterRegistry.rerank.bind(adapterRegistry)
  adapterRegistry.embedTexts = async options => { guardWarmRequest(); return embed(options) }
  adapterRegistry.rerank = async options => { guardWarmRequest(); return rerank(options) }
  try {
    await sqliteClient.init()
    const stored = await sqliteClient.get("SELECT overrides_json FROM runtime_config WHERE id=1")
    if (!stored) throw new Error("missing isolated configuration")
    const config = JSON.parse(String(stored.overrides_json))
    config.logging = { ...config.logging, enabled: false, langfuse: { ...config.logging?.langfuse, enabled: false } }
    await sqliteClient.run("UPDATE runtime_config SET overrides_json=? WHERE id=1", [JSON.stringify(config)])
    await configStore.load()
    if (evaluationModelSignature(configStore.get()) !== input.modelSignature) throw new Error("configuration changed before snapshot")
    const snapshotDocuments = await sqliteClient.all("SELECT id,content_hash,metadata_json FROM knowledge_documents WHERE knowledge_base_id='builtin-commands' ORDER BY id")
    if (crypto.createHash("sha256").update(JSON.stringify(snapshotDocuments)).digest("hex") !== input.manifest.corpus.fingerprint) throw new Error("knowledge changed while snapshotting")
    await configStore.update(cfg => {
      const knowledge = cfg.knowledge as Row
      knowledge.commandRetrieval = { ...knowledge.commandRetrieval, mode: mode === "lexical" ? "lexical" : "hybrid" }
      knowledge.retrieval = { ...knowledge.retrieval, resultLimit: Math.max(Number(knowledge.retrieval?.resultLimit) || 5, input.dataset.k), rerankEnabled: mode === "hybrid-rerank" }
    })
    const imported = await commandImports.list()
    let commands: Row[] = imported.map(row => {
      const c = { ...row.metadata, id: row.id, title: row.title, metadata: row.metadata, retrievalText: cleanCommandRetrievalText(row.retrievalText, row.metadata), sourceId: row.sourceId, suggestedCommand: row.metadata.suggestedCommand ?? row.title, description: row.metadata.description || row.title, imported: true, enabled: row.enabled }
      return { ...buildCommandDoc(c), ...c }
    })
    await prepareCommandCompleteness(commands)
    const observer = {
      searchableCommands: () => commands.filter(c => c.enabled !== false),
      recommendCommands(query: unknown, options: Row = {}) { return buildCommandRecommendations(this.searchableCommands(), query, { ...options, commandPrefixes: commandPrefixes(configStore.get()), minRelevance: (configStore.get().knowledge as Row).retrieval.minRelevance }) },
    }
    for (const c of input.dataset.cases as Row[]) {
      const before = commands, savedDocuments: Row[] = [], savedChunks: Row[] = []
      const keys = new Set<string>()
      for (const target of c.context.deletedTargets || []) {
        const binding = input.manifest.bindings.find((b: Row) => b.targetId === target)
        if (!binding?.commandId) continue
        const document = await sqliteClient.get("SELECT * FROM knowledge_documents WHERE json_extract(metadata_json,'$.commandId')=?", [binding.commandId])
        if (document) { savedDocuments.push(document); savedChunks.push(...await sqliteClient.all("SELECT * FROM knowledge_chunks WHERE document_id=?", [document.id])); keys.add(binding.commandId) }
      }
      try {
        if (savedDocuments.length) { await sqliteClient.transaction(savedDocuments.map(d => ({ sql: "DELETE FROM knowledge_documents WHERE id=?", params: [d.id] }))); commands = commands.filter(row => !keys.has(row.id)) }
        const event = { user_id: "evaluation", group_id: "evaluation", isGroup: c.context.channel === "group", isMaster: c.context.role === "master", sender: { role: c.context.role === "groupOwner" ? "owner" : c.context.role === "groupAdmin" ? "admin" : "member" } }
        const start = performance.now()
        const response = await recommendCommandHybrid(observer, c.query, { event, limit: input.dataset.k, signal: AbortSignal.timeout(30000) }) as Row
        const latencyMs = performance.now() - start
        const vectorValid = mode === "lexical" || response.retrieval.vectorAvailable === true
        const rankValid = mode !== "hybrid-rerank" || ["applied", "cached"].includes(response.retrieval.rerank) || response.retrieval.rerank === "disabled" && !response.results.length
        if (!vectorValid || !rankValid) throw new Error("requested model branch did not complete")
        const warmStart = performance.now()
        cacheOnly = true; cacheMiss = false
        try { await recommendCommandHybrid(observer, c.query, { event, limit: input.dataset.k, signal: AbortSignal.timeout(30000) }) }
        catch { cacheMiss = true /* 缓存测量失败不改写已成功的首次查询。 */ }
        finally { cacheOnly = false }
        rows.push({ caseId: c.id, query: c.query, status: "ok", latencyMs, warmLatencyMs: cacheMiss ? null : performance.now() - warmStart, retrieval: response.retrieval, results: response.results.map((r: Row) => ({ id: r.id, pluginKey: r.pluginKey, fnc: r.fnc, regexp: r.regexp, regexpFlags: r.regexpFlags || "", suggestedCommand: r.recommendation?.command || r.suggestedCommand || r.fnc, rerankScore: r.rerankScore, vectorSimilarity: r.vectorSimilarity })) })
        process.send?.({ type: "progress", mode, completed: rows.length, total: input.dataset.cases.length })
      } catch {
        rows.push({ caseId: c.id, query: c.query, status: "error", reason: "本条请求或指定检索分支未完成；已停止以避免把降级结果冒充对比成绩。", results: [] })
        throw new Error("evaluation stopped on failed retrieval branch")
      } finally {
        if (savedDocuments.length) await sqliteClient.transaction([...savedDocuments.map(d => ({ sql: `INSERT INTO knowledge_documents(${Object.keys(d).join(",")}) VALUES(${Object.keys(d).map(() => "?").join(",")})`, params: Object.values(d) })), ...savedChunks.map(c => ({ sql: `INSERT INTO knowledge_chunks(${Object.keys(c).join(",")}) VALUES(${Object.keys(c).map(() => "?").join(",")})`, params: Object.values(c) }))])
        commands = before
      }
    }
  } finally {
    await fs.writeFile(outputFile, JSON.stringify(rows))
    await modelLogStore.stop({ flush: false })
    await sqliteClient.close()
  }
}
main().catch(() => { process.send?.({ type: "failed" }); process.exitCode = 1 }).finally(() => { finished = true; process.disconnect?.() })
