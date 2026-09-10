import { reactive, computed, ref, watch } from "vue"
import { confirmAction, store, request, toast, refreshTab } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { AddChannelForm, ModelEditor, ProviderEditor } from "./provider-editors.js"
import { ModelRoutingBuilder } from "./provider-routing.js"
import {
  INHERIT_BOOL_OPTIONS,
  ProviderFilterSearch,
  requestProviderModels,
  runLocked,
  uniqueModelIds,
} from "./provider-shared.js"
interface ProviderTemplate extends UnknownRecord {
  id: string
  label?: string
}
interface RemoteModel extends UnknownRecord {
  id: string
  label?: string
  description?: string
  methods?: string[]
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
  defaultCount: number
  items: Channel[]
}
export const ProvidersTab = {
  name: "ProvidersTab",
  components: { AddChannelForm, ProviderEditor, ModelEditor, ModelRoutingBuilder, ProviderFilterSearch },
  setup() {
    const cfg = computed<ProvidersConfig>(() => asRecord<ProvidersConfig>(store.config))
    const providerSlice = computed<ProvidersSlice>(() => asRecord<ProvidersSlice>(store.providers))
    const templates = computed(() => providerSlice.value.templates || [])
    const apiProviders = computed(() => cfg.value.apiProviders || [])
    const channels = computed(() => providerSlice.value.channels || [])
    const modelByName = computed<Record<string, ModelConfig>>(() => Object.fromEntries((cfg.value.models || []).map(model => [model.name, model])))
    const modelNames = computed(() => (cfg.value.models || [])
      .filter(model => model.purpose !== "image" && model.purpose !== "embedding")
      .map(model => model.name))
    const defaultReplyChannel = computed(() => cfg.value.chat?.defaultChannel || cfg.value.modelTasks?.replyer?.modelList?.[0] || "")
    const defaultImageChannel = computed(() => cfg.value.modelTasks?.imageGeneration?.modelList?.[0] || "")
    const defaultModel = computed(() => (cfg.value.models || []).find(model => model.name === defaultReplyChannel.value) || null)
    const showAddDrawer = ref(false)
    const activeProviderPane = ref("models")
    const showImportDrawer = ref(false)
    const editingId = ref("")
    const editingProvider = ref("")
    const providerQuery = ref("")
    const modelQuery = ref("")
    const remoteModelQuery = ref("")
    const remotePurpose = ref("chat")
    const remoteImageAdapter = ref("openai-images")
    const remoteStream = ref("")
    const activeProviderName = ref("")
    const providerSelectionTouched = ref(false)
    const remoteLoading = ref(false)
    const remoteImporting = ref(false)
    const remoteModels = ref<RemoteModel[]>([])
    const remoteSelected = ref<string[]>([])
    const providerTesting = ref(false)
    const providerDeleting = ref(false)
    const channelBusyMap = reactive<Record<string, boolean>>({})
    const providerCards = computed<ProviderCard[]>(() => apiProviders.value.map(provider => {
      const items = channels.value.filter(channel => channel.provider === provider.name)
      return {
        ...provider,
        channelCount: items.length,
        visualCount: items.filter(item => item.visual).length,
        toolCount: items.filter(item => item.toolUse).length,
        embeddingCount: items.filter(item => item.embedding).length,
        imageCount: items.filter(item => item.purpose === "image" || item.imageGeneration === true).length,
        defaultCount: items.filter(item => item.id === defaultReplyChannel.value || item.id === defaultImageChannel.value).length,
        items,
      }
    }))
    const providerPaneItems = computed(() => [
      { value: "models", label: "已配置模型", icon: "cpu", badge: selectedProviderChannels.value.length || 0 },
      { value: "import", label: "导入新模型", icon: "download", badge: remoteAvailableCount.value || 0 },
    ])
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
    const selectedProviderChannels = computed(() => channels.value.filter(item => item.provider === activeProviderName.value))
    const filteredSelectedProviderChannels = computed(() => {
      const keyword = modelQuery.value.trim().toLowerCase()
      if (!keyword) return selectedProviderChannels.value
      return selectedProviderChannels.value.filter(item => {
        const haystack = [item.id, item.model, item.type, item.provider].join(" ").toLowerCase()
        return haystack.includes(keyword)
      })
    })
    const filteredRemoteModels = computed(() => {
      const keyword = remoteModelQuery.value.trim().toLowerCase()
      if (!keyword) return remoteModels.value
      return remoteModels.value.filter(item => {
        const haystack = [item.id, item.label, item.description, ...(item.methods || [])].join(" ").toLowerCase()
        return haystack.includes(keyword)
      })
    })
    const currentProviderModelIds = computed(() => new Set(selectedProviderChannels.value.map(item => String(item.model || "").trim()).filter(Boolean)))
    const remoteNewCount = computed(() => remoteSelected.value.filter(id => !currentProviderModelIds.value.has(id)).length)
    const remoteExistingCount = computed(() => remoteModels.value.filter(item => currentProviderModelIds.value.has(item.id)).length)
    const remoteAvailableCount = computed(() => remoteModels.value.length - remoteExistingCount.value)
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
      showImportDrawer.value = false
      activeProviderPane.value = "models"
      modelQuery.value = ""
      remoteModelQuery.value = ""
      remoteModels.value = []
      remoteSelected.value = []
      remotePurpose.value = "chat"
      remoteStream.value = ""
      const provider = apiProviders.value.find(item => item.name === name)
      remoteImageAdapter.value = provider?.type === "gemini" ? "gemini-images" : "openai-images"
    }
    async function testChannel(channelId: string | Channel = "") {
      const id = typeof channelId === "string" ? channelId : channelId.id
      if (!id) throw new Error("channelId is required")
      return runChannelAction(`test:${id}`, async () => {
        const result = asRecord<ApiResult>(await request("/api/channels/test", {
          method: "POST",
          body: JSON.stringify({ channelId: id }),
        }))
        const tested = result.result || {}
        toast(tested.operation === "embedding"
          ? `向量测试通过：${tested.channel || "-"}（${tested.dimensions || "-"} 维）`
          : `测试通过：${tested.channel || "-"}`)
        return result
      })
    }
    async function testSelectedProvider() {
      return runLocked(providerTesting, async () => {
        try {
        const first = selectedProviderChannels.value[0]
        if (!first) throw new Error("当前供应商下还没有可测试的模型")
        await testChannel(first.id)
      } catch (err) {
        toast(errorMessage(err))
      }})
    }
    function openImportDrawer() {
      if (!selectedProvider.value) return
      showImportDrawer.value = true
    }
    function closeImportDrawer() {
      showImportDrawer.value = false
    }
    function selectProviderPane(value: string) {
      if (value === "import") return openImportDrawer()
      activeProviderPane.value = "models"
      closeImportDrawer()
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
          remoteModels.value = []
          remoteSelected.value = []
          remoteModelQuery.value = ""
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
    async function fetchRemoteModelsForSelectedProvider() {
      return runLocked(remoteLoading, async () => {
        try {
        const provider = selectedProvider.value
        if (!provider?.name) throw new Error("请先选择供应商")
        const result = await requestProviderModels({ providerName: provider.name, purpose: remotePurpose.value, adapter: remotePurpose.value === "image" ? remoteImageAdapter.value : undefined })
        remoteModels.value = asRecords<RemoteModel>(result.models)
        remoteSelected.value = []
        const available = remoteModels.value.filter(item => !currentProviderModelIds.value.has(item.id)).length
        toast(`已拉取 ${remoteModels.value.length || 0} 个模型，其中 ${available} 个可以导入`)
      } catch (err) {
        remoteModels.value = []
        remoteSelected.value = []
        toast(errorMessage(err))
      }})
    }
    function toggleRemoteModel(id: string, checked: boolean) {
      if (currentProviderModelIds.value.has(id)) return
      const next = new Set(remoteSelected.value)
      if (checked) next.add(id)
      else next.delete(id)
      remoteSelected.value = uniqueModelIds([...next])
    }
    function selectAllRemoteModels() {
      remoteSelected.value = uniqueModelIds(filteredRemoteModels.value
        .map(item => item.id)
        .filter(id => !currentProviderModelIds.value.has(id)))
    }
    function clearRemoteModels() {
      remoteSelected.value = []
    }
    async function importRemoteModels() {
      return runLocked(remoteImporting, async () => {
        try {
        const provider = selectedProvider.value
        if (!provider?.name) throw new Error("请先选择供应商")
        const identifiers = uniqueModelIds(remoteSelected.value)
        if (!identifiers.length) throw new Error("请至少勾选一个模型")
        const result = asRecord<ApiResult>(await request(`/api/providers/${encodeURIComponent(provider.name)}/models`, {
          method: "POST",
          body: JSON.stringify({
            modelIdentifiers: identifiers,
            purpose: remotePurpose.value,
            adapter: remotePurpose.value === "image" ? (remoteImageAdapter.value === "gemini-images" ? "gemini-images" : "openai-images") : undefined,
            image: remotePurpose.value === "image" ? { protocol: remoteImageAdapter.value } : undefined,
            stream: (remotePurpose.value === "chat" || remotePurpose.value === "image") && remoteStream.value !== ""
              ? remoteStream.value === "true"
              : undefined,
          }),
        }))
        store.config = asRecord(result.config)
        store.providers = { ...asRecord<ProvidersSlice>(store.providers), diagnostics: result.diagnostics }
        toast(`已导入 ${identifiers.length} 个模型到 ${provider.name}`)
        showImportDrawer.value = false
        await refreshTab("providers")
      } catch (err) {
        toast(errorMessage(err))
      }})
    }
    async function setDefault(ch: Channel) {
      const name = modelByName.value[ch.id]?.name || ch.id
      const image = ch.purpose === "image" || ch.imageGeneration === true
      if (ch.purpose === "embedding" || ch.embedding) {
        toast("向量模型请在知识库或记忆设置中选择")
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
      cfg, templates, apiProviders, channels, modelByName, modelNames,
      activeProvider, activeModel, defaultReplyChannel, defaultImageChannel, defaultModel,
      activeProviderPane, providerPaneItems,
      providerQuery, modelQuery, remoteModelQuery, activeProviderName,
      providerCards, filteredProviders, selectedProvider, selectedProviderCard, selectedProviderChannels, filteredSelectedProviderChannels,
      remoteLoading, remoteImporting, remoteModels, remoteSelected, remotePurpose, remoteImageAdapter, remoteStream, filteredRemoteModels, remoteNewCount, remoteExistingCount, remoteAvailableCount, currentProviderModelIds, providerTesting, providerDeleting, channelBusy,
      showAddDrawer, showImportDrawer, editingId, editingProvider,
      openModelEditor, openProviderEditor, canManage, selectProvider,
      testChannel, testSelectedProvider, requestRemoveProvider, fetchRemoteModelsForSelectedProvider, toggleRemoteModel, selectAllRemoteModels, clearRemoteModels, importRemoteModels,
      openImportDrawer, closeImportDrawer, selectProviderPane, setDefault, requestRemoveModel,
    }
  },
  template: `
    <div class="stack">
      <SideDrawer
        :open="showAddDrawer"
        title="新增渠道"
        subtitle="先保存渠道连接，再从该渠道导入模型并选择用途。"
        icon="server"
        width="560px"
        @close="showAddDrawer = false"
      >
        <AddChannelForm :templates="templates" @added="showAddDrawer = false" />
      </SideDrawer>

      <SideDrawer
        :open="!!activeProvider"
        title="编辑供应商"
        subtitle="维护渠道连接方式、鉴权头和请求参数。"
        icon="key"
        width="560px"
        @close="editingProvider = ''"
      >
        <ProviderEditor v-if="activeProvider" :provider="activeProvider" @saved="editingProvider = ''" />
      </SideDrawer>

      <SideDrawer
        :open="!!activeModel"
        title="编辑模型"
        subtitle="维护模型映射、能力标记和价格参数。"
        icon="cpu"
        width="560px"
        @close="editingId = ''"
      >
        <ModelEditor v-if="activeModel" :model="activeModel" @saved="editingId = ''" />
      </SideDrawer>

      <div class="section-stage provider-page-stage">
      <div class="section-intro provider-page-toolbar">
        <div><h2>渠道与模型</h2><p>先保存渠道连接，再从渠道导入模型并配置用途与能力。</p></div>
        <button class="btn primary small" type="button" @click="showAddDrawer = true"><Icon name="plus" :size="14" />新增渠道</button>
      </div>
      <ModelRoutingBuilder :cfg="cfg" :model-names="modelNames" compact />
      <Panel flush>
        <div class="provider-console provider-console-compact">
          <aside class="provider-sidebar">
            <div class="provider-sidebar-head">
              <div>
                <div class="section-title"><Icon name="database" :size="13" />供应商源</div>
                <p class="muted tiny">先选供应商，再在右侧配置、测试和管理模型。</p>
              </div>
            </div>

            <div class="list-filter">
              <ProviderFilterSearch v-model="providerQuery" placeholder="搜索供应商、端点或模型" />
              <span class="filter-count">{{ filteredProviders.length }} / {{ providerCards.length }}</span>
            </div>

            <div v-if="filteredProviders.length" class="provider-source-list">
              <button
                v-for="provider in filteredProviders"
                :key="provider.name"
                type="button"
                class="provider-source-card"
                :class="{ active: activeProviderName === provider.name, 'has-default': provider.defaultCount }"
                @click="selectProvider(provider.name)"
              >
                <div class="provider-source-top">
                  <div>
                    <div class="provider-source-name">{{ provider.name }}</div>
                    <div class="provider-source-url truncate">{{ provider.baseURL || '默认端点' }}</div>
                  </div>
                  <StatusDot :state="provider.apiKey ? 'on' : 'warn'" :label="provider.apiKey ? '已配置' : '缺少密钥'" />
                </div>
                <div class="provider-source-meta">
                  <span class="badge">{{ provider.type || "openai-compatible" }}</span>
                  <span class="badge accent">{{ provider.channelCount }} 个模型</span>
                  <span v-if="provider.embeddingCount" class="badge accent">{{ provider.embeddingCount }} 个向量</span>
                  <span v-if="provider.defaultCount" class="badge accent"><Icon name="sparkles" :size="11" />主模型所在</span>
                </div>
                <div class="provider-source-actions" @click.stop>
                  <IconButton icon="pencil" tone="accent" tip="编辑供应商连接" @click="openProviderEditor(provider.name)" />
                  <IconButton icon="trash" tone="danger" tip="删除当前供应商" :busy="providerDeleting && activeProviderName === provider.name" @click="requestRemoveProvider(provider)" />
                </div>
              </button>
            </div>
            <p v-else class="muted small" style="padding:12px">暂无可用供应商。</p>
          </aside>

          <section class="provider-main" v-if="selectedProvider">
            <div class="provider-hero">
              <div class="provider-hero-head">
                <div>
                  <div class="provider-hero-title">{{ selectedProvider.name }}</div>
                  <div class="muted">{{ selectedProvider.baseURL || "默认端点" }}</div>
                </div>
                <div class="row">
                  <button class="btn small outline" type="button" :disabled="providerTesting" @click="testSelectedProvider"><Icon name="play" :size="14" :class="{ 'icon-spin': providerTesting }" />{{ providerTesting ? "测试中..." : "测试供应商" }}</button>
                </div>
              </div>
              <div class="provider-hero-meta">
                <span class="badge">{{ selectedProvider.type || "openai-compatible" }}</span>
                <span class="badge" :class="selectedProvider.apiKey ? 'on' : 'risk-medium'">{{ selectedProvider.apiKey ? "密钥已配置" : "缺少密钥" }}</span>
                <span class="badge accent">{{ selectedProviderCard?.channelCount || 0 }} 个已挂模型</span>
                <span class="badge">{{ selectedProviderCard?.visualCount || 0 }} 个视觉模型</span>
                <span class="badge">{{ selectedProviderCard?.toolCount || 0 }} 个工具模型</span>
                <span class="badge accent">{{ selectedProviderCard?.embeddingCount || 0 }} 个向量模型</span>
                <span v-if="selectedProviderCard?.imageCount" class="badge accent">{{ selectedProviderCard.imageCount }} 个图片模型</span>
              </div>
            </div>

            <div class="segmented provider-pane-tabs" role="group" aria-label="当前供应商操作">
              <button v-for="item in providerPaneItems" :key="item.value" type="button" :aria-pressed="item.value === 'import' ? showImportDrawer : !showImportDrawer && activeProviderPane === item.value" :class="{ active: item.value === 'import' ? showImportDrawer : !showImportDrawer && activeProviderPane === item.value }" @click="selectProviderPane(item.value)">
                <Icon :name="item.icon" :size="13" />{{ item.label }}<span v-if="item.badge !== undefined" class="provider-pane-count">{{ item.badge }}</span>
              </button>
            </div>

            <div class="provider-main-grid single">
              <section v-if="activeProviderPane === 'models'" class="provider-section">
                <div class="provider-section-head">
                  <div>
                    <div class="section-title"><Icon name="cpu" :size="13" />已配置模型</div>
                    <p class="muted tiny">这里展示当前供应商已经挂到插件里的模型，可直接设默认、测试或编辑。</p>
                  </div>
                  <span class="filter-count">{{ filteredSelectedProviderChannels.length }} / {{ selectedProviderChannels.length }}</span>
                </div>
                <div class="list-filter">
                  <ProviderFilterSearch v-model="modelQuery" placeholder="搜索模型 ID 或渠道名" />
                </div>
                <div v-if="filteredSelectedProviderChannels.length" class="provider-model-list">
                  <div v-for="ch in filteredSelectedProviderChannels" :key="ch.id" class="provider-model-card" :class="{ 'is-default': ch.id === defaultReplyChannel || ch.id === defaultImageChannel }">
                    <div v-if="ch.id === defaultReplyChannel" class="default-model-banner"><Icon name="sparkles" :size="13" />当前主回复模型</div>
                    <div v-else-if="ch.id === defaultImageChannel" class="default-model-banner"><Icon name="image" :size="13" />当前默认画图模型</div>
                    <div class="provider-model-head">
                      <div>
                        <div class="provider-model-name">{{ ch.id }}</div>
                        <div class="provider-model-id">{{ ch.model || "-" }}</div>
                      </div>
                      <div class="row-actions">
                        <IconButton icon="play" tone="accent" tip="测试该模型" tip-dir="tip-left" :busy="channelBusy('test:' + ch.id)" @click="testChannel(ch)" />
                        <IconButton v-if="canManage(ch) && ch.purpose !== 'embedding' && !ch.embedding && ch.id !== ((ch.purpose === 'image' || ch.imageGeneration) ? defaultImageChannel : defaultReplyChannel)" icon="check" tone="good" :tip="(ch.purpose === 'image' || ch.imageGeneration) ? '设为默认画图模型' : '设为默认回复模型'" tip-dir="tip-left" :busy="channelBusy('default:' + ch.id)" @click="setDefault(ch)" />
                        <IconButton v-if="canManage(ch)" icon="pencil" tone="accent" tip="编辑模型参数" tip-dir="tip-left" @click="openModelEditor(ch.id)" />
                        <IconButton v-if="canManage(ch)" icon="trash" tone="danger" tip="删除模型" tip-dir="tip-left" :busy="channelBusy('remove:' + ch.id)" @click="requestRemoveModel(ch)" />
                      </div>
                    </div>
                    <div class="provider-model-meta">
                      <span class="badge">{{ ch.type }}</span>
                      <span v-if="ch.id === defaultReplyChannel" class="badge accent"><Icon name="sparkles" :size="11" />默认回复</span>
                      <span v-if="ch.id === defaultImageChannel" class="badge accent"><Icon name="image" :size="11" />默认画图</span>
                      <span v-if="ch.purpose === 'image' || ch.imageGeneration" class="badge">图片</span>
                      <template v-else-if="ch.purpose !== 'image' && !ch.imageGeneration">
                        <span v-if="ch.visual" class="badge accent">视觉</span>
                        <span v-if="ch.toolUse" class="badge">工具</span>
                        <span v-if="ch.embedding" class="badge accent">向量{{ ch.embeddingDimensions ? ' · ' + ch.embeddingDimensions + ' 维' : '' }}</span>
                        <span v-if="ch.reasoningLabel" class="badge accent">{{ ch.reasoningLabel }}</span>
                      </template>
                    </div>
                  </div>
                </div>
                <p v-else class="muted small" style="padding:8px 0">当前供应商下还没有模型。</p>
              </section>

            </div>

            <SideDrawer
              :open="showImportDrawer"
              title="导入新模型"
              subtitle="从当前供应商获取模型列表，勾选后批量加入当前配置。"
              icon="download"
              width="760px"
              @close="closeImportDrawer"
            >
              <section class="provider-section provider-import-drawer">
                <div class="provider-section-head">
                  <div>
                    <div class="section-title"><Icon name="download" :size="13" />拉取并导入模型</div>
                    <p class="muted tiny">已存在的模型会自动置灰，不会重复导入，也不会改变当前主模型。</p>
                  </div>
                  <div class="row">
                    <button class="btn small outline" type="button" :disabled="remoteLoading" @click="fetchRemoteModelsForSelectedProvider">
                      <Icon :name="remoteLoading ? 'activity' : 'refresh'" :size="14" :class="{ 'icon-spin': remoteLoading }" />
                      {{ remoteLoading ? "拉取中..." : "获取模型列表" }}
                    </button>
                    <button class="btn primary small" type="button" :disabled="remoteImporting || !remoteNewCount" @click="importRemoteModels">
                      <Icon name="plus" :size="14" :class="{ 'icon-spin': remoteImporting }" />
                      {{ remoteImporting ? "导入中..." : (remoteNewCount ? ("导入 " + remoteNewCount + " 个模型") : "选择模型后导入") }}
                    </button>
                  </div>
                </div>
                <div class="form-grid dense">
                  <Field label="模型用途" type="select" :options="[{ value: 'chat', label: '文本对话' }, { value: 'image', label: '图片生成' }, { value: 'embedding', label: '向量检索' }]" v-model="remotePurpose" tip="导入后模型只会加入对应任务。" />
                  <Field v-if="remotePurpose === 'image'" label="图片协议" type="select" :options="[{ value: 'openai-images', label: 'OpenAI Images（兼容协议）' }, { value: 'openai-chat-completions', label: 'OpenAI Chat Completions（生图/编辑）' }, { value: 'gemini-images', label: 'Gemini 图片协议' }]" v-model="remoteImageAdapter" tip="按模型实际接口选择协议。" />
                  <Field v-if="remotePurpose === 'chat' || remotePurpose === 'image'" label="流式响应" type="select" :options="INHERIT_BOOL_OPTIONS" v-model="remoteStream" tip="留空继承全局；图片流需要上游支持。" />
                </div>
                <div class="list-filter">
                  <ProviderFilterSearch v-model="remoteModelQuery" placeholder="筛选可导入模型" />
                  <button class="btn small outline" type="button" :disabled="!remoteAvailableCount" @click="selectAllRemoteModels"><Icon name="check" :size="14" />选择可导入项</button>
                  <button class="btn small outline" type="button" :disabled="!remoteSelected.length" @click="clearRemoteModels"><Icon name="eraser" :size="14" />清空</button>
                  <span class="filter-count">可导入 {{ remoteAvailableCount }} · 已存在 {{ remoteExistingCount }}</span>
                </div>
                <div v-if="filteredRemoteModels.length" class="model-picker provider-remote-picker">
                  <div class="model-selection-summary" :class="{ ready: remoteNewCount }">
                    <span class="model-selection-icon"><Icon :name="remoteNewCount ? 'check' : 'info'" :size="16" /></span>
                    <div><strong>{{ remoteNewCount ? ("已选择 " + remoteNewCount + " 个新模型") : '请选择要导入的模型' }}</strong><span>{{ remoteNewCount ? '确认后会加入当前供应商，不会改变现有主模型。' : '先获取模型列表，再勾选需要导入的模型。' }}</span></div>
                  </div>
                  <div class="model-picker-grid">
                    <label v-for="item in filteredRemoteModels" :key="item.id" class="model-option" :class="{ active: remoteSelected.includes(item.id), existing: currentProviderModelIds.has(item.id) }">
                      <input
                        class="model-option-input"
                        type="checkbox"
                        :checked="remoteSelected.includes(item.id)"
                        :disabled="currentProviderModelIds.has(item.id)"
                        @change="toggleRemoteModel(item.id, $event.target.checked)"
                      />
                      <span class="model-select-indicator"><Icon :name="currentProviderModelIds.has(item.id) ? 'check' : 'plus'" :size="13" /></span>
                      <div class="model-option-body">
                        <div class="model-option-head">
                          <strong>{{ item.id }}</strong>
                          <span v-if="currentProviderModelIds.has(item.id)" class="badge on">已存在</span>
                          <span v-else-if="remoteSelected.includes(item.id)" class="badge accent">准备导入</span>
                        </div>
                        <div v-if="item.description" class="muted tiny">{{ item.description }}</div>
                      </div>
                    </label>
                  </div>
                </div>
                <p v-else class="muted small" style="padding:8px 0">先点击“获取模型列表”，再勾选需要导入的模型。</p>
              </section>
            </SideDrawer>
          </section>

          <section v-else class="provider-empty-state">
            <div class="provider-empty-card">
              <Icon name="server" :size="18" />
              <div class="provider-empty-title">还没有可管理的供应商</div>
              <p class="muted">先新增一个渠道，之后就可以从渠道导入模型并测试。</p>
              <button class="btn primary" type="button" @click="showAddDrawer = true"><Icon name="plus" :size="14" />新增渠道</button>
            </div>
          </section>
        </div>
      </Panel>
      </div>
    </div>
  `,
}
