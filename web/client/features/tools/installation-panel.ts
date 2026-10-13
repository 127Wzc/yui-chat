import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue"
import { confirmAction, request, setDirtyScope, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"

interface Task extends UnknownRecord { id: string; version: number; kind: string; status: string; currentStep: string; sourceIdentity: string; reasonCode?: string; origin?: { entry: string; id: string }; plan?: { id: string; targetId: string; digest: string; expiresAt: number }; candidates?: string[]; result?: UnknownRecord }
const terminal = new Set(["succeeded", "failed", "canceled", "expired", "needs_attention"])
const labels: Record<string, string> = { inspecting: "检查中", awaiting_input: "等待输入", awaiting_confirmation: "等待确认", queued: "待提交", installing: "安装中", recovering: "恢复中", succeeded: "成功", failed: "失败", canceled: "已取消", expired: "已过期", needs_attention: "需要处理" }
export const InstallationPanel = {
  name: "InstallationPanel",
  setup() {
    const tasks = ref<Task[]>([]), selected = ref<Task | null>(null), events = ref<UnknownRecord[]>([]), credentials = ref<UnknownRecord[]>([]), networkGrants = ref<UnknownRecord[]>([])
    const busy = ref(false), filter = ref(""), entryFilter = ref(""), kindFilter = ref("")
    const form = reactive({ source: "", kind: "skill", ref: "", subdir: "", transport: "streamableHttp", serviceId: "", upload: "" })
    const secret = reactive({ alias: "", purpose: "repository-read", origin: "", scope: "", value: "", envRef: "" })
    const network = reactive({ url: "", targetId: "", purpose: "mcp-connect", addresses: "", paths: "", ca: "", allowHttpCredentials: false })
    const binding = reactive({ credentialId: "", subdir: "", serviceId: "", networkGrantId: "" })
    const hasMore = ref(true)
    const managementOpen = ref(false)
    let timer: ReturnType<typeof setTimeout> | undefined, sequence = 0, detailVersion = 0, failures = 0, disposed = false
    let requestKey = crypto.randomUUID()
    const rows = computed(() => tasks.value.filter(task => (!filter.value || task.status === filter.value) && (!entryFilter.value || task.origin?.entry === entryFilter.value) && (!kindFilter.value || task.kind === kindFilter.value)))
    watch([form, secret, network], () => setDirtyScope("extension-installation", Boolean(form.source || form.upload || secret.value || secret.envRef || network.url)), { deep: true })
    async function post(url: string, body: unknown = {}, idempotent = false) {
      return request(url, { method: "POST", headers: idempotent ? { "Idempotency-Key": requestKey } : {}, body: JSON.stringify(body) })
    }
    async function reload() {
      const result = await request("/api/extensions/installations?limit=100")
      const recent = asRecords<Task>(result.tasks)
      const seen = new Set(recent.map(task => task.id))
      if (!tasks.value.length) hasMore.value = recent.length === 100
      tasks.value = [...recent, ...tasks.value.filter(task => !seen.has(task.id))]
      const refreshed = recent.find(task => task.id === selected.value?.id)
      if (refreshed) selected.value = refreshed
      if (selected.value && (!terminal.has(selected.value.status) || detailVersion !== selected.value.version)) {
        const detail = await request(`/api/extensions/installations/${selected.value.id}`)
        selected.value = asRecord<Task>(detail.task)
        const timeline = await request(`/api/extensions/installations/${selected.value.id}/events?afterSequence=${sequence}`)
        const next = asRecords(timeline.events)
        if (next.length) { events.value.push(...next); sequence = Number(next.at(-1)?.sequence || sequence) }
        detailVersion = next.length === 100 ? 0 : selected.value.version
      }
    }
    async function loadMore() {
      await run(async () => {
        const last = tasks.value.at(-1)
        if (!last) return
        const result = await request(`/api/extensions/installations?limit=100&before=${Number(last.updatedAt)}&beforeId=${encodeURIComponent(last.id)}`)
        const more = asRecords<Task>(result.tasks), seen = new Set(tasks.value.map(task => task.id))
        tasks.value.push(...more.filter(task => !seen.has(task.id))); hasMore.value = more.length === 100
      }, false)
    }
    async function tick() {
      if (disposed) return
      try { if (!document.hidden) { await reload(); failures = 0 } } catch { failures = Math.min(5, failures + 1) }
      const active = tasks.value.some(task => !terminal.has(task.status))
      timer = setTimeout(tick, document.hidden ? 30000 : failures ? Math.min(60000, 2000 * 2 ** failures) : active ? 2000 : 10000)
    }
    const visible = () => { if (!document.hidden && !disposed) { clearTimeout(timer); void tick() } }
    onMounted(() => { void tick(); document.addEventListener("visibilitychange", visible) })
    onBeforeUnmount(() => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); setDirtyScope("extension-installation", false) })
    async function run(work: () => Promise<unknown>, refresh = true) {
      if (busy.value) return
      busy.value = true
      try { await work(); if (refresh) await reload() } catch (error) { toast(errorMessage(error)) } finally { busy.value = false }
    }
    async function select(task: Task) { selected.value = task; events.value = []; sequence = 0; detailVersion = 0; await run(reload) }
    async function submit(inspect = false) {
      await run(async () => {
        const source = form.source.trim()
        const body: UnknownRecord = { source, kind: form.kind }
        if (form.kind === "mcp") body.mcp = { id: form.serviceId.trim(), url: source, transport: form.transport }
        else { if (form.ref) body.ref = form.ref; if (form.subdir) body.subdir = form.subdir; if (form.upload) { body.provider = "upload"; body.upload = form.upload } }
        const result = await post(`/api/extensions/installations${inspect ? "/inspect" : ""}`, body, true)
        selected.value = asRecord<Task>(result.task); events.value = []; sequence = 0
        requestKey = crypto.randomUUID(); form.source = ""; form.upload = ""
        toast("安装请求已受理；成功后保持停用")
      })
    }
    async function upload(event: Event) {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (!file) return
      if (file.size > 20 * 1024 * 1024) { toast("上传文件不能超过 20 MiB"); return }
      const bytes = new Uint8Array(await file.arrayBuffer())
      let value = ""
      for (let index = 0; index < bytes.length; index += 8192) value += String.fromCharCode(...bytes.subarray(index, index + 8192))
      form.upload = btoa(value); form.source = file.name
    }
    async function mutate(action: string) {
      if (!selected.value) return
      if (["apply", "cancel", "retry", "recover"].includes(action) && !await confirmAction({ title: action === "apply" ? "提交这份安装计划？" : action === "cancel" ? "取消安装任务？" : action === "recover" ? "恢复这次停用提交？" : "创建新的重试任务？", message: action === "apply" ? "来源与固定内容按当前计划提交，安装后仍停用。" : "操作结果会写入安装记录。", detail: selected.value.id, confirmText: "确认", tone: "warn", icon: "download" })) return
      await run(async () => {
        const body = action === "inputs" ? { expectedVersion: selected.value!.version, ...(binding.subdir ? { subdir: binding.subdir } : {}), ...(binding.credentialId ? { credentialId: binding.credentialId } : {}) } : action === "apply" ? { planId: selected.value!.plan?.id } : {}
        const result = await post(`/api/extensions/installations/${selected.value!.id}/${action}`, body)
        selected.value = asRecord<Task>(result.task)
      })
    }
    async function loadManagement() {
      await run(async () => { const result = await request("/api/extensions/credentials"); credentials.value = asRecords(result.credentials); networkGrants.value = asRecords(result.networkGrants); managementOpen.value = true })
    }
    async function saveSecret() {
      await run(async () => {
        const result = await post("/api/extensions/credentials", { alias: secret.alias, purpose: secret.purpose, origin: secret.origin, scope: secret.scope, ...(secret.envRef ? { envRef: secret.envRef } : { value: secret.value }) })
        secret.value = ""; secret.envRef = ""; binding.credentialId = String(result.credentialId)
        toast("凭据已保存，明文不会回显")
        const list = await request("/api/extensions/credentials"); credentials.value = asRecords(list.credentials)
      })
    }
    async function saveNetwork() {
      if (!await confirmAction({ title: "授权这个精确网络目标？", message: network.allowHttpCredentials ? "此目标将获准在明文 HTTP 上携带静态凭据，内容可能被网络中的其他设备读取。" : "连接由 Yui Chat 服务端发起；localhost 指服务端或其容器。", detail: `${network.url}\nIP：${network.addresses}`, confirmText: "授权此目标", tone: "warn", icon: "link" })) return
      await run(async () => {
        const result = await post("/api/extensions/network-grants", { ...network, addresses: network.addresses.split(/[\s,]+/).filter(Boolean), paths: network.paths.split(/[\s,]+/).filter(Boolean) })
        binding.networkGrantId = String(asRecord(result.grant).id); network.url = ""
        const list = await request("/api/extensions/credentials"); networkGrants.value = asRecords(list.networkGrants)
        toast("网络授权已保存，请绑定到来源或服务")
      })
    }
    async function bindService() {
      await run(async () => {
        if (binding.credentialId) await post(`/api/extensions/credentials/${binding.credentialId}/bind`, { serviceId: binding.serviceId })
        if (binding.networkGrantId) await post(`/api/extensions/network-grants/${binding.networkGrantId}/bind`, { targetId: binding.serviceId })
        toast("绑定已保存；请在 MCP 服务页发现工具并明确选择开放名单")
      })
    }
    async function revoke(type: string, id: unknown) {
      if (!await confirmAction({ title: "撤销这项授权？", message: "后续请求将停止使用该授权，相关 MCP 连接会关闭。", confirmText: "撤销", tone: "warn", icon: "power" })) return
      await run(async () => { await post(`/api/extensions/${type}/${String(id)}/revoke`); await loadManagement() })
    }
    return { tasks, rows, hasMore, loadMore, selected, events, busy, filter, entryFilter, kindFilter, form, secret, network, binding, managementOpen, credentials, networkGrants, labels, terminal, reload, select, submit, upload, mutate, loadManagement, saveSecret, saveNetwork, bindService, revoke }
  },
  template: `
    <div class="stack">
      <div class="section-heading-row"><strong>安装扩展</strong><button class="btn outline" @click="loadManagement" :disabled="busy">凭据 / 来源管理</button><button class="btn outline" @click="reload">刷新</button></div>
      <p class="muted">安装成功后保持停用、默认仅主人可用。Skill 不执行附带代码；MCP 导入不会连接或发现工具。</p>
      <div class="form-grid">
        <label>类型<select v-model="form.kind"><option value="skill">Markdown Skill</option><option value="mcp">远程 MCP</option></select></label>
        <label>来源<input v-model="form.source" placeholder="仓库、归档、SKILL.md 或 MCP URL" /></label>
        <template v-if="form.kind === 'skill'"><label>版本<input v-model="form.ref" placeholder="默认分支或固定 commit" /></label><label>目录<input v-model="form.subdir" placeholder="多候选可稍后选择" /></label><label>上传 Skill / ZIP / tar.gz<input type="file" @change="upload" /></label></template>
        <template v-else><label>服务 ID<input v-model="form.serviceId" placeholder="小写字母、数字、横线" /></label><label>传输<select v-model="form.transport"><option value="streamableHttp">Streamable HTTP</option><option value="sse">SSE</option></select></label></template>
      </div>
      <div class="toolbar"><button class="btn primary" :disabled="busy || !form.source" @click="submit(false)">安装为停用</button><button class="btn outline" :disabled="busy || !form.source" @click="submit(true)">只检查</button></div>
      <div class="toolbar"><select v-model="filter"><option value="">所有状态</option><option v-for="(label, value) in labels" :value="value">{{ label }}</option></select><select v-model="entryFilter"><option value="">所有入口</option><option value="model">模型</option><option value="owner_command">主人指令</option><option value="web">Web</option></select><select v-model="kindFilter"><option value="">所有类型</option><option value="skill">Skill</option><option value="mcp">MCP</option></select><button v-if="hasMore" class="btn outline" :disabled="busy" @click="loadMore">加载更多</button></div>
      <div v-for="task in rows" :key="task.id" class="section-heading-row"><button class="btn outline" @click="select(task)">{{ task.plan?.targetId || task.id }}</button><span>{{ task.kind }} · {{ task.origin?.entry }} · {{ labels[task.status] || task.status }} · {{ task.currentStep }}</span></div>
      <div v-if="selected" class="stack">
        <strong>{{ selected.id }} · {{ labels[selected.status] }}</strong><p>来源：{{ selected.sourceIdentity }}<br/>发起主体：{{ selected.origin?.id }} / {{ selected.origin?.entry }}<br/>{{ selected.reasonCode }}</p>
        <p v-if="selected.plan">目标：{{ selected.plan.targetId }}<br/>固定内容：{{ selected.plan.digest }}<br/>计划：{{ selected.plan.id }}</p>
        <div v-if="selected.status === 'awaiting_input'" class="form-grid"><label v-if="selected.candidates?.length">候选目录<select v-model="binding.subdir"><option value="">请选择</option><option v-for="candidate in selected.candidates" :value="candidate">{{ candidate }}</option></select></label><label>凭据编号<input v-model="binding.credentialId" placeholder="在凭据管理中创建或选择" /></label><button class="btn primary" :disabled="busy" @click="mutate('inputs')">补齐并继续原任务</button></div>
        <div class="toolbar"><button v-if="selected.status === 'needs_attention' && selected.phase && !selected.operationKind" class="btn outline" :disabled="busy" @click="mutate('recover')">核验并恢复停用提交</button><button v-if="selected.status === 'awaiting_confirmation'" class="btn primary" :disabled="busy" @click="mutate('apply')">确认这份计划</button><button v-if="!terminal.has(selected.status)" class="btn danger" :disabled="busy" @click="mutate('cancel')">取消任务</button><button v-if="['failed','expired'].includes(selected.status) && !selected.phase" class="btn outline" :disabled="busy" @click="mutate('retry')">安全重试</button></div>
        <p v-if="selected.status === 'succeeded' && (!selected.operationKind || selected.operationKind === 'install')">安装时状态：停用；运行验证：未执行。当前状态请查看扩展能力或 MCP 服务页，启用会单独记录。</p>
        <ol><li v-for="event in events" :key="event.sequence">{{ event.sequence }} · {{ new Date(Number(event.timestamp)).toLocaleString() }} · {{ event.type }} {{ event.errorCode }}</li></ol>
      </div>
      <div v-if="managementOpen" class="stack">
        <strong>凭据绑定</strong><p class="muted">仓库凭据绑定 API origin 与完整来源身份；MCP 凭据绑定服务 ID。通用归档和 MCP 的值填写 HTTP Header JSON；只读平台 Token 直接填写。秘密不进入浏览器存储或配置包。</p>
        <div class="form-grid"><label>别名<input v-model="secret.alias" /></label><label>用途<select v-model="secret.purpose"><option value="repository-read">仓库读取</option><option value="mcp-auth">MCP 鉴权</option></select></label><label>精确 origin<input v-model="secret.origin" placeholder="https://api.github.com" /></label><label>来源身份 / 服务 ID<input v-model="secret.scope" placeholder="https://github.com/owner/repo" /></label><label>凭据值<input type="password" v-model="secret.value" autocomplete="new-password" /></label><label>或授权环境变量名<input v-model="secret.envRef" /></label></div>
        <button class="btn primary" :disabled="busy" @click="saveSecret">加密保存凭据</button>
        <div v-for="item in credentials" :key="String(item.id)" class="toolbar"><span>{{ item.alias }} · {{ item.origin }} · {{ item.scope }} · {{ item.revoked ? '已撤销' : '有效' }}</span><button class="btn outline" @click="binding.credentialId = String(item.id)">选择</button><button v-if="!item.revoked" class="btn danger" @click="revoke('credentials', item.id)">撤销</button></div>
        <strong>精确网络授权</strong><p class="muted">填写服务端可连接的真实 IP。授权路径为精确路径；SSE 的 POST 路径须单独列出。DNS 地址变化会停止连接。</p>
        <div class="form-grid"><label>用途<select v-model="network.purpose"><option value="mcp-connect">MCP 连接</option><option value="repository-fetch">来源获取</option></select></label><label>目标身份<input v-model="network.targetId" /></label><label>地址<input v-model="network.url" /></label><label>精确 IP<input v-model="network.addresses" placeholder="127.0.0.1，或实际内网 IP" /></label><label>附加协议路径<input v-model="network.paths" placeholder="/messages" /></label><label>服务级 CA<textarea v-model="network.ca"></textarea></label><label><input type="checkbox" v-model="network.allowHttpCredentials" />允许该 HTTP 目标携带静态凭据</label></div><button class="btn outline" :disabled="busy" @click="saveNetwork">检查并授权精确目标</button>
        <div v-for="item in networkGrants" :key="String(item.id)" class="toolbar"><span>{{ item.origin }} · {{ item.targetId }} · {{ item.revoked ? '已撤销' : '有效' }}</span><button class="btn outline" @click="binding.networkGrantId = String(item.id)">选择</button><button v-if="!item.revoked" class="btn danger" @click="revoke('network-grants', item.id)">撤销</button></div>
        <label>绑定目标身份（MCP 服务 ID 或完整来源身份）<input v-model="binding.serviceId" /></label><p class="muted">凭据：{{ binding.credentialId || '未选择' }} · 网络：{{ binding.networkGrantId || '未选择' }}</p><button class="btn primary" :disabled="busy" @click="bindService">绑定到停用服务 / 来源</button>
      </div>
    </div>
  `,
}
