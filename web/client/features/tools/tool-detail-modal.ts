import { computed, nextTick, reactive, ref, watch } from "vue"
import { request, toast } from "../../app/store/store.js"
import { asRecord, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { ToolConfigurationPanel } from "./tool-configuration-panel.js"
import { RenderPanel } from "./render-panel.js"
import {
  policyBadges,
  sourceLabel,
  toolCommon,
  toolDeliveryLabel,
  toolDisplayName,
  toolFinalReplyLabel,
  toolProvenance,
  toolRepeatabilityLabel,
  toolSource,
} from "./shared.js"

interface ToolRecord extends UnknownRecord {
  name: string
  common: UnknownRecord
  runtimeConfig: UnknownRecord
  modelDefinition: UnknownRecord
  modelPrompt: string
  modelPromptCharacters: number
  modelTokenEstimate: number
  modelPromptNote: string
  enabled: boolean
}

interface SourcePreview extends UnknownRecord {
  available?: boolean
  file?: string
  symbol?: string
  language?: string
  source?: string
  reason?: string
}

interface ConfigurationPanelHandle {
  saveAll: () => Promise<void> | void
}

function cloneTool(tool: unknown = {}): ToolRecord {
  const source = asRecord<ToolRecord>(tool)
  const common = toolCommon(source)
  return JSON.parse(JSON.stringify({
    name: source.name || "",
    common: {
      ...common,
      tags: Array.isArray(common.tags) ? [...common.tags] : [],
      policy: { ...asRecord(common.policy) },
      provenance: { ...toolProvenance(source) },
    },
    runtimeConfig: source.runtimeConfig || {},
    modelDefinition: source.modelDefinition || {},
    modelPrompt: source.modelPrompt || "",
    modelPromptCharacters: source.modelPromptCharacters || 0,
    modelTokenEstimate: source.modelTokenEstimate || 0,
    modelPromptNote: source.modelPromptNote || "",
    enabled: Boolean(source.enabled),
  }))
}

const EMPTY_TOOL = cloneTool()

export const ToolDetailModal = {
  name: "ToolDetailModal",
  components: { ToolConfigurationPanel, RenderPanel },
  props: {
    open: Boolean,
    tool: { type: Object, default: () => EMPTY_TOOL },
    initialTab: { type: String, default: "overview" },
  },
  emits: ["close", "updated"],
  setup(props: { open: boolean; tool?: unknown; initialTab?: string }, { emit }: { emit: (event: string, payload?: unknown) => void }) {
    const toolDetail = reactive<ToolRecord>(cloneTool())
    const modalRoot = ref<HTMLElement | null>(null)
    const configurationPanel = ref<ConfigurationPanelHandle | null>(null)
    const activeTab = ref("overview")
    const sourcePreview = reactive<SourcePreview>({})
    const sourceLoading = ref(false)
    let sourceRequestId = 0

    const title = computed(() => toolDisplayName(toolDetail) || toolDetail.name || "能力详情")
    const isRenderImage = computed(() => toolDetail.name === "render_image")
    const subtitle = computed(() => {
      const provenance = toolProvenance(toolDetail)
      return `${sourceLabel(toolSource(toolDetail))}能力 · ${provenance.packageId || provenance.skillId || "系统内置"}`
    })
    const hasRuntimeFields = computed(() => Object.keys(asRecord(toolCommon(toolDetail).configSchema).properties || {}).length > 0)
    const hasChannelConfig = computed(() => ["image_media", "web_search", "tool_search"].includes(toolDetail.name))
    const hasConfig = computed(() => hasRuntimeFields.value || hasChannelConfig.value)
    const accessBadges = computed(() => policyBadges(toolCommon(toolDetail).policy))
    const tabs = computed(() => [
      { id: "overview", label: "能力概览", icon: "info" },
      ...(isRenderImage.value ? [{ id: "render", label: "渲染设置", icon: "sparkles", badge: "统一入口" }] : []),
      { id: "configuration", label: "渠道与变量", icon: "sliders", badge: hasConfig.value ? "可配置" : "无额外项" },
      { id: "source", label: "定义与源码", icon: "code" },
    ])

    function resetSource() {
      for (const key of Object.keys(sourcePreview)) delete sourcePreview[key]
      sourceLoading.value = false
      sourceRequestId++
    }

    function syncTool(value: unknown = props.tool) {
      Object.assign(toolDetail, cloneTool(value || EMPTY_TOOL))
      resetSource()
    }

    function resetScroll() {
      void nextTick(() => {
        const scrollContainer = modalRoot.value?.closest(".drawer-body")
        if (scrollContainer instanceof HTMLElement) scrollContainer.scrollTop = 0
      })
    }

    async function loadSource() {
      if (sourcePreview.available !== undefined || sourceLoading.value || !toolDetail.name) return
      const requestId = ++sourceRequestId
      sourceLoading.value = true
      try {
        const result = asRecord(await request(`/api/tools/${encodeURIComponent(toolDetail.name)}/source-preview`))
        if (requestId !== sourceRequestId) return
        Object.assign(sourcePreview, asRecord(result.preview))
      } catch (error) {
        if (requestId !== sourceRequestId) return
        Object.assign(sourcePreview, { available: false, reason: errorMessage(error) })
      } finally {
        if (requestId === sourceRequestId) sourceLoading.value = false
      }
    }

    function selectTab(tab: string) {
      activeTab.value = tab
      if (tab === "source") void loadSource()
      resetScroll()
    }

    function updateTool(value: unknown) {
      syncTool(value)
      emit("updated", value)
    }

    function saveConfiguration() {
      void configurationPanel.value?.saveAll()
    }

    watch(() => [props.open, props.tool, props.initialTab], () => {
      syncTool()
      activeTab.value = ["render", "configuration", "source"].includes(String(props.initialTab)) && (String(props.initialTab) !== "render" || isRenderImage.value) ? String(props.initialTab) : "overview"
      if (activeTab.value === "source") void loadSource()
      if (props.open) resetScroll()
    }, { immediate: true, deep: true })

    return {
      toolDetail,
      modalRoot,
      configurationPanel,
      activeTab,
      sourcePreview,
      sourceLoading,
      title,
      subtitle,
      tabs,
      isRenderImage,
      accessBadges,
      hasConfig,
      selectTab,
      saveConfiguration,
      updateTool,
      sourceLabel,
      toolCommon,
      toolDeliveryLabel,
      toolFinalReplyLabel,
      toolProvenance,
      toolRepeatabilityLabel,
      toolSource,
    }
  },
  template: `
    <SideDrawer :open="open" :title="title" :subtitle="subtitle" icon="wrench" width="1100px" :modal="true" @close="$emit('close')">
      <div ref="modalRoot" class="tool-detail-modal">
        <header class="tool-detail-hero">
          <div class="tool-detail-identity">
            <div class="tool-detail-id-row"><code>{{ toolDetail.name }}</code><span class="status-dot" :class="toolDetail.enabled ? 'good' : 'muted'"></span><strong>{{ toolDetail.enabled ? '已启用' : '未启用' }}</strong></div>
            <p>{{ toolCommon(toolDetail).descriptionZh || toolCommon(toolDetail).description || '暂无能力说明。' }}</p>
          </div>
          <div class="tool-detail-metrics">
            <div><span>分类</span><strong>{{ toolCommon(toolDetail).categoryLabel || toolCommon(toolDetail).category || '未分类' }}</strong></div>
            <div><span>风险</span><strong>{{ toolCommon(toolDetail).risk === 'high' ? '高风险' : toolCommon(toolDetail).risk === 'external' ? '外网访问' : '常规' }}</strong></div>
            <div><span>定义开销</span><strong>{{ Number(toolDetail.modelTokenEstimate || 0).toLocaleString('zh-CN') }} 词元</strong></div>
          </div>
        </header>

        <nav class="tool-detail-tabs" role="tablist" aria-label="能力详情">
          <button v-for="tab in tabs" :key="tab.id" type="button" role="tab" :aria-selected="activeTab === tab.id" :class="{ active: activeTab === tab.id }" @click="selectTab(tab.id)"><Icon :name="tab.icon" :size="14" /><span>{{ tab.label }}</span><small v-if="tab.badge">{{ tab.badge }}</small></button>
        </nav>

        <section v-if="activeTab === 'overview'" class="tool-detail-page">
          <div class="tool-overview-grid">
            <article class="tool-overview-card tool-overview-primary"><span class="eyebrow">主要能力</span><h3>{{ toolCommon(toolDetail).displayNameZh || toolDetail.name }}</h3><p>{{ toolCommon(toolDetail).descriptionZh || toolCommon(toolDetail).description || '暂无说明' }}</p><p v-if="toolCommon(toolDetail).descriptionZh && toolCommon(toolDetail).description && toolCommon(toolDetail).descriptionZh !== toolCommon(toolDetail).description" class="muted tiny">{{ toolCommon(toolDetail).description }}</p></article>
            <article class="tool-overview-card"><span class="eyebrow">运行方式</span><dl><div><dt>消息投递</dt><dd>{{ toolDeliveryLabel(toolDetail) }}</dd></div><div><dt>对话收束</dt><dd>{{ toolFinalReplyLabel(toolDetail) }}</dd></div><div><dt>重复调用</dt><dd>{{ toolRepeatabilityLabel(toolDetail) }}</dd></div></dl></article>
            <article class="tool-overview-card"><span class="eyebrow">权限边界</span><div v-if="accessBadges.length" class="tool-badge-cloud"><span v-for="badge in accessBadges" :key="badge" class="badge">{{ badge }}</span></div><p v-else>没有额外角色限制，仍受全局工具开关与会话策略控制。</p></article>
            <article class="tool-overview-card"><span class="eyebrow">来源</span><dl><div><dt>类型</dt><dd>{{ sourceLabel(toolSource(toolDetail)) }}</dd></div><div><dt>归属</dt><dd>{{ toolProvenance(toolDetail).packageId || toolProvenance(toolDetail).skillId || 'builtin' }}</dd></div><div><dt>标签</dt><dd>{{ (toolCommon(toolDetail).tags || []).join(' · ') || '无' }}</dd></div></dl></article>
          </div>
          <div v-if="hasConfig" class="tool-detail-next"><Icon name="sliders" :size="17" /><div><strong>此能力支持独立配置</strong><p>渠道开关、默认来源与密钥集中在“渠道与变量”，保存后生效。</p></div><button class="btn small outline" type="button" @click="selectTab('configuration')">去配置<Icon name="chevron-right" :size="13" /></button></div>
        </section>

        <section v-else-if="activeTab === 'render'" class="tool-detail-page">
          <RenderPanel />
        </section>

        <section v-else-if="activeTab === 'configuration'" class="tool-detail-page">
          <ToolConfigurationPanel ref="configurationPanel" :tool="toolDetail" @updated="updateTool" />
        </section>

        <section v-else class="tool-detail-page tool-source-workspace">
          <article class="tool-definition-card">
            <div class="tool-definition-head"><div><span class="eyebrow">模型可见定义</span><h3>实际注入结构</h3></div><span class="badge">{{ toolDetail.modelPromptCharacters }} 字符</span></div>
            <p class="muted tiny">这里展示工具协议定义，不是额外 system prompt。工具启用并通过权限判断后才会进入模型请求。</p>
            <pre class="tool-source-code"><code>{{ toolDetail.modelPrompt || toolDetail.modelPromptNote || '当前没有可展示的定义。' }}</code></pre>
          </article>
          <article class="tool-definition-card">
            <div class="tool-definition-head"><div><span class="eyebrow">只读源码</span><h3>{{ sourcePreview.file || '实现片段' }}</h3></div><span v-if="sourcePreview.symbol" class="badge">{{ sourcePreview.symbol }}</span></div>
            <div v-if="sourceLoading" class="tool-source-loading"><Icon name="refresh" :size="18" /><span>正在读取实现片段…</span></div>
            <pre v-else-if="sourcePreview.available" class="tool-source-code source"><code>{{ sourcePreview.source }}</code></pre>
            <div v-else class="tool-config-empty"><Icon name="code" :size="22" /><strong>没有可浏览的内置源码</strong><p>{{ sourcePreview.reason || '外部工具或动态扩展仅展示模型定义，源码由对应服务维护。' }}</p></div>
          </article>
          <details class="tool-advanced-definition"><summary>参数与执行策略</summary><div class="tool-definition-json"><JsonBlock title="参数 Schema" :value="toolCommon(toolDetail).parameters" :open="true" /><JsonBlock title="执行保护" :value="{ execution: toolCommon(toolDetail).execution, executionByAction: toolCommon(toolDetail).executionByAction, policy: toolCommon(toolDetail).policy }" /></div></details>
        </section>
      </div>
      <template #actions>
        <button v-if="activeTab === 'configuration' && hasConfig" class="btn primary" type="button" @click="saveConfiguration"><Icon name="save" :size="14" />保存配置</button>
        <button class="btn outline" type="button" @click="$emit('close')"><Icon name="x" :size="14" />关闭</button>
      </template>
    </SideDrawer>
  `,
}
