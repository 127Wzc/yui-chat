import crypto from "node:crypto"
import { configStore } from "../config/store.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { backgroundTaskService } from "../core/scheduling/background-task-service.js"
import { estimateTokens } from "../core/chat/token-budget.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import { runIsolatedModelTask } from "../models/isolated-task.js"
import { normalizeModelUsage } from "../models/protocol/normalize.js"
import { groupCaptureStore } from "./group-capture.js"
import { vectorRecall } from "./vector-recall.js"
import { sqliteMemoryStore } from "./sqlite-store.js"
import { memoryRepository } from "./repository.js"
import { record,records,identifier,fail,hash,messageHash,readSnapshot,readMemories,versions,getJob,publicJob,saveJob,saveSnapshot,versionGuards,writeMemory,currentRows,currentEvidence,cleanupMaintenance } from "./maintenance-data.js"
import type { Row,Job,Target } from "./maintenance-data.js"
import { MAINTENANCE_PROMPT,reviewProposals,proposalView,buildChanges,assertNoFactConflicts } from "./maintenance-plan.js"
import type { Proposal,Changes } from "./maintenance-plan.js"
import type { SqliteOperation } from "../core/storage/types.js"

const DAY=86400000
const activeStatuses=["queued","collecting","analyzing"]
const linkedMessage = `EXISTS (SELECT 1 FROM memory_evidence e JOIN memory_items m ON m.id=e.memory_id
  WHERE e.source_event_id=group_memory_messages.id AND e.source_type='group-message:'||group_memory_messages.group_id
    AND (e.message_id='' OR e.message_id=group_memory_messages.message_id) AND m.status<>'deleted')`
// 多个调用入口共用运行预留；重启恢复只执行一次，不能把另一个实例的活跃任务误判为中断。
const running=new Map<string,AbortController>()
const backgroundIds=new Map<string,string>()
let recovery:Promise<void>|undefined
type ModelTask=typeof runIsolatedModelTask
interface Message extends Row { id:string;message_id:string;sender_id:string;text_content:string;sent_at:number;expires_at:number }

export class MemoryMaintenance {
  constructor(private readonly model:ModelTask=runIsolatedModelTask) {}

  private async recover():Promise<void> {
    recovery??=sqliteClient.run("UPDATE memory_maintenance_jobs SET status='failed',error_message='运行已中断，可重新分析；没有自动应用任何建议。',updated_at=? WHERE status IN ('queued','collecting','analyzing')",[Date.now()]).then(()=>undefined).catch(error=>{recovery=undefined;throw error})
    await recovery
  }

  private available(write=false): void {
    if(!sqliteClient.status.available) fail("AI记忆整理需要SQLite，当前后端不可用，未执行文件降级写入。",503)
    if(write&&record(configStore.get().memory).enabled===false) fail("记忆功能已关闭，不能分析或应用新的变更。",409)
  }
  private async settings(groupId:string,history=false):Promise<Row> {
    this.available(true)
    const memory=record(configStore.get().memory),capture=record(memory.groupCapture),defaults=record(capture.consolidation)
    const policy=await sqliteClient.get("SELECT * FROM group_memory_policies WHERE group_id=?",[groupId])
    if(!policy) fail("未找到这个群的采集配置。")
    if(history&&(capture.enabled===false||policy.enabled!==1)) fail("历史参考需要当前群已授权并开启消息采集。")
    if(groupCaptureStore.clearingScopes.has(`group:${groupId}`)) fail("本群资料正在清理，请稍后重试。",409)
    return {modelName:policy.model_name??defaults.modelName??"",maxTokens:policy.max_tokens??defaults.maxTokens??100000,
      tokenLimit:policy.token_limit??capture.defaultTokenLimit??200000,minConfidence:policy.min_confidence??defaults.minConfidence??0.7,
    }
  }
  private async loadMessages(target:Target,count:number):Promise<Message[]> {
    const result:Message[]=[]
    let cursor:Message|undefined,scanned=0
    while(result.length<count&&scanned<10000) {
      const rows=await sqliteClient.all<Message>(`SELECT id,group_id,message_id,sender_id,sent_at,text_content,expires_at,segments_json,is_command FROM group_memory_messages WHERE group_id=?
        ${target.userId?"AND sender_id=?":""} AND is_command=0 AND text_content<>'' AND (expires_at=0 OR expires_at>?)
        ${cursor?"AND (sent_at<? OR (sent_at=? AND id<?))":""} ORDER BY sent_at DESC,id DESC LIMIT 200`,[target.groupId,...(target.userId?[target.userId]:[]),Date.now(),...(cursor?[cursor.sent_at,cursor.sent_at,cursor.id]:[])])
      if(!rows.length)break
      scanned+=rows.length;cursor=rows.at(-1)
      for(const row of rows) {
        const segments=records(JSON.parse(String(row.segments_json||"[]")))
        if(segments.some(s=>["forward","node"].includes(String(s.type))))continue
        result.push(row);if(result.length===count)break
      }
      if(rows.length<200)break
    }
    return result.reverse()
  }
  private async messageGuards(job:Job):Promise<SqliteOperation[]> {
    const guards:SqliteOperation[]=[]
    for(const ref of job.snapshot.messages) {
      const row=await sqliteClient.get<Message>(`SELECT *,${linkedMessage} AS memory_linked FROM group_memory_messages WHERE id=? AND group_id=?`,[ref.id,job.groupId])
      if(!row||(job.userId&&row.sender_id!==job.userId)||messageHash(row)!==ref.hash||(row.expires_at>0&&row.expires_at<=Date.now()&&!row.memory_linked)) fail("本次参考原文已修改、删除或过期，请重新分析。",409)
      guards.push({sql:`SELECT text_content,sender_id,message_id,segments_json,is_command,sent_at,expires_at FROM group_memory_messages WHERE id=? AND group_id=? AND (expires_at=0 OR expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) OR ${linkedMessage})`,params:[row.id,job.groupId],mode:"get",expect:{text_content:row.text_content,sender_id:row.sender_id,message_id:row.message_id,segments_json:row.segments_json,is_command:row.is_command,sent_at:row.sent_at,expires_at:row.expires_at}})
    }
    return guards
  }
  async create(group:unknown,user:unknown,options:Row={}):Promise<Row> {
    this.available(true)
    const target={groupId:identifier(group),userId:user?identifier(user):""}
    if(options.useHistory!==undefined&&typeof options.useHistory!=="boolean") fail("历史参考必须为布尔值。")
    const useHistory=options.useHistory===true
    const requestedCount=useHistory?Number(options.count??200):0
    if(useHistory&&(!Number.isInteger(requestedCount)||requestedCount<1||requestedCount>2000))fail("参考发言条数必须为1至2000之间的整数。")
    await this.settings(target.groupId,useHistory)
    await cleanupMaintenance()
    await this.recover()
    const id=crypto.randomUUID(),now=Date.now()
    try {
      await sqliteClient.run("INSERT INTO memory_maintenance_jobs(id,group_id,user_id,actor_id,status,use_history,requested_count,created_at,updated_at,expires_at) VALUES(?,?,?,?,'queued',?,?,?,?,?)",[id,target.groupId,target.userId,identifier(options.actorId||"web-admin"),useHistory?1:0,requestedCount,now,now,now+DAY])
    } catch(error) {
      if(/UNIQUE/.test(String(error)))fail("该用户已有整理任务（全局记忆跨群共用），请先完成或取消。",409)
      throw error
    }
    this.schedule(id)
    return publicJob(await getJob(id))
  }
  private schedule(id:string):void {
    const controller=new AbortController()
    running.set(id,controller)
    try {
      const task=backgroundTaskService.submit({name:"memory-maintenance",queueKey:"memory-maintenance",maxConcurrent:1,maxQueue:200,
        execute:async signal=>{
          const combined=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(600000)])
          try {await this.analyze(id,combined)}
          catch(error) {
            const current=await sqliteClient.get("SELECT status FROM memory_maintenance_jobs WHERE id=?",[id])
            if(current&&activeStatuses.includes(String(current.status))) {
              const message=combined.aborted?"任务已取消或超过总时限，没有应用任何建议。":record(error).maintenanceError===true?String(record(error).message):"分析未完成，请检查模型设置后重试；没有应用任何建议。"
              await saveJob(id,{status:combined.aborted?"cancelled":"failed",error:message})
              hostRuntime.logger?.warn?.("[Yui-Chat][Memory] 整理分析未完成",error instanceof Error?error.name:"AnalysisError")
            }
          } finally {running.delete(id);backgroundIds.delete(id)}
        }})
      backgroundIds.set(id,task.id)
    } catch(error) {
      running.delete(id)
      void saveJob(id,{status:"failed",error:"后台队列不可用，请稍后重试。"}).catch(e=>hostRuntime.logger?.error?.("[Yui-Chat][Memory] 整理任务状态写入失败",e))
      throw error
    }
  }
  private async analyze(id:string,signal:AbortSignal):Promise<void> {
    signal.throwIfAborted()
    let job=await getJob(id)
    const settings=await this.settings(job.groupId,job.useHistory)
    await saveJob(id,{status:"collecting",error:"",progress:{stage:"读取资料"}},["queued"])
    let messages:Message[]=[],initialCount=0,historyWarning="",historyScanned=0,historyCursor=""
    if(job.useHistory) {
      messages=await this.loadMessages(job,job.requestedCount);initialCount=messages.length
      if(messages.length<job.requestedCount) {
        await groupCaptureStore.refreshPolicies()
        try {
          const result=await groupCaptureStore.backfillHistory("group",job.groupId,{limit:1000,maxMessages:1000,continueFromOldest:true,queueExtraction:false,respectRetention:true,signal})
          historyScanned=Number(result.received||0)
          historyCursor=String(result.startedFrom||"")
        } catch(error) {
          signal.throwIfAborted()
          historyWarning="平台历史未能补足，按实际可用发言分析。"
          hostRuntime.logger?.debug?.("[Yui-Chat][Memory] 整理历史补充不足",error instanceof Error?error.name:"HistoryError")
        }
        messages=await this.loadMessages(job,job.requestedCount)
      }
    }
    signal.throwIfAborted()
    const snapshot=await readSnapshot(job)
    snapshot.messages=messages.map(m=>({id:m.id,hash:messageHash(m),sentAt:m.sent_at,expiresAt:m.expires_at}))
    await saveSnapshot(job,snapshot)
    const progress={memoryCount:snapshot.memories.length,messageCount:messages.length,databaseCount:Math.min(initialCount,messages.length),historyCount:Math.max(0,messages.length-initialCount),requestedCount:job.requestedCount,
      historyComplete:!job.useHistory||messages.length===job.requestedCount,historyScanned,historyCursor,from:messages[0]?.sent_at||0,to:messages.at(-1)?.sent_at||0,
      warning:historyWarning||(messages.length<job.requestedCount?"参考发言不足，本次不再补录，按实际资料分析。":""),memoryComplete:true}
    await saveJob(id,{status:"analyzing",progress:{...progress,stage:"模型分析"}},["collecting"])
    job=await getJob(id)
    if(!snapshot.memories.length&&!messages.length){await saveJob(id,{status:"ready",plan:[],progress:{...progress,stage:"没有可整理资料",analysisComplete:true}});return}
    const memoryInputs=snapshot.memories.map(m=>({id:m.id,text:m.text,type:m.type,scope:m.scope_type,groupId:m.group_id,factKey:m.fact_key,factValue:m.fact_value,
      confidence:m.confidence,lastConfirmedAt:m.last_confirmed_at,expiresAt:m.expires_at,source:m.source,tags:JSON.parse(m.tags_json),evidence:snapshot.evidence.filter(e=>e.memory_id===m.id).map(e=>({id:e.source_event_id,type:e.source_type})),lifecycle:undefined}))
    const messageInputs=messages.map(m=>({id:m.id,author:m.sender_id,time:new Date(m.sent_at).toISOString(),text:m.text_content}))
    const base={now:new Date().toISOString(),timeZone:"Asia/Shanghai",target:{scope:job.userId?"member":"group",userId:job.userId,groupId:job.groupId},useHistory:job.useHistory}
    const limit=Math.max(3000,Number(settings.tokenLimit)||200000)
    const prompt=JSON.stringify({...base,memories:memoryInputs,history:messageInputs})
    const inputTokens=estimateTokens(MAINTENANCE_PROMPT)+estimateTokens(prompt)
    if(inputTokens>limit)fail(`完整资料预计 ${inputTokens} Token，超过本群输入上限 ${limit}；未调用模型，请调整预算后重新分析。`)
    signal.throwIfAborted();await this.settings(job.groupId,job.useHistory)
    await saveJob(id,{progress:{...progress,stage:"单次模型分析",inputTokens,tokenLimit:limit}})
    const response=await this.model({taskName:"replyer",channelId:String(settings.modelName)||undefined,systemPrompt:MAINTENANCE_PROMPT,prompt,maxTokens:Number(settings.maxTokens),timeoutMs:90000,singleAttempt:true,signal,event:{isGroup:true,group_id:job.groupId,user_id:job.userId||"memory-maintenance"},source:"memory-maintenance",purpose:"memory-maintenance",metadata:{jobId:id}})
    // 模型调用已发生；先保存用量，后续格式或范围校验失败也保留本次消耗。
    const resultProgress={...progress,stage:"校验整理结果",inputTokens,tokenLimit:limit,usage:normalizeModelUsage(response.usage)}
    await saveJob(id,{progress:resultProgress},["analyzing"])
    const {plan:final,review}=reviewProposals(String(response.text||""),job,snapshot.memories.map(m=>m.id),messages.map(m=>m.id),Number(settings.minConfidence))
    signal.throwIfAborted();await this.settings(job.groupId,job.useHistory)
    await sqliteClient.transaction([...versionGuards(snapshot.versions),...await this.messageGuards(job),
      {sql:"UPDATE memory_maintenance_jobs SET status='ready',plan_json=?,progress_json=?,updated_at=? WHERE id=? AND status='analyzing'",params:[JSON.stringify(final),JSON.stringify({...resultProgress,review,stage:review.complete?"变更预览":"部分变更需人工处理",analysisComplete:review.complete}),Date.now(),id],expectChanges:1}])
  }
  async view(id:unknown):Promise<Row> {
    this.available()
    await this.recover()
    const job=await getJob(id)
    const result=publicJob(job)
    result.plan=(job.plan as Proposal[]).map(p=>proposalView(p,job.snapshot))
    return result
  }
  async list(group:unknown,user?:unknown):Promise<Row[]> {
    this.available();await cleanupMaintenance()
    const rows=await sqliteClient.all(`SELECT id FROM memory_maintenance_jobs WHERE group_id=? ${user===undefined?"":"AND user_id=?"} ORDER BY created_at DESC LIMIT 250`,[identifier(group),...(user===undefined?[]:[user?identifier(user):""])])
    return Promise.all(rows.map(row=>this.view(row.id)))
  }
  async dismiss(id:unknown):Promise<Row> {
    this.available()
    const job=await getJob(id)
    if(job.reviewedAt)return this.view(job.id)
    if(job.status!=="ready")fail("只有已完成分析、尚未应用的任务可以保留原样结束审阅。",409)
    const result=await sqliteClient.run("UPDATE memory_maintenance_jobs SET reviewed_at=?,updated_at=? WHERE id=? AND status='ready' AND reviewed_at=0",[Date.now(),Date.now(),job.id])
    if(Number(result.changes)!==1&&!(await getJob(job.id)).reviewedAt)fail("任务状态已变化，请刷新查看结果。",409)
    return this.view(job.id)
  }
  async source(id:unknown,sourceId:unknown):Promise<Row> {
    this.available();const job=await getJob(id)
    if(!job.useHistory)fail("本任务未开启历史参考，不读取聊天原文。")
    const ref=job.snapshot.messages.find(m=>m.id===String(sourceId))
    if(!ref)fail("原文不属于本任务的参考范围。",404)
    const source=await sqliteClient.get<Message>(`SELECT * FROM group_memory_messages WHERE id=? AND group_id=? AND (expires_at=0 OR expires_at>? OR ${linkedMessage})`,[ref.id,job.groupId,Date.now()])
    if(!source||(job.userId&&source.sender_id!==job.userId)||messageHash(source)!==ref.hash)return {available:false,id:ref.id}
    return {available:true,id:ref.id,text:source.text_content,sentAt:source.sent_at,author:source.sender_id,authorName:source.sender_name||""}
  }
  async evidence(id:unknown,memoryId:unknown,page:unknown=1):Promise<Row> {
    this.available();const job=await getJob(id)
    const original=job.snapshot.memories.find(m=>m.id===String(memoryId))
    if(!original)fail("记忆不属于本次整理范围。",404)
    const current=await memoryRepository.get(original.id)
    if(!current||current.scope_type!==original.scope_type||current.owner_id!==original.owner_id||current.group_id!==original.group_id)fail("记忆已删除或范围已变化，请在记忆页查看。",409)
    // 仅管理员显式展开来源时读取现有原文，不补录历史，也不发给模型。
    const currentPage=Number(page)
    if(!Number.isSafeInteger(currentPage)||currentPage<1)fail("来源页码必须为正整数。")
    return memoryRepository.listEvidence(original.id,currentPage)
  }
  async keepIssue(id:unknown,issueId:unknown):Promise<Row> {
    this.available();const job=await getJob(id)
    const index=job.plan.findIndex(p=>p.id===String(issueId)&&p.blocked===true)
    if(index<0)fail("未找到本任务的异常项。",404)
    if(job.plan[index].resolution==="kept"||job.reviewedAt)return this.view(job.id)
    if(!["ready","applied","undone"].includes(job.status))fail("当前任务不能处理异常项。",409)
    // 原子修改一项审阅决定，保留并发处理的其他项和提交回执。
    const result=await sqliteClient.run(`UPDATE memory_maintenance_jobs SET plan_json=json_set(plan_json,'$[${index}].resolution','kept'),updated_at=? WHERE id=? AND status IN ('ready','applied','undone') AND reviewed_at=0 AND json_extract(plan_json,'$[${index}].id')=? AND json_extract(plan_json,'$[${index}].blocked')=1`,[Date.now(),job.id,String(issueId)])
    if(Number(result.changes)!==1)fail("任务状态已变化，请刷新后重试。",409)
    return this.view(job.id)
  }
  async retry(id:unknown):Promise<Row> {
    this.available(true);await this.recover()
    const job=await getJob(id);await this.settings(job.groupId,job.useHistory)
    if(job.expiresAt<=Date.now())fail("任务已超过保留期限，请创建新的整理任务。",409)
    if(running.has(job.id))fail("上一轮分析正在停止，请稍后重试。",409)
    if(!["failed","cancelled","stale"].includes(job.status))fail("只有失败、取消或失效的任务可以重试。",409)
    await saveJob(job.id,{status:"queued",error:"",progress:{stage:"等待重新取材"}},[job.status]);this.schedule(job.id)
    return this.view(job.id)
  }
  async cancel(id:unknown):Promise<Row> {
    this.available();const job=await getJob(id)
    if(!activeStatuses.includes(job.status))fail("本任务已不在分析中，不能取消已提交的变更。",409)
    await saveJob(job.id,{status:"cancelled",error:"已取消，没有应用建议。"})
    running.get(job.id)?.abort(new Error("管理员取消"))
    const backgroundId=backgroundIds.get(job.id)
    if(backgroundId) {
      const queued=backgroundTaskService.get(backgroundId)?.status==="queued"
      backgroundTaskService.cancel(backgroundId)
      if(queued){running.delete(job.id);backgroundIds.delete(job.id)}
    }
    return this.view(job.id)
  }
  async group(group:unknown,options:Row):Promise<Row> {
    if(options.useHistory!==undefined&&typeof options.useHistory!=="boolean")fail("历史参考必须为布尔值。")
    if(options.useHistory===true&&(!Number.isInteger(Number(options.count??200))||Number(options.count??200)<1||Number(options.count??200)>2000))fail("参考发言条数必须为1至2000之间的整数。")
    const groupId=identifier(group);await this.settings(groupId,options.useHistory===true)
    const members=await sqliteClient.all("SELECT owner_id AS id FROM memory_items WHERE scope_type='user_group' AND group_id=? AND type IN ('fact','episode') AND status IN ('active','warm','cold') AND (expires_at=0 OR expires_at>?) UNION SELECT sender_id AS id FROM group_memory_messages WHERE group_id=? AND sender_id<>'' AND (expires_at=0 OR expires_at>?) LIMIT 201",[groupId,Date.now(),groupId,Date.now()])
    if(members.length>200)fail("已记录成员超过单次批量上限，请按成员分别处理。")
    const jobs:Row[]=[],failures:Row[]=[]
    for(const user of ["",...members.map(row=>String(row.id))]) {
      try{jobs.push(await this.create(groupId,user,options))}
      catch(error){failures.push({userId:user,error:error instanceof Error?error.message:"创建任务失败"})}
    }
    return {jobs,failures,total:members.length+1}
  }
  private receiptUpdate(job:Job,receipt:Row,applyHash:string):SqliteOperation {
    return {sql:"UPDATE memory_maintenance_jobs SET status='applied',receipt_json=?,apply_hash=?,undo_until=?,expires_at=?,updated_at=? WHERE id=? AND status='ready' AND reviewed_at=0",
      params:[JSON.stringify(receipt),applyHash,Date.now()+7*DAY,Date.now()+7*DAY,Date.now(),job.id],expectChanges:1}
  }
  async apply(id:unknown,selectedIds:unknown,editsValue:unknown={}):Promise<Row> {
    this.available();const job=await getJob(id)
    if(!Array.isArray(selectedIds)||selectedIds.some(value=>typeof value!=="string"))fail("请选择需要应用的变更。")
    const ids=[...new Set(selectedIds as string[])].sort(),edits=record(editsValue)
    if(!ids.length||Object.keys(edits).some(id=>!ids.includes(id)))fail("选择或编辑的变更标识无效。")
    const applyHash=hash([ids,edits])
    if(job.status==="applied") {if(job.applyHash!==applyHash)fail("任务已按不同的选择提交，不能再次应用。",409);return this.view(job.id)}
    const settings=await this.settings(job.groupId,job.useHistory)
    if(job.status!=="ready"||job.reviewedAt||job.expiresAt<=Date.now())fail("预览已过期、审阅已结束或未完整分析，不能应用。",409)
    const selected=(job.plan as Proposal[]).filter(p=>ids.includes(p.id))
    if(selected.length!==ids.length)fail("选择了不属于本任务的建议。")
    const changes=buildChanges(job,selected,edits,Number(settings.minConfidence))
    let messageGuards:SqliteOperation[]
    try{messageGuards=await this.messageGuards(job)}catch(error){
      if(record(error).statusCode===409)await sqliteClient.run("UPDATE memory_maintenance_jobs SET status='stale',error_message=?,updated_at=? WHERE id=? AND status='ready' AND reviewed_at=0",["参考原文已变化或到期，请重新分析。",Date.now(),job.id])
      throw error
    }
    const operations:SqliteOperation[]=[...versionGuards(job.snapshot.versions),...messageGuards]
    const oldIds=new Set(changes.before.map(m=>m.id))
    for(const row of changes.after) operations.push(...writeMemory(row,oldIds.has(row.id),changes.evidenceAfter.filter(e=>e.memory_id===row.id)))
    for(const memoryId of changes.created)operations.push({sql:"INSERT INTO memory_maintenance_sources(job_id,memory_id,group_id) VALUES(?,?,'')",params:[job.id,memoryId]})
    const results=changes.after.filter(m=>m.status!=="archived")
    let resultIndex=0
    const groups=selected.map(p=>{
      const outputs=results.slice(resultIndex,resultIndex+p.outputs.length).map(m=>({text:m.text,scope:m.scope_type,factKey:m.fact_key,factValue:m.fact_value,confidence:m.confidence}))
      resultIndex+=p.outputs.length
      return {id:p.id,kind:p.kind,outputs}
    })
    const receipt={...changes,summary:{applied:selected.length,created:changes.created.length,archived:changes.after.filter(m=>m.status==="archived").length,edited:Object.keys(edits).length,appliedAt:Date.now(),groups}}
    operations.push(this.receiptUpdate(job,receipt,applyHash))
    try{await sqliteClient.transaction(operations)}catch(error){
      const latest=await getJob(job.id)
      if(latest.status==="applied"&&latest.applyHash===applyHash)return this.view(job.id)
      if(latest.reviewedAt)fail("审阅已结束，整次提交未应用。",409)
      if(/版本|条件写入/.test(String(error))) {await sqliteClient.run("UPDATE memory_maintenance_jobs SET status='stale',error_message=?,updated_at=? WHERE id=? AND status='ready' AND reviewed_at=0",["资料已变化，整次提交未应用，请重新分析。",Date.now(),job.id]);fail("资料已变化，整次提交未应用，请重新分析。",409)}
      throw error
    }
    vectorRecall.markDirty();await sqliteMemoryStore.refreshStats()
    return this.view(job.id)
  }
  async undo(id:unknown):Promise<Row> {
    this.available();const job=await getJob(id)
    if(job.status==="undone")return this.view(job.id)
    if(job.status!=="applied"||job.undoUntil<=Date.now())fail("任务未应用或已超过撤销期限。",409)
    const receipt=job.receipt as unknown as Changes
    const currentVersions=await versions(job)
    const ids=receipt.after.map(m=>m.id)
    const current=await currentRows(ids),evidence=await currentEvidence(ids)
    const expectedEvidence=[...receipt.evidenceAfter,...receipt.evidenceBefore.filter(e=>receipt.after.some(m=>m.id===e.memory_id&&m.status==="archived"))]
    const canonical=(rows:Row[])=>[...rows].sort((a,b)=>hash(a).localeCompare(hash(b)))
    if(hash(canonical(current))!==hash(canonical(receipt.after))||hash(canonical(evidence))!==hash(canonical(expectedEvidence)))fail("相关记忆或证据已有后续修改，不能覆盖撤销。",409)
    if(receipt.before.some(m=>m.expires_at>0&&m.expires_at<=Date.now()))fail("原记忆已到期，不能撤销恢复其召回。",409)
    const affected=new Set(ids)
    // 撤销恢复原有分组（其中可能本来就有重复），只检查它与后来保留的记录是否冲突。
    assertNoFactConflicts(receipt.before,(await readMemories(job)).filter(m=>!affected.has(m.id)),false)
    const operations:SqliteOperation[]=[...versionGuards(currentVersions)]
    for(const row of receipt.before) operations.push(...writeMemory({...row,updated_at:Date.now()},true,receipt.evidenceBefore.filter(e=>e.memory_id===row.id),true))
    for(const memoryId of receipt.created) operations.push({sql:"DELETE FROM memory_maintenance_sources WHERE job_id=? AND memory_id=?",params:[job.id,memoryId]},{sql:"DELETE FROM memory_fts WHERE memory_id=?",params:[memoryId]},{sql:"DELETE FROM memory_items WHERE id=?",params:[memoryId],expectChanges:1})
    operations.push({sql:"UPDATE memory_maintenance_jobs SET status='undone',updated_at=? WHERE id=? AND status='applied'",params:[Date.now(),job.id],expectChanges:1})
    await sqliteClient.transaction(operations)
    vectorRecall.markDirty();await sqliteMemoryStore.refreshStats()
    return this.view(job.id)
  }
}
export const memoryMaintenance=new MemoryMaintenance()
