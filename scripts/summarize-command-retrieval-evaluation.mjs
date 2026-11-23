import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const output = path.resolve(process.argv[2] || path.join(root, "cache/retrieval-evaluation-20261123"))
const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"))
const dataset = JSON.parse(await fs.readFile(path.join(root, "scripts/fixtures/command-retrieval-source-benchmark.json"), "utf8"))
const selector = c => JSON.stringify([c.pluginKey, c.fnc, c.regexp, c.regexpFlags || ""])
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null
}
const ratio = (a, b) => b ? a / b : null
const original = new Map(dataset.targets.map(t => [selector(t.selector), t.id]))
const audited = new Map(manifest.bindings.filter(b => b.snapshot).map(b => [selector(b.snapshot), b.targetId]))
const absentTargets = new Set(manifest.bindings.filter(b => b.status === "absent").map(b => b.targetId))

function summarize(input, split, binding, supportedOnly = false) {
  const lookup = binding === "original" ? original : audited
  const cases = dataset.cases.filter(c => (split === "all" || c.split === split) && (!supportedOnly || c.kind !== "positive" || c.expected.relevantGroups.every(group => group.some(id => !absentTargets.has(id)))))
  const byId = new Map(input.rows.map(r => [r.caseId, r]))
  const details = cases.map(c => {
    const row = byId.get(c.id)
    const results = row?.results || []
    const ids = results.slice(0, dataset.k).map(r => lookup.get(selector(r)) || `unmapped:${selector(r)}`)
    const expected = new Set(c.expected.relevantGroups.flat())
    const rank = ids.findIndex(id => expected.has(id))
    const groupsHit = c.expected.relevantGroups.filter(group => group.some(id => ids.includes(id))).length
    const forbidden = ids.filter(id => c.expected.forbiddenTargets.includes(id))
    const precision = ids.length ? new Set(ids.filter(id => expected.has(id))).size / ids.length : 0
    return { caseId: c.id, kind: c.kind, queryType: c.queryType, query: c.query, status: row?.status || "missing", hit: rank >= 0, firstHit: rank === 0, reciprocalRank: rank >= 0 ? 1 / (rank + 1) : 0, precision, recall: ratio(groupsHit, c.expected.relevantGroups.length), returned: ids, forbidden, latencyMs: row?.latencyMs ?? null, warmLatencyMs: row?.warmLatencyMs ?? null, vectorAvailable: row?.retrieval?.vectorAvailable ?? false, rerank: row?.retrieval?.rerank || null, deletionTestable: !c.context.deletedTargets?.length || row?.deletionTargetsPresent === c.context.deletedTargets.length }
  })
  const positive = details.filter(c => c.kind === "positive")
  const negative = details.filter(c => c.kind === "negative" && c.status === "ok")
  const completed = details.filter(c => c.status === "ok")
  const slice = rows => ({ count: rows.length, hits: rows.filter(c => c.hit).length, hitAt5: ratio(rows.filter(c => c.hit).length, rows.length), firstHitRate: ratio(rows.filter(c => c.firstHit).length, rows.length), precisionAt5: ratio(rows.reduce((sum, c) => sum + c.precision, 0), rows.length), mrrAt5: ratio(rows.reduce((sum, c) => sum + c.reciprocalRank, 0), rows.length) })
  return {
    split, binding, supportedOnly,
    counts: { planned: cases.length, completed: completed.length, errors: details.filter(c => c.status === "error").length, missing: details.filter(c => c.status === "missing").length, positive: positive.length, positiveHits: positive.filter(c => c.hit).length, negative: negative.length, negativeFalseRecommendations: negative.filter(c => c.returned.length).length, vectorAvailable: completed.filter(c => c.vectorAvailable).length, rerankStates: Object.fromEntries([...new Set(completed.map(c => c.rerank))].map(state => [state, completed.filter(c => c.rerank === state).length])), untestableDeletionCases: details.filter(c => !c.deletionTestable).map(c => c.caseId), forbiddenReturned: details.reduce((sum, c) => sum + c.forbidden.length, 0), warmLatencySamples: completed.filter(c => Number.isFinite(c.warmLatencyMs)).length },
    metrics: { hitAt5: ratio(positive.filter(c => c.hit).length, positive.length), recallAt5: ratio(positive.reduce((sum, c) => sum + (c.recall || 0), 0), positive.length), firstHitRate: ratio(positive.filter(c => c.firstHit).length, positive.length), precisionAt5: ratio(positive.reduce((sum, c) => sum + c.precision, 0), positive.length), mrrAt5: ratio(positive.reduce((sum, c) => sum + c.reciprocalRank, 0), positive.length), negativeFalseRecommendationRate: ratio(negative.filter(c => c.returned.length).length, negative.length), coldP50Ms: percentile(completed.map(c => c.latencyMs), .5), coldP95Ms: percentile(completed.map(c => c.latencyMs), .95), warmP50Ms: percentile(completed.map(c => c.warmLatencyMs), .5), warmP95Ms: percentile(completed.map(c => c.warmLatencyMs), .95) },
    queryTypes: Object.fromEntries([...new Set(positive.map(c => c.queryType))].map(type => [type, slice(positive.filter(c => c.queryType === type))])),
    details,
  }
}

const reports = []
for (const mode of ["lexical", "hybrid", "hybrid-rerank"]) {
  let input
  try { input = JSON.parse(await fs.readFile(path.join(output, `${mode}.json`), "utf8")) }
  catch (error) { if (error.code === "ENOENT") continue; throw error }
  if (input.run.corpusIdentity !== manifest.corpusIdentity) throw new Error("corpus snapshot mismatch")
  if (input.run.datasetSha256 !== manifest.datasetSha256) throw new Error("benchmark snapshot mismatch")
  const calls = input.rows.flatMap(row => [...(row.calls || []), ...(row.warmCalls || [])])
  reports.push({ mode, modelCalls: Object.fromEntries(["embedTexts", "rerank"].map(operation => [operation, { attempted: calls.filter(c => c.operation === operation).length, succeeded: calls.filter(c => c.operation === operation && c.ok).length, failed: calls.filter(c => c.operation === operation && !c.ok).length }])), warmResultDifferences: input.rows.filter(r => r.warmResultsEqual === false).map(r => r.caseId), summaries: ["all", "development", "evaluation"].flatMap(split => [summarize(input, split, "original"), summarize(input, split, "audited"), summarize(input, split, "audited", true)]) })
}
const report = { generatedAt: new Date().toISOString(), manifest, limitations: [
  "全部方式检索同一份完整知识库快照，不是只检索 46 个目标组成的小库。",
  "主表采用事前确定的 7 项标识/正则版本映射；保留严格按原始标识计分的成绩。未根据检索结果修改答案。",
  "主指标保留知识库缺失目标造成的未命中；可支持目标子集只用于诊断，不替代完整分母。",
  "历史源码有变化或缺失，本次评测检验导入知识快照的检索效果，不验证当前所有插件功能可执行。",
  "211 条问法由源码整理，未经独立业务标注；固定验收集公开，不代表未见过的线上用户问题。",
  "Hit@5：前 5 条出现至少一个标注可接受指令的正例比例；首条准确率：第一条即为标注可接受指令的正例比例。",
  "Precision@5：每条正例前 5 个实际返回位置中，不同标注正确项占实际返回数的比例，再按正例取平均；空结果计 0。该值不等于问法命中率。",
  "首次查询指各方式独立进程中的首次问法请求，不清空 SQLite/操作系统缓存；热缓存指紧接着重复同一问法。",
  "延迟涵盖实际发生的在线 Embedding 和 Rerank，不包括最终 LLM 回答生成与消息投递。P95 只统计完成查询；错误和缺失另列。",
  "权限/歧义样本仅采集候选，没有最终回答判定；不执行登录、群管或其他真实指令，不修改生产知识。",
  "删除样本中原本就缺失的目标标为不可验证；易混淆/禁止候选是检索诊断，不是越权操作次数。",
  "模型失败与降级单独记录，不能将降级结果描述成成功运行了混合检索或重排。",
], reports }
await fs.writeFile(path.join(output, "summary.json"), JSON.stringify(report, null, 2) + "\n")
const pct = value => value == null ? "—" : `${(value * 100).toFixed(1)}%`
const num = value => value == null ? "—" : value.toFixed(1)
const score = value => value == null ? "—" : value.toFixed(4)
const esc = text => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const names = { lexical: "关键词", hybrid: "混合检索", "hybrid-rerank": "混合检索 + 重排" }
const csvRows = [["mode", "split", "binding", "supportedOnly", "positiveCount", "positiveHits", "Hit@5", "Top1Accuracy", "Precision@5", "MRR@5", "coldP50Ms", "coldP95Ms", "warmP50Ms", "warmP95Ms", "errors", "vectorAvailable", "rerankApplied", "rerankFallback"]]
for (const r of reports) for (const s of r.summaries) csvRows.push([r.mode, s.split, s.binding, s.supportedOnly, s.counts.positive, s.counts.positiveHits, s.metrics.hitAt5, s.metrics.firstHitRate, s.metrics.precisionAt5, s.metrics.mrrAt5, s.metrics.coldP50Ms, s.metrics.coldP95Ms, s.metrics.warmP50Ms, s.metrics.warmP95Ms, s.counts.errors, s.counts.vectorAvailable, s.counts.rerankStates.applied || 0, s.counts.rerankStates.failed_fallback || 0])
await fs.writeFile(path.join(output, "comparison.csv"), csvRows.map(row => row.join(",")).join("\n") + "\n")
function table(split) {
  return `<table><thead><tr><th>方式</th><th>正例命中 / 总数</th><th>Hit@5</th><th>首条准确率</th><th>Precision@5</th><th>MRR@5</th><th>首次查询 P50 / P95</th><th>热缓存 P50 / P95</th><th>错误数</th><th>向量有效 / 重排成功</th></tr></thead><tbody>${reports.map(r => {
    const s = r.summaries.find(s => s.split === split && s.binding === "audited" && !s.supportedOnly)
    return `<tr><td>${names[r.mode]}</td><td>${s.counts.positiveHits} / ${s.counts.positive}</td><td>${pct(s.metrics.hitAt5)}</td><td>${pct(s.metrics.firstHitRate)}</td><td>${pct(s.metrics.precisionAt5)}</td><td>${score(s.metrics.mrrAt5)}</td><td>${num(s.metrics.coldP50Ms)} / ${num(s.metrics.coldP95Ms)} ms</td><td>${num(s.metrics.warmP50Ms)} / ${num(s.metrics.warmP95Ms)} ms</td><td>${s.counts.errors}</td><td>${s.counts.vectorAvailable} / ${s.counts.rerankStates.applied || 0}</td></tr>`
  }).join("")}</tbody></table>`
}
function boundaryTable() {
  return `<table><tr><th>方式</th><th>无匹配反例误推荐</th><th>完成数</th><th>在线嵌入调用</th><th>在线重排调用</th></tr>${reports.map(r => {
    const s = r.summaries.find(s => s.split === "all" && s.binding === "audited" && !s.supportedOnly)
    return `<tr><td>${names[r.mode]}</td><td>${s.counts.negativeFalseRecommendations} / ${s.counts.negative}</td><td>${s.counts.completed} / ${s.counts.planned}</td><td>${r.modelCalls.embedTexts.succeeded} 成功 / ${r.modelCalls.embedTexts.failed} 失败</td><td>${r.modelCalls.rerank.succeeded} 成功 / ${r.modelCalls.rerank.failed} 失败</td></tr>`
  }).join("")}</table><p>反例仅 8 条，结果不能外推为线上误推荐率或安全保障。调用数不含单独保存的连通性探测。</p>`
}
function queryTypeTable() {
  const labels = { exact: "完整指令", paraphrase: "自然问法", typo: "错别字" }
  return `<table><tr><th>正例类型</th><th>数量</th>${reports.map(r => `<th>${names[r.mode]} Hit@5</th>`).join("")}</tr>${["exact", "paraphrase", "typo"].map(type => {
    const slices = reports.map(r => r.summaries.find(s => s.split === "all" && s.binding === "audited" && !s.supportedOnly).queryTypes[type])
    return `<tr><td>${labels[type]}</td><td>${slices[0]?.count || 0}</td>${slices.map(s => `<td>${pct(s?.hitAt5)}</td>`).join("")}</tr>`
  }).join("")}</table>`
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Yui Chat 检索评测</title><style>body{font:16px/1.65 system-ui,sans-serif;color:#172033;background:#f4f6fa;margin:0}main{max-width:1280px;margin:40px auto;padding:36px;background:white;border-radius:16px}h1{font-size:30px}h2{margin-top:32px;font-size:21px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:12px 9px;border-bottom:1px solid #dce2ec;text-align:left}th{background:#eef2fa}p,li{color:#40506a}.note{padding:16px;background:#fff6dd;border-radius:8px}code{font-size:13px}details{margin:14px 0}a{color:#2058bf}</style><main><h1>Yui Chat · 指令检索真实评测</h1><p>知识快照：${manifest.corpus.documents.toLocaleString()} 条知识 / ${manifest.corpus.plugins} 个插件来源 · ${dataset.cases.length} 条问法 · Top-${dataset.k} · 单查询串行</p><p>Embedding：${esc(manifest.settings.embedding)}（${manifest.settings.dimensions} 维）；Rerank：${esc(manifest.settings.reranker)}</p>${reports.length < 3 || reports.some(r => r.summaries.some(s => s.split === "all" && s.counts.completed !== s.counts.planned)) ? '<p class="note">当前报告尚未完成全部三种方式。缺失方式不计为零分，也不以降级结果代替。</p>' : ""}<h2>固定验收集</h2>${table("evaluation")}<p>命中率仅统计此集合中的正例；歧义、权限和反例分别记录。</p><h2>全部正例</h2>${table("all")}<p>全量成绩同时包含开发样本，不能称为独立测试成绩。</p><h2>自然问法与精确指令分开统计</h2>${queryTypeTable()}<h2>无匹配反例与模型调用</h2>${boundaryTable()}<h2>绑定核对</h2><p>${manifest.bindings.filter(b => b.status === "exact").length} 个目标完全匹配；${manifest.bindings.filter(b => b.status === "reviewed-alias").length} 个目标采用事前核对映射；${manifest.bindings.filter(b => b.status === "absent").length} 个目标缺失。原始标识成绩与缺失目标诊断保存在 JSON / CSV 中。</p><details><summary>查看映射与缺失目标</summary><table><tr><th>目标</th><th>状态</th><th>依据</th></tr>${manifest.bindings.filter(b => b.status !== "exact").map(b => `<tr><td>${esc(b.targetId)}</td><td>${esc(b.status)}</td><td>${esc(b.reason)}</td></tr>`).join("")}</table></details><h2>解释与边界</h2><ul>${report.limitations.map(t => `<li>${esc(t)}</li>`).join("")}</ul><p>可核对文件：<a href="summary.json">完整结果</a> · <a href="comparison.csv">对比表 CSV</a> · <a href="manifest.json">快照与参数</a></p><p>生成时间：${esc(report.generatedAt)}。仅展示检索结果，不代表最终回答或工具执行成功率。</p></main></html>`
await fs.writeFile(path.join(output, "report.html"), html)
console.log(JSON.stringify(reports.map(r => ({ mode: r.mode, modelCalls: r.modelCalls, all: r.summaries.find(s => s.split === "all" && s.binding === "audited" && !s.supportedOnly), evaluation: r.summaries.find(s => s.split === "evaluation" && s.binding === "audited" && !s.supportedOnly) })).map(r => ({ ...r, all: { counts: r.all.counts, metrics: r.all.metrics, queryTypes: r.all.queryTypes }, evaluation: { counts: r.evaluation.counts, metrics: r.evaluation.metrics, queryTypes: r.evaluation.queryTypes } })), null, 2))
