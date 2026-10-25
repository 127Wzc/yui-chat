import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import ts from "typescript"

const root=await fs.mkdtemp(path.join(os.tmpdir(),"yui-model-protocols-"))
process.env.YUI_CHAT_RUNTIME_ROOT=root
global.logger={info(){},warn(){},error(){},debug(){},mark(){}}
const requests=[]
const server=http.createServer(async(req,res)=>{
  let input="";for await(const chunk of req)input+=chunk
  const body=input?JSON.parse(input):{}
  requests.push({url:req.url,method:req.method,body,authorization:req.headers.authorization})
  let response
  if(req.url==="/v1/embeddings")response={model:body.model,data:[{index:0,embedding:[1,0]}],usage:{prompt_tokens:1,total_tokens:1}}
  else if(req.url==="/v1/rerank")response={model:body.model,results:body.documents.map((_,index)=>({index,relevance_score:1-index})),usage:{prompt_tokens:1,total_tokens:1}}
  else if(req.url==="/v1/systemone")response={model:body.model,answers:{thanks:{type:"noul",noul:0.9}},usage:{prompt_tokens:1,total_tokens:1}}
  else if(req.url==="/v1/responses")response={id:"fixture-response",model:body.model,output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"ok"}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}
  else if(req.url.includes(":batchEmbedContents"))response={embeddings:[{values:[1,0]}]}
  else if(req.method==="GET")response={data:[{id:"jev-latest"},{id:"bge-m3"},{id:"bge-reranker-v2-m3"}]}
  else{res.statusCode=404;response={error:{message:"unexpected fixture endpoint"}}}
  res.setHeader("content-type","application/json");res.end(JSON.stringify(response))
})
let sqliteClient
await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve)})
try{
  const {defaults}=await import("../output/runtime/config/defaults.js")
  const {configStore}=await import("../output/runtime/config/store.js")
  ;({sqliteClient}=await import("../output/runtime/core/storage/sqlite/client.js"))
  const {SqliteRuntimeConfigRepository}=await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  const {addModelsToProvider,updateModelConfig,resolveProviderDraft}=await import("../output/runtime/models/configuration/editor.js")
  const {providerResolver}=await import("../output/runtime/models/routing/provider-resolver.js")
  const {adapterRegistry}=await import("../output/runtime/models/adapters/registry.js")
  const {modelLogStore}=await import("../output/runtime/core/observability/model-log.js")
  const {validateConfig}=await import("../output/runtime/config/validator.js")
  const {getProviderTemplate}=await import("../output/runtime/models/configuration/provider-templates.js")
  await configStore.load();await sqliteClient.init(defaults)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  const baseURL=`http://127.0.0.1:${server.address().port}/v1`
  let cfg=structuredClone(configStore.get())
  cfg.apiProviders.push({name:"mixed",type:"openai-compatible",baseURL,apiKey:"fixture-secret"})
  const cases=[{id:"reply",purpose:"chat",adapter:"openai-responses",expected:"openai-responses",path:"/v1/responses"},
    {id:"bge-m3",purpose:"embedding",expected:"embeddings",path:"/v1/embeddings"},
    {id:"bge-reranker-v2-m3",purpose:"rerank",expected:"rerank",path:"/v1/rerank"},
    {id:"jev-latest",purpose:"decision",expected:"systemone",path:"/v1/systemone"}]
  for(const row of cases)cfg=addModelsToProvider(cfg,"mixed",[row.id],{purpose:row.purpose,...(row.adapter?{adapter:row.adapter}:{})})
  cfg=addModelsToProvider(cfg,"mixed",["image"],{purpose:"image",image:{protocol:"openai-images"}})
  assert.equal(validateConfig(cfg).ok,true)
  await configStore.save(cfg)
  const testResults=new Map()
  for(const row of cases){
    const model=cfg.models.find(m=>m.apiProvider==="mixed"&&m.modelIdentifier===row.id)
    assert.equal(model.adapter,row.expected)
    const channel=providerResolver.buildChannel(model,cfg)
    assert.equal(channel.type,row.expected);assert.equal(channel.baseURL,baseURL);assert.equal(channel.apiKey,"fixture-secret")
    const result=await adapterRegistry.testChannel(channel)
    testResults.set(model.name,result)
    assert.equal(result.model,row.id);assert.equal(result.provider,"mixed");assert(result.protocol)
    assert.equal(result.channel,model.name,"test responses retain the internal association ID separately")
    assert.equal(result.adapter,row.expected)
    const sent=requests.at(-1)
    assert.equal(sent.url,row.path);assert.equal(sent.body.model,row.id);assert.equal(sent.authorization,"Bearer fixture-secret")
    const edited=updateModelConfig(cfg,model.name,{purpose:row.purpose}).models.find(m=>m.name===model.name)
    assert.equal(edited.adapter,row.expected,"saving a model must preserve its specialized protocol")
    if(row.purpose!=="chat"){
      const chat=updateModelConfig(cfg,model.name,{purpose:"chat"}).models.find(m=>m.name===model.name)
      assert.equal(chat.adapter,"openai-compatible","changing purpose restores a usable chat protocol")
      const invalid=structuredClone(cfg);invalid.models.find(m=>m.name===model.name).adapter="openai-compatible"
      assert.equal(validateConfig(invalid).ok,false,"raw mismatched purpose/protocol must fail validation")
    }
    const preview=resolveProviderDraft({providerName:"mixed",purpose:row.purpose},cfg).channel
    if(row.purpose!=="chat")assert.equal(preview.type,row.expected,"model-list preview must select the same specialized adapter")
  }
  assert.equal(getProviderTemplate("typesafe").adapter,"systemone")
  for(const id of ["embeddings","rerank","systemone"]){
    const adapter=adapterRegistry.get(id)
    assert.equal(adapter.id,id);assert.equal(adapter.supportsTools,false);assert.equal(adapter.supportsStreaming,false)
    await assert.rejects(adapter.sendMessage({channel:{type:id},messages:[]}),/仅用于|不能作为对话/)
  }
  await assert.rejects(adapterRegistry.get("rerank").embedTexts({channel:{type:"rerank"},texts:["x"]}),/不支持/)
  await assert.rejects(adapterRegistry.get("embeddings").rerank({channel:{type:"embeddings"},query:"x",documents:["x"]}),/不支持/)
  const image=cfg.models.find(m=>m.modelIdentifier==="image")
  const beforeImage=requests.length;assert.equal((await adapterRegistry.testChannel(providerResolver.buildChannel(image,cfg))).operation,"image")
  assert.equal(requests.length,beforeImage,"testing image configuration must not generate a paid image")

  // Saving legacy model configurations migrates both mis-imported and vendor-specific protocols.
  const legacy=structuredClone(cfg)
  legacy.apiProviders.push({name:"old-decision",type:"typesafe",baseURL,apiKey:"fixture-secret"})
  legacy.models.push({name:"old-jev",modelIdentifier:"jev-latest",apiProvider:"old-decision",adapter:"typesafe",purpose:"decision"})
  legacy.models.find(m=>m.modelIdentifier==="jev-latest"&&m.apiProvider==="mixed").adapter="openai-compatible"
  legacy.models.find(m=>m.modelIdentifier==="bge-m3").adapter="chatglm"
  legacy.models.find(m=>m.modelIdentifier==="bge-reranker-v2-m3").adapter="openai-compatible"
  legacy.models.find(m=>m.modelIdentifier==="bge-m3").embedding.protocol="openai-compatible"
  await configStore.save(legacy)
  const migrated=configStore.get()
  assert.equal(migrated.apiProviders.find(p=>p.name==="old-decision").type,"systemone")
  assert.equal(migrated.models.find(m=>m.name==="old-jev").adapter,"systemone")
  for(const row of cases)assert.equal(migrated.models.find(m=>m.apiProvider==="mixed"&&m.modelIdentifier===row.id).adapter,row.expected)
  assert.equal(migrated.models.find(m=>m.modelIdentifier==="bge-m3").embedding.protocol,"embeddings")
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  assert.equal(configStore.get().models.find(m=>m.name==="old-jev").adapter,"systemone","normalized configuration survives reload")

  // Gemini keeps its native wire API while the visible model protocol is embeddings.
  let gemini=structuredClone(migrated)
  gemini.apiProviders.push({name:"native-gemini",type:"gemini",baseURL:baseURL.replace(/\/v1$/,""),apiKey:"fixture-key"})
  gemini=addModelsToProvider(gemini,"native-gemini",["native-embedding"],{purpose:"embedding"})
  const native=gemini.models.find(m=>m.modelIdentifier==="native-embedding")
  assert.equal(native.adapter,"embeddings");assert.equal(native.embedding.protocol,"gemini")
  await adapterRegistry.testChannel(providerResolver.buildChannel(native,gemini))
  assert(requests.at(-1).url.includes("/v1beta/models/native-embedding:batchEmbedContents"))

  // Human-readable log summaries survive model deletion without changing accounting keys.
  await modelLogStore.flush(true)
  const deletedKey=cfg.models.find(m=>m.apiProvider==="mixed"&&m.modelIdentifier==="jev-latest").name
  await configStore.update(c=>{c.models=c.models.filter(m=>m.name!==deletedKey)})
  const logSummary=await modelLogStore.summary({from:Date.now()-3600000,to:Date.now()+1000})
  const historical=logSummary.models.find(row=>row.name===deletedKey)
  assert(historical,"daily summary must retain deleted models")
  assert.equal(historical.model_display_name,"jev-latest");assert.equal(historical.provider_name,"mixed")
  assert.equal(historical.name,deletedKey,"display fixes must preserve accounting and filter identity")
  const display=await import("../output/runtime/web/client/shared/model-display.js")
  const vueRuntime=await import("vue")
  const clientVue={...vueRuntime,onMounted(){},onUnmounted(){}}
  const clientStore={config:cfg,providers:{channels:cases.map(row=>({id:cfg.models.find(m=>m.apiProvider==="mixed"&&m.modelIdentifier===row.id).name,model:row.id,provider:"mixed",type:row.expected,purpose:row.purpose}))}}
  const messages=[]
  const data={asRecord:v=>v||{},asRecords:v=>Array.isArray(v)?v:[],errorMessage:e=>String(e)}
  const app={store:clientStore,toast:message=>messages.push(message),request:async(_url,options)=>({result:testResults.get(JSON.parse(options.body).channelId)}),refreshTab:async()=>{}}
  const loadView=async(file,dependencies)=>{
    const exports={}
    vm.runInNewContext(ts.transpileModule(await fs.readFile(new URL(`../web/client/${file}.ts`,import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:dependencies,URLSearchParams,setTimeout,clearTimeout,setInterval,clearInterval})
    return exports
  }
  const shared=await loadView("features/providers/provider-shared",spec=>spec.includes("model-display")?display:spec.includes("app/store")?app:{})
  const providerView=await loadView("features/providers/providers-tab",spec=>spec==="vue"?clientVue:spec.includes("app/store")?app:spec.includes("shared/data")?data:spec.includes("provider-shared")?shared:{})
  const providers=providerView.ProvidersTab.setup();providers.selectProvider("mixed")
  for(const row of cases){
    const model=cfg.models.find(m=>m.apiProvider==="mixed"&&m.modelIdentifier===row.id)
    await providers.testChannel(model.name)
    assert(messages.at(-1).includes(`mixed · ${row.id}`),"actual test notification must show provider and upstream model")
    assert(!messages.at(-1).includes(model.name),"internal generated model IDs must not leak into notifications")
  }
  const logs=await loadView("features/logs/logs-tab",spec=>spec==="vue"?clientVue:spec.includes("model-display")?display:spec.includes("app/store")?app:spec.includes("shared/data")?data:{})
  assert.equal(logs.modelNamesLabel({id:"run-without-model"}),"未知模型")
  assert.equal(logs.modelNamesLabel({id:"call-id",model_name:"fallback-model"}),"fallback-model")
  const logView=logs.LogsTab.setup();logView.state.summary=logSummary
  const option=logView.modelOptions.value.find(row=>row.value===deletedKey)
  assert.equal(option.label,"mixed · jev-latest");assert.equal(option.value,deletedKey)
  const route=logs.modelRouteDetail({available_models:[{id:deletedKey,model:"jev-latest",provider:"mixed"}],actual_model:{id:deletedKey,model:"jev-latest",provider:"mixed"}})
  assert(route.includes("mixed · jev-latest")&&!route.includes(deletedKey))
  for(const protocol of ["embeddings","rerank","systemone"])assert.equal(logs.protocolShortLabel(protocol),protocol)
  assert.equal(logs.protocolShortLabel("typesafe-systemone"),"systemone")
  const {conversationLog}=await import("../output/runtime/core/chat/conversation-log.js")
  const previousLogger=global.logger
  try{
    global.logger={...previousLogger,info:message=>messages.push(String(message)),debug:message=>messages.push(String(message))}
    conversationLog.completed({...cfg,logging:{...cfg.logging,level:"debug"}},{channel:deletedKey})
    assert(messages.at(-1).includes("mixed · jev-latest")&&!messages.at(-1).includes(deletedKey),"ordinary conversation logs use readable route names too")
  }finally{global.logger=previousLogger}

  // Exercise actual front-end submit handlers, including a decision model in a chat provider.
  const vue=await import("vue")
  const submitted=[]
  const source=await fs.readFile(new URL("../web/client/features/providers/provider-editors.ts",import.meta.url),"utf8")
  const exports={}
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports,require:spec=>spec==="vue"?vue:spec.includes("app/store")?{store:{config:cfg,providers:{}},request:async(url,options)=>{if(options.method==="PATCH")submitted.push(JSON.parse(options.body));return {config:cfg}},toast(){},refreshTab:async()=>{}}:spec.includes("shared/data")?{asRecord:v=>v||{},errorMessage:e=>String(e)}:spec.includes("shared/format")?{toJson:v=>JSON.stringify(v),parseJsonText:v=>JSON.parse(v),splitTokens:v=>String(v).split(/[,\s]+/)}:spec.includes("provider-shared")?{runLocked:async(ref,fn)=>{if(ref.value)return;ref.value=true;try{return await fn()}finally{ref.value=false}},BOOL_OFF_OPTIONS:[],BOOL_OPTIONS:[],INHERIT_BOOL_OPTIONS:[],REASONING_TARGET_OPTIONS:[],uniqueModelIds:v=>v,requestProviderModels:async()=>({models:[]})}:spec.includes("provider-tool-policy")?{modelToolPolicyDraft:()=>({toolPolicyAllow:[],toolPolicyDeny:[]}),buildModelToolPolicyOptions:()=>[],modelToolPolicyPatch:()=>({})}:spec.includes("provider-responses")?{responsesModelDraft:()=>({}),responsesModelPatch:()=>({})}:{},setTimeout,clearTimeout,
  })
  for(const row of cases.filter(r=>r.purpose!=="chat")){
    const model=cfg.models.find(m=>m.apiProvider==="mixed"&&m.modelIdentifier===row.id)
    const setup=exports.ModelEditor.setup({model},{emit(){}})
    await setup.save()
    assert.equal(submitted.at(-1).adapter,row.expected,"editor must submit the dedicated protocol")
  }
  console.log("ok model display and protocols: mixed-provider HTTP tests, model imports/edits/previews, validation, legacy migration/reload, dedicated capabilities, Gemini native embeddings and editor submissions")
}finally{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
  await sqliteClient?.close?.();await fs.rm(root,{recursive:true,force:true})
}
