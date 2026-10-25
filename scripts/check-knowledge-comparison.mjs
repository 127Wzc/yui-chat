import assert from "node:assert/strict"
import * as vue from "vue"
import { renderToString } from "vue/server-renderer"
import { KnowledgeRetrievalResults } from "../output/runtime/web/client/features/knowledge/knowledge-retrieval-results.js"

const candidates = [
  { id:"a", title:'丙 <img src=x onerror="alert(1)">', content:"正文第一行\n正文第二行", recallRank:1, lexicalRelevance:0.6, vectorSimilarity:0.7, score:0.02, rerankRank:2, rerankScore:0.5, processingResult:"return_limit" },
  { id:"b", title:"甲", content:"关键词结果", recallRank:2, lexicalRelevance:1, vectorSimilarity:0, score:0.03, rerankRank:3, rerankScore:0, processingResult:"below_threshold" },
  { id:"c", title:"乙", content:"仅向量命中", recallRank:3, vectorSimilarity:0.9, score:0, rerankRank:1, rerankScore:0.9, processingResult:"returned", finalRank:1 },
  { id:"d", title:"丁", content:"未重排的候选", recallRank:4, lexicalRelevance:0, score:0.01, processingResult:"input_budget" },
]
const trace = { query:"查询体力", candidates, directResultIds:["a","b"], finalResultIds:["c"], rerankSucceeded:true, rerank:{scores:candidates.filter(row=>row.rerankScore!==undefined).map(row=>({id:row.id,score:row.rerankScore})),elapsedMs:20},config:{minRelevance:0.55,rerankMinScore:0.3,resultLimit:2,rerankResultLimit:1,weights:[{baseId:"fixture",keyword:1,vector:0.65}]} }
const props = vue.reactive({trace, diagnostics:{rerank:"applied",mode:"hybrid"}})
const scope = vue.effectScope()
const ui = scope.run(()=>KnowledgeRetrievalResults.setup(props))
const ids = ()=>Array.from(ui.sortedRows?.value || ui.visibleRows.value,row=>row.id)
try {
  assert.deepEqual(ids(),["c","a","b","d"],"successful rerank defaults to descending score")
  assert.deepEqual(ui.columns.map(column=>column.key),["title","lexicalRelevance","recallRank","vectorSimilarity","score","rerankRank","rerankScore","processingResult"])
  for(const [key,asc,desc] of [
    ["lexicalRelevance",["d","a","b","c"],["b","a","d","c"]],
    ["recallRank",["a","b","c","d"],["d","c","b","a"]],
    ["vectorSimilarity",["b","a","c","d"],["c","a","b","d"]],
    ["score",["c","d","a","b"],["b","a","d","c"]],
    ["rerankRank",["c","a","b","d"],["b","a","c","d"]],
    ["rerankScore",["b","a","c","d"],["c","a","b","d"]],
    ["processingResult",["c","a","b","d"],["d","b","a","c"]],
  ]) {
    if(ui.sortKey.value===key && ui.sortDirection.value==="asc")ui.sortColumn(key)
    ui.sortColumn(key);assert.equal(ui.sortDirection.value,"asc");assert.deepEqual(ids(),asc,key)
    ui.sortColumn(key);assert.deepEqual(ids(),desc,key)
  }
  ui.sortColumn("title");const alphabetic=ids();ui.sortColumn("title");assert.deepEqual(ids(),[...alphabetic].reverse())
  ui.sortColumn("lexicalRelevance");const before=ids()
  ui.view.value="direct";assert.deepEqual(ids(),["a","b"])
  ui.view.value="reranked";assert.deepEqual(ids(),["c"])
  ui.view.value="overview";assert.deepEqual(ids(),before,"switching views preserves the chosen sort")
  ui.toggleExpanded("a");assert(ui.expanded.value.includes("a"));ui.view.value="direct";ui.view.value="overview";assert(ui.expanded.value.includes("a"))
  assert.equal(ui.percentage(0),"0.0%");assert.equal(ui.formatNumber(0),"0.0000");assert.equal(ui.formatNumber(undefined),"—")
  props.diagnostics={rerank:"disabled",mode:"lexical"};props.trace={...trace,rerankSucceeded:false};await vue.nextTick()
  assert.equal(ui.sortKey.value,"score");assert.deepEqual(ids(),["b","a","d","c"],"fallback defaults to fusion score, not original recall position")
  assert.equal(ui.score(candidates[0]),"—");assert.equal(ui.rerankRank(candidates[0]),"—")
  ui.view.value="reranked";assert.equal(ui.visibleRows.value.length,0)
  props.diagnostics={rerank:"cached",mode:"hybrid"};props.trace={...trace};await vue.nextTick()
  assert.equal(ui.sortKey.value,"rerankScore");assert.equal(ui.view.value,"overview");assert.equal(ui.expanded.value.length,0)
  assert.deepEqual(ids(),["c","a","b","d"])
} finally { scope.stop() }

async function render(testTrace, diagnostics, configure=()=>{}) {
  const component={...KnowledgeRetrievalResults,setup(props,context){const state=KnowledgeRetrievalResults.setup(props,context);configure(state);return state}}
  const app=vue.createSSRApp(component,{trace:testTrace,diagnostics})
  app.component("Icon",{template:"<span />"})
  return renderToString(app)
}
const html=await render(trace,{rerank:"applied",mode:"hybrid"},state=>state.toggleExpanded("a"))
assert.equal((html.match(/<th /g)||[]).length,8)
assert.equal((html.match(/aria-sort="descending"/g)||[]).length,1)
assert(!html.includes("<select"),"sorting is controlled by column headers")
assert(html.includes("关键词覆盖率"));assert(html.includes("向量相似度"));assert(html.includes("0.0%"));assert(html.includes("0.0000"))
assert(html.includes("完整正文"));assert(html.includes("正文第一行\n正文第二行"))
assert(html.includes("&lt;img"));assert(!html.includes('<img src=x'))
const inactive=await render({...trace,rerankSucceeded:false},{rerank:"disabled",mode:"lexical"})
const inactiveBody=inactive.match(/<tbody>([\s\S]*?)<\/tbody>/)[1]
for(const row of inactiveBody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
  const cells=Array.from(row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g),m=>m[1])
  assert(cells[5].startsWith("—"));assert.equal(cells[6],"—","disabled results never display stale rerank scores")
}
const noRank=await render({...trace,rerankSucceeded:false},{rerank:"disabled",mode:"lexical"},state=>state.view.value="reranked")
assert(noRank.includes("本次没有重排结果"));assert(!noRank.includes('class="knowledge-result-card"'))
assert(!html.includes("额度"));assert(!html.includes("调用次数"),"the result view has no retired quota notice")
console.log("ok knowledge comparison: eight column sorts, null/zero values, score defaults, same-query views, full escaped content, state reset and quota-free presentation")
