import { reactive, computed, ref, watch } from "vue"
import { confirmAction, store, request, toast, refreshTab } from "../../app/store/store.js"
import { asRecord, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { AddChannelForm, ModelEditor, ProviderEditor } from "./provider-editors.js"
import { ModelRoutingBuilder } from "./provider-routing.js"
import { ProviderImportDialog } from "./provider-import-dialog.js"
import { providerModelCounts, runLocked } from "./provider-shared.js"
interface ProviderTemplate extends UnknownRecord {
  id: string
  label?: string
}
interface ModelConfig extends UnknownRecord {
  name: string
  purpose?: string
  modelIdentifier?: string
  apiProvider?: string
}
interface Channel extends UnknownRecord {
  id: string
  provider: string
  model?: string
  modelIdentifier?: string
  type?: string
  purpose?: string
  origin?: string
  visual?: boolean
  toolUse?: boolean
  embedding?: boolean
  embeddingDimensions?: number
  reasoningLabel?: string
  imageGeneration?: boolean
}
interface ApiProvider extends UnknownRecord {
  name: string
  type?: string
  baseURL?: string
  apiKey?: string
}
interface ProvidersConfig extends UnknownRecord {
  apiProviders?: ApiProvider[]
  models?: ModelConfig[]
  chat?: { defaultChannel?: string; defaultTask?: string }
  modelTasks?: { replyer?: { modelList?: string[] }; imageGeneration?: { modelList?: string[] } }
}
interface ProvidersSlice extends UnknownRecord {
  templates?: ProviderTemplate[]
  channels?: Channel[]
  diagnostics?: UnknownRecord
}
interface ApiResult extends UnknownRecord {
  result?: { channel?: string; operation?: string; dimensions?: number; vectorCount?: number }
  config?: UnknownRecord
  diagnostics?: UnknownRecord
  removedModels?: unknown[]
  fallbackModel?: string
}
interface ProviderCard extends ApiProvider {
  channelCount: number
  visualCount: number
  toolCount: number
  embeddingCount: number
  imageCount: number
  decisionCount: number
  defaultCount: number
  items: Channel[]
}
export const ProvidersTab = {
  name: "ProvidersTab",
  components: { AddChannelForm, ProviderEditor, ModelEditor, ModelRoutingBuilder, ProviderImportDialog },
  setup() {
    const cfg = computed<ProvidersConfig>(() => asRecord<ProvidersConfig>(store.config))
    const providerSlice = computed<ProvidersSlice>(() => asRecord<ProvidersSlice>(store.providers))
    const templates = computed(() => providerSlice.value.templates || [])
    const apiProviders = computed(() => cfg.value.apiProviders || [])
    const channels = computed(() => providerSlice.value.channels || [])
    const modelByName = computed<Record<string, ModelConfig>>(() => Object.fromEntries((cfg.value.models || []).map(model => [model.name, model])))
    const modelNames = computed(() => (cfg.value.models || [])
      .filter(model => model.purpose !== "image" && model.purpose !== "embedding" && model.purpose !== "decision")
      .map(model => model.name))
    const defaultReplyChannel = computed(() => cfg.value.chat?.defaultChannel || cfg.value.modelTasks?.replyer?.modelList?.[0] || "")
    const defaultImageChannel = computed(() => cfg.value.modelTasks?.imageGeneration?.modelList?.[0] || "")
    const defaultModel = computed(() => (cfg.value.models || []).find(model => model.name === defaultReplyChannel.value) || null)
    const showAddDialog = ref(false)
    const showImportDialog = ref(false)
    const editingId = ref("")
    const editingProvider = ref("")
    const providerQuery = ref("")
    const modelQuery = ref("")
    const activeProviderName = ref("")
    const providerSelectionTouched = ref(false)
    const providerTesting = ref(false)
    const providerDeleting = ref(false)
    const channelBusyMap = reactive<Record<string, boolean>>({})
    const providerCards = computed<ProviderCard[]>(() => apiProviders.value.map(provider => {
      const items = channels.value.filter(channel => channel.provider === provider.name)
      return {
        ...provider,
        ...providerModelCounts(items),
        defaultCount: items.filter(item => item.id === defaultReplyChannel.value || item.id === defaultImageChannel.value).length,
        items,
      }
    }))
    const filteredProviders = computed(() => {
      const keyword = providerQuery.value.trim().toLowerCase()
      if (!keyword) return providerCards.value
      return providerCards.value.filter(item => {
        const haystack = [item.name, item.type, item.baseURL, ...item.items.map(model => `${model.id} ${model.model || ""}`)].join(" ").toLowerCase()
        return haystack.includes(keyword)
      })
    })
    watch(providerCards, cards => {
      if (!cards.length) {
        activeProviderName.value = ""
        return
      }
      const currentExists = cards.some(item => item.name === activeProviderName.value)
      if (!currentExists || !providerSelectionTouched.value) {
        const preferred = cards.find(item => item.defaultCount)
          || cards.find(item => item.apiKey && item.channelCount)
          || cards[0]
        activeProviderName.value = preferred?.name || cards[0].name
      }
    }, { immediate: true, deep: true })
    const activeProvider = computed(() => apiProviders.value.find(item => item.name === editingProvider.value) || null)
    const activeModel = computed(() => modelByName.value[editingId.value] || null)
    const selectedProvider = computed(() => apiProviders.value.find(item => item.name === activeProviderName.value) || null)
    const selectedProviderCard = computed(() => providerCards.value.find(item => item.name === activeProviderName.value) || null)
    const isDefault = (ch: Channel) => ch.id === defaultReplyChannel.value || ch.id === defaultImageChannel.value
    // 默认模型排在最前，其余保持配置顺序。
    const selectedProviderChannels = computed(() => channels.value
      .filter(item => item.provider === activeProviderName.value)
      .map((item, index) => ({ item, index }))
      .sort((a, b) => Number(isDefault(b.item)) - Number(isDefault(a.item)) || a.index - b.index)
      .map(entry => entry.item))
    const filteredSelectedProviderChannels = computed(() => {
      const keyword = modelQuery.value.trim().toLowerCase()
      if (!keyword) return selectedProviderChannels.value
      return selectedProviderChannels.value.filter(item => {
        const haystack = [item.id, item.model, item.type, item.provider].join(" ").toLowerCase()
        return haystack.includes(keyword)
      })
    })
    const currentProviderModelIds = computed(() => new Set(selectedProviderChannels.value.map(item => String(item.model || "").trim()).filter(Boolean)))
    // 渠道摘要只列非零项，避免“0 个向量模型”这类噪音。
    const providerSummary = computed(() => {
      const card = selectedProviderCard.value
      if (!card) return ""
      return [
        `${card.channelCount} 个模型`,
        card.visualCount ? `${card.visualCount} 视觉` : "",
        card.toolCount ? `${card.toolCount} 工具` : "",
        card.imageCount ? `${card.imageCount} 图片` : "",
        card.embeddingCount ? `${card.embeddingCount} 向量` : "",
        card.decisionCount ? `${card.decisionCount} 决策` : "",
      ].filter(Boolean).join(" · ")
    })
    function purposeOf(ch: Channel): { icon: string; label: string } {
      if (ch.purpose === "image" || ch.imageGeneration) return { icon: "image", label: "图片生成" }
      if (ch.purpose === "embedding" || ch.embedding) return { icon: "database", label: "向量检索" }
      if (ch.purpose === "decision") return { icon: "scale", label: "决策判断" }
      return { icon: "message", label: "文本对话" }
    }
    function capabilityTags(ch: Channel): string[] {
      if (ch.purpose === "embedding" || ch.embedding) return ch.embeddingDimensions ? [`${ch.embeddingDimensions} 维`] : []
      if (ch.purpose === "image" || ch.imageGeneration || ch.purpose === "decision") return []
      return [ch.visual ? "视觉" : "", ch.toolUse ? "工具" : "", ch.reasoningLabel || ""].filter(Boolean)
    }
    function defaultLabel(ch: Channel): string {
      if (ch.id === defaultReplyChannel.value) return "默认回复"
      if (ch.id === defaultImageChannel.value) return "默认画图"
      return ""
    }
    function canSetDefault(ch: Channel): boolean {
      return canManage(ch) && !isDefault(ch) && ch.purpose !== "embedding" && ch.purpose !== "decision" && !ch.embedding
    }
    const openModelEditor = (id: string) => { editingId.value = id || "" }
    const openProviderEditor = (name: string) => { editingProvider.value = name || "" }
    const canManage = (ch: Channel) => ch.origin === "model" && !!modelByName.value[ch.id]?.name
    const channelBusy = (id: string) => Boolean(channelBusyMap[id])
    async function runChannelAction<T>(id: string, task: () => Promise<T>): Promise<T | null> {
      const key = String(id || "")
      if (!key || channelBusyMap[key]) return null
      channelBusyMap[key] = true
      try {
        return await task()
      } finally {
        channelBusyMap[key] = false
      }
    }
    function selectProvider(name = "") {
      providerSelectionTouched.value = true
      activeProviderName.value = name
      showImportDialog.value = false
      modelQuery.value = ""
    }
    async function testChannel(channelId: string | Channel = "") {
      const id = typeof channelId === "string" ? channelId : channelId.id
      if (!id) throw new Error("channelId is required")
      return runChannelAction(`test:${id}`, async () => {
        try {
          const result = asRecord<ApiResult>(await request("/api/channels/test", {
            method: "POST",
            body: JSON.stringify({ channelId: id }),
          }))
          const tested = result.result || {}
          toast(tested.operation === "embedding"
            ? `向量测试通过：${tested.channel || "-"}（${tested.dimensions || "-"} 维）`
            : `测试通过：${tested.channel || "-"}`)
          return result
        } catch (err) {
          toast(errorMessage(err))
          return null
        }
      })
    }
    async function testSelectedProvider() {
      return runLocked(providerTesting, async () => {
        const first = selectedProviderChannels.value[0]
        if (!first) return toast("当前渠道下还没有可测试的模型")
        await testChannel(first.id)
      })
    }
    async function removeSelectedProvider(targetProvider: ApiProvider | null = null) {
      return runLocked(providerDeleting, async () => {
        try {
          const provider = targetProvider || selectedProvider.value
          if (!provider?.name) throw new Error("请先选择供应商")
          const modelCount = channels.value.filter(item => item.provider === provider.name).length
          const result = asRecord<ApiResult>(await request(`/api/providers/${encodeURIComponent(provider.name)}`, { method: "DELETE" }))
          store.config = asRecord(result.config)
          store.providers = { ...asRecord<ProvidersSlice>(store.providers), diagnostics: result.diagnostics }
          editingProvider.value = ""
          editingId.value = ""
          if (activeProviderName.value === provider.name) activeProviderName.value = ""
          modelQuery.value = ""
          toast(`已删除供应商 ${provider.name}${result.removedModels?.length ? `，并移除 ${result.removedModels.length} 个关联模型` : ""}`)
          await refreshTab("providers")
        } catch (err) {
          toast(errorMessage(err))
        }})
    }

    async function requestRemoveProvider(provider: ApiProvider) {
      if (!provider?.name) return
      const count = channels.value.filter(item => item.provider === provider.name).length
      const accepted = await confirmAction({
        title: `删除渠道“${provider.name}”？`,
        message: `该渠道下 ${count} 个模型会一并移除，相关回复方案会自动清理。`,
        detail: provider.baseURL || provider.name,
        confirmText: "确认删除服务",
      })
      if (accepted) await removeSelectedProvider(provider)
    }
    async function setDefault(ch: Channel) {
      const name = modelByName.value[ch.id]?.name || ch.id
      const image = ch.purpose === "image" || ch.imageGeneration === true
      if (ch.purpose === "embedding" || ch.embedding || ch.purpose === "decision") {
        toast(ch.purpose === "decision" ? "决策模型请在引用它的功能里选择，例如日常定格" : "向量模型请在知识库或记忆设置中选择")
        return
      }
      const taskName = image ? "imageGeneration" : (cfg.value.chat?.defaultTask || "replyer")
      const currentName = defaultModel.value?.name || defaultReplyChannel.value || "当前默认模型"
      const accepted = await confirmAction({
        title: image ? `将“${name}”设为默认画图模型？` : `将“${name}”设为默认回复模型？`,
        message: image ? "图片生成工具会优先使用该模型。" : `新的普通对话会优先使用该模型，替代“${currentName}”。`,
        detail: ch.modelIdentifier || ch.model || ch.id,
        confirmText: "确认切换默认模型",
        tone: "warn",
        icon: "check",
      })
      if (!accepted) return
      return runChannelAction(`default:${ch.id}`, async () => {
        try {
        const result = asRecord<ApiResult>(await request(`/api/models/${encodeURIComponent(name)}/default`, {
          method: "POST",
          body: JSON.stringify({ taskName }),
        }))
        store.config = asRecord(result.config)
        toast(image ? `已将 ${name} 设为默认画图模型` : `已将 ${name} 设为默认回复模型`)
        await refreshTab("providers")
      } catch (err) {
        toast(errorMessage(err))
      }})
    }

    async function removeModel(ch: Channel) {
      if (channelBusyMap[`remove:${ch.id}`]) return null
      try {
        const name = modelByName.value[ch.id]?.name || ch.id
        await runChannelAction(`remove:${ch.id}`, async () => {
          const result = asRecord<ApiResult>(await request(`/api/models/${encodeURIComponent(name)}`, { method: "DELETE" }))
          store.config = asRecord(result.config)
          toast(`已删除模型 ${name}${result.fallbackModel ? `，默认回退到 ${result.fallbackModel}` : ""}`)
          if (editingId.value === ch.id) editingId.value = ""
          await refreshTab("providers")
        })
      } catch (err) {
        toast(errorMessage(err))
      }
    }

    async function requestRemoveModel(ch: Channel) {
      if (!ch?.id) return
      const name = modelByName.value[ch.id]?.name || ch.id
      const accepted = await confirmAction({
        title: `删除模型“${name}”？`,
        message: "相关回复方案会移除该模型；如果它是主模型，系统会自动选择可用模型回退。",
        detail: ch.modelIdentifier || ch.model || ch.id,
        confirmText: "确认删除模型",
      })
      if (accepted) await removeModel(ch)
    }

    return {
      cfg, templates, modelNames, providerCards, filteredProviders,
      selectedProvider, selectedProviderCard, selectedProviderChannels, filteredSelectedProviderChannels, currentProviderModelIds, providerSummary,
      activeProvider, activeModel, activeProviderName, providerQuery, modelQuery,
      showAddDialog, showImportDialog, editingId, editingProvider, providerTesting, providerDeleting,
      purposeOf, capabilityTags, defaultLabel, isDefault, canSetDefault, canManage, channelBusy,
      selectProvider, openModelEditor, openProviderEditor, testChannel, testSelectedProvider,
      requestRemoveProvider, setDefault, requestRemoveModel,
    }
  },
  template: `
    <div class="pv-page">
      <Dialog :open="showAddDialog" title="新增渠道" @close="showAddDialog = false">
        <AddChannelForm :templates="templates" @added="showAddDialog = false" />
      </Dialog>
      <Dialog :open="!!activeProvider" :title="'编辑渠道 · ' + (activeProvider?.name || '')" @close="editingProvider = ''">
        <ProviderEditor v-if="activeProvider" :provider="activeProvider" @saved="editingProvider = ''" />
      </Dialog>
      <Dialog :open="!!activeModel" size="lg" :title="'编辑模型 · ' + (activeModel?.name || '')" @close="editingId = ''">
        <ModelEditor v-if="activeModel" :model="activeModel" @saved="editingId = ''" />
      </Dialog>
      <ProviderImportDialog :open="showImportDialog" :provider="selectedProvider" :existing-ids="currentProviderModelIds" @close="showImportDialog = false" />

      <header class="pv-header">
        <h2>渠道与模型</h2>
        <button class="btn primary" type="button" @click="showAddDialog = true"><Icon name="plus" :size="14" />新增渠道</button>
      </header>

      <ModelRoutingBuilder :cfg="cfg" :model-names="modelNames" compact />

      <div v-if="providerCards.length" class="pv-shell">
        <aside class="pv-nav">
          <SearchInput v-if="providerCards.length > 4" v-model="providerQuery" placeholder="搜索渠道或模型" />
          <div class="pv-nav-label">渠道<span>{{ filteredProviders.length }}</span></div>
          <nav class="pv-nav-list" aria-label="渠道列表">
            <button
              v-for="provider in filteredProviders"
              :key="provider.name"
              type="button"
              class="pv-nav-item"
              :class="{ 'is-active': activeProviderName === provider.name }"
              :aria-current="activeProviderName === provider.name ? 'true' : undefined"
              @click="selectProvider(provider.name)"
            >
              <span class="dot" :class="provider.apiKey ? 'on' : 'warn'" :title="provider.apiKey ? '密钥已配置' : '缺少密钥'"></span>
              <span class="pv-nav-text">
                <span class="pv-nav-name">{{ provider.name }}<Icon v-if="provider.defaultCount" name="star" :size="11" class="pv-nav-star" /></span>
                <span class="pv-nav-meta">{{ provider.type || "openai-compatible" }} · {{ provider.channelCount }} 个模型</span>
              </span>
            </button>
            <p v-if="!filteredProviders.length" class="pv-nav-empty">没有匹配的渠道</p>
          </nav>
        </aside>

        <section v-if="selectedProvider" class="pv-detail">
          <div class="pv-detail-head">
            <div class="pv-detail-title">
              <div class="pv-title-row">
                <h3>{{ selectedProvider.name }}</h3>
                <Badge variant="outline">{{ selectedProvider.type || "openai-compatible" }}</Badge>
                <Badge :variant="selectedProvider.apiKey ? 'success' : 'warning'">{{ selectedProvider.apiKey ? "密钥已配置" : "缺少密钥" }}</Badge>
              </div>
              <code class="pv-endpoint">{{ selectedProvider.baseURL || "默认端点" }}</code>
            </div>
            <div class="pv-detail-actions">
              <button class="btn outline small" type="button" :disabled="providerTesting || !selectedProviderChannels.length" @click="testSelectedProvider">
                <Icon name="play" :size="13" :class="{ 'icon-spin': providerTesting }" />{{ providerTesting ? "测试中" : "测试连接" }}
              </button>
              <button class="btn outline small" type="button" @click="openProviderEditor(selectedProvider.name)"><Icon name="pencil" :size="13" />编辑连接</button>
              <IconButton icon="trash" tone="danger" tip="删除渠道" tip-dir="tip-left" :busy="providerDeleting" @click="requestRemoveProvider(selectedProvider)" />
            </div>
          </div>

          <div class="pv-models-bar">
            <div class="pv-models-title">模型<span>{{ providerSummary }}</span></div>
            <div class="pv-models-tools">
              <SearchInput v-if="selectedProviderChannels.length > 5" v-model="modelQuery" placeholder="筛选模型" />
              <button class="btn small" type="button" @click="showImportDialog = true"><Icon name="download" :size="13" />导入模型</button>
            </div>
          </div>

          <ul v-if="filteredSelectedProviderChannels.length" class="pv-model-list">
            <li v-for="ch in filteredSelectedProviderChannels" :key="ch.id" class="pv-model" :class="{ 'is-default': isDefault(ch) }">
              <span class="pv-model-icon" :data-tip="purposeOf(ch).label"><Icon :name="purposeOf(ch).icon" :size="15" /></span>
              <div class="pv-model-main">
                <div class="pv-model-name">
                  <span class="truncate">{{ ch.id }}</span>
                  <Badge v-if="defaultLabel(ch)" variant="default" icon="star">{{ defaultLabel(ch) }}</Badge>
                </div>
                <div class="pv-model-meta">
                  <code>{{ ch.model || "-" }}</code>
                  <span>{{ ch.type }}</span>
                  <span v-for="tag in capabilityTags(ch)" :key="tag">{{ tag }}</span>
                </div>
              </div>
              <div class="pv-model-actions">
                <button v-if="canSetDefault(ch)" class="btn ghost small pv-set-default" type="button" :disabled="channelBusy('default:' + ch.id)" @click="setDefault(ch)">设为默认</button>
                <IconButton icon="play" tip="测试该模型" tip-dir="tip-left" :busy="channelBusy('test:' + ch.id)" @click="testChannel(ch)" />
                <IconButton v-if="canManage(ch)" icon="pencil" tip="编辑模型" tip-dir="tip-left" @click="openModelEditor(ch.id)" />
                <IconButton v-if="canManage(ch)" icon="trash" tone="danger" tip="删除模型" tip-dir="tip-left" :busy="channelBusy('remove:' + ch.id)" @click="requestRemoveModel(ch)" />
              </div>
            </li>
          </ul>
          <div v-else class="pv-empty">
            <Icon name="cpu" :size="18" />
            <strong>{{ selectedProviderChannels.length ? "没有匹配的模型" : "还没有模型" }}</strong>
            <button v-if="!selectedProviderChannels.length" class="btn small" type="button" @click="showImportDialog = true"><Icon name="download" :size="13" />导入模型</button>
          </div>
        </section>
      </div>

      <div v-else class="pv-empty is-page">
        <Icon name="server" :size="20" />
        <strong>还没有模型渠道</strong>
        <button class="btn primary" type="button" @click="showAddDialog = true"><Icon name="plus" :size="14" />新增渠道</button>
      </div>
    </div>
  `,
}
