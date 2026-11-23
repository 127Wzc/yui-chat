import fs from "node:fs/promises"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { cloneJsonValue as copy } from "../core/shared/json-values.js"

type Row = Record<string, any>
export const evaluationModes = ["lexical", "hybrid", "hybrid-rerank"] as const
export interface EvaluationDataset { version: number; k: number; createdAt: string; provenance: string; files: Row[]; targets: Row[]; cases: Row[] }
const baselineId = "builtin-20261123"
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
const fingerprint = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
const selectorKey = (value: Row): string => JSON.stringify([value.pluginKey, value.fnc, value.regexp, value.regexpFlags || ""])
function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }) }
function text(value: unknown, max: number, label: string, required = false): string {
  if (value !== undefined && typeof value !== "string") fail(`${label}必须是文本`)
  const result = String(value || "").trim()
  if (result.length > max || required && !result) fail(`${label}${required ? "不能为空且" : ""}最多 ${max} 字符`)
  return result
}
function id(value: unknown): string { const result = text(value, 120, "标识", true); if (!/^[\w.-]+$/.test(result)) fail("标识只能包含字母、数字、下划线、点和横线"); return result }
function list(value: unknown, max: number, label: string): unknown[] { if (!Array.isArray(value) || value.length > max) fail(`${label}必须是最多 ${max} 项的数组`); return value }
const strings = (value: unknown, max = 30): string[] => [...new Set(list(value || [], max, "条目").map(v => text(v, 1000, "条目", true)))]
function choice(value: unknown, options: string[], label: string): string { if (!options.includes(String(value))) fail(`${label}无效`); return String(value) }
function selector(value: unknown): Row {
  const row = record(value)
  const result = { pluginKey: text(row.pluginKey, 200, "插件标识", true), fnc: text(row.fnc, 200, "处理函数", true), regexp: text(row.regexp, 1500, "注册规则", true), regexpFlags: text(row.regexpFlags, 10, "正则选项") }
  try { new RegExp(result.regexp, result.regexpFlags) } catch { fail("注册规则的正则语法无效") }
  return result
}
export function normalizeEvaluationDataset(value: unknown): EvaluationDataset {
  const input = record(value)
  const targets = list(input.targets, 3000, "预期目标").map(value => {
    const row = record(value)
    return { id: id(row.id), family: text(row.family || row.id, 120, "功能分组", true), selector: selector(row.selector), pluginName: text(row.pluginName, 200, "插件名称"), example: text(row.example, 1000, "建议指令", true), meaning: text(row.meaning, 4000, "用途", true), declaredPermission: text(row.declaredPermission || "unknown", 100, "声明权限"), executionConditions: strings(row.executionConditions), evidence: list(row.evidence || [], 12, "来源依据").map(value => { const proof = record(value); return { file: text(proof.file, 500, "来源路径", true), startLine: Math.max(1, Math.trunc(Number(proof.startLine) || 1)), endLine: Math.max(1, Math.trunc(Number(proof.endLine) || 1)), claim: text(proof.claim, 1000, "来源说明", true) } }) }
  })
  const ids = new Set(targets.map(t => t.id))
  if (ids.size !== targets.length || new Set(targets.map(t => selectorKey(t.selector))).size !== targets.length) fail("预期目标标识或完整注册规则重复")
  const references = (value: unknown): string[] => { const result = strings(value); if (result.some(v => !ids.has(v))) fail("题目引用了不存在的预期目标"); return result }
  const cases = list(input.cases, 10000, "题目").map(value => {
    const row = record(value), expected = record(row.expected), context = record(row.context)
    const kind = choice(row.kind, ["positive", "negative", "ambiguous", "policy"], "样本类别")
    const relevantGroups = list(expected.relevantGroups || [], 20, "预期功能组").map(group => { const result = references(group); if (!result.length) fail("预期功能组不能为空"); return result })
    const relevant = relevantGroups.flat(), forbiddenTargets = references(expected.forbiddenTargets || [])
    if (new Set(relevant).size !== relevant.length || forbiddenTargets.some(v => relevant.includes(v))) fail("预期答案组不能重叠，也不能同时列为排除目标")
    if (kind === "positive" && !relevant.length) fail("正例必须选择至少一个预期目标")
    if (kind === "negative" && relevant.length) fail("无匹配反例不能填写可接受目标")
    const action = choice(expected.action, ["recommend", "no-match", "clarify", "explain-restriction"], "预期动作")
    if (kind === "negative" && action !== "no-match") fail("无匹配反例的预期动作必须为不推荐")
    return { id: id(row.id), family: text(row.family || "manual", 120, "功能分组", true), split: choice(row.split, ["development", "evaluation"], "数据划分"), kind, queryType: choice(row.queryType, ["exact", "paraphrase", "typo", "boundary"], "问法类型"), query: text(row.query, 4000, "题目", true), context: { role: choice(context.role === "admin" ? "groupAdmin" : context.role || "member", ["member", "groupAdmin", "groupOwner", "master"], "提问角色"), channel: choice(context.channel || "group", ["group", "private"], "对话场景"), ...(context.deletedTargets?.length ? { deletedTargets: references(context.deletedTargets) } : {}) }, expected: { relevantGroups, forbiddenTargets, action, checks: strings(expected.checks) } }
  })
  if (new Set(cases.map(c => c.id)).size !== cases.length) fail("题目标识重复")
  const k = Number(input.k || 5)
  if (!Number.isInteger(k) || k < 1 || k > 20) fail("返回条数必须为 1–20")
  const dataset = { version: 1, k, createdAt: text(input.createdAt, 100, "创建时间"), provenance: text(input.provenance || "管理台维护的指令检索题库", 1000, "题库说明"), files: list(input.files || [], 3000, "来源文件").map(value => { const row = record(value); return { file: text(row.file, 500, "来源路径", true), sha256: text(row.sha256, 64, "来源摘要"), lines: Math.max(1, Math.trunc(Number(row.lines) || 1)) } }), targets, cases }
  if (Buffer.byteLength(JSON.stringify(dataset)) > 8 * 1024 * 1024) fail("题库最多 8 MiB")
  return dataset
}

let baselinePromise: Promise<Row> | null = null
async function baseline(): Promise<Row> {
  baselinePromise ||= fs.readFile(fileURLToPath(new URL("../resources/benchmarks/command-retrieval-baseline.json", import.meta.url)), "utf8").then(raw => { const result = JSON.parse(raw); result.dataset = normalizeEvaluationDataset(result.dataset); return result })
  return baselinePromise
}
async function current(): Promise<{ revision: number; dataset: EvaluationDataset; fingerprint: string }> {
  if (!sqliteClient.status.available) fail("SQLite 尚未就绪，题库不可用", 503)
  const row = await sqliteClient.get("SELECT revision,dataset_json FROM knowledge_evaluation_state WHERE id=1")
  const dataset = row ? normalizeEvaluationDataset(JSON.parse(String(row.dataset_json))) : copy((await baseline()).dataset) as EvaluationDataset
  return { revision: Number(row?.revision || 0), dataset, fingerprint: fingerprint(dataset) }
}
async function mutate(expectedRevision: unknown, change: (dataset: EvaluationDataset) => void): Promise<Row> {
  if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0) fail("请先读取当前题库版本")
  const state = await current()
  if (state.revision !== expectedRevision) fail("题库已被其他操作修改，请刷新后重试", 409)
  const candidate = copy(state.dataset)
  change(candidate)
  const dataset = normalizeEvaluationDataset(candidate)
  if (fingerprint(dataset) === state.fingerprint) return state
  try {
    await sqliteClient.transaction([
      { sql: "INSERT OR IGNORE INTO knowledge_evaluation_state(id,revision,dataset_json,updated_at) VALUES(1,0,?,?)", params: [JSON.stringify((await baseline()).dataset), Date.now()] },
      { sql: "UPDATE knowledge_evaluation_state SET dataset_json=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=?", params: [JSON.stringify(dataset), Date.now(), expectedRevision], expectChanges: 1 },
    ])
  } catch (error) { if (String(record(error).message || error).includes("条件写入")) fail("题库已被其他操作修改，请刷新后重试", 409); throw error }
  return { revision: state.revision + 1, dataset, fingerprint: fingerprint(dataset) }
}

function normalizeBundle(value: unknown): Row {
  const input = record(value), dataset = normalizeEvaluationDataset(input.dataset), caseIds = new Map(dataset.cases.map(c => [c.id, c.query]))
  const runs: Row = {}
  for (const mode of evaluationModes) {
    if (!input.runs?.[mode]) continue
    const seen = new Set<string>()
    runs[mode] = list(input.runs[mode], 10000, "评测记录").map(value => {
      const row = record(value), caseId = id(row.caseId)
      if (!caseIds.has(caseId) || seen.has(caseId)) fail("评测记录包含未知或重复题目")
      seen.add(caseId)
      if (row.query !== undefined && row.query !== caseIds.get(caseId)) fail("运行记录问法与题库快照不一致，不能混用版本")
      const number = (v: unknown, signed = false): number | null => v === undefined || v === null ? null : Number.isFinite(v) && (signed || Number(v) >= 0) ? Number(v) : fail("运行耗时或分数无效")
      const retrieval = record(row.retrieval)
      return { caseId, status: choice(row.status, ["ok", "error", "skipped"], "运行状态"), reason: text(row.reason, 1000, "运行说明"), latencyMs: number(row.latencyMs), warmLatencyMs: number(row.warmLatencyMs), retrieval: { vectorAvailable: retrieval.vectorAvailable === true, rerank: text(retrieval.rerank, 100, "重排状态"), mode: text(retrieval.mode, 100, "检索方式") }, results: list(row.results || [], 30, "候选结果").map(value => { const result = record(value); return { ...selector(result), id: text(result.id, 1000, "候选标识"), suggestedCommand: text(result.suggestedCommand, 2000, "实际推荐文本"), rerankScore: number(result.rerankScore, true), vectorSimilarity: number(result.vectorSimilarity, true) } }) }
    })
  }
  if (!Object.keys(runs).length) fail("没有可导入的评测结果")
  const manifest = record(input.manifest)
  const bundle = { schemaVersion: 1, title: text(input.title || "手动导入评测", 200, "评测名称", true), createdAt: text(input.createdAt || new Date().toISOString(), 100, "运行时间"), dataset, manifest: { corpus: { documents: Number(manifest.corpus?.documents) || 0, plugins: Number(manifest.corpus?.plugins) || 0 }, bindings: list(manifest.bindings || [], 3000, "标识映射").map(value => { const b = record(value); return { targetId: id(b.targetId), snapshot: b.snapshot ? selector(b.snapshot) : null, status: text(b.status, 100, "绑定状态") } }) }, runs }
  if (Buffer.byteLength(JSON.stringify(bundle)) > 20 * 1024 * 1024) fail("评测结果最多 20 MiB")
  return bundle
}

export function scoreEvaluation(bundle: Row, binding = "audited"): Row {
  const dataset = bundle.dataset as EvaluationDataset
  const caseById = new Map(dataset.cases.map(c => [c.id, c]))
  const mapping = new Map(dataset.targets.map(t => [selectorKey(t.selector), t.id]))
  if (binding !== "original") for (const b of bundle.manifest?.bindings || []) if (b.snapshot && dataset.targets.some(t => t.id === b.targetId)) mapping.set(selectorKey(b.snapshot), b.targetId)
  const modes: Row = {}, metrics: Row = {}
  for (const mode of evaluationModes) {
    if (!bundle.runs[mode]) continue
    modes[mode] = bundle.runs[mode].map((row: Row) => {
      const c = caseById.get(row.caseId)!
      const matchedIds = row.status === "ok" ? row.results.slice(0, dataset.k).map((r: Row) => mapping.get(selectorKey(r)) || null) : []
      const relevant = new Set(c.expected.relevantGroups.flat()), rank = row.status === "ok" ? matchedIds.findIndex((v: string | null) => relevant.has(v)) : -1
      return { ...row, matchedIds, hit: rank >= 0, firstHit: rank === 0, reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1), precision: matchedIds.length ? new Set(matchedIds.filter((v: string | null) => relevant.has(v))).size / matchedIds.length : 0 }
    })
    metrics[mode] = {}
    for (const split of ["all", "development", "evaluation"]) {
      const cases = dataset.cases.filter(c => split === "all" || c.split === split), selectedIds = new Set(cases.map(c => c.id)), positiveIds = new Set(cases.filter(c => c.kind === "positive").map(c => c.id)), rows = modes[mode].filter((r: Row) => selectedIds.has(r.caseId)), positives = cases.filter(c => c.kind === "positive"), positiveRows = rows.filter((r: Row) => positiveIds.has(r.caseId))
      const latency = rows.filter((r: Row) => r.status === "ok" && Number.isFinite(r.latencyMs)).map((r: Row) => r.latencyMs).sort((a: number, b: number) => a - b)
      const negativeRows = rows.filter((r: Row) => r.status === "ok" && caseById.get(r.caseId)?.kind === "negative")
      const average = (key: string): number | null => positives.length ? positiveRows.reduce((sum: number, r: Row) => sum + Number(r[key]), 0) / positives.length : null
      metrics[mode][split] = { planned: cases.length, completed: rows.filter((r: Row) => r.status === "ok").length, positive: positives.length, hits: positiveRows.filter((r: Row) => r.hit).length, hitAt5: positives.length ? positiveRows.filter((r: Row) => r.hit).length / positives.length : null, top1: average("firstHit"), precision: average("precision"), mrr: average("reciprocalRank"), p50: latency[Math.ceil(latency.length * .5) - 1] ?? null, p95: latency[Math.ceil(latency.length * .95) - 1] ?? null, negative: negativeRows.length, falseRecommendations: negativeRows.filter((r: Row) => r.results.length).length }
    }
  }
  return { modes, metrics }
}

export const knowledgeEvaluation = {
  current,
  async overview(): Promise<Row> {
    const state = await current(), seed = await baseline()
    const rows = await sqliteClient.all("SELECT id,title,dataset_fingerprint,created_at,status,progress_json,error FROM knowledge_evaluation_runs ORDER BY created_at DESC LIMIT 100")
    return { ...state, runs: [...rows.map(row => ({ id: row.id, title: row.title, createdAt: row.created_at, status: row.status, progress: JSON.parse(String(row.progress_json)), error: row.error, matchesCurrent: row.dataset_fingerprint === state.fingerprint, builtin: false })), { id: baselineId, title: seed.title, createdAt: seed.createdAt, status: "completed", matchesCurrent: fingerprint(seed.dataset) === state.fingerprint, builtin: true }] }
  },
  async saveCase(input: unknown, expectedRevision: unknown, caseId?: string): Promise<Row> {
    const row = record(input), key = caseId || `case-${crypto.randomUUID()}`
    return mutate(expectedRevision, dataset => { const index = dataset.cases.findIndex(c => c.id === key); if (caseId && index < 0) fail("题目不存在", 404); const candidate = { ...row, id: key }; if (index < 0) dataset.cases.push(candidate); else dataset.cases[index] = candidate })
  },
  async deleteCase(caseId: string, expectedRevision: unknown): Promise<Row> { return mutate(expectedRevision, dataset => { if (!dataset.cases.some(c => c.id === caseId)) fail("题目不存在", 404); dataset.cases = dataset.cases.filter(c => c.id !== caseId) }) },
  async saveTarget(input: unknown, expectedRevision: unknown, targetId?: string): Promise<Row> { const row = record(input), key = targetId || `target-${crypto.randomUUID()}`; return mutate(expectedRevision, dataset => { const index = dataset.targets.findIndex(t => t.id === key); if (targetId && index < 0) fail("预期目标不存在", 404); const candidate = { ...row, id: key }; if (index < 0) dataset.targets.push(candidate); else dataset.targets[index] = candidate }) },
  async replaceDataset(input: unknown, expectedRevision: unknown): Promise<Row> { const dataset = normalizeEvaluationDataset(input); return mutate(expectedRevision, current => Object.assign(current, dataset)) },
  async getRun(runId: string, binding = "audited"): Promise<Row> {
    let bundle: Row
    if (runId === baselineId) bundle = await baseline()
    else { const row = await sqliteClient.get("SELECT bundle_json FROM knowledge_evaluation_runs WHERE id=?", [runId]); if (!row) fail("评测记录不存在", 404); bundle = JSON.parse(String(row.bundle_json)) }
    return { id: runId, title: bundle.title, createdAt: bundle.createdAt, fingerprint: fingerprint(bundle.dataset), dataset: bundle.dataset, manifest: bundle.manifest, ...scoreEvaluation(bundle, binding) }
  },
  async importRun(value: unknown): Promise<Row> {
    const bundle = normalizeBundle(value), key = `run-${fingerprint(bundle).slice(0, 32)}`
    await sqliteClient.run("INSERT OR IGNORE INTO knowledge_evaluation_runs(id,title,dataset_fingerprint,bundle_json,created_at) VALUES(?,?,?,?,?)", [key, bundle.title, fingerprint(bundle.dataset), JSON.stringify(bundle), Date.now()])
    return { id: key }
  },
  async exportRun(runId: string): Promise<Row> {
    if (runId === baselineId) return copy(await baseline())
    const row = await sqliteClient.get("SELECT bundle_json FROM knowledge_evaluation_runs WHERE id=?", [runId])
    if (!row) fail("评测记录不存在", 404)
    return JSON.parse(String(row.bundle_json))
  },
  async commandOptions(query: string): Promise<Row[]> {
    const rows = await sqliteClient.all("SELECT title,metadata_json FROM knowledge_documents WHERE knowledge_base_id='builtin-commands' AND source_type='command' AND (title LIKE ? OR content LIKE ?) ORDER BY title LIMIT 40", [`%${query.slice(0,100)}%`, `%${query.slice(0,100)}%`])
    return rows.flatMap(row => { const command = record(JSON.parse(String(row.metadata_json)).command); if (!command.pluginKey || !command.fnc || !command.regexp || !command.suggestedCommand) return []; return [{ selector: { pluginKey: command.pluginKey, fnc: command.fnc, regexp: command.regexp, regexpFlags: command.regexpFlags || "" }, example: command.suggestedCommand, meaning: command.description || row.title, pluginName: command.pluginName || command.pluginKey, declaredPermission: command.permission || "unknown", executionConditions: [], evidence: [] }] })
  },
}
