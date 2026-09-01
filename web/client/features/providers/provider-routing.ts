import { computed, reactive, ref } from "vue"
import { refreshTab, saveConfigPatch, store, toast } from "../../app/store/store.js"
import { splitNames } from "../../shared/format.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import {
  BOOL_OFF_OPTIONS,
  STRATEGY_OPTIONS,
  runLocked,
  strategyLabel,
} from "./provider-shared.js"

interface RoutingModel extends UnknownRecord {
  name: string
  modelIdentifier?: string
  adapter?: string
  visual?: boolean
  toolUse?: boolean
}
interface SubAgentSettings extends UnknownRecord {
  enabled?: boolean
  task?: string
  maxDepth?: number
  maxTasksPerDispatch?: number
  maxToolRounds?: number
  maxToolCallsPerRound?: number
  maxConcurrency?: number
  maxDurationMs?: number
  allowedTools?: string[]
  systemPrompt?: string
}
interface RoutingConfig extends UnknownRecord {
  modelTasks?: Record<string, { modelList?: string[]; selectionStrategy?: string }>
  subAgent?: SubAgentSettings
  mediaRecognition?: { recognitionModel?: string }
  chat?: { modelRequestTimeoutMs?: number; modelStream?: boolean; defaultTask?: string }
  models?: RoutingModel[]
}
interface SubAgentRun extends UnknownRecord {
  task?: string
  caller?: string
  tools?: string[]
  toolRounds?: number
  ok?: boolean
  error?: string
  channel?: string
  chars?: number
  startedAt?: string
}
interface RoutingDigest extends UnknownRecord { summary?: { providers?: number; models?: number } }
interface RoutingPreview extends UnknownRecord {
  task?: string
  ok?: boolean
  candidateCount?: number
  candidates?: Array<RoutingModel & { provider?: string; timeoutMs?: number; stream?: boolean }>
}
interface ProviderDiagnostics extends UnknownRecord {
  routingDigest?: RoutingDigest
  routingPreview?: RoutingPreview
  routing?: RoutingDigest
  validation?: { issues?: UnknownRecord[] }
}
interface ProviderState extends UnknownRecord {
  diagnostics?: ProviderDiagnostics
  routing?: RoutingDigest
  routingPreview?: RoutingPreview
}

// 子代理配置 + 调用轨迹：从对话流程中独立出来，便于单独维护与扩展。
const SubAgentConfig = {
  name: "SubAgentConfig",
  props: { cfg: Object },
  setup(props: { cfg: RoutingConfig }) {
    const taskNames = computed(() => {
      const modelTasks = props.cfg.modelTasks || {}
      const names = Object.keys(modelTasks)
      return names.length ? names : ["replyer"]
    })
    const sub = props.cfg.subAgent || {}
    const draft = reactive({
      enabled: sub.enabled === true ? "true" : "false",
      task: sub.task || "replyer",
      maxDepth: sub.maxDepth ?? 1,
      maxTasksPerDispatch: sub.maxTasksPerDispatch ?? 3,
      maxToolRounds: sub.maxToolRounds ?? 4,
      maxToolCallsPerRound: sub.maxToolCallsPerRound ?? 4,
      maxConcurrency: sub.maxConcurrency ?? 3,
      maxDurationMs: sub.maxDurationMs ?? 120000,
      allowedTools: (sub.allowedTools || []).join(", "),
      systemPrompt: sub.systemPrompt || "",
    })
    const showDrawer = ref(false)
    const saving = ref(false)
    const runs = computed(() => asRecords<SubAgentRun>(asRecord(store.subAgentRuns).runs))
    async function save() {
      return runLocked(saving, async () => {
        try {
        await saveConfigPatch({
          "subAgent.enabled": draft.enabled === "true",
          "subAgent.task": draft.task,
          "subAgent.maxDepth": Number(draft.maxDepth) || 1,
          "subAgent.maxTasksPerDispatch": Number(draft.maxTasksPerDispatch) || 3,
          "subAgent.maxToolRounds": Number(draft.maxToolRounds),
          "subAgent.maxToolCallsPerRound": Number(draft.maxToolCallsPerRound) || 4,
          "subAgent.maxConcurrency": Number(draft.maxConcurrency) || 3,
          "subAgent.maxDurationMs": Number(draft.maxDurationMs) || 120000,
          "subAgent.allowedTools": splitNames(draft.allowedTools),
          "subAgent.systemPrompt": draft.systemPrompt,
        })
      } catch (err) { toast(errorMessage(err)) }})
    }
    return { draft, showDrawer, taskNames, runs, save, saving, BOOL_OFF_OPTIONS }
  },
  template: `
    <div class="stack" style="margin-top:12px">
      <div class="item subtle">
        <div class="item-head">
          <div class="item-title">子代理 · 让 AI 自主派生干活（实验）</div>
          <button class="btn small outline" type="button" @click="showDrawer = true"><Icon name="sliders" :size="14" />编辑</button>
        </div>
        <PillList :items="[
          { label: draft.enabled === 'true' ? '已启用' : '未启用', active: draft.enabled === 'true' },
          { label: '任务 ' + draft.task },
          { label: '并发 ' + draft.maxConcurrency },
          { label: '单次 ' + draft.maxTasksPerDispatch + ' 项' },
          { label: '轮次 ' + draft.maxToolRounds, tone: 'accent' }
        ]" />
      </div>
      <SideDrawer
        :open="showDrawer"
        title="子代理设置"
        subtitle="像 Codex / Claude Code 一样，允许 AI 派生子任务。"
        icon="bot"
        width="620px"
        @close="showDrawer = false"
      >
      <div class="hint-banner" :class="draft.enabled === 'true' ? 'ok' : 'warn'">
        <Icon :name="draft.enabled === 'true' ? 'check' : 'info'" :size="14" />
        <span>{{ draft.enabled === "true" ? "已启用：仅主人对话可调用 dispatch_subagent 派生子代理，用独立工具集干活后回灌结论" : "开启后，主人在对话中可自主派生子代理去完成子任务（查资料 / 分析 / 整理）" }}</span>
      </div>
      <div class="form-grid">
        <Field label="启用子代理" type="select" :options="BOOL_OFF_OPTIONS" v-model="draft.enabled" tip="开启后，主人对话里才可以派生子代理处理子任务。" />
        <Field label="子代理任务" type="select" :options="taskNames" v-model="draft.task" tip="子代理用哪个模型任务执行" />
        <Field label="最大递归深度" type="number" v-model="draft.maxDepth" tip="子代理能否再派生；默认 1（不可再派生），上限 5" />
        <Field label="单次最多子任务" type="number" v-model="draft.maxTasksPerDispatch" tip="一次 dispatch_subagent 最多接收多少个独立任务，上限 8" />
        <Field label="全局最大并发" type="number" v-model="draft.maxConcurrency" tip="所有对话共享的子代理运行上限，也用于单次批量并发" />
        <Field label="子代理工具轮次" type="number" v-model="draft.maxToolRounds" tip="子代理自己的工具调用轮数上限" />
        <Field label="每轮最多工具调用" type="number" v-model="draft.maxToolCallsPerRound" tip="限制模型一次返回过多并行工具调用，上限 8" />
        <Field label="单任务最长毫秒" type="number" v-model="draft.maxDurationMs" tip="包含模型和工具循环；默认 120000，范围 10000–600000" />
      </div>
      <Field label="子代理可用工具" hint="逗号分隔；独立于主对话，默认只读 / 检索类，不含发消息 / 再派生" v-model="draft.allowedTools" tip="这里是子代理自己的白名单；不写就按默认安全集合执行。" />
      <Field label="子代理系统提示词" type="textarea" v-model="draft.systemPrompt" tip="只写对子代理有效的补充要求，比如更偏分析、整理或审阅。" />
        <template #actions>
          <button class="btn outline" type="button" @click="showDrawer = false"><Icon name="x" :size="14" />取消</button>
          <button class="btn primary small" type="button" :disabled="saving" @click="save"><Icon name="save" :size="14" :class="{ 'icon-spin': saving }" />{{ saving ? "保存中..." : "保存子代理设置" }}</button>
        </template>
      </SideDrawer>
      <div class="section-title" style="margin-top:4px"><Icon name="activity" :size="13" />最近调用</div>
      <div v-if="runs.length" class="table-wrap" style="max-height:220px">
        <table class="data-table">
          <thead><tr><th>子任务</th><th>调用者</th><th>工具</th><th class="num">轮</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in runs" :key="i" :data-tip="(r.error ? r.error + ' · ' : '') + (r.channel || '-') + ' · ' + (r.chars || 0) + ' 字 · ' + (r.startedAt || '')">
              <td class="cell-title truncate" style="max-width:200px">{{ r.task }}</td>
              <td class="muted tiny">{{ r.caller || "-" }}</td>
              <td class="muted tiny truncate" style="max-width:160px">{{ (r.tools && r.tools.length) ? r.tools.join(", ") : "—" }}</td>
              <td class="num">{{ r.toolRounds }}</td>
              <td><span class="badge" :class="r.ok ? 'on' : 'risk-high'">{{ r.ok ? "完成" : "失败" }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted tiny">暂无子代理调用记录；启用后，AI 派生子代理的轨迹会显示在这里。</p>
    </div>
  `,
}

// 模型路由：默认回复任务 + fallback，媒体识别可指定增强模型。
export const ModelRoutingBuilder = {
  name: "ModelRoutingBuilder",
  components: { SubAgentConfig },
  props: { cfg: Object, modelNames: Array, compact: Boolean },
  setup(props: { cfg: RoutingConfig; modelNames: string[]; compact: boolean }) {
    const modelOptions = computed(() => [
      { value: "", label: "自动选择" },
      ...(props.modelNames || []).map(name => ({ value: name, label: name })),
    ])
    const draft = reactive({
      replyerModels: (props.cfg.modelTasks?.replyer?.modelList || props.modelNames).join(", "),
      replyerStrategy: props.cfg.modelTasks?.replyer?.selectionStrategy || "sequential",
      recognitionModel: props.cfg.mediaRecognition?.recognitionModel || "",
      modelRequestTimeoutMs: props.cfg.chat?.modelRequestTimeoutMs ?? 90000,
      modelStream: props.cfg.chat?.modelStream === true ? "true" : "false",
    })

    const replyerModelList = computed(() => splitNames(draft.replyerModels))
    const replyerStrategyLabel = computed(() => strategyLabel(draft.replyerStrategy))
    const replyerModelCards = computed(() => (props.cfg.models || []).map(model => ({
      ...model,
      selected: replyerModelList.value.includes(model.name),
      primary: replyerModelList.value[0] === model.name,
    })))
    const visionOk = computed(() => {
      const models = props.cfg.models || []
      return replyerModelList.value.some(name => models.find(m => m.name === name)?.visual)
    })

    const providerState = computed(() => asRecord<ProviderState>(store.providers))
    const digest = computed(() => providerState.value.diagnostics?.routingDigest || providerState.value.routing || {})
    const digestSummary = computed(() => digest.value.summary || {})
    const digestMetrics = computed(() => [
      { label: "供应商", value: digestSummary.value.providers || 0, icon: "server", tone: "blue" },
      { label: "模型", value: digestSummary.value.models || 0, icon: "cpu", tone: "purple" },
      { label: "回复模型", value: replyerModelList.value.length, icon: "filter", tone: "cyan" },
      { label: "默认任务", value: props.cfg.chat?.defaultTask || "replyer", icon: "sparkles", tone: "pink" },
    ])
    const previewResult = computed(() => providerState.value.diagnostics?.routingPreview || providerState.value.routingPreview || {})
    const diagIssues = computed(() => providerState.value.diagnostics?.validation?.issues || [])
    const showDrawer = ref(false)
    const saving = ref(false)
    const previewing = ref(false)

    function toggleReplyerModel(name: string) {
      const rows = [...replyerModelList.value]
      const index = rows.indexOf(name)
      if (index >= 0) rows.splice(index, 1)
      else rows.push(name)
      draft.replyerModels = rows.join(", ")
    }

    function makePrimaryModel(name: string) {
      const rows = replyerModelList.value.filter(item => item !== name)
      draft.replyerModels = [name, ...rows].join(", ")
    }

    // 常用保存：单模型主对话 + 工具调用 + fallback 渠道
    async function saveSimple() {
      return runLocked(saving, async () => {
        try {
        const replyer = splitNames(draft.replyerModels)
        if (!replyer.length) throw new Error("请填写至少一个回复模型")
        const patch = {
          "chat.defaultTask": "replyer",
          "chat.defaultChannel": replyer[0],
          "modelTasks.replyer.modelList": replyer,
          "modelTasks.replyer.selectionStrategy": draft.replyerStrategy,
          "mediaRecognition.recognitionModel": draft.recognitionModel,
          "chat.modelRequestTimeoutMs": Number(draft.modelRequestTimeoutMs) || 90000,
          "chat.modelStream": draft.modelStream === "true",
        }
        await saveConfigPatch(patch)
        toast(draft.replyerStrategy === "fallback" ? "已设为主对话 + fallback 回复" : "已设为单模型直接回复")
      } catch (err) { toast(errorMessage(err)) }})
    }

    async function runPreview() {
      return runLocked(previewing, async () => {
        try {
        await refreshTab("providers")
        const preview = providerState.value.diagnostics?.routingPreview || {}
        toast(`路由预览完成：${preview.candidateCount || 0} 个候选模型`)
      } catch (err) { toast(errorMessage(err)) }})
    }

    return {
      store,
      modelOptions, STRATEGY_OPTIONS, BOOL_OFF_OPTIONS, draft, replyerModelList, replyerModelCards,
      replyerStrategyLabel,
      visionOk,
      digest, digestMetrics, previewResult, diagIssues, showDrawer,
      saving, previewing, toggleReplyerModel, makePrimaryModel, saveSimple, runPreview,
    }
  },
  template: `
    <div class="model-routing-shell" :class="{ compact }">
      <section v-if="compact" class="provider-routing-compact">
        <div class="provider-routing-compact-main">
          <div class="section-title"><Icon name="sparkles" :size="13" />全局回复设置</div>
          <PillList :items="[
            { label: '主模型 ' + (replyerModelList[0] || '尚未设置'), active: !!replyerModelList.length },
            { label: '备用 ' + Math.max(0, replyerModelList.length - 1) },
            { label: '策略 ' + replyerStrategyLabel },
            { label: draft.modelStream === 'true' ? '默认流式' : '默认非流式', tone: draft.modelStream === 'true' ? 'accent' : '' }
          ]" />
        </div>
        <button class="btn small outline" type="button" @click="showDrawer = true"><Icon name="sliders" :size="14" />全局设置</button>
      </section>

      <Panel v-else title="回复方案" icon="sparkles">
        <template #actions>
          <button class="btn small outline" type="button" @click="showDrawer = true"><Icon name="sliders" :size="14" />全局设置</button>
        </template>
        <PillList :items="[
          { label: '回复模型 ' + replyerModelList.length, active: true },
          { label: '策略 ' + replyerStrategyLabel },
          { label: '超时 ' + Math.round(Number(draft.modelRequestTimeoutMs || 0) / 1000) + ' 秒' },
          { label: draft.modelStream === 'true' ? '默认流式' : '默认非流式', tone: draft.modelStream === 'true' ? 'accent' : '' },
          { label: draft.recognitionModel ? ('识图增强 ' + draft.recognitionModel) : '识图自动选择', tone: 'accent' }
        ]" />

        <Collapse title="查看路由详情" :hint="replyerModelList.length + ' 个候选模型'">
        <MetricGrid :items="digestMetrics" compact />
        <div v-if="(previewResult.candidates || []).length" class="item subtle" style="margin-top:10px">
          <div class="item-head">
            <div class="item-title">预览 · {{ previewResult.task || "replyer" }}</div>
            <span class="badge" :class="previewResult.ok === false ? 'risk-high' : 'on'">{{ previewResult.ok === false ? "有错误" : "就绪" }}</span>
          </div>
          <div v-for="(m, i) in previewResult.candidates" :key="i" class="row" style="margin-top:6px" :data-tip="m.name + ' / ' + (m.adapter || '-')">
            <span class="flow-node-num">{{ i + 1 }}</span>
            <span class="badge accent">{{ i === 0 ? "主用" : "回退" }}</span>
            <span class="badge">{{ m.provider || "-" }}</span>
            <span class="muted tiny">{{ m.name }}</span>
            <span class="badge">{{ Math.round(Number(m.timeoutMs || 0) / 1000) }} 秒</span>
            <span class="badge" :class="m.stream ? 'on' : ''">{{ m.stream ? "流式" : "非流式" }}</span>
          </div>
        </div>
        </Collapse>

        <SubAgentConfig v-if="store.developerMode" :cfg="cfg" />

        <div v-if="diagIssues.length" class="table-wrap" style="max-height:180px">
          <table class="data-table">
            <thead><tr><th>区域</th><th>级别</th><th>说明</th></tr></thead>
            <tbody>
              <tr v-for="(it, i) in diagIssues" :key="i">
                <td class="cell-title">{{ it.area || "config" }}<span v-if="it.id" class="muted">/{{ it.id }}</span></td>
                <td><span class="badge" :class="it.level === 'error' ? 'risk-high' : 'risk-medium'">{{ it.level }}</span></td>
                <td class="muted">{{ it.message || "" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      <SideDrawer
        :open="showDrawer"
        title="全局回复设置"
        subtitle="选择主回复模型、备用模型和全局传输参数。"
        icon="sparkles"
        width="620px"
        @close="showDrawer = false"
      >
        <div class="form-section">
          <div class="section-title"><Icon name="bot" :size="13" />回复模型</div>
          <div class="routing-model-picker" role="group" aria-label="选择回复模型">
            <div
              v-for="model in replyerModelCards"
              :key="model.name"
              class="routing-model-card"
              :class="{ selected: model.selected, primary: model.primary }"
            >
              <button class="routing-model-toggle" type="button" :aria-pressed="model.selected" @click="toggleReplyerModel(model.name)">
                <span class="model-select-indicator"><Icon :name="model.selected ? 'check' : 'plus'" :size="13" /></span>
                <span class="routing-model-copy"><strong>{{ model.name }}</strong><small>{{ model.modelIdentifier || model.adapter || '模型' }}</small></span>
                <span v-if="model.primary" class="badge accent"><Icon name="sparkles" :size="11" />主模型</span>
                <span v-else-if="model.selected" class="badge accent">备用 {{ replyerModelList.indexOf(model.name) }}</span>
              </button>
              <button v-if="model.selected && !model.primary" class="routing-make-primary" type="button" @click="makePrimaryModel(model.name)">设为主模型</button>
              <div class="routing-model-capabilities">
                <span v-if="model.visual">支持图片</span><span v-if="model.toolUse">支持工具</span><span>{{ model.adapter || '默认协议' }}</span>
              </div>
            </div>
          </div>
          <p class="muted tiny">点击卡片加入或移除。带高亮光环的是主模型，其余已选模型会在主模型失败时作为备用。</p>
          <Field label="选择策略" type="select" :options="STRATEGY_OPTIONS" v-model="draft.replyerStrategy" tip="推荐“失败回退”：先用主模型，失败时再自动切到后备模型。" />
          <div class="form-grid dense">
            <Field label="全局请求超时（毫秒）" type="number" v-model="draft.modelRequestTimeoutMs" tip="所有模型默认使用；单个模型可以在“模型服务 → 编辑模型”中覆盖。范围 1000–600000。" />
            <Field label="默认流式响应" type="select" :options="BOOL_OFF_OPTIONS" v-model="draft.modelStream" tip="OpenAI Compatible、Qwen、ChatGLM 会使用 SSE；其他协议暂按非流式执行。" />
          </div>
          <Field label="媒体识别增强模型" type="select" :options="modelOptions" v-model="draft.recognitionModel" tip="主模型不识图时，recognize_media 工具优先使用这个模型；留空则自动选择视觉模型或回复模型" />
          <div class="hint-banner" :class="visionOk ? 'ok' : 'warn'">
            <Icon :name="visionOk ? 'check' : 'alert'" :size="14" />
            <span>{{ visionOk ? "回复模型支持图像识别，图片会随主对话直接发送给模型" : "回复模型不支持图像识别，可启用 recognize_media 工具让模型按需识别媒体" }}</span>
          </div>
          <p class="muted tiny">常规聊天只使用默认回复任务：主回复模型负责对话、工具调用和媒体上下文；多个回复模型请把策略设为 fallback 做失败回退。</p>
        </div>
        <template #actions>
          <button class="btn primary" type="button" :disabled="saving" @click="saveSimple"><Icon name="save" :size="14" :class="{ 'icon-spin': saving }" />{{ saving ? "保存中..." : "保存回复方案" }}</button>
          <button class="btn outline" type="button" :disabled="previewing" @click="runPreview()"><Icon name="eye" :size="14" :class="{ 'icon-spin': previewing }" />{{ previewing ? "刷新中..." : "刷新预览" }}</button>
        </template>
      </SideDrawer>
    </div>
  `,
}
