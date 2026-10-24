import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

// 仅校验静态基准和给定检索结果，不加载宿主、导入插件、运行指令或请求模型。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixture = path.join(root, "scripts/fixtures/command-retrieval-source-benchmark.json")
const digest = text => crypto.createHash("sha256").update(text).digest("hex")
const selectorKey = value => JSON.stringify([value.pluginKey, value.fnc, value.regexp, value.regexpFlags || ""])
const unique = rows => new Set(rows).size === rows.length

function validate(data) {
  assert.equal(data.version, 1)
  assert(Number.isInteger(data.k) && data.k > 0 && data.k <= 30)
  assert(data.targets.length && data.cases.length && data.files.length)
  assert(unique(data.targets.map(row => row.id)), "duplicate target IDs")
  assert(unique(data.targets.map(row => selectorKey(row.selector))), "ambiguous runtime selectors")
  assert(unique(data.cases.map(row => row.id)), "duplicate case IDs")
  assert(unique(data.files.map(row => row.file)), "duplicate source paths")
  const targets = new Map(data.targets.map(row => [row.id, row]))
  const sources = new Map(data.files.map(row => [row.file, row]))
  for (const source of data.files) {
    assert(/^[a-f0-9]{64}$/.test(source.sha256))
    assert(source.file.startsWith("plugins/") && !source.file.split("/").some(part => ["..", "chatgpt-plugin", "node_modules"].includes(part)), "invalid source scope")
    assert(Number.isInteger(source.lines) && source.lines > 0)
  }
  for (const target of data.targets) {
    assert(target.id && target.family && target.meaning && target.example)
    assert(target.selector.pluginKey && target.selector.fnc && target.selector.regexp)
    assert(target.selector.regexp.length < 1500 && target.example.length < 300)
    assert(new RegExp(target.selector.regexp, target.selector.regexpFlags).test(target.example), `${target.id}: example does not match registration`)
    assert(target.evidence.length >= 2 && target.executionConditions.length)
    for (const proof of target.evidence) {
      assert(sources.has(proof.file) && proof.claim)
      assert(Number.isInteger(proof.startLine) && Number.isInteger(proof.endLine) && proof.startLine > 0 && proof.endLine >= proof.startLine && proof.endLine <= sources.get(proof.file).lines)
    }
  }
  const families = new Map()
  for (const row of data.cases) {
    assert(["development", "evaluation"].includes(row.split))
    assert(["positive", "negative", "ambiguous", "policy"].includes(row.kind))
    assert(row.query && row.context.role && row.context.channel && row.queryType)
    assert(["recommend", "no-match", "clarify", "explain-restriction"].includes(row.expected.action))
    assert(Array.isArray(row.expected.relevantGroups) && Array.isArray(row.expected.forbiddenTargets) && row.expected.checks.length)
    for (const group of row.expected.relevantGroups) assert(group.length && unique(group) && group.every(id => targets.has(id)), `${row.id}: unknown target group`)
    const relevant = row.expected.relevantGroups.flat()
    assert(unique(relevant), `${row.id}: equivalence groups must not overlap`)
    for (const id of row.expected.forbiddenTargets) assert(targets.has(id) && !relevant.includes(id), `${row.id}: invalid forbidden target`)
    for (const id of row.context.deletedTargets || []) assert(targets.has(id))
    if (row.kind === "positive") {
      assert(relevant.length)
      for (const id of relevant) assert.equal(targets.get(id).family, row.family, `${row.id}: cross-family positive`)
      if (families.has(row.family)) assert.equal(row.split, families.get(row.family), `${row.family}: paraphrases leaked across splits`)
      families.set(row.family, row.split)
    }
    if (row.kind === "negative") assert.equal(relevant.length, 0)
  }
}

function resolveResults(results, data) {
  assert(Array.isArray(results), "ok rows need a results array")
  const byId = new Map(data.targets.map(row => [row.id, row]))
  const bySelector = new Map(data.targets.map(row => [selectorKey(row.selector), row.id]))
  return results.map(row => {
    assert(row && typeof row === "object")
    if (row.targetId != null) {
      assert(byId.has(row.targetId), `unknown targetId ${row.targetId}; use a full selector for other corpus commands`)
      return { ...byId.get(row.targetId).selector, ...row, key: row.targetId }
    }
    const command = row.metadata?.command || row.command || row
    assert(command.pluginKey && command.fnc && typeof command.regexp === "string", "unbound result: provide targetId or pluginKey + fnc + regexp + regexpFlags")
    const key = selectorKey(command)
    return { ...row, ...command, key: bySelector.get(key) || `unmapped:${key}` }
  })
}

function priority(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return undefined
  const number = Number(value)
  return Number.isNaN(number) ? undefined : number
}
function ordering(rows) {
  let checked = 0, missing = 0, violations = 0
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i]
    const left = priority(a.priority), right = priority(b.priority)
    // 未知优先级必须显式记录为 null；字段缺失代表尚未采集，不能当成已验证。
    if (!("priority" in a) || !("priority" in b)) { missing++; continue }
    checked++
    if (left === undefined && right !== undefined || left !== undefined && right !== undefined && left > right) { violations++; continue }
    if (left === undefined || left !== right) continue
    const ordinal = value => Number.isInteger(value) && value > 0
    if (!ordinal(a.pluginOrder) || !ordinal(b.pluginOrder)) { missing++; continue }
    if (a.pluginOrder > b.pluginOrder) violations++
    else if (a.pluginOrder === b.pluginOrder) {
      if (!ordinal(a.ruleOrder) || !ordinal(b.ruleOrder)) missing++
      else if (a.ruleOrder > b.ruleOrder) violations++
    }
  }
  return { checkedAdjacentPairs: checked, missingMetadataPairs: missing, violations }
}

function equivalentOrdering(rows) {
  const groups = new Map()
  const result = { checkedAdjacentPairs:0, missingMetadataPairs:0, violations:0 }
  for (const row of rows) {
    const name = String(row.suggestedCommand || (typeof row.command === "string" ? row.command : "") || row.title || "").toLowerCase().replace(/\s+/gu," ").trim()
    if (!name) { result.missingMetadataPairs++; continue }
    groups.set(name,[...(groups.get(name)||[]),row])
  }
  for (const group of groups.values()) {
    const checked = ordering(group)
    for (const key of Object.keys(result)) result[key] += checked[key]
  }
  return result
}

function score(data, rows, split, applyOrdering) {
  const selected = data.cases.filter(row => split === "all" || row.split === split)
  const known = new Set(data.cases.map(row => row.id))
  assert(unique(rows.map(row => row.caseId)), "duplicate result rows")
  const results = new Map()
  for (const row of rows) {
    assert(known.has(row.caseId), `unknown case ${row.caseId}`)
    assert(["ok", "error", "skipped"].includes(row.status), "rows must explicitly report ok, error or skipped")
    if (row.status !== "ok") assert(row.reason, "errors/skips need a reason")
    results.set(row.caseId, { ...row, bound: row.status === "ok" ? resolveResults(row.results, data) : [] })
  }
  const totals = { planned: selected.length, completed: 0, missing: 0, errors: 0, skipped: 0, positiveCases: 0, hitAtK: 0, recallAtK: 0, firstHit: 0, mrrAtK: 0, precisionAtK: 0, negativeCompleted: 0, negativeFalseRecommendations: 0, forbiddenReturned: 0, unmappedResults: 0, duplicateResults: 0, priorityViolations: 0, priorityCheckedPairs: 0, priorityMissingPairs: 0, humanReviewed: 0, humanPassed: 0 }
  const details = [], slices = {}, latency = []
  for (const c of selected) {
    const row = results.get(c.id)
    if (!row) totals.missing++
    else if (row.status === "error") totals.errors++
    else if (row.status === "skipped") totals.skipped++
    else totals.completed++
    const top = (row?.bound || []).slice(0, data.k)
    const keys = top.map(r => r.key), uniq = new Set(keys)
    totals.duplicateResults += keys.length - uniq.size
    const relevant = new Set(c.expected.relevantGroups.flat())
    const hitGroups = c.expected.relevantGroups.filter(group => group.some(id => uniq.has(id))).length
    const rank = keys.findIndex(id => relevant.has(id))
    const forbidden = top.filter(item => c.expected.forbiddenTargets.includes(item.key) || c.context?.blockedPlugins?.includes(item.pluginKey)).map(item => item.key)
    totals.unmappedResults += keys.filter(id => id.startsWith("unmapped:")).length
    totals.forbiddenReturned += forbidden.length
    const order = applyOrdering === "equivalent" ? equivalentOrdering(top) : applyOrdering ? ordering(top) : { violations: 0, checkedAdjacentPairs: 0, missingMetadataPairs: 0 }
    totals.priorityViolations += order.violations; totals.priorityCheckedPairs += order.checkedAdjacentPairs; totals.priorityMissingPairs += order.missingMetadataPairs
    if (c.kind === "positive") {
      totals.positiveCases++
      totals.hitAtK += rank >= 0 ? 1 : 0
      totals.firstHit += rank === 0 ? 1 : 0
      totals.mrrAtK += rank < 0 ? 0 : 1 / (rank + 1)
      totals.recallAtK += hitGroups / c.expected.relevantGroups.length
      totals.precisionAtK += keys.length ? [...uniq].filter(id => relevant.has(id)).length / keys.length : 0
      const bucket = slices[c.queryType] ||= { count: 0, hits: 0, first: 0 }
      bucket.count++; bucket.hits += rank >= 0 ? 1 : 0; bucket.first += rank === 0 ? 1 : 0
    }
    if (c.kind === "negative" && row?.status === "ok") { totals.negativeCompleted++; if (keys.length) totals.negativeFalseRecommendations++ }
    const requiresReview = ["policy", "ambiguous"].includes(c.kind)
    const reviewed = row?.status === "ok" && row.review && typeof row.review.checksPassed === "boolean" && typeof row.review.action === "string"
    if (requiresReview && reviewed) { totals.humanReviewed++; if (row.review.checksPassed && row.review.action === c.expected.action) totals.humanPassed++ }
    if (row?.status === "ok" && Number.isFinite(row.latencyMs) && row.latencyMs >= 0) latency.push(row.latencyMs)
    details.push({ caseId:c.id, kind:c.kind, status:row?.status || "missing", returned:keys, expectedGroups:c.expected.relevantGroups, hit:rank >= 0, rank:rank < 0 ? null : rank + 1, forbidden, ordering:order, manualReview:requiresReview ? reviewed ? "recorded" : "pending" : "not-required", reason:row?.reason })
  }
  const divide = (a,b) => b ? a / b : null
  latency.sort((a,b)=>a-b)
  return { k:data.k, split, counts:{...totals,latencySamples:latency.length,humanReviewPlanned:selected.filter(row=>["policy","ambiguous"].includes(row.kind)).length}, metrics:{completionRate:divide(totals.completed,totals.planned), hitAtK:divide(totals.hitAtK,totals.positiveCases), recallAtK:divide(totals.recallAtK,totals.positiveCases), firstHit:divide(totals.firstHit,totals.positiveCases), mrrAtK:divide(totals.mrrAtK,totals.positiveCases), precisionAtK:divide(totals.precisionAtK,totals.positiveCases), negativeFalseRecommendationRate:divide(totals.negativeFalseRecommendations,totals.negativeCompleted), humanReviewPassRate:divide(totals.humanPassed,totals.humanReviewed), latencyP95Ms:latency.length ? latency[Math.ceil(latency.length*0.95)-1] : null}, slices, details }
}

function selfTest() {
  const target = id => ({id,selector:{pluginKey:id,fnc:"same",regexp:"^#test$",regexpFlags:""}})
  const expected = relevantGroups => ({relevantGroups,forbiddenTargets:[],action:"recommend"})
  const data = {k:3,targets:[target("a"),target("alias"),target("b")],cases:[{id:"p",split:"development",kind:"positive",queryType:"exact",expected:expected([["a","alias"],["b"]])},{id:"n",split:"development",kind:"negative",expected:expected([])}]}
  const report = score(data,[{caseId:"p",status:"ok",results:[{targetId:"alias"},{targetId:"alias"}]},{caseId:"n",status:"ok",results:[]}],"all",false)
  assert.equal(report.metrics.recallAtK,0.5); assert.equal(report.metrics.hitAtK,1); assert.equal(report.metrics.precisionAtK,0.5); assert.equal(report.counts.duplicateResults,1)
  assert.equal(report.metrics.negativeFalseRecommendationRate,0)
  assert.equal(score(data,[],"all",false).metrics.completionRate,0)
  assert.equal(score(data,[],"all",false).metrics.hitAtK,0)
  assert.equal(score(data,[],"all",false).metrics.negativeFalseRecommendationRate,null)
  const splitData = {...data,cases:data.cases.map(row=>({...row,split:row.id === "p" ? "development" : "evaluation"}))}
  assert.equal(score(splitData,[{caseId:"p",status:"skipped",reason:"not run"},{caseId:"n",status:"ok",results:[]}],"evaluation",false).counts.completed,1)
  assert.equal(resolveResults([{priority:300,metadata:{command:target("a").selector}}],data)[0].priority,300)
  assert.equal(ordering([{priority:"-Infinity"},{priority:0},{priority:"Infinity"},{priority:null}]).violations,0)
  assert.equal(ordering([{priority:0},{priority:"-Infinity"}]).violations,1)
  assert.equal(ordering([{priority:null},{priority:0}]).violations,1)
  assert.equal(ordering([{priority:0,pluginOrder:2},{priority:0,pluginOrder:1}]).violations,1)
  assert.equal(ordering([{priority:0,pluginOrder:1,ruleOrder:2},{priority:0,pluginOrder:1,ruleOrder:1}]).violations,1)
  assert.equal(ordering([{},{}]).missingMetadataPairs,1)
  assert.equal(equivalentOrdering([{suggestedCommand:"#体力",priority:300},{suggestedCommand:"#查战绩",priority:1}]).violations,0)
  assert.equal(equivalentOrdering([{suggestedCommand:"#体力",priority:300},{suggestedCommand:"#查战绩",priority:1},{suggestedCommand:"#体力",priority:5}]).violations,1)
  const failedNegative = score(data,[{caseId:"n",status:"ok",results:[{targetId:"a"}]}],"all",false)
  assert.equal(failedNegative.metrics.negativeFalseRecommendationRate,1)
  const protectedCase = {...data.cases[1],id:"policy",kind:"policy",context:{blockedPlugins:["outside"]},expected:{...expected([]),action:"no-match"}}
  const policy = {...data,cases:[protectedCase]}
  const policyResult = score(policy,[{caseId:"policy",status:"ok",results:[{pluginKey:"outside",fnc:"other",regexp:"^#other$"}]}],"all",false)
  assert.equal(policyResult.counts.forbiddenReturned,1); assert.equal(policyResult.counts.unmappedResults,1); assert.equal(policyResult.counts.humanReviewed,0)
  assert.equal(score(policy,[{caseId:"policy",status:"ok",results:[],review:{checksPassed:true,action:"no-match"}}],"all",false).counts.humanPassed,1)
  assert.throws(()=>score(data,[{caseId:"p",status:"ok",results:[{fnc:"same"}]}],"all",false),/unbound/)
  assert.throws(()=>score(data,[{caseId:"p",status:"ok",results:[{targetId:"a"}]},{caseId:"p",status:"ok",results:[]}],"all",false),/duplicate/)
}

const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i++) {
  const flag = args[i]
  assert(["--results", "--split", "--host-root"].includes(flag), `unknown option ${flag}`)
  assert(args[i+1] && !args[i+1].startsWith("--"), `${flag} requires a value`)
  options[flag] = args[++i]
}
const raw = await fs.readFile(fixture,"utf8"), data = JSON.parse(raw)
validate(data); selfTest()
const hostRoot = path.resolve(options["--host-root"] || path.join(root,"../.."))
const sources = {verified:[],missing:[],changed:[]}
for (const source of data.files) {
  try {
    const contents = await fs.readFile(path.join(hostRoot,source.file),"utf8")
    sources[digest(contents) === source.sha256 ? "verified" : "changed"].push(source.file)
  } catch (error) {
    if (error.code === "ENOENT") sources.missing.push(source.file)
    else throw error
  }
}
const split = options["--split"] || "all"
assert(["all","development","evaluation"].includes(split))
const status = {datasetSha256:digest(raw),targets:data.targets.length,cases:data.cases.length,sources,scorerSelfTest:"passed",paidModelCalls:0}
if (options["--results"]) {
  const input = JSON.parse(await fs.readFile(path.resolve(options["--results"]),"utf8"))
  assert.equal(input.run?.datasetSha256,status.datasetSha256,"results belong to a different benchmark revision")
  assert(input.run?.corpusIdentity && input.run?.mode,"record corpus snapshot and retrieval mode")
  assert(Array.isArray(input.rows))
  const orderingMode = input.run.ordering === "relevance-with-command-priority" ? "equivalent" : input.run.ordering === "framework-priority"
  console.log(JSON.stringify({...status,run:input.run,sourceReviewRequired:sources.changed.length>0 || sources.missing.length>0,report:score(data,input.rows,split,orderingMode)},null,2))
} else {
  console.log(JSON.stringify({...status,qualityEvaluation:"not-run"},null,2))
  if (sources.changed.length) process.exitCode=1
}
