import { computed, reactive, ref, watch } from "vue"
import { request, saveConfigPatch, store, toast } from "../../app/store/store.js"
import { parseJsonText, toJson } from "../../shared/format.js"
import { asRecord, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { SystemRenderStrategyPanel } from "./system-render-strategy-panel.js"

interface RenderTemplate extends UnknownRecord {
  kind: string
  label?: string
  description?: string
  command?: string
}

interface RenderConfig extends UnknownRecord {
  enabled?: boolean
  engine?: string
  catalog?: RenderTemplate[]
  system?: {
    engine?: string
  }
}

interface RenderSlice extends UnknownRecord {
  render?: RenderConfig
}

interface RenderPreview extends UnknownRecord {
  imageBase64?: string
  format?: string
  engine?: string
  requestedEngine?: string
  fallback?: boolean
  bytes?: number
}

interface RenderPreviewResponse extends UnknownRecord {
  preview?: RenderPreview
}

function defaultRenderInput(kind = "text-card") {
  if (kind === "html") return { title: "HTML 渲染", content: "<h1>Yui Chat</h1><p>使用统一主题的 HTML 卡片。</p>" }
  if (kind === "markdown") return { title: "Markdown 渲染", content: "# Markdown\n\n公式：$a^2+b^2=c^2$\n\n```mermaid\nflowchart LR\nA --> B\n```" }
  if (kind === "mindmap") return { title: "能力总览", content: "# Yui Chat\n## 模型\n## 工具\n## 渲染" }
  return { title: "Yui Chat", subtitle: "渲染预览", content: "这是一张文本卡片。" }
}

const PREVIEW_TEMPLATE_KINDS = ["html", "markdown", "mindmap", "text-card"]

/** render_image 的统一设置与预览；工具和系统各自使用一套引擎策略。 */
export const RenderPanel = {
  name: "RenderPanel",
  components: { SystemRenderStrategyPanel },
  setup() {
    const render = computed<RenderConfig>(() => asRecord<RenderSlice>(store.render).render || {})
    const catalog = computed<RenderTemplate[]>(() => {
      const available = render.value.catalog || []
      return PREVIEW_TEMPLATE_KINDS
        .map(kind => available.find(item => item.kind === kind))
        .filter((item): item is RenderTemplate => Boolean(item))
    })
    const templates = computed(() => catalog.value.map(item => ({ value: item.kind === "text-card" ? "text" : item.kind, label: item.label || item.kind })))
    const draft = reactive({ format: "markdown", input: toJson(defaultRenderInput("markdown")) })
    const settings = reactive({
      aiEngine: "html",
    })
    const systemRenderPanel = ref<{ getPatch?: () => UnknownRecord } | null>(null)
    const previewImage = ref("")
    const previewMeta = ref<RenderPreview | null>(null)
    const showPreviewDrawer = ref(false)
    const pills = computed(() => [
      { label: "HTML" }, { label: "Markdown · 数学公式 · Mermaid" },
      { label: "思维导图" }, { label: "文本卡片" },
    ])

    function loadSample() {
      draft.input = toJson(defaultRenderInput(draft.format))
      toast(`已载入 ${draft.format} 示例`)
    }
    function syncSettings() {
      settings.aiEngine = String(render.value.engine || "html") === "svg" ? "svg" : "html"
    }
    syncSettings()
    watch(render, syncSettings, { deep: true })

    async function saveSettings() {
      try {
        await saveConfigPatch({
          "response.render.engine": settings.aiEngine,
          ...(systemRenderPanel.value?.getPatch?.() || {}),
        })
        toast("render_image 策略已保存")
      } catch (err) { toast(errorMessage(err)) }
    }
    function chooseTemplate(item: RenderTemplate = { kind: "text-card" }) {
      draft.format = item.kind === "text-card" ? "text" : item.kind
      draft.input = toJson(defaultRenderInput(draft.format))
    }
    async function preview() {
      try {
        const input = parseJsonText(draft.input, "内容数据 JSON", {})
        const result = asRecord<RenderPreviewResponse>(await request("/api/render/preview", {
          method: "POST",
          body: JSON.stringify({ format: draft.format, data: input }),
        }))
        if (!result.preview?.imageBase64) throw new Error("渲染服务没有返回预览图")
        previewImage.value = `data:image/png;base64,${result.preview.imageBase64}`
        previewMeta.value = result.preview
        toast(`${draft.format} 预览已生成`)
      } catch (err) { toast(errorMessage(err)) }
    }
    return { render, catalog, templates, draft, settings, systemRenderPanel, previewImage, previewMeta, showPreviewDrawer, pills, chooseTemplate, loadSample, saveSettings, preview }
  },
  template: `
    <Panel title="图片渲染" icon="sparkles">
      <template #actions>
        <button class="btn small outline" type="button" @click="showPreviewDrawer = true"><Icon name="eye" :size="14" />渲染预览</button>
      </template>
      <SideDrawer :open="showPreviewDrawer" title="渲染预览" subtitle="HTML、Markdown、思维导图与文本卡片。" icon="sparkles" width="620px" @close="showPreviewDrawer = false">
        <div class="render-template-gallery">
          <button v-for="item in catalog" :key="item.kind" class="render-template-card" :class="{ active: draft.format === (item.kind === 'text-card' ? 'text' : item.kind) }" type="button" @click="chooseTemplate(item)">
            <span class="scenario-icon"><Icon name="sparkles" :size="17" /></span>
            <span><strong>{{ item.label || item.kind }}</strong><small>{{ item.description || item.command || '图片模板' }}</small></span>
            <Icon name="check" :size="14" />
          </button>
        </div>
        <Field label="格式" type="select" :options="templates.length ? templates : ['markdown']" v-model="draft.format" />
        <Field label="内容数据 JSON" type="textarea" v-model="draft.input" />
        <div class="action-bar"><button class="btn small outline" type="button" @click="loadSample"><Icon name="download" :size="14" />载入示例</button><button class="btn primary small" type="button" @click="preview"><Icon name="eye" :size="14" />生成预览</button></div>
        <div v-if="previewImage" class="render-preview" style="margin-top:12px"><img :src="previewImage" alt="render preview" /><PillList :items="[{ label: previewMeta.format || draft.format, active: true }, { label: previewMeta.fallback ? ((previewMeta.requestedEngine || 'HTML').toUpperCase() + ' → SVG 回退') : (previewMeta.engine || 'default') }, { label: (previewMeta.bytes || 0) + ' bytes' }]" /></div>
      </SideDrawer>
      <p class="muted tiny">支持的格式</p>
      <PillList :items="pills" />
      <div class="render-settings">
        <div class="form-grid">
          <Field label="工具引擎" type="select" :options="[{ value: 'html', label: 'HTML' }, { value: 'svg', label: 'SVG' }]" v-model="settings.aiEngine" tip="HTML 文档使用 HTML；其他格式按此设置渲染。" />
        </div>
      </div>
      <div class="render-settings">
        <SystemRenderStrategyPanel ref="systemRenderPanel" embedded :show-save="false" />
      </div>
      <div class="action-bar"><button class="btn primary small" type="button" @click="saveSettings"><Icon name="save" :size="14" />保存渲染策略</button></div>
      <p class="muted tiny">图片按需生成，不保存渲染文件。</p>
    </Panel>
  `,
}
