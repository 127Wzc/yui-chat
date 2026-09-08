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
  html?: { enabled?: boolean; allowedUrlHosts?: string[]; allowPrivateHosts?: boolean }
}

interface RenderSlice extends UnknownRecord {
  render?: RenderConfig
}

interface RenderPreview extends UnknownRecord {
  imageBase64?: string
  kind?: string
  engine?: string
  requestedEngine?: string
  fallback?: boolean
  bytes?: number
}

interface RenderPreviewResponse extends UnknownRecord {
  preview?: RenderPreview
}

function defaultRenderInput(kind = "text-card") {
  if (kind === "markdown") return { title: "Markdown 渲染", markdown: "# 标题\n\n- 帮助图\n- 动态面板" }
  if (kind === "mindmap") return { title: "能力总览", markdown: "# Yui Chat\n## 模型\n## 工具\n## 渲染" }
  return { title: "Yui Chat", subtitle: "渲染预览", content: "这是一张文本卡片。" }
}

const PREVIEW_TEMPLATE_KINDS = ["text-card", "markdown", "mindmap"]

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
    const templates = computed(() => catalog.value.map(item => item.kind))
    const draft = reactive({ template: "text-card", input: toJson(defaultRenderInput("text-card")) })
    const settings = reactive({
      aiEngine: "html",
    })
    const systemRenderPanel = ref<{ getPatch?: () => UnknownRecord } | null>(null)
    const previewImage = ref("")
    const previewMeta = ref<RenderPreview | null>(null)
    const showPreviewDrawer = ref(false)
    const systemEngine = computed(() => String(asRecord(render.value.system).engine || "html").toUpperCase())

    const metrics = computed(() => [
      { label: "模板", value: catalog.value.length, icon: "sparkles", tone: "purple" },
      { label: "工具", value: settings.aiEngine.toUpperCase(), icon: "cpu", tone: "blue" },
      { label: "系统渲染", value: systemEngine.value, icon: "dashboard", tone: "cyan" },
    ])
    const pills = computed(() => [
      { label: `工具 ${render.value.engine || "html"}`, active: render.value.enabled !== false },
      { label: `系统 ${render.value.system?.engine || "html"}` },
      { label: "即时生成" },
      { label: `URL 域名 ${render.value.html?.allowedUrlHosts?.length || 0}` },
      { label: render.value.html?.allowPrivateHosts ? "私网 URL 放行" : "私网 URL 拦截", tone: render.value.html?.allowPrivateHosts ? "risk-high" : "" },
    ])

    function loadSample() {
      draft.input = toJson(defaultRenderInput(draft.template))
      toast(`已载入 ${draft.template} 示例`)
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
      draft.template = item.kind || "text-card"
      draft.input = toJson(defaultRenderInput(draft.template))
    }
    async function preview() {
      try {
        const input = parseJsonText(draft.input, "模板数据 JSON", {})
        const result = asRecord<RenderPreviewResponse>(await request("/api/render/preview", {
          method: "POST",
          body: JSON.stringify({ template: draft.template, data: input }),
        }))
        if (!result.preview?.imageBase64) throw new Error("渲染服务没有返回预览图")
        previewImage.value = `data:image/png;base64,${result.preview.imageBase64}`
        previewMeta.value = result.preview
        toast(`${draft.template} 预览已生成`)
      } catch (err) { toast(errorMessage(err)) }
    }
    return { render, catalog, templates, draft, settings, systemRenderPanel, previewImage, previewMeta, showPreviewDrawer, metrics, pills, chooseTemplate, loadSample, saveSettings, preview }
  },
  template: `
    <Panel title="render_image 图片渲染" icon="sparkles">
      <template #actions>
        <button class="btn small outline" type="button" @click="showPreviewDrawer = true"><Icon name="eye" :size="14" />模板预览</button>
      </template>
      <SideDrawer :open="showPreviewDrawer" title="模板预览" subtitle="选择模板并预览。" icon="sparkles" width="620px" @close="showPreviewDrawer = false">
        <div class="render-template-gallery">
          <button v-for="item in catalog" :key="item.kind" class="render-template-card" :class="{ active: draft.template === item.kind }" type="button" @click="chooseTemplate(item)">
            <span class="scenario-icon"><Icon name="sparkles" :size="17" /></span>
            <span><strong>{{ item.label || item.kind }}</strong><small>{{ item.description || item.command || '图片模板' }}</small></span>
            <Icon name="check" :size="14" />
          </button>
        </div>
        <Field label="模板" type="select" :options="templates.length ? templates : ['text-card']" v-model="draft.template" />
        <Field label="模板数据 JSON" type="textarea" v-model="draft.input" />
        <div class="action-bar"><button class="btn small outline" type="button" @click="loadSample"><Icon name="download" :size="14" />载入示例</button><button class="btn primary small" type="button" @click="preview"><Icon name="eye" :size="14" />生成预览</button></div>
        <div v-if="previewImage" class="render-preview" style="margin-top:12px"><img :src="previewImage" alt="render preview" /><PillList :items="[{ label: previewMeta.kind || draft.template, active: true }, { label: previewMeta.fallback ? ((previewMeta.requestedEngine || 'HTML').toUpperCase() + ' → SVG 回退') : (previewMeta.engine || 'default') }, { label: (previewMeta.bytes || 0) + ' bytes' }]" /></div>
      </SideDrawer>
      <MetricGrid :items="metrics" compact />
      <PillList :items="pills" />
      <Collapse title="工具渲染" hint="render_image 使用的设置">
        <div class="form-grid">
          <Field label="图片引擎" type="select" :options="[{ value: 'html', label: 'HTML（优先）' }, { value: 'svg', label: 'SVG' }]" v-model="settings.aiEngine" tip="只影响 render_image。" />
        </div>
      </Collapse>
      <Collapse title="系统渲染" hint="系统图片统一使用同一个引擎">
        <SystemRenderStrategyPanel ref="systemRenderPanel" embedded :show-save="false" />
      </Collapse>
      <div class="action-bar"><button class="btn primary small" type="button" @click="saveSettings"><Icon name="save" :size="14" />保存渲染策略</button></div>
      <p class="muted tiny">图片按需生成，不保存渲染文件。</p>
    </Panel>
  `,
}
