import { computed, ref, watch } from "vue"
import { store, request, toast, refreshTab } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { INHERIT_BOOL_OPTIONS, requestProviderModels, runLocked, uniqueModelIds } from "./provider-shared.js"

interface RemoteModel extends UnknownRecord {
  id: string
  label?: string
  description?: string
  methods?: string[]
}

export const MODEL_PURPOSE_OPTIONS = [
  { value: "chat", label: "文本对话", icon: "message", description: "回复、工具调用和视觉理解" },
  { value: "image", label: "图片生成", icon: "image", description: "画图与图片编辑" },
  { value: "embedding", label: "向量检索", icon: "database", description: "知识库与记忆的向量化" },
  { value: "decision", label: "决策判断", icon: "scale", description: "结构化判断，如日常定格" },
]

const IMAGE_PROTOCOL_OPTIONS = [
  { value: "openai-images", label: "OpenAI Images（兼容协议）" },
  { value: "openai-chat-completions", label: "OpenAI Chat Completions（生图/编辑）" },
  { value: "gemini-images", label: "Gemini 图片协议" },
]

// 从当前渠道拉取模型列表并批量导入；打开时自动拉取一次，用途切换后重新拉取。
export const ProviderImportDialog = {
  name: "ProviderImportDialog",
  props: {
    open: Boolean,
    provider: { type: Object, default: null },
    // 当前渠道已挂的上游模型 ID，已存在的不能重复导入。
    existingIds: { type: Object, default: () => new Set<string>() },
  },
  emits: ["close"],
  setup(props: { open: boolean; provider: UnknownRecord | null; existingIds: Set<string> }, { emit }: { emit: (event: "close") => void }) {
    const purpose = ref("chat")
    const imageProtocol = ref("openai-images")
    const stream = ref("")
    const query = ref("")
    const models = ref<RemoteModel[]>([])
    const selected = ref<string[]>([])
    const loading = ref(false)
    const importing = ref(false)
    const loadedKey = ref("")

    const providerName = computed(() => String(props.provider?.name || ""))
    const filtered = computed(() => {
      const keyword = query.value.trim().toLowerCase()
      if (!keyword) return models.value
      return models.value.filter(item => [item.id, item.label, item.description, ...(item.methods || [])].join(" ").toLowerCase().includes(keyword))
    })
    const exists = (id: string) => props.existingIds.has(id)
    const availableCount = computed(() => models.value.filter(item => !exists(item.id)).length)
    const newCount = computed(() => selected.value.filter(id => !exists(id)).length)
    const allFilteredSelected = computed(() => {
      const candidates = filtered.value.filter(item => !exists(item.id))
      return candidates.length > 0 && candidates.every(item => selected.value.includes(item.id))
    })

    function reset() {
      const type = String(props.provider?.type || "")
      purpose.value = type === "typesafe" ? "decision" : "chat"
      imageProtocol.value = type === "gemini" ? "gemini-images" : "openai-images"
      stream.value = ""
      query.value = ""
      models.value = []
      selected.value = []
      loadedKey.value = ""
    }

    async function fetchModels() {
      return runLocked(loading, async () => {
        try {
          if (!providerName.value) throw new Error("请先选择渠道")
          const result = await requestProviderModels({ providerName: providerName.value, purpose: purpose.value, adapter: purpose.value === "image" ? imageProtocol.value : undefined })
          models.value = asRecords<RemoteModel>(result.models)
          selected.value = []
          loadedKey.value = `${providerName.value}:${purpose.value}:${imageProtocol.value}`
        } catch (err) {
          models.value = []
          selected.value = []
          toast(errorMessage(err))
        }
      })
    }

    function toggle(id: string, checked: boolean) {
      if (exists(id)) return
      const next = new Set(selected.value)
      if (checked) next.add(id)
      else next.delete(id)
      selected.value = uniqueModelIds([...next])
    }

    function toggleAll(checked: boolean) {
      const ids = filtered.value.map(item => item.id).filter(id => !exists(id))
      selected.value = checked ? uniqueModelIds([...selected.value, ...ids]) : selected.value.filter(id => !ids.includes(id))
    }

    async function importModels() {
      return runLocked(importing, async () => {
        try {
          const identifiers = uniqueModelIds(selected.value.filter(id => !exists(id)))
          if (!identifiers.length) throw new Error("请至少勾选一个模型")
          const image = purpose.value === "image"
          const result = asRecord(await request(`/api/providers/${encodeURIComponent(providerName.value)}/models`, {
            method: "POST",
            body: JSON.stringify({
              modelIdentifiers: identifiers,
              purpose: purpose.value,
              adapter: image ? (imageProtocol.value === "gemini-images" ? "gemini-images" : "openai-images") : undefined,
              image: image ? { protocol: imageProtocol.value } : undefined,
              stream: (purpose.value === "chat" || image) && stream.value !== "" ? stream.value === "true" : undefined,
            }),
          }))
          store.config = asRecord(result.config)
          store.providers = { ...asRecord(store.providers), diagnostics: result.diagnostics }
          toast(`已导入 ${identifiers.length} 个模型到 ${providerName.value}`)
          emit("close")
          await refreshTab("providers")
        } catch (err) {
          toast(errorMessage(err))
        }
      })
    }

    watch(() => [props.open, providerName.value] as const, ([open]) => {
      if (!open) return
      reset()
      void fetchModels()
    })
    // 用途和图片协议会影响上游过滤条件，切换后重新拉取。
    watch([purpose, imageProtocol], () => {
      if (props.open && loadedKey.value && loadedKey.value !== `${providerName.value}:${purpose.value}:${imageProtocol.value}`) void fetchModels()
    })

    return {
      MODEL_PURPOSE_OPTIONS, IMAGE_PROTOCOL_OPTIONS, INHERIT_BOOL_OPTIONS,
      purpose, imageProtocol, stream, query, models, selected, loading, importing,
      filtered, availableCount, newCount, allFilteredSelected, exists,
      fetchModels, toggle, toggleAll, importModels,
    }
  },
  template: `
    <Dialog :open="open" size="lg" :title="'导入模型 · ' + (provider?.name || '')" @close="$emit('close')">
      <div class="pv-import">
        <div class="pv-import-section">
          <RadioGroup v-model="purpose" :options="MODEL_PURPOSE_OPTIONS" variant="cards" label="模型用途" />
        </div>
        <div v-if="purpose === 'image' || purpose === 'chat'" class="form-grid dense">
          <Field v-if="purpose === 'image'" label="图片协议" type="select" :options="IMAGE_PROTOCOL_OPTIONS" v-model="imageProtocol" tip="按模型实际接口选择协议。" />
          <Field label="流式响应" type="select" :options="INHERIT_BOOL_OPTIONS" v-model="stream" tip="留空继承全局；图片流需要上游支持。" />
        </div>

        <div class="pv-import-section">
          <div class="pv-import-toolbar">
            <SearchInput v-model="query" placeholder="筛选模型" />
            <button class="btn small outline" type="button" :disabled="loading" @click="fetchModels">
              <Icon name="refresh" :size="13" :class="{ 'icon-spin': loading }" />{{ loading ? '获取中' : '重新获取' }}
            </button>
          </div>
          <div class="pv-import-list" :class="{ 'is-loading': loading }">
            <div v-if="filtered.length" class="pv-import-head">
              <Checkbox :model-value="allFilteredSelected" :disabled="!availableCount" label="全选可导入项" @update:model-value="toggleAll" />
              <span class="muted tiny">可导入 {{ availableCount }} · 已存在 {{ models.length - availableCount }}</span>
            </div>
            <div v-for="item in filtered" :key="item.id" class="pv-import-row" :class="{ 'is-existing': exists(item.id) }">
              <Checkbox :model-value="exists(item.id) || selected.includes(item.id)" :disabled="exists(item.id)" @update:model-value="toggle(item.id, $event)">
                <span class="pv-import-name">{{ item.id }}</span>
                <span v-if="item.description" class="ui-check-desc">{{ item.description }}</span>
              </Checkbox>
              <Badge v-if="exists(item.id)" variant="outline">已导入</Badge>
            </div>
            <p v-if="!filtered.length" class="pv-import-empty">{{ loading ? '获取中…' : (models.length ? '没有匹配的模型' : '没有获取到模型，请检查密钥') }}</p>
          </div>
        </div>
      </div>
      <template #footer>
        <span class="pv-import-count">{{ newCount ? ('已选 ' + newCount + ' 个') : '未选择模型' }}</span>
        <button class="btn outline" type="button" @click="$emit('close')">取消</button>
        <button class="btn primary" type="button" :disabled="importing || !newCount" @click="importModels">
          <Icon name="download" :size="14" :class="{ 'icon-spin': importing }" />{{ importing ? '导入中…' : '导入' }}
        </button>
      </template>
    </Dialog>
  `,
}
