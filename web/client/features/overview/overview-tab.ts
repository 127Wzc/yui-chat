import { computed, reactive, ref } from "vue"
import { store, request, toast, setTab, refreshSlices, saveConfigPatch } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"

interface GuideSummary { next?: GuideStep; ready?: number; warn?: number; todo?: number }
interface GuideStep extends UnknownRecord {
  id: string
  status?: string
  defaults?: UnknownRecord
  action?: { tab?: string }
}
interface GuideData extends UnknownRecord { summary?: GuideSummary; steps?: GuideStep[] }
interface ProviderTemplate extends UnknownRecord {
  id: string
  label?: string
  providerName?: string
  baseURL?: string
  modelIdentifier?: string
  authType?: string
}
interface ProviderData extends UnknownRecord { templates?: ProviderTemplate[] }
interface ModelConfig extends UnknownRecord {
  name?: string
  adapter?: string
  modelIdentifier?: string
  capabilities?: { chat?: boolean }
}
interface ApiProvider extends UnknownRecord { name?: string; authType?: string }
interface ReplyTask extends UnknownRecord { modelList?: string[]; selectionStrategy?: string }
interface OverviewConfig extends UnknownRecord {
  models?: ModelConfig[]
  apiProviders?: ApiProvider[]
  chat?: { defaultChannel?: string }
  persona?: { firstPerson?: string; characterPrompt?: string; respondToAt?: boolean }
  tools?: { boundaryAccess?: { enabled?: boolean } }
  knowledge?: { enabled?: boolean }
  response?: { defaultMode?: string; autoUsePicture?: boolean; autoUsePictureThreshold?: number }
  modelTasks?: { replyer?: ReplyTask }
}
interface DiagnosticsData extends UnknownRecord { summary?: { errorCount?: number; warnCount?: number } }
interface LogSummary extends UnknownRecord {
  totals?: { total?: number; calls?: number; failures?: number; toolSuccessRate?: number; toolFailures?: number }
  daily?: Array<{ total?: number }>
  models?: Array<{ name?: string }>
  purposes?: Array<UnknownRecord>
}
interface ConversationData extends UnknownRecord { conversations?: unknown[] }
interface ChatResult extends UnknownRecord { text?: string }
interface ChatResponse extends UnknownRecord { sessionId?: string; result?: ChatResult }
interface WizardResult extends UnknownRecord { text?: string }

const statusText = { ready: "就绪", warn: "待检查", todo: "待处理" }
const BOOL_OPTIONS = [{ value: "true", label: "开启" }, { value: "false", label: "关闭" }]
const OUTPUT_MODE_OPTIONS = [{ value: "text", label: "优先文字（推荐）" }, { value: "picture", label: "优先图片卡片" }]
const TOOL_PRESET_OPTIONS = [
  { value: "core", label: "基础助手（推荐）" },
  { value: "search", label: "联网检索" },
  { value: "media", label: "图片与媒体" },
  { value: "memory", label: "记忆与画像" },
  { value: "render", label: "图片卡片" },
]

function webTestSessionId() {
  if (globalThis.crypto?.randomUUID) return `wizard-${globalThis.crypto.randomUUID()}`
  return `wizard-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function number(value: unknown): string {
  return Number(value || 0).toLocaleString("zh-CN")
}

export const OverviewTab = {
  name: "OverviewTab",
  setup() {
    const config = computed(() => asRecord<OverviewConfig>(store.config))
    const diagnostics = computed(() => asRecord<DiagnosticsData>(store.diagnostics))
    const guide = computed(() => asRecord<GuideData>(store.setupGuide))
    const guideSummary = computed(() => guide.value.summary || {})
    const guideSteps = computed(() => guide.value.steps || [])
    const nextStep = computed(() =>
      guideSummary.value.next || guideSteps.value.find(item => item.status !== "ready") || guideSteps.value[0],
    )
    const showGuide = ref(false)
    const guideIndex = ref(0)
    const wizardBusy = ref(false)
    const wizardTestResult = ref<WizardResult | null>(null)
    const wizardTestSession = ref(webTestSessionId())
    const initialConfig = config.value
    const initialRealModels = (initialConfig.models || []).filter(model => model.adapter !== "mock" && model.name !== "mock")
    const wizard = reactive({
      providerTemplate: "qwen",
      providerName: "qwen-main",
      providerBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      providerApiKey: "",
      providerModel: "qwen-plus",
      mainModel: initialConfig.chat?.defaultChannel && initialConfig.chat.defaultChannel !== "mock" ? initialConfig.chat.defaultChannel : (initialRealModels[0]?.name || ""),
      fallbackModel: "",
      firstPerson: initialConfig.persona?.firstPerson || "埋埋",
      personaPrompt: initialConfig.persona?.characterPrompt || "你是[first_person]，一个友好、可靠的中文 AI 助手。先给结论，再给清晰步骤；不确定时主动说明。",
      respondToAt: String(initialConfig.persona?.respondToAt !== false),
      toolPreset: "core",
      boundaryAccess: String(initialConfig.tools?.boundaryAccess?.enabled !== false),
      knowledgeEnabled: String(initialConfig.knowledge?.enabled !== false),
      outputMode: initialConfig.response?.defaultMode || "text",
      autoPicture: String(initialConfig.response?.autoUsePicture !== false),
      pictureThreshold: initialConfig.response?.autoUsePictureThreshold || 1200,
      testPrompt: "你好，请用两句话介绍你自己，并告诉我当前能做什么。",
    })
    const currentGuideStep = computed(() => guideSteps.value[guideIndex.value] || guideSteps.value[0] || null)
    const currentGuideDefaults = computed(() => Object.entries(currentGuideStep.value?.defaults || {}))
    const currentGuideId = computed(() => currentGuideStep.value?.id || "")
    const providerData = computed(() => asRecord<ProviderData>(store.providers))
    const providerTemplates = computed(() => providerData.value.templates || [])
    const providerTemplateOptions = computed(() => providerTemplates.value.map(item => ({ value: item.id, label: item.label || item.id })))
    const realModels = computed(() => (config.value.models || []).filter(model => model.adapter !== "mock" && model.name !== "mock"))
    const modelOptions = computed(() => realModels.value.map(model => ({ value: model.name, label: `${model.name}${model.modelIdentifier && model.modelIdentifier !== model.name ? ` · ${model.modelIdentifier}` : ""}` })))
    const fallbackModelOptions = computed(() => [{ value: "", label: "暂不设置" }, ...modelOptions.value.filter(item => item.value !== wizard.mainModel)])

    async function ensureWizardData(stepId: string) {
      const keys: string[] = []
      if (["provider-model", "model-routing", "web-chat-test"].includes(stepId)) keys.push("providers")
      if (stepId === "knowledge") keys.push("knowledge")
      if (stepId === "output-cache") keys.push("output")
      if (!keys.length) return
      try { await refreshSlices(keys) } catch (err) { toast(errorMessage(err)) }
    }

    async function openGuide(stepId = "") {
      const index = guideSteps.value.findIndex(item => item.id === stepId)
      guideIndex.value = index >= 0 ? index : Math.max(0, guideSteps.value.findIndex(item => item.status !== "ready"))
      showGuide.value = true
      await ensureWizardData(guideSteps.value[guideIndex.value]?.id || "")
    }

    async function moveGuide(offset: number) {
      guideIndex.value = Math.min(Math.max(0, guideIndex.value + offset), Math.max(0, guideSteps.value.length - 1))
      await ensureWizardData(currentGuideId.value)
    }

    async function selectGuideIndex(index: number) {
      guideIndex.value = index
      await ensureWizardData(currentGuideId.value)
    }

    function openGuideAction(step: GuideStep | null = currentGuideStep.value) {
      if (!step) return
      showGuide.value = false
      setTab(step.action?.tab || "overview")
    }

    function formatGuideValue(value: unknown): string {
      if (Array.isArray(value)) return value.join("、")
      if (value && typeof value === "object") return JSON.stringify(value)
      return String(value ?? "-")
    }

    function applyProviderTemplate(id = wizard.providerTemplate) {
      const template = providerTemplates.value.find(item => item.id === id)
      if (!template) return
      wizard.providerTemplate = template.id
      wizard.providerName = template.providerName || wizard.providerName
      wizard.providerBaseURL = template.baseURL || ""
      wizard.providerModel = template.modelIdentifier || wizard.providerModel
    }

    async function runWizardAction(action: () => unknown | Promise<unknown>, success?: string, refresh: string[] = ["config", "setupGuide", "diagnostics"]): Promise<boolean> {
      if (wizardBusy.value) return false
      wizardBusy.value = true
      try {
        await action()
        if (refresh.length) await refreshSlices(refresh)
        if (success) toast(success)
        return true
      } catch (err) {
        toast(errorMessage(err))
        return false
      } finally {
        wizardBusy.value = false
      }
    }

    async function saveProvider() {
      if (!wizard.providerModel.trim()) return toast("请填写模型 ID")
      if (!wizard.providerName.trim()) return toast("请填写渠道名称")
      const template = providerTemplates.value.find(item => item.id === wizard.providerTemplate)
      const existing = (config.value.apiProviders || []).find(item => item.name === wizard.providerName.trim())
      if (existing && !wizard.providerApiKey.trim() && existing.authType !== "none") {
        toast("这个渠道已经存在；为避免覆盖已保存的密钥，请直接进入下一步，或填写新 Key 后更新")
        return false
      }
      if (!existing && template?.authType !== "none" && !wizard.providerApiKey.trim()) {
        toast("请填写模型服务商提供的 API Key")
        return false
      }
      return runWizardAction(async () => {
        const result = asRecord<{ model?: { name?: string } }>(await request("/api/providers/quick-add", {
          method: "POST",
          body: JSON.stringify({
            templateId: wizard.providerTemplate,
            providerName: wizard.providerName,
            baseURL: wizard.providerBaseURL,
            apiKey: wizard.providerApiKey,
            modelIdentifiers: [wizard.providerModel],
          }),
        }))
        wizard.providerApiKey = ""
        wizard.mainModel = result.model?.name || wizard.mainModel
      }, "模型服务已保存，可继续设置回复方案", ["config", "providers", "setupGuide", "diagnostics"])
    }

    async function saveProviderAndTest() {
      const saved = await saveProvider()
      if (!saved || !wizard.mainModel) return
      return runWizardAction(async () => {
        await request("/api/channels/test", { method: "POST", body: JSON.stringify({ channelId: wizard.mainModel }) })
      }, "模型连接测试成功", ["providers", "setupGuide", "diagnostics"])
    }

    async function saveRouting() {
      if (!wizard.mainModel) return toast("请先选择主模型")
      const current = config.value.modelTasks?.replyer || {}
      const modelList = [wizard.mainModel, wizard.fallbackModel].filter(Boolean)
      return runWizardAction(() => saveConfigPatch({
        "chat.defaultTask": "replyer",
        "chat.defaultChannel": wizard.mainModel,
        "modelTasks.replyer": { ...current, modelList, selectionStrategy: "fallback" },
      }, "setup-guide-routing"), "回复方案已保存", ["config", "providers", "setupGuide", "diagnostics"])
    }

    async function savePersona() {
      if (!wizard.firstPerson.trim()) return toast("请填写助手称呼")
      return runWizardAction(() => saveConfigPatch({
        "persona.enabled": true,
        "persona.firstPerson": wizard.firstPerson.trim(),
        "persona.characterPrompt": wizard.personaPrompt.trim(),
        "persona.respondToFirstPersonCall": true,
        "persona.respondToAt": wizard.respondToAt === "true",
      }, "setup-guide-persona"), "助手人设已保存")
    }

    async function saveTools() {
      return runWizardAction(async () => {
        await request("/api/tools/apply-preset", { method: "POST", body: JSON.stringify({ preset: wizard.toolPreset }) })
        await saveConfigPatch({ "tools.boundaryAccess.enabled": wizard.boundaryAccess === "true" }, "setup-guide-tools")
      }, "常用能力与权限已保存", ["config", "tools", "setupGuide", "diagnostics"])
    }

    async function saveKnowledge() {
      return runWizardAction(
        () => saveConfigPatch({ "knowledge.enabled": wizard.knowledgeEnabled === "true" }, "setup-guide-knowledge"),
        wizard.knowledgeEnabled === "true" ? "知识库已开启；需要时可在知识库页面手动重新扫描" : "知识库已关闭",
        ["config", "knowledge", "setupGuide", "diagnostics"],
      )
    }

    async function saveOutput() {
      return runWizardAction(() => saveConfigPatch({
        "response.defaultMode": wizard.outputMode,
        "response.autoUsePicture": wizard.autoPicture === "true",
        "response.autoUsePictureThreshold": Number(wizard.pictureThreshold || 1200),
        "response.render.enabled": true,
        "response.render.html.enabled": false,
      }, "setup-guide-output"), "输出方式已保存，高风险截图保持关闭", ["config", "output", "setupGuide", "diagnostics"])
    }

    async function sendWizardTest() {
      const prompt = wizard.testPrompt.trim()
      if (!prompt) return toast("请输入测试问题")
      wizardTestResult.value = null
      return runWizardAction(async () => {
        const response = asRecord<ChatResponse>(await request("/api/chat/test", {
          method: "POST",
          body: JSON.stringify({ prompt, sessionId: wizardTestSession.value, channelId: wizard.mainModel || "" }),
        }))
        wizardTestSession.value = response.sessionId || wizardTestSession.value
        wizardTestResult.value = response.result || { text: "模型没有返回文本。" }
      }, "对话验证成功", ["setupGuide", "conversations"])
    }

    async function copyPanelCommand() {
      try {
        await navigator.clipboard.writeText("#yui面板")
        toast("已复制 #yui面板")
      } catch { toast("请在机器人聊天中发送：#yui面板") }
    }

    const diagSummary = computed(() => diagnostics.value.summary || {})
    const homeStatus = computed(() => {
      if (Number(diagSummary.value.errorCount || 0) > 0) return "bad"
      if (Number(guideSummary.value.todo || 0) > 0) return "setup"
      if (Number(diagSummary.value.warnCount || 0) > 0 || Number(guideSummary.value.warn || 0) > 0) return "warn"
      return "good"
    })
    const homeTitle = computed(() => ({
      bad: "AI 助手有问题需要处理",
      setup: "继续完成 AI 助手设置",
      warn: "AI 助手可以使用，建议再检查几项",
      good: "AI 助手运行正常",
    })[homeStatus.value])
    const homeDescription = computed(() => ({
      bad: `发现 ${diagSummary.value.errorCount || 0} 个错误，可从页面顶部的诊断按钮查看。`,
      setup: `8 步启用流程已完成 ${guideSummary.value.ready || 0} 步，按推荐值继续即可。`,
      warn: `主要功能已经就绪，还有 ${(diagSummary.value.warnCount || 0) + (guideSummary.value.warn || 0)} 项建议检查。`,
      good: "模型、回复能力和主要运行链路均已通过当前检查。",
    })[homeStatus.value])
    const logsSummary = computed(() => asRecord<LogSummary>(store.logsSummary))
    const logTotals = computed(() => logsSummary.value.totals || {})
    const metrics = computed(() => [
      { label: "近 7 天 Token", value: number(logTotals.value.total), icon: "activity", tone: "blue", tip: "所有模型输入与输出 Token" },
      { label: "模型调用", value: number(logTotals.value.calls), icon: "cpu", tone: "purple", tip: "最近 7 天统一模型调用量" },
      { label: "模型失败率", value: `${logTotals.value.calls ? ((Number(logTotals.value.failures || 0) / Number(logTotals.value.calls)) * 100).toFixed(1) : "0.0"}%`, icon: "alert", tone: logTotals.value.failures ? "orange" : "green" },
      { label: "工具成功率", value: `${Number(logTotals.value.toolSuccessRate || 0).toFixed(1)}%`, icon: "wrench", tone: logTotals.value.toolFailures ? "orange" : "green" },
      { label: "活跃对话", value: number(asRecord<ConversationData>(store.conversations).conversations?.length || 0), icon: "message", tone: "blue", tip: "当前仍在使用的会话" },
    ])
    const daily = computed(() => logsSummary.value.daily || [])
    const dailyMax = computed(() => Math.max(1, ...daily.value.map(item => Number(item.total || 0))))
    const modelRows = computed(() => logsSummary.value.models || [])
    const purposeRows = computed(() => logsSummary.value.purposes || [])

    return {
      metrics, logsSummary, logTotals, daily, dailyMax, modelRows, purposeRows, number,
      homeStatus, homeTitle, homeDescription, diagSummary,
      guideSummary, guideSteps, nextStep, statusText,
      showGuide, guideIndex, currentGuideStep, currentGuideDefaults,
      currentGuideId, wizard, wizardBusy, wizardTestResult,
      providerTemplateOptions, modelOptions, fallbackModelOptions,
      BOOL_OPTIONS, OUTPUT_MODE_OPTIONS, TOOL_PRESET_OPTIONS,
      openGuide, moveGuide, selectGuideIndex, openGuideAction, formatGuideValue,
      applyProviderTemplate, saveProvider, saveProviderAndTest, saveRouting, savePersona, saveTools, saveKnowledge, saveOutput, sendWizardTest, copyPanelCommand,
      setTab,
    }
  },
  template: `
    <div class="stack">
      <section class="home-hero" :class="homeStatus">
        <div class="home-hero-copy">
          <span class="eyebrow"><span class="dot" :class="homeStatus === 'good' ? 'on' : (homeStatus === 'bad' ? 'bad' : 'warn')"></span>系统状态</span>
          <h2>{{ homeTitle }}</h2>
          <p>{{ homeDescription }}</p>
          <div class="home-hero-actions">
            <button class="btn" type="button" @click="setTab('chat')"><Icon name="message" :size="15" />测试对话</button>
          </div>
        </div>
        <div class="home-health-summary">
          <div><b :class="{ danger: Number(diagSummary.errorCount || 0) > 0 }">{{ diagSummary.errorCount || 0 }}</b><span>错误</span></div>
          <div><b :class="{ warn: Number(diagSummary.warnCount || 0) > 0 }">{{ diagSummary.warnCount || 0 }}</b><span>警告</span></div>
          <div><b>{{ guideSummary.percent || 0 }}%</b><span>配置就绪</span></div>
        </div>
        <section class="home-setup-strip" :class="{ complete: Number(guideSummary.percent || 0) >= 100 }">
          <span class="home-setup-icon"><Icon :name="Number(guideSummary.percent || 0) >= 100 ? 'check' : 'sparkles'" :size="18" /></span>
          <div class="home-setup-copy">
            <div><b>{{ Number(guideSummary.percent || 0) >= 100 ? '主要配置已就绪' : ('下一步 · ' + (nextStep?.title || '继续配置')) }}</b><span>{{ guideSummary.ready || 0 }} / {{ guideSummary.total || 8 }} 项完成</span></div>
            <p>{{ Number(guideSummary.percent || 0) >= 100 ? '需要调整模型、人格或输出方式时，可以随时重新打开配置引导。' : (nextStep?.detail || '按推荐设置完成剩余项目。') }}</p>
          </div>
          <div class="home-setup-progress"><span :style="{ width: (guideSummary.percent || 0) + '%' }"></span></div>
          <button class="btn" :class="{ outline: Number(guideSummary.percent || 0) >= 100 }" type="button" @click="openGuide(nextStep?.id || '')">{{ Number(guideSummary.percent || 0) >= 100 ? '查看配置' : '继续配置' }}<Icon name="chevron-right" :size="14" /></button>
        </section>
      </section>

      <MetricGrid class="home-dashboard-metrics" :items="metrics" />

      <section class="home-dashboard-grid">
        <Panel title="近 7 天 Token 趋势" icon="chart" class="home-trend-panel">
          <template #actions><button class="btn small outline" type="button" @click="setTab('logs')">查看模型日志<Icon name="chevron-right" :size="13" /></button></template>
          <div v-if="daily.length" class="logs-bars home-logs-bars">
            <div v-for="row in daily" :key="row.day" class="logs-bar-row">
              <span class="logs-bar-label">{{ row.day.slice(5) }}</span>
              <div class="logs-bar-track"><span :style="{ width: Math.max(2, Number(row.total || 0) / dailyMax * 100) + '%' }"></span></div>
              <b>{{ number(row.total) }}</b>
              <div class="logs-bar-values"><span>输入 {{ number(row.input) }}</span><span>输出 {{ number(row.output) }}</span><span v-if="row.cached">缓存 {{ number(row.cached) }}</span></div>
            </div>
          </div>
          <div v-else class="dashboard-empty"><Icon name="chart" :size="22" /><span>最近 7 天还没有模型用量。</span></div>
        </Panel>

        <div class="home-ranking-stack">
          <Panel title="模型排行" icon="server">
            <div v-if="modelRows.length" class="rank-list"><div v-for="(row, index) in modelRows.slice(0, 6)" :key="row.name" class="rank-row"><span class="rank-index">{{ index + 1 }}</span><span class="grow truncate">{{ row.name }}</span><b>{{ number(row.total) }}</b><small>{{ number(row.calls) }} 次</small></div></div>
            <p v-else class="muted small">暂无模型用量。</p>
          </Panel>
          <Panel title="用途分布" icon="layers">
            <div v-if="purposeRows.length" class="rank-list"><div v-for="row in purposeRows.slice(0, 6)" :key="row.name" class="rank-row"><span class="grow truncate">{{ row.name }}</span><b>{{ number(row.total) }}</b><small>{{ number(row.calls) }} 次</small></div></div>
            <p v-else class="muted small">暂无用途数据。</p>
          </Panel>
        </div>
      </section>

      <SideDrawer
        :open="showGuide"
        title="8 步快速启用"
        subtitle="每一步都给出推荐做法和可直接参考的默认值"
        icon="sparkles"
        width="640px"
        @close="showGuide = false"
      >
        <div v-if="currentGuideStep" class="wizard-shell">
          <div class="wizard-progress-head">
            <span>第 {{ guideIndex + 1 }} / {{ guideSteps.length }} 步</span>
            <b>{{ currentGuideStep.title }}</b>
            <span class="badge" :class="currentGuideStep.status === 'ready' ? 'on' : (currentGuideStep.status === 'warn' ? 'risk-medium' : '')">
              {{ statusText[currentGuideStep.status] || "待处理" }}
            </span>
          </div>
          <div class="wizard-progress-track"><span :style="{ width: ((guideIndex + 1) / Math.max(guideSteps.length, 1) * 100) + '%' }"></span></div>

          <div class="wizard-step-nav" aria-label="配置步骤">
            <button
              v-for="(step, index) in guideSteps"
              :key="step.id"
              type="button"
              :class="{ active: index === guideIndex, done: step.status === 'ready' }"
              :aria-label="'第 ' + (index + 1) + ' 步：' + step.title"
              @click="selectGuideIndex(index)"
            >{{ index + 1 }}</button>
          </div>

          <section class="wizard-card">
            <span class="eyebrow"><Icon name="info" :size="13" />当前状态</span>
            <p>{{ currentGuideStep.detail }}</p>
          </section>

          <section class="wizard-card recommendation">
            <span class="eyebrow"><Icon name="sparkles" :size="13" />推荐做法</span>
            <p>{{ currentGuideStep.recommendation || '保持默认值即可，后续可随时回来调整。' }}</p>
          </section>

          <section class="wizard-card">
            <span class="eyebrow"><Icon name="sliders" :size="13" />参考值 / 默认值</span>
            <div class="wizard-defaults">
              <div v-for="row in currentGuideDefaults" :key="row[0]">
                <span>{{ row[0] }}</span><b>{{ formatGuideValue(row[1]) }}</b>
              </div>
            </div>
          </section>

          <section class="wizard-inline-config">
            <div class="wizard-inline-head">
              <div><span class="eyebrow"><Icon name="zap" :size="13" />在这里完成</span><h3>{{ currentGuideStep.title }}</h3></div>
              <span class="badge">可稍后修改</span>
            </div>

            <div v-if="currentGuideId === 'web-auth'" class="wizard-inline-body">
              <div class="wizard-success-note"><Icon name="check" :size="18" /><div><strong>你已进入受保护的管理页面</strong><p>以后可由主人在机器人聊天中发送 <code>#yui面板</code> 获取 3 分钟有效的一次性快捷链接；需要固定入口时再配置 <code>web.authToken</code>。</p></div></div>
              <div class="wizard-inline-actions"><button class="btn outline" type="button" @click="copyPanelCommand"><Icon name="copy" :size="14" />复制 #yui面板</button></div>
            </div>

            <div v-else-if="currentGuideId === 'provider-model'" class="wizard-inline-body">
              <div class="form-grid">
                <Field label="模型服务" type="select" :options="providerTemplateOptions" v-model="wizard.providerTemplate" @update:model-value="applyProviderTemplate" tip="国内用户可先选择通义千问；其他兼容服务选择 OpenAI Compatible。" />
                <Field label="渠道名称" v-model="wizard.providerName" placeholder="qwen-main" tip="保留默认值即可，用于区分不同服务。" />
                <Field label="API 地址" v-model="wizard.providerBaseURL" placeholder="https://服务商地址/v1" tip="官方预设会自动填写；中转服务一般填写到 /v1。" />
                <Field label="API Key" type="password" v-model="wizard.providerApiKey" placeholder="仅保存在本机配置" tip="从模型服务商控制台创建，不会显示在公开页面。" />
              </div>
              <Field label="模型 ID" v-model="wizard.providerModel" placeholder="qwen-plus" hint="参考值：通义千问 qwen-plus；OpenAI gpt-4o-mini；请以服务商控制台为准。" />
              <div class="wizard-inline-actions">
                <button class="btn outline" type="button" :disabled="wizardBusy" @click="saveProvider"><Icon name="save" :size="14" />仅保存</button>
                <button class="btn primary" type="button" :disabled="wizardBusy" @click="saveProviderAndTest"><Icon :name="wizardBusy ? 'activity' : 'play'" :class="{ 'icon-spin': wizardBusy }" :size="14" />保存并测试</button>
              </div>
            </div>

            <div v-else-if="currentGuideId === 'model-routing'" class="wizard-inline-body">
              <div v-if="modelOptions.length" class="form-grid">
                <Field label="主回复模型" type="select" :options="modelOptions" v-model="wizard.mainModel" tip="绝大多数消息由这个模型回复。" />
                <Field label="备用模型" type="select" :options="fallbackModelOptions" v-model="wizard.fallbackModel" tip="主模型连接失败时自动切换；首次使用可以留空。" />
              </div>
              <div v-else class="wizard-empty-note"><Icon name="info" :size="17" /><span>还没有真实模型，请先返回上一步添加模型服务。</span></div>
              <div class="wizard-reference-line"><span>推荐策略</span><strong>主模型失败后切换备用模型</strong></div>
              <div class="wizard-inline-actions"><button class="btn primary" type="button" :disabled="wizardBusy || !modelOptions.length" @click="saveRouting"><Icon name="save" :size="14" />保存回复方案</button></div>
            </div>

            <div v-else-if="currentGuideId === 'persona'" class="wizard-inline-body">
              <div class="form-grid">
                <Field label="助手称呼" v-model="wizard.firstPerson" placeholder="埋埋" hint="参考值：埋埋、小助手；建议 2～6 个字。" />
                <Field label="被 @ 时回复" type="select" :options="BOOL_OPTIONS" v-model="wizard.respondToAt" />
              </div>
              <Field label="角色设定" type="textarea" :rows="4" v-model="wizard.personaPrompt" hint="只定义身份、关系和表达方式；系统会自动保留工具与安全运行规则。" />
              <div class="wizard-persona-sample"><span class="avatar-mini">{{ wizard.firstPerson.slice(0, 1) || 'AI' }}</span><div><strong>{{ wizard.firstPerson || '助手' }}</strong><p>你好，我会先给你结论，再用简单步骤解释。遇到不确定的信息，我会明确说明。</p></div></div>
              <div class="wizard-inline-actions"><button class="btn primary" type="button" :disabled="wizardBusy" @click="savePersona"><Icon name="save" :size="14" />保存人设</button></div>
            </div>

            <div v-else-if="currentGuideId === 'tools'" class="wizard-inline-body">
              <div class="form-grid">
                <Field label="能力场景" type="select" :options="TOOL_PRESET_OPTIONS" v-model="wizard.toolPreset" tip="首次使用推荐基础助手；这些能力只会追加，不会关闭现有能力。" />
                <Field label="边界权限" type="select" :options="BOOL_OPTIONS" v-model="wizard.boundaryAccess" tip="推荐开启，普通用户默认无法使用高风险管理能力。" />
              </div>
              <div class="wizard-warning-note" v-if="wizard.boundaryAccess !== 'true'"><Icon name="alert" :size="16" /><span>关闭边界权限后，高风险工具主要依赖主人权限兜底。普通部署建议保持开启。</span></div>
              <div class="wizard-inline-actions"><button class="btn primary" type="button" :disabled="wizardBusy" @click="saveTools"><Icon name="zap" :size="14" />应用能力并保存权限</button></div>
            </div>

            <div v-else-if="currentGuideId === 'knowledge'" class="wizard-inline-body">
              <Field label="指令知识库" type="select" :options="BOOL_OPTIONS" v-model="wizard.knowledgeEnabled" hint="推荐开启。保存时会自动执行首次扫描，让 AI 认识现有机器人指令。" />
              <div class="wizard-reference-line"><span>首次扫描</span><strong>自动执行，无需离开向导</strong></div>
              <div class="wizard-inline-actions"><button class="btn primary" type="button" :disabled="wizardBusy" @click="saveKnowledge"><Icon name="refresh" :size="14" />保存并扫描</button></div>
            </div>

            <div v-else-if="currentGuideId === 'output-cache'" class="wizard-inline-body">
              <div class="form-grid">
                <Field label="默认输出" type="select" :options="OUTPUT_MODE_OPTIONS" v-model="wizard.outputMode" />
                <Field label="长文本自动转图片" type="select" :options="BOOL_OPTIONS" v-model="wizard.autoPicture" />
                <Field label="转图片阈值" type="number" v-model="wizard.pictureThreshold" hint="推荐 1200 字；群聊可在 1000～1600 之间调整。" />
              </div>
              <div class="wizard-success-note compact"><Icon name="key" :size="16" /><div><strong>安全默认值</strong><p>HTML/URL 截图保持关闭，私网地址保持拦截。</p></div></div>
              <div class="wizard-inline-actions"><button class="btn primary" type="button" :disabled="wizardBusy" @click="saveOutput"><Icon name="save" :size="14" />保存输出方式</button></div>
            </div>

            <div v-else-if="currentGuideId === 'web-chat-test'" class="wizard-inline-body">
              <Field label="测试问题" type="textarea" :rows="3" v-model="wizard.testPrompt" hint="测试对话不会调用工具、不会写入长期记忆，也不会向真实群聊发送消息。" />
              <div class="wizard-inline-actions"><button class="btn primary" type="button" :disabled="wizardBusy" @click="sendWizardTest"><Icon :name="wizardBusy ? 'activity' : 'message'" :class="{ 'icon-spin': wizardBusy }" :size="14" />{{ wizardBusy ? '正在等待回复…' : '发送测试' }}</button></div>
              <div v-if="wizardTestResult" class="wizard-test-result">
                <div class="wizard-test-meta"><span class="dot on"></span><strong>回复成功</strong><span>{{ wizardTestResult.channel || '默认模型' }}</span></div>
                <p>{{ wizardTestResult.text || '模型没有返回文本。' }}</p>
              </div>
            </div>
          </section>

          <div class="wizard-more-settings">
            <span>需要更细的参数？</span>
            <button class="btn small outline" type="button" @click="openGuideAction()">打开“{{ currentGuideStep.action?.label || '更多设置' }}”<Icon name="chevron-right" :size="14" /></button>
          </div>
        </div>
        <template #actions>
          <button class="btn outline" type="button" :disabled="guideIndex <= 0" @click="moveGuide(-1)"><Icon name="chevron-left" :size="14" />上一步</button>
          <button v-if="guideIndex < guideSteps.length - 1" class="btn primary" type="button" @click="moveGuide(1)">下一步<Icon name="chevron-right" :size="14" /></button>
          <button v-else class="btn primary" type="button" @click="showGuide = false"><Icon name="check" :size="14" />完成</button>
        </template>
      </SideDrawer>
    </div>
  `,
}
