import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { configStore, tempDir } from "../config/store.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { knowledgeEvaluation, evaluationModes } from "./evaluation.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import { errorSummary } from "../core/shared/error-details.js"

type Row = Record<string, any>
const hash = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
export function evaluationModelSignature(config: unknown): string {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value
  const cfg = config as Row
  return hash(canonical([cfg.apiProviders, cfg.models, cfg.modelTasks, cfg.knowledge]))
}
let active: { id: string; cancelled: boolean; child?: ChildProcess } | null = null
let starting = false
function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }) }

export const evaluationRunner = {
  activeId(): string { return active?.id || "" },
  async recoverInterrupted(): Promise<void> {
    if (active || starting) return
    await fs.mkdir(tempDir, { recursive: true })
    for (const entry of await fs.readdir(tempDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^knowledge-evaluation-[0-9a-f-]{36}$/.test(entry.name)) await fs.rm(path.join(tempDir, entry.name), { recursive: true, force: true })
    }
    await sqliteClient.run("UPDATE knowledge_evaluation_runs SET status='interrupted',error='进程已中断，未自动续跑模型请求' WHERE status IN ('queued','running')")
  },
  async plan(): Promise<Row> {
    const current = await knowledgeEvaluation.current(), cfg = configStore.get() as Row
    if (!current.dataset.cases.length || current.dataset.cases.length > 500) fail("单次评测需要 1–500 道题")
    const base = await sqliteClient.get("SELECT retrieval_json,active_vector_space_id FROM knowledge_bases WHERE id='builtin-commands'")
    const baseConfig = JSON.parse(String(base?.retrieval_json || "{}"))
    const embedding = cfg.models.find((m: Row) => m.name === baseConfig.embeddingModel)
    const rerankTask = cfg.knowledge?.retrieval?.rerankTask || "rerank"
    const rerankNames = cfg.knowledge?.retrieval?.rerankModel ? [cfg.knowledge.retrieval.rerankModel] : cfg.modelTasks?.[rerankTask]?.modelList || []
    const rerankers = rerankNames.map((name: string) => cfg.models.find((m: Row) => m.name === name && m.purpose === "rerank")).filter(Boolean)
    const reranker = rerankers[0]
    if (!sqliteClient.status.vector.available || !base?.active_vector_space_id || !embedding || !reranker) fail("请先配置指令知识库的可用向量索引及专用重排模型")
    const providers = [embedding, ...rerankers].map(model => cfg.apiProviders.find((p: Row) => p.name === model.apiProvider))
    const destinations = [...new Set(providers.map(provider => { try { return new URL(provider.baseURL).host } catch { return "未提供服务地址" } }))]
    const modelSignature = evaluationModelSignature(cfg)
    return { revision: current.revision, questions: current.dataset.cases.length, embedding: embedding.modelIdentifier || embedding.name, reranker: rerankers.map((m: Row) => m.modelIdentifier || m.name).join(" → "), destinations, maxEmbeddingCalls: current.dataset.cases.length * 2, maxRerankCalls: current.dataset.cases.length * rerankers.length, signature: hash([current.fingerprint, current.revision, modelSignature]) }
  },
  async start(input: Row): Promise<Row> {
    if (active || starting) fail("已有评测正在运行，请等待完成或先取消", 409)
    starting = true
    try {
      const plan = await this.plan()
      if (plan.signature !== input.signature || plan.revision !== input.expectedRevision) fail("题库或模型配置已变化，请重新核对评测范围", 409)
      const state = await knowledgeEvaluation.current(), id = `run-${crypto.randomUUID()}`
      const signedModelSignature = evaluationModelSignature(configStore.get())
      if (hash([state.fingerprint, state.revision, signedModelSignature]) !== plan.signature) fail("题库或模型配置已变化，请重新核对评测范围", 409)
      const bundle: Row = { schemaVersion: 1, title: `手动评测 · ${new Date().toISOString()}`, createdAt: new Date().toISOString(), dataset: state.dataset, manifest: { corpus: {}, bindings: [], plan }, runs: {} }
      await sqliteClient.run("UPDATE knowledge_evaluation_runs SET status='interrupted',error='进程已中断，未自动续跑模型请求' WHERE status IN ('queued','running')")
      await sqliteClient.run("INSERT INTO knowledge_evaluation_runs(id,title,dataset_fingerprint,bundle_json,status,created_at) VALUES(?,?,?,?,'queued',?)", [id, bundle.title, state.fingerprint, JSON.stringify(bundle), Date.now()])
      const task = { id, cancelled: false } as NonNullable<typeof active>
      active = task
      // The background promise owns its complete lifecycle and failure persistence.
      void execute(task, bundle, signedModelSignature).catch(() => { hostRuntime.logger?.warn?.("[yui-chat] 评测状态保存或临时副本清理失败，请检查存储") }).finally(() => { if (active === task) active = null })
      return { id }
    } finally { starting = false }
  },
  cancel(id: string): Row {
    if (!active || active.id !== id) fail("该评测没有正在运行的任务", 409)
    active.cancelled = true
    active.child?.kill("SIGTERM")
    return { cancelling: true }
  },
}

async function execute(task: NonNullable<typeof active>, bundle: Row, modelSignature: string): Promise<void> {
  let directory = ""
  let stage = "创建临时副本"
  try {
    await fs.mkdir(tempDir, { recursive: true })
    directory = path.join(tempDir, `knowledge-evaluation-${crypto.randomUUID()}`)
    await fs.mkdir(directory, { mode: 0o700 })
    await sqliteClient.evaluationSnapshot(path.join(directory, "state.sqlite3"))
    await sqliteClient.evaluationSnapshot(path.join(directory, "vectors.sqlite3"), "vectors")
    stage = "固定知识库与目标标识"
    const documents = await sqliteClient.all("SELECT id,content_hash,metadata_json FROM knowledge_documents WHERE knowledge_base_id='builtin-commands' ORDER BY id")
    const commands = documents.map(d => ({ documentId: d.id, ...JSON.parse(String(d.metadata_json)).command }))
    const key = (s: Row): string => JSON.stringify([s.pluginKey, s.fnc, s.regexp, s.regexpFlags || ""])
    const known = await knowledgeEvaluation.getRun("builtin-20261123")
    bundle.manifest.corpus = { documents: documents.length, plugins: new Set(commands.map(c => c.pluginKey)).size, fingerprint: hash(documents) }
    bundle.manifest.bindings = bundle.dataset.targets.map((target: Row) => {
      let found = commands.find(c => key(c) === key(target.selector)), status = "exact"
      if (!found) {
        const existing = known.dataset.targets.find((t: Row) => t.id === target.id)
        const alias = existing && key(existing.selector) === key(target.selector) ? known.manifest.bindings.find((b: Row) => b.targetId === target.id)?.snapshot : null
        if (alias) { found = commands.find(c => key(c) === key(alias)); status = "reviewed-alias" }
      }
      return { targetId: target.id, snapshot: found ? { pluginKey: found.pluginKey, fnc: found.fnc, regexp: found.regexp, regexpFlags: found.regexpFlags || "" } : null, commandId: found?.id, status: found ? status : "absent" }
    })
    const inputFile = path.join(directory, "input.json")
    await fs.writeFile(inputFile, JSON.stringify({ dataset: bundle.dataset, manifest: bundle.manifest, modelSignature }), { mode: 0o600 })
    await sqliteClient.run("UPDATE knowledge_evaluation_runs SET status='running',bundle_json=? WHERE id=?", [JSON.stringify(bundle), task.id])
    for (const [index, mode] of evaluationModes.entries()) {
      stage = `执行 ${mode}`
      if (task.cancelled) break
      const runtime = path.join(directory, mode), storage = path.join(runtime, "data/yui-chat/storage")
      await fs.mkdir(storage, { recursive: true, mode: 0o700 })
      for (const name of ["state", "vectors"]) await fs.cp(path.join(directory, `${name}.sqlite3`), path.join(storage, `${name}.sqlite3`), { errorOnExist: true, force: false })
      const resultFile = path.join(directory, `${mode}.json`)
      let progressWrites = Promise.resolve()
      let progressError: unknown
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL("./evaluation-worker.js", import.meta.url)), inputFile, resultFile, mode], { env: { ...process.env, YUI_CHAT_RUNTIME_ROOT: runtime }, stdio: ["ignore", "ignore", "ignore", "ipc"] })
        task.child = child
        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM") }, 600000)
        child.on("message", (message: unknown) => {
          const m = message as Row
          if (m?.type !== "progress" || !Number.isInteger(m.completed)) return
          const progress = { mode, completed: index * bundle.dataset.cases.length + m.completed, total: bundle.dataset.cases.length * evaluationModes.length }
          progressWrites = progressWrites.then(async () => {
            if (!progressError) await sqliteClient.run("UPDATE knowledge_evaluation_runs SET progress_json=? WHERE id=?", [JSON.stringify(progress), task.id])
          }).catch(error => { progressError = error; child.kill("SIGTERM") })
        })
        child.once("error", error => { clearTimeout(timer); reject(error) })
        child.once("exit", code => { clearTimeout(timer); resolve(timedOut ? -1 : code ?? 1) })
      })
      await progressWrites
      if (progressError) throw progressError
      task.child = undefined
      try { bundle.runs[mode] = JSON.parse(await fs.readFile(resultFile, "utf8")) } catch (error) { if ((error as Row).code !== "ENOENT") throw error }
      await sqliteClient.run("UPDATE knowledge_evaluation_runs SET bundle_json=? WHERE id=?", [JSON.stringify(bundle), task.id])
      if (exitCode && !task.cancelled) throw new Error("requested branch failed")
    }
    await sqliteClient.run("UPDATE knowledge_evaluation_runs SET status=?,error=? WHERE id=?", [task.cancelled ? "cancelled" : "completed", task.cancelled ? "用户取消；已完成的分组结果保留" : "", task.id])
  } catch (error) {
    hostRuntime.logger?.warn?.(`[yui-chat] 评测未完成：${stage}`, errorSummary(error))
    await sqliteClient.run("UPDATE knowledge_evaluation_runs SET status=?,error=? WHERE id=?", [task.cancelled ? "cancelled" : "failed", task.cancelled ? "用户取消；不自动继续模型调用" : `评测在“${stage}”阶段未完成。请核对配置、索引与模型连接；已完成结果保留，不把降级当作成功对比。`, task.id])
  } finally { task.child?.kill("SIGTERM"); if (directory) await fs.rm(directory, { recursive: true, force: true }) }
}
