import { computed,ref } from "vue"
import { request,toast } from "../../app/store/store.js"
import { asRecord,asRecords,errorMessage } from "../../shared/data.js"

export type MaintenanceRow=Record<string,any>
const rows=(value:unknown)=>asRecords(value) as MaintenanceRow[]
export const maintenanceActive=(status:string)=>["queued","collecting","analyzing"].includes(status)
export const maintenanceStamp=(value:unknown)=>value?new Date(Number(value)).toLocaleString("zh-CN",{hour12:false}):"未记录"
export function maintenanceTaskState(job:MaintenanceRow):{bucket:string;label:string;tone:string;changes:number;notes:number;issues:number}{
  const plan=rows(job.plan),changes=plan.filter(p=>p.kind!=="review"&&!p.blocked).length,notes=plan.filter(p=>p.kind==="review"&&!p.blocked).length
  const issues=job.reviewedAt?0:plan.filter(p=>p.blocked&&p.resolution!=="kept").length
  const counts={changes,notes,issues}
  if(maintenanceActive(job.status))return{bucket:"running",label:({queued:"排队中",collecting:"读取资料",analyzing:"分析中"} as Record<string,string>)[job.status],tone:"on",...counts}
  if(["ready","applied","undone"].includes(job.status)&&issues)return{bucket:"review",label:job.status==="undone"?`已撤销 · ${issues} 项待处理`:job.status==="applied"?`已提交 · ${issues} 项待处理`:`待审核 · ${changes} 组 / ${issues} 项异常`,tone:"warn",...counts}
  if(job.status==="ready"){
    if(job.reviewedAt)return{bucket:"history",label:"已保留原样",tone:"off",...counts}
    if(changes)return{bucket:"review",label:`待审核 · ${changes} 组`,tone:"warn",...counts}
    return{bucket:"history",label:plan.some(p=>p.blocked)?"异常项已保留":notes?"仅供核对":"无需变更",tone:"off",...counts}
  }
  return{bucket:"history",label:({applied:"已应用",undone:"已撤销",cancelled:"已取消",failed:"分析失败",stale:"资料已变化"} as Record<string,string>)[job.status]||job.status,tone:["failed","stale"].includes(job.status)?"bad":"off",...counts}
}

/** 发起入口只创建后台分析，所有进度和审阅集中到整理任务工作区。 */
export const MemoryMaintenanceDialog={
  name:"MemoryMaintenanceDialog",
  props:{groupId:{type:String,required:true},userId:{type:String,default:""},name:{type:String,default:""},batch:{type:Boolean,default:false}},
  emits:["submitted"],
  setup(props:{groupId:string;userId:string;name:string;batch:boolean},{emit}:{emit:(name:string,value:unknown)=>void}){
    const open=ref(false),busy=ref(false),error=ref(""),useHistory=ref(false),count=ref(200),failures=ref<MaintenanceRow[]>([])
    const target=ref({groupId:"",userId:"",name:"",batch:false})
    const title=computed(()=>target.value.batch?"AI 整理全群记忆":target.value.userId?"AI 整理记忆":"AI 整理群记忆")
    const countLabel=computed(()=>target.value.batch?"每个任务参考发言条数":target.value.userId?"参考本人发言条数":"参考全群发言总条数")
    const historyDescription=computed(()=>"默认仅整理已有记忆。开启后"+(target.value.batch?"群公共任务参考当前群所有成员的历史，个人任务只参考本人在本群的消息。":target.value.userId?"只参考该成员在当前群的本人消息。":"参考当前群所有成员的历史消息。")+"先查数据库，不足时从本群最早已存消息向前补录一轮，最多1000条；预算通过后只分析一次。")
    const countDescription=computed(()=>target.value.batch?"1–2000 条；群公共任务按全群总量计数，个人任务按本人发言计数。":target.value.userId?"1–2000 条；只统计本人在当前群的有效发言。":"1–2000 条；统计当前群全体成员的有效发言总量。")
    function show(){target.value={groupId:props.groupId,userId:props.userId,name:props.name||props.userId||"本群公共记忆",batch:props.batch};useHistory.value=false;count.value=200;failures.value=[];error.value="";open.value=true}
    function close(){if(!busy.value)open.value=false}
    function showTasks(){open.value=false;emit("submitted",{groupId:target.value.groupId})}
    async function start(){
      if(busy.value)return
      if(useHistory.value&&(!Number.isInteger(Number(count.value))||Number(count.value)<1||Number(count.value)>2000)){error.value="参考发言条数必须为1至2000的整数。";return}
      busy.value=true;error.value=""
      try{
        const base=`/api/memory/maintenance/groups/${encodeURIComponent(target.value.groupId)}`
        const path=target.value.batch?base:target.value.userId?`${base}/members/${encodeURIComponent(target.value.userId)}`:`${base}/public`
        const result=await request(path,{method:"POST",body:JSON.stringify({useHistory:useHistory.value,...(useHistory.value?{count:Number(count.value)}:{})})})
        failures.value=rows(result.failures)
        const created=target.value.batch?rows(result.jobs):[asRecord(result.job)]
        if(!created.length){error.value="没有成功创建任务，请查看失败原因。";return}
        open.value=false
        emit("submitted",{groupId:target.value.groupId,jobId:created[0].id,failures:failures.value})
        toast(`已创建 ${created.length} 个后台任务，请在整理任务中查看进度和审阅。`,"success")
      }catch(e){error.value=errorMessage(e)}finally{busy.value=false}
    }
    return{open,busy,error,useHistory,count,target,failures,title,countLabel,historyDescription,countDescription,show,close,start,showTasks}
  },
  template:`
    <button class="btn small outline" type="button" @click="show"><Icon name="sparkles" :size="14" />{{ batch ? 'AI 整理全群' : userId ? 'AI 整理记忆' : 'AI 整理群记忆' }}</button>
    <SideDrawer :open="open" :title="title" :subtitle="target.name + ' · 群 ' + target.groupId" icon="sparkles" width="640px" variant="dialog" @close="close">
      <div class="maintenance-intro"><Icon name="sparkles" :size="20" /><div><strong>先分析，再由你决定是否应用</strong><p>任务在后台执行，完成后进入「整理任务」。关闭页面不影响分析，记忆不会自动修改。</p></div></div>
      <section class="maintenance-options">
        <Field label="参考本群历史发言" type="switch" v-model="useHistory" :disabled="busy" :description="historyDescription" />
        <Field v-if="useHistory" :label="countLabel" type="number" v-model="count" :disabled="busy" :description="countDescription" />
        <p class="muted small">{{ target.batch ? '为已记录成员及群公共记忆分别创建任务，每个任务独立调用一次模型、独立审阅。' : target.userId ? '检查本人全局与当前群个人记忆。' : '只检查当前群公共记忆。' }}</p>
      </section>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <p v-for="item in failures" :key="item.userId" class="error-text">{{ item.userId || '群公共记忆' }}：{{ item.error }}</p>
      <template #actions><button class="btn ghost" type="button" :disabled="busy" @click="showTasks">查看整理任务</button><button class="btn outline" type="button" :disabled="busy" @click="close">取消</button><button class="btn primary" type="button" :disabled="busy" @click="start">{{ busy ? '正在创建…' : '开始分析' }}</button></template>
    </SideDrawer>`,
}
