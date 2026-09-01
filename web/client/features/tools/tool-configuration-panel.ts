import { computed, reactive, ref, watch } from "vue"
import { request, refreshTab, saveConfigPatch, store, toast } from "../../app/store/store.js"
import { asRecord, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { collectRuntimeValues, integerValue, runtimeDraftValues, runtimeFieldRow, toolCommon, type RuntimeFieldRow } from "./shared.js"

interface ConfigField {
  key: string
  label: string
  kind: "boolean" | "number" | "text"
  default: boolean | number | string
  min?: number
  max?: number
  placeholder?: string
  tip?: string
}

interface ChannelGuide {
  title: string
  description: string
  url?: string
  linkLabel?: string
}

interface ChannelOption {
  id: string
  label: string
  description: string
  fields?: ConfigField[]
  runtimeFields?: string[]
  guide: ChannelGuide
}

interface ChannelProfile {
  title: string
  description: string
  path: string
  channels: ChannelOption[]
  globalFields: ConfigField[]
}

interface ToolRecord extends UnknownRecord {
  name?: string
  runtimeConfig?: UnknownRecord
}

const NO_PARAMETER_GUIDE: ChannelGuide = {
  title: "开箱即用",
  description: "该渠道不需要密钥或额外连接参数，启用后即可参与搜索。",
}

const CHANNEL_PROFILES: Record<string, ChannelProfile> = {
  image_media: {
    title: "图片搜索渠道",
    description: "卡片顺序就是搜索优先级。首个启用渠道作为默认源，失败时按顺序向下重试，未启用渠道会被跳过。",
    path: "tools.builtin.imageSearch",
    channels: [
      { id: "bing", label: "Bing 图片", description: "通用图片搜索，适合作为默认来源。", guide: NO_PARAMETER_GUIDE },
      { id: "baidu", label: "百度图片", description: "中文关键词和本地内容覆盖较好。", guide: NO_PARAMETER_GUIDE },
      { id: "serp-bing", label: "SERP · Bing", description: "通过搜索聚合页补充 Bing 候选。", guide: NO_PARAMETER_GUIDE },
      { id: "serp-yandex", label: "SERP · Yandex", description: "适合补充海外图片候选。", guide: NO_PARAMETER_GUIDE },
      {
        id: "pixiv",
        label: "Pixiv 插画",
        description: "插画与多图作品，成人内容受独立开关控制。",
        fields: [
          { key: "pixivR18", label: "允许 R18", kind: "boolean", default: false, tip: "关闭时模型参数无法绕过该门禁。" },
          { key: "pixivEndpoint", label: "兼容接口地址", kind: "text", default: "https://api.lolicon.app/setu/v2", placeholder: "https://…", tip: "必须使用 HTTPS；可替换为可信的兼容服务。" },
        ],
        guide: {
          title: "Pixiv 渠道说明",
          description: "默认使用公开兼容接口，无需密钥。若使用自建镜像，在这里填写兼容接口地址；R18 必须由管理员显式开启。",
          url: "https://api.lolicon.app/#/setu",
          linkLabel: "查看接口说明",
        },
      },
    ],
    globalFields: [
      { key: "fallbackEnabled", label: "失败后自动换源", kind: "boolean", default: true, tip: "开启后严格按下方渠道顺序重试。" },
      { key: "maxResults", label: "最多候选数", kind: "number", default: 5, min: 1, max: 10 },
      { key: "timeoutMs", label: "搜索超时（毫秒）", kind: "number", default: 12000, min: 1000, max: 60000 },
      { key: "downloadTimeoutMs", label: "缓存下载超时（毫秒）", kind: "number", default: 30000, min: 1000, max: 120000 },
      { key: "maxImageBytes", label: "单图缓存上限（bytes）", kind: "number", default: 33554432, min: 1048576, max: 134217728, tip: "默认 32 MiB。" },
    ],
  },
  web_search: {
    title: "实时搜索渠道",
    description: "卡片顺序就是搜索优先级。首个启用渠道作为默认源，失败时按顺序向下重试，密钥只保存在服务端。",
    path: "tools.builtin.webSearch",
    channels: [
      {
        id: "baidu-ai",
        label: "百度 AI 搜索",
        description: "中文实时内容与摘要检索。",
        runtimeFields: ["baiduApiKey"],
        guide: {
          title: "获取百度 API Key",
          description: "在百度智能云千帆 AppBuilder 控制台创建应用并获取 API Key，然后粘贴到右侧。",
          url: "https://ai.baidu.com/ai-doc/AppBuilder/lm68r8e6i",
          linkLabel: "打开官方获取指引",
        },
      },
      {
        id: "tavily",
        label: "Tavily",
        description: "面向智能体的网页搜索与结构化结果。",
        runtimeFields: ["tavilyApiKey"],
        guide: {
          title: "获取 Tavily API Key",
          description: "登录 Tavily 控制台创建 API Key，然后粘贴到右侧。",
          url: "https://docs.tavily.com/documentation/quickstart",
          linkLabel: "打开官方快速开始",
        },
      },
    ],
    globalFields: [
      { key: "fallbackEnabled", label: "失败后自动换源", kind: "boolean", default: true, tip: "开启后严格按下方渠道顺序重试。" },
      { key: "maxResults", label: "最多结果数", kind: "number", default: 5, min: 1, max: 20 },
      { key: "timeoutMs", label: "请求超时（毫秒）", kind: "number", default: 30000, min: 1000, max: 120000 },
    ],
  },
}

function readPath(value: unknown, path: string): UnknownRecord {
  let current = asRecord(value)
  for (const part of path.split(".")) current = asRecord(current[part])
  return current
}

function cloneRuntime(tool: ToolRecord): UnknownRecord {
  return asRecord(tool.runtimeConfig)
}

export const ToolConfigurationPanel = {
  name: "ToolConfigurationPanel",
  props: { tool: { type: Object, required: true } },
  emits: ["updated"],
  setup(props: { tool: ToolRecord }, { emit, expose }: { emit: (event: string, payload?: unknown) => void; expose: (value: UnknownRecord) => void }) {
    const channelDraft = reactive<{ enabledSources: string[]; order: string[]; values: UnknownRecord }>({ enabledSources: [], order: [], values: {} })
    const runtimeDraft = reactive<Record<string, string>>({})
    const expandedChannel = ref("")
    const draggedChannel = ref("")
    const saving = ref(false)
    const profile = computed(() => CHANNEL_PROFILES[String(props.tool?.name || "")] || null)
    const runtimeRows = computed<RuntimeFieldRow[]>(() => Object.entries(asRecord(toolCommon(props.tool).configSchema).properties || {})
      .map(([name, field]) => runtimeFieldRow(name, field, cloneRuntime(props.tool)[name] !== undefined)))
    const runtimeRowsByName = computed(() => new Map(runtimeRows.value.map(row => [row.name, row])))
    const assignedRuntimeNames = computed(() => new Set(profile.value?.channels.flatMap(channel => channel.runtimeFields || []) || []))
    const unassignedRuntimeRows = computed(() => runtimeRows.value.filter(row => !assignedRuntimeNames.value.has(row.name)))
    const orderedChannels = computed(() => {
      const channels = new Map((profile.value?.channels || []).map(channel => [channel.id, channel]))
      return channelDraft.order.map(id => channels.get(id)).filter((channel): channel is ChannelOption => Boolean(channel))
    })
    const enabledOrderedChannels = computed(() => orderedChannels.value.filter(channel => channelDraft.enabledSources.includes(channel.id)))
    const hasConfiguration = computed(() => Boolean(profile.value || runtimeRows.value.length))

    function allProfileFields(currentProfile: ChannelProfile): ConfigField[] {
      return [...currentProfile.globalFields, ...currentProfile.channels.flatMap(channel => channel.fields || [])]
    }

    function syncChannels() {
      const currentProfile = profile.value
      channelDraft.enabledSources = []
      channelDraft.order = []
      channelDraft.values = {}
      if (!currentProfile) return
      const current = readPath(store.config, currentProfile.path)
      const knownIds = currentProfile.channels.map(channel => channel.id)
      const configured = Array.isArray(current.enabledSources) ? current.enabledSources.map(String).filter(id => knownIds.includes(id)) : [...knownIds]
      const defaultSource = String(current.defaultSource || "")
      const enabled = [...new Set(configured)]
      if (enabled.includes(defaultSource) && enabled[0] !== defaultSource) {
        enabled.splice(enabled.indexOf(defaultSource), 1)
        enabled.unshift(defaultSource)
      }
      channelDraft.enabledSources = enabled
      channelDraft.order = [...enabled, ...knownIds.filter(id => !enabled.includes(id))]
      for (const field of allProfileFields(currentProfile)) channelDraft.values[field.key] = current[field.key] ?? field.default
    }

    function syncRuntime() {
      for (const key of Object.keys(runtimeDraft)) delete runtimeDraft[key]
      Object.assign(runtimeDraft, runtimeDraftValues(toolCommon(props.tool).configSchema, cloneRuntime(props.tool)))
    }

    watch(() => [props.tool, store.config], () => { syncChannels(); syncRuntime() }, { immediate: true, deep: true })

    function channelEnabled(id: string): boolean {
      return channelDraft.enabledSources.includes(id)
    }

    function rebuildEnabledSources() {
      const enabled = new Set(channelDraft.enabledSources)
      channelDraft.enabledSources = channelDraft.order.filter(id => enabled.has(id))
    }

    function toggleChannel(id: string, enabled: boolean) {
      const values = new Set(channelDraft.enabledSources)
      if (enabled) {
        values.add(id)
        expandedChannel.value = id
      } else values.delete(id)
      channelDraft.enabledSources = channelDraft.order.filter(channelId => values.has(channelId))
    }

    function toggleExpanded(id: string) {
      expandedChannel.value = expandedChannel.value === id ? "" : id
    }

    function reorderChannel(sourceId: string, targetId: string) {
      if (!sourceId || sourceId === targetId) return
      const sourceIndex = channelDraft.order.indexOf(sourceId)
      const targetIndex = channelDraft.order.indexOf(targetId)
      if (sourceIndex < 0 || targetIndex < 0) return
      const next = [...channelDraft.order]
      next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, sourceId)
      channelDraft.order = next
      rebuildEnabledSources()
    }

    function startDrag(id: string, event: DragEvent) {
      draggedChannel.value = id
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", id)
      }
    }

    function dropChannel(id: string, event: DragEvent) {
      event.preventDefault()
      reorderChannel(draggedChannel.value || event.dataTransfer?.getData("text/plain") || "", id)
      draggedChannel.value = ""
    }

    function moveChannel(id: string, delta: number) {
      const index = channelDraft.order.indexOf(id)
      const target = index + delta
      if (index < 0 || target < 0 || target >= channelDraft.order.length) return
      const next = [...channelDraft.order]
      ;[next[index], next[target]] = [next[target], next[index]]
      channelDraft.order = next
      rebuildEnabledSources()
    }

    function channelRuntimeRows(channel: ChannelOption): RuntimeFieldRow[] {
      return (channel.runtimeFields || []).map(name => runtimeRowsByName.value.get(name)).filter((row): row is RuntimeFieldRow => Boolean(row))
    }

    function channelCredentialState(channel: ChannelOption): string {
      const rows = channelRuntimeRows(channel)
      if (!rows.length) return "无需密钥"
      return rows.every(row => runtimeDraft[row.name] === "********") ? "参数已设置" : "需要配置参数"
    }

    function channelReady(channel: ChannelOption): boolean {
      const rows = channelRuntimeRows(channel)
      return !rows.length || rows.every(row => runtimeDraft[row.name] === "********")
    }

    function normalizeField(field: ConfigField): boolean | number | string {
      const raw = channelDraft.values[field.key]
      if (field.kind === "boolean") return raw === true || raw === "true"
      if (field.kind === "number") return integerValue(raw, Number(field.default), field.min ?? Number.MIN_SAFE_INTEGER, field.max ?? Number.MAX_SAFE_INTEGER)
      return String(raw ?? field.default)
    }

    async function saveRuntimeConfig(): Promise<ToolRecord | null> {
      if (!runtimeRows.value.length) return null
      const value = collectRuntimeValues(toolCommon(props.tool).configSchema, runtimeDraft)
      const response = asRecord(await request(`/api/tools/${encodeURIComponent(String(props.tool.name || ""))}/runtime-config`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      }))
      const tools = Array.isArray(response.tools) ? response.tools.map(asRecord<ToolRecord>) : []
      return tools.find(item => item.name === props.tool.name) || null
    }

    async function saveAll() {
      if (saving.value) return
      const currentProfile = profile.value
      if (currentProfile && !channelDraft.enabledSources.length) return toast("请至少启用一个搜索渠道", "warn")
      saving.value = true
      try {
        const updated = await saveRuntimeConfig()
        if (updated) emit("updated", updated)
        if (currentProfile) {
          const enabledSources = channelDraft.order.filter(id => channelDraft.enabledSources.includes(id))
          const patch: UnknownRecord = {
            [`${currentProfile.path}.enabledSources`]: enabledSources,
            [`${currentProfile.path}.defaultSource`]: enabledSources[0],
          }
          for (const field of allProfileFields(currentProfile)) patch[`${currentProfile.path}.${field.key}`] = normalizeField(field)
          await saveConfigPatch(patch, `tool-channels:${props.tool.name}`)
          syncChannels()
        } else {
          toast("运行变量已保存并热应用")
          await refreshTab("tools")
        }
      } catch (error) { toast(errorMessage(error)) }
      finally { saving.value = false }
    }

    expose({ saveAll })

    return {
      channelDraft,
      profile,
      runtimeDraft,
      runtimeRows,
      unassignedRuntimeRows,
      orderedChannels,
      enabledOrderedChannels,
      expandedChannel,
      draggedChannel,
      saving,
      hasConfiguration,
      channelEnabled,
      toggleChannel,
      toggleExpanded,
      startDrag,
      dropChannel,
      moveChannel,
      channelRuntimeRows,
      channelCredentialState,
      channelReady,
      saveAll,
    }
  },
  template: `
    <div class="tool-config-workspace">
      <template v-if="profile">
        <section class="tool-config-card tool-global-config-card">
          <div class="tool-config-card-head">
            <div><span class="eyebrow">全局参数</span><h3>{{ profile.title }}</h3><p>{{ profile.description }}</p></div>
          </div>
          <div class="tool-priority-summary">
            <span><Icon name="list" :size="14" />已启用 {{ enabledOrderedChannels.length }} / {{ orderedChannels.length }}</span>
            <span v-if="enabledOrderedChannels.length"><strong>默认源</strong>{{ enabledOrderedChannels[0].label }}</span>
            <span v-else class="danger">至少启用一个渠道</span>
          </div>
          <div class="tool-global-fields">
            <template v-for="field in profile.globalFields" :key="field.key">
              <Field v-if="field.kind === 'boolean'" :label="field.label" type="select" :options="[{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }]" v-model="channelDraft.values[field.key]" :tip="field.tip" />
              <Field v-else-if="field.kind === 'number'" :label="field.label" type="number" v-model="channelDraft.values[field.key]" :tip="field.tip" />
              <Field v-else :label="field.label" type="text" :placeholder="field.placeholder" v-model="channelDraft.values[field.key]" :tip="field.tip" />
            </template>
          </div>
        </section>

        <section class="tool-config-card tool-channel-list-card">
          <div class="tool-channel-list-head">
            <div><span class="eyebrow">渠道优先级</span><h3>搜索与重试顺序</h3><p>拖动卡片调整顺序；也可使用上下按钮。首个启用项是默认源，失败时向下重试。</p></div>
          </div>
          <div class="tool-channel-list">
            <article
              v-for="(channel, index) in orderedChannels"
              :key="channel.id"
              class="tool-channel-row"
              :class="{ enabled: channelEnabled(channel.id), expanded: expandedChannel === channel.id, dragging: draggedChannel === channel.id }"
              @dragover.prevent
              @drop="dropChannel(channel.id, $event)"
            >
              <div class="tool-channel-row-main">
                <button class="tool-channel-drag" type="button" draggable="true" title="拖动调整优先级" aria-label="拖动调整优先级" @dragstart="startDrag(channel.id, $event)" @dragend="draggedChannel = ''"><Icon name="grip-vertical" :size="17" /></button>
                <span class="tool-channel-order">{{ index + 1 }}</span>
                <span class="tool-channel-mark"><Icon name="search" :size="15" /></span>
                <button class="tool-channel-copy" type="button" @click="toggleExpanded(channel.id)"><strong>{{ channel.label }}</strong><code>{{ channel.id }}</code><p>{{ channel.description }}</p></button>
                <span v-if="channelEnabled(channel.id) && enabledOrderedChannels[0]?.id === channel.id" class="badge primary">默认</span>
                <span class="tool-channel-state" :class="{ ready: channelReady(channel) }">{{ channelCredentialState(channel) }}</span>
                <div class="tool-channel-order-actions">
                  <button class="icon-btn" type="button" :disabled="index === 0" title="上移" @click="moveChannel(channel.id, -1)"><Icon name="chevron-up" :size="14" /></button>
                  <button class="icon-btn" type="button" :disabled="index === orderedChannels.length - 1" title="下移" @click="moveChannel(channel.id, 1)"><Icon name="chevron-down" :size="14" /></button>
                </div>
                <Switch :model-value="channelEnabled(channel.id)" @update:model-value="toggleChannel(channel.id, $event)" />
                <button class="icon-btn tool-channel-expand" type="button" :aria-expanded="expandedChannel === channel.id" :title="expandedChannel === channel.id ? '收起参数' : '展开参数'" @click="toggleExpanded(channel.id)"><Icon :name="expandedChannel === channel.id ? 'chevron-up' : 'chevron-down'" :size="15" /></button>
              </div>

              <div v-if="expandedChannel === channel.id" class="tool-channel-editor">
                <aside class="tool-channel-guide">
                  <span class="tool-channel-guide-icon"><Icon name="info" :size="17" /></span>
                  <div><strong>{{ channel.guide.title }}</strong><p>{{ channel.guide.description }}</p><a v-if="channel.guide.url" :href="channel.guide.url" target="_blank" rel="noreferrer">{{ channel.guide.linkLabel || '查看获取说明' }}<Icon name="external-link" :size="13" /></a></div>
                </aside>
                <div v-if="(channel.fields || []).length || channelRuntimeRows(channel).length" class="tool-channel-fields">
                  <template v-for="field in channel.fields || []" :key="field.key">
                    <Field v-if="field.kind === 'boolean'" :label="field.label" type="select" :options="[{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }]" v-model="channelDraft.values[field.key]" :tip="field.tip" />
                    <Field v-else-if="field.kind === 'number'" :label="field.label" type="number" v-model="channelDraft.values[field.key]" :tip="field.tip" />
                    <Field v-else :label="field.label" type="text" :placeholder="field.placeholder" v-model="channelDraft.values[field.key]" :tip="field.tip" />
                  </template>
                  <template v-for="row in channelRuntimeRows(channel)" :key="row.name">
                    <Field v-if="row.kind === 'select'" :label="row.label" type="select" :options="row.options" v-model="runtimeDraft[row.name]" :tip="row.tip" />
                    <Field v-else-if="row.kind === 'number'" :label="row.label" type="number" :placeholder="row.placeholder" v-model="runtimeDraft[row.name]" :tip="row.tip" />
                    <Field v-else-if="row.kind === 'textarea'" :label="row.label" type="textarea" :rows="3" :placeholder="row.placeholder" v-model="runtimeDraft[row.name]" :tip="row.tip" />
                    <Field v-else :label="row.label" :type="row.kind === 'secret' ? 'password' : 'text'" :placeholder="row.placeholder" v-model="runtimeDraft[row.name]" :tip="row.tip" />
                  </template>
                </div>
                <div v-else class="tool-channel-no-fields"><Icon name="check" :size="16" /><span>此渠道无需额外参数，启用并保存即可使用。</span></div>
              </div>
            </article>
          </div>
        </section>

        <section v-if="unassignedRuntimeRows.length" class="tool-config-card">
          <div class="tool-config-card-head"><div><span class="eyebrow">公共运行变量</span><h3>未绑定到单一渠道的参数</h3><p>这些参数作用于整个工具，而不是某一个搜索渠道。</p></div></div>
          <div class="form-grid tool-runtime-grid">
            <template v-for="row in unassignedRuntimeRows" :key="row.name">
              <Field v-if="row.kind === 'select'" :label="row.label" type="select" :options="row.options" v-model="runtimeDraft[row.name]" :tip="row.tip" />
              <Field v-else-if="row.kind === 'number'" :label="row.label" type="number" :placeholder="row.placeholder" v-model="runtimeDraft[row.name]" :tip="row.tip" />
              <Field v-else-if="row.kind === 'textarea'" :label="row.label" type="textarea" :rows="3" :placeholder="row.placeholder" v-model="runtimeDraft[row.name]" :tip="row.tip" />
              <Field v-else :label="row.label" :type="row.kind === 'secret' ? 'password' : 'text'" :placeholder="row.placeholder" v-model="runtimeDraft[row.name]" :tip="row.tip" />
            </template>
          </div>
        </section>
      </template>

      <section v-else-if="runtimeRows.length" class="tool-config-card">
        <div class="tool-config-card-head">
          <div><span class="eyebrow">运行变量</span><h3>密钥与连接参数</h3><p>只保存在服务端，执行时注入工具；不会进入模型可见的工具定义。</p></div>
        </div>
        <div class="form-grid tool-runtime-grid">
          <template v-for="row in runtimeRows" :key="row.name">
            <Field v-if="row.kind === 'select'" :label="row.label" type="select" :options="row.options" v-model="runtimeDraft[row.name]" :tip="row.tip" />
            <Field v-else-if="row.kind === 'number'" :label="row.label" type="number" :placeholder="row.placeholder" v-model="runtimeDraft[row.name]" :tip="row.tip" />
            <Field v-else-if="row.kind === 'textarea'" :label="row.label" type="textarea" :rows="3" :placeholder="row.placeholder" v-model="runtimeDraft[row.name]" :tip="row.tip" />
            <Field v-else :label="row.label" :type="row.kind === 'secret' ? 'password' : 'text'" :placeholder="row.placeholder" v-model="runtimeDraft[row.name]" :tip="row.tip" />
          </template>
        </div>
      </section>

      <div v-if="!hasConfiguration" class="tool-config-empty"><Icon name="sliders" :size="22" /><strong>这个工具没有额外配置</strong><p>它直接使用调用参数和系统公共设置，不需要单独维护渠道或密钥。</p></div>
    </div>
  `,
}
