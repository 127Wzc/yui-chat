import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import ts from "typescript"
import express from "express"
import { once } from "node:events"
import { pathToFileURL } from "node:url"
import * as vue from "vue"
import { renderToString } from "vue/server-renderer"
const root = await fs.mkdtemp(path.join(os.tmpdir(), "yui-command-import-")), host = path.join(root, "host")
process.env.YUI_CHAT_RUNTIME_ROOT = root
process.env.YUI_CHAT_PLUGIN_ROOT = path.join(host, "plugins/yui-chat")
for (const directory of ["plugins/yui-chat", "plugins/fixture/apps", "lib/plugins"]) await fs.mkdir(path.join(host, directory), { recursive: true })
await fs.writeFile(path.join(host, "package.json"), '{"type":"module"}')
await fs.writeFile(path.join(host, "lib/plugins/loader.js"), 'export default { priority: [], deal: async()=>false }')
global.logger = { mark(){}, info(){}, warn(){}, error(){}, debug(){}, blue:v=>v, cyan:v=>v, red:v=>v }
global.Bot = { express:null, wsf:{}, uin:[] };global.segment={at:String,image:String,record:String,reply:String};global.plugin=class {}
let sqliteClient, jobs, server
try {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  const { knowledgeStore } = await import("../output/runtime/knowledge/store.js")
  const { knowledgeRepository } = await import("../output/runtime/knowledge/repository.js")
  const { commandImports, commandChunks } = await import("../output/runtime/knowledge/command-import.js")
  const { scanCommandMetadata, scanLoadedCommands } = await import("../output/runtime/knowledge/command-scanner.js")
  const { commandObserver } = await import("../output/runtime/knowledge/command-observer.js")
  const { searchKnowledgeDetailed, buildKnowledgePrompt } = await import("../output/runtime/knowledge/retrieval.js")
  const { estimateTokens, truncateTextToTokens } = await import("../output/runtime/core/chat/token-budget.js")
  const { vectorIndex } = await import("../output/runtime/knowledge/vector-index.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  ;({ knowledgeIndexJobs: jobs } = await import("../output/runtime/knowledge/index-jobs.js"))
  await configStore.load(); await sqliteClient.init(defaults);await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  const embeddings=[];let embeddingCalls=0;let failEmbedding=false, releaseEmbedding, signalEmbedding
  adapterRegistry.register({id:"import-fixture",supportsEmbeddings:true,supportsTools:false,async embedTexts({texts,dimensions}){embeddingCalls++;embeddings.push(...texts);if(signalEmbedding){signalEmbedding();await new Promise(resolve=>{releaseEmbedding=resolve})}if(failEmbedding)throw Error("fixture embedding failed");return {vectors:texts.map(text=>text.includes("签到")?[0,1]:[1,0]),dimensions,usage:{input:texts.length,output:0,total:texts.length}}}})
  await configStore.update(c=>{c.apiProviders.push({name:"fixture",type:"import-fixture"});c.models.push({name:"embedding",adapter:"import-fixture",apiProvider:"fixture",modelIdentifier:"embedding",purpose:"embedding",capabilities:{chat:false,embedding:true},embedding:{defaultDimensions:2,allowedDimensions:[2],batchSize:32,timeoutMs:10000}});c.knowledge.commandRetrieval.mode="lexical"})
  await knowledgeStore.init();await commandObserver.init();jobs.scheduleAvailable=()=>{}
  const base="builtin-commands"
  await knowledgeStore.updateBuiltinRetrieval({embeddingModel:"embedding",dimensions:2})
  await jobs.runAvailable()
  const document={id:"cmd-stamina",title:"#体力",retrievalText:"查看原神体力和剩余树脂",metadata:{pluginKey:"fixture",pluginName:"游戏",fnc:"stamina",regexp:"^#体力$",suggestedCommand:"#体力",description:"游戏功能"}}
  const bundle=(documents=[document],sourceId="yunzai")=>({schemaVersion:1,sourceId,documents})
  const apply=(input,options={})=>commandImports.apply(input,options)
  assert.deepEqual(await commandImports.list(),[],"the imported catalogue starts empty")
  assert.equal(commandChunks(document.retrievalText).length,1)
  assert(commandChunks("长".repeat(10000)).length>1)
  await assert.rejects(apply(bundle([document,document])),/重复 ID/)
  await assert.rejects(apply({...bundle(),deletedIds:["x"]}),/不能删除/)
  await assert.rejects(apply(bundle(),{deleteMissing:true}),/不执行同步删除/)
  const first=await apply(bundle());assert.equal(first.summary.inserted,1)
  await jobs.runAvailable();assert.equal(embeddings.length,1)
  assert.deepEqual(embeddings,[document.retrievalText],"only retrievalText, without title or metadata decoration, reaches embedding")
  const row=(await sqliteClient.all("SELECT * FROM knowledge_documents WHERE source_key=?",["command:cmd-stamina"]))[0]
  const chunksBefore=await sqliteClient.all("SELECT id FROM knowledge_chunks WHERE document_id=?",[row.id])
  assert.deepEqual((await sqliteClient.all("SELECT content FROM knowledge_chunks WHERE document_id=?",[row.id])).map(chunk=>chunk.content),[document.retrievalText],"chunk content is exactly the retrieval text")
  const spaceId=(await knowledgeRepository.getBase(base)).active_vector_space_id
  const runsBefore=(await commandImports.logs()).total
  assert.equal((await apply(bundle())).summary.unchanged,1)
  await jobs.runAvailable();assert.equal(embeddings.length,1);assert.equal((await commandImports.history(document.id)).length,0)
  assert.deepEqual(await sqliteClient.all("SELECT id FROM knowledge_chunks WHERE document_id=?",[row.id]),chunksBefore)
  assert.equal((await commandImports.logs()).total,runsBefore+1,"even a no-op import has a summary log")
  const noOpHistory=(await commandImports.history(document.id)).length
  assert.equal((await apply(bundle([{...document,sourceHash:"ignored-extra-field"}]),{policy:"overwrite"})).summary.unchanged,1,"an unsupported external source hash must not create changes")
  assert.equal((await commandImports.history(document.id)).length,noOpHistory)
  assert(!(Object.hasOwn((await commandImports.export("yunzai")).documents[0],"sourceHash")),"export must omit the retired source hash")
  const changed={...document,retrievalText:"查看原神体力和剩余树脂 v2"}
  const transaction=sqliteClient.transaction.bind(sqliteClient),runsBeforeFailure=(await commandImports.logs()).total
  sqliteClient.transaction=operations=>transaction([...operations,{sql:"INSERT INTO missing_transaction_test_table VALUES(1)"}])
  try{await assert.rejects(apply(bundle([changed]),{policy:"overwrite"}),/missing_transaction_test_table/)}finally{sqliteClient.transaction=transaction}
  assert.equal((await commandImports.list())[0].retrievalText,document.retrievalText,"a failed transaction must retain current content")
  assert.equal((await commandImports.logs()).total,runsBeforeFailure);assert.equal((await commandImports.history(document.id)).length,0)
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS n FROM knowledge_vector_tasks")).n,0,"a failed import must not enqueue vector work")
  assert.equal((await apply(bundle([changed]))).summary.skipped,1,"default must skip existing IDs")
  assert.equal((await commandImports.history(document.id)).length,0)
  assert.equal((await apply(bundle([changed]),{policy:"overwrite"})).summary.updated,1)
  await jobs.runAvailable();assert.equal(embeddings.length,2)
  assert.equal((await knowledgeRepository.getBase(base)).active_vector_space_id,spaceId,"normal changes keep the existing vector space")
  assert.equal((await jobs.inspect(base)).state,"ready")
  const metadataOnly={...changed,metadata:{...changed.metadata,permission:"master"}}
  await apply(bundle([metadataOnly]),{policy:"overwrite"});await jobs.runAvailable();assert.equal(embeddings.length,2,"metadata edits reuse vectors")
  for(let i=3;i<=6;i++)await apply(bundle([{...metadataOnly,retrievalText:`体力树脂 version ${i}`}]),{policy:"overwrite"})
  let history=await commandImports.history(document.id)
  assert.equal(history.length,2,"current plus two prior versions")
  const oldVersion=history.at(-1),versionBefore=(await commandImports.preview(bundle([]))).revision
  await commandImports.restore(document.id,oldVersion.id,versionBefore)
  assert.equal((await commandImports.list())[0].retrievalText,oldVersion.snapshot.document.retrievalText)
  assert.equal((await commandImports.history(document.id)).length,2)
  await assert.rejects(apply(bundle([changed]),{policy:"overwrite",expectedRevision:versionBefore}),/重新预览/)
  await assert.rejects(apply(bundle([document],"other"),{policy:"overwrite"}),/其他来源/)
  const sign={...document,id:"cmd-sign",title:"#签到",retrievalText:"每天签到领取奖励",metadata:{...document.metadata,fnc:"sign",suggestedCommand:"#签到",regexp:"^#签到$"}}
  await configStore.update(config=>{config.knowledge.indexing.maxChunksPerKnowledgeBase=1})
  await assert.rejects(apply(bundle([sign])),/超过.*上限/)
  await configStore.update(config=>{config.knowledge.indexing.maxChunksPerKnowledgeBase=100000})
  await apply(bundle([sign]));assert.equal((await commandImports.list()).length,2,"partial imports never delete missing IDs")
  const callsBeforeBatch=embeddingCalls
  await jobs.runAvailable();assert.equal(embeddingCalls,callsBeforeBatch+1,"changed documents must share embedding batches");await commandObserver.load()
  const exported=await commandImports.export("yunzai"),exportedHistory=(await commandImports.history(document.id)).length
  assert.equal((await apply(exported,{policy:"overwrite"})).summary.unchanged,2,"export/import roundtrip must be idempotent")
  assert.equal((await commandImports.history(document.id)).length,exportedHistory)
  const recommended=await searchKnowledgeDetailed({isMaster:true},"剩余树脂",{knowledgeBaseIds:[base]})
  assert(recommended.results.some(item=>item.commandId===document.id),"retrieval must use imported retrievalText")
  assert.equal(new Set(recommended.results.map(item=>item.commandId)).size,recommended.results.length,"one authoritative command catalogue")
  assert(recommended.results[0].fieldDescription.includes("regexpFlags"))
  const beforeDescription=embeddings.length,historyBeforeDescription=(await commandImports.history(document.id)).length
  const jobsBeforeDescription=await sqliteClient.all("SELECT id FROM knowledge_index_jobs")
  const guide="priority：越小越先尝试；regexp 是匹配规则，regexpFlags 是正则选项。"
  const indexRevisionBeforeDescription=(await knowledgeRepository.getBase(base)).updated_at
  await knowledgeStore.updateBuiltinRetrieval({fieldDescription:guide})
  await jobs.runAvailable()
  assert.equal(embeddings.length,beforeDescription,"field descriptions must not rebuild vectors")
  assert.deepEqual(await sqliteClient.all("SELECT id FROM knowledge_index_jobs"),jobsBeforeDescription)
  assert.equal((await commandImports.history(document.id)).length,historyBeforeDescription)
  assert.equal((await knowledgeRepository.getBase(base)).config.fieldDescription,guide)
  assert.equal((await knowledgeRepository.getBase(base)).updated_at,indexRevisionBeforeDescription,"a field-only update must not supersede an in-flight index build")
  const withGuide=await searchKnowledgeDetailed({isMaster:true},"剩余树脂",{knowledgeBaseIds:[base]})
  assert.equal(withGuide.results[0].fieldDescription,guide)
  const otherBase=await knowledgeStore.create({name:"其他资料",config:{fieldDescription:"等级为业务服务等级"}})
  await knowledgeStore.ingestText({knowledgeBaseId:otherBase.id,name:"体力",content:"剩余树脂体力等级"})
  const otherResults=await searchKnowledgeDetailed({isMaster:true},"剩余树脂",{knowledgeBaseIds:[otherBase.id]})
  assert.equal(otherResults.results[0].fieldDescription,"等级为业务服务等级")
  const ordinaryIndexRevision=(await knowledgeRepository.getBase(otherBase.id)).updated_at
  await knowledgeStore.update(otherBase.id,{config:{fieldDescription:"新的等级说明"}})
  assert.equal((await knowledgeRepository.getBase(otherBase.id)).updated_at,ordinaryIndexRevision)
  const promptRows=[...withGuide.results,...withGuide.results,...otherResults.results]
  const prompt=buildKnowledgePrompt(promptRows,5000)
  assert.equal(prompt.split(guide).length-1,1,"one field guide per base, even with multiple hits")
  assert.equal(prompt.split("等级为业务服务等级").length-1,1)
  for(const limit of [80,200,800]) assert(estimateTokens(buildKnowledgePrompt(promptRows,limit))<=limit,"answer context includes guides and headers in the budget")
  const longPrompt=buildKnowledgePrompt([{...withGuide.results[0],content:"长篇说明".repeat(10000)}],800)
  assert(longPrompt.includes("长篇说明"));assert(estimateTokens(longPrompt)<=800,"a long chunk must be truncated instead of silently omitted")
  const emptyGuideBase=await knowledgeStore.create({name:"普通资料"})
  assert.equal(emptyGuideBase.config.fieldDescription,"")
  await knowledgeRepository.deleteBase(otherBase.id);await knowledgeRepository.deleteBase(emptyGuideBase.id)
  await assert.rejects(knowledgeStore.updateBuiltinRetrieval({fieldDescription:"长".repeat(2001)}),/2000/)
  await assert.rejects(knowledgeStore.updateBuiltinRetrieval({fieldDescription:42}),/文本/)
  const {CommandSearchTool,CommandRecommendTool,KnowledgeManageTool}=await import("../output/runtime/tools/builtins/command.js")
  const toolContext={e:{isMaster:true}},toolArgs={query:"剩余树脂",limit:3}
  assert((await new CommandSearchTool().execute(toolArgs,toolContext)).includes(guide))
  const toolRecommendation=JSON.parse(await new CommandRecommendTool().execute(toolArgs,toolContext))
  assert.equal(toolRecommendation.knowledgeBase.fieldDescription,guide)
  assert(toolRecommendation.recommendations.some(row=>row.retrievalText.includes("树脂")))
  assert((await new KnowledgeManageTool().execute({...toolArgs,action:"search",knowledgeBaseIds:[base]},toolContext)).includes(guide))
  // Exercise real rerank packing and cache logic with an isolated model/budget fixture.
  const rerankExports={},rerankPrompts=[],rerankBudget={day:"",calls:0,scopes:{}}
  const rerankRoot={models:[{name:"rank"}],modelTasks:{},apiProviders:[]}
  vm.runInNewContext(ts.transpileModule(await fs.readFile(new URL("../knowledge/retrieval-rerank.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports:rerankExports,require:spec=>{
      if(spec==="node:path")return {default:path}
      if(spec==="node:crypto")return {default:crypto}
      if(spec.includes("atomic-json-repository"))return {AtomicJsonRepository:class{async update(fn){fn(rerankBudget)}}}
      if(spec.includes("config/store"))return {configStore:{get:()=>rerankRoot},dataDir:root}
      if(spec.includes("token-budget"))return {estimateTokens,truncateTextToTokens}
      if(spec.includes("host-runtime"))return {hostRuntime:{}}
      if(spec.includes("isolated-task"))return {runIsolatedModelTask:async request=>{rerankPrompts.push(request);const input=JSON.parse(request.prompt);return {text:JSON.stringify(input.candidates.map(row=>({id:row.id,relevance:0.9})))}}}
      throw Error("unexpected rerank dependency: "+spec)
    },
  })
  const rankConfig={rerankEnabled:true,rerankModel:"rank",rerankInputTokenBudget:1000,rerankCacheTtlMs:60000,rerankCallsPerConversation:20}
  const rankCandidates=[{id:"a",title:"指令一",content:"指令一的用途",score:1,knowledgeBaseId:base,fieldDescription:guide,metadata:{implementation:"must not reach model"}},{id:"b",title:"指令二",content:"指令二的用途",score:1,knowledgeBaseId:base,fieldDescription:guide},{id:"c",title:"其他文档",content:"其他资料",score:1,knowledgeBaseId:"other",fieldDescription:"独立说明"}]
  assert.equal((await rerankExports.rerankKnowledge({},"用途",rankCandidates,rankConfig)).state,"applied")
  const rankedInput=JSON.parse(rerankPrompts[0].prompt)
  assert.deepEqual(rankedInput.fieldDescriptions,{[base]:guide,other:"独立说明"})
  assert.equal(rerankPrompts[0].prompt.split(guide).length-1,1)
  assert(!rerankPrompts[0].prompt.includes("must not reach model"),"reranker receives retrieval text without implementation/metadata")
  assert(rankedInput.candidates.every(row=>Object.keys(row).sort().join(",")==="content,id,knowledgeBaseId,title"))
  assert.equal((await rerankExports.rerankKnowledge({},"用途",rankCandidates,rankConfig)).state,"cached")
  assert.equal(rerankPrompts.length,1)
  await rerankExports.rerankKnowledge({},"用途",rankCandidates.map(row=>({...row,fieldDescription:"修改后的说明"})),rankConfig)
  assert.equal(rerankPrompts.length,2,"guide changes invalidate rerank cache without vector rebuilding")
  assert.equal((await rerankExports.rerankKnowledge({},"短问题",rankCandidates.map(row=>({...row,content:'"\\'.repeat(6000),fieldDescription:"长说明".repeat(600)})),{...rankConfig,rerankInputTokenBudget:400})).state,"applied")
  assert.equal(rerankPrompts.length,3)
  assert(estimateTokens(rerankPrompts[2].prompt)<=400,"serialized rerank input stays within budget including escaping")
  assert.equal((await rerankExports.rerankKnowledge({},"长".repeat(5000),rankCandidates,rankConfig)).state,"input_budget")
  await knowledgeRepository.setGrant({knowledgeBaseId:base,principalType:"user",principalId:"no-grants",access:"deny"})
  assert.deepEqual(await knowledgeStore.list({user_id:"no-grants"}),[],"an empty authorization list must not expose metadata")
  const untouchedCount=embeddings.length
  assert.equal((await commandImports.preview(bundle([document]))).summary.skipped,1)
  assert.equal(embeddings.length,untouchedCount,"preview never calls models")
  const log=await commandImports.logs();assert(log.runs.some(run=>run.summary.updated));assert((await commandImports.log(first.runId)).some(change=>change.operation==="insert"))
  // An embedding response arriving after a newer import cannot overwrite the latest chunks.
  await apply(bundle([{...changed,retrievalText:"体力 old in flight"}]),{policy:"overwrite"})
  const started=new Promise(resolve=>{signalEmbedding=resolve});const processing=jobs.runPendingDocuments();await started
  await apply(bundle([{...changed,retrievalText:"体力 newest"}]),{policy:"overwrite"});signalEmbedding=null;releaseEmbedding();await processing
  await jobs.runAvailable();assert.equal((await jobs.inspect(base)).state,"ready")
  failEmbedding=true;await apply(bundle([{...changed,retrievalText:"体力 failed embedding"}]),{policy:"overwrite"});await jobs.runAvailable()
  assert((await sqliteClient.get("SELECT error FROM knowledge_vector_tasks WHERE kind='document'"))?.error)
  failEmbedding=false;await sqliteClient.run("UPDATE knowledge_vector_tasks SET retry_at=0");await jobs.runAvailable();assert.equal((await jobs.inspect(base)).state,"ready")
  // A shrinking document removes old chunks and physical vectors; retained blocks are reused.
  const long={...document,id:"cmd-long",retrievalText:"体力长说明。".repeat(1800)};await apply(bundle([long]));await jobs.runAvailable()
  const longRow=(await commandImports.list()).find(row=>row.id===long.id),oldChunks=await sqliteClient.all("SELECT id FROM knowledge_chunks WHERE document_id=?",[longRow.documentId]);assert(oldChunks.length>1)
  await apply(bundle([{...long,retrievalText:"体力短说明"}]),{policy:"overwrite"});await jobs.runAvailable()
  const remaining=await sqliteClient.all("SELECT id FROM knowledge_chunks WHERE document_id=?",[longRow.documentId]);assert.equal(remaining.length,1)
  assert(!(await sqliteClient.all("SELECT owner_id FROM embedding_records",[],"vectors")).some(record=>oldChunks.some(chunk=>chunk.id===record.owner_id)))
  const beforeDelete=(await commandImports.preview(bundle([]))).revision
  const deleted=await apply({...bundle([]),deletedIds:[document.id]},{operation:"delete",expectedRevision:beforeDelete});assert.equal(deleted.summary.deleted,1)
  assert(!(await commandImports.list()).some(row=>row.id===document.id));assert.equal((await commandImports.history(document.id)).length,3,"a deleted item retains three recoverable versions")
  await assert.rejects(apply(bundle([document],"other")),/其他来源/,"a retained ID cannot be reused by another source")
  const deletedVersion=(await commandImports.history(document.id))[0];await commandImports.restore(document.id,deletedVersion.id,(await commandImports.preview(bundle([]))).revision)
  assert.equal((await commandImports.history(document.id)).length,2)
  assert.equal((await commandImports.list()).filter(row=>row.id===document.id).length,1)
  // Static scanner is safe, stable across rescans, and distinguishes identical patterns with different flags/classes.
  const source=path.join(host,"plugins/fixture/apps/commands.ts")
  await fs.writeFile(source,`throw Error('must never execute'); export class A { constructor(){super({name:'fixture',dsc:'游戏',rule:[{reg:/^#体力$/,fnc:'stamina'},{reg:/^#体力$/i,fnc:'stamina'}]})} stamina(){return 'tree'} } export class B { constructor(){super({name:'fixture',rule:[{reg:/^#体力$/,fnc:'stamina'}]})} stamina(){return 'other'} }`)
  const scan1=await scanCommandMetadata(host),scan2=await scanCommandMetadata(host)
  assert.equal(scan1.documents.length,3);assert.equal(new Set(scan1.documents.map(row=>row.id)).size,3);assert.deepEqual(scan1.documents.map(row=>row.id),scan2.documents.map(row=>row.id));assert.equal(scan1.complete,false)
  await fs.writeFile(path.join(host,"plugins/fixture/apps/unique.ts"),`export class C { constructor(){super({rule:[{reg:/^#old$/,fnc:'unique'}]})} unique(){return 1} }`)
  const unique1=(await scanCommandMetadata(host)).documents.find(row=>row.metadata.fnc==="unique")
  await fs.writeFile(path.join(host,"plugins/fixture/apps/unique.ts"),`export class C { constructor(){super({rule:[{reg:/^#new$/,fnc:'unique'}]})} unique(){return 2} }`)
  assert.notEqual((await scanCommandMetadata(host)).documents.find(row=>row.metadata.fnc==="unique").id,unique1.id,"changing the trigger creates a new deterministic identity")
  await fs.mkdir(path.join(host,"plugins/yui-chat/apps"),{recursive:true})
  await fs.writeFile(path.join(host,"plugins/yui-chat/apps/master.ts"),`import {pluginCommandRule} from '../core/message/command-prefixes.js'; export class Master {constructor(){super({rule:[masterCommand('诊断','diagnostics'),{reg:pluginCommandRule('帮助'),fnc:'help'}]})} diagnostics(){} help(){} }`)
  const own=(await scanCommandMetadata(host)).documents.filter(row=>row.metadata.pluginKey==="yui-chat")
  assert.equal(own.length,2);assert.equal(own.find(row=>row.metadata.fnc==="diagnostics").metadata.permission,"master");assert.equal(own.find(row=>row.metadata.fnc==="help").metadata.regexp,"^#yui帮助$")
  await fs.writeFile(path.join(host,"plugins/fixture/apps/outer-only.ts"),`export class OuterOnly {constructor(){super({name:'外层规则',rule:[{reg:/^#step$/,fnc:'secondaryReply'}]})}}`)
  const staticOuterOnly=await scanCommandMetadata(host)
  const outerRule=staticOuterOnly.documents.find(row=>row.metadata.className==="OuterOnly")
  assert(outerRule);assert.equal(outerRule.metadata.fnc,"secondaryReply")
  assert(!Object.hasOwn(outerRule.metadata,"implementation"))
  assert.equal(staticOuterOnly.warnings.length,1,"static scan retains only its offline-coverage notice for missing handlers")
  // Runtime collection reads declared rules, never handler bodies, accessors or follow-up callbacks.
  class LiveBase { dynamic(){throw Error("handler must never execute")} }
  class LivePlugin extends LiveBase { constructor(){super();this.name="已加载插件";this.dsc="运行时生成规则";this.rule=[{reg:new RegExp("^#runtime$","i"),fnc:"dynamic",permission:"master"},{reg:/^#runtime$/,fnc:"dynamic"},{reg:/^#accessor$/,fnc:"accessor"}];Object.defineProperty(this,"accessor",{get(){throw Error("getter must never execute")}})} }
  const loadedEntry={plugin:new LivePlugin(),class:LivePlugin,key:"runtime-fixture",priority:1}
  const runtime1=await scanLoadedCommands([loadedEntry]),runtime2=await scanLoadedCommands([loadedEntry])
  assert.equal(runtime1.documents.length,3);assert.equal(new Set(runtime1.documents.map(row=>row.id)).size,3)
  assert.deepEqual(runtime1.documents.map(row=>row.id),runtime2.documents.map(row=>row.id))
  assert.deepEqual(runtime1.documents,runtime2.documents)
  assert(runtime1.documents.every(row=>Object.keys(row).sort().join(",")==="id,metadata,retrievalText,title"),"collected documents contain only ID, title, retrieval text and metadata")
  const expectedId="cmd-"+crypto.createHash("sha256").update(JSON.stringify(["yunzai-command-v1","runtime-fixture","LivePlugin","dynamic","^#runtime$","i"])).digest("hex")
  assert.equal(runtime1.documents[0].id,expectedId,"identity is reproducible from registration fields alone")
  await assert.rejects(fs.access(path.join(root,"data/yui-chat/command-kb/scan-identities.json")),{code:"ENOENT"},"collection must not create an identity manifest")
  assert.equal(runtime1.documents[0].metadata.permission,"master");assert.equal(runtime1.documents[0].metadata.regexpFlags,"i")
  for(const scan of [scan1,runtime1]) for(const row of scan.documents){
    assert(!Object.hasOwn(row.metadata,"implementation"),"collection must not include handler source code")
    assert(row.retrievalText.includes(`插件名称：${row.metadata.pluginName}`))
    assert(row.retrievalText.includes(`插件标识：${row.metadata.pluginKey}`))
    assert(row.retrievalText.includes(`priority：${row.metadata.priority??"未知"}`))
    assert(row.retrievalText.includes(`regexp：${row.metadata.regexp}`))
    assert(row.retrievalText.includes(`regexpFlags：${JSON.stringify(row.metadata.regexpFlags||"")}`))
    assert(!row.retrievalText.includes("数值越小"),"field semantics belong to the base guide")
  }
  assert.deepEqual(runtime1.warnings,[],"unreadable handlers do not warn or mark collection incomplete")
  assert.equal(runtime1.complete,true)
  const outerOnlyPlugin=new Proxy({name:"外层规则",rule:[{reg:/^#step$/,fnc:"secondaryReply"}]},{
    get(target,key,receiver){if(key==="secondaryReply")throw Error("must not read handler");return Reflect.get(target,key,receiver)},
    getOwnPropertyDescriptor(target,key){if(key==="secondaryReply")throw Error("must not inspect handler");return Reflect.getOwnPropertyDescriptor(target,key)},
  })
  const outerOnly=await scanLoadedCommands([{key:"declared-only",class:LivePlugin,plugin:outerOnlyPlugin}])
  assert.equal(outerOnly.documents.length,1);assert.equal(outerOnly.documents[0].metadata.fnc,"secondaryReply")
  assert.deepEqual(outerOnly.warnings,[]);assert.equal(outerOnly.complete,true)
  const extraEntry={...loadedEntry,key:"unrelated-plugin"},shifted=await scanLoadedCommands([extraEntry,loadedEntry])
  assert.equal(shifted.documents[3].id,runtime1.documents[0].id)
  const reversedPlugin=new LivePlugin();reversedPlugin.rule.reverse()
  const reversed=await scanLoadedCommands([{...loadedEntry,plugin:reversedPlugin}])
  for(const document of runtime1.documents){const match=reversed.documents.find(row=>row.id===document.id);assert(match)}
  for(const change of ["permission","priority","name","implementation"]){
    const plugin=new LivePlugin(),entry={...loadedEntry,plugin}
    if(change==="permission")plugin.rule[0].permission="admin"
    if(change==="priority")entry.priority=9
    if(change==="name")plugin.name="新的展示名称"
    if(change==="implementation")plugin.dynamic=function(){return "updated"}
    const updated=(await scanLoadedCommands([entry])).documents[0]
    assert.equal(updated.id,runtime1.documents[0].id,change+" must not change the ID")
    if(change==="implementation")assert.deepEqual(updated,runtime1.documents[0],"handler changes must not affect collected metadata or retrieval text")
  }
  await assert.rejects(scanLoadedCommands([loadedEntry,{...loadedEntry,priority:2}]),/身份冲突/,"duplicate identities must fail instead of depending on scan order")
  await assert.rejects(scanLoadedCommands([{...loadedEntry,key:""}]),/稳定的插件注册来源/)
  const {compareCommandPriority}=await import("../output/runtime/knowledge/command-document-builder.js")
  assert(compareCommandPriority({priority:1,pluginOrder:0,ruleOrder:0},{priority:1,pluginOrder:1,ruleOrder:0})<0)
  assert(compareCommandPriority({priority:1,pluginOrder:0,ruleOrder:0},{priority:1,pluginOrder:0,ruleOrder:1})<0)
  const registry=(await import(pathToFileURL(path.join(host,"lib/plugins/loader.js")).href)).default
  registry.priority=[loadedEntry]
  // Real HTTP auth, preview-conflict detection, editing, audit and restore.
  const { issueWebAccessToken } = await import("../output/runtime/web/http/auth.js"),{registerCommandKnowledgeRoutes}=await import("../output/runtime/web/http/routes/knowledge/commands.js")
  const {registerKnowledgeBaseRoutes}=await import("../output/runtime/web/http/routes/knowledge/bases.js")
  const {registerConfigRoutes}=await import("../output/runtime/web/http/routes/configuration.js")
  const token=issueWebAccessToken("fixture").token
  const app=express();app.use(express.json({limit:"12mb"}));registerCommandKnowledgeRoutes(app);registerKnowledgeBaseRoutes(app);registerConfigRoutes(app);server=app.listen(0,"127.0.0.1");await once(server,"listening")
  const api=async(url,method="GET",body,authorized=true)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${url}`,{method,headers:{...(authorized?{"yui-chat-token":token}:{}),"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json().catch(()=>({}))}}
  assert.equal((await api("/api/knowledge/commands/catalog","GET",null,false)).status,401)
  assert.equal((await api("/api/knowledge/commands/collect","POST",{},false)).status,401)
  const guideUrl="/api/knowledge/bases/builtin-commands/retrieval"
  assert.equal((await api(guideUrl,"PATCH",{fieldDescription:"新说明"},false)).status,401)
  const settingsBefore=await sqliteClient.all("SELECT id FROM knowledge_index_jobs"),vectorsBefore=embeddingCalls
  const guideSaved=await api(guideUrl,"PATCH",{fieldDescription:"通过设置页保存的字段说明"})
  assert.equal(guideSaved.status,200);assert.equal(guideSaved.data.base.config.fieldDescription,"通过设置页保存的字段说明");assert.equal(guideSaved.data.index,null)
  assert.deepEqual(await sqliteClient.all("SELECT id FROM knowledge_index_jobs"),settingsBefore);assert.equal(embeddingCalls,vectorsBefore)
  assert.equal((await api(guideUrl,"PATCH",{fieldDescription:null})).status,400)
  assert.equal((await api(guideUrl,"PATCH",{fieldDescription:"长".repeat(2001)})).status,400)
  const catalogueBeforeCollection=await commandImports.list(),callsBeforeCollection=embeddingCalls
  const collectedResult=await api("/api/knowledge/commands/collect","POST",{})
  assert.equal(collectedResult.status,200);assert.equal(collectedResult.data.bundle.documents.length,3);assert.equal(collectedResult.data.pluginCount,1)
  assert.deepEqual(await commandImports.list(),catalogueBeforeCollection,"collection must not import or replace knowledge")
  assert.equal(embeddingCalls,callsBeforeCollection,"collection must not call models")
  assert.equal((await api("/api/knowledge/commands/import","POST",{bundle:bundle([document]),options:{expectedRevision:""}})).status,400)
  const preview=(await api("/api/knowledge/commands/import-preview","POST",{bundle:bundle([document])})).data
  assert.equal((await api("/api/knowledge/commands/import","POST",{bundle:bundle([document]),options:{expectedRevision:preview.revision}})).status,200)
  const state=(await api(`/api/knowledge/commands/${document.id}/history`)).data
  assert.equal((await api(`/api/knowledge/commands/${document.id}`,"PUT",{title:"edited",retrievalText:"手动编辑体力说明",expectedRevision:state.revision})).status,200)
  assert.equal((await api("/api/knowledge/commands/import","POST",{bundle:bundle([document]),options:{policy:"overwrite",expectedRevision:preview.revision}})).status,409)
  assert.equal((await api("/api/knowledge/commands/import-logs")).status,200)
  assert.equal((await api("/api/knowledge/commands/vector-status")).status,200)
  assert.equal((await api("/api/knowledge/commands/retry-vectors","POST",{})).status,200)
  assert.equal((await api("/api/knowledge/commands/export?sourceId=yunzai")).data.bundle.documents.length,(await commandImports.list()).length)
  const batchRows=[{...sign,id:"batch-delete-1"},{...sign,id:"batch-delete-2"}]
  await apply(bundle(batchRows));const beforeBatchDelete=(await commandImports.preview(bundle([]))).revision
  const batchDeleted=await api("/api/knowledge/commands","DELETE",{sourceId:"yunzai",ids:batchRows.map(row=>row.id),expectedRevision:beforeBatchDelete})
  assert.equal(batchDeleted.status,200);assert.equal(batchDeleted.data.summary.deleted,2)
  assert(!(await commandImports.list()).some(row=>row.id.startsWith("batch-delete-")))
  assert.equal((await commandImports.history(batchRows[0].id)).length,1)
  assert.equal((await api("/api/knowledge/enrichment","POST",{})).status,404,"retired AI endpoint must be absent")
  // Availability is local state: no document/history/vector churn, prefiltered retrieval, and source isolation.
  const availabilityUrl="/api/knowledge/commands/availability"
  assert.equal((await api(availabilityUrl,"PATCH",{sourceId:"yunzai",kind:"command",ids:[sign.id],enabled:false},false)).status,401)
  const otherPlugin={...sign,id:"availability-other-plugin",metadata:{...sign.metadata,pluginKey:"other-plugin",pluginName:"另一插件"}}
  const otherSource={...sign,id:"availability-other-source"}
  await apply(bundle([otherPlugin]));await apply(bundle([otherSource],"other-source"));await jobs.runAvailable();await commandObserver.load()
  const {searchKnowledgeDetailed:searchDocuments}=await import("../output/runtime/knowledge/document-retrieval.js")
  await searchDocuments({isMaster:true},"签到",{knowledgeBaseIds:[base],vectorOnly:true,limit:10})
  const callsBeforeAvailability=embeddingCalls,historyBeforeAvailability=await commandImports.history(sign.id),logsBeforeAvailability=(await commandImports.logs()).total
  const documentsBeforeAvailability=await sqliteClient.all("SELECT id,content_hash,metadata_json,updated_at FROM knowledge_documents ORDER BY id")
  const chunksBeforeAvailability=await sqliteClient.all("SELECT id,content_hash FROM knowledge_chunks ORDER BY id")
  const vectorRowsBeforeAvailability=await sqliteClient.all("SELECT id,owner_id,content_hash FROM embedding_records ORDER BY id",[],"vectors")
  const jobsBeforeAvailability=await sqliteClient.all("SELECT id FROM knowledge_index_jobs ORDER BY id")
  const availabilityRequest=(kind,ids,enabled,sourceId="yunzai")=>api(availabilityUrl,"PATCH",{sourceId,kind,ids,enabled})
  const stopped=await availabilityRequest("command",[sign.id],false)
  assert.equal(stopped.status,200);assert(stopped.data.availability.find(row=>row.id===sign.id)?.enabled===false)
  assert.equal(stopped.data.availability.length,1,"a single switch returns only the affected state")
  assert(!JSON.stringify(stopped.data.availability).includes("retrievalText"),"switch responses do not resend document bodies")
  await commandObserver.load()
  const statsBeforePluginStop=stopped.data.stats
  assert((await commandImports.list()).some(row=>row.id===sign.id && row.commandEnabled===false))
  assert(!commandObserver.findMatches("签到",10).some(row=>row.id===sign.id))
  assert(!(await commandObserver.recommendCommandsHybrid("签到",{event:{isMaster:true},limit:10})).results.some(row=>row.id===sign.id))
  assert(!(await searchKnowledgeDetailed({isMaster:true},"签到",{knowledgeBaseIds:[base]})).results.some(row=>row.commandId===sign.id))
  for(const vectorOnly of [false,true]){
    const found=await searchDocuments({isMaster:true},"签到",{knowledgeBaseIds:[base],vectorOnly,limit:1,candidateLimit:1})
    assert.equal(found.results.length,1,"disabled records must not crowd active candidates out of TopK")
    assert(found.results.every(row=>row.commandId!==sign.id))
  }
  const recommendedWhileStopped=JSON.parse(await new CommandRecommendTool().execute({query:"签到",limit:10},toolContext))
  assert(!recommendedWhileStopped.recommendations.some(row=>row.id===sign.id))
  assert.equal(embeddingCalls,callsBeforeAvailability)
  assert.deepEqual(await commandImports.history(sign.id),historyBeforeAvailability)
  assert.equal((await commandImports.logs()).total,logsBeforeAvailability)
  assert.deepEqual(await sqliteClient.all("SELECT id,content_hash,metadata_json,updated_at FROM knowledge_documents ORDER BY id"),documentsBeforeAvailability)
  assert.deepEqual(await sqliteClient.all("SELECT id,content_hash FROM knowledge_chunks ORDER BY id"),chunksBeforeAvailability)
  assert.deepEqual(await sqliteClient.all("SELECT id,owner_id,content_hash FROM embedding_records ORDER BY id",[],"vectors"),vectorRowsBeforeAvailability)
  assert.deepEqual(await sqliteClient.all("SELECT id FROM knowledge_index_jobs ORDER BY id"),jobsBeforeAvailability)
  const pluginStopped=await availabilityRequest("plugin",["key:fixture"],false)
  assert.equal(pluginStopped.status,200);assert.equal(pluginStopped.data.stats.documents,statsBeforePluginStop.documents)
  assert(pluginStopped.data.stats.searchableDocuments<statsBeforePluginStop.searchableDocuments)
  assert((await commandImports.list()).find(row=>row.id===otherSource.id).enabled,"same plugin key in another source is unaffected")
  assert(!(await commandImports.list()).find(row=>row.id===document.id).enabled)
  const blockedNew={...sign,id:"availability-new",title:"新增签到"}
  await apply(bundle([blockedNew]));await commandObserver.load()
  assert(!(await commandImports.list()).find(row=>row.id===blockedNew.id).enabled,"a disabled plugin also covers newly imported entries")
  assert.equal((await availabilityRequest("plugin",["key:fixture"],true)).status,200)
  const afterPluginEnable=await commandImports.list()
  assert.equal(afterPluginEnable.find(row=>row.id===sign.id).enabled,false,"plugin re-enable retains the individual choice")
  assert.equal(afterPluginEnable.find(row=>row.id===blockedNew.id).enabled,true)
  assert.equal((await availabilityRequest("command",[sign.id,otherPlugin.id],false)).status,200)
  assert.equal((await availabilityRequest("command",[sign.id,otherSource.id],true)).status,400,"cross-source batches must fail atomically")
  assert.equal((await commandImports.list()).find(row=>row.id===sign.id).enabled,false)
  assert.equal((await availabilityRequest("command",[sign.id],"false")).status,400)
  assert.equal((await availabilityRequest("unknown",[sign.id],false)).status,400)
  const disabledExport=await commandImports.export("yunzai")
  assert(disabledExport.documents.every(row=>!Object.hasOwn(row,"enabled")&&!Object.hasOwn(row,"pluginId")),"local switches are not external document content")
  await apply(bundle([{...sign,retrievalText:"每天签到领取奖励（更新说明）"}]),{policy:"overwrite"})
  assert.equal((await commandImports.list()).find(row=>row.id===sign.id).enabled,false,"overwriting imported content must retain local switches")
  await apply({...bundle([]),deletedIds:[sign.id]},{operation:"delete"})
  const disabledHistory=(await commandImports.history(sign.id))[0]
  await commandImports.restore(sign.id,disabledHistory.id,(await commandImports.preview(bundle([]))).revision)
  assert.equal((await commandImports.list()).find(row=>row.id===sign.id).enabled,false,"restoring an ID retains its local switch")
  assert.equal((await availabilityRequest("command",[sign.id,otherPlugin.id],true)).status,200)
  const enabledStats=(await api("/api/knowledge/bases")).data.bases.find(row=>row.id===base).stats
  assert.equal(enabledStats.searchableDocuments,enabledStats.documents)
  const allCommands=await commandImports.list(),bySource=new Map()
  for(const row of allCommands)bySource.set(row.sourceId,[...(bySource.get(row.sourceId)||[]),row.id])
  for(const [sourceId,ids] of bySource)await commandImports.setAvailability({sourceId,kind:"command",ids,enabled:false})
  const callsBeforeEmptySearch=embeddingCalls
  const emptySearch=await searchDocuments({isMaster:true},"此前未出现的新问题",{knowledgeBaseIds:[base],vectorOnly:true})
  assert.deepEqual(emptySearch.results,[]);assert.equal(embeddingCalls,callsBeforeEmptySearch,"an entirely disabled catalogue must not call the query embedding model")
  for(const [sourceId,ids] of bySource)await commandImports.setAvailability({sourceId,kind:"command",ids,enabled:true})
  await commandObserver.load()
  // The global final limit is shared by commands, documents, mixed searches, tools and HTTP.
  const quotaRows=Array.from({length:12},(_,i)=>({...document,id:`quota-${i}`,title:`#限额测试${i}`,retrievalText:`限额测试候选说明 ${i}`,metadata:{...document.metadata,suggestedCommand:`#限额测试${i}`,fnc:`quota${i}`,regexp:`^#限额测试${i}$`}}))
  await apply(bundle(quotaRows));await commandObserver.load()
  const quotaBase=await knowledgeStore.create({name:"召回限额资料",autoRetrieve:true,triggerWords:["限额测试"]})
  for(let i=0;i<12;i++)await knowledgeStore.ingestText({knowledgeBaseId:quotaBase.id,name:`普通条目${i}`,content:`限额测试候选说明 ${i}`})
  await jobs.runAvailable()
  const limitJobs=await sqliteClient.all("SELECT id FROM knowledge_index_jobs"),callsBeforeLimit=embeddingCalls
  const patchLimit=value=>api("/api/config","PATCH",{patch:{"knowledge.retrieval.resultLimit":value}})
  assert.equal((await api("/api/config","PATCH",{patch:{"knowledge.retrieval.resultLimit":3}},false)).status,401)
  assert.equal((await patchLimit(3)).status,200)
  for(const invalid of [0,21,2.5,"invalid"]){assert.equal((await patchLimit(invalid)).status,400);assert.equal(configStore.get().knowledge.retrieval.resultLimit,3)}
  assert.equal(JSON.parse((await sqliteClient.get("SELECT overrides_json FROM runtime_config WHERE id=1")).overrides_json).knowledge.retrieval.resultLimit,3)
  assert.deepEqual(await sqliteClient.all("SELECT id FROM knowledge_index_jobs"),limitJobs)
  assert.equal(embeddingCalls,callsBeforeLimit,"saving the final limit must not build vectors")
  const event={isMaster:true},quotaQuery="限额测试"
  const {resolveKnowledgeResultLimit}=await import("../output/runtime/knowledge/document-retrieval.js")
  for(const value of [undefined,null,NaN,Infinity,0,-1])assert.equal(resolveKnowledgeResultLimit(value),3)
  assert.equal(resolveKnowledgeResultLimit(1.8),1);assert.equal(resolveKnowledgeResultLimit(100),3)
  for(const limit of [undefined,1,100]){
    const expected=limit===1?1:3
    assert.equal((await commandObserver.recommendCommandsHybrid(quotaQuery,{event,limit})).results.length,expected)
    for(const ids of [[base],[quotaBase.id],[base,quotaBase.id]])assert.equal((await knowledgeStore.search(event,quotaQuery,{knowledgeBaseIds:ids,limit,useVector:false})).length,expected)
    const searched=await api(`/api/knowledge/bases/${base}/search`,"POST",{query:quotaQuery,limit})
    assert.equal(searched.status,200);assert.equal(searched.data.results.length,expected)
    assert.equal(JSON.parse(await new CommandRecommendTool().execute({query:quotaQuery,limit},{e:event})).count,expected)
    const mixedPrompt=await new KnowledgeManageTool().execute({action:"search",query:quotaQuery,knowledgeBaseIds:[base,quotaBase.id],limit},{e:event})
    assert.equal((mixedPrompt.match(/\[知识：/gu)||[]).length,expected,"combined tool output must share one final cap")
  }
  assert.equal((await new CommandSearchTool().execute({query:quotaQuery},{e:event})).match(/\[知识：/gu).length,3)
  assert.equal((await knowledgeStore.buildPrompt(event,quotaQuery)).match(/\[知识：/gu).length,3)
  const oldMode=configStore.get().knowledge.commandRetrieval.mode
  await configStore.update(c=>{c.knowledge.commandRetrieval.mode="hybrid"})
  const quotaHybrid=await commandObserver.recommendCommandsHybrid(quotaQuery,{event})
  assert.equal(quotaHybrid.results.length,3)
  assert(quotaHybrid.retrieval.vectorResults>3,"the final limit must not truncate the vector candidate pool")
  await configStore.update(c=>{c.knowledge.commandRetrieval.mode=oldMode})
  assert.equal((await patchLimit(12)).status,200)
  assert.equal((await commandObserver.recommendCommandsHybrid(quotaQuery,{event})).results.length,12)
  assert.equal(JSON.parse(await new CommandRecommendTool().execute({query:quotaQuery},{e:event})).count,12,"tools must not retain the former 5/10-result defaults")
  assert.equal((await api(`/api/knowledge/bases/${base}/search`,"POST",{query:quotaQuery})).data.results.length,12,"HTTP must not retain the former 8-result default")
  assert.equal((await patchLimit(defaults.knowledge.retrieval.resultLimit)).status,200)
  // Quality sorting covers the full matching catalogue before response limiting.
  const qualityRows=Array.from({length:205},(_,i)=>({...document,id:`quality-sort-${i}`,title:`#质量排序测试${i}`,retrievalText:`质量排序专用内容 ${i}`}))
  const weakRow={...document,id:"quality-sort-weak",title:"质量排序弱项",retrievalText:"质量排序专用内容 待补充",metadata:{pluginKey:"quality-fixture",fnc:"weak",regexp:"",description:""}}
  await apply(bundle([...qualityRows,weakRow]));await commandObserver.load()
  await sqliteClient.run("UPDATE knowledge_documents SET updated_at=1 WHERE source_key=?",[`command:${weakRow.id}`])
  const qualityUrl=`/api/knowledge/bases/${base}/documents?q=${encodeURIComponent("质量排序专用内容")}`
  assert.equal((await api(qualityUrl,"GET",undefined,false)).status,401)
  const allQuality=(await api(qualityUrl)).data.documents
  assert.equal(allQuality.length,206,"the full catalogue remains reachable beyond the former first 200")
  assert.equal(allQuality.at(-1).metadata.commandId,weakRow.id)
  const lowQuality=(await api(`${qualityUrl}&sort=quality-asc&limit=1`)).data.documents
  assert.equal(lowQuality.length,1);assert.equal(lowQuality[0].metadata.commandId,weakRow.id,"sort before limiting, including old entries outside the first page")
  const highQuality=(await api(`${qualityUrl}&sort=quality-desc`)).data.documents
  for(let i=1;i<highQuality.length;i++)assert(highQuality[i-1].qualityScore>=highQuality[i].qualityScore)
  const ascending=(await api(`${qualityUrl}&sort=quality-asc`)).data.documents
  for(let i=1;i<ascending.length;i++)assert(ascending[i-1].qualityScore<=ascending[i].qualityScore)
  assert.deepEqual((await api(`${qualityUrl}&sort=unknown`)).data.documents.map(row=>row.id),allQuality.map(row=>row.id))
  const qualityFiltered=(await api(`/api/knowledge/bases/${base}/documents?sort=quality-asc&q=${encodeURIComponent("质量排序专用内容 待补充")}`)).data.documents
  assert.equal(qualityFiltered.length,1);assert.equal(qualityFiltered[0].metadata.commandId,weakRow.id)
  // Origin rendering reads runtime registration keys and explicitly labels missing sources.
  const originExports={}
  const tabSource=await fs.readFile(new URL("../web/client/features/knowledge/knowledge-tab.ts",import.meta.url),"utf8")
  vm.runInNewContext(ts.transpileModule(tabSource+"\nexports.testDocumentOrigin = documentOrigin",{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:originExports,require:()=>({})})
  const loadedOrigin=originExports.testDocumentOrigin({source_type:"command",metadata:{origin:{type:"loaded-plugin-rule",pluginKey:"example",registrationKey:"example/网易点歌.js",method:"Music"},command:{pluginName:"点歌"}}})
  assert.equal(loadedOrigin.file,"example/网易点歌.js");assert.equal(loadedOrigin.fileLabel,"注册来源");assert.equal(loadedOrigin.plugin,"点歌")
  const offlineOrigin=originExports.testDocumentOrigin({metadata:{origin:{type:"runtime-plugin-rule",file:"plugins/example/music.ts",method:"Music"}}})
  assert.equal(offlineOrigin.fileLabel,"文件");assert.equal(offlineOrigin.file,"plugins/example/music.ts")
  assert.equal(originExports.testDocumentOrigin({source_type:"command",metadata:{command:{registrationKey:"plugin-entry",fnc:"handler"}}}).file,"plugin-entry")
  assert.equal(originExports.testDocumentOrigin({source_type:"command"}).file,"未提供来源")
  // A failed runtime apply must be retried even when the next save has identical values.
  const runtimeExports={};let runtimeCalls=0,failRuntime=true,settings={knowledge:{enabled:true},other:true}
  vm.runInNewContext(ts.transpileModule(await fs.readFile(new URL("../web/http/runtime-config.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:runtimeExports,require:spec=>spec.includes("lifecycle")?{applyRuntimeConfig:async()=>{runtimeCalls++;if(failRuntime)throw Error("runtime apply failed");return {}}}:{configStore:{save:async next=>(settings=next),update:async updater=>(settings=await updater(settings))}}})
  await assert.rejects(runtimeExports.saveConfigAndApply(settings),/runtime apply failed/);failRuntime=false
  await runtimeExports.updateConfigAndApply(config=>config);assert.equal(runtimeCalls,2)
  await runtimeExports.updateConfigAndApply(config=>({...config,knowledge:{enabled:false}}));assert.equal(runtimeCalls,2,"knowledge settings do not reload unrelated services")
  // Compile/render the management components and verify default policy and removed AI/exclusion controls.
  for(const file of ["knowledge-command-workbench","knowledge-command-editor","knowledge-command-maintenance","knowledge-base-workspace"]){
    const exports={};vm.runInNewContext(ts.transpileModule(await fs.readFile(new URL(`../web/client/features/knowledge/${file}.ts`,import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:spec=>spec==="vue"?vue:{},setTimeout,clearTimeout})
    const component=Object.values(exports)[0];assert(vue.compile(component.template))
    if(file==="knowledge-base-workspace"){
      const app=vue.createSSRApp(component,{draft:{retrievalResultLimit:3},globalResultLimit:3,globalSettingsOpen:true,globalSettingsDirty:true,baseHealth:()=>({}),documentOrigin:()=>null,canEditBuiltinCommand:()=>false,jobLabel:String,jobProgress:()=>0,jobProgressTone:()=>"",jobProgressLabel:String,shortId:String})
      app.component("Icon",{template:"<span />"});app.component("Field",{props:["label","modelValue"],template:'<label>{{ label }}<input :value="modelValue" /></label>'});app.component("Panel",{template:"<section><slot /></section>"})
      for(const name of ["StatusDot","IconButton","PagedList"])app.component(name,{template:"<span />"})
      const html=await renderToString(app);assert(html.includes("全局配置"));assert(html.includes("每次召回上限"));assert(html.includes('value="3"'));assert(html.includes("无需重建索引"))
    }
    if(file==="knowledge-command-workbench"){
      for(const currentView of ["library","import","guide"]){
        const app=vue.createSSRApp({...component,setup(props,context){const state=component.setup(props,context);state.loading.value=false;state.view.value=currentView;return state}})
        for(const name of ["Field","PagedList","Icon"])app.component(name,{template:"<span />"})
        const html=await renderToString(app)
        assert(html.includes("使用指南"));assert(html.includes("立即采集"))
        if(currentView==="library"){assert(html.includes("让机器人知道自己有哪些指令"));assert(!html.includes("textarea"));assert(!html.includes("command-file-input"))}
        if(currentView==="import"){assert(html.includes("只添加新指令"));assert(html.includes("含当前最多保留 3 个版本"))}
        if(currentView==="guide"){assert(html.includes("scan-command-knowledge.js"));assert(html.includes("复制整理提示词"));assert(html.includes("下载使用指南"))}
      }
    }
  }
  const {chunkText}=await import("../output/runtime/knowledge/chunking.js");assert.equal(chunkText("a".repeat(200),{targetChars:80,overlapChars:0,minChars:1}).length,3)
  console.log("ok knowledge-rag: stable scanner IDs, import policies/atomic audit, 3-version retention, restore/delete, canonical retrieval, incremental vectors/no-op/failure/races, auth and UI")
}finally{if(server)await new Promise(resolve=>server.close(resolve));jobs?.stop();await sqliteClient?.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true})}
