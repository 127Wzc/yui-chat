import { ref, computed, reactive, nextTick, watch } from "vue"
import { store, request, toast, refreshTab, apiUrl, saveConfigPatch } from "../../app/store/store.js"
import { parseJsonText, toJson } from "../../shared/format.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { ExtensionPanel } from "./extension-panel.js"
import { McpPanel } from "./mcp-panel.js"
import { ToolDetailModal } from "./tool-detail-modal.js"
import { BoundaryAccessPanel } from "./permission-panel.js"
import { ToolListPanel } from "./tools-list-panel.js"
import { BuiltinCategorySettingsPanel } from "./builtin-category-panel.js"
import { GlobalToolSettingsPanel } from "./global-tool-settings-panel.js"
import { isFoldedRenderTool, toolSource, type ToolConfigRoot, type ToolRecord, type ToolsSlice } from "./shared.js"

interface RenderTemplate extends UnknownRecord {
  kind: string
  label?: string
  description?: string
  command?: string
}

interface RenderCacheItem extends UnknownRecord {
  imageUrl?: string
  kind?: string
  size?: number
}

interface RenderConfig extends UnknownRecord {
  enabled?: boolean
  engine?: string
  markdownEngine?: string
  markmapEngine?: string
  catalog?: RenderTemplate[]
  cache?: { files?: number; bytes?: number }
  html?: { enabled?: boolean; allowedUrlHosts?: string[]; allowPrivateHosts?: boolean }
}

interface RenderSlice extends UnknownRecord {
  render?: RenderConfig
  cache?: RenderCacheItem[]
}

interface HealthSlice extends UnknownRecord {
  renderCache?: { files?: number; bytes?: number }
}

interface RenderPreview extends UnknownRecord {
  imageBase64?: string
  kind?: string
  engine?: string
  bytes?: number
}

interface RenderPreviewResponse extends UnknownRecord {
  preview?: RenderPreview
  cache?: RenderCacheItem[]
}

function defaultRenderInput(kind = "text-card") {
  if (kind === "markdown") return { title: "Markdown 渲染", markdown: "# 标题\n\n- 帮助图\n- 动态面板" }
  if (kind === "mindmap") return { title: "能力总览", markdown: "# Yui Chat\n## 模型\n## 工具\n## 渲染" }
  if (kind === "function-plot") return { title: "函数图", expressions: ["sin(x)", "x^2/8"], xMin: -10, xMax: 10 }
  if (kind === "word-cloud") return { title: "能力词云", words: [{ text: "工具", weight: 8 }, { text: "渲染", weight: 6 }] }
  if (kind === "dynamic-panel") return { title: "动态面板", metrics: [{ label: "工具", value: "ready" }], sections: [{ title: "说明", lines: ["渲染正常。"] }] }
  if (kind === "command-help") return { query: "怎么查体力" }
  if (kind === "chat-card") return { prompt: "帮我介绍渲染工具", answer: "可生成帮助图、聊天卡片和动态图片。", metadata: { channel: "mock", adapter: "mock" } }
  return { title: "Yui Chat", subtitle: "渲染预览", content: "这是一张文本卡片。" }
}

// 统一模板渲染调试。
const RenderPanel = {
  name: "RenderPanel",
  setup() {
    const render = computed<RenderConfig>(() => asRecord<RenderSlice>(store.render).render || {})
    const catalog = computed<RenderTemplate[]>(() => render.value.catalog || [])
    const templates = computed(() => catalog.value.map(item => item.kind))
    const cache = computed<RenderCacheItem[]>(() => asRecord<RenderSlice>(store.render).cache || [])
    const additionalRenderCount = computed(() => asRecords<ToolRecord>(asRecord<ToolsSlice>(store.tools).tools).filter(isFoldedRenderTool).length)
    const draft = reactive({ template: "text-card", engine: "default", input: toJson(defaultRenderInput("text-card")) })
    const settings = reactive({ htmlEnabled: "false", markdownEngine: "auto", markmapEngine: "auto" })
    const previewImage = ref("")
    const previewMeta = ref<RenderPreview | null>(null)
    const showPreviewDrawer = ref(false)

    const metrics = computed(() => [
      { label: "模板", value: catalog.value.length, icon: "sparkles", tone: "purple" },
      { label: "缓存文件", value: asRecord<HealthSlice>(store.health).renderCache?.files || render.value.cache?.files || 0, icon: "database", tone: "blue" },
      { label: "缓存大小", value: asRecord<HealthSlice>(store.health).renderCache?.bytes || render.value.cache?.bytes || 0, icon: "database", tone: "cyan" },
      { label: "HTML 后端", value: render.value.html?.enabled ? "on" : "off", icon: "eye", tone: render.value.html?.enabled ? "orange" : "green" },
    ])
    const pills = computed(() => [
      { label: "渲染服务", active: render.value.enabled },
      { label: "引擎 " + (render.value.engine || "sharp-svg"), tone: "accent" },
      { label: "markdown " + (render.value.markdownEngine || "svg") },
      { label: "markmap " + (render.value.markmapEngine || "svg") },
      { label: `URL 域名 ${render.value.html?.allowedUrlHosts?.length || 0}` },
      { label: render.value.html?.allowPrivateHosts ? "私网 URL 放行" : "私网 URL 拦截", tone: render.value.html?.allowPrivateHosts ? "risk-high" : "" },
    ])

    function imageUrl(url: unknown) {
      if (!url) return ""
      const text = String(url)
      const path = text.startsWith("/") ? text : `/${text}`
      return apiUrl(path)
    }
    function loadSample() {
      draft.input = toJson(defaultRenderInput(draft.template))
      toast(`已载入 ${draft.template} 示例`)
    }
    function syncSettings() {
      settings.htmlEnabled = String(render.value.html?.enabled === true)
      settings.markdownEngine = String(render.value.markdownEngine || "auto")
      settings.markmapEngine = String(render.value.markmapEngine || "auto")
    }
    syncSettings()
    watch(render, syncSettings, { deep: true })
    async function saveSettings() {
      try {
        await saveConfigPatch({
          "response.render.html.enabled": settings.htmlEnabled === "true",
          "response.render.markdownEngine": settings.markdownEngine,
          "response.render.markmapEngine": settings.markmapEngine,
        })
        toast("渲染引擎设置已保存并热应用")
      } catch (err) { toast(errorMessage(err)) }
    }
    function chooseTemplate(item: RenderTemplate = { kind: "text-card" }) {
      draft.template = item.kind || "text-card"
      draft.input = toJson(defaultRenderInput(draft.template))
    }
    async function preview() {
      try {
        const input = parseJsonText(draft.input, "模板数据 JSON", {})
        const result = asRecord<RenderPreviewResponse>(await request("/api/render/preview", {
          method: "POST",
          body: JSON.stringify({ template: draft.template, engine: draft.engine === "default" ? "" : draft.engine, data: input }),
        }))
        if (!result.preview?.imageBase64) throw new Error("渲染服务没有返回预览图")
        previewImage.value = `data:image/png;base64,${result.preview.imageBase64}`
        previewMeta.value = result.preview
        await refreshCache(false)
        toast(`${draft.template} 预览已生成`)
      } catch (err) { toast(errorMessage(err)) }
    }
    async function refreshCache(showToast = true) {
      try {
        const result = asRecord<RenderPreviewResponse>(await request("/api/render/cache?limit=24"))
        store.render = { ...asRecord<RenderSlice>(store.render), cache: result.cache || [] }
        if (showToast) toast("渲染缓存已刷新")
      } catch (err) { toast(errorMessage(err)) }
    }
    return { render, catalog, templates, cache, additionalRenderCount, draft, settings, previewImage, previewMeta, showPreviewDrawer, metrics, pills, imageUrl, chooseTemplate, loadSample, saveSettings, preview, refreshCache }
  },
  template: `
    <Panel title="图片卡片" icon="sparkles">
      <template #actions>
        <button class="btn small outline" type="button" @click="showPreviewDrawer = true"><Icon name="eye" :size="14" />模板预览</button>
      </template>
      <SideDrawer
        :open="showPreviewDrawer"
        title="模板预览"
        subtitle="调试 render_image 的模板输入与输出。"
        icon="sparkles"
        width="620px"
        @close="showPreviewDrawer = false"
      >
        <div class="render-template-gallery">
          <button v-for="item in catalog" :key="item.kind" class="render-template-card" :class="{ active: draft.template === item.kind }" type="button" @click="chooseTemplate(item)">
            <span class="scenario-icon"><Icon :name="item.kind === 'conversation-list' ? 'message' : (item.kind === 'dynamic-panel' ? 'dashboard' : 'sparkles')" :size="17" /></span>
            <span><strong>{{ item.label || item.kind }}</strong><small>{{ item.description || item.command || '图片模板' }}</small></span>
            <Icon name="check" :size="14" />
          </button>
        </div>
        <div class="form-grid">
          <Field label="模板" type="select" :options="templates.length ? templates : ['text-card']" v-model="draft.template" />
          <Field label="引擎" type="select" :options="['default', 'svg', 'html']" v-model="draft.engine" />
        </div>
        <Field label="模板数据 JSON" type="textarea" v-model="draft.input" />
        <div class="action-bar">
          <button class="btn small outline" type="button" @click="loadSample"><Icon name="download" :size="14" />载入示例</button>
          <button class="btn primary small" type="button" @click="preview"><Icon name="eye" :size="14" />生成预览</button>
          <button class="btn small outline" type="button" @click="refreshCache(true)"><Icon name="refresh" :size="14" />刷新缓存</button>
        </div>
        <div v-if="previewImage" class="render-preview" style="margin-top:12px">
          <img :src="previewImage" alt="render preview" />
          <PillList :items="[{ label: previewMeta.kind || draft.template, active: true }, { label: previewMeta.engine || 'default' }, { label: (previewMeta.bytes || 0) + ' bytes' }]" />
        </div>
      </SideDrawer>
      <MetricGrid :items="metrics" compact />
      <PillList :items="pills" />
      <Collapse title="富 Markdown 与思维导图引擎" hint="KaTeX / Mermaid / Markmap">
        <div class="form-grid">
          <Field label="本地 HTML 渲染后端" type="select" :options="[{ value: 'false', label: '关闭（默认）' }, { value: 'true', label: '开启' }]" v-model="settings.htmlEnabled" tip="控制 Markmap、任意 HTML 与 URL 截图；安全富 Markdown/KaTeX 使用插件内置模板，不受此开关影响。" />
          <Field label="Markdown 引擎" type="select" :options="['auto', 'svg', 'html']" v-model="settings.markdownEngine" tip="auto 使用插件内置的富 Markdown、KaTeX 与 Mermaid；svg 是不支持公式的轻量回退。" />
          <Field label="思维导图引擎" type="select" :options="['auto', 'svg', 'html']" v-model="settings.markmapEngine" tip="auto 在 HTML 后端开启时使用 Markmap，否则回退轻量 SVG。" />
        </div>
        <div class="action-bar"><button class="btn primary small" type="button" @click="saveSettings"><Icon name="save" :size="14" />保存引擎设置</button></div>
      </Collapse>
      <p class="muted tiny">默认向模型暴露 render_image；另有 {{ additionalRenderCount }} 个受控截图工具，按权限单独启用。</p>
      <Collapse title="最近缓存" hint="仅插件内渲染缓存">
        <PagedList :rows="cache" :page-size="6" label="缓存" list-class="render-cache" empty="暂无渲染缓存。" v-slot="{ item }">
          <div class="item">
            <img :src="imageUrl(item.imageUrl)" :alt="item.kind || 'render cache'" loading="lazy" />
            <div class="item-head" style="margin-top:8px">
              <div class="item-title truncate">{{ item.kind || "render" }}</div>
              <span class="badge">{{ (item.size || 0) + " B" }}</span>
            </div>
          </div>
        </PagedList>
      </Collapse>
    </Panel>
  `,
}

export const ToolsTab = {
  name: "ToolsTab",
  components: { ToolListPanel, RenderPanel, ExtensionPanel, ToolDetailModal, BoundaryAccessPanel, GlobalToolSettingsPanel, BuiltinCategorySettingsPanel, McpPanel },
  setup() {
    const activeCapabilityView = ref("discover")
    const activeBuiltinCategory = ref("all")
    const showGlobalSettings = ref(false)
    const showToolDetail = ref(false)
    const selectedTool = ref<ToolRecord | null>(null)
    const selectedToolTab = ref("overview")
    const isPermissionPage = computed(() => store.activeTab === "tool-permissions")
    const globalToolsEnabled = computed(() => asRecord<ToolConfigRoot>(store.config).tools?.enabled !== false)
    const allTools = computed<ToolRecord[]>(() => asRecords<ToolRecord>(asRecord<ToolsSlice>(store.tools).tools).filter(item => toolSource(item) === "builtin" && !isFoldedRenderTool(item)))
    const enabledToolCount = computed(() => allTools.value.filter(item => item.enabled).length)
    const customCount = computed(() => asRecord<ToolsSlice>(store.tools).custom?.catalog?.length || 0)
    const skillCount = computed(() => asRecord<ToolsSlice>(store.tools).skills?.catalog?.length || 0)
    const mcpCount = computed(() => asRecord<ToolsSlice>(store.tools).mcp?.servers?.length || Object.keys(asRecord<ToolsSlice>(store.tools).mcp?.config?.servers || {}).length)
    const renderCount = computed(() => asRecord<RenderSlice>(store.render).render?.catalog?.length || 0)
    const capabilityViewItems = computed(() => [
      { value: "discover", label: "内置能力", description: "系统内置工具的启用与配置", icon: "sparkles", badge: `${enabledToolCount.value}/${allTools.value.length}` },
      { value: "extensions", label: "扩展能力", description: "Custom 与 Markdown Skill", icon: "cpu", badge: customCount.value + skillCount.value },
      { value: "mcp", label: "MCP 服务", description: "第三方服务与本地命令", icon: "link", badge: mcpCount.value },
      { value: "render", label: "图片渲染", description: "模板预览、渲染与缓存", icon: "dashboard", badge: renderCount.value },
    ])
    function selectBuiltinCategory(value: string) { activeBuiltinCategory.value = String(value || "all") }
    // 内置能力的查看与运行配置留在内置页；只有 Custom 编辑才进入扩展工作区。
    async function openToolDetail(payload: { name?: string; action?: string }) {
      const tool = asRecords<ToolRecord>(asRecord<ToolsSlice>(store.tools).tools).find(item => item.name === payload?.name)
      if (!tool) return
      if (payload?.action === "edit" && toolSource(tool) === "custom") {
        activeCapabilityView.value = "extensions"
        await nextTick()
        window.dispatchEvent(new CustomEvent("yui-chat:open-tool-detail", { detail: payload }))
        return
      }
      if (toolSource(tool) === "builtin") {
        selectedTool.value = tool
        selectedToolTab.value = payload?.action === "config" ? "configuration" : "overview"
        showToolDetail.value = true
        return
      }
      window.dispatchEvent(new CustomEvent("yui-chat:open-tool-detail", { detail: payload }))
    }
    return {
      isPermissionPage,
      activeCapabilityView,
      activeBuiltinCategory,
      showGlobalSettings,
      showToolDetail,
      selectedTool,
      selectedToolTab,
      globalToolsEnabled,
      capabilityViewItems,
      openToolDetail,
      selectBuiltinCategory,
    }
  },
  template: `
    <div class="stack">
      <nav v-if="!isPermissionPage" class="capability-mode-tabs" role="tablist" aria-label="能力类型">
        <button
          v-for="item in capabilityViewItems"
          :key="item.value"
          type="button"
          role="tab"
          :aria-selected="activeCapabilityView === item.value"
          :class="{ active: activeCapabilityView === item.value }"
          @click="activeCapabilityView = item.value"
        ><Icon :name="item.icon" :size="15" /><span>{{ item.label }}</span><b>{{ item.badge }}</b></button>
        <span class="capability-mode-spacer" aria-hidden="true"></span>
        <button class="capability-global-settings" type="button" :aria-label="globalToolsEnabled ? '打开全局工具设置' : '打开全局工具设置，当前已关闭'" @click="showGlobalSettings = true"><Icon name="gear" :size="15" /><span>全局配置</span><b>{{ globalToolsEnabled ? '已启用' : '已关闭' }}</b></button>
      </nav>
      <div v-if="!isPermissionPage" class="section-stage capability-workspace">
        <div v-if="activeCapabilityView === 'discover'" class="section-stage capability-source-stage capability-builtin-layout">
          <ToolListPanel :selected-category="activeBuiltinCategory" @category-change="selectBuiltinCategory" @open-tool-detail="openToolDetail" />
          <BuiltinCategorySettingsPanel :selected-category="activeBuiltinCategory" @select-category="selectBuiltinCategory" />
        </div>
        <div v-else-if="activeCapabilityView === 'extensions'" class="section-stage capability-source-stage">
          <ExtensionPanel />
        </div>
        <div v-else-if="activeCapabilityView === 'mcp'" class="section-stage capability-source-stage">
          <McpPanel />
        </div>
        <div v-else-if="activeCapabilityView === 'render'" class="section-stage capability-source-stage">
          <RenderPanel />
        </div>
      </div>
      <GlobalToolSettingsPanel v-if="!isPermissionPage" :open="showGlobalSettings" @close="showGlobalSettings = false" />
      <ToolDetailModal v-if="!isPermissionPage" :open="showToolDetail" :tool="selectedTool" :initial-tab="selectedToolTab" @updated="selectedTool = $event" @close="showToolDetail = false" />

      <div v-else class="section-stage capability-permission-workspace">
        <BoundaryAccessPanel />
      </div>
    </div>
  `,
}
