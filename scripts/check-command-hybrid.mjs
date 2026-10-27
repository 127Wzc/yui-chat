import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import crypto from "node:crypto"
import ts from "typescript"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "yui-hybrid-"))
process.env.YUI_CHAT_RUNTIME_ROOT = root
global.logger = { warn(){}, error(){}, debug(){}, info(){}, mark(){} }
const requests = []
let mode = "ok"
const server = http.createServer(async (req, res) => {
  let input = ""
  for await (const part of req) input += part
  const body = JSON.parse(input)
  requests.push({ path:req.url, body, authorization:req.headers.authorization })
  if (mode === "wait") return
  const results = mode === "duplicate" ? [{index:0,relevance_score:1},{index:0,relevance_score:0}]
    : mode === "missing" ? [{index:0,relevance_score:1}]
    : mode === "invalid" ? [{index:0,relevance_score:"0.9"},{index:1,relevance_score:0}]
    : [{index:1,relevance_score:2.5},{index:0,relevance_score:-1}]
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({ results, usage:{prompt_tokens:5,total_tokens:5} }))
})
await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve)})
try {
  const { OpenAICompatibleAdapter } = await import("../output/runtime/models/adapters/openai/chat/adapter.js")
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { addModelsToProvider, updateModelConfig } = await import("../output/runtime/models/configuration/editor.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { providerResolver } = await import("../output/runtime/models/routing/provider-resolver.js")
  const { cleanCommandRetrievalText, isSendableCommand } = await import("../output/runtime/knowledge/command-retrieval-text.js")
  const { orderEquivalentCommandMatches, collapseEquivalentCommandMatches } = await import("../output/runtime/knowledge/command-document-builder.js")
  const { selectRelevantCommandCandidates, findCommandMatches } = await import("../output/runtime/knowledge/command-query-service.js")
  const { lexicalIndexText, lexicalTerms } = await import("../output/runtime/knowledge/lexical-text.js")
  const { estimateTokens, truncateTextToTokens } = await import("../output/runtime/core/chat/token-budget.js")
  const adapter = new OpenAICompatibleAdapter()
  const channel = { type:"openai-compatible", model:"bge-reranker-v2-m3", baseURL:`http://127.0.0.1:${server.address().port}/v1`, apiKey:"fixture-secret", timeoutMs:1000, modelConfig:{purpose:"rerank",rerank:{params:{extra:true,query:"must not override",top_n:1}}} }
  const input = { channel, query:"如何拿原图", documents:["查看天气","获取原图"] }
  const response = await adapter.rerank(input)
  assert.deepEqual(response.results,[{index:1,score:2.5},{index:0,score:-1}],"keep provider score scale and input indices")
  assert.equal(requests[0].path,"/v1/rerank")
  assert.equal(requests[0].authorization,"Bearer fixture-secret")
  assert.equal(requests[0].body.query,input.query)
  assert.equal(requests[0].body.top_n,2)
  assert.equal(requests[0].body.return_documents,false)
  assert.equal(requests[0].body.extra,true)
  for (mode of ["duplicate","missing","invalid"]) await assert.rejects(adapter.rerank(input),/重排结果/)
  mode="wait"
  const controller=new AbortController()
  const cancelled=adapter.rerank({...input,signal:controller.signal})
  controller.abort(new Error("fixture canceled"))
  await assert.rejects(cancelled,/fixture canceled/)
  mode="ok"

  let cfg=structuredClone(defaults)
  cfg.apiProviders.push({name:"rank-provider",type:"openai-compatible",baseURL:channel.baseURL,authType:"none"})
  cfg=addModelsToProvider(cfg,"rank-provider",["bge-reranker-v2-m3"],{purpose:"rerank"})
  const rank=cfg.models.find(model=>model.purpose==="rerank")
  assert(rank && rank.capabilities.chat===false && rank.capabilities.embedding===false)
  assert(!cfg.modelTasks.replyer.modelList.includes(rank.name))
  assert.equal(providerResolver.buildChannel(rank,cfg).purpose,"rerank")
  const { configStore } = await import("../output/runtime/config/store.js")
  const originalLoad=configStore.load
  try {
    configStore.load=async()=>cfg
    assert.equal((await providerResolver.listChannels()).find(row=>row.id===rank.name)?.purpose,"rerank")
  } finally { configStore.load=originalLoad }
  cfg.knowledge.retrieval.rerankEnabled=true
  cfg.knowledge.retrieval.rerankModel=rank.name
  cfg.knowledge.retrieval.rerankMinScore=-0.5
  assert.equal(validateConfig(cfg).ok,true,JSON.stringify(validateConfig(cfg).errors))
  const invalidAgent=structuredClone(cfg);invalidAgent.subAgent.task="rerank"
  assert(validateConfig(invalidAgent).errors.some(row=>row.path==="subAgent.task"))
  const invalid=structuredClone(cfg);invalid.knowledge.retrieval.rerankMinScore="0.5"
  assert.equal(validateConfig(invalid).ok,false)
  const changed=updateModelConfig(cfg,rank.name,{purpose:"chat"})
  assert.equal(changed.models.find(model=>model.name===rank.name).rerank,undefined)
  assert(!changed.modelTasks.rerank.modelList.includes(rank.name))

  const raw="插件名称：测试\n指令：#原图\n用途：获取此前图片\npriority：-Infinity\nregexp：^#原图$|^x\n用途：不能进入检索$\nregexpFlags：\"i\"\n示例：#原图"
  const cleaned=cleanCommandRetrievalText(raw,{regexp:"^#原图$|^x\n用途：不能进入检索$"})
  assert.equal(cleaned,"插件名称：测试\n指令：#原图\n用途：获取此前图片\n示例：#原图")
  assert.equal(isSendableCommand({event:"notice.group.poke",suggestedCommand:"#戳一戳"}),false)
  assert.equal(isSendableCommand({event:"message",regexp:"^(.*)"}),false)
  assert.equal(isSendableCommand({event:"message",regexp:"^(.*)$",suggestedCommand:"#已确认入口"}),true)
  assert(lexicalTerms("怎么拿原图 stoken ws").includes("原图"))
  assert(lexicalIndexText("#原图 stoken ws").includes("stoken ws"))
  const { default: Database } = await import("better-sqlite3")
  const lexicalDb=new Database(":memory:")
  try {
    lexicalDb.exec("CREATE VIRTUAL TABLE fixture_fts USING fts5(id UNINDEXED,content,tokenize='unicode61')")
    const insert=lexicalDb.prepare("INSERT INTO fixture_fts(id,content) VALUES(?,?)")
    insert.run("repeated",lexicalIndexText("原图 原图"))
    insert.run("single",lexicalIndexText("原图 天气"))
    assert.equal(lexicalDb.prepare("SELECT id FROM fixture_fts WHERE fixture_fts MATCH ? ORDER BY bm25(fixture_fts)").all('"原图"')[0].id,"repeated","document projection retains term frequency for real BM25 ranking")
  } finally { lexicalDb.close() }

  const candidate=(id,command,priority)=>({id,suggestedCommand:command,priority})
  const candidates=[candidate("low","#原图",100),candidate("other","*原图",-1000),candidate("first","#原图","-Infinity"),candidate("last","#原图",200),candidate("different","#面板",-99999)]
  assert.deepEqual(orderEquivalentCommandMatches(candidates).map(row=>row.id),["first","other","low","last","different"])
  assert.deepEqual(collapseEquivalentCommandMatches(orderEquivalentCommandMatches(candidates)).map(row=>row.id),["first","other","low","different"])
  const noConflict=[{id:"a",suggestedCommand:"#a",get priority(){throw Error("must skip sorting")}}, {id:"b",suggestedCommand:"#b",get priority(){throw Error("must skip sorting")}}]
  assert.deepEqual(orderEquivalentCommandMatches(noConflict),noConflict)
  const spaces=noConflict.map((row,index)=>({...Object.getOwnPropertyDescriptors(row),suggestedCommand:{value:index ? "#a b" : "#a  b",enumerable:true}})).map(descriptors=>Object.defineProperties({},descriptors))
  assert.deepEqual(orderEquivalentCommandMatches(spaces),spaces,"different internal whitespace must not create a false conflict")
  assert.equal(selectRelevantCommandCandidates([{...candidate("covered","#原图",0),lexicalRelevance:1},candidate("semantic","#高清图",1)]).results.length,2,"full keyword coverage must not discard semantic candidates")
  const prefixMatches=findCommandMatches([candidate("hash","#原图",0),candidate("star","*原图",0)].map(row=>({...row,retrievalText:`指令：${row.suggestedCommand}`})),"*原图",{prioritizeCommands:false})
  assert(!prefixMatches.some(row=>row.id==="hash" && row.exactCommandMatch))
  assert.equal(prefixMatches.find(row=>row.id==="star")?.exactCommandMatch,true)

  // Use the real rerank orchestrator with isolated configuration; no paid requests.
  const exports={}
  let calls=0,fail=false,legacy=false
  vm.runInNewContext(ts.transpileModule(await fs.readFile(new URL("../models/retrieval-rerank.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports,AbortController,setTimeout,clearTimeout,require:specifier=>{
      if(specifier==="node:crypto")return {default:crypto}
      if(specifier.includes("config/store"))return {configStore:{get:()=>cfg},dataDir:root}
      if(specifier.includes("token-budget"))return {estimateTokens,truncateTextToTokens}
      if(specifier.includes("provider-resolver"))return {modelPurpose:model=>model.purpose,providerResolver}
      if(specifier.includes("adapters/registry"))return {adapterRegistry:{async rerank(request){calls++;if(fail)throw Error("fixture down");return adapter.rerank(request)}}}
      if(specifier.includes("isolated-task"))return {runIsolatedModelTask(){if(!legacy)throw Error("dedicated model must not use chat");return {channel:"legacy-fallback",text:JSON.stringify([{id:"weather",relevance:0.1},{id:"image",relevance:0.9}])}}}
      throw Error("unexpected dependency "+specifier)
    },
  })
  const rows=[{id:"weather",title:"天气",content:"查看天气",score:0.02},{id:"image",title:"原图",content:"获取原图",score:0.01}]
  const settings={...cfg.knowledge.retrieval,rerankMinScore:null}
  assert.equal(defaults.knowledge.retrieval.rerankMinScore,0.3)
  assert.equal(defaults.knowledge.retrieval.rerankResultLimit,5)
  const disabled=await exports.rerankCandidates({},"原图",rows,{...settings,rerankEnabled:false})
  assert.equal(disabled.state,"disabled");assert.equal(calls,0)
  const ranked=await exports.rerankCandidates({},"原图",rows,settings)
  assert.equal(ranked.state,"applied");assert.deepEqual(Array.from(ranked.results,row=>row.id),["image","weather"])
  assert.equal(calls,1)
  const filtered=await exports.rerankCandidates({},"原图",rows,{...settings,rerankMinScore:0})
  assert.equal(filtered.state,"cached");assert.deepEqual(Array.from(filtered.results,row=>row.id),["image"])
  assert.equal(calls,1,"threshold edits reuse scores without extra requests")
  const defaultFiltered=await exports.rerankCandidates({},"原图",rows,{...settings,rerankMinScore:defaults.knowledge.retrieval.rerankMinScore})
  assert.deepEqual(Array.from(defaultFiltered.results,row=>row.id),["image"],"the default cutoff also accepts provider scores above one")
  const traced=await exports.rerankCandidates({},"原图",rows,{...settings,rerankMinScore:0},undefined,true)
  assert.equal(traced.state,"cached");assert.equal(calls,1)
  assert.equal(traced.trace.scores.length,2,"the trace retains scores below the cutoff")
  assert.equal(traced.trace.scores.find(row=>row.id==="weather").score,-1)
  assert.equal(traced.trace.model,channel.model,"cache preserves the actual model even when the original call did not request a trace")
  assert.equal(ranked.trace,undefined)
  fail=true
  const fallback=await exports.rerankCandidates({},"另一个问题",rows,settings,undefined,true)
  assert.equal(fallback.state,"failed_fallback");assert.deepEqual(fallback.results,rows)
  assert.equal(fallback.trace.scores.length,0)
  fail=false
  const beforeRepeated=calls
  const event={user_id:"reader",sessionId:"same-session"}
  for(let i=0;i<105;i++){
    const result=await exports.rerankCandidates(event,`连续重排 ${i}`,rows,settings,undefined,true)
    assert.equal(result.state,"applied");assert.equal(result.results[0].rerankScore,2.5)
    assert(!Object.hasOwn(result.trace,"budget"));assert(!Object.hasOwn(result.trace,"budgetMode"))
  }
  assert.equal(calls,beforeRepeated+105,"one conversation can run more than the former daily call ceiling")
  const beforeOff=calls
  assert.equal((await exports.rerankCandidates(event,"关闭重排",rows,{...settings,rerankEnabled:false})).state,"disabled")
  assert.equal(calls,beforeOff)
  legacy=true;rank.purpose="chat";cfg.models.push({name:"legacy-fallback",purpose:"chat",modelIdentifier:"actual-chat-ranker"})
  const legacyResult=await exports.rerankCandidates({},"对话模型重排",rows,settings,undefined,true)
  assert.equal(legacyResult.state,"applied");assert.equal(legacyResult.trace.model,"actual-chat-ranker","legacy task fallback reports the model actually used")
  console.log("ok command hybrid: real /rerank HTTP, score/index validation, cancellation, purpose routing, clean text, Chinese terms, prefix distinction, conflict-only sorting, disabled/cache/failure and repeated calls")
} finally {
  server.closeAllConnections()
  await new Promise(resolve=>server.close(resolve))
  await fs.rm(root,{recursive:true,force:true})
}
