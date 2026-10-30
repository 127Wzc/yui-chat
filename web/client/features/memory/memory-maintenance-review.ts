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
    const selected=ref<string[]>([]),drafts=reactive<Record<string,MaintenanceRow[]>>({}),editing=reactive<Record<string,boolean>>({}),sourceTexts=reactive<Record<string,MaintenanceRow>>({})
    const baseline=ref(""),dirtyKey=`memory-maintenance:${props.job.id}`
    let seq=0,timer:ReturnType<typeof setInterval>|undefined,refreshing=false
    const proposals=computed(()=>rows(job.value.plan).filter(p=>p.kind!=="review"))
    const notes=computed(()=>rows(job.value.plan).filter(p=>p.kind==="review"))
    const state=computed(()=>maintenanceTaskState(job.value)),working=computed(()=>maintenanceActive(job.value.status))
    const canReview=computed(()=>job.value.status==="ready"&&!job.value.reviewedAt)
    const dirty=computed(()=>canReview.value&&baseline.value!==JSON.stringify([selected.value,drafts]))
    const scopeOptions=computed(()=>job.value.userId?[{value:"user",label:"全局记忆"},{value:"user_group",label:"当前群个人记忆"}]:[{value:"group",label:"群公共记忆"}])
    watch(dirty,value=>setDirtyScope(dirtyKey,value))
    function adopt(next:MaintenanceRow){
      const reset=job.value.id!==next.id||job.value.status!==next.status||job.value.reviewedAt!==next.reviewedAt||!baseline.value
      job.value=next
      if(reset){
        selected.value=rows(next.plan).filter(p=>p.kind!=="review"&&p.selected).map(p=>p.id)
        for(const key of Object.keys(drafts))delete drafts[key]
        for(const key of Object.keys(editing))delete editing[key]
        for(const key of Object.keys(sourceTexts))delete sourceTexts[key]
        for(const p of rows(next.plan))if(p.kind!=="review")drafts[p.id]=clone(rows(p.outputs))
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
    async function openMemory(){
      if(busy.value)return
      if(dirty.value&&!await confirmAction({title:"前往记忆页？",message:"未提交的整理编辑将放弃，分析建议仍会保留。",confirmText:"放弃草稿并前往",tone:"warn"}))return
      setDirtyScope(dirtyKey,false);emit("open-memory",job.value)
    }
    function toggleEdit(p:MaintenanceRow){if(canReview.value&&!busy.value)editing[p.id]=!editing[p.id]}
    function editText(p:MaintenanceRow,index:number,value:string){drafts[p.id][index].text=value;drafts[p.id][index].factValue=value.trim()}
    async function action(name:string,body:MaintenanceRow={}){
      if(busy.value)return
      busy.value=true;error.value=""
      const token=++seq
      try{
        const result=await request(`/api/memory/maintenance/jobs/${encodeURIComponent(job.value.id)}/${name}`,{method:"POST",body:JSON.stringify(body)})
        if(token!==seq)return
        adopt(asRecord(result.job));setDirtyScope(dirtyKey,false);emit("changed",job.value)
        if(["apply","undo","dismiss"].includes(name))toast(({apply:"所选变更已应用",undo:"本次变更已撤销",dismiss:"已保留原记忆，审阅已结束"} as Record<string,string>)[name],"success")
      }catch(e){if(token===seq){error.value=errorMessage(e);await refresh()}}finally{busy.value=false}
    }
    async function apply(){
      if(!canReview.value||!selected.value.length||busy.value)return
      if(!await confirmAction({title:`应用选中的 ${selected.value.length} 组变更？`,message:"未选建议保持原样；合并和拆分按关联组整体提交。",confirmText:"确认应用",tone:"warn"}))return
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
      const token=seq
      try{
        const result=await request(`/api/memory/maintenance/jobs/${encodeURIComponent(job.value.id)}/sources/${encodeURIComponent(id)}`)
        if(token===seq)sourceTexts[id]=asRecord(result.source)
      }catch(e){if(token===seq)error.value=errorMessage(e)}
    }
    onMounted(()=>{timer=setInterval(()=>{if(working.value&&!busy.value)void refresh()},1500)})
    onUnmounted(()=>{seq++;clearInterval(timer);setDirtyScope(dirtyKey,false)})
    return{job,open,busy,error,selected,drafts,editing,sourceTexts,proposals,notes,state,working,canReview,scopeOptions,kinds,scope,stamp:maintenanceStamp,close,openMemory,refresh,toggleEdit,editText,action,apply,dismiss,undo,loadSource}
  },
  template:`
    <SideDrawer :open="open" :title="name || (job.userId ? '用户 ' + job.userId : '群公共记忆')" :subtitle="stamp(job.createdAt) + ' · ' + (job.useHistory ? '参考本群历史' : '仅整理已有记忆')" icon="sparkles" width="840px" @close="close">
      <div class="maintenance-review-heading"><span class="badge maintenance-status" :class="state.tone">{{ state.label }}</span><span class="muted small">群 {{ job.groupId }}</span></div>
      <div class="maintenance-materials">
        <span v-if="job.progress.memoryCount != null">已有记忆 <strong>{{ job.progress.memoryCount }}</strong> 条</span>
        <span v-if="job.useHistory">参考发言 <strong>{{ job.progress.messageCount || 0 }} / {{ job.requestedCount }}</strong> 条</span><span v-else>未参考聊天原文</span>
      </div>
      <details v-if="job.useHistory || job.progress.inputTokens" class="maintenance-material-detail"><summary>取材与用量</summary><p v-if="job.useHistory">数据库 {{ job.progress.databaseCount || 0 }} 条，历史补充 {{ job.progress.historyCount || 0 }} 条；扫描 {{ job.progress.historyScanned || 0 }} 条群消息。</p><p v-if="job.progress.from">发言时间：{{ stamp(job.progress.from) }} 至 {{ stamp(job.progress.to) }}</p><p v-if="job.progress.inputTokens">预计输入 {{ job.progress.inputTokens }} / {{ job.progress.tokenLimit }} Token；单次分析。</p></details>
      <p v-if="job.progress.warning" class="muted small">{{ job.progress.warning }}</p>
      <p v-if="error || job.error" class="error-text" role="alert">{{ error || job.error }}</p>
      <div v-if="working" class="maintenance-outcome" role="status"><Icon name="refresh" :size="24" class="icon-spin" /><h3>{{ job.progress.stage || state.label }}</h3><p>分析在后台继续，完成后会进入待审核或已结束。</p></div>
      <div v-else-if="job.status === 'ready' && !proposals.length" class="maintenance-outcome"><Icon :name="notes.length ? 'info' : 'check'" :size="24" /><h3>{{ notes.length ? '仅供核对，不会修改记忆' : '分析完成，无需变更' }}</h3><p>{{ notes.length ? '以下是核对提示，原记忆保持原样。需要修改时，请在记忆页手动编辑。' : '本次没有生成需要应用的建议，原记忆保持原样。' }}</p></div>
      <div v-if="job.reviewedAt" class="maintenance-result"><p>已保留原样并结束审阅。{{ stamp(job.reviewedAt) }}</p></div>
      <div v-if="job.status === 'applied' || job.status === 'undone'" class="maintenance-result"><p>{{ job.status === 'undone' ? '本次变更已撤销。' : '选中的变更已应用。' }} 原提交 {{ job.receipt.applied }} 组，新增结果 {{ job.receipt.created }} 条，归档原件 {{ job.receipt.archived }} 条。</p><p class="muted small">撤销截止 {{ stamp(job.undoUntil) }}。</p></div>
      <section v-if="proposals.length && !working" class="maintenance-preview" aria-label="可应用变更">
        <div class="maintenance-section-heading"><h3>{{ canReview ? '可应用变更' : '分析原稿' }} <span class="muted">{{ proposals.length }}</span></h3><span v-if="canReview" class="muted small">已选 {{ selected.length }} 组</span></div>
        <p v-if="canReview" class="muted small">逐组选择后应用。合并、拆分及其关联记录一起生效。</p>
        <p v-else class="muted small">这里保留最初的分析建议，包含未采用的部分；当前记忆可在记忆页查看。</p>
        <article v-for="p in proposals" :key="p.id" class="maintenance-change">
          <div class="maintenance-section-heading"><label v-if="canReview" class="row"><input class="ui-check-box" type="checkbox" v-model="selected" :value="p.id" :disabled="busy" /><strong>{{ kinds[p.kind] }}</strong></label><strong v-else>{{ kinds[p.kind] }}</strong><span v-if="p.needsReview" class="badge">请核对后选择</span></div>
          <p v-for="old in p.before" :key="old.id" class="maintenance-original"><span class="muted tiny">原 · {{ scope(old.scope) }} · 置信度 {{ Math.round(old.confidence * 100) }}%</span><br />{{ old.text }}</p>
          <template v-if="canReview && editing[p.id]">
            <section v-for="(output,index) in drafts[p.id]" :key="index" class="maintenance-output">
              <Field label="建议内容" type="textarea" :rows="3" :disabled="busy" :model-value="output.text" @update:model-value="value => editText(p,index,value)" />
              <Field label="适用范围" type="select" v-model="output.scope" :disabled="busy" :options="scopeOptions" />
              <details><summary>事实分类与归纳值</summary><Field label="稳定事实键" v-model="output.factKey" :disabled="busy" /><Field label="事实值" v-model="output.factValue" :disabled="busy" /></details>
            </section><p class="muted small">保留全部拆分结果与来源；改写会标为人工修订。</p>
          </template>
          <template v-else><div v-for="(output,index) in drafts[p.id]" :key="index" class="maintenance-proposed"><span class="muted tiny">建议 · {{ scope(output.scope) }}</span><p>{{ output.text }}</p></div></template>
          <p v-if="p.kind === 'archive'" class="muted small">归档后退出召回，保留原件。</p><p class="muted small">{{ p.reason }}</p>
          <div v-if="canReview && p.outputs.length"><button class="btn small ghost" type="button" :disabled="busy" @click="toggleEdit(p)">{{ editing[p.id] ? '结束编辑' : '编辑建议' }}</button></div>
          <details class="maintenance-evidence"><summary>查看依据与来源</summary><p v-for="e in p.evidence" :key="e.id" class="muted small">{{ e.type }} · {{ e.id }}</p><p v-if="!p.evidence.length && !p.historyEvidence.length" class="muted small">依据已有记忆，无可用原文证据。</p><div v-for="m in p.historyEvidence" :key="m.id"><button class="btn small ghost" type="button" @click="loadSource(m.id)">查看发言原文 · {{ stamp(m.sentAt) }}</button><p v-if="sourceTexts[m.id]">{{ sourceTexts[m.id].available ? sourceTexts[m.id].text : '原文已不可用' }}</p></div></details>
        </article>
      </section>
      <details v-if="notes.length && !working" class="maintenance-notes" :open="!proposals.length"><summary>仅供核对 <span>{{ notes.length }} 条</span><small>原记忆保持不变</small></summary><div class="maintenance-note-list"><article v-for="p in notes" :key="p.id" class="maintenance-note"><p v-for="old in p.before" :key="old.id"><span class="muted tiny">{{ scope(old.scope) }}</span><br />{{ old.text }}</p><p class="muted small">{{ p.reason }}</p><details class="maintenance-evidence"><summary>查看依据与来源</summary><p v-for="e in p.evidence" :key="e.id" class="muted small">{{ e.type }} · {{ e.id }}</p><p v-if="!p.evidence.length && !p.historyEvidence.length" class="muted small">无可用原文证据，保持现状。</p><div v-for="m in p.historyEvidence" :key="m.id"><button class="btn small ghost" type="button" @click="loadSource(m.id)">查看发言原文 · {{ stamp(m.sentAt) }}</button><p v-if="sourceTexts[m.id]">{{ sourceTexts[m.id].available ? sourceTexts[m.id].text : '原文已不可用' }}</p></div></details></article></div></details>
      <template #actions>
        <button v-if="notes.length || ['applied','undone'].includes(job.status)" class="btn ghost" type="button" :disabled="busy" @click="openMemory">查看对应记忆</button>
        <button v-if="working" class="btn outline" type="button" :disabled="busy" @click="action('cancel')">取消分析</button>
        <button v-if="canReview && (proposals.length || notes.length)" class="btn outline" type="button" :disabled="busy" @click="dismiss">保留原样，结束审阅</button>
        <button v-if="['failed','cancelled','stale'].includes(job.status)" class="btn outline" type="button" :disabled="busy" @click="action('retry')">重新分析</button>
        <button v-if="job.status === 'applied' && job.undoUntil > Date.now()" class="btn outline" type="button" :disabled="busy" @click="undo">撤销本次变更</button>
        <button class="btn outline" type="button" :disabled="busy" @click="close">关闭</button>
        <button v-if="canReview && proposals.length" class="btn primary" type="button" :disabled="busy || !selected.length" @click="apply">应用选中的 {{ selected.length }} 组变更</button>
      </template>
    </SideDrawer>`,
}
