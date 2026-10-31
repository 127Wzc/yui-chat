import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import Database from "better-sqlite3"

await fs.mkdir(new URL("../cache/",import.meta.url),{recursive:true})
const root=await fs.mkdtemp(new URL("../cache/memory-strategy-",import.meta.url))
process.env.YUI_CHAT_RUNTIME_ROOT=root
global.logger={mark(){},info(){},warn(){},error(){},debug(){}}
global.Bot={express:null,wsf:{},uin:[]}
global.segment={at:String,image:String,record:String,reply:String}
global.plugin=class {}
let db,capture,vectors
try{
  const {runStateMigrations}=await import("../output/runtime/core/storage/sqlite/migration-runner.js")
  const dir=new URL("../core/storage/sqlite/migrations/",import.meta.url)
  const files=(await fs.readdir(dir)).filter(file=>file.endsWith(".sql")).sort()
  function oldDatabase(){return new Database(":memory:")}
  for(const fail of [false,true]){
    const old=oldDatabase()
    try{
      old.pragma("foreign_keys=ON")
      old.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY,applied_at INTEGER NOT NULL) STRICT")
      for(const file of files.filter(file=>file<"015")){
        old.exec(await fs.readFile(new URL(file,dir),"utf8"))
        old.prepare("INSERT INTO schema_migrations VALUES(?,1)").run(file)
      }
      for(const status of ["active","warm","cold","archived","deleted"]){
        old.prepare("INSERT INTO memory_items(id,scope_type,owner_id,type,text,normalized_key,status,last_confirmed_at,expires_at,created_at,updated_at) VALUES(?,'user','legacy','fact',?,?,?,?,12,13,14)").run(status,`原有${status}`,status,status,11)
        old.prepare("INSERT INTO memory_evidence VALUES(?,?,'manual','')").run(status,`e-${status}`)
      }
      old.prepare("INSERT INTO group_memory_extraction_jobs(id,group_id,window_start,window_end,content_hash,extractor_version,status,created_at,updated_at,completed_at) VALUES('old-job','g',1,2,'hash','group-memory-v4-daily','completed',1,2,3)").run()
      const before=old.prepare("SELECT * FROM memory_items ORDER BY id").all()
      const evidence=old.prepare("SELECT * FROM memory_evidence ORDER BY memory_id").all()
      const jobs=old.prepare("SELECT * FROM group_memory_extraction_jobs").all()
      if(fail){
        old.exec("CREATE TABLE memory_extraction_budget_daily(day TEXT)")
        assert.throws(()=>runStateMigrations(old))
        assert(!old.prepare("PRAGMA table_info(memory_items)").all().some(c=>c.name==="observed_at"),"failed upgrade rolls back all column additions")
      }else{
        runStateMigrations(old)
        assert.equal(old.prepare("SELECT COUNT(*) AS n FROM group_memory_extraction_batches").get().n,0,"historical completed jobs are not guessed or requeued")
        const upgraded=old.prepare("SELECT * FROM memory_items ORDER BY id").all()
        assert.deepEqual(upgraded.map(row=>Object.fromEntries(Object.keys(before[0]).map(k=>[k,row[k]]))),before)
        assert(upgraded.every(row=>row.observed_at===0&&row.validity_reason===""))
        runStateMigrations(old)
      }
      assert.deepEqual(old.prepare("SELECT * FROM memory_evidence ORDER BY memory_id").all(),evidence)
      assert.deepEqual(old.prepare("SELECT * FROM group_memory_extraction_jobs").all(),jobs)
    }finally{old.close()}
  }
  const {defaults}=await import("../output/runtime/config/defaults.js")
  const {configStore}=await import("../output/runtime/config/store.js")
  ;({sqliteClient:db}=await import("../output/runtime/core/storage/sqlite/client.js"))
  const {SqliteRuntimeConfigRepository}=await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  const {GroupCaptureStore}=await import("../output/runtime/memory/group-capture.js")
  const {memoryRepository:repo}=await import("../output/runtime/memory/repository.js")
  const {sqliteMemoryStore:store}=await import("../output/runtime/memory/sqlite-store.js")
  const {lifecycleFor,statusFor}=await import("../output/runtime/memory/decay.js")
  ;({vectorRecall:vectors}=await import("../output/runtime/memory/vector-recall.js"))
  await db.init(defaults)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(db))
  await configStore.update(c=>{c.memory.groupCapture.consolidation.enabled=false;c.memory.groupCapture.consolidation.maxAttempts=1})
  const DAY=86400000,now=Date.now(),start=new Date(now-3*DAY).setHours(0,0,0,0)
  assert.equal(statusFor({type:"fact",scope_type:"user",last_confirmed_at:now-2000*DAY},now),"cold")
  assert.equal(lifecycleFor({type:"fact",last_confirmed_at:now-2000*DAY},now).nextTransitionAt,0)
  assert.equal(statusFor({status:"archived",last_confirmed_at:now},now),"archived")
  assert.equal(lifecycleFor({expires_at:now-1,validity_reason:"reference-window"},now).validity,"stale")
  let calls=0,failCall=0,invalidRefs=false,reportedUsage={input:11,output:7,total:18}
  const seen=[]
  capture=new GroupCaptureStore(async options=>{
    calls++
    assert.equal(options.singleAttempt,true)
    assert(!options.prompt.includes("900001"),"actual person identifiers are replaced by exact batch aliases")
    const aliases=options.prompt.match(/需要提炼的消息：([^；]+)/)[1].split(",")
    const markers=aliases.map(alias=>options.prompt.split("\n").find(line=>line.startsWith(`[${alias}] `))?.split("：").at(-1)?.slice(0,5))
    if(calls===failCall)return {text:"{broken",usage:reportedUsage}
    seen.push(...markers)
    return {text:JSON.stringify({candidates:aliases.map((alias,index)=>({operation:"add",scope:"user",subjectId:"u1",speakerId:"u1",factKey:"preference.test",factValue:markers[index],text:`用户喜欢${markers[index]}`,evidenceMessageIds:[invalidRefs?"m99999":alias]}))}),usage:reportedUsage}
  })
  await capture.init()
  async function window(group,texts){
    await capture.setPolicy("group",group,{enabled:true,tokenLimit:3000,overrides:{tokenLimit:true}})
    for(let i=0;i<texts.length;i++)await db.run("INSERT INTO group_memory_messages(id,group_id,message_id,sender_id,sender_role,sent_at,text_content,content_hash,segments_json) VALUES(?,?,?,'900001','member',?,?,?,'[]')",[`${group}-${i}`,group,`${group}-${i}`,start+i*1000,texts[i],`${group}-hash-${i}`])
    await capture.createDailyWindow("group",group,start,start+DAY)
    return db.get("SELECT * FROM group_memory_extraction_jobs WHERE group_id=?",[group])
  }
  async function retry(job){await db.run("UPDATE group_memory_extraction_jobs SET status='pending' WHERE id=?",[job.id]);return db.get("SELECT * FROM group_memory_extraction_jobs WHERE id=?",[job.id])}
  const job=await window("increment",["甲甲甲甲甲"+"甲".repeat(2700),"乙乙乙乙乙"+"乙".repeat(2700),"丙丙丙丙丙"+"丙".repeat(2700)])
  failCall=2
  await capture.processWindow(job)
  const partial=await db.get("SELECT * FROM group_memory_extraction_jobs WHERE id=?",[job.id])
  assert.equal(partial.status,"failed")
  assert.equal(JSON.parse(partial.result_json).usage.total,36,"invalid JSON still records upstream usage")
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM group_memory_extraction_batches WHERE job_id=? AND status='applied'",[job.id])).n,1)
  const first=seen[0]
  failCall=0
  await capture.processWindow(await retry(job))
  const completed=await db.get("SELECT * FROM group_memory_extraction_jobs WHERE id=?",[job.id])
  assert.equal(completed.status,"completed")
  assert.equal(JSON.parse(completed.result_json).processedMessageCount,3)
  assert.equal(seen.filter(marker=>marker===first).length,1,"successful source versions are not sent for extraction again")
  await capture.createDailyWindow("group","increment",start,start+DAY,{requeue:true})
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM group_memory_extraction_batches WHERE job_id=?",[job.id])).n,0,"explicit full re-extraction atomically resets its old checkpoints")
  await db.run("UPDATE group_memory_extraction_jobs SET status='completed' WHERE id=?",[job.id])
  const beforeCalls=calls
  await capture.processWindow(completed)
  assert.equal(calls,beforeCalls)

  const checkpoint=await window("checkpoint",["丁丁丁丁丁喜欢茶"])
  const apply=capture.applyCandidates.bind(capture)
  capture.applyCandidates=async()=>{throw new Error("simulate interrupted database write")}
  await capture.processWindow(checkpoint)
  assert.equal((await db.get("SELECT status FROM group_memory_extraction_batches WHERE job_id=?",[checkpoint.id])).status,"extracted")
  const afterModel=calls
  capture.applyCandidates=apply
  await capture.processWindow(await retry(checkpoint))
  assert.equal(calls,afterModel,"saved model response is reused after a write interruption")

  const concurrent=await window("concurrent",["戊戊戊戊戊喜欢画画"])
  const oldCalls=calls
  await Promise.all([capture.processWindow(concurrent),capture.processWindow(concurrent)])
  assert.equal(calls,oldCalls+1,"only one caller claims the same pending job")
  reportedUsage={input:0,output:0,total:0}
  const zero=await window("zero-usage",["零零零零零喜欢阅读"])
  await capture.processWindow(zero)
  const zeroUsage=JSON.parse((await db.get("SELECT result_json FROM group_memory_extraction_jobs WHERE id=?",[zero.id])).result_json).usage
  assert.deepEqual(zeroUsage,{input:0,output:0,total:0,estimated:false},"reported zero usage must remain zero")
  reportedUsage={input:11,output:7,total:18}
  const bad=await window("bad-ref",["己己己己己喜欢旅行"])
  invalidRefs=true
  await capture.processWindow(bad)
  invalidRefs=false
  assert.equal((await db.get("SELECT status FROM group_memory_extraction_jobs WHERE id=?",[bad.id])).status,"failed")
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM group_memory_extraction_batches WHERE job_id=?",[bad.id])).n,0)

  const retained=await window("retained-context",["辛辛辛辛辛喜欢音乐"])
  await db.run("INSERT INTO group_memory_extraction_batches VALUES(?,?,?,?,'applied',?,?)",[retained.id,"retained-key",JSON.stringify({targets:[{id:"retained-context-0",hash:"retained-context-hash-0"}],context:[{id:"expired-context",hash:"old"}]}),"[]",now,now])
  const retainedCalls=calls
  await capture.processWindow(retained)
  assert.equal(calls,retainedCalls,"natural cleanup of unused context does not repeat successfully extracted targets")
  const budget=await window("budget",["庚庚庚庚庚喜欢跑步"])
  await configStore.update(c=>{c.memory.groupCapture.consolidation.tokensPerDay=1})
  const budgetCalls=calls
  await capture.processWindow(budget)
  const waiting=await db.get("SELECT * FROM group_memory_extraction_jobs WHERE id=?",[budget.id])
  assert.equal(waiting.status,"pending");assert.equal(waiting.attempt_count,0);assert(waiting.next_attempt_at>now)
  assert.equal(calls,budgetCalls)
  await configStore.update(c=>{c.memory.groupCapture.consolidation.tokensPerDay=0})

  const current=await repo.insert({scopeType:"user",ownerId:"timeline",groupId:"",text:"用户住苏州",factKey:"identity.city",factValue:"苏州",source:"group-window:current",lastConfirmedAt:now-1000,observedAt:now-1000})
  const row=(id,at,text)=>({id,message_id:id,sender_id:"timeline",sent_at:at,text_content:text,sender_role:"member"})
  const candidate=(id,value,operation="add")=>({scope:"user",subjectId:"timeline",speakerId:"timeline",kind:"identity",factKey:"identity.city",factValue:value,text:`用户住${value}`,operation,evidenceMessageIds:[id]})
  const stale=await capture.applyCandidates({id:"old",group_id:"g"},[row("older",start,"我以前住杭州")],[candidate("older","杭州","replace")])
  assert.equal(stale[0].action,"ignored");assert.equal((await repo.get(current.id)).status,"active")
  const pending=await capture.applyCandidates({id:"new",group_id:"g"},[row("later",now,"我住南京")],[candidate("later","南京")])
  assert.equal(pending[0].action,"review")
  const pendingRow=await repo.get(pending[0].id)
  assert.equal(statusFor(pendingRow),"archived")
  assert.equal(lifecycleFor(pendingRow).validity,"pending")
  await assert.rejects(async()=>store.saveScopedMemory({scopeType:"user",ownerId:"other",id:pendingRow.id,text:pendingRow.text,resolution:"accept",expectedRevision:await repo.revision(pendingRow)}),/未找到/)
  const detail=await store.getMemoryDetail({scopeType:"user",ownerId:"timeline",id:pendingRow.id})
  assert.equal(detail.item.conflicts[0].id,current.id,"pending review includes readable original facts")
  const oldRevision=detail.item.revision
  await repo.insert({scopeType:"user",ownerId:"timeline",text:"另一条新事实"})
  await assert.rejects(async()=>store.saveScopedMemory({scopeType:"user",ownerId:"timeline",id:pendingRow.id,text:pendingRow.text,resolution:"accept",expectedRevision:oldRevision}),/条件写入|不匹配|预期|未提交/)
  assert.equal((await repo.get(current.id)).status,"active","stale approval cannot archive an unseen newer state")
  await store.saveScopedMemory({scopeType:"user",ownerId:"timeline",id:pendingRow.id,text:pendingRow.text,resolution:"accept",expectedRevision:await repo.revision(pendingRow)})
  assert.equal((await repo.get(current.id)).superseded_by,pendingRow.id)
  assert.equal((await repo.get(pendingRow.id)).status,"active")
  await assert.rejects(async()=>store.saveScopedMemory({scopeType:"user",ownerId:"timeline",id:pendingRow.id,text:pendingRow.text,resolution:"accept",expectedRevision:await repo.revision(pendingRow)}),/不在待核实/)
  const history=await repo.listPage({scopeType:"user",ownerId:"timeline",groupId:""},{includeHistory:true})
  assert(history.items.some(item=>item.id===current.id))
  const historyGroup="history-view"
  const archivedGroup=await repo.insert({scopeType:"group",ownerId:historyGroup,groupId:historyGroup,text:"归档的群历史",status:"archived"})
  const expiredGroup=await repo.insert({scopeType:"group",ownerId:historyGroup,groupId:historyGroup,text:"已到期的群历史",expiresAt:now-1})
  const deletedGroup=await repo.insert({scopeType:"group",ownerId:historyGroup,groupId:historyGroup,text:"已删除的群历史",status:"deleted"})
  const archivedMember=await repo.insert({scopeType:"user_group",ownerId:"history-member",groupId:historyGroup,text:"成员的归档历史",status:"archived"})
  const foreignHistory=await repo.insert({scopeType:"user_group",ownerId:"history-member",groupId:"elsewhere",text:"其他群的历史",status:"archived"})
  const workspace=await store.getGroupWorkspace(historyGroup)
  assert(workspace.groupMemory.items.some(item=>item.id===archivedGroup.id)&&workspace.groupMemory.items.some(item=>item.id===expiredGroup.id),"management shows archived and expired history by default")
  assert(!workspace.groupMemory.items.some(item=>item.id===deletedGroup.id))
  assert(workspace.members.some(member=>member.userId==="history-member"&&member.memoryCount===1),"members with only local history remain discoverable")
  const memberHistory=await store.getGroupMemberWorkspace(historyGroup,"history-member")
  assert(memberHistory.groupMemory.items.some(item=>item.id===archivedMember.id))
  assert(!memberHistory.groupMemory.items.some(item=>item.id===foreignHistory.id),"showing history must preserve group boundaries")
  const globalHistory=await store.getGroupMemberWorkspace(historyGroup,"timeline")
  assert(globalHistory.globalMemory.items.some(item=>item.id===current.id),"global personal history is shown by default too")
  assert.equal((await repo.list([{scopeType:"group",ownerId:historyGroup,groupId:historyGroup}],{includeCold:true})).length,0,"management history does not widen normal recall")
  const plan=await capture.applyCandidates({id:"past",group_id:"g"},[row("plan",start,"我计划周一玩游戏")],[{...candidate("plan","游戏"),kind:"plan",factKey:"plan.game",validTo:new Date(start+DAY).toISOString()}])
  assert.equal(statusFor(await repo.get(plan[0].id)),"expired","past deadlines are retained")
  const expired=await repo.insert({scopeType:"user",ownerId:"retained",text:"过期事实",expiresAt:now-100*DAY})
  const episode=await repo.insert({scopeType:"user",ownerId:"retained",type:"episode",text:"旧短期经历",expiresAt:now-100*DAY})
  await store.flush()
  assert(await repo.get(expired.id));assert.equal(await repo.get(episode.id),null)
  const race=await repo.insert({scopeType:"user",ownerId:"race",text:"原事实",factKey:"identity.city",factValue:"旧值",source:"group-window:race"})
  await db.run("UPDATE memory_items SET source='manual-edit',text='人工修订' WHERE id=?",[race.id])
  await assert.rejects(()=>repo.replaceFact(race,{scopeType:"user",ownerId:"race",text:"新值",factKey:"identity.city",factValue:"新值"}),/版本|未提交/)
  assert.equal((await repo.get(race.id)).text,"人工修订","even a same-millisecond manual edit cannot be overwritten by an old automatic decision")
  const explicit=await store.addFact({user_id:"explicit",time:now/1000},"用户住广州",{source:"explicit-user",factKey:"identity.city",factValue:"广州"})
  assert.equal((await store.addFact({user_id:"explicit"},"用户住广州",{source:"explicit-user",factKey:"identity.city",factValue:"广州"})).id,explicit.id)
  const updated=await store.addFact({user_id:"explicit",time:(now+1000)/1000},"用户住深圳",{source:"explicit-user",factKey:"identity.city",factValue:"深圳",operation:"replace"})
  assert.equal((await repo.get(explicit.id)).superseded_by,updated.id)
  const legacyText="已有的未结构化事实"
  const legacy=await repo.insert({scopeType:"user",ownerId:"large-legacy",text:legacyText,importance:0,source:"explicit-user"})
  await db.transaction(Array.from({length:501},(_,i)=>({sql:"INSERT INTO memory_items(id,scope_type,owner_id,type,text,normalized_key,importance,last_confirmed_at,created_at,updated_at) VALUES(?,'user','large-legacy','fact',?,?,1,1,1,1)",params:[`large-${i}`,`其他事实${i}`,`其他事实${i}`]})))
  assert.equal((await store.addFact({user_id:"large-legacy"},legacyText,{source:"explicit-user"})).id,legacy.id,"old unstructured facts beyond the 500-row working set remain deduplicated")
  const linked=await capture.applyCandidates({id:"legacy-link",group_id:"g"},[{id:"legacy-e",message_id:"legacy-e",sender_id:"large-legacy",sent_at:now,text_content:legacyText}],[{scope:"user",subjectId:"large-legacy",text:legacyText,factKey:"preference.legacy",factValue:legacyText,evidenceMessageIds:["legacy-e"]}])
  assert.equal(linked[0].id,legacy.id,"daily extraction associates exact legacy content without rewriting the whole scope")
  assert.equal((await capture.summary()).dailyBudget.reserved,0)
  console.log("ok memory strategy: additive migration/rollback, lifecycle, incremental batches/checkpoints, budgets/actual usage, exact references, temporal conflicts, manual resolution and retention")
}finally{
  await capture?.stop({flush:false})

  await db?.close()
  await fs.rm(root,{recursive:true,force:true})
}
