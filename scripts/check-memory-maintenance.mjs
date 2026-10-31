import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"

const pluginRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..")
await fs.mkdir(path.join(pluginRoot,"cache"),{recursive:true})
const root=await fs.mkdtemp(path.join(pluginRoot,"cache","memory-maintenance-"))
process.env.YUI_CHAT_RUNTIME_ROOT=root
const host=path.join(root,"host")
process.env.YUI_CHAT_PLUGIN_ROOT=path.join(host,"plugins/yui-chat")
await fs.mkdir(path.join(host,"plugins/yui-chat"),{recursive:true})
await fs.mkdir(path.join(host,"lib/plugins"),{recursive:true})
await fs.writeFile(path.join(host,"package.json"),'{"type":"module"}')
await fs.writeFile(path.join(host,"lib/plugins/loader.js"),'export default { priority: [], deal: async()=>false }')
global.logger={mark(){},info(){},warn(){},error(){},debug(){}}
global.Bot={express:null,wsf:{},uin:[]}
global.segment={at:String,image:String,record:String,reply:String}
global.plugin=class {}
let db,capture,modelLogStore,vectorRecall
try {
  // 仅新增迁移，从现有 012 数据库升级，不重放旧迁移或改写事实/证据。
  const {runStateMigrations}=await import("../output/runtime/core/storage/sqlite/migration-runner.js")
  const upgrade=new Database(":memory:")
  try {
    upgrade.pragma("foreign_keys=ON")
    upgrade.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY,applied_at INTEGER NOT NULL) STRICT")
    const dir=new URL("../core/storage/sqlite/migrations/",import.meta.url)
    for(const file of (await fs.readdir(dir)).filter(f=>f.endsWith(".sql")&&f<"013").sort()) {
      upgrade.exec(await fs.readFile(new URL(file,dir),"utf8"))
      upgrade.prepare("INSERT INTO schema_migrations VALUES(?,1)").run(file)
    }
    upgrade.prepare("INSERT INTO memory_items(id,scope_type,owner_id,type,text,normalized_key,last_confirmed_at,created_at,updated_at) VALUES('legacy','user','old','fact','原有事实','old',1,1,1)").run()
    upgrade.prepare("INSERT INTO memory_evidence VALUES('legacy','original','group-message:old','m')").run()
    upgrade.prepare("INSERT INTO group_memory_policies(group_id,enabled,token_limit,max_tokens,model_name,last_daily_end,created_at,updated_at,retrieval_result_limit) VALUES('saved',1,60000,65536,'saved-model',123,1,2,10)").run()
    upgrade.prepare("INSERT INTO group_memory_policies(group_id,created_at,updated_at) VALUES('inherited',1,2)").run()
    const savedPolicies=upgrade.prepare("SELECT * FROM group_memory_policies ORDER BY group_id").all()
    const migrated=runStateMigrations(upgrade)
    assert.equal(migrated.at(-1).id,"015-memory-incremental-updates.sql")
    assert(migrated.slice(0,-3).every(m=>m.applied_at===1))
    assert.equal(upgrade.prepare("SELECT text FROM memory_items WHERE id='legacy'").get().text,"原有事实")
    assert.equal(upgrade.prepare("SELECT source_event_id FROM memory_evidence").get().source_event_id,"original")
    assert.deepEqual(runStateMigrations(upgrade),migrated)
    assert.deepEqual(upgrade.prepare("SELECT * FROM group_memory_policies ORDER BY group_id").all(),savedPolicies,"range migration must preserve all overrides, NULL inheritance and capture state")
    upgrade.prepare("UPDATE group_memory_policies SET token_limit=1000000,max_tokens=100000 WHERE group_id='saved'").run()
    assert.throws(()=>upgrade.prepare("UPDATE group_memory_policies SET token_limit=1000001 WHERE group_id='saved'").run(),/CHECK/)
    assert.throws(()=>upgrade.prepare("UPDATE group_memory_policies SET max_tokens=100001 WHERE group_id='saved'").run(),/CHECK/)
    assert.equal(upgrade.pragma("quick_check",{simple:true}),"ok")
  } finally {upgrade.close()}
  const {defaults}=await import("../output/runtime/config/defaults.js")
  const {configStore}=await import("../output/runtime/config/store.js")
  ;({sqliteClient:db}=await import("../output/runtime/core/storage/sqlite/client.js"))
  const {SqliteRuntimeConfigRepository}=await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  const {MemoryMaintenance}=await import("../output/runtime/memory/maintenance.js")
  const {memoryRepository}=await import("../output/runtime/memory/repository.js")
  ;({groupCaptureStore:capture}=await import("../output/runtime/memory/group-capture.js"))
  ;({modelLogStore}=await import("../output/runtime/core/observability/model-log.js"))
  ;({vectorRecall}=await import("../output/runtime/memory/vector-recall.js"))
  await configStore.load()
  assert.equal((await db.init(defaults)).available,true)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(db))
  await configStore.update(c=>{c.memory.enabled=true;c.memory.groupCapture.enabled=true;c.memory.groupCapture.consolidation.enabled=false})
  const {validateConfig}=await import("../output/runtime/config/validator.js")
  assert.equal(defaults.memory.groupCapture.defaultTokenLimit,200000)
  assert.equal(defaults.memory.groupCapture.consolidation.maxTokens,100000)
  const rangeConfig=JSON.parse(JSON.stringify(configStore.get()))
  rangeConfig.memory.groupCapture.defaultTokenLimit=1000000
  rangeConfig.memory.groupCapture.consolidation.maxTokens=100000
  assert.equal(validateConfig(rangeConfig).ok,true)
  rangeConfig.memory.groupCapture.defaultTokenLimit=1000001
  assert.equal(validateConfig(rangeConfig).ok,false)
  rangeConfig.memory.groupCapture.defaultTokenLimit=200000
  rangeConfig.memory.groupCapture.consolidation.maxTokens=100001
  assert.equal(validateConfig(rangeConfig).ok,false)
  const DAY=86400000,originalTime=Date.now()-10*DAY
  const groups=["g","other","many","history","backfill","race","failure","cancel","clear","batch","expiry","scope","manual","split","budget","history-scope","public-backfill"]
  for(const g of groups)await capture.setPolicy("group",g,{enabled:true,tokenLimit:60000,overrides:{tokenLimit:true}})
  let serial=0,calls=0,historyCalls=0,inputs=[],choose=()=>[]
  const reportedUsage={input:11618,output:3279,total:14897,cached:0,reasoning:133,source:"reported",inputKnown:true,outputKnown:true,totalKnown:true}
  let modelUsage=reportedUsage
  const model=async options=>{
    calls++
    assert.equal(options.singleAttempt,true,"整理任务必须禁止渠道 fallback，单次完成")
    const input=JSON.parse(options.prompt);inputs.push(input)
    const operations=await choose(input,options)
    return {text:typeof operations==="string"?operations:JSON.stringify({reviewedIds:input.memories.map(m=>m.id),reviewedMessageIds:input.history.map(m=>m.id),operations}),usage:modelUsage}
  }
  const service=new MemoryMaintenance(model)
  async function fact(user,text,group="g",extra={}) {
    const {scope="user_group",evidence=[],...fields}=extra
    return memoryRepository.insert({scopeType:scope,ownerId:scope==="group"?group:user,groupId:scope==="user"?"":group,type:"fact",text,factKey:`preference.item${++serial}`,factValue:text,source:"group-window:test",confidence:0.8,lastConfirmedAt:originalTime,...fields},{evidence})
  }
  async function message(group,id,user,text="我喜欢天文。",extra={}) {
    const {segments=[],at=Date.now()-1000,expires=Date.now()+DAY,isCommand=0}=extra
    await db.run("INSERT INTO group_memory_messages(id,group_id,message_id,sender_id,sender_name,sent_at,text_content,content_hash,segments_json,is_command,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",[id,group,id,user,user,at,text,id,JSON.stringify(segments),isCommand,expires])
  }
  async function settle(job,expected="ready") {
    let result
    for(let i=0;i<600;i++) {
      result=await service.view(job.id)
      if(!["queued","collecting","analyzing"].includes(result.status))break
      await new Promise(r=>setTimeout(r,10))
    }
    assert.equal(result.status,expected,JSON.stringify(result))
    return result
  }
  async function analyze(group,user,handler=()=>[],options={}) {
    choose=handler
    return settle(await service.create(group,user,options))
  }
  const get=id=>db.get("SELECT * FROM memory_items WHERE id=?",[id])
  const output=(m,extra={})=>({text:m.text,scope:m.scope,factKey:m.factKey,factValue:m.factValue,memoryIds:[m.id],messageIds:[],confidence:m.confidence,expiresAt:0,...extra})
  const rewrite=(m,text)=>({kind:"rewrite",sourceIds:[m.id],outputs:[output(m,{text,factValue:text})],reason:"改写为更清晰的同一事实"})

  // 默认完整读取超过一页的记忆，来源只取元信息，不访问原文或底层历史。
  global.Bot.pickGroup=()=>({getChatHistory:async()=>{historyCalls++;throw new Error("默认路径不应调用历史")}})
  for(let i=0;i<260;i++)await fact("many-user",`喜欢第${i}种文学作品`,"many")
  const globalFact=await fact("many-user","喜欢天文", "many",{scope:"user",evidence:[{sourceEventId:"meta",sourceType:"group-message:many",messageId:"meta"}]})
  await fact("many-user","其他群专用信息","other")
  await fact("other-user","其他成员信息","many")
  await message("many","meta","many-user","不应出现在默认分析中的聊天原文")
  const complete=await analyze("many","many-user",()=>[],{count:"ignored"})
  assert.equal(complete.progress.memoryCount,261)
  assert.equal(complete.progress.messageCount,0)
  assert.equal(complete.requestedCount,0)
  assert.deepEqual(complete.progress.usage,reportedUsage,"成功任务保存上游用量，预算估算单独保留")
  assert.notEqual(complete.progress.inputTokens,complete.progress.usage.input)
  assert.equal(historyCalls,0)
  const defaultInput=inputs.at(-1)
  assert.equal(defaultInput.memories.length,261)
  assert(defaultInput.memories.some(m=>m.id===globalFact.id))
  assert(!JSON.stringify(defaultInput).includes("不应出现在默认分析中"))
  assert(!JSON.stringify(defaultInput).includes("其他群专用信息")&&!JSON.stringify(defaultInput).includes("其他成员信息"))
  assert(!Object.hasOwn(complete,"snapshot")&&!Object.hasOwn(complete,"chunks"))
  await assert.rejects(service.source(complete.id,"meta"),/未开启/)

  // 群公共任务从当前群全体成员取材；个人任务在 LIMIT 之前按目标成员过滤。
  const groupMemory=await fact("history-scope","群里定期读书","history-scope",{scope:"group"})
  const memberMemory=await fact("scope-a","喜欢读书","history-scope")
  await fact("scope-b","喜欢诗歌","history-scope")
  await fact("other","其他群活动","other",{scope:"group"})
  const scopeTime=Date.now()-10000
  await message("history-scope","scope-a1","scope-a","本群每周六组织读书会。",{at:scopeTime})
  await message("history-scope","scope-a2","scope-a","我喜欢科幻小说。",{at:scopeTime+1000})
  await message("history-scope","scope-b1","scope-b","确认读书会是每周六。",{at:scopeTime+2000})
  await message("history-scope","scope-command","scope-b","#yuihelp",{isCommand:1,at:scopeTime+3000})
  await message("history-scope","scope-forward","scope-a","转发其他人的经历",{segments:[{type:"forward"}],at:scopeTime+4000})
  await message("history-scope","scope-expired","gone","过期发言",{expires:Date.now()-1})
  await message("other","scope-other-group","scope-a","其他群的发言")
  const scopedGroup=await analyze("history-scope","",(input,options)=>{
    assert.equal(input.target.scope,"group")
    assert(options.systemPrompt.includes("当前群各成员的有效发言"))
    assert.deepEqual(input.memories.map(m=>m.id),[groupMemory.id])
    assert.deepEqual(new Set(input.history.map(m=>m.id)),new Set(["scope-a1","scope-a2","scope-b1"]))
    return [{kind:"add",sourceIds:[],outputs:[{text:"本群每周六组织读书会",scope:"group",factKey:"group.reading_schedule",factValue:"每周六读书会",memoryIds:[],messageIds:["scope-a1","scope-b1"],confidence:0.85,expiresAt:0}],reason:"本群成员提出并确认的公共活动安排"}]
  },{useHistory:true,count:3})
  assert.equal(scopedGroup.progress.messageCount,3)
  assert.equal((await service.source(scopedGroup.id,"scope-b1")).author,"scope-b")
  await assert.rejects(service.source(scopedGroup.id,"scope-other-group"),/范围/)
  await service.apply(scopedGroup.id,[scopedGroup.plan[0].id])
  const publicResult=await db.get("SELECT * FROM memory_items WHERE source=?",[`maintenance:${scopedGroup.id}`])
  assert.equal(publicResult.scope_type,"group");assert.equal(publicResult.owner_id,"history-scope")
  assert.equal((await get(memberMemory.id)).status,"active")
  const scopedMember=await analyze("history-scope","scope-a",input=>{
    assert.equal(input.target.scope,"member")
    assert.deepEqual(input.memories.map(m=>m.id),[memberMemory.id])
    assert.deepEqual(input.history.map(m=>m.id),["scope-a1","scope-a2"])
    assert(input.history.every(m=>m.author==="scope-a"))
    return []
  },{useHistory:true,count:2})
  await assert.rejects(service.source(scopedMember.id,"scope-b1"),/范围/)
  choose=()=>[{kind:"add",sourceIds:[],outputs:[{text:"个人候选",scope:"user",factKey:"preference.test",factValue:"测试",memoryIds:[],messageIds:["scope-a1"],confidence:0.8,expiresAt:0}],reason:"不能在群公共任务写入个人记忆"}]
  const wrongScope=await settle(await service.create("history-scope","",{useHistory:true,count:3}));assert(wrongScope.plan[0].blocked);await assert.rejects(service.apply(wrongScope.id,[wrongScope.plan[0].id]),/异常变更/)
  choose=()=>[{kind:"add",sourceIds:[],outputs:[{text:"本人候选",scope:"user",factKey:"preference.test",factValue:"测试",memoryIds:[],messageIds:["scope-b1"],confidence:0.8,expiresAt:0}],reason:"不能拿其他成员的原文作本人依据"}]
  const wrongAuthor=await settle(await service.create("history-scope","scope-a",{useHistory:true,count:2}));assert(wrongAuthor.plan[0].blocked);await assert.rejects(service.apply(wrongAuthor.id,[wrongAuthor.plan[0].id]),/异常变更/)
  choose=()=>[]
  const batchInputStart=inputs.length
  const scopedBatch=await service.group("history-scope",{useHistory:true,count:1})
  assert.equal(scopedBatch.failures.length,0);assert.equal(scopedBatch.jobs.length,3)
  for(const item of scopedBatch.jobs)await settle(item)
  const batchInputs=inputs.slice(batchInputStart)
  assert.equal(batchInputs.length,3)
  assert(batchInputs.some(input=>input.target.scope==="group"&&input.target.userId===""))
  assert(batchInputs.filter(input=>input.target.scope==="member").every(input=>input.history.every(m=>m.author===input.target.userId)))
  assert.equal(historyCalls,0,"两种范围数据库足量时均不拉取平台历史")

  // 逐组应用、保留未选项；弱置信度不能因合并取较高值，确认时间及显式到期不延长。
  const a=await fact("merge-user","喜欢天文","g",{confidence:0.9,expiresAt:Date.now()+DAY,evidence:[{sourceEventId:"e-a",sourceType:"group-message:g",messageId:"a"}]})
  const b=await fact("merge-user","爱好天文","g",{confidence:0.65,evidence:[{sourceEventId:"e-b",sourceType:"group-message:other",messageId:"b"}]})
  const c=await fact("merge-user","爱好摄影")
  const plan=await analyze("g","merge-user",input=>[
    {kind:"merge",sourceIds:[a.id,b.id],outputs:[output(input.memories.find(m=>m.id===a.id),{memoryIds:[a.id,b.id],text:"爱好天文学",factValue:"爱好天文学",confidence:0.99})],reason:"同一偏好的重复表述"},
    rewrite(input.memories.find(m=>m.id===c.id),"爱好自然摄影"),
  ])
  assert.equal(plan.plan.length,2)
  const merge=plan.plan[0]
  assert.equal((await get(a.id)).status,"active","分析不直接写回记忆")
  await db.run("INSERT INTO portrait_reports(id,group_id,user_id,type_id,version,month,report_json,sources_json,created_at) VALUES('affected-portrait','g','merge-user','positive',1,'2026-10','{}',?,?)",[JSON.stringify({memories:[{id:a.id}]}),Date.now()])
  const [applied,repeatApplied]=await Promise.all([service.apply(plan.id,[merge.id]),service.apply(plan.id,[merge.id])])
  assert.equal(applied.status,"applied");assert.equal(applied.receipt.applied,1)
  assert.equal(repeatApplied.receipt.appliedAt,applied.receipt.appliedAt,"并发重复请求只提交一次")
  assert.equal((await db.get("SELECT status FROM portrait_reports WHERE id='affected-portrait'")).status,"invalid")
  assert.equal((await get(c.id)).status,"active")
  const replacement=await db.get("SELECT * FROM memory_items WHERE source=?",[`maintenance:${plan.id}`])
  assert.equal(replacement.confidence,0.65)
  assert.equal(replacement.last_confirmed_at,originalTime)
  assert.equal(replacement.expires_at,(await get(a.id)).expires_at)
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM memory_evidence WHERE memory_id=?",[replacement.id])).n,2)
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_id=?",[replacement.id])).n,1)
  assert.equal((await service.apply(plan.id,[merge.id])).receipt.appliedAt,applied.receipt.appliedAt)
  await assert.rejects(service.apply(plan.id,[plan.plan[1].id]),/不同的选择/)
  assert.equal((await service.undo(plan.id)).status,"undone")
  assert.equal((await get(a.id)).status,"active");assert.equal((await get(b.id)).status,"active")
  assert.equal(await get(replacement.id),undefined)
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_id=?",[replacement.id])).n,0)

  // 事务内条件断言必须回滚先前写入，包含零行更新与缺失的版本行。
  for(const guard of [{sql:"UPDATE memory_items SET text=text WHERE id='missing'",expectChanges:1},{sql:"SELECT revision FROM memory_maintenance_versions WHERE owner_id='missing'",mode:"get",expect:{revision:0}}]) {
    await assert.rejects(db.transaction([{sql:"UPDATE memory_items SET text='不能提交的变化' WHERE id=?",params:[a.id]},guard]))
    assert.equal((await get(a.id)).text,"喜欢天文")
  }
  const stale=await analyze("g","merge-user",input=>[rewrite(input.memories.find(m=>m.id===a.id),"喜欢观测星空")])
  await memoryRepository.update(c.id,{text:"本人后来改成电影兴趣"})
  await assert.rejects(service.apply(stale.id,[stale.plan[0].id]),/资料已变化/)
  assert.equal((await service.view(stale.id)).status,"stale")
  assert.equal((await get(a.id)).status,"active")
  const staleEvidence=await analyze("g","merge-user",input=>[rewrite(input.memories.find(m=>m.id===a.id),"喜欢研究星空")])
  await db.run("INSERT INTO memory_evidence VALUES(?,?,?,'')",[a.id,"new-proof","group-message:g"])
  await assert.rejects(service.apply(staleEvidence.id,[staleEvidence.plan[0].id]),/资料已变化/)

  const atomicFact=await fact("atomic-user","喜欢竹笛","failure")
  const atomic=await analyze("failure","atomic-user",input=>[rewrite(input.memories[0],"喜欢传统竹笛")])
  await db.exec("CREATE TRIGGER maintenance_test_failure BEFORE INSERT ON memory_items WHEN NEW.source LIKE 'maintenance:%' BEGIN SELECT RAISE(ABORT,'injected failure'); END")
  await assert.rejects(service.apply(atomic.id,[atomic.plan[0].id]),/injected failure/)
  assert.equal((await get(atomicFact.id)).status,"active")
  assert.equal((await service.view(atomic.id)).status,"ready")
  await db.exec("DROP TRIGGER maintenance_test_failure")

  // 无法解析或缺少操作数组时失败；可解析的局部异常在后续逐组隔离。
  let malformedFailure
  for(const bad of ["{",JSON.stringify({reviewedIds:[],reviewedMessageIds:[],operations:{}})]) {
    choose=()=>bad
    const invalid=await settle(await service.create("failure","atomic-user"),"failed")
    assert.deepEqual(invalid.progress.usage,reportedUsage,"格式和审阅核验失败也保留已发生的用量")
    assert.deepEqual(invalid.plan,[]);malformedFailure=invalid
  }
  // 无历史时，证据元信息不能被当成已读原文；两类审阅范围分别说明匹配、缺失和多出数量。
  const coverageFact=await fact("coverage-user","喜欢科幻小说","failure",{evidence:[{sourceEventId:"metadata-only",sourceType:"group-message:failure",messageId:"metadata-only"}]})
  choose=input=>JSON.stringify({reviewedIds:input.memories.map(m=>m.id),reviewedMessageIds:[input.memories[0].evidence[0].id,input.memories[0].evidence[0].id],operations:[]})
  const coverageFailure=await settle(await service.create("failure","coverage-user"))
  assert.equal(coverageFailure.progress.analysisComplete,false)
  assert(coverageFailure.plan[0].issue.includes("记忆确认 1/1 条（缺失 0 条，多出 0 个标识）"))
  assert(coverageFailure.plan[0].issue.includes("原文确认 0/0 条（缺失 0 条，多出 1 个标识）"))
  assert(coverageFailure.plan[0].blocked)
  assert(!coverageFailure.plan[0].issue.includes("metadata-only"),"失败摘要只记录计数，不复制模型返回的标识")
  assert.deepEqual(coverageFailure.progress.usage,reportedUsage)
  assert.equal((await get(coverageFact.id)).status,"active")
  await assert.rejects(service.apply(coverageFailure.id,[coverageFailure.plan[0].id]),/异常变更/)
  const {parseProposals}=await import("../output/runtime/memory/maintenance-plan.js")
  const reviewJob={useHistory:true,snapshot:{memories:[],evidence:[],messages:[]}}
  const reviewResponse=(memories,messages)=>JSON.stringify({reviewedIds:memories,reviewedMessageIds:messages,operations:[]})
  assert.deepEqual(parseProposals(reviewResponse(["m2","m1","m1"],["h1"]),reviewJob,["m1","m2"],["h1"],0.7),[],"顺序和重复不改变原有集合核验语义")
  for(const [memories,messages,memorySummary,messageSummary] of [
    [["m1"],["h1"],"记忆确认 1/2 条（缺失 1 条，多出 0 个标识）","原文确认 1/1 条（缺失 0 条，多出 0 个标识）"],
    [["m1","unknown-memory"],["unknown-message"],"记忆确认 1/2 条（缺失 1 条，多出 1 个标识）","原文确认 0/1 条（缺失 1 条，多出 1 个标识）"],
    [["m1","m2"],[],"记忆确认 2/2 条（缺失 0 条，多出 0 个标识）","原文确认 0/1 条（缺失 1 条，多出 0 个标识）"],
  ])assert.throws(()=>parseProposals(reviewResponse(memories,messages),reviewJob,["m1","m2"],["h1"],0.7),error=>error.message.includes(memorySummary)&&error.message.includes(messageSummary))
  assert.throws(()=>parseProposals(JSON.stringify({reviewedIds:[],operations:[]}),reviewJob,[],[],0.7),/原文审阅列表格式错误/)
  const memoryRefs=Array.from({length:59},(_,i)=>`memory-${i}`),metadataRefs=Array.from({length:73},(_,i)=>`evidence-${i}`)
  assert.throws(()=>parseProposals(reviewResponse(memoryRefs,[...metadataRefs,metadataRefs[0],metadataRefs[1]]),{...reviewJob,useHistory:false},memoryRefs,[],0.7),error=>error.message.includes("记忆确认 59/59")&&error.message.includes("原文确认 0/0 条（缺失 0 条，多出 73 个标识）"))
  choose=()=>[]
  modelUsage={input:0,output:0,total:7,cached:0,reasoning:0,source:"reported",inputKnown:true,outputKnown:true,totalKnown:true}
  const retried=await service.retry(malformedFailure.id)
  assert.equal(retried.progress.usage,undefined,"重新分析不显示上一轮用量")
  const zeroUsage=await settle(retried)
  assert.deepEqual(zeroUsage.progress.usage,modelUsage,"上游零值与独立总量不被估算或求和替换")
  modelUsage={input_tokens:123,total_tokens:777,Authorization:"must-not-persist"}
  const partialUsage=await analyze("failure","coverage-user")
  assert.deepEqual(partialUsage.progress.usage,{input:123,output:0,total:777,cached:0,reasoning:0,source:"reported",inputKnown:true,outputKnown:false,totalKnown:true})
  modelUsage=undefined
  const unknownUsage=await analyze("failure","coverage-user")
  assert.equal(unknownUsage.progress.usage.source,"unknown")
  assert.equal(unknownUsage.progress.usage.inputKnown,false)
  modelUsage=reportedUsage
  choose=input=>[{...rewrite(input.memories[0],"越界事实"),sourceIds:[globalFact.id]}]
  const unknownReference=await settle(await service.create("failure","atomic-user"));assert(unknownReference.plan[0].blocked)
  // 精确关联的正常组可单独提交；遗漏、未知引用和重叠操作整组隔离，不能编辑后绕过。
  await message("failure","partial-proof","partial-user","我喜欢阅读科幻小说。")
  await db.run("UPDATE group_memory_messages SET sender_name='示例读者' WHERE id='partial-proof'")
  const partialA=await fact("partial-user","喜欢科幻小说","failure",{evidence:[{sourceEventId:"partial-proof",sourceType:"group-message:failure",messageId:"partial-proof"}]})
  const partialB=await fact("partial-user","爱好科幻小说","failure")
  const partialC=await fact("partial-user","喜欢摄影","failure")
  const beforePartial=await get(partialC.id)
  const partialPlan=await analyze("failure","partial-user",input=>JSON.stringify({
    reviewedIds:[partialA.id,partialB.id,"wrong-identifier"],reviewedMessageIds:[],operations:[
      {kind:"merge",sourceIds:[partialA.id,partialB.id],outputs:[output(input.memories.find(m=>m.id===partialA.id),{memoryIds:[partialA.id,partialB.id]})],reason:"合并同一偏好"},
      rewrite(input.memories.find(m=>m.id===partialC.id),"喜欢自然摄影"),
      {kind:"archive",sourceIds:["wrong-identifier"],outputs:[],reason:"无法精确关联的归档"},
    ],
  }))
  assert.equal(partialPlan.progress.review.memories.matched,2)
  assert.equal(partialPlan.progress.review.memories.missing,1)
  assert.equal(partialPlan.progress.review.memories.unexpected,1)
  assert.equal(partialPlan.progress.analysisComplete,false)
  const normalGroup=partialPlan.plan.find(p=>!p.blocked&&p.kind!=="review"),isolated=partialPlan.plan.filter(p=>p.blocked)
  assert.equal(normalGroup.kind,"merge");assert.equal(isolated.length,3)
  assert(isolated.some(p=>p.before.some(m=>m.id===partialC.id)),"遗漏项可按真实正文单独处理")
  assert(isolated.every(p=>!p.selected&&!p.outputs.length))
  await assert.rejects(service.apply(partialPlan.id,[normalGroup.id,isolated[0].id]),/异常变更/)
  assert.equal((await get(partialA.id)).status,"active","混入异常项时整次提交不写入")
  const proofCalls=calls,proofHistoryCalls=historyCalls
  const proof=await service.evidence(partialPlan.id,partialA.id)
  assert.equal(proof.items[0].text,"我喜欢阅读科幻小说。")
  assert.equal(proof.items[0].senderId,"partial-user")
  assert.equal(calls,proofCalls);assert.equal(historyCalls,proofHistoryCalls)
  await assert.rejects(service.source(partialPlan.id,"partial-proof"),/未开启/)
  await assert.rejects(service.evidence(partialPlan.id,globalFact.id),/本次整理范围/)
  await assert.rejects(service.evidence(partialPlan.id,partialA.id,0),/页码/)
  await assert.rejects(service.evidence(partialPlan.id,partialA.id,"Infinity"),/页码/)
  const partialApplied=await service.apply(partialPlan.id,[normalGroup.id])
  assert.equal(partialApplied.status,"applied");assert.equal(partialApplied.receipt.applied,1)
  assert.deepEqual(await get(partialC.id),beforePartial)
  assert.equal(partialApplied.plan.filter(p=>p.blocked&&!p.resolution).length,3,"提交正常组不会吞掉未处理异常")
  assert.equal((await service.evidence(partialPlan.id,partialA.id)).items[0].text,proof.items[0].text,"归档后仍可核对原件来源")
  const partialKept=await Promise.all(isolated.map(p=>service.keepIssue(partialPlan.id,p.id)))
  assert(partialKept.every(job=>job.status==="applied"))
  const allKept=await service.view(partialPlan.id)
  assert(allKept.plan.filter(p=>p.blocked).every(p=>p.resolution==="kept"),"并发保留异常项不能覆盖其他项决定")
  assert.deepEqual(await get(partialC.id),beforePartial)
  assert.equal((await service.keepIssue(partialPlan.id,isolated[0].id)).status,"applied","保留决定可幂等重试")
  await assert.rejects(service.keepIssue(partialPlan.id,normalGroup.id),/异常项/)
  const partialUndone=await service.undo(partialPlan.id)
  assert.equal(partialUndone.status,"undone");assert.equal((await get(partialA.id)).status,"active")
  assert.deepEqual(await get(partialC.id),beforePartial)
  const overlapA=await fact("overlap-user","喜欢徒步","failure"),overlapB=await fact("overlap-user","喜欢阅读","failure")
  const overlapping=await analyze("failure","overlap-user",input=>[
    rewrite(input.memories.find(m=>m.id===overlapA.id),"爱好徒步"),
    {...rewrite(input.memories.find(m=>m.id===overlapA.id),"常去徒步"),sourceIds:[overlapA.id,"unknown"]},
    rewrite(input.memories.find(m=>m.id===overlapB.id),"爱好阅读"),
  ])
  assert(overlapping.plan.slice(0,2).every(p=>p.blocked&&p.issue.includes("多组变更")))
  assert.equal(overlapping.plan[2].kind,"rewrite");assert(!overlapping.plan[2].blocked)
  await service.apply(overlapping.id,[overlapping.plan[2].id])
  assert.equal((await get(overlapA.id)).status,"active")
  const overlapUndone=await service.undo(overlapping.id)
  assert.equal(overlapUndone.status,"undone")
  await Promise.all(overlapUndone.plan.filter(p=>p.blocked).map(p=>service.keepIssue(overlapping.id,p.id)))
  const overlapHandled=await service.view(overlapping.id)
  assert(overlapHandled.plan.filter(p=>p.blocked).every(p=>p.resolution==="kept"),"撤销正常提交后，异常项仍可独立处理")
  const archivePreview=await analyze("failure","coverage-user",input=>[{kind:"archive",sourceIds:[input.memories[0].id],outputs:[],reason:"请管理员核对是否需要退出召回"}])
  const combined=await fact("split-user","喜欢滑雪，也喜欢游泳","split")
  const split=await analyze("split","split-user",input=>[{kind:"rewrite",sourceIds:[combined.id],outputs:[output(input.memories[0],{text:"喜欢滑雪",factKey:"preference.ski",factValue:"滑雪"}),output(input.memories[0],{text:"喜欢游泳",factKey:"preference.swim",factValue:"游泳"})],reason:"拆为两个可独立更新的偏好"}])
  await assert.rejects(service.apply(split.id,[split.plan[0].id],{[split.plan[0].id]:[split.plan[0].outputs[0]]}),/不能删减/)
  await assert.rejects(service.apply(split.id,[split.plan[0].id],{[split.plan[0].id]:split.plan[0].outputs.map(o=>({...o,scope:"group"}))}),/范围越界/)
  const manual=split.plan[0].outputs.map(o=>({...o,text:o.text+"运动",factValue:o.factValue+"运动"}))
  const splitApplied=await service.apply(split.id,[split.plan[0].id],{[split.plan[0].id]:manual})
  const manualRows=await db.all("SELECT * FROM memory_items WHERE owner_id='split-user' AND status='active'")
  assert.equal(manualRows.length,2);assert(manualRows.every(m=>m.source===`maintenance:${split.id}`&&JSON.parse(m.tags_json).includes("manual-revision")&&m.fact_value.endsWith("运动")))
  await memoryRepository.update(manualRows[0].id,{text:"后续人工更新"})
  await assert.rejects(service.undo(split.id),/后续修改/)
  await memoryRepository.hardDelete(manualRows[1].id)
  await assert.rejects(service.view(split.id),/不存在/)

  const protectedFact=await fact("manual-user","喜欢园艺","manual",{source:"manual"})
  const protectedPlan=await analyze("manual","manual-user",input=>[rewrite(input.memories[0],"喜爱园艺")])
  assert(protectedPlan.plan[0].needsReview&&!protectedPlan.plan[0].selected)
  await service.apply(protectedPlan.id,[protectedPlan.plan[0].id])
  assert.equal((await db.get("SELECT source FROM memory_items WHERE owner_id='manual-user' AND status='active'")).source,"manual-edit")
  assert.equal((await get(protectedFact.id)).status,"archived")
  const expired=await fact("expired-user","临时兴趣","expiry",{expiresAt:Date.now()-100})
  const expiredPlan=await analyze("expiry","expired-user",input=>[rewrite(input.memories[0],"仍然有效的兴趣")])
  await assert.rejects(service.apply(expiredPlan.id,[expiredPlan.plan[0].id]),/已失效/)
  assert.equal((await get(expired.id)).status,"active")
  const scopeFact=await fact("scope-user","喜欢书法","scope",{scope:"user",evidence:[{sourceEventId:"s1",sourceType:"group-message:other",messageId:"s1"}]})
  const move=await analyze("scope","scope-user",input=>[{kind:"move",sourceIds:[scopeFact.id],outputs:[output(input.memories[0],{scope:"user_group"})],reason:"建议核对范围"}])
  assert(move.plan[0].needsReview&&!move.plan[0].selected)
  await service.apply(move.id,[move.plan[0].id])
  assert.equal((await db.get("SELECT group_id FROM memory_items WHERE owner_id='scope-user' AND status='active'")).group_id,"scope")
  await fact("weak-user","曾经喜欢笛子","expiry",{confidence:0.2})
  const weak=await analyze("expiry","weak-user",input=>[{kind:"archive",sourceIds:[input.memories[0].id],outputs:[],reason:"资料陈旧且置信度低"}])
  assert(weak.plan[0].needsReview&&!weak.plan[0].selected,"低置信度或陈旧不构成明确失效依据")
  const collisionA=await fact("proof-user","喜欢星星","g",{evidence:[{sourceEventId:"collision",sourceType:"group-message:g",messageId:"g1"}]})
  const collisionB=await fact("proof-user","喜欢星空","g",{evidence:[{sourceEventId:"collision",sourceType:"group-message:other",messageId:"o1"}]})
  const conflict=await analyze("g","proof-user",input=>[{kind:"merge",sourceIds:[collisionA.id,collisionB.id],outputs:[output(input.memories[0],{memoryIds:[collisionA.id,collisionB.id]})],reason:"合并同一偏好"}])
  await assert.rejects(service.apply(conflict.id,[conflict.plan[0].id]),/不同来源/)
  const legacyTime=await fact("legacy-time-user","喜欢木笛","g")
  await db.run("UPDATE memory_items SET last_confirmed_at=0,updated_at=?,created_at=? WHERE id=?",[originalTime,originalTime,legacyTime.id])
  const timePlan=await analyze("g","legacy-time-user",input=>[rewrite(input.memories[0],"喜欢演奏木笛")])
  await service.apply(timePlan.id,[timePlan.plan[0].id])
  assert.equal((await db.get("SELECT last_confirmed_at FROM memory_items WHERE owner_id='legacy-time-user' AND status='active'")).last_confirmed_at,originalTime,"缺失显式确认时间时沿用原有效时间，不重置为整理时刻")

  // DB 优先，只统计本人的有效发言，排除命令、转发、过期消息。
  await message("history","own1","history-user","我喜欢陶艺。")
  await message("history","other1","someone-else","他喜欢摄影。")
  await message("history","forward1","history-user","转发的别人的喜好",{segments:[{type:"forward"}]})
  await message("history","command1","history-user","#yuihelp",{isCommand:1})
  await message("history","expired1","history-user","过期原文",{expires:Date.now()-1})
  const history=await analyze("history","history-user",input=>[{kind:"add",sourceIds:[],outputs:[{text:"喜欢陶艺",scope:"user",factKey:"preference.ceramics",factValue:"陶艺",memoryIds:[],messageIds:[input.history[0].id],confidence:0.85,expiresAt:0}],reason:"本人直接陈述"}],{useHistory:true,count:1})
  assert.equal(historyCalls,0)
  assert.equal(history.progress.messageCount,1)
  assert.equal(inputs.at(-1).history[0].id,"own1")
  assert.equal((await service.source(history.id,"own1")).text,"我喜欢陶艺。")
  await assert.rejects(service.source(history.id,"other1"),/范围/)
  await service.apply(history.id,[history.plan[0].id])
  const newFact=await db.get("SELECT * FROM memory_items WHERE owner_id='history-user'")
  assert.equal(newFact.last_confirmed_at,(await db.get("SELECT sent_at FROM group_memory_messages WHERE id='own1'")).sent_at)
  assert.equal((await db.get("SELECT source_event_id FROM memory_evidence WHERE memory_id=?",[newFact.id])).source_event_id,"own1")
  const repeat=await analyze("history","history-user",input=>[{kind:"reinforce",sourceIds:[input.memories[0].id],outputs:[output(input.memories[0],{messageIds:["own1"],confidence:0.99})],reason:"重复引用旧原文"}],{useHistory:true,count:1})
  await assert.rejects(service.apply(repeat.id,[repeat.plan[0].id]),/重复强化/)
  await message("history","own2","history-user","我现在仍喜欢陶艺。",{at:Date.now()})
  const reinforce=await analyze("history","history-user",input=>[{kind:"reinforce",sourceIds:[input.memories[0].id],outputs:[output(input.memories[0],{messageIds:["own2"],confidence:0.9})],reason:"本人再次确认相同事实"}],{useHistory:true,count:2})
  await service.apply(reinforce.id,[reinforce.plan[0].id])
  assert.equal((await get(newFact.id)).confidence,0.9)
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM memory_evidence WHERE memory_id=?",[newFact.id])).n,2)
  await message("history","soon-expired","expiry-history-user","喜欢木雕")
  const expiringHistory=await analyze("history","expiry-history-user",input=>[{kind:"add",sourceIds:[],outputs:[{text:"喜欢木雕",scope:"user",factKey:"preference.wood",factValue:"木雕",memoryIds:[],messageIds:[input.history[0].id],confidence:0.85,expiresAt:0}],reason:"本人直接陈述"}],{useHistory:true,count:1})
  await db.run("UPDATE group_memory_messages SET expires_at=? WHERE id='soon-expired'",[Date.now()-1])
  assert.equal((await service.source(expiringHistory.id,"soon-expired")).available,false)
  await assert.rejects(service.apply(expiringHistory.id,[expiringHistory.plan[0].id]),/过期/)
  assert.equal((await service.view(expiringHistory.id)).status,"stale")
  await assert.rejects(service.create("history","history-user",{useHistory:true,count:2001}),/1至2000/)
  await assert.rejects(service.create("history","history-user",{useHistory:"true"}),/布尔/)
  await message("history","corrected-meta","metadata-user","喜欢陶笛")
  const metadata=await analyze("history","metadata-user",()=>[],{useHistory:true,count:1})
  await db.run("UPDATE group_memory_messages SET sent_at=sent_at+1 WHERE id='corrected-meta'")
  await assert.rejects(service.source(metadata.id,"corrected-meta"),/不存在/,"更正原文作者或时间也必须使旧依据失效")
  await capture.setPolicy("group","history",{enabled:false})
  await assert.rejects(service.create("history","history-user",{useHistory:true}),/已授权/)
  await analyze("history","history-user")
  await capture.setPolicy("group","history",{enabled:true})

  await message("backfill","stored","backfill-user","喜欢短篇小说")
  const policyBefore=await db.get("SELECT last_daily_end FROM group_memory_policies WHERE group_id='backfill'")
  global.Bot.pickGroup=()=>({getChatHistory:async()=>{
    historyCalls++
    return [{message_id:"wrong-group-own",group_id:"other",user_id:"backfill-user",time:Math.floor(Date.now()/1000)-30,raw_message:"其他群本人的消息"},{message_id:"new-own",user_id:"backfill-user",time:Math.floor(Date.now()/1000)-60,raw_message:"也喜欢诗歌",sender:{nickname:"旧昵称"}},...Array.from({length:5},(_,i)=>({message_id:`new-other${i}`,user_id:"other-person",time:Math.floor(Date.now()/1000)-100-i,raw_message:"其他成员发言"}))]
  }})
  const supplemented=await analyze("backfill","backfill-user",()=>[],{useHistory:true,count:2})
  assert.equal(historyCalls,1)
  assert.equal(supplemented.progress.databaseCount,1);assert.equal(supplemented.progress.historyCount,1)
  assert.equal(supplemented.progress.messageCount,2);assert(supplemented.progress.historyComplete)
  assert(inputs.at(-1).history.every(m=>m.author==="backfill-user"))
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM group_memory_messages WHERE message_id='wrong-group-own'")).n,0)
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM group_memory_extraction_jobs WHERE group_id='backfill'")).n,0)
  assert.equal((await db.get("SELECT last_daily_end FROM group_memory_policies WHERE group_id='backfill'")).last_daily_end,policyBefore.last_daily_end)
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM memory_items WHERE owner_id='backfill-user'")).n,0,"历史补录不能同步旧身份或自动提炼")
  await analyze("backfill","backfill-user",()=>[],{useHistory:true,count:2})
  assert.equal(historyCalls,1,"数据库足量后不再补历史")

  await message("public-backfill","public-stored-a","public-a","群活动在周末")
  await message("public-backfill","public-stored-b","public-b","周末有空")
  global.Bot.pickGroup=groupId=>{
    assert.equal(groupId,"public-backfill")
    return {getChatHistory:async()=>{
      historyCalls++
      return [...["public-a","public-b","public-c"].map((user_id,i)=>({message_id:`public-page${i}`,group_id:"public-backfill",user_id,time:Math.floor(Date.now()/1000)-60-i,raw_message:"本群活动安排"})),{message_id:"wrong-group-public",group_id:"other",user_id:"outsider",time:Math.floor(Date.now()/1000)-30,raw_message:"其他群的活动安排"}]
    }}
  }
  const publicBackfill=await analyze("public-backfill","",input=>{
    assert.equal(input.target.scope,"group")
    assert.equal(input.history.length,5)
    assert.deepEqual(new Set(input.history.map(m=>m.author)),new Set(["public-a","public-b","public-c"]))
    return []
  },{useHistory:true,count:5})
  assert.equal(historyCalls,2)
  assert.equal(publicBackfill.progress.databaseCount,2);assert.equal(publicBackfill.progress.historyCount,3)
  assert(publicBackfill.progress.historyComplete)
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM group_memory_messages WHERE message_id='wrong-group-public'")).n,0)

  // 跨群和跨实例共用同一人的运行预留；取消后的迟到模型结果不能写成可应用预览。
  await fact("race-user","喜欢建筑","race",{scope:"user"})
  let release,entered
  choose=async()=>{entered=true;await new Promise(r=>{release=r});return []}
  const running=await service.create("race","race-user")
  for(let i=0;!entered&&i<100;i++)await new Promise(r=>setTimeout(r,10))
  assert(entered)
  const separate=new MemoryMaintenance(model)
  await assert.rejects(separate.create("other","race-user"),/已有整理任务/)
  assert.equal((await separate.view(running.id)).status,"analyzing")
  const queued=await service.create("race","queued-user",{useHistory:true,count:1})
  assert.equal((await service.view(queued.id)).status,"queued")
  await assert.rejects(service.source(queued.id,"not-yet"),error=>error.statusCode===404,"尚未读取资料时不暴露未授权原文")
  await service.cancel(queued.id)
  const requeued=await service.retry(queued.id)
  assert.equal(requeued.status,"queued","等待中的取消立即释放队列预留，允许重试")
  await service.cancel(requeued.id)
  await service.cancel(running.id)
  await assert.rejects(service.retry(running.id),/正在停止/)
  release()
  await new Promise(r=>setTimeout(r,30))
  assert.equal((await service.view(running.id)).status,"cancelled")
  choose=()=>[]
  await settle(await service.retry(running.id))

  // 清理、撤回和自然过期的区别；清理后迟到的历史页不再落盘。
  await fact("clear-user","喜欢阅读","clear")
  const clean=await analyze("clear","clear-user",input=>[rewrite(input.memories[0],"喜欢阅读书籍")])
  await capture.clear("group","clear","raw")
  await assert.rejects(service.apply(clean.id,[clean.plan[0].id]),/不存在/)
  await fact("clear-derived","喜欢昆虫","clear",{scope:"user",evidence:[{sourceEventId:"clear-proof",sourceType:"group-message:clear",messageId:"clear-proof"}]})
  const derived=await analyze("clear","clear-derived",input=>[rewrite(input.memories[0],"爱好昆虫观察")])
  await service.apply(derived.id,[derived.plan[0].id])
  await capture.clear("group","clear","derived")
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM memory_items WHERE owner_id='clear-derived'")).n,0,"仅来自已清理群的全局派生结果和归档原件均须清理")
  await assert.rejects(service.undo(derived.id),/不存在/)
  await db.run("DELETE FROM group_memory_messages WHERE id='own1'")
  await assert.rejects(service.undo(history.id),/不存在/)
  const noHistory=await analyze("g","merge-user")
  await message("g","natural-expiry","merge-user","自然到期",{expires:Date.now()-1})
  await capture.cleanupExpired()
  assert.equal((await service.view(noHistory.id)).status,"ready")
  let finishHistory,historyEntered=false
  global.Bot.pickGroup=()=>({getChatHistory:async()=>{historyEntered=true;return new Promise(r=>{finishHistory=r})}})
  choose=()=>[]
  const pending=await service.create("cancel","cancel-user",{useHistory:true,count:2})
  for(let i=0;!historyEntered&&i<100;i++)await new Promise(r=>setTimeout(r,10))
  assert(historyEntered)
  await service.cancel(pending.id)
  finishHistory([{message_id:"late",user_id:"cancel-user",time:Date.now()/1000,raw_message:"不应落盘"}])
  await new Promise(r=>setTimeout(r,30))
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM group_memory_messages WHERE group_id='cancel'")).n,0)
  assert.equal((await service.view(pending.id)).status,"cancelled")

  // 全群按成员独立建任务，公共事实单独一项；已有任务仅影响该成员。
  await fact("batch-a","喜欢音乐","batch")
  await fact("batch-b","喜欢漫画","batch")
  await fact("batch","群活动在周末","batch",{scope:"group"})
  let unblock
  choose=async()=>{await new Promise(r=>{unblock=r});return []}
  const busyMember=await service.create("batch","batch-a")
  for(let i=0;!unblock&&i<100;i++)await new Promise(r=>setTimeout(r,10))
  const batch=await service.group("batch",{})
  assert.equal(batch.total,3);assert.equal(batch.jobs.length,2);assert.equal(batch.failures[0].userId,"batch-a")
  choose=()=>[];unblock()
  await settle(busyMember)
  for(const j of batch.jobs)await settle(j)
  assert(batch.jobs.some(j=>!j.userId)&&batch.jobs.some(j=>j.userId==="batch-b"))
  await assert.rejects(service.group("batch",{useHistory:"true"}),/布尔/)

  // 输入预算/配置错误明确失败，不能把部分建议开放应用，也不会泄漏供应商错误。
  await fact("failure-user","喜欢琵琶","failure")
  choose=()=>{throw Object.assign(new Error("upstream secret Authorization should-not-leak"),{statusCode:429})}
  const failed=await settle(await service.create("failure","failure-user"),"failed")
  assert(!failed.error.includes("Authorization")&&!failed.error.includes("should-not-leak"))
  await capture.setPolicy("group","budget",{tokenLimit:3000,overrides:{tokenLimit:true}})
  await message("budget","oversized","budget-user","很长的完整原文".repeat(2000))
  choose=()=>[]
  const beforeBudget=calls
  const budget=await settle(await service.create("budget","budget-user",{useHistory:true,count:1}),"failed")
  assert(budget.error.includes("超过本群输入上限"));assert.equal(calls,beforeBudget)
  await db.run("UPDATE memory_maintenance_jobs SET expires_at=? WHERE id=?",[Date.now()-1,failed.id])
  await assert.rejects(service.retry(failed.id),/保留期限/)
  await capture.cleanupExpired()
  await assert.rejects(service.view(failed.id),/不存在/)

  // 人工修订保留派生来源，后续本人否定和清理来源群都能处理这些结果。
  for(const group of ["revised","retained","one-scan","large-input"])await capture.setPolicy("group",group,{enabled:true,tokenLimit:60000,overrides:{tokenLimit:true}})
  await fact("revised-user","喜欢天文","revised",{scope:"user",factKey:"preference.astronomy",factValue:"天文",evidence:[{sourceEventId:"revised-proof",sourceType:"group-message:revised",messageId:"revised-proof"}]})
  const revised=await analyze("revised","revised-user",input=>[rewrite(input.memories[0],"喜欢研究天文")])
  await service.apply(revised.id,[revised.plan[0].id],{[revised.plan[0].id]:revised.plan[0].outputs.map(o=>({...o,text:"喜欢观测星空",factValue:"天文"}))})
  const revisedRow=await db.get("SELECT * FROM memory_items WHERE owner_id='revised-user' AND status='active'")
  assert.equal(revisedRow.source,`maintenance:${revised.id}`)
  assert(JSON.parse(revisedRow.tags_json).includes("manual-revision"))
  const retracted=await capture.applyCandidates({id:"revised-retract",group_id:"revised"},[{id:"revised-denial",message_id:"revised-denial",sender_id:"revised-user",sent_at:Date.now()}],[{operation:"retract",scope:"user",subjectId:"revised-user",speakerId:"revised-user",factKey:"preference.astronomy",factValue:"天文",text:"用户不再喜欢天文",confidence:0.9,evidenceMessageIds:["revised-denial"]}])
  assert.equal(retracted[0].action,"retracted")
  await capture.clear("group","revised","derived")
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM memory_items WHERE owner_id='revised-user'")).n,0)

  // 范围迁移和编辑结果都不能制造单值冲突；多值偏好可以并存，关联重写可一起解决旧冲突。
  const moving=await fact("conflict-user","用户自述为男性","scope",{scope:"user",factKey:"identity.gender",factValue:"male"})
  const targetFact=await fact("conflict-user","用户自述为女性","scope",{factKey:"identity.gender",factValue:"female"})
  const conflicting=await analyze("scope","conflict-user",input=>[{kind:"move",sourceIds:[moving.id],outputs:[output(input.memories.find(m=>m.id===moving.id),{scope:"user_group"})],reason:"核对适用范围"}])
  await assert.rejects(service.apply(conflicting.id,[conflicting.plan[0].id]),/单值事实的冲突/)
  assert.equal((await get(moving.id)).status,"active");assert.equal((await get(targetFact.id)).status,"active")
  const resolved=await analyze("scope","conflict-user",input=>[{kind:"merge",sourceIds:[moving.id,targetFact.id],outputs:[output(input.memories.find(m=>m.id===moving.id),{scope:"user_group",memoryIds:[moving.id,targetFact.id]})],reason:"同时审核并修正冲突"}])
  await service.apply(resolved.id,[resolved.plan[0].id])
  await fact("multi-user","喜欢咖啡","g",{factKey:"preference.drink",factValue:"coffee"})
  await fact("multi-user","喜欢茶","g",{factKey:"preference.drink",factValue:"tea"})
  const multi=await analyze("g","multi-user",input=>[rewrite(input.memories.find(m=>m.factValue==="coffee"),"喜欢手冲咖啡")])
  await service.apply(multi.id,[multi.plan[0].id])
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM memory_items WHERE owner_id='multi-user' AND status='active'")).n,2)

  // 无关记忆新增不阻止撤销，恢复会制造冲突时仍拒绝。
  await fact("undo-unrelated","喜欢口琴","g")
  const unrelated=await analyze("g","undo-unrelated",input=>[rewrite(input.memories[0],"喜欢演奏口琴")])
  await service.apply(unrelated.id,[unrelated.plan[0].id])
  const unrelatedAdded=await fact("undo-unrelated","喜欢徒步","g")
  assert.equal((await service.undo(unrelated.id)).status,"undone")
  assert.equal((await get(unrelatedAdded.id)).status,"active")
  const beforeUndo=await fact("undo-conflict","用户自述职业为教师","g",{factKey:"profile.occupation",factValue:"teacher"})
  const undoConflict=await analyze("g","undo-conflict",input=>[rewrite(input.memories[0],"用户从事教学")])
  await service.apply(undoConflict.id,[undoConflict.plan[0].id])
  await fact("undo-conflict","用户自述职业为工程师","g",{factKey:"profile.occupation",factValue:"engineer"})
  await assert.rejects(service.undo(undoConflict.id),/单值事实的冲突/)
  assert.equal((await get(beforeUndo.id)).status,"archived")
  const duplicate1=await fact("undo-duplicates","喜欢咖啡","g",{factKey:"preference.coffee",factValue:"coffee"})
  const duplicate2=await fact("undo-duplicates","爱好咖啡","g",{factKey:"preference.coffee",factValue:"coffee"})
  const duplicateMerge=await analyze("g","undo-duplicates",input=>[{kind:"merge",sourceIds:[duplicate1.id,duplicate2.id],outputs:[output(input.memories[0],{memoryIds:[duplicate1.id,duplicate2.id]})],reason:"合并相同键值的重复记录"}])
  await service.apply(duplicateMerge.id,[duplicateMerge.plan[0].id])
  assert.equal((await service.undo(duplicateMerge.id)).status,"undone","撤销可以恢复合并前本来重复的两条记录")
  await fact("undo-race","喜欢陶艺","g")
  const undoRace=await analyze("g","undo-race",input=>[rewrite(input.memories[0],"爱好陶艺")])
  await service.apply(undoRace.id,[undoRace.plan[0].id])
  const raceResult=await db.get("SELECT id FROM memory_items WHERE source=? AND status='active'",[`maintenance:${undoRace.id}`])
  const originalTransaction=db.transaction
  let injectedUndoRace=false
  db.transaction=async function(operations,...args){
    if(!injectedUndoRace&&operations.some(op=>op.sql.includes("status='undone'"))) {
      injectedUndoRace=true
      await db.run("UPDATE memory_items SET text='撤销检查后发生的新编辑' WHERE id=?",[raceResult.id])
    }
    return originalTransaction.call(this,operations,...args)
  }
  try{await assert.rejects(service.undo(undoRace.id),/资料版本已变化/)}finally{db.transaction=originalTransaction}
  assert.equal((await get(raceResult.id)).text,"撤销检查后发生的新编辑")
  assert.equal((await service.view(undoRace.id)).status,"applied","并发冲突整次回滚，回执仍为已应用")

  // 到期清理只删无引用原文，保持记忆、来源可读性和整理预览；解除引用后可清理。
  await message("retained","retained-proof","retained-user","本人喜欢陶笛",{expires:Date.now()-1})
  await message("retained","unused-expired","someone","无用的到期消息",{expires:Date.now()-1})
  const retainedFact=await fact("retained-user","喜欢陶笛","retained",{evidence:[{sourceEventId:"retained-proof",sourceType:"group-message:retained",messageId:"retained-proof"}]})
  const retainedPreview=await analyze("retained","retained-user")
  const retainedBefore=await get(retainedFact.id)
  await capture.cleanupExpired()
  assert(await db.get("SELECT id FROM group_memory_messages WHERE id='retained-proof'"))
  assert.equal(await db.get("SELECT id FROM group_memory_messages WHERE id='unused-expired'"),undefined)
  assert.deepEqual(await get(retainedFact.id),retainedBefore)
  assert.equal((await service.view(retainedPreview.id)).status,"ready")
  assert.equal((await memoryRepository.listEvidence(retainedFact.id)).items[0].available,true)
  await memoryRepository.hardDelete(retainedFact.id)
  await capture.cleanupExpired()
  assert.equal(await db.get("SELECT id FROM group_memory_messages WHERE id='retained-proof'"),undefined)

  // 单条无关原文删除不移除预览或已应用回执；被引用原文删除仍会移除。
  await message("retained","target-proof","target-user","喜欢木工")
  await message("retained","unrelated-proof","unrelated-user","天气不错")
  const referenced=await analyze("retained","target-user",input=>[{kind:"add",sourceIds:[],outputs:[{text:"喜欢木工",scope:"user",factKey:"preference.woodwork",factValue:"木工",memoryIds:[],messageIds:[input.history[0].id],confidence:0.9,expiresAt:0}],reason:"本人自述"}],{useHistory:true,count:1})
  await db.run("DELETE FROM group_memory_messages WHERE id='unrelated-proof'")
  assert.equal((await service.view(referenced.id)).status,"ready")
  await service.apply(referenced.id,[referenced.plan[0].id])
  await message("retained","another-unrelated","unrelated-user","准备出门")
  await db.run("DELETE FROM group_memory_messages WHERE id='another-unrelated'")
  assert.equal((await service.view(referenced.id)).status,"applied")
  await db.run("DELETE FROM group_memory_messages WHERE id='target-proof'")
  await assert.rejects(service.view(referenced.id),/不存在/)
  await message("retained","natural-linked","natural-user","喜欢笛子",{expires:Date.now()+60000})
  await fact("natural-user","喜欢笛子","retained",{evidence:[{sourceEventId:"natural-linked",sourceType:"group-message:retained",messageId:"natural-linked"}]})
  const natural=await analyze("retained","natural-user",input=>[rewrite(input.memories[0],"爱好笛子")],{useHistory:true,count:1})
  await service.apply(natural.id,[natural.plan[0].id])
  const realNow=Date.now
  Date.now=()=>realNow()+120000
  try {
    await capture.cleanupExpired()
    assert.equal((await service.source(natural.id,"natural-linked")).available,true,"自然到期且仍有关联记忆的原文继续可读")
    assert.equal((await service.undo(natural.id)).status,"undone","原文自然到期不阻止未变化记忆的撤销")
  } finally {Date.now=realNow}

  // 仅从最早已存消息向前扫描一轮1000条（宿主按200条分页）；不足也只分析一次。
  const oldestAt=Date.now()-600000
  await message("one-scan","oldest-stored","scan-user","本地发言",{at:oldestAt})
  let scanPages=0
  global.Bot.pickGroup=()=>({getChatHistory:async(cursor,count)=>{
    assert.equal(cursor,scanPages?`scan-page${scanPages-1}-199`:"oldest-stored")
    assert.equal(count,200)
    const page=scanPages++
    return Array.from({length:200},(_,i)=>({message_id:`scan-page${page}-${i}`,user_id:i===0?"scan-user":"other-scanned",time:Math.floor(oldestAt/1000)-page*200-i-1,raw_message:"历史发言"}))
  }})
  const scanModelStart=calls
  const scanned=await analyze("one-scan","scan-user",()=>[],{useHistory:true,count:20})
  assert.equal(scanPages,5);assert.equal(scanned.progress.historyScanned,1000)
  assert.equal(scanned.progress.historyCursor,"oldest-stored")
  assert.equal(scanned.progress.messageCount,6);assert.equal(scanned.progress.historyComplete,false)
  assert.equal(calls-scanModelStart,1)
  const dbEnoughStart=calls
  await analyze("one-scan","scan-user",()=>[],{useHistory:true,count:2})
  assert.equal(scanPages,5);assert.equal(calls-dbEnoughStart,1)
  await capture.setPolicy("group","large-input",{tokenLimit:5000,overrides:{tokenLimit:true}})
  for(let i=0;i<12;i++)await message("large-input",`long-${i}`,"long-user","完整的文学阅读经历".repeat(200))
  choose=()=>[]
  const largeBefore=calls
  const tooLarge=await settle(await service.create("large-input","long-user",{useHistory:true,count:12}),"failed")
  assert(tooLarge.error.includes("超过本群输入上限"));assert.equal(calls,largeBefore,"整份资料预算不足时零模型调用，不拆批次")

  // 大预算可保存到群配置，完整输入超过旧6万限制仍一次发送，10万输出原样传递。
  const expandedPolicy=await capture.setPolicy("group","expanded-budget",{enabled:true,tokenLimit:1000000,maxTokens:100000,overrides:{tokenLimit:true,maxTokens:true}})
  assert.equal(expandedPolicy.tokenLimit,1000000)
  assert.equal(expandedPolicy.maxTokens,100000)
  assert.equal((await db.get("SELECT token_limit,max_tokens FROM group_memory_policies WHERE group_id='expanded-budget'")).token_limit,1000000)
  const inheritedPolicy=await capture.setPolicy("group","inherited-budget",{enabled:true})
  assert.equal(inheritedPolicy.tokenLimit,200000)
  assert.equal(inheritedPolicy.maxTokens,100000)
  for(let i=0;i<40;i++)await message("expanded-budget",`expanded-${i}`,"expanded-user","阅读和旅行的完整经历".repeat(400))
  const expandedStart=calls
  const expanded=await analyze("expanded-budget","expanded-user",(_input,options)=>{assert.equal(options.maxTokens,100000);return []},{useHistory:true,count:40})
  assert(expanded.progress.inputTokens>60000)
  assert.equal(expanded.progress.tokenLimit,1000000)
  assert.equal(calls-expandedStart,1)

  // 整理正文和值均不按敏感内容筛查；格式、对象和证据校验保持。
  await fact("unfiltered-user","喜欢研究token预算","g")
  const unfiltered=await analyze("g","unfiltered-user",input=>[{...rewrite(input.memories[0],"喜欢研究API key与token预算"),outputs:[output(input.memories[0],{text:"喜欢研究API key与token预算",factValue:"密码 TEST_ONLY"})]}])
  await service.apply(unfiltered.id,[unfiltered.plan[0].id])
  assert.equal((await db.get("SELECT fact_value FROM memory_items WHERE owner_id='unfiltered-user' AND status='active'")).fact_value,"密码 TEST_ONLY")

  await configStore.update(c=>{c.memory.enabled=false})
  await assert.rejects(service.create("g","any"),/已关闭/)
  assert.equal((await service.apply(protectedPlan.id,[protectedPlan.plan[0].id])).status,"applied","停用写入不影响已提交请求的幂等回执")
  await configStore.update(c=>{c.memory.enabled=true})

  // 真实路由中间件：所有入口都鉴权；GET 无模型调用，Token 不能从 URL/正文进入。
  const {registerMemoryMaintenanceRoutes}=await import("../output/runtime/web/http/routes/knowledge/memory-maintenance.js")
  const {issueWebAccessToken}=await import("../output/runtime/web/http/auth.js")
  const routes=[]
  const app={get:(p,...h)=>routes.push({method:"GET",p,h}),post:(p,...h)=>routes.push({method:"POST",p,h})}
  registerMemoryMaintenanceRoutes(app,service)
  const token=issueWebAccessToken("admin").token
  async function invoke(route,{headers={},body={},query={},params={}}={}) {
    const req={method:route.method,headers,body,query,params}
    const res={code:200,headers:{},status(n){this.code=n;return this},set(key,v){this.headers[key]=v;return this},json(value){this.body=value;return this},append(){}}
    const next=async i=>{if(route.h[i])await route.h[i](req,res,()=>next(i+1))}
    await next(0);return res
  }
  for(const route of routes)assert.equal((await invoke(route,{query:{token},body:{token}})).code,401)
  const evidenceRoute=routes.find(r=>r.p.endsWith("/memories/:memoryId/evidence"))
  const evidenceResponse=await invoke(evidenceRoute,{headers:{"yui-chat-token":token},params:{id:partialPlan.id,memoryId:partialA.id}})
  assert.equal(evidenceResponse.code,200);assert.equal(evidenceResponse.headers["Cache-Control"],"no-store")
  assert.equal(evidenceResponse.body.evidence.items[0].text,proof.items[0].text)
  assert.equal((await invoke(evidenceRoute,{headers:{"yui-chat-token":token},params:{id:partialPlan.id,memoryId:globalFact.id}})).code,404)
  const keepRoute=routes.find(r=>r.p.endsWith("/issues/:issueId/keep"))
  assert.equal((await invoke(keepRoute,{headers:{"yui-chat-token":token},params:{id:coverageFailure.id,issueId:coverageFailure.plan[0].id}})).code,200)
  assert.equal((await invoke(keepRoute,{headers:{"yui-chat-token":token},params:{id:coverageFailure.id,issueId:normalGroup.id}})).code,404)
  const getRoute=routes.find(r=>r.p.endsWith("/jobs/:id")&&r.method==="GET")
  const callsBefore=calls
  const read=await invoke(getRoute,{headers:{"yui-chat-token":token},params:{id:noHistory.id}})
  assert.equal(read.code,200);assert.equal(read.headers["Cache-Control"],"no-store");assert.equal(calls,callsBefore)
  const protectedPost=routes.find(r=>r.p.endsWith("/apply"))
  assert.equal((await invoke(protectedPost,{headers:{cookie:`yui_chat_session=${token}`,origin:"https://outside.example",host:"localhost"},params:{id:noHistory.id},body:{selectedIds:[]}})).code,401)
  const spoof=await invoke(protectedPost,{headers:{"yui-chat-token":token},params:{id:noHistory.id},body:{selectedIds:["fake"],userId:"another"}})
  assert.equal(spoof.code,400)
  choose=()=>[]
  const publicRoute=routes.find(r=>r.method==="POST"&&r.p.endsWith("/public"))
  const publicResponse=await invoke(publicRoute,{headers:{"yui-chat-token":token},params:{groupId:"history-scope"},body:{useHistory:true,count:3,userId:"scope-b"}})
  assert.equal(publicResponse.code,200)
  assert.equal(publicResponse.body.job.userId,"","群公共入口不能由正文伪造为个人任务")
  await settle(publicResponse.body.job)
  assert.equal(inputs.at(-1).target.scope,"group")
  assert.equal(inputs.at(-1).history.length,3)

  // 结束审阅只记录处理时间；不修改任何记忆，幂等且不能再应用。
  const dismissFact=await fact("dismiss-user","喜欢观察树木","g")
  const dismissPlan=await analyze("g","dismiss-user",input=>[rewrite(input.memories[0],"喜欢观察和辨认树木")])
  const dismissBefore=await get(dismissFact.id)
  const closed=await service.dismiss(dismissPlan.id)
  assert(closed.reviewedAt>0)
  assert.equal((await service.dismiss(dismissPlan.id)).reviewedAt,closed.reviewedAt)
  assert.deepEqual(await get(dismissFact.id),dismissBefore)
  await assert.rejects(service.apply(dismissPlan.id,[dismissPlan.plan[0].id]),/审阅已结束/)
  const reviewOnly=await analyze("g","dismiss-user",input=>[{kind:"review",sourceIds:[input.memories[0].id],outputs:[],reason:"缺少原文，保留现状"}])
  const dismissRoute=routes.find(r=>r.p.endsWith("/dismiss"))
  const closedReview=await invoke(dismissRoute,{headers:{"yui-chat-token":token},params:{id:reviewOnly.id}})
  assert.equal(closedReview.code,200);assert(closedReview.body.job.reviewedAt>0)
  assert.deepEqual(await get(dismissFact.id),dismissBefore)
  await assert.rejects(service.dismiss(applied.id),/只有已完成分析/)

  // 应用已经读到预览后，另一个窗口选择保留原样：最终条件写入失败应整批回滚。
  const dismissRace=await analyze("g","dismiss-user",input=>[rewrite(input.memories[0],"爱好辨认树种")])
  const beforeDismissRace=await get(dismissFact.id),raceTransaction=db.transaction
  let injectedDismiss=false
  db.transaction=async function(operations,...args){
    if(!injectedDismiss&&operations.some(op=>op.sql.includes("status='applied'")&&op.params.includes(dismissRace.id))){injectedDismiss=true;await service.dismiss(dismissRace.id)}
    return raceTransaction.call(this,operations,...args)
  }
  try{await assert.rejects(service.apply(dismissRace.id,[dismissRace.plan[0].id]),/审阅已结束/)}finally{db.transaction=raceTransaction}
  assert(injectedDismiss)
  assert.deepEqual(await get(dismissFact.id),beforeDismissRace)
  assert.equal((await service.view(dismissRace.id)).status,"ready")
  assert((await service.view(dismissRace.id)).reviewedAt>0)

  // 真实 Vue 模板编译、任务分流、审阅及创建交互。
  global.location={pathname:"/yui-chat",hash:"",search:""}
  global.localStorage={getItem(){return null}}
  const {compile,createSSRApp,createRenderer,h,nextTick}=await import("vue")
  const {renderToString}=await import("vue/server-renderer")
  const clientModule=new URL("../output/runtime/web/client/features/memory/memory-maintenance.js",import.meta.url)
  const {MemoryMaintenanceDialog,maintenanceTaskState}=await import(clientModule.href)
  const {MemoryMaintenanceReview}=await import("../output/runtime/web/client/features/memory/memory-maintenance-review.js")
  const {MemoryMaintenanceWorkspace}=await import("../output/runtime/web/client/features/memory/memory-maintenance-workspace.js")
  for(const component of [MemoryMaintenanceDialog,MemoryMaintenanceReview,MemoryMaintenanceWorkspace]){
    const errors=[]
    compile(component.template,{onError:e=>errors.push(e.message),onWarn(){}})
    assert.deepEqual(errors,[],component.name)
  }
  const {components}=await import("../output/runtime/web/client/ui/components.js")
  async function renderReview(job,{activeId="",evidence={}}={}){
    const component={...MemoryMaintenanceReview,setup(props,ctx){const state=MemoryMaintenanceReview.setup(props,ctx);state.activeId.value=activeId;Object.assign(state.evidence,evidence);return state}}
    const app=createSSRApp(component,{job,name:"示例成员"})
    for(const [name,component] of Object.entries(components))app.component(name,component)
    const ctx={},html=await renderToString(app,ctx)
    return html+Object.values(ctx.teleports||{}).join("")
  }
  const clientReady={...plan,status:"ready",reviewedAt:0}
  const mixed={...clientReady,plan:[...plan.plan,...reviewOnly.plan]}
  const rendered=await renderReview(mixed)
  assert(rendered.includes("合并重复")&&rendered.includes("未参考聊天原文"))
  assert(rendered.includes("仅供核对")&&rendered.includes("可应用变更"))
  assert.equal((rendered.match(/type="checkbox"/g)||[]).length,plan.plan.length,"提示项不能显示禁用勾选框")
  const onlyNotes=await renderReview({...reviewOnly,reviewedAt:0})
  assert(onlyNotes.includes("仅供核对，不会修改记忆")&&onlyNotes.includes("保留原样，结束审阅")&&onlyNotes.includes("前往对应记忆页"))
  assert(!onlyNotes.includes('type="checkbox"')&&!onlyNotes.includes("提交已选的"))
  const noChanges=await renderReview({...clientReady,plan:[]})
  assert(noChanges.includes("分析完成，无需变更")&&!noChanges.includes("提交已选的"))
  const readOnly=await renderReview({...clientReady,reviewedAt:Date.now()})
  assert(readOnly.includes("已保留原样")&&!readOnly.includes('type="checkbox"')&&!readOnly.includes("提交已选的"))
  for(const job of [clientReady,coverageFailure]){
    const html=await renderReview(job)
    assert(html.includes(`预计输入 ${job.progress.inputTokens} / ${job.progress.tokenLimit} Token`))
    assert(html.includes("本次用量：输入 11618（上游），输出 3279（上游），合计 14897（上游） Token。"),"成功和校验失败任务均展示上游用量")
  }
  const failedReview=await renderReview(coverageFailure)
  assert(failedReview.includes("原文确认 0/0 条（缺失 0 条，多出 1 个标识）"))
  assert(!failedReview.includes("提交已选的"))
  assert((await renderReview(zeroUsage)).includes("输入 0（上游），输出 0（上游），合计 7（上游）"))
  assert((await renderReview(partialUsage)).includes("输入 123（上游），输出 未提供，合计 777（上游）"))
  assert((await renderReview(unknownUsage)).includes("输入 未提供，输出 未提供，合计 未提供"))
  assert(!(await renderReview({...clientReady,progress:{inputTokens:7817,tokenLimit:200000}})).includes("本次用量"),"旧任务不虚构实际用量")
  assert((await renderReview({...clientReady,progress:{usage:{input:10,output:20,total:30,source:"estimated"}}})).includes("输入 10（估算），输出 20（估算），合计 30（估算）"))
  const partialHtml=await renderReview(partialPlan)
  assert(partialHtml.includes("部分内容需要你单独处理")&&partialHtml.includes("处理前")&&partialHtml.includes("处理后"))
  assert.equal((partialHtml.match(/type="checkbox"/g)||[]).length,1,"异常项不能进入选择列表")
  assert(partialHtml.includes("2 条原件 → 1 条结果"))
  assert(!partialHtml.includes(partialA.id)&&!partialHtml.includes("group-message:"),"管理员看到正文，不展示内部来源编号")
  const readableProof=await renderReview(partialPlan,{evidence:{[partialA.id]:{...proof,loaded:true,loading:false}}})
  assert(readableProof.includes("我喜欢阅读科幻小说。")&&readableProof.includes("示例读者"))
  assert(!readableProof.includes("partial-proof")&&!readableProof.includes(partialA.id))
  const missingPreview=await renderReview(partialPlan,{activeId:isolated.find(p=>p.before.some(m=>m.id===partialC.id)).id})
  assert(missingPreview.includes("喜欢摄影")&&missingPreview.includes("这项保留原样")&&missingPreview.includes("单独查看 / 编辑这条记忆"))
  const archiveHtml=await renderReview(archivePreview)
  assert(archiveHtml.includes("1 条原件将移入归档")&&archiveHtml.includes("退出日常召回")&&archiveHtml.includes("不新增替代记忆"))
  const editedReceiptHtml=await renderReview(splitApplied)
  assert(editedReceiptHtml.includes("喜欢滑雪运动")&&editedReceiptHtml.includes("提交结果"),"应用后展示人工编辑并实际写入的结果")
  assert.equal(maintenanceTaskState(partialApplied).bucket,"review","正常组已提交但异常未处理，仍留在待审核")
  assert.equal(maintenanceTaskState(allKept).bucket,"history")
  assert.equal(maintenanceTaskState(overlapUndone).bucket,"review")
  assert.equal(maintenanceTaskState(overlapHandled).bucket,"history")
  assert((await renderReview(allKept)).includes("异常部分已保留原样"))
  for(const [job,bucket,label] of [
    [clientReady,"review","待审核"],[{...clientReady,plan:[]},"history","无需变更"],
    [{...reviewOnly,reviewedAt:0},"history","仅供核对"],[closed,"history","已保留原样"],
    [{...clientReady,status:"analyzing"},"running","分析中"],[{...clientReady,status:"failed"},"history","分析失败"],
  ]){const state=maintenanceTaskState(job);assert.equal(state.bucket,bucket);assert(state.label.includes(label))}

  const storeSpecifier=(await fs.readFile(clientModule,"utf8")).match(/from "([^"]+store\/store.js[^"]*)"/)[1]
  const {settleConfirm,confirmState,store}=await import(new URL(storeSpecifier,clientModule).href)
  const originalFetch=global.fetch,requests=[]
  const renderer=createRenderer({createElement:tag=>({tag}),createComment:()=>({}),createText:()=>({}),patchProp(){},insert(){},remove(){},setElementText(){},setText(){},parentNode(){return null},nextSibling(){return null}})
  function mount(component,props){
    const app=renderer.createApp({...component,template:undefined,render:()=>h("div")},props)
    return {app,ui:app.mount({})}
  }
  global.fetch=async(url,options)=>{
    const body=options.body?JSON.parse(options.body):{}
    requests.push({url,body})
    let job=mixed
    if(url.endsWith("/apply"))job={...job,status:"applied"}
    if(url.endsWith("/dismiss"))job={...job,reviewedAt:Date.now()}
    return {ok:true,json:async()=>({ok:true,job})}
  }
  const reviewUi=mount(MemoryMaintenanceReview,{job:mixed,name:"示例成员"})
  try{
    const ui=reviewUi.ui
    assert(!ui.selected.includes(reviewOnly.plan[0].id))
    ui.selected=[merge.id];ui.toggleEdit(merge);ui.editText(merge,0,"喜欢科幻文学")
    ui.drafts[merge.id][0].scope="user";ui.toggleEdit(merge)
    assert.equal(ui.editing[merge.id],false)
    await nextTick();assert(Object.values(store.dirtyScopes).some(Boolean))
    const submit=ui.apply();assert(confirmState.open);settleConfirm(true);await submit
    const sent=requests.find(r=>r.url.endsWith("/apply")).body
    assert.deepEqual(sent.selectedIds,[merge.id])
    assert.equal(sent.edits[merge.id][0].text,"喜欢科幻文学")
    assert.equal(sent.edits[merge.id][0].factValue,"喜欢科幻文学")
    assert.equal(sent.edits[merge.id][0].scope,"user")
  }finally{reviewUi.app.unmount()}
  const dismissalUi=mount(MemoryMaintenanceReview,{job:clientReady,name:"示例成员"})
  try{
    const ui=dismissalUi.ui
    ui.editText(merge,0,"未提交的编辑");await nextTick()
    const cancel=ui.close();assert(confirmState.open);settleConfirm(false);await cancel
    assert.equal(ui.job.reviewedAt,0)
    const finish=ui.dismiss();assert(confirmState.open);settleConfirm(true);await finish;await nextTick()
    assert(ui.job.reviewedAt>0)
    assert(!Object.keys(store.dirtyScopes).some(key=>key.startsWith("memory-maintenance:")))
  }finally{dismissalUi.app.unmount();global.fetch=originalFetch}

  // 展开依据分页读取；保留异常不清除正常组的编辑，人工入口携带具体记忆。
  let reviewState=partialPlan
  const sourceRequests=[],manualEvents=[]
  global.fetch=async(url,options)=>{
    sourceRequests.push(url)
    if(url.includes("/evidence"))return{ok:true,json:async()=>({ok:true,evidence:{...proof,page:1,pageSize:20}})}
    if(url.endsWith("/keep"))reviewState={...reviewState,plan:reviewState.plan.map(p=>p.id===isolated[0].id?{...p,resolution:"kept"}:p)}
    return{ok:true,json:async()=>({ok:true,job:reviewState})}
  }
  const sourceUi=mount(MemoryMaintenanceReview,{job:partialPlan,name:"示例成员",onOpenMemory:event=>manualEvents.push(event)})
  try{
    assert.equal(sourceRequests.length,0,"打开审阅不会主动读取聊天原文")
    const ui=sourceUi.ui
    await ui.loadEvidence(partialA.id);await ui.loadEvidence(partialA.id)
    assert.equal(sourceRequests.length,1,"已经展开的来源复用本次读取结果")
    assert.equal(ui.evidence[partialA.id].items[0].text,proof.items[0].text)
    ui.editText(normalGroup,0,"喜欢阅读科幻作品");await nextTick()
    await ui.keepIssue(isolated[0]);await nextTick()
    assert.equal(ui.drafts[normalGroup.id][0].text,"喜欢阅读科幻作品")
    assert(store.dirtyScopes[`memory-maintenance:${partialPlan.id}`],"保留异常不能清掉未提交编辑的脏标记")
    const leave=ui.openMemory(isolated[0].before[0]);assert(confirmState.open);settleConfirm(true);await leave
    assert.equal(manualEvents[0].memory.id,partialC.id)
    assert.equal(manualEvents[0].memory.text,"喜欢摄影")
  }finally{sourceUi.app.unmount();global.fetch=originalFetch}

  // 取消响应先到、旧轮询后到，界面仍保持已取消。
  let finishOldRead
  global.fetch=async(url,options)=>options.method==="POST"?{ok:true,json:async()=>({ok:true,job:{...clientReady,status:"cancelled"}})}:new Promise(resolve=>{finishOldRead=()=>resolve({ok:true,json:async()=>({ok:true,job:{...clientReady,status:"analyzing"}})})})
  const lateReview=mount(MemoryMaintenanceReview,{job:{...clientReady,status:"analyzing"},name:"示例成员"})
  try{
    const read=lateReview.ui.refresh()
    await lateReview.ui.action("cancel")
    finishOldRead();await read
    assert.equal(lateReview.ui.job.status,"cancelled")
  }finally{lateReview.app.unmount();global.fetch=originalFetch}

  for(const target of [{groupId:"g",userId:"merge-user",name:"示例成员"},{groupId:"history-scope",userId:"",batch:false},{groupId:"history-scope",userId:"",batch:true}]){
    const sent=[],events=[]
    global.fetch=async(url,options)=>{
      sent.push({url,body:options.body?JSON.parse(options.body):{}})
      return {ok:true,json:async()=>({ok:true,job:clientReady,jobs:[clientReady]})}
    }
    const creation=mount(MemoryMaintenanceDialog,{...target,onSubmitted:event=>events.push(event)})
    try{
      const ui=creation.ui
      ui.show();assert.equal(ui.useHistory,false);assert.equal(sent.length,0,"打开发起入口不读取任务或调用模型")
      if(target.userId)assert.equal(ui.countLabel,"参考本人发言条数")
      else{assert(ui.historyDescription.includes("当前群所有成员的历史"));if(target.batch)assert(ui.historyDescription.includes("个人任务只参考本人"))}
      ui.useHistory=true;ui.count=3;await ui.start()
      const path=target.batch?"/groups/history-scope":target.userId?"/groups/g/members/merge-user":"/groups/history-scope/public"
      assert.equal(sent.length,1);assert(sent[0].url.endsWith(path));assert.equal(sent[0].body.count,3)
      assert.equal(events[0].jobId,clientReady.id);assert.equal(ui.open,false)
      ui.show();assert.equal(ui.useHistory,false,"每次打开发起入口恢复默认不参考历史")
    }finally{creation.app.unmount();global.fetch=originalFetch}
  }

  // 集中任务页按真实结果分类；过滤、搜索及新创建任务定位均不触发模型。
  const queueJobs=[clientReady,{...reviewOnly,reviewedAt:0},{...clientReady,id:"empty",plan:[]},{...clientReady,id:"working",status:"analyzing"},closed]
  const queueCalls=[],queueEvents=[]
  const queueFetch=async(url)=>{queueCalls.push(url);return {ok:true,json:async()=>url.includes("/jobs/")?{ok:true,job:clientReady}:{ok:true,jobs:queueJobs}}}
  global.fetch=queueFetch
  const queue=mount(MemoryMaintenanceWorkspace,{view:{selectedGroupId:"g",members:[{userId:"merge-user",name:"示例成员"}],memberTitle:item=>item.name},seed:{jobId:"working"},onChanged:()=>queueEvents.push("changed")})
  try{
    for(let i=0;i<10&&queue.ui.loading;i++)await new Promise(r=>setTimeout(r,1))
    const ui=queue.ui
    assert.equal(ui.filter,"running");assert.equal(ui.counts.review,1);assert.equal(ui.counts.running,1);assert.equal(ui.counts.history,3)
    ui.filter="review";assert.equal(ui.visible.length,1);ui.query="不存在";assert.equal(ui.visible.length,0)
    ui.query="示例成员";assert.equal(ui.visible[0].id,clientReady.id)
    assert.equal(queueCalls.length,1)
    await ui.open(clientReady);assert.equal(ui.selected.id,clientReady.id)
    let finishOldList
    global.fetch=async()=>new Promise(resolve=>{finishOldList=()=>resolve({ok:true,json:async()=>({ok:true,jobs:queueJobs})})})
    const oldList=ui.refresh();ui.changed({...clientReady,status:"applied"});finishOldList();await oldList
    assert.equal(ui.counts.review,0,"迟到列表不能把已应用任务改回待审核");assert.deepEqual(queueEvents,["changed"])
    global.fetch=queueFetch
    await ui.submitted({jobId:reviewOnly.id,failures:[{userId:"blocked",error:"任务冲突"}]});assert.equal(ui.filter,"history");assert.equal(ui.submission.failures.length,1)
  }finally{queue.app.unmount();global.fetch=originalFetch}

  // 人工处理定位具体记忆及其全局/本群范围，取消工作区切换时保留审阅。
  const manualOpened=[]
  const navigationView={selectedGroupId:"failure",members:[],memberTitle:item=>item.userId,activeWorkspace:"maintenance",selectedMember:null,memberScope:"user_group",async switchWorkspace(value){this.activeWorkspace=value},async selectMember(member){this.selectedMember=member;this.memberScope="user_group"},openMemoryEditor(item,target){manualOpened.push({item,target})}}
  global.fetch=async()=>({ok:true,json:async()=>({ok:true,jobs:[]})})
  const navigation=mount(MemoryMaintenanceWorkspace,{view:navigationView,seed:{}})
  try{
    const memory={...normalGroup.before[0],scope:"user"}
    await navigation.ui.openMemory({...partialPlan,memory})
    assert.equal(navigationView.memberScope,"user")
    assert.deepEqual(manualOpened[0].target,{scopeType:"user",ownerId:partialPlan.userId,groupId:partialPlan.groupId})
    assert.equal(manualOpened[0].item.id,memory.id)
    await navigation.ui.openMemory({...partialPlan,userId:"",memory:{...memory,scope:"group"}})
    assert.equal(navigationView.selectedMember,null)
    assert.equal(manualOpened[1].target.scopeType,"group")
    navigationView.activeWorkspace="maintenance";navigationView.switchWorkspace=async()=>{}
    navigation.ui.selected=partialPlan
    await navigation.ui.openMemory({...partialPlan,memory})
    assert.equal(manualOpened.length,2);assert.equal(navigation.ui.selected.id,partialPlan.id)
  }finally{navigation.app.unmount();global.fetch=originalFetch}

  let finishInitialList,listCalls=0
  const justCreated={...clientReady,id:"just-created",status:"queued"}
  global.fetch=async()=>++listCalls===1?new Promise(resolve=>{finishInitialList=()=>resolve({ok:true,json:async()=>({ok:true,jobs:[]})})}):{ok:true,json:async()=>({ok:true,jobs:[justCreated]})}
  const lateQueue=mount(MemoryMaintenanceWorkspace,{view:{selectedGroupId:"g",members:[],memberTitle:item=>item.userId},seed:{}})
  try{
    await lateQueue.ui.submitted({jobId:justCreated.id})
    finishInitialList();await new Promise(resolve=>setTimeout(resolve,0))
    assert.equal(lateQueue.ui.jobs[0].id,justCreated.id,"创建前开始的列表读取不能丢掉新任务")
    assert.equal(lateQueue.ui.filter,"running")
  }finally{lateQueue.app.unmount();global.fetch=originalFetch}
  await db.close()
  await assert.rejects(service.create("g","offline"),/需要SQLite/)
  console.log("ok memory-maintenance: additive migration, complete isolated input, per-group review, atomic apply, versions, idempotency, undo, provenance cleanup, history backfill, cancellation, batch, authenticated routes, Vue rendering")
} finally {
  await capture?.stop({flush:false})
  if(vectorRecall?.dirtyTimer)clearTimeout(vectorRecall.dirtyTimer)
  await modelLogStore?.stop({flush:false})
  await db?.close()
  await fs.rm(root,{recursive:true,force:true})
}
