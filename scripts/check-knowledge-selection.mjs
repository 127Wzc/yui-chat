import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "yui-knowledge-selection-"))
process.env.YUI_CHAT_RUNTIME_ROOT = root
const host=path.join(root,"host")
process.env.YUI_CHAT_PLUGIN_ROOT=path.join(host,"plugins/yui-chat")
await fs.mkdir(path.join(host,"plugins/yui-chat"),{recursive:true})
await fs.mkdir(path.join(host,"lib/plugins"),{recursive:true})
await fs.writeFile(path.join(host,"package.json"),'{"type":"module"}')
await fs.writeFile(path.join(host,"lib/plugins/loader.js"),'export default {priority:[],deal:async()=>false}')
global.logger = { info(){}, warn(){}, error(){}, debug(){}, mark(){} }
let sqliteClient
let jobs
try {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { knowledgeStore } = await import("../output/runtime/knowledge/store.js")
  const { knowledgeRepository } = await import("../output/runtime/knowledge/repository.js")
  const { commandImports } = await import("../output/runtime/knowledge/command-import.js")
  const { searchKnowledgeDetailed, knowledgeQueryTerms } = await import("../output/runtime/knowledge/retrieval.js")
  const { normalizeSearchQuery } = await import("../output/runtime/knowledge/command-document-builder.js")
  const { estimateTokens, selectPromptTools, isBotCommandQuery } = await import("../output/runtime/core/chat/token-budget.js")
  const { vectorIndex } = await import("../output/runtime/knowledge/vector-index.js")
  const { KnowledgeManageTool } = await import("../output/runtime/tools/builtins/command.js")
  const { ToolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { modelToolDefinition, responsesToolDefinition } = await import("../output/runtime/tools/support/contract.js")
  ;({ knowledgeIndexJobs: jobs } = await import("../output/runtime/knowledge/index-jobs.js"))
  let embedCalls = 0
  adapterRegistry.register({ id: "selection-embed", supportsEmbeddings: true, async embedTexts({channel,texts,dimensions}) {
    embedCalls++
    return { model: channel.model, dimensions, vectors: texts.map(()=>[1,0]), usage:{promptTokens:texts.length,completionTokens:0,totalTokens:texts.length} }
  } })
  await configStore.load()
  await sqliteClient.init(defaults)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  await configStore.update(c=>{
    c.apiProviders.push({name:"selection",type:"selection-embed"},{name:"rank-provider",type:"openai-compatible",baseURL:"https://example.invalid/v1"})
    c.models.push({name:"selection-embed",adapter:"selection-embed",apiProvider:"selection",modelIdentifier:"selection-embed",purpose:"embedding",capabilities:{chat:false,embedding:true},embedding:{defaultDimensions:2,allowedDimensions:[2],batchSize:32,timeoutMs:10000}},
      {name:"selection-rank",adapter:"openai-compatible",apiProvider:"rank-provider",modelIdentifier:"rank",purpose:"rerank",capabilities:{chat:false,embedding:false}})
    c.modelTasks.rerank={purpose:"rerank",modelList:["selection-rank"],selectionStrategy:"fallback"}
    c.knowledge.indexing.concurrency=6
    c.knowledge.retrieval.rerankEnabled=false
    c.knowledge.retrieval.resultLimit=20
  })
  await knowledgeStore.init()
  jobs.scheduleAvailable=()=>{}
  const master={isMaster:true,user_id:"owner"}, user={user_id:"reader"}, otherUser={user_id:"other"}
  const bases=[]
  for(let i=0;i<6;i++){
    const base=await knowledgeStore.create({name:`资料${i}`,description:`业务${i}的用途和操作场景`,tags:[`领域${i}`],triggerWords:[`业务${i}`],config:{embeddingModel:"selection-embed",dimensions:2,fieldDescription:`仅业务${i}的字段含义`}})
    bases.push(base)
    await knowledgeStore.ingestText({knowledgeBaseId:base.id,name:`资料${i}`,content:`共同主题 业务${i}的操作流程`})
  }
  await jobs.runAvailable()
  await knowledgeRepository.setGrant({knowledgeBaseId:bases[0].id,principalType:"user",principalId:"reader"})
  await knowledgeRepository.setGrant({knowledgeBaseId:bases[1].id,principalType:"user",principalId:"reader"})
  await knowledgeRepository.setGrant({knowledgeBaseId:bases[2].id,principalType:"user",principalId:"other"})
  const tool=new KnowledgeManageTool(), registry=new ToolRegistry()
  registry.register(tool)
  const raw=registry.get("knowledge_manage")
  const [readerView]=await registry.prepareModelTools([raw],{e:user})
  const [otherView]=await registry.prepareModelTools([raw],{e:otherUser})
  for(const definition of [modelToolDefinition(readerView).function,responsesToolDefinition(readerView)]){
    assert(definition.description.includes("业务0的用途和操作场景"))
    assert(!definition.description.includes(bases[2].id),"unauthorized catalogue must not reach either protocol")
    assert.equal(definition.parameters.properties.knowledgeBaseIds.default,undefined,"no all-library default on a command recommendation")
    assert(!definition.description.includes("仅业务0的字段含义"),"field guides are disclosed after selecting a base")
    assert.equal(definition.parameters.properties.scope.default,"authorized")
  }
  assert(otherView.common.description.includes(bases[2].id))
  assert(!otherView.common.description.includes(bases[0].id))
  assert(!raw.common.description.includes(bases[0].id),"context views must never mutate the registry")
  const configured=structuredClone(configStore.get());configured.tools.enabled=true;configured.tools.enabledTools=["knowledge_manage"]
  const discovered=await registry.searchAllowedTools("知识",{e:user,config:configured})
  assert(discovered[0].description.includes(bases[0].id),"tool discovery shares the same caller-specific directory")
  const signal=new AbortController().signal
  const context={e:user,agent:{signal}}
  const directory=JSON.parse(await tool.execute({action:"list"},context))
  assert.equal(directory.length,3)
  assert(directory.every(base=>base.fieldDescription===undefined))
  const details=JSON.parse(await tool.execute({action:"list",scope:"selected",knowledgeBaseIds:[bases[1].id]},context))
  assert.equal(details.length,1);assert.equal(details[0].fieldDescription,"仅业务1的字段含义")
  assert((await tool.execute({action:"list",knowledgeBaseIds:[bases[2].id]},context)).includes("没有访问"),"detail discovery rechecks base access")
  assert((await tool.execute({action:"search",query:" "},context)).includes("非空 query"))
  const implicit=await tool.execute({action:"search",query:"共同主题"},context)
  assert(implicit.includes("资料0")&&implicit.includes("资料1")&&!implicit.includes("资料2"))
  const exact=await tool.execute({action:"search",scope:"selected",knowledgeBaseIds:[bases[1].id],query:"共同主题"},context)
  assert(exact.includes("资料1")&&!exact.includes("资料0"))
  assert((await tool.execute({action:"search",scope:"authorized",knowledgeBaseIds:[bases[1].id],query:"共同主题"},context)).includes("资料1"))
  assert((await tool.execute({action:"search",scope:"selected",query:"共同主题"},context)).includes("必须传入"))
  assert((await tool.execute({action:"search",knowledgeBaseIds:[],query:"共同主题"},context)).includes("非空"))
  const unauthorized=await tool.execute({action:"search",knowledgeBaseIds:[bases[0].id,bases[2].id],query:"共同主题"},context)
  assert(unauthorized.includes("没有访问"));assert(!unauthorized.includes("操作流程"))
  await assert.rejects(searchKnowledgeDetailed(user,"共同主题",{knowledgeBaseIds:[bases[2].id]}),/没有访问/)

  // Keep query actions/time/negation and command prefixes, including words containing stop-word characters.
  assert.equal(normalizeSearchQuery("如何设置群禁言"),"设置群禁言")
  assert.equal(normalizeSearchQuery("如何查询群禁言"),"查询群禁言")
  for(const word of ["今天","当前","关闭","不要","我的世界"]){
    assert(knowledgeQueryTerms(`${word} 入群验证`).includes(word),`retain ${word} as retrieval evidence`)
  }
  assert.equal(normalizeSearchQuery("#当前体力"),"#当前体力")
  assert.equal(normalizeSearchQuery("*关闭验证"),"*关闭验证")
  for(const query of ["机器人怎么关闭入群验证","如何查体力","#体力怎么用","这个指令有什么参数"]){
    assert(isBotCommandQuery(query),query)
    assert.equal(selectPromptTools([readerView,{name:"web_search",description:"机器人指令查询"}],query,{maxTools:1,maxDefinitionTokens:1200})[0]?.name,"knowledge_manage")
  }
  for(const query of ["如何做饭","怎么学习英语","查一下今天的新闻"])assert(!isBotCommandQuery(query),query)
  for(let i=0;i<15;i++)await knowledgeStore.create({name:`扩展资料${i}`,description:"完整用途".repeat(125),config:{fieldDescription:"字段细节".repeat(300)}})
  const [largeView]=await registry.prepareModelTools([raw],{e:master})
  const largeDefinition=modelToolDefinition(largeView).function
  assert(largeDefinition.description.includes("其余库请用 list"))
  assert(largeDefinition.description.includes("builtin-commands"))
  assert(!largeDefinition.description.includes("字段细节"))
  assert(estimateTokens(largeDefinition)<1200,"large catalogues must fit the default definition budget")
  assert.equal(selectPromptTools([largeView],"机器人有哪些指令",{maxDefinitionTokens:1200})[0]?.name,"knowledge_manage")
  assert.equal(JSON.parse(await tool.execute({action:"list"},{e:master})).length,22,"the short directory never hides bases from discovery")

  // Real SQLite and vector indexes; a barrier proves bounded overlap rather than elapsed time.
  const originalAll=sqliteClient.all.bind(sqliteClient), originalSearch=vectorIndex.search.bind(vectorIndex)
  let lexicalStarted=0, vectorStarted=0, active=0, peak=0, released=false, release
  const barrier=new Promise(resolve=>{release=resolve})
  const timer=setTimeout(()=>release(),3000)
  const releaseIfReady=()=>{if(lexicalStarted>=4&&vectorStarted>=4){released=true;release()}}
  sqliteClient.all=async(sql,params,...rest)=>{
    if(sql.includes("-bm25(knowledge_fts) AS score")){
      lexicalStarted++;releaseIfReady();await barrier
    }
    return originalAll(sql,params,...rest)
  }
  vectorIndex.search=async(...args)=>{
    active++;peak=Math.max(peak,active);vectorStarted++;releaseIfReady();await barrier
    try{return await originalSearch(...args)}finally{active--}
  }
  const beforeQuery=embedCalls
  let concurrent
  try{concurrent=await searchKnowledgeDetailed(master,"共同主题 并发验证",{knowledgeBaseIds:bases.map(b=>b.id)})}
  finally{clearTimeout(timer);release();sqliteClient.all=originalAll;vectorIndex.search=originalSearch}
  assert(released,"four libraries must start both recall routes before the barrier releases: "+JSON.stringify({lexicalStarted,vectorStarted,retrieval:concurrent.retrieval}))
  assert.equal(peak,4,"library fanout must be bounded")
  assert.equal(embedCalls,beforeQuery+1,"concurrent libraries sharing an embedding identity generate one query vector")
  assert.equal(new Set(concurrent.results.map(r=>r.knowledgeBaseId)).size,6)

  await commandImports.apply({schemaVersion:1,sourceId:"selection",documents:[{id:"selection-command",title:"#共同主题",retrievalText:"共同主题 指令操作说明",metadata:{event:"message",regexp:"^#共同主题$",suggestedCommand:"#共同主题"}}]})
  const originalRank=adapterRegistry.rerank.bind(adapterRegistry)
  let rankCalls=0,failRank=false,rankIds=[]
  adapterRegistry.rerank=async request=>{
    rankCalls++;rankIds=request.documents
    if(failRank)throw Error("fixture unavailable")
    return {model:request.channel.model,results:request.documents.map((_,index)=>({index,score:(index+1)/request.documents.length})),usage:{promptTokens:1,completionTokens:0,totalTokens:1}}
  }
  try{
    await configStore.update(c=>{c.knowledge.retrieval.rerankEnabled=true})
    const ranked=await searchKnowledgeDetailed(user,"共同主题",{knowledgeBaseIds:[bases[0].id,bases[1].id],includeTrace:true})
    assert.equal(rankCalls,1,"one global rerank call for multiple libraries")
    assert(rankIds.some(s=>s.includes("业务0"))&&rankIds.some(s=>s.includes("业务1")))
    assert.equal(ranked.retrieval.rerank,"applied")
    assert.equal(ranked.results[0].rerankScore,1,"global order must survive final merging")
    assert.equal(ranked.trace.candidates.length,2);assert(ranked.trace.rerankSucceeded)
    assert.equal(ranked.trace.rerank.scores.length,2);assert.equal(ranked.trace.directResultIds.length,2)
    assert(ranked.trace.candidates.every(row=>row.keywordRank===1&&row.vectorRank===1&&row.lexicalRelevance===1&&row.vectorSimilarity===1),"trace retains both recall routes and their metrics")
    assert.deepEqual(ranked.trace.finalResultIds,ranked.results.map(row=>row.id))
    assert.equal((await searchKnowledgeDetailed(user,"共同主题",{knowledgeBaseIds:[bases[0].id,bases[1].id]})).trace,undefined,"ordinary searches do not expose candidate traces")
    const mixed=await searchKnowledgeDetailed(user,"共同主题",{knowledgeBaseIds:["builtin-commands",bases[0].id]})
    assert.equal(rankCalls,2,"a mixed command/document search must also use one global rerank")
    assert(rankIds.some(s=>s.includes("指令操作"))&&rankIds.some(s=>s.includes("业务0")))
    assert.equal(mixed.results[0].rerankScore,1,"cross-library merging cannot overwrite rerank order")
    await configStore.update(c=>{c.knowledge.retrieval.rerankResultLimit=1})
    const capped=await searchKnowledgeDetailed(user,"共同主题",{knowledgeBaseIds:[bases[0].id,bases[1].id],includeTrace:true})
    assert.equal(capped.retrieval.rerank,"cached");assert.equal(capped.results.length,1);assert.equal(capped.results[0].rerankScore,1)
    assert.equal(rankCalls,2,"changing the return limit must reuse cached scores")
    assert.equal(capped.trace.candidates.filter(row=>row.processingResult==="return_limit").length,1)
    assert.equal(capped.trace.candidates.length,2,"the overview is not truncated by the final return limit")
    await configStore.update(c=>{c.knowledge.retrieval.rerankMinScore=0.75})
    const thresholded=await searchKnowledgeDetailed(user,"共同主题",{knowledgeBaseIds:[bases[0].id,bases[1].id],includeTrace:true})
    const low=thresholded.trace.candidates.find(row=>row.processingResult==="below_threshold")
    assert.equal(low.rerankScore,0.5);assert.equal(low.rerankRank,2,"a rejected candidate retains its actual score and model ranking")
    assert.equal(thresholded.trace.directResultIds.length,2,"direct recall is unaffected by the rerank score cutoff")
    await configStore.update(c=>{c.knowledge.retrieval.rerankMinScore=0.3;c.knowledge.retrieval.rerankMaxCandidates=1})
    const pool=await searchKnowledgeDetailed({...user,sessionId:"trace-pool"},"共同主题",{knowledgeBaseIds:[bases[0].id,bases[1].id],includeTrace:true})
    assert.equal(pool.trace.rerank.inputIds.length,1)
    assert.equal(pool.trace.candidates.filter(row=>row.processingResult==="candidate_limit"&&row.rerankScore===undefined).length,1)
    await configStore.update(c=>{c.knowledge.retrieval.rerankMaxCandidates=20;c.knowledge.retrieval.rerankInputTokenBudget=200})
    const inputBudget=await searchKnowledgeDetailed(user,"共同主题"+"预算".repeat(800),{knowledgeBaseIds:[bases[0].id,bases[1].id],includeTrace:true})
    assert.equal(inputBudget.retrieval.rerank,"input_budget");assert(!inputBudget.trace.rerankSucceeded)
    assert.equal(inputBudget.trace.rerank.inputIds.length,0);assert.equal(inputBudget.results.length,2)
    await configStore.update(c=>{c.knowledge.retrieval.rerankInputTokenBudget=6000})
    await configStore.update(c=>{c.knowledge.retrieval.rerankResultLimit=5;c.knowledge.retrieval.resultLimit=1})
    assert.equal((await searchKnowledgeDetailed(user,"共同主题",{knowledgeBaseIds:[bases[0].id,bases[1].id]})).results.length,1,"global limit still applies after reranking")
    await configStore.update(c=>{c.knowledge.retrieval.resultLimit=20})
    assert.equal((await searchKnowledgeDetailed(user,"共同主题",{knowledgeBaseIds:[bases[0].id,bases[1].id],limit:1})).results.length,1,"callers can request fewer ranked results")
    await configStore.update(c=>{c.knowledge.retrieval.rerankResultLimit=1})
    assert.equal((await searchKnowledgeDetailed(user,"共同主题",{knowledgeBaseIds:[bases[0].id,bases[1].id],rerank:false})).results.length,2,"bypassing rerank uses the global cap")
    failRank=true
    const fallback=await searchKnowledgeDetailed(user,"共同主题 降级验证",{knowledgeBaseIds:[bases[0].id,bases[1].id],includeTrace:true})
    assert.equal(fallback.retrieval.rerank,"failed_fallback");assert.equal(fallback.results.length,2)
    assert(!fallback.trace.rerankSucceeded);assert(fallback.trace.candidates.every(row=>row.rerankScore===undefined&&row.rerankRank===undefined))
    await configStore.update(c=>{c.knowledge.retrieval.rerankEnabled=false})
    const calls=rankCalls
    const disabled=await searchKnowledgeDetailed(user,"共同主题 关闭验证",{knowledgeBaseIds:[bases[0].id,bases[1].id],includeTrace:true})
    assert.equal(rankCalls,calls);assert.equal(disabled.retrieval.rerank,"disabled");assert.equal(disabled.results.length,2)
    assert.deepEqual(disabled.trace.finalResultIds,disabled.trace.directResultIds);assert(!disabled.trace.rerankSucceeded)
    const abort=new AbortController();abort.abort()
    await assert.rejects(searchKnowledgeDetailed(user,"共同主题",{knowledgeBaseIds:[bases[0].id],signal:abort.signal}),/abort/i)
    assert.equal(rankCalls,calls,"cancelled retrieval must not enter rerank")
  }finally{adapterRegistry.rerank=originalRank}

  // Passive events remain searchable explanations, while recommendations exclude them.
  await commandImports.apply({schemaVersion:1,sourceId:"selection",documents:[{id:"selection-poke",title:"戳一戳响应",retrievalText:"戳一戳 功能说明",metadata:{event:"notice.group.poke",regexp:"(?:)",suggestedCommand:""}}]})
  const eventSearch=await searchKnowledgeDetailed(master,"戳一戳",{knowledgeBaseIds:["builtin-commands"],useVector:false})
  assert(eventSearch.results.some(r=>r.commandId==="selection-poke"))
  const commands=await searchKnowledgeDetailed(master,"戳一戳",{knowledgeBaseIds:["builtin-commands"],useVector:false,sendableCommandsOnly:true})
  assert(!commands.results.some(r=>r.commandId==="selection-poke"))

  // LIKE supplementation must retain the stronger FTS/BM25 score.
  const bm=await knowledgeStore.create({name:"BM25"})
  await knowledgeStore.ingestText({knowledgeBaseId:bm.id,name:"Z strong",content:"stoken stoken stoken stoken stoken"})
  await knowledgeStore.ingestText({knowledgeBaseId:bm.id,name:"A weak",content:"stoken filler filler filler filler"})
  assert.equal((await searchKnowledgeDetailed(master,"stoken",{knowledgeBaseIds:[bm.id],useVector:false})).results[0].title,"Z strong")
  console.log("ok knowledge selection: caller-specific catalogues, protocol definitions, precise/default scopes, permissions, bounded parallel recall, shared embeddings, one global optional rerank, failure/cancellation, passive events and BM25")
}finally{
  await jobs?.waitForIdle?.()
  await sqliteClient?.close?.()
  await fs.rm(root,{recursive:true,force:true})
}
