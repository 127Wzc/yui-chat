import { computed, reactive, watch } from "vue"
import { saveConfigPatch, store, toast } from "../../app/store/store.js"
import { asRecord, errorMessage, type UnknownRecord } from "../../shared/data.js"

interface RenderConfig extends UnknownRecord {
  engine?: string
  system?: UnknownRecord
}

interface ResponseConfig extends UnknownRecord {
  render?: RenderConfig
}

function strategyValue(strategy: UnknownRecord, key: string, fallback: unknown): unknown {
  return strategy[key] === undefined ? fallback : strategy[key]
}

/** 系统图片与工具图片各自选择一个引擎；工具页与开发者页共用。 */
export const SystemRenderStrategyPanel = {
  name: "SystemRenderStrategyPanel",
  props: {
    embedded: { type: Boolean, default: false },
    showSave: { type: Boolean, default: true },
  },
  setup(_props: unknown, { expose }: { expose: (exposed: Record<string, unknown>) => void }) {
    const response = computed(() => asRecord<ResponseConfig>(asRecord(store.config).response))
    const render = computed<RenderConfig>(() => asRecord<RenderConfig>(response.value.render))
    const settings = reactive({
      engine: "html",
    })

    function syncSettings() {
      const system = asRecord(render.value.system)
      settings.engine = String(strategyValue(system, "engine", "html")) === "svg" ? "svg" : "html"
    }
    syncSettings()
    watch(render, syncSettings, { deep: true })

    function buildPatch(): UnknownRecord {
      return {
        "response.render.system.engine": settings.engine,
      }
    }

    async function saveSettings() {
      try {
        await saveConfigPatch(buildPatch(), "system-render-strategy")
        toast("系统渲染策略已保存", "success")
      } catch (err) { toast(errorMessage(err)) }
    }

    expose({ getPatch: buildPatch, saveSettings })
    return { settings, saveSettings }
  },
  template: `
    <div class="system-render-strategy-panel">
      <div v-if="!embedded" class="developer-section-head">
        <div><b>系统渲染策略</b><span>系统图片统一使用同一个引擎。</span></div>
        <button v-if="showSave" class="btn small outline" type="button" @click="saveSettings"><Icon name="save" :size="14" />保存</button>
      </div>
      <div class="form-grid">
        <Field label="图片引擎" type="select" :options="[{ value: 'html', label: 'HTML（优先）' }, { value: 'svg', label: 'SVG' }]" v-model="settings.engine" tip="HTML 不可用时使用 SVG。" />
      </div>
      <div v-if="embedded && showSave" class="action-bar"><button class="btn small outline" type="button" @click="saveSettings"><Icon name="save" :size="14" />保存</button></div>
      <p class="muted tiny">HTML 不可用时使用 SVG。</p>
    </div>
  `,
}
