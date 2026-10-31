import { computed,onMounted,onUnmounted,ref,watch } from "vue"
import { request } from "../../app/store/store.js"
import { asRecord,asRecords,errorMessage } from "../../shared/data.js"
import { MemoryGroupPicker } from "./memory-group-picker.js"
import { MemoryMaintenanceDialog,maintenanceActive,maintenanceStamp,maintenanceTaskState } from "./memory-maintenance.js"
import { MemoryMaintenanceReview } from "./memory-maintenance-review.js"
import type { MaintenanceRow } from "./memory-maintenance.js"

/** 按当前群集中查看异步任务，待核对提示与无变更结果不挤占待审核队列。 */
export const MemoryMaintenanceWorkspace={
  name:"MemoryMaintenanceWorkspace",
  components:{MemoryGroupPicker,MemoryMaintenanceDialog,MemoryMaintenanceReview},
  props:{view:{type:Object,required:true},seed:{type:Object,default:()=>({})}},
  emits:["changed"],
  setup(props:{view:MaintenanceRow;seed:MaintenanceRow},{emit}:{emit:(name:string)=>void}){
    const jobs=ref<MaintenanceRow[]>([]),filter=ref("review"),query=ref(""),loading=ref(false),error=ref(""),selected=ref<MaintenanceRow|null>(null),opening=ref("")
    const submission=ref(props.seed)
    let seq=0,timer:ReturnType<typeof setInterval>|undefined,pending=false
    const counts=computed(()=>jobs.value.reduce((sum,job)=>{sum[maintenanceTaskState(job).bucket]++;return sum},{review:0,running:0,history:0} as Record<string,number>))
    const filters=computed(()=>[{value:"review",label:`待审核 ${counts.value.review}`},{value:"running",label:`进行中 ${counts.value.running}`},{value:"history",label:`已结束 ${counts.value.history}`}])
    function targetName(job:MaintenanceRow):string{
      if(!job.userId)return "群公共记忆"
      const member=(props.view.members as MaintenanceRow[]||[]).find(item=>String(item.userId)===String(job.userId))
      return member?String(props.view.memberTitle(member)):String(job.userId)
    }
    const visible=computed(()=>{
      const term=query.value.trim().toLowerCase()
      return jobs.value.filter(job=>maintenanceTaskState(job).bucket===filter.value&&(!term||`${targetName(job)} ${job.userId} ${job.id}`.toLowerCase().includes(term)))
    })
    const empty=computed(()=>query.value.trim()?"没有匹配的整理任务。":({review:"暂无待审核变更。仅供核对和无需变更的结果可在「已结束」查看。",running:"当前没有进行中的分析。",history:"暂无已结束的任务。"} as Record<string,string>)[filter.value])
    async function refresh(quiet=false){
      const group=props.view.selectedGroupId,token=seq
      if(!group||pending)return
      pending=true
      if(!quiet)loading.value=true
      try{
        const result=await request(`/api/memory/maintenance/groups/${encodeURIComponent(group)}`)
        if(token!==seq)return
        jobs.value=asRecords(result.jobs) as MaintenanceRow[];error.value=""
        if(submission.value.jobId){
          const created=jobs.value.find(item=>item.id===submission.value.jobId)
          if(created){filter.value=maintenanceTaskState(created).bucket;submission.value={...submission.value,jobId:""}}
        }
      }catch(e){if(token===seq)error.value=errorMessage(e)}finally{if(token===seq){pending=false;loading.value=false}}
    }
    async function submitted(value:MaintenanceRow){seq++;pending=false;submission.value=value;await refresh()}
    async function open(job:MaintenanceRow){
      if(opening.value)return
      const token=seq;opening.value=job.id;error.value=""
      try{
        const result=await request(`/api/memory/maintenance/jobs/${encodeURIComponent(job.id)}`)
        if(token===seq)selected.value=asRecord(result.job)
      }catch(e){if(token===seq)error.value=errorMessage(e)}finally{if(token===seq)opening.value=""}
    }
    function changed(next:MaintenanceRow){
      const previous=jobs.value.find(item=>item.id===next.id)
      if(previous?.status!==next.status||previous?.reviewedAt!==next.reviewedAt||maintenanceTaskState(previous||{}).issues!==maintenanceTaskState(next).issues){seq++;pending=false;loading.value=false}
      jobs.value=jobs.value.map(item=>item.id===next.id?next:item)
      if(["applied","undone"].includes(next.status))emit("changed")
    }
    async function openMemory(job:MaintenanceRow){
      await props.view.switchWorkspace("manage")
      if(props.view.activeWorkspace&&props.view.activeWorkspace!=="manage")return
      selected.value=null
      if(job.userId)await props.view.selectMember((props.view.members as MaintenanceRow[]||[]).find(member=>member.userId===job.userId)||{userId:job.userId})
      else props.view.selectedMember=null
      if(job.userId&&job.memory)props.view.memberScope=job.memory.scope
      if(job.memory)props.view.openMemoryEditor(job.memory,{scopeType:job.memory.scope,ownerId:job.userId||job.groupId,groupId:job.groupId})
    }
    watch(()=>props.view.selectedGroupId,()=>{seq++;pending=false;jobs.value=[];selected.value=null;opening.value="";query.value="";error.value="";submission.value={};void refresh()})
    watch(()=>props.seed,value=>{void submitted(value)})
    onMounted(()=>{void refresh();timer=setInterval(()=>{if(jobs.value.some(job=>maintenanceActive(job.status)))void refresh(true)},2000)})
    onUnmounted(()=>{seq++;clearInterval(timer)})
    return{jobs,filter,query,loading,error,selected,opening,submission,counts,filters,visible,empty,targetName,state:maintenanceTaskState,stamp:maintenanceStamp,refresh,submitted,open,changed,openMemory}
  },
  template:`
    <section class="maintenance-workspace">
      <header class="group-memory-toolbar"><MemoryGroupPicker :view="view" /><button class="icon-btn" type="button" :disabled="loading || !view.selectedGroupId" aria-label="刷新整理任务" @click="refresh()"><Icon name="refresh" :size="16" :class="{'icon-spin': loading}" /></button><div v-if="view.selectedGroupId" class="maintenance-create-actions"><MemoryMaintenanceDialog :group-id="view.selectedGroupId" name="本群公共记忆" @submitted="submitted" /><MemoryMaintenanceDialog :group-id="view.selectedGroupId" :batch="true" name="本群已记录成员及公共记忆" @submitted="submitted" /></div></header>
      <div v-if="view.selectedGroupId" class="maintenance-task-body">
        <header class="maintenance-task-heading"><div><h2>整理任务</h2><p>分析与记忆分开管理，只有你应用后才会修改记忆。</p></div><span class="muted small">预览保留 24 小时 · 应用记录保留 7 天</span></header>
        <div v-if="submission.failures?.length" class="maintenance-failures" role="alert"><strong>部分任务未创建</strong><p v-for="item in submission.failures" :key="item.userId">{{ item.userId || '群公共记忆' }}：{{ item.error }}</p></div>
        <div class="maintenance-task-tools"><SectionNav v-model="filter" :items="filters" label="整理任务状态" variant="tabs" /><SearchInput v-model="query" placeholder="搜索成员或任务编号" /></div>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
        <p v-if="loading && !jobs.length" class="muted" role="status">正在读取整理任务…</p>
        <PagedList v-else :key="filter + query" :rows="visible" :page-size="8" label="个任务" list-class="maintenance-task-list" :empty="empty">
          <template #default="{ item }"><article class="maintenance-task-row">
            <div class="maintenance-task-identity"><span class="maintenance-task-icon"><Icon :name="item.userId ? 'message' : 'database'" :size="18" /></span><div><h3>{{ targetName(item) }}</h3><p class="muted small">{{ item.userId ? '个人全局与本群记忆' : '本群公共记忆' }}<span v-if="item.userId && targetName(item) !== item.userId"> · {{ item.userId }}</span></p></div></div>
            <div class="maintenance-task-meta"><time :datetime="new Date(item.createdAt).toISOString()">{{ stamp(item.createdAt) }}</time><span>{{ item.useHistory ? '参考本群历史' : '仅整理已有记忆' }}</span><span class="maintenance-task-id" :title="item.id">任务 {{ item.id }}</span></div>
            <div class="maintenance-task-status"><span class="badge maintenance-status" :class="state(item).tone">{{ state(item).label }}</span><small v-if="state(item).bucket === 'running'">{{ item.progress.stage || '后台执行中' }}</small><small v-else-if="state(item).issues">{{ state(item).issues }} 项异常待单独处理 · 正常变更可独立提交</small><small v-else-if="item.status === 'applied'">已应用 {{ item.receipt.applied }} 组</small><small v-else-if="state(item).notes">{{ state(item).notes }} 条核对提示 · 提示项保留原样</small><small v-else-if="item.status === 'failed' || item.status === 'stale'">打开查看原因</small><small v-else-if="state(item).label === '无需变更'">原记忆保持不变</small></div>
            <button class="btn small" :class="state(item).bucket === 'review' ? 'primary' : 'outline'" type="button" :disabled="Boolean(opening)" @click="open(item)">{{ opening === item.id ? '正在打开…' : state(item).bucket === 'review' ? '审阅变更' : state(item).bucket === 'running' ? '查看进度' : '查看结果' }}</button>
          </article></template>
        </PagedList>
        <p class="maintenance-task-footnote muted small">仅供核对、无需变更及已处理的任务收在「已结束」，不计入待审核。</p>
        <p v-if="jobs.length >= 250" class="muted small">显示当前群最近的 250 个任务。</p>
      </div>
      <div v-else class="memory-list-empty"><Icon name="database" :size="24" /><span>选择群聊后查看整理任务。</span></div>
      <MemoryMaintenanceReview v-if="selected" :key="selected.id" :job="selected" :name="targetName(selected)" @changed="changed" @close="selected = null" @open-memory="openMemory" />
    </section>`,
}
