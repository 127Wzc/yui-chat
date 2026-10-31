import { computed,nextTick,onMounted,onUnmounted,reactive,ref,watch } from "vue"
import { confirmAction,request,setDirtyScope,toast } from "../../app/store/store.js"
import { asRecord,asRecords,errorMessage } from "../../shared/data.js"
import { maintenanceActive,maintenanceStamp,maintenanceTaskState } from "./memory-maintenance.js"
import type { MaintenanceRow } from "./memory-maintenance.js"

const rows=(value:unknown)=>asRecords(value) as MaintenanceRow[]
const clone=(value:MaintenanceRow[])=>value.map(item=>({...item}))
const kinds:Record<string,string>={merge:"合并重复",rewrite:"拆分重写",move:"调整范围",archive:"归档",add:"新增",reinforce:"强化"}
const scope=(value:string)=>({user:"全局",user_group:"本群",group:"群公共"} as Record<string,string>)[value]||value

/** 审阅只面向一个任务；提示项不参与可提交的关联变更组。 */
export const MemoryMaintenanceReview={
  name:"MemoryMaintenanceReview",
  props:{job:{type:Object,required:true},name:{type:String,default:""}},
  emits:["changed","close","open-memory"],
  setup(props:{job:MaintenanceRow;name:string},{emit}:{emit:(name:string,value?:unknown)=>void}){
    const job=ref<MaintenanceRow>(props.job),open=ref(true),busy=ref(false),error=ref("")
    const selected=ref<string[]>([]),drafts=reactive<Record<string,MaintenanceRow[]>>({}),editing=reactive<Record<string,boolean>>({}),sourceTexts=reactive<Record<string,MaintenanceRow>>({}),evidence=reactive<Record<string,MaintenanceRow>>({}),activeId=ref("")
    const baseline=ref(""),dirtyKey=`memory-maintenance:${props.job.id}`
    let seq=0,sourceEpoch=0,timer:ReturnType<typeof setInterval>|undefined,refreshing=false
    const proposals=computed(()=>rows(job.value.plan).filter(p=>p.kind!=="review"&&!p.blocked))
    const notes=computed(()=>rows(job.value.plan).filter(p=>p.kind==="review"&&!p.blocked))
    const issues=computed(()=>rows(job.value.plan).filter(p=>p.blocked))
    const entries=computed(()=>[...proposals.value,...issues.value,...notes.value])
    const active=computed(()=>entries.value.find(p=>p.id===activeId.value)||entries.value[0])
    const pendingIssues=computed(()=>issues.value.filter(p=>p.resolution!=="kept"&&!job.value.reviewedAt))
    const chosen=computed(()=>proposals.value.filter(p=>selected.value.includes(p.id)))
    const effect=computed(()=>chosen.value.reduce((sum,p)=>({archived:sum.archived+(p.kind==="reinforce"?0:rows(p.before).length),created:sum.created+(p.kind==="reinforce"?0:rows(drafts[p.id]).length),reinforced:sum.reinforced+(p.kind==="reinforce"?1:0)}),{archived:0,created:0,reinforced:0}))
    const committed=(p:MaintenanceRow)=>job.value.status==="applied"&&rows(job.value.receipt?.groups).some(g=>g.id===p.id)
    const decision=(p:MaintenanceRow)=>job.value.status==="undone"?"已撤销":committed(p)?"已提交":canReview.value?(selected.value.includes(p.id)?"已选待提交":"本次不提交"):job.value.status==="applied"&&job.value.receipt?.groups?"未采用":"分析原稿"
    const fate=(p:MaintenanceRow)=>job.value.status==="undone"?"已撤销 · 原件已恢复":committed(p)?"已归档 · 原件保留":canReview.value?"提交后归档 · 保留原件":"分析建议 · 尚未应用"
    const entryTitle=(p:MaintenanceRow)=>String(rows(p.before)[0]?.text||rows(p.outputs)[0]?.text||p.issue||p.reason||"范围关联异常")
    const effectLabel=(p:MaintenanceRow)=>p.kind==="archive"?`${rows(p.before).length} 条退出召回`:p.kind==="reinforce"?"保留原记忆，补充证据":`${rows(p.before).length} 条原件 → ${rows(drafts[p.id]).length} 条结果`
    const state=computed(()=>maintenanceTaskState(job.value)),working=computed(()=>maintenanceActive(job.value.status))
    const usageSummary=computed(()=>{
      if(!job.value.progress.usage)return ""
      const usage=asRecord(job.value.progress.usage)
      const counter=(key:string)=>usage[`${key}Known`]===true?`${usage[key]}（上游）`:usage.source==="estimated"?`${usage[key]}（估算）`:"未提供"
      return `本次用量：输入 ${counter("input")}，输出 ${counter("output")}，合计 ${counter("total")} Token。`
    })
    const canReview=computed(()=>job.value.status==="ready"&&!job.value.reviewedAt)
    const dirty=computed(()=>canReview.value&&baseline.value!==JSON.stringify([selected.value,drafts]))
    const scopeOptions=computed(()=>job.value.userId?[{value:"user",label:"全局记忆"},{value:"user_group",label:"当前群个人记忆"}]:[{value:"group",label:"群公共记忆"}])
    watch(dirty,value=>setDirtyScope(dirtyKey,value))
    function adopt(next:MaintenanceRow){
      const reset=job.value.id!==next.id||job.value.status!==next.status||job.value.reviewedAt!==next.reviewedAt||!baseline.value
      job.value=next
      if(reset){
        sourceEpoch++
        selected.value=rows(next.plan).filter(p=>p.kind!=="review"&&!p.blocked&&p.selected).map(p=>p.id)
        for(const key of Object.keys(drafts))delete drafts[key]
        for(const key of Object.keys(editing))delete editing[key]
        for(const key of Object.keys(sourceTexts))delete sourceTexts[key]
        for(const key of Object.keys(evidence))delete evidence[key]
        for(const p of rows(next.plan))if(p.kind!=="review"&&!p.blocked)drafts[p.id]=clone(rows(rows(next.receipt?.groups).find(g=>g.id===p.id)?.outputs||p.outputs))
        baseline.value=JSON.stringify([selected.value,drafts])
      }
    }
    adopt(props.job)
    async function refresh(){
      if(refreshing)return
      refreshing=true
      const token=seq
      try{
        const result=await request(`/api/memory/maintenance/jobs/${encodeURIComponent(job.value.id)}`)
        if(token===seq){adopt(asRecord(result.job));emit("changed",job.value)}
      }catch(e){if(token===seq)error.value=errorMessage(e)}finally{refreshing=false}
    }
    async function close(){
      if(busy.value)return
      if(dirty.value&&!await confirmAction({title:"放弃未提交的选择和编辑？",message:"分析建议仍保留在整理任务中，本次编辑不会应用。",confirmText:"放弃草稿",tone:"warn"}))return
      open.value=false
      await nextTick()
      emit("close")
    }
    async function openMemory(memory?:MaintenanceRow){
      if(busy.value)return
      if(dirty.value&&!await confirmAction({title:"前往记忆页？",message:"未提交的整理编辑将放弃，分析建议仍会保留。",confirmText:"放弃草稿并前往",tone:"warn"}))return
      setDirtyScope(dirtyKey,false);emit("open-memory",{...job.value,memory})
    }
    function toggleChoice(p:MaintenanceRow){if(canReview.value&&!busy.value&&!p.blocked&&p.kind!=="review")selected.value=selected.value.includes(p.id)?selected.value.filter(id=>id!==p.id):[...selected.value,p.id]}
    function toggleEdit(p:MaintenanceRow){if(canReview.value&&!busy.value)editing[p.id]=!editing[p.id]}
    function editText(p:MaintenanceRow,index:number,value:string){drafts[p.id][index].text=value;drafts[p.id][index].factValue=value.trim()}
    async function action(name:string,body:MaintenanceRow={}){
      if(busy.value)return
      busy.value=true;error.value=""
      const token=++seq
      try{
        const result=await request(`/api/memory/maintenance/jobs/${encodeURIComponent(job.value.id)}/${name}`,{method:"POST",body:JSON.stringify(body)})
        if(token!==seq)return
        adopt(asRecord(result.job));if(["apply","undo","dismiss"].includes(name))setDirtyScope(dirtyKey,false);emit("changed",job.value)
        if(["apply","undo","dismiss"].includes(name))toast(({apply:"所选变更已应用",undo:"本次变更已撤销",dismiss:"已保留原记忆，审阅已结束"} as Record<string,string>)[name],"success")
      }catch(e){if(token===seq){error.value=errorMessage(e);await refresh()}}finally{busy.value=false}
    }
    async function apply(){
      if(!canReview.value||!selected.value.length||busy.value)return
      if(!await confirmAction({title:`提交已选的 ${selected.value.length} 组变更？`,message:`将归档 ${effect.value.archived} 条原件，新增 ${effect.value.created} 条结果${effect.value.reinforced?`，补充 ${effect.value.reinforced} 条记忆的证据`:""}。未选建议与 ${pendingIssues.value.length} 项待处理异常保持原样，可继续单独处理。`,confirmText:"确认提交",tone:"warn"}))return
      const edits:MaintenanceRow={}
      for(const id of selected.value)if(JSON.stringify(drafts[id])!==JSON.stringify(proposals.value.find(p=>p.id===id)?.outputs))edits[id]=drafts[id]
      await action("apply",{selectedIds:selected.value,edits})
    }
    async function dismiss(){
      if(!canReview.value||busy.value)return
      if(!await confirmAction({title:"保留原记忆并结束审阅？",message:"本次建议将移入已结束，不会修改任何记忆；分析记录仍可查看。",confirmText:"保留原样",tone:"warn"}))return
      await action("dismiss")
    }
    async function undo(){if(!busy.value&&await confirmAction({title:"撤销本次记忆变更？",message:"会检查后续修改；资料已变化或到期时不会强行恢复。",confirmText:"确认撤销",tone:"warn"}))await action("undo")}
    async function loadSource(id:string){
      if(!job.value.useHistory)return
      const token=sourceEpoch
      try{
        const result=await request(`/api/memory/maintenance/jobs/${encodeURIComponent(job.value.id)}/sources/${encodeURIComponent(id)}`)
        if(token===sourceEpoch)sourceTexts[id]=asRecord(result.source)
      }catch(e){if(token===sourceEpoch)error.value=errorMessage(e)}
    }
    async function loadEvidence(memoryId:string,page=1){
      const previous=evidence[memoryId]||{items:[],total:0,page:0}
      if(previous.loading||(page===1&&previous.loaded&&!previous.error))return
      const token=sourceEpoch
      evidence[memoryId]={...previous,loading:true,error:""}
      try{
        const result=await request(`/api/memory/maintenance/jobs/${encodeURIComponent(job.value.id)}/memories/${encodeURIComponent(memoryId)}/evidence?page=${page}`)
        if(token===sourceEpoch){const next=asRecord(result.evidence);evidence[memoryId]={...next,items:page>1?[...rows(previous.items),...rows(next.items)]:rows(next.items),loaded:true,loading:false,error:""}}
      }catch(e){if(token===sourceEpoch)evidence[memoryId]={...previous,loading:false,error:errorMessage(e)}}
    }
    function keepIssue(p:MaintenanceRow){return action(`issues/${encodeURIComponent(p.id)}/keep`)}
    onMounted(()=>{timer=setInterval(()=>{if(working.value&&!busy.value)void refresh()},1500)})
    onUnmounted(()=>{seq++;sourceEpoch++;clearInterval(timer);setDirtyScope(dirtyKey,false)})
    return{job,open,busy,error,selected,drafts,editing,sourceTexts,proposals,notes,issues,pendingIssues,entries,activeId,active,chosen,effect,committed,decision,fate,entryTitle,effectLabel,evidence,loadEvidence,keepIssue,state,working,usageSummary,canReview,scopeOptions,kinds,scope,stamp:maintenanceStamp,close,openMemory,refresh,toggleChoice,toggleEdit,editText,action,apply,dismiss,undo,loadSource}
  },
  template:`
    <SideDrawer :open="open" :title="name || (job.userId ? '成员记忆' : '群公共记忆')" :subtitle="stamp(job.createdAt) + ' · ' + (job.useHistory ? '参考本群历史' : '仅整理已有记忆')" icon="sparkles" width="1180px" @close="close">
      <header class="maintenance-review-heading"><span class="badge maintenance-status" :class="state.tone">{{ state.label }}</span><span class="muted small">逐组对比，确认后提交</span><button class="btn small ghost" type="button" :disabled="busy" @click="refresh">刷新</button></header>
      <div class="maintenance-review-summary" aria-label="本次提交概览">
        <div><strong>{{ canReview ? selected.length : job.receipt.applied || 0 }}</strong><span>{{ canReview ? '已选变更组' : '已提交变更组' }}</span></div>
        <div><strong>{{ canReview ? effect.archived : job.receipt.archived || 0 }}</strong><span>原件归档</span></div>
        <div><strong>{{ canReview ? effect.created : job.receipt.created || 0 }}</strong><span>新增结果</span></div>
        <div :class="{'has-issues': pendingIssues.length}"><strong>{{ pendingIssues.length }}</strong><span>待单独处理</span></div>
      </div>
      <details class="maintenance-material-detail"><summary>取材与用量 · 已有记忆 {{ job.progress.memoryCount || 0 }} 条 · {{ job.useHistory ? '参考原文 ' + (job.progress.messageCount || 0) + ' 条' : '未参考聊天原文' }}</summary><p v-if="job.useHistory">数据库 {{ job.progress.databaseCount || 0 }} 条，历史补充 {{ job.progress.historyCount || 0 }} 条；扫描 {{ job.progress.historyScanned || 0 }} 条群消息。</p><p v-if="job.progress.from">发言时间：{{ stamp(job.progress.from) }} 至 {{ stamp(job.progress.to) }}</p><p v-if="job.progress.inputTokens">预计输入 {{ job.progress.inputTokens }} / {{ job.progress.tokenLimit }} Token；单次分析。</p><p v-if="usageSummary">{{ usageSummary }}</p></details>
      <div v-if="job.progress.review?.complete === false" class="maintenance-partial" role="status"><Icon name="info" :size="18" /><div><strong>{{ pendingIssues.length ? '部分内容需要你单独处理' : '异常部分已保留原样' }}</strong><p>记忆已准确匹配 {{ job.progress.review.memories.matched }} / {{ job.progress.review.memories.expected }} 条。未确认、无法关联或互相冲突的部分已隔离，正常变更可独立提交。</p></div></div>
      <p v-if="job.progress.warning" class="muted small">{{ job.progress.warning }}</p><p v-if="error || job.error" class="error-text" role="alert">{{ error || job.error }}</p>
      <div v-if="working" class="maintenance-outcome" role="status"><Icon name="refresh" :size="24" class="icon-spin" /><h3>{{ job.progress.stage || state.label }}</h3><p>分析在后台继续，完成后可逐组审阅。</p></div>
      <div v-else-if="job.status === 'ready' && !entries.length" class="maintenance-outcome"><Icon name="check" :size="24" /><h3>分析完成，无需变更</h3><p>本次没有生成需要应用的建议，原记忆保持原样。</p></div>
      <div v-if="job.reviewedAt" class="maintenance-result"><p>已保留原样并结束审阅。{{ stamp(job.reviewedAt) }}</p></div>
      <div v-if="['applied','undone'].includes(job.status)" class="maintenance-result"><p>{{ job.status === 'undone' ? '本次变更已撤销。' : '选中的变更已应用。' }} 原提交 {{ job.receipt.applied }} 组，新增结果 {{ job.receipt.created }} 条，归档原件 {{ job.receipt.archived }} 条。</p><p v-if="pendingIssues.length">{{ pendingIssues.length }} 项异常仍保留原样，可继续单独处理。</p><p class="muted small">撤销截止 {{ stamp(job.undoUntil) }}。</p></div>
      <div v-if="entries.length && !working" class="maintenance-review-layout">
        <nav class="maintenance-change-nav" aria-label="变更清单">
          <template v-for="section in [{label:'可应用变更',items:proposals},{label:'需人工处理',items:issues},{label:'仅供核对',items:notes}]" :key="section.label">
            <h3 v-if="section.items.length">{{ section.label }} <span>{{ section.items.length }}</span></h3>
            <div v-for="p in section.items" :key="p.id" class="maintenance-nav-row" :class="{'is-active': active?.id === p.id,'is-blocked':p.blocked}">
              <label v-if="canReview && !p.blocked && p.kind !== 'review'" class="maintenance-stage-check"><input class="ui-check-box" type="checkbox" v-model="selected" :value="p.id" :disabled="busy" :aria-label="'选择变更：' + entryTitle(p)" /></label>
              <button type="button" :aria-current="active?.id === p.id ? 'true' : undefined" @click="activeId = p.id"><span class="maintenance-nav-kind">{{ p.blocked ? (p.resolution === 'kept' || job.reviewedAt ? '已保留原样' : '待单独处理') : kinds[p.kind] || '核对提示' }}<small v-if="!p.blocked && p.needsReview">需核对</small></span><span class="maintenance-nav-text">{{ entryTitle(p) }}</span><small v-if="!p.blocked && p.kind !== 'review'">{{ effectLabel(p) }}</small></button>
            </div>
          </template>
        </nav>
        <section v-if="active" class="maintenance-diff-panel" aria-label="变更详情">
          <header class="maintenance-diff-heading"><div><span class="maintenance-eyebrow">{{ active.blocked ? '已隔离的异常' : active.kind === 'review' ? '仅供核对' : '记忆变更' }}</span><h3>{{ active.blocked ? kinds[active.requestedKind] || '资料关联异常' : kinds[active.kind] || '核对提示' }}</h3></div><span v-if="active.blocked" class="badge">{{ active.resolution === 'kept' || job.reviewedAt ? '已保留原样' : '不会自动应用' }}</span><span v-else-if="active.kind === 'review'" class="badge">原记忆保持不变</span><span v-else class="badge" :class="selected.includes(active.id) && canReview ? 'on' : ''">{{ decision(active) }}</span></header>
          <p v-if="active.blocked" class="maintenance-issue-message">{{ active.issue }}</p>
          <div class="maintenance-diff-columns">
            <section class="maintenance-diff-side before"><header><strong>处理前</strong><span>{{ active.before.length }} 条原记忆</span></header>
              <article v-for="old in active.before" :key="old.id" class="maintenance-diff-record"><div class="maintenance-record-meta"><span>{{ scope(old.scope) }}</span><span>置信度 {{ Math.round(old.confidence * 100) }}%</span></div><p>{{ old.text }}</p><small v-if="old.expiresAt">有效期至 {{ stamp(old.expiresAt) }}</small><small v-else-if="old.lastConfirmedAt">最近确认 {{ stamp(old.lastConfirmedAt) }}</small><span v-if="!active.blocked && !['review','reinforce'].includes(active.kind)" class="maintenance-record-fate">{{ fate(active) }}</span><button v-if="active.blocked" class="btn small ghost" type="button" :disabled="busy" @click="openMemory(old)">单独查看 / 编辑这条记忆</button></article>
              <p v-if="!active.before.length" class="maintenance-diff-empty">{{ active.blocked ? '没有能准确关联的原记忆。请到记忆页人工核对，不会猜测对应关系。' : '本组没有原记忆，将依据参考原文新增。' }}</p>
            </section>
            <section class="maintenance-diff-side after" :class="{'is-isolated':active.blocked}"><header><strong>{{ active.blocked ? '未采用的建议' : committed(active) ? '提交结果' : '处理后' }}</strong><span>{{ active.blocked ? '仅供人工参考' : active.kind === 'archive' ? '不再参与召回' : active.kind === 'review' ? '保持原样' : (drafts[active.id]?.length || 0) + ' 条结果' }}</span></header>
              <div v-if="active.blocked" class="maintenance-diff-empty"><p v-for="(text,index) in active.previewTexts" :key="index">{{ text }}</p><p>该组尚未写入。可保留原样，或在记忆页单独处理。</p></div>
              <div v-else-if="active.kind === 'archive'" class="maintenance-archive-result"><Icon name="database" :size="24" /><strong>{{ active.before.length }} 条原件{{ committed(active) ? '已归档' : '将移入归档' }}</strong><p>退出日常召回，保留记忆正文和已有来源。</p><small>不新增替代记忆；提交后可在保留期内撤销。</small></div>
              <div v-else-if="active.kind === 'review'" class="maintenance-diff-empty"><strong>仅供核对，不会修改记忆</strong><p>以下提示保留原样，需要修改时可前往对应记忆页。</p></div>
              <template v-else>
                <article v-for="(output,index) in drafts[active.id]" :key="index" class="maintenance-diff-record"><div class="maintenance-record-meta"><span>{{ scope(output.scope) }}</span><span>{{ active.kind === 'reinforce' ? '补充证据' : '保留为新结果' }}</span></div>
                  <template v-if="canReview && editing[active.id]"><Field label="建议内容" type="textarea" :rows="4" :disabled="busy" :model-value="output.text" @update:model-value="value => editText(active,index,value)" /><Field label="适用范围" type="select" v-model="output.scope" :disabled="busy" :options="scopeOptions" /><details><summary>事实分类与归纳值</summary><Field label="稳定事实键" v-model="output.factKey" :disabled="busy" /><Field label="事实值" v-model="output.factValue" :disabled="busy" /></details></template><p v-else>{{ output.text }}</p>
                </article><p class="maintenance-diff-footnote">{{ active.kind === 'reinforce' ? '保留原记忆及适用范围，只补充新的原文证据。' : '原件与已有来源保留，整组结果一起生效。' }}</p>
              </template>
            </section>
          </div>
          <div class="maintenance-diff-actions"><button v-if="canReview && !active.blocked && active.kind !== 'review'" class="btn small outline" type="button" :disabled="busy" @click="toggleChoice(active)">{{ selected.includes(active.id) ? '本组保留原样' : '加入本次提交' }}</button><span v-if="!active.blocked && active.kind !== 'review'" class="small">{{ effectLabel(active) }}</span><button v-if="canReview && active.outputs.length && !active.blocked" class="btn small outline" type="button" :disabled="busy" @click="toggleEdit(active)">{{ editing[active.id] ? '完成编辑' : '编辑处理结果' }}</button><button v-if="active.blocked && !active.resolution && !job.reviewedAt && ['ready','applied','undone'].includes(job.status)" class="btn small outline" type="button" :disabled="busy" @click="keepIssue(active)">这项保留原样</button><button v-if="active.blocked || active.kind === 'review'" class="btn small ghost" type="button" :disabled="busy" @click="openMemory()">前往对应记忆页</button></div>
          <p v-if="active.blocked && canReview && proposals.length" class="muted small maintenance-manual-hint">可先提交正常变更，再单独处理异常。直接编辑原记忆后，尚未提交的预览需要重新分析。</p>
          <section v-if="active.reason" class="maintenance-reason"><h4>为什么这样整理</h4><p>{{ active.reason }}</p></section>
          <section class="maintenance-readable-evidence"><h4>依据与来源</h4><p class="muted small">{{ job.useHistory ? '查看原记忆、已有来源与本次参考发言。' : '本次分析只使用已有记忆。下方原文由你按需展开，仅供人工核对，不发送给模型。' }}</p>
            <details v-for="old in active.before" :key="old.id" class="maintenance-source-group" @toggle="$event.target.open && loadEvidence(old.id)"><summary><span>{{ old.text }}</span><small>{{ old.evidenceCount || 0 }} 条已有来源</small></summary>
              <p v-if="evidence[old.id]?.loading" class="muted small" role="status">正在读取已保存的来源…</p><article v-for="(item,index) in evidence[old.id]?.items || []" :key="index" class="maintenance-source-message"><header><strong>{{ item.senderName || '原文作者' }}</strong><span>{{ item.groupId === job.groupId ? '本群' : '来源群' }}</span><time>{{ stamp(item.sentAt) }}</time></header><p>{{ item.available ? item.text : '原文已清理或不可用，仅保留来源记录。' }}</p></article>
              <p v-if="evidence[old.id]?.loaded && !evidence[old.id].total" class="muted small">没有关联聊天原文。人工维护或平台资料通常没有原文证据。</p><p v-if="evidence[old.id]?.error" class="error-text" role="alert">{{ evidence[old.id].error }}<button class="btn small ghost" type="button" @click="loadEvidence(old.id,evidence[old.id].page + 1)">重试读取</button></p><button v-if="evidence[old.id]?.loaded && evidence[old.id].items.length < evidence[old.id].total" class="btn small outline" type="button" :disabled="evidence[old.id].loading" @click="loadEvidence(old.id,evidence[old.id].page + 1)">加载更多来源（{{ evidence[old.id].items.length }} / {{ evidence[old.id].total }}）</button>
            </details>
            <details v-for="m in active.historyEvidence" :key="m.id" class="maintenance-source-group" @toggle="$event.target.open && loadSource(m.id)"><summary>本次参考发言 · {{ stamp(m.sentAt) }}</summary><article v-if="sourceTexts[m.id]" class="maintenance-source-message"><header><strong>{{ sourceTexts[m.id].authorName || '发言者' }}</strong></header><p>{{ sourceTexts[m.id].available ? sourceTexts[m.id].text : '原文已不可用' }}</p></article></details>
            <p v-if="!active.before.length && !active.historyEvidence.length" class="muted small">没有可核对的记忆或原文；请保留原样并人工处理。</p>
          </section>
        </section>
      </div>
      <template #actions>
        <span v-if="canReview && proposals.length" class="maintenance-submit-summary">已选 {{ selected.length }} 组 · 归档 {{ effect.archived }} 条 · 新增 {{ effect.created }} 条</span>
        <button v-if="working" class="btn outline" type="button" :disabled="busy" @click="action('cancel')">取消分析</button>
        <button v-if="canReview && entries.length" class="btn ghost" type="button" :disabled="busy" @click="dismiss">保留原样，结束审阅</button>
        <button v-if="['failed','cancelled','stale'].includes(job.status)" class="btn outline" type="button" :disabled="busy" @click="action('retry')">重新分析</button>
        <button v-if="job.status === 'applied' && job.undoUntil > Date.now()" class="btn outline" type="button" :disabled="busy" @click="undo">撤销本次提交</button>
        <button class="btn outline" type="button" :disabled="busy" @click="close">关闭</button>
        <button v-if="canReview && proposals.length" class="btn primary" type="button" :disabled="busy || !selected.length" @click="apply">提交已选的 {{ selected.length }} 组变更</button>
      </template>
    </SideDrawer>
`,
}
