import { reactive, computed, ref, watch } from "vue"
import { confirmAction, store, request, toast, refreshTab } from "../../app/store/store.js"
import { splitTokens, parseJsonText, toJson } from "../../shared/format.js"
import { asRecord, errorMessage, type UnknownRecord } from "../../shared/data.js"
import {
  BOOL_OFF_OPTIONS,
  BOOL_OPTIONS,
  INHERIT_BOOL_OPTIONS,
  REASONING_EFFORT_OPTIONS,
  REASONING_TARGET_OPTIONS,
  requestProviderModels,
  runLocked,
  uniqueModelIds,
} from "./provider-shared.js"

interface ProviderTemplate extends UnknownRecord {
  id: string
  label?: string
  providerName?: string
  baseURL?: string
  modelIdentifier?: string
  authType?: string
}
interface RemoteModel extends UnknownRecord {
  id: string
  label?: string
  description?: string
  methods?: string[]
  ownedBy?: string
}
interface ProviderConfig extends UnknownRecord {
  name: string
  baseURL?: string
  headers?: UnknownRecord
  apiKey?: string
  type?: string
}
interface ModelConfig extends UnknownRecord {
  name: string
  modelIdentifier?: string
  apiProvider?: string
  capabilities?: { chat?: boolean; embedding?: boolean }
  embedding?: { protocol?: string; defaultDimensions?: number; allowedDimensions?: number[]; supportsDimensionOverride?: boolean; batchSize?: number; timeoutMs?: number; params?: UnknownRecord }
  visual?: boolean
  toolUse?: boolean
  timeoutMs?: number
  stream?: boolean
  priceIn?: number
  priceOut?: number
  reasoning?: { target?: string; effort?: string }
  params?: UnknownRecord
}
interface RequestResult extends UnknownRecord {
  models?: RemoteModel[]
  result?: { channel?: string }
  config?: UnknownRecord
  diagnostics?: UnknownRecord
}
type Emit = (event: string) => void

// 添加模型渠道：本地草稿，保存后不清空，方便连续添加。
export const AddChannelForm = {
  name: "AddChannelForm",
  props: { templates: Array, defaultTask: String },
  emits: ["added"],
  setup(props: { templates: ProviderTemplate[]; defaultTask?: string }, { emit }: { emit: Emit }) {
    const draft = reactive({
      providerTemplate: props.templates[0]?.id || "openai",
      providerName: "",
      modelIdentifiers: "",
      apiKey: "",
      baseURL: "https://api.openai.com/v1",
      headers: "{}",
    })
    const loadingModels = ref(false)
    const addingChannel = ref(false)
    const testingChannel = ref(false)
    const fetchedModels = ref<RemoteModel[]>([])
    const selectedModelIds = ref<string[]>([])
    const modelFilter = ref("")
    const templateOptions = computed(() => (props.templates || []).map(item => ({ value: item.id, label: item.label || item.id })))
    const currentTemplate = computed<ProviderTemplate>(() => (props.templates || []).find(item => item.id === draft.providerTemplate) || { id: "" })
    const modelCount = computed(() => splitTokens(draft.modelIdentifiers).length)
    const filteredFetchedModels = computed(() => {
      const keyword = modelFilter.value.trim().toLowerCase()
      if (!keyword) return fetchedModels.value
      return fetchedModels.value.filter(item => {
        const haystack = [item.id, item.label, item.description, ...(item.methods || [])].join(" ").toLowerCase()
        return haystack.includes(keyword)
      })
    })
    const selectedRemoteCount = computed(() => selectedModelIds.value.length)
    const endpointPreset = computed(() => {
      const template = currentTemplate.value
      return [
        template.label || template.id || "渠道模板",
        draft.baseURL || template.baseURL || "自定义端点",
      ].filter(Boolean).join(" / ")
    })

    function syncModelIdentifiers() {
      draft.modelIdentifiers = selectedModelIds.value.join("\n")
    }

    function syncSelectedFromText() {
      const selected = new Set(splitTokens(draft.modelIdentifiers))
      selectedModelIds.value = fetchedModels.value
        .map(item => item.id)
        .filter(id => selected.has(id))
    }

    function applyTemplate({ notify = true }: { notify?: boolean } = {}) {
      const template = (props.templates || []).find(item => item.id === draft.providerTemplate)
      if (!template) {
        if (notify) toast("未找到模板")
        return
      }
      draft.providerName = template.providerName || draft.providerName
      draft.baseURL = template.baseURL || ""
      draft.modelIdentifiers = template.modelIdentifier || ""
      draft.headers = "{}"
      fetchedModels.value = []
      selectedModelIds.value = splitTokens(draft.modelIdentifiers)
      modelFilter.value = ""
      if (notify) toast(`已套用 ${template.label || template.id} 模板`)
    }
    watch(() => draft.providerTemplate, () => applyTemplate({ notify: false }))
    watch(() => props.templates, templates => {
      if (!templates?.length) return
      if (!templates.find(item => item.id === draft.providerTemplate)) draft.providerTemplate = templates[0].id
      if (!draft.providerName || !draft.modelIdentifiers) applyTemplate({ notify: false })
    }, { deep: true })
    if (!draft.providerName || !draft.modelIdentifiers) applyTemplate({ notify: false })

    async function fetchModels() {
      return runLocked(loadingModels, async () => {
        try {
        const result = asRecord<RequestResult>(await requestProviderModels({
          templateId: draft.providerTemplate,
          providerName: draft.providerName,
          baseURL: draft.baseURL,
          apiKey: draft.apiKey,
          headers: parseJsonText(draft.headers, `${draft.providerName || draft.providerTemplate} headers`, {}),
        }))
        fetchedModels.value = result.models ? result.models : []
        const existingIds = new Set(splitTokens(draft.modelIdentifiers))
        selectedModelIds.value = fetchedModels.value
          .map(item => item.id)
          .filter(id => existingIds.has(id))
        if (!selectedModelIds.value.length) {
          const preferred = String(currentTemplate.value.modelIdentifier || "").trim()
          if (preferred && fetchedModels.value.some(item => item.id === preferred)) {
            selectedModelIds.value = [preferred]
            syncModelIdentifiers()
          }
        }
        toast(`已拉取 ${fetchedModels.value.length || 0} 个模型`)
      } catch (err) {
        fetchedModels.value = []
        selectedModelIds.value = []
        toast(errorMessage(err))
      }})
    }

    function toggleFetchedModel(id: string, checked: boolean) {
      const next = new Set(selectedModelIds.value)
      if (checked) next.add(id)
      else next.delete(id)
      selectedModelIds.value = uniqueModelIds([...next])
      syncModelIdentifiers()
    }

    function selectAllFetchedModels() {
      selectedModelIds.value = uniqueModelIds(filteredFetchedModels.value.map(item => item.id))
      syncModelIdentifiers()
    }

    function clearFetchedSelection() {
      selectedModelIds.value = []
      syncModelIdentifiers()
    }

    watch(() => draft.modelIdentifiers, () => {
      if (!fetchedModels.value.length) return
      syncSelectedFromText()
    })

    async function quickAdd() {
      return runLocked(addingChannel, async () => {
        try {
        const models = splitTokens(draft.modelIdentifiers)
        if (!models.length) throw new Error("请至少填写一个模型 ID")
        const result = asRecord<RequestResult>(await request("/api/providers/quick-add", {
          method: "POST",
          body: JSON.stringify({
            templateId: draft.providerTemplate,
            providerName: draft.providerName,
            baseURL: draft.baseURL,
            apiKey: draft.apiKey,
            headers: parseJsonText(draft.headers, `${draft.providerName || draft.providerTemplate} headers`, {}),
            modelIdentifiers: models,
          }),
        }))
        toast(`已添加 ${result.models?.length || 1} 个模型到默认回复`)
        draft.apiKey = ""
        await refreshTab("providers")
        emit("added")
      } catch (err) {
        toast(errorMessage(err))
      }})
    }
    async function testChannel() {
      return runLocked(testingChannel, async () => {
        try {
        const result = asRecord<RequestResult>(await request("/api/channels/test", { method: "POST", body: "{}" }))
        toast(`渠道测试完成：${result.result?.channel || "-"}`)
      } catch (err) {
        toast(errorMessage(err))
      }})
    }
    return {
      draft, templateOptions, endpointPreset, modelCount,
      loadingModels, addingChannel, testingChannel, fetchedModels, filteredFetchedModels, selectedModelIds, selectedRemoteCount, modelFilter,
      applyTemplate, fetchModels, toggleFetchedModel, selectAllFetchedModels, clearFetchedSelection, quickAdd, testChannel,
    }
  },
  template: `
    <Panel title="添加模型服务" icon="plus">
      <div class="form-section">
        <div class="section-title"><Icon name="server" :size="13" />渠道信息</div>
        <div class="form-grid">
          <Field label="渠道类型" type="select" :options="templateOptions" v-model="draft.providerTemplate" tip="选择后会自动填入常见端点和鉴权方式" />
          <Field label="渠道名称" v-model="draft.providerName" placeholder="openai-main" tip="同一个渠道下可以挂多个模型" />
          <Field label="Base URL" v-model="draft.baseURL" placeholder="https://api.openai.com/v1" tip="官方兼容端点通常填到 /v1 即可；不要把具体接口路径拼进去。" />
          <Field label="API Key" type="password" v-model="draft.apiKey" placeholder="sk-..." tip="仅保存在本地插件配置中，用于该渠道的统一鉴权。" />
        </div>
        <Field label="模型列表" type="textarea" :rows="3" v-model="draft.modelIdentifiers" placeholder="gpt-4o-mini&#10;gpt-4.1-mini" hint="一行一个，也支持逗号分隔" tip="这里只填渠道实际支持的模型 ID；后续可以在模型路由里设主用和 fallback。" />
        <div class="action-bar compact">
          <button class="btn small outline" type="button" :disabled="loadingModels" @click="fetchModels">
            <Icon :name="loadingModels ? 'activity' : 'refresh'" :size="14" :class="{ 'icon-spin': loadingModels }" />
            {{ loadingModels ? "拉取中..." : "自动拉取模型" }}
          </button>
          <button class="btn small outline" type="button" :disabled="!fetchedModels.length" @click="selectAllFetchedModels"><Icon name="check" :size="14" />全选当前结果</button>
          <button class="btn small outline" type="button" :disabled="!selectedRemoteCount" @click="clearFetchedSelection"><Icon name="eraser" :size="14" />清空勾选</button>
        </div>
        <div v-if="fetchedModels.length" class="model-picker">
          <div class="row">
            <Field class="grow" label="筛选拉取结果" v-model="modelFilter" placeholder="按模型 ID、名称或描述筛选" />
            <span class="filter-count">已勾选 {{ selectedRemoteCount }} / {{ fetchedModels.length }}</span>
          </div>
          <div class="model-picker-grid">
            <label v-for="item in filteredFetchedModels" :key="item.id" class="model-option" :class="{ active: selectedModelIds.includes(item.id) }">
              <input
                class="model-option-input"
                type="checkbox"
                :checked="selectedModelIds.includes(item.id)"
                @change="toggleFetchedModel(item.id, $event.target.checked)"
              />
              <span class="model-select-indicator"><Icon name="check" :size="13" /></span>
              <div class="model-option-body">
                <div class="model-option-head">
                  <strong>{{ item.id }}</strong>
                  <span v-if="item.ownedBy" class="badge subtle">{{ item.ownedBy }}</span>
                </div>
                <div v-if="item.description" class="muted tiny">{{ item.description }}</div>
              </div>
            </label>
          </div>
        </div>
        <div class="hint-banner ok">
          <Icon name="info" :size="14" />
          <span>将添加 {{ modelCount || 0 }} 个模型到默认回复任务；多个模型可在下方“模型路由”里切换 fallback。</span>
        </div>
      </div>
      <Collapse title="高级扩展" :hint="endpointPreset">
        <Field label="额外 Headers JSON" type="textarea" :rows="4" v-model="draft.headers" hint="仅在网关要求附加请求头时填写；普通 OpenAI / Gemini / Claude 不需要展开。" />
      </Collapse>
      <div class="action-bar">
        <button class="btn outline" type="button" @click="applyTemplate()"><Icon name="sparkles" :size="14" />重置为模板</button>
        <button class="btn primary" type="button" :disabled="addingChannel" @click="quickAdd"><Icon name="plus" :size="14" :class="{ 'icon-spin': addingChannel }" />{{ addingChannel ? "添加中..." : "添加渠道" }}</button>
        <button class="btn outline" type="button" :disabled="testingChannel" @click="testChannel"><Icon name="play" :size="14" :class="{ 'icon-spin': testingChannel }" />{{ testingChannel ? "测试中..." : "测试默认渠道" }}</button>
      </div>
    </Panel>
  `,
}

// 供应商凭据编辑：默认只保留最常用参数，额外请求头放到高级扩展。
export const ProviderEditor = {
  name: "ProviderEditor",
  emits: ["saved"],
  props: { provider: Object },
  setup(props: { provider: ProviderConfig }, { emit }: { emit: Emit }) {
    const draft = reactive({
      baseURL: props.provider.baseURL || "",
      apiKey: "",
      clearApiKey: "false",
      headers: toJson(props.provider.headers || {}),
    })
    const saving = ref(false)
    async function save() {
      return runLocked(saving, async () => {
        try {
        const name = props.provider.name
        if (draft.clearApiKey === "true") {
          const accepted = await confirmAction({ title: `清空“${name}”的 API Key？`, message: "清空后，该模型服务会停止鉴权调用，直到重新填写密钥。", confirmText: "确认清空密钥", tone: "warn", icon: "key" })
          if (!accepted) return
        }
        const body: UnknownRecord = {
          baseURL: draft.baseURL,
          headers: parseJsonText(draft.headers, `${name} headers`, {}),
          clearApiKey: draft.clearApiKey === "true",
        }
        if (draft.apiKey.trim()) body.apiKey = draft.apiKey.trim()
        const result = asRecord<RequestResult>(await request(`/api/providers/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify(body) }))
        store.config = asRecord(result.config)
        store.providers = { ...asRecord(store.providers), diagnostics: result.diagnostics }
        draft.apiKey = ""
        draft.clearApiKey = "false"
        toast(`已保存供应商 ${name}`)
        await refreshTab("providers")
        emit("saved")
      } catch (err) {
        toast(errorMessage(err))
      }})
    }
    return { draft, save, saving, BOOL_OFF_OPTIONS }
  },
  template: `
      <div class="settings-stack">
      <div class="form-grid dense">
        <Field label="Base URL" v-model="draft.baseURL" placeholder="https://api.example.com/v1" tip="留空时沿用模板默认端点；自建网关或代理时再改。" />
        <Field label="替换 API Key" type="password" v-model="draft.apiKey" :placeholder="provider.apiKey ? '留空保持当前密钥' : '输入 API Key'" tip="编辑态不会回显旧密钥；留空就保持不变。" />
        <Field label="清空 API Key" type="select" :options="BOOL_OFF_OPTIONS" v-model="draft.clearApiKey" tip="开启后会移除已保存的密钥；通常只在换渠道或停用时使用。" />
      </div>
      <Collapse title="高级扩展" hint="仅在代理要求额外请求头时填写" nested>
        <Field label="额外 Headers JSON" type="textarea" :rows="5" v-model="draft.headers" />
      </Collapse>
      <div class="row row-end">
        <button class="btn primary small" type="button" :disabled="saving" @click="save"><Icon name="save" :size="14" :class="{ 'icon-spin': saving }" />{{ saving ? "保存中..." : "保存供应商" }}</button>
      </div>
    </div>
  `,
}

// 模型参数编辑器：默认保留基础路由与能力，价格和私有参数收进高级扩展。
export const ModelEditor = {
  name: "ModelEditor",
  emits: ["saved"],
  props: { model: Object, providers: Array },
  setup(props: { model: ModelConfig; providers: string[] }, { emit }: { emit: Emit }) {
    const draft = reactive({
      modelIdentifier: props.model.modelIdentifier || "",
      apiProvider: props.model.apiProvider || props.providers[0] || "mock",
      chatCapability: String(props.model.capabilities?.chat !== false),
      embeddingCapability: String(Boolean(props.model.capabilities?.embedding)),
      embeddingProtocol: props.model.embedding?.protocol || "openai-compatible",
      embeddingDimensions: props.model.embedding?.defaultDimensions ?? 1024,
      embeddingAllowedDimensions: (props.model.embedding?.allowedDimensions || []).join(", "),
      embeddingSupportsOverride: String(props.model.embedding?.supportsDimensionOverride !== false),
      embeddingBatchSize: props.model.embedding?.batchSize ?? 16,
      embeddingTimeoutMs: props.model.embedding?.timeoutMs ?? 30000,
      embeddingParams: toJson(props.model.embedding?.params || {}),
      visual: String(Boolean(props.model.visual)),
      toolUse: String(props.model.toolUse !== false),
      timeoutSeconds: (props.model.timeoutMs == null ? 60 : Math.round(props.model.timeoutMs / 1000)) as number | "",
      contextWindowTokens: props.model.contextWindowTokens ?? 200000,
      stream: props.model.stream === undefined ? "" : String(Boolean(props.model.stream)),
      priceIn: props.model.priceIn ?? 0,
      priceOut: props.model.priceOut ?? 0,
      reasoningTarget: props.model.reasoning?.target || "auto",
      reasoningEffort: props.model.reasoning?.effort || "",
      params: toJson(props.model.params || {}),
    })
    const providerOptions = computed(() => (props.providers.length ? props.providers : [draft.apiProvider]))
    const loadingModels = ref(false)
    const saving = ref(false)
    const fetchedModels = ref<RemoteModel[]>([])
    const modelFilter = ref("")
    const filteredFetchedModels = computed(() => {
      const keyword = modelFilter.value.trim().toLowerCase()
      if (!keyword) return fetchedModels.value
      return fetchedModels.value.filter(item => {
        const haystack = [item.id, item.label, item.description, ...(item.methods || [])].join(" ").toLowerCase()
        return haystack.includes(keyword)
      })
    })
    watch(() => draft.apiProvider, () => {
      fetchedModels.value = []
      modelFilter.value = ""
    })

    async function fetchModels() {
      return runLocked(loadingModels, async () => {
        try {
        if (!draft.apiProvider) throw new Error("请先选择 Provider")
        const result = asRecord<RequestResult>(await requestProviderModels({ providerName: draft.apiProvider }))
        fetchedModels.value = result.models ? result.models : []
        toast(`已从 ${draft.apiProvider} 拉取 ${fetchedModels.value.length || 0} 个模型`)
      } catch (err) {
        fetchedModels.value = []
        toast(errorMessage(err))
      }})
    }

    function chooseModelIdentifier(id: string) {
      draft.modelIdentifier = String(id || "").trim()
    }

    function applyBgePreset() {
      draft.modelIdentifier = "BAAI/bge-m3"
      draft.chatCapability = "false"
      draft.embeddingCapability = "true"
      draft.visual = "false"
      draft.toolUse = "false"
      draft.embeddingProtocol = "openai-compatible"
      draft.embeddingDimensions = 1024
      draft.embeddingAllowedDimensions = "1024"
      draft.embeddingSupportsOverride = "false"
      draft.embeddingBatchSize = 16
      draft.embeddingTimeoutMs = 30000
      draft.embeddingParams = "{}"
      toast("已套用 BGE-M3 向量模型预设")
    }

    async function save() {
      return runLocked(saving, async () => {
        try {
        const name = props.model.name
        const result = asRecord<RequestResult>(await request(`/api/models/${encodeURIComponent(name)}`, {
          method: "PATCH",
          body: JSON.stringify({
            modelIdentifier: draft.modelIdentifier,
            apiProvider: draft.apiProvider,
            visual: draft.visual === "true",
            toolUse: draft.toolUse !== "false",
            timeoutMs: draft.timeoutSeconds === "" ? null : Math.round(Number(draft.timeoutSeconds) * 1000),
            contextWindowTokens: draft.contextWindowTokens === "" ? null : Number(draft.contextWindowTokens),
            stream: draft.stream === "" ? null : draft.stream === "true",
            priceIn: Number(draft.priceIn || 0),
            priceOut: Number(draft.priceOut || 0),
            reasoning: draft.reasoningEffort
              ? { target: draft.reasoningTarget || "auto", effort: draft.reasoningEffort }
              : (draft.reasoningTarget && draft.reasoningTarget !== "auto" ? { target: draft.reasoningTarget, effort: "" } : null),
            capabilities: {
              chat: draft.chatCapability !== "false",
              embedding: draft.embeddingCapability === "true",
            },
            embedding: draft.embeddingCapability === "true"
              ? {
                protocol: draft.embeddingProtocol || "openai-compatible",
                defaultDimensions: Number(draft.embeddingDimensions || 0),
                allowedDimensions: splitTokens(draft.embeddingAllowedDimensions).map(Number).filter(Number.isFinite),
                supportsDimensionOverride: draft.embeddingSupportsOverride !== "false",
                batchSize: Number(draft.embeddingBatchSize || 16),
                timeoutMs: Number(draft.embeddingTimeoutMs || 30000),
                params: parseJsonText(draft.embeddingParams, `${name} embedding params`, {}),
              }
              : null,
            params: parseJsonText(draft.params, `${name} params`, {}),
          }),
        }))
        store.config = asRecord(result.config)
        store.providers = { ...asRecord(store.providers), diagnostics: result.diagnostics }
        toast(`已保存模型 ${name}`)
        await refreshTab("providers")
        emit("saved")
      } catch (err) {
        toast(errorMessage(err))
      }})
    }
    return {
      draft, providerOptions, loadingModels, saving, fetchedModels, modelFilter, filteredFetchedModels,
      fetchModels, chooseModelIdentifier, applyBgePreset, save, BOOL_OPTIONS, BOOL_OFF_OPTIONS, INHERIT_BOOL_OPTIONS,
      REASONING_TARGET_OPTIONS, REASONING_EFFORT_OPTIONS,
    }
  },
  template: `
    <div class="settings-stack">
      <div class="form-grid dense">
        <Field label="Model ID" v-model="draft.modelIdentifier" placeholder="gpt-4o-mini" tip="真正请求时发给上游的模型名；和本地显示名称可以不同。" />
        <Field label="Provider" type="select" :options="providerOptions" v-model="draft.apiProvider" tip="切换到哪个渠道去调用这个模型。" />
        <Field label="聊天能力" type="select" :options="BOOL_OPTIONS" v-model="draft.chatCapability" tip="关闭后不会进入聊天任务，只作为向量模型使用。" />
        <Field label="向量能力" type="select" :options="BOOL_OPTIONS" v-model="draft.embeddingCapability" tip="开启后可在知识库中选择；BGE-M3 建议使用 1024 维。" />
        <Field label="视觉能力" type="select" :options="BOOL_OFF_OPTIONS" v-model="draft.visual" tip="开启后才能参与媒体识别或图像理解链路。" />
        <Field label="工具调用" type="select" :options="BOOL_OPTIONS" v-model="draft.toolUse" tip="主对话模型建议开启；纯识图补强模型可以按需关闭。" />
        <Field label="请求超时（秒）" type="number" v-model="draft.timeoutSeconds" placeholder="默认 60" tip="只覆盖当前模型；建议 Grok 等慢模型设置 90–180 秒。留空则继承全局默认。" />
        <Field label="上下文窗口（tokens）" type="number" v-model="draft.contextWindowTokens" placeholder="留空使用全局聊天预算" tip="模型上下文窗口。会话输入预算 = 窗口 − 输出预留 − 安全边际；留空时回落聊天设置里的全局输入预算（默认 6000），工具结果和大历史会被完整保留。" />
        <Field label="流式响应" type="select" :options="INHERIT_BOOL_OPTIONS" v-model="draft.stream" tip="留空继承全局。OpenAI Compatible、Qwen、ChatGLM 支持；其他协议暂按非流式执行。" />
      </div>
      <Collapse v-if="draft.embeddingCapability === 'true'" title="向量模型参数" hint="知识库 / 记忆可复用" nested>
        <div class="form-grid dense">
          <Field label="Embedding 协议" type="select" :options="[{ value: 'openai-compatible', label: 'OpenAI Compatible' }]" v-model="draft.embeddingProtocol" />
          <Field label="默认维度" type="number" v-model="draft.embeddingDimensions" tip="BGE-M3 固定为 1024。" />
          <Field label="允许维度" v-model="draft.embeddingAllowedDimensions" placeholder="1024" tip="逗号分隔；留空表示不限制。" />
          <Field label="允许覆盖维度" type="select" :options="BOOL_OFF_OPTIONS" v-model="draft.embeddingSupportsOverride" />
          <Field label="批大小" type="number" v-model="draft.embeddingBatchSize" />
          <Field label="Embedding 超时（毫秒）" type="number" v-model="draft.embeddingTimeoutMs" />
        </div>
        <div class="action-bar compact">
          <button class="btn small outline" type="button" @click="applyBgePreset"><Icon name="sparkles" :size="14" />套用 BGE-M3 预设</button>
        </div>
        <Field label="Embedding Params JSON" type="textarea" :rows="3" v-model="draft.embeddingParams" tip="网关要求额外字段时填写；普通 BGE-M3 接口保持 {}。" />
      </Collapse>
      <div class="action-bar compact">
        <button class="btn small outline" type="button" :disabled="loadingModels" @click="fetchModels">
          <Icon :name="loadingModels ? 'activity' : 'refresh'" :size="14" :class="{ 'icon-spin': loadingModels }" />
          {{ loadingModels ? "拉取中..." : "从 Provider 拉取模型" }}
        </button>
      </div>
      <div v-if="fetchedModels.length" class="model-picker">
        <div class="row">
          <Field class="grow" label="筛选拉取结果" v-model="modelFilter" placeholder="按模型 ID、名称或描述筛选" />
          <span class="filter-count">当前使用 {{ draft.modelIdentifier || "未选择" }}</span>
        </div>
        <div class="model-picker-grid">
          <button
            v-for="item in filteredFetchedModels"
            :key="item.id"
            class="model-option buttonlike"
            :class="{ active: draft.modelIdentifier === item.id }"
            type="button"
            @click="chooseModelIdentifier(item.id)"
          >
            <span class="model-select-indicator"><Icon name="check" :size="13" /></span>
            <div class="model-option-body">
              <div class="model-option-head">
                <strong>{{ item.id }}</strong>
                <span v-if="item.ownedBy" class="badge subtle">{{ item.ownedBy }}</span>
              </div>
              <div v-if="item.description" class="muted tiny">{{ item.description }}</div>
            </div>
          </button>
        </div>
      </div>
      <Collapse title="推理 / 思考强度" hint="统一管理 OpenAI / DeepSeek / Claude 推理等级" nested>
        <div class="form-grid dense">
          <Field
            label="适配目标"
            type="select"
            :options="REASONING_TARGET_OPTIONS"
            v-model="draft.reasoningTarget"
            tip="默认选“自动识别”。如果你走第三方网关、模型名不标准，手动指定更稳。"
          />
          <Field
            label="推理等级"
            type="select"
            :options="REASONING_EFFORT_OPTIONS"
            v-model="draft.reasoningEffort"
            tip="只对推理模型有意义。统一提供低 / 中 / 高三档，其他更细参数继续放在高级扩展。"
          />
        </div>
        <p class="muted tiny">保存后会自动翻译成对应上游参数：OpenAI 用 reasoning.effort，DeepSeek 用 reasoning_effort，Claude 用 thinking.effort。</p>
      </Collapse>
      <Collapse title="高级扩展" hint="价格统计与模型私有参数" nested>
        <div class="form-grid dense">
          <Field label="输入价格 / 1M（CNY）" type="number" v-model="draft.priceIn" tip="仅用于成本估算和展示，不影响实际调用。" />
          <Field label="输出价格 / 1M（CNY）" type="number" v-model="draft.priceOut" tip="同上，可先留默认 0，后面再补。" />
        </div>
        <Field label="Params JSON" type="textarea" v-model="draft.params" tip="给这个模型追加私有请求参数，比如特定温度、max_tokens 或供应商私有扩展字段。推理等级优先走上面的统一配置。" />
      </Collapse>
      <div class="row row-end">
        <button class="btn primary small" type="button" :disabled="saving" @click="save"><Icon name="save" :size="14" :class="{ 'icon-spin': saving }" />{{ saving ? "保存中..." : "保存模型参数" }}</button>
      </div>
    </div>
  `,
}
