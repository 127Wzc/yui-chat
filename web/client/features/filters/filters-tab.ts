import { computed, ref } from "vue"
import { store } from "../../app/store/store.js"
import { CustomFiltersPanel } from "./custom-panel.js"
import { MessageFiltersPanel } from "./message-filters-panel.js"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record) : []
}

export const FiltersTab = {
  name: "FiltersTab",
  components: { CustomFiltersPanel, MessageFiltersPanel },
  setup() {
    const activeView = ref("rules")
    const createIntent = ref<UnknownRecord | null>(null)
    const filters = computed<UnknownRecord[]>(() => {
      const filtering = record(record(store.filters).filtering)
      const response = record(record(store.config).response)
      const messageFilters = record(response.messageFilters)
      return records(filtering.filters || messageFilters.filters)
    })
    const enabledCount = computed(() => filters.value.filter(item => item.enabled === true).length)
    const implementationCount = computed(() => records(record(store.filters).implementations || record(store.filters).tools).filter(item => ["builtin", "custom"].includes(String(item.source))).length)
    const viewItems = computed(() => [
      { value: "rules", label: "规则链", description: "按阶段与优先级安排处理顺序", icon: "filter", badge: enabledCount.value },
      { value: "implementations", label: "代码实现", description: "维护内置与 Custom Filter 代码", icon: "cpu", badge: implementationCount.value },
    ])

    function openImplementations(intent: UnknownRecord = {}): void {
      activeView.value = "implementations"
      createIntent.value = { stage: intent.stage || "output", view: intent.view || "code", nonce: Date.now() }
    }

    return { activeView, createIntent, viewItems, openImplementations }
  },
  template: `
    <div class="stack">
      <nav class="capability-mode-tabs" role="tablist" aria-label="代码过滤器分区">
        <button v-for="item in viewItems" :key="item.value" type="button" role="tab" :aria-selected="activeView === item.value" :class="{ active: activeView === item.value }" @click="activeView = item.value"><Icon :name="item.icon" :size="15" /><span>{{ item.label }}</span><b>{{ item.badge }}</b></button>
      </nav>
      <div class="section-stage capability-workspace">
        <div v-show="activeView === 'rules'" class="section-stage capability-source-stage"><MessageFiltersPanel @open-implementations="openImplementations" /></div>
        <div v-show="activeView === 'implementations'" class="section-stage capability-source-stage"><CustomFiltersPanel :create-intent="createIntent" /></div>
      </div>
    </div>
  `,
}
