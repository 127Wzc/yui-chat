import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import express from "express"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "yui-evaluation-"))
process.env.YUI_CHAT_RUNTIME_ROOT = root
global.logger={warn:(...values)=>console.error(...values),info(){},debug(){},error(){}}
let sqliteClient, apiServer, modelServer
try {
  const { configStore } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  const { knowledgeEvaluation, normalizeEvaluationDataset } = await import("../output/runtime/knowledge/evaluation.js")
  const { evaluationRunner } = await import("../output/runtime/knowledge/evaluation-runner.js")
  const { registerKnowledgeEvaluationRoutes } = await import("../output/runtime/web/http/routes/knowledge/evaluation.js")
  const { requireWebAuth } = await import("../output/runtime/web/http/auth.js")
  await configStore.load()
  const first = await knowledgeEvaluation.overview()
  assert.equal(first.dataset.cases.length, 211)
  assert.equal(first.revision, 0)
  assert.equal((await sqliteClient.get("SELECT count(*) n FROM knowledge_evaluation_state")).n, 0, "viewing built-in results must not create mutable state")
  const historical = await knowledgeEvaluation.getRun("builtin-20261123")
  assert.equal(historical.metrics.hybrid.all.hits, 162)
  assert.equal(historical.metrics["hybrid-rerank"].all.hits, 153)
  assert.equal(historical.metrics["hybrid-rerank"].all.falseRecommendations, 0)
  const item = structuredClone(first.dataset.cases[0]); delete item.id; item.query = "手工新增：原神体力"
  const saved = await knowledgeEvaluation.saveCase(item, 0)
  assert.equal(saved.revision, 1)
  assert.equal(saved.dataset.cases.length, 212)
  assert.equal((await knowledgeEvaluation.getRun("builtin-20261123")).dataset.cases.length, 211, "history snapshot must not track edits")
  await assert.rejects(()=>knowledgeEvaluation.saveCase(item, 0),e=>e.statusCode===409)
  const concurrent = await Promise.allSettled([knowledgeEvaluation.saveCase({...item,query:"并发甲"},1),knowledgeEvaluation.saveCase({...item,query:"并发乙"},1)])
  assert.equal(concurrent.filter(r=>r.status==="fulfilled").length,1)
  assert.equal(concurrent.find(r=>r.status==="rejected").reason.statusCode,409)
  const current = await knowledgeEvaluation.current()
  await assert.rejects(()=>knowledgeEvaluation.saveCase({...item,expected:{...item.expected,relevantGroups:[["missing-target"]]}},current.revision),/不存在的预期目标/)
  const target = {...structuredClone(first.dataset.targets[0]),selector:{pluginKey:"evaluation-fixture",fnc:"test",regexp:"^测试预期$",regexpFlags:""},example:"测试预期"}
  delete target.id
  const targetSaved = await knowledgeEvaluation.saveTarget(target,current.revision)
  const targetId = targetSaved.dataset.targets.at(-1).id
  const targetEdited = await knowledgeEvaluation.saveTarget({...target,meaning:"页面维护的预期目标"},targetSaved.revision,targetId)
  assert.equal(targetEdited.dataset.targets.find(t=>t.id===targetId).meaning,"页面维护的预期目标")
  await assert.rejects(()=>knowledgeEvaluation.saveTarget(target,targetSaved.revision,targetId),e=>e.statusCode===409)
  const addedId = saved.dataset.cases.at(-1).id
  const deleted = await knowledgeEvaluation.deleteCase(addedId,targetEdited.revision)
  assert(!deleted.dataset.cases.some(c=>c.id===addedId))
  assert.equal((await knowledgeEvaluation.getRun("builtin-20261123")).dataset.targets.length,first.dataset.targets.length)
  const bundle = await knowledgeEvaluation.exportRun("builtin-20261123")
  const imported = await knowledgeEvaluation.importRun(bundle)
  const repeated = await knowledgeEvaluation.importRun(bundle)
  assert.equal(imported.id,repeated.id,"repeated imports are idempotent")
  const importedRun = await knowledgeEvaluation.getRun(imported.id)
  assert.equal(importedRun.metrics.hybrid.all.hits,162)
  assert.equal(importedRun.metrics["hybrid-rerank"].all.hits,153)
  assert.notEqual(importedRun.fingerprint,current.fingerprint)
  const bad = structuredClone(bundle); bad.runs.lexical[0].query = "篡改后的问法"
  await assert.rejects(()=>knowledgeEvaluation.importRun(bad),/问法与题库快照不一致/)

  await configStore.update(c=>{c.web.authToken="evaluation-test-token"})
  const app = express()
  app.use("/api/knowledge/evaluation",requireWebAuth,express.json({limit:"24mb"}))
  registerKnowledgeEvaluationRoutes(app)
  apiServer = await new Promise((resolve,reject)=>{const server=app.listen(0,"127.0.0.1",()=>resolve(server));server.once("error",reject)})
  const origin=`http://127.0.0.1:${apiServer.address().port}`
  const fetchApi = (suffix,options={})=>fetch(origin+"/api/knowledge/evaluation"+suffix,{...options,headers:{"content-type":"application/json","yui-chat-token":"evaluation-test-token",...options.headers}})
  assert.equal((await fetch(origin+"/api/knowledge/evaluation")).status,401)
  const cookieCrossSite = await fetch(origin+"/api/knowledge/evaluation/cases",{method:"POST",headers:{cookie:"yui_chat_session=evaluation-test-token",origin:"https://other.invalid","content-type":"application/json"},body:"{}"})
  assert.equal(cookieCrossSite.status,401)
  const response=await fetchApi("")
  assert.equal(response.status,200)
  const invalidRevision=await fetchApi("/cases",{method:"POST",body:JSON.stringify({case:item,expectedRevision:0})})
  assert.equal(invalidRevision.status,409)
  assert.equal((await fetchApi("/runs/builtin-20261123")).status,200)

  // A real HTTP adapter boundary, with no external model calls. The score is not
  // a quality claim: this fixture only verifies isolation, lifecycle and protocols.
  let modelCalls=0, delayed=false
  modelServer = http.createServer(async(req,res)=>{
    let text="";for await(const part of req)text+=part
    const input=JSON.parse(text);modelCalls++
    if(delayed)await new Promise(resolve=>setTimeout(resolve,1500))
    res.setHeader("content-type","application/json")
    if(req.url.endsWith("/embeddings"))res.end(JSON.stringify({data:input.input.map((_,index)=>({index,embedding:[1,0]})),usage:{prompt_tokens:1,total_tokens:1}}))
    else res.end(JSON.stringify({results:input.documents.map((_,index)=>({index,relevance_score:.9})),usage:{prompt_tokens:1,total_tokens:1}}))
  })
  await new Promise((resolve,reject)=>{modelServer.once("error",reject);modelServer.listen(0,"127.0.0.1",resolve)})
  const { knowledgeStore } = await import("../output/runtime/knowledge/store.js")
  const { knowledgeRepository } = await import("../output/runtime/knowledge/repository.js")
  const { commandImports } = await import("../output/runtime/knowledge/command-import.js")
  const { knowledgeIndexJobs } = await import("../output/runtime/knowledge/index-jobs.js")
  const { vectorIndex } = await import("../output/runtime/knowledge/vector-index.js")
  const { embeddingIdentity } = await import("../output/runtime/knowledge/embedding-identity.js")
  knowledgeIndexJobs.scheduleAvailable=()=>{}
  await configStore.update(c=>{
    c.apiProviders=[...c.apiProviders.filter(p=>p.name!=="fixture"),{name:"fixture",type:"openai-compatible",baseURL:`http://127.0.0.1:${modelServer.address().port}/v1`,apiKey:"fixture-only"}]
    c.models=[...c.models.filter(m=>!["eval-embedding","eval-rerank"].includes(m.name)),{name:"eval-embedding",apiProvider:"fixture",modelIdentifier:"embedding-fixture",adapter:"embeddings",purpose:"embedding",capabilities:{embedding:true},embedding:{defaultDimensions:2,allowedDimensions:[2],batchSize:32,timeoutMs:10000}},{name:"eval-rerank",apiProvider:"fixture",modelIdentifier:"rerank-fixture",adapter:"rerank",purpose:"rerank",capabilities:{rerank:true}}]
    c.knowledge.retrieval.rerankModel="eval-rerank";c.knowledge.retrieval.rerankMinScore=.1;c.knowledge.retrieval.rerankCacheTtlMs=0
  })
  await knowledgeStore.init()
  const existing=await knowledgeRepository.getBase("builtin-commands")
  await knowledgeRepository.upsertBase({id:"builtin-commands",name:"内置指令知识库",protected:true,config:{...existing.config,embeddingModel:"eval-embedding",dimensions:2,distanceMetric:"cosine"}})
  await commandImports.apply({schemaVersion:1,sourceId:"fixture",documents:[{id:"fixture-stamina",title:"原神体力",retrievalText:"原神体力查询，查看树脂恢复情况。",metadata:{...first.dataset.targets[0].selector,suggestedCommand:"#原神体力",description:"查询原神体力",event:"message",pluginName:"测试指令"}}]})
  const chunks=await sqliteClient.all("SELECT id,content_hash FROM knowledge_chunks WHERE knowledge_base_id='builtin-commands'")
  const space=await vectorIndex.ensureSpace({modelName:"eval-embedding",dimensions:2,distanceMetric:"cosine",scopeKey:`builtin-commands:fixture:fp-${embeddingIdentity("eval-embedding")}`})
  await vectorIndex.upsertBatch(space,chunks.map(c=>({ownerType:"knowledge_chunk",ownerId:c.id,contentHash:c.content_hash,vector:[1,0]})))
  await sqliteClient.run("UPDATE knowledge_bases SET active_vector_space_id=? WHERE id='builtin-commands'",[space.id])
  const small=normalizeEvaluationDataset({...first.dataset,cases:[first.dataset.cases[0],first.dataset.cases.find(c=>c.kind==="negative")]})
  await knowledgeEvaluation.replaceDataset(small,(await knowledgeEvaluation.current()).revision)
  const configBefore=JSON.stringify(configStore.get()),docsBefore=JSON.stringify(await sqliteClient.all("SELECT * FROM knowledge_documents ORDER BY id"))
  const plan=await evaluationRunner.plan()
  assert.equal(plan.questions,2);assert.equal(modelCalls,0,"reading plan, editing, importing and opening results must not call models")
  await assert.rejects(()=>evaluationRunner.start({expectedRevision:plan.revision,signature:"stale"}),e=>e.statusCode===409)
  const started=await evaluationRunner.start({expectedRevision:plan.revision,signature:plan.signature})
  await assert.rejects(()=>evaluationRunner.start({expectedRevision:plan.revision,signature:plan.signature}),e=>e.statusCode===409)
  const waitRun=async(id)=>{
    const end=Date.now()+25000
    while(Date.now()<end){const record=(await knowledgeEvaluation.overview()).runs.find(r=>r.id===id);if(!["queued","running"].includes(record.status)&&evaluationRunner.activeId()!==id)return record;await new Promise(r=>setTimeout(r,100))}
    throw new Error("evaluation did not finish in 25 seconds")
  }
  const finished=await waitRun(started.id)
  assert.equal(finished.status,"completed",JSON.stringify(finished))
  const result=await knowledgeEvaluation.getRun(started.id)
  for(const mode of ["lexical","hybrid","hybrid-rerank"])assert.equal(result.modes[mode].length,2)
  assert(modelCalls>0)
  assert(modelCalls<=plan.maxEmbeddingCalls+plan.maxRerankCalls,"warm cache probes must not issue extra paid requests")
  assert(result.modes["hybrid-rerank"].some(row=>row.warmLatencyMs===null),"uncached rerank warm probes must leave latency unmeasured")
  assert.equal(JSON.stringify(configStore.get()),configBefore,"isolated modes must not mutate production config")
  assert.equal(JSON.stringify(await sqliteClient.all("SELECT * FROM knowledge_documents ORDER BY id")),docsBefore)
  const temp=path.join(root,"data/yui-chat/cache/temp")
  assert(!(await fs.readdir(temp)).some(n=>n.startsWith("knowledge-evaluation-")),"private snapshots must be removed")
  delayed=true
  const cancelling=await evaluationRunner.start({expectedRevision:plan.revision,signature:plan.signature})
  const delayEnd=Date.now()+5000
  while(Date.now()<delayEnd&&(await knowledgeEvaluation.overview()).runs.find(r=>r.id===cancelling.id).progress.mode!=="hybrid")await new Promise(r=>setTimeout(r,50))
  evaluationRunner.cancel(cancelling.id)
  assert.equal((await waitRun(cancelling.id)).status,"cancelled")
  await assert.rejects(()=>sqliteClient.evaluationSnapshot(path.join(root,"not-an-evaluation.sqlite3")),/临时路径/)
  await sqliteClient.close();await sqliteClient.init()
  assert.equal((await knowledgeEvaluation.current()).dataset.cases.length,2,"questions must survive a database reconnect")
  assert.equal((await knowledgeEvaluation.getRun(started.id)).modes.hybrid.length,2,"run snapshots must survive reconnect")
  const orphan=path.join(temp,"knowledge-evaluation-00000000-0000-0000-0000-000000000000")
  await fs.mkdir(orphan,{recursive:true});await fs.writeFile(path.join(orphan,"state.sqlite3"),"private fixture")
  await sqliteClient.run("UPDATE knowledge_evaluation_runs SET status='running' WHERE id=?",[imported.id])
  const callsBeforeRecovery=modelCalls
  await evaluationRunner.recoverInterrupted()
  await assert.rejects(()=>fs.access(orphan))
  assert.equal((await knowledgeEvaluation.overview()).runs.find(r=>r.id===imported.id).status,"interrupted")
  assert.equal(modelCalls,callsBeforeRecovery,"crash recovery must not restart model calls")
  console.log("ok knowledge evaluation: baseline scores, revision conflicts, immutable history, imports, auth/origin, isolated real-protocol job, cancellation and cleanup")
  if(process.argv.includes("--preview")) {
    delayed=false
    await sqliteClient.run("DELETE FROM knowledge_evaluation_state")
    await sqliteClient.run("DELETE FROM knowledge_evaluation_runs")
    const router=express.Router()
    router.use("/api/knowledge/evaluation",requireWebAuth,express.json({limit:"24mb"}))
    registerKnowledgeEvaluationRoutes(router)
    router.use("/assets",express.static(new URL("../output/runtime/web/client",import.meta.url).pathname))
    router.get("/",(_req,res)=>{
      res.setHeader("Set-Cookie","yui_chat_session=evaluation-test-token; HttpOnly; SameSite=Strict; Path=/yui-chat")
      res.type("html").send(`<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="/yui-chat/"><title>Yui Chat · 检索评测验证</title><link rel="icon" href="data:,"><link rel="stylesheet" href="assets/app.css"><script type="importmap">{"imports":{"vue":"/yui-chat/assets/vendor/vue.esm-browser.prod.js"}}</script></head><body><div id="app"></div><script type="module">import{createApp}from'vue';import{KnowledgeEvaluation}from'./assets/features/knowledge/knowledge-evaluation.js';import{components}from'./assets/ui/components.js';const app=createApp({components:{KnowledgeEvaluation},data:()=>({open:true}),template:'<div style="padding:32px"><h2>知识库 · 隔离验证</h2><button class="btn" @click="open=true">检索评测</button><KnowledgeEvaluation v-if="open" :open="open" @close="open=false"/><ConfirmDialog/><Toast/></div>'});for(const[name,c]of Object.entries(components))app.component(name,c);app.mount('#app');</script></body></html>`)
    })
    app.use("/yui-chat",router)
    console.log(`evaluation preview: ${origin}/yui-chat/ (temporary database and localhost model fixtures only)`)
    await new Promise(resolve=>{process.once("SIGINT",resolve);process.once("SIGTERM",resolve)})
  }
} finally {
  await sqliteClient?.close()
  if(apiServer)await new Promise(r=>apiServer.close(r))
  if(modelServer)await new Promise(r=>modelServer.close(r))
  await fs.rm(root,{recursive:true,force:true})
}
