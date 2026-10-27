import { computed, onUnmounted, reactive, ref, watch } from "vue"
import { apiUrl, confirmAction, request as rawRequest, setDirtyScope, store, toast } from "../../app/store/store.js"
import { errorMessage } from "../../shared/data.js"

type Row = Record<string, any>
const request = async (path: string, options: RequestInit = {}): Promise<Row> => rawRequest(path, options)
const stamp = (value: unknown): string => Number(value) ? new Date(Number(value)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未记录"
const json = (value: unknown) => JSON.stringify(value)

export const PortraitScopeDefaults = {
  name: "PortraitScopeDefaults",
  props: { groupId: { type: String, required: true }, userId: { type: String, default: "" } },
  setup(props: { groupId: string; userId: string }) {
    const data = ref<Row>({}), selected = ref(""), baseline = ref(""), busy = ref(false), error = ref("")
    let seq = 0, dirtyKey = ""
    const typeOptions = computed(() => [{ value: "", label: props.userId ? "继承本群 / 全局默认" : "继承全局默认" }, ...(data.value.types || []).map((t: Row) => ({ value: t.id, label: t.name }))])
    const endpoint = () => `/api/memory/portraits/groups/${encodeURIComponent(props.groupId)}/default-type`
    async function load() {
      const token = ++seq
      if (dirtyKey) setDirtyScope(dirtyKey, false)
      dirtyKey = `portrait:default:${props.groupId}:${props.userId}`
      if (!props.groupId) return
      try {
        const result = await request(endpoint() + `?userId=${encodeURIComponent(props.userId)}`)
        if (token !== seq) return
        data.value = result; selected.value = String(props.userId ? result.memberType : result.groupType); baseline.value = selected.value; error.value = ""
      } catch (e) { if (token === seq) error.value = errorMessage(e) }
    }
    watch(() => [props.groupId, props.userId], load, { immediate: true })
    watch(selected, value => setDirtyScope(dirtyKey, value !== baseline.value))
    onUnmounted(() => { seq++; if (dirtyKey) setDirtyScope(dirtyKey, false) })
    async function save() {
      const token = seq, base = endpoint(), userId = props.userId, value = selected.value
      busy.value = true
      try {
        const result = await request(base, { method: "PUT", body: json({ userId, typeId: value }) })
        if (token !== seq) return
        data.value = result; baseline.value = value; setDirtyScope(dirtyKey, selected.value !== value); toast("默认类型已保存，已有画像保留")
      } catch (e) { if (token === seq) toast(errorMessage(e)) } finally { busy.value = false }
    }
    return { data, selected, baseline, busy, error, typeOptions, save }
  },
  template: `<section class="portrait-scope-default"><div class="memory-section-head"><div><h3>{{ userId ? '本群成员默认类型' : '本群默认画像类型' }}</h3><p>只决定未指定类型时打开哪一份画像，仍可分别生成全部五种画像。</p></div></div><p v-if="error" class="error-text">{{ error }}</p><Field label="默认画像类型" type="select" v-model="selected" :options="typeOptions" /><div class="row between"><span class="muted small">{{ data.source || '全局默认' }} · {{ data.type?.name || '—' }}</span><button v-if="busy || selected !== baseline" class="btn small outline" type="button" :disabled="busy" @click="save">保存默认类型</button></div></section>`,
}

export const MemoryPortraitWorkspace = {
  name: "MemoryPortraitWorkspace",
  components: { PortraitScopeDefaults },
  props: { groupId: { type: String, required: true }, userId: { type: String, required: true }, name: { type: String, default: "成员" }, enabled: { type: Boolean, default: false } },
  setup(props: { groupId: string; userId: string; name: string; enabled: boolean }) {
    const data = ref<Row>({}), error = ref(""), busy = ref(false), loading = ref(false), selectedType = ref("")
    const showDefaults = ref(false), showGenerate = ref(false), showReport = ref(false), showEvidence = ref(false), showVersions = ref(false)
    const previewHtml = ref(""), previewReport = ref<Row | null>(null), evidence = ref<Row[]>([]), historyCount = ref(200), supplement = ref(true)
    let seq = 0
    const report = computed<Row | null>(() => data.value.report || null)
    const endpoint = () => `/api/memory/portraits/groups/${encodeURIComponent(props.groupId)}/members/${encodeURIComponent(props.userId)}`
    async function load(reset = false) {
      const token = ++seq
      if (reset) selectedType.value = ""
      error.value = ""; showReport.value = false; showEvidence.value = false; showVersions.value = false; showGenerate.value = false; showDefaults.value = false; previewHtml.value = ""
      const previousTypes = data.value.types
      data.value = { types: previousTypes }
      loading.value = false
      if (!props.enabled || !props.groupId || !props.userId) return
      loading.value = true
      try {
        const result = await request(endpoint() + (selectedType.value ? `?typeId=${encodeURIComponent(selectedType.value)}` : ""))
        if (token !== seq) return
        data.value = result; selectedType.value = String(result.type.id)
      } catch (e) { if (token === seq) error.value = errorMessage(e) } finally { if (token === seq) loading.value = false }
    }
    watch(() => [props.groupId, props.userId, props.enabled], () => load(true), { immediate: true })
    onUnmounted(() => { seq++ })
    async function selectType(id: string) { if (id !== selectedType.value && !busy.value) { selectedType.value = id; await load() } }
    function openGenerate() { historyCount.value = Number((store.config?.memory as Row)?.portrait?.historyCount) || 200; showGenerate.value = true }
    async function closeDefaults() {
      if (store.dirtyScopes[`portrait:default:${props.groupId}:${props.userId}`] && !await confirmAction({ title: "放弃默认类型修改？", message: "成员默认类型尚未保存。", confirmText: "放弃修改", tone: "warn" })) return
      await load()
    }
    async function generate() {
      const force = Boolean(data.value.used), typeId = selectedType.value, base = endpoint(), token = seq
      if (!await confirmAction({ title: force ? "重提炼画像" : "生成画像", message: `${props.name} · ${data.value.type?.name || '默认类型'} · 最多 ${historyCount.value} 条发言`, detail: force ? "管理员重提炼将调用模型，成功后更新本类型副本，失败保留原副本。" : "成功后计入本群本类型本月额度，其他类型额度不受影响。", confirmText: force ? "确认重提炼" : "开始生成", tone: "warn" })) return
      if (token !== seq) return
      busy.value = true; showGenerate.value = false; error.value = ""
      try {
        const result = await request(base, { method: "POST", body: json({ force, typeId, historyCount: historyCount.value, supplement: supplement.value }) })
        if (token !== seq) return
        const current = await request(base + `?typeId=${encodeURIComponent(typeId)}`)
        if (token !== seq) return
        data.value = current; toast(result.cached ? "已返回本类型画像副本" : "画像已保存")
      } catch (e) { if (token === seq) error.value = errorMessage(e) } finally { busy.value = false }
    }
    async function openReport(item: Row) {
      const token = seq
      try { const result = await request(`${endpoint()}/${encodeURIComponent(item.id)}/preview`); if (token !== seq) return; previewReport.value = item; previewHtml.value = String(result.html || ""); showReport.value = true }
      catch (e) { if (token === seq) toast(errorMessage(e)) }
    }
    async function openEvidence() {
      if (!report.value) return
      const token = seq
      try { const result = await request(`${endpoint()}/${encodeURIComponent(report.value.id)}/evidence`); if (token !== seq) return; evidence.value = result.items || []; showEvidence.value = true }
      catch (e) { if (token === seq) toast(errorMessage(e)) }
    }
    async function copyPersona() {
      try { await navigator.clipboard.writeText(String(report.value?.personaPrompt || "")); toast("人格模拟提示词已复制") }
      catch { toast("无法访问剪贴板，请选择正文手动复制") }
    }
    return { data, report, error, busy, loading, selectedType, showDefaults, showGenerate, showReport, showEvidence, showVersions, previewHtml, evidence, historyCount, supplement, stamp, openGenerate, generate, openReport, openEvidence, selectType, closeDefaults, copyPersona, load,
      imageUrl: computed(() => previewReport.value ? apiUrl(`${endpoint()}/${encodeURIComponent(previewReport.value.id)}/image`) : "") }
  },
  template: `
    <section class="portrait-workspace">
      <div v-if="!enabled" class="member-memory-empty"><Icon name="lock" :size="25" /><strong>本群画像功能暂不可用</strong><p>只有开启消息采集的群可以生成和查看画像，已有副本会保留。</p></div>
      <template v-else>
        <div class="portrait-type-tabs" aria-label="画像类型"><button v-for="item in data.types" :key="item.id" class="btn small" :class="selectedType === item.id ? 'primary' : 'outline'" type="button" :disabled="busy" :aria-pressed="selectedType === item.id" @click="selectType(item.id)">{{ item.name }}</button></div>
        <div class="row between portrait-toolbar"><span class="muted small">{{ data.type?.description || '正在读取画像类型…' }}</span><div class="row"><button class="btn small outline" type="button" @click="showDefaults = true">默认类型</button><button class="btn small primary" type="button" :disabled="busy || loading || Boolean(data.running) || !data.type" @click="openGenerate"><Icon name="refresh" :size="14" />{{ data.used ? '重提炼' : '生成' }}{{ data.type?.name || '画像' }}</button></div></div>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p><p v-if="loading || busy" class="muted small" role="status">{{ busy ? '正在整理资料并生成画像，请稍候…' : '正在读取画像…' }}</p>
        <div v-if="data.running && !busy" class="portrait-quota">本类型已有任务正在生成。<button class="btn small outline" type="button" @click="load()">刷新状态</button></div>
        <div v-if="data.type" class="portrait-quota"><Icon name="calendar" :size="15" /><div>{{ data.type.name }} · {{ data.used ? '本群本月额度已用' : '本群本月可生成一次' }}<p>每种类型额度独立；{{ data.used ? '普通成员重复请求返回副本，下次可生成 ' + stamp(data.nextAt) : '成功生成才扣额度' }}。</p></div></div>
        <article v-if="report" class="portrait-summary">
          <div class="row"><span class="badge portrait-type-badge">{{ report.type.name }}</span><span class="muted small">v{{ report.version }} · {{ stamp(report.createdAt) }}</span></div>
          <h3>{{ report.name }} · {{ report.type.name }}</h3>
          <template v-if="report.typeId !== 'clone'"><p class="portrait-lead">{{ report.summary }}</p><div class="portrait-keywords"><span v-for="tag in report.keywords" :key="tag">{{ tag }}</span></div></template>
          <section v-if="report.personaPrompt" class="portrait-section"><div class="row between"><h4>人格模拟提示词</h4><button class="btn small outline" type="button" @click="copyPersona"><Icon name="copy" :size="14" />复制正文</button></div><pre class="portrait-persona">{{ report.personaPrompt }}</pre></section>
          <template v-if="report.typeId !== 'clone'"><section v-for="(section, index) in report.sections" :key="index" class="portrait-section"><h4>{{ section.heading }}</h4><p>{{ section.text }}</p></section></template>
          <footer class="row"><button class="btn small outline" type="button" @click="openEvidence">查看依据</button></footer>
        </article>
        <div v-else-if="!loading && !busy && !error" class="member-memory-empty"><Icon name="bot" :size="25" /><strong>{{ data.used ? '本类型副本因资料变化已失效' : '还没有' + (data.type?.name || '本类型画像') }}</strong><p>{{ data.used ? '管理员可重提炼，普通成员需等待下月。' : '点击上方生成按钮，其他类型的画像和额度会独立保留。' }}</p></div>
        <div class="row portrait-actions"><button v-if="report" class="btn small primary" type="button" @click="openReport(report)"><Icon name="image" :size="14" />查看图片副本</button><button v-if="data.reports?.length" class="btn small outline" type="button" @click="showVersions = true"><Icon name="history" :size="14" />本类型版本</button></div>
      </template>
      <SideDrawer :open="showDefaults && enabled" title="默认画像类型" :subtitle="name + ' · 仅本群生效'" width="560px" @close="closeDefaults"><PortraitScopeDefaults v-if="showDefaults" :group-id="groupId" :user-id="userId" /></SideDrawer>
      <SideDrawer :open="showGenerate && enabled" :title="(data.used ? '重提炼' : '生成') + (data.type?.name || '画像')" :subtitle="name" width="560px" @close="showGenerate = false"><p>当前类型：{{ data.type?.name }} · 只使用这套内置提示词</p><Field label="目标成员历史发言数量" type="number" v-model="historyCount" description="50–500 条；受输入预算限制，不截断单条消息。" /><Checkbox class="portrait-check" v-model="supplement" label="本地不足时补充平台历史" /><p class="muted small">补录受采集保留期限、扫描条数和耗时限制，不追加历史记忆提炼任务。</p><template #actions><button class="btn primary" type="button" :disabled="busy || historyCount < 50 || historyCount > 500" @click="generate">{{ data.used ? '重提炼' : '生成画像' }}</button></template></SideDrawer>
      <SideDrawer :open="showReport && enabled" title="画像图片副本" :subtitle="name" width="900px" @close="showReport = false"><iframe v-if="showReport" class="portrait-preview-frame" :srcdoc="previewHtml" sandbox="" title="统一 HTML 画像预览"></iframe><p class="muted small">使用已保存内容预览，不调用模型。</p><template #actions><a v-if="imageUrl" class="btn outline" :href="imageUrl" target="_blank" rel="noopener noreferrer">打开 PNG 图片</a></template></SideDrawer>
      <SideDrawer :open="showEvidence && enabled" title="画像依据" :subtitle="name" width="640px" @close="showEvidence = false"><div v-if="report" class="portrait-notes"><p class="muted small">{{ report.messageCount }} / {{ report.requestedCount }} 条发言 · {{ report.memoryCount }} 条记忆</p><p v-if="report.uncertainties" class="muted small">{{ report.uncertainties }}</p><p v-if="report.backfillNote" class="muted small">{{ report.backfillNote }}</p></div><article v-for="item in evidence" :key="item.id" class="portrait-evidence"><small>{{ item.type === 'memory' ? '长期记忆' : item.type === 'profile' ? '人工资料' : item.type === 'context' ? '回复上下文' : '本群原文' }} · {{ item.sentAt ? stamp(item.sentAt) : '' }}</small><p>{{ item.available ? item.text : '原文已清理或不可用，保留来源标识。' }}</p></article></SideDrawer>
      <SideDrawer :open="showVersions && enabled" title="画像版本" :subtitle="(data.type?.name || '') + ' · 最近三个版本'" width="560px" @close="showVersions = false"><article v-for="item in data.reports" :key="item.id" class="portrait-version row between"><div><strong>v{{ item.version }} · {{ item.type.name }}</strong><p class="muted small">{{ stamp(item.createdAt) }} · {{ item.messageCount }} 条发言</p></div><button class="btn small outline" type="button" @click="showVersions = false; openReport(item)">查看副本</button></article></SideDrawer>
    </section>`,
}

export const MemoryPortraitSettings = {
  name: "MemoryPortraitSettings",
  setup() {
    const settings = reactive<Row>({}), types = ref<Row[]>([]), fixedPrompt = ref(""), baseline = ref(""), busy = ref(false), error = ref("")
    const dirty = computed(() => baseline.value !== "" && json(settings) !== baseline.value)
    const typeOptions = computed(() => types.value.map(t => ({ value: t.id, label: t.name })))
    const modelOptions = computed(() => [{ value: "", label: "跟随默认对话模型" }, ...((store.config?.models as Row[]) || []).filter(m => m.capabilities?.chat !== false).map(m => ({ value: m.name, label: `${m.apiProvider || ''} · ${m.modelIdentifier || m.name}` }))])
    let mounted = true
    async function load() {
      try { const r = await request("/api/memory/portraits/settings"); if (!mounted) return; Object.assign(settings, r.settings); types.value = r.types; fixedPrompt.value = String(r.fixedPrompt || ""); baseline.value = json(settings) }
      catch (e) { if (mounted) error.value = errorMessage(e) }
    }
    load()
    watch(dirty, value => setDirtyScope("portrait:settings", value))
    onUnmounted(() => { mounted = false; setDirtyScope("portrait:settings", false) })
    async function save() {
      busy.value = true; error.value = ""
      try { const r = await request("/api/memory/portraits/settings", { method: "PUT", body: json({ settings }) }); if (!mounted) return; Object.assign(settings, r.settings); baseline.value = json(settings); store.config = r.config; toast("画像设置已保存") }
      catch (e) { if (mounted) error.value = errorMessage(e) } finally { busy.value = false }
    }
    return { settings, types, fixedPrompt, busy, error, dirty, typeOptions, modelOptions, save }
  },
  template: `<section class="portrait-settings"><header class="memory-section-head"><div><h2>画像设置</h2><p>五种内置任务独立保存；默认正画像，各类型每人每群每月成功生成一次。</p></div><button class="btn small primary" type="button" :disabled="busy || !dirty" @click="save">保存设置</button></header><p v-if="error" class="error-text" role="alert">{{ error }}</p><div class="form-grid two"><Field label="全局默认画像类型" type="select" v-model="settings.defaultType" :options="typeOptions" /><Field label="画像模型" type="select" v-model="settings.modelName" :options="modelOptions" /><Field label="默认历史发言数量" type="number" v-model="settings.historyCount" description="50–500 条目标成员发言" /><Field label="输入 Token 上限" type="number" v-model="settings.inputTokenLimit" description="3000–100000，默认 100000；包含规则、任务、记忆、同类型原画像和聊天记录" /><Field label="输出 Token 上限" type="number" v-model="settings.maxTokens" description="1024–10000，默认 10000；思考也计入上限" /></div><div class="portrait-type-grid"><article v-for="item in types" :key="item.id" class="portrait-type-card"><div class="row between"><h3>{{ item.name }}</h3><span class="badge">{{ item.id === settings.defaultType ? '默认类型' : '独立月度额度' }}</span></div><p class="muted small">{{ item.description }}</p><details class="capture-default-prompt"><summary>查看内置提示词原文</summary><pre>{{ item.prompt }}</pre></details></article></div><p class="muted small portrait-notes">内置提示词来自 <a href="https://github.com/Zhalslar/astrbot_plugin_portrayal/blob/main/builtin_prompts.yaml" target="_blank" rel="noopener noreferrer">astrbot_plugin_portrayal</a>（MIT），在本地随插件提供。克隆人格仅生成可复制模板，不自动切换机器人身份。</p><details class="capture-default-prompt"><summary>共用资料与输出规则</summary><pre>{{ fixedPrompt }}</pre></details></section>`,
}
