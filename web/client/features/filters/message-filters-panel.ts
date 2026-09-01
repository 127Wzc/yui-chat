import { computed, onMounted, reactive, ref } from "vue"
import { confirmAction, request, store, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { Field, Icon, JsonBlock, Panel, SideDrawer, Switch } from "../../ui/components.js"

interface FilterCondition extends UnknownRecord {
  minTextLength?: number
}

interface FilterArgument extends UnknownRecord {
  value?: unknown
}

interface FilterImplementationRef extends UnknownRecord {
  type: string
  id: string
  arguments: Record<string, FilterArgument>
}

interface MessageFilter extends UnknownRecord {
  id: string
  name: string
  enabled: boolean
  stage: string
  priority: number
  condition: FilterCondition
  implementation: FilterImplementationRef
  onFailure: string
}

interface StageDefinition extends UnknownRecord {
  id: string
  label: string
  shortLabel: string
  description: string
  textBinding: string
  textLabel: string
}

interface FieldSchema extends UnknownRecord {
  type?: string
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  enumLabels?: Record<string, string>
}

interface FieldEntry {
  name: string
  schema: FieldSchema
}

interface FilterImplementation extends UnknownRecord {
  id: string
  source?: string
  sourceLabel?: string
  stages?: string[]
  displayName?: string
  displayNameZh?: string
  description?: string
  packageId?: string
  tags?: string[]
  effects?: string[]
  enabled?: boolean
  parameters?: { properties?: Record<string, FieldSchema>; required?: string[] }
}

interface FilterTemplate extends UnknownRecord {
  id: string
  name: string
  description: string
  filter: MessageFilter
}

interface MessageFiltersResponse extends UnknownRecord {
  filtering?: { enabled?: boolean; filters?: MessageFilter[] }
  implementations?: FilterImplementation[]
  stages?: StageDefinition[]
  templates?: FilterTemplate[]
  config?: UnknownRecord
}

interface FilterGroup {
  stage: StageDefinition
  filters: MessageFilter[]
}

interface ImplementationSource {
  id: string
  label: string
  count: number
}

interface EditorStep {
  value: number
  label: string
  description: string
}

interface DragState {
  id: string
  stage: string
  overId: string
}

interface FilterPanelContext {
  emit: (event: "open-implementations", payload: UnknownRecord) => void
}

function filterId(prefix = "filter"): string {
  return `${prefix}-${Date.now().toString(36)}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emptyFilter(): MessageFilter {
  return {
    id: filterId(),
    name: "新的输出过滤器",
    enabled: false,
    stage: "output",
    priority: 100,
    condition: { minTextLength: 0 },
    implementation: { type: "filter", id: "", arguments: {} },
    onFailure: "continue",
  }
}

const fallbackStages: StageDefinition[] = [
  { id: "input", label: "发送模型前", shortLabel: "输入过滤器", description: "改写、校验或拦截当前用户输入。", textBinding: "input.text", textLabel: "当前用户输入" },
  { id: "output", label: "回复发送前", shortLabel: "输出过滤器", description: "改写、拦截或转换当前回复正文。", textBinding: "response.text", textLabel: "当前回复正文" },
]

function sourceIcon(implementation: FilterImplementation = { id: "" }): string {
  return implementation.source === "custom" ? "cpu" : "sliders"
}

function sourceName(implementation: FilterImplementation = { id: "" }): string {
  return implementation.sourceLabel || (implementation.source === "custom" ? "Custom 代码" : "内置代码")
}

export const MessageFiltersPanel = {
  name: "MessageFiltersPanel",
  components: { Field, Icon, JsonBlock, Panel, SideDrawer, Switch },
  emits: ["open-implementations"],
  setup(_context: unknown, { emit }: FilterPanelContext) {
    const loading = ref(false)
    const saving = ref(false)
    const enabled = ref(true)
    const filters = ref<MessageFilter[]>([])
    const templates = ref<FilterTemplate[]>([])
    const stages = ref<StageDefinition[]>(clone(fallbackStages))
    const implementations = ref<FilterImplementation[]>([])
    const implementationQuery = ref("")
    const implementationSource = ref("all")
    const editorOpen = ref(false)
    const editorStep = ref(1)
    const editingIndex = ref(-1)
    const editor = reactive<MessageFilter>(emptyFilter())
    const testText = ref("这是一段用于测试的消息 123。")
    const testRunning = ref(false)
    const testResult = ref<unknown>(null)
    const dragState = reactive<DragState>({ id: "", stage: "", overId: "" })

    const selectedStage = computed<StageDefinition>(() => stages.value.find(stage => stage.id === editor.stage) || fallbackStages.find(stage => stage.id === editor.stage) || fallbackStages[1])
    const stageOptions = computed(() => stages.value.map(stage => ({ value: stage.id, label: `${stage.shortLabel || stage.label}：${stage.label}` })))
    const selectableImplementations = computed(() => implementations.value.filter(implementation => {
      return ["builtin", "custom"].includes(implementation.source || "") && (implementation.stages || []).includes(editor.stage)
    }))
    const implementationSources = computed<ImplementationSource[]>(() => {
      const groups = new Map<string, ImplementationSource>()
      for (const implementation of selectableImplementations.value) {
        const id = implementation.source || "custom"
        const current = groups.get(id) || { id, label: sourceName(implementation), count: 0 }
        current.count += 1
        groups.set(id, current)
      }
      return [{ id: "all", label: "全部", count: selectableImplementations.value.length }, ...groups.values()]
    })
    const filteredImplementations = computed(() => {
      const query = implementationQuery.value.trim().toLowerCase()
      return selectableImplementations.value.filter(implementation => {
        const source = implementation.source
        if (implementationSource.value !== "all" && source !== implementationSource.value) return false
        if (!query) return true
        return [
          implementation.id,
          implementation.displayName,
          implementation.displayNameZh,
          implementation.description,
          implementation.sourceLabel,
          implementation.packageId,
          ...(implementation.tags || []),
        ].some(value => String(value || "").toLowerCase().includes(query))
      })
    })
    const selectedImplementation = computed(() => selectableImplementations.value.find(item => item.id === editor.implementation.id) || null)
    const selectedFields = computed<FieldEntry[]>(() => Object.entries(selectedImplementation.value?.parameters?.properties || {}).map(([name, schema]) => ({ name, schema })))
    const activeFilterCount = computed(() => filters.value.filter(filter => filter.enabled).length)
    const implementationCount = computed(() => implementations.value.filter(item => ["builtin", "custom"].includes(item.source || "")).length)
    const filterGroups = computed<FilterGroup[]>(() => ["input", "output"].map(stageId => ({
      stage: stages.value.find(stage => stage.id === stageId) || fallbackStages.find(stage => stage.id === stageId) || fallbackStages[1],
      filters: filters.value
        .map((filter, index) => ({ filter, index }))
        .filter(item => item.filter.stage === stageId)
        .sort((left, right) => Number(left.filter.priority ?? 100) - Number(right.filter.priority ?? 100) || left.index - right.index)
        .map(item => item.filter),
    })))
    const editorSteps = computed<EditorStep[]>(() => [
      { value: 1, label: "选择实现", description: selectedImplementation.value?.displayNameZh || selectedImplementation.value?.displayName || "先决定如何处理" },
      { value: 2, label: "设置规则", description: editor.name?.trim() || "名称、条件和优先级" },
      { value: 3, label: "测试并保存", description: "确认实际效果" },
    ])
    const effectsNeedConfirmation = computed(() => (selectedImplementation.value?.effects || []).some(effect => effect === "network" || effect === "delivery"))

    function resetEditor(filter = emptyFilter(), index = -1) {
      const next = clone(filter)
      const implementation = next.implementation || { type: "filter", id: "", arguments: {} }
      Object.assign(editor, next, {
        priority: Number.isInteger(Number(next.priority)) ? Number(next.priority) : 100,
        condition: { minTextLength: Number(next.condition?.minTextLength ?? 0) },
        implementation: { type: "filter", id: implementation.id || "", arguments: { ...(implementation.arguments || {}) } },
      })
      editingIndex.value = index
      ensureArguments()
    }

    function ensureArguments() {
      for (const { name, schema } of selectedFields.value) {
        if (name === "text") continue
        const previous = editor.implementation.arguments[name]
        editor.implementation.arguments[name] = { value: previous?.value ?? schema.default ?? "" }
      }
    }

    function setStage(stage: string): void {
      editor.stage = stage
      if (!selectableImplementations.value.some(implementation => implementation.id === editor.implementation.id)) {
        editor.implementation.id = ""
        editor.implementation.arguments = {}
        editor.implementation.type = "filter"
      }
      implementationSource.value = "all"
      ensureArguments()
    }

    function setImplementation(implementation: FilterImplementation): void {
      editor.implementation.id = implementation.id
      editor.implementation.type = "filter"
      editor.implementation.arguments = {}
      ensureArguments()
    }

    function argument(field: FieldEntry): FilterArgument {
      editor.implementation.arguments[field.name] ||= { value: field.schema.default ?? "" }
      return editor.implementation.arguments[field.name]
    }

    function editFilter(filter: MessageFilter, index: number): void {
      resetEditor(filter, index)
      testResult.value = null
      implementationQuery.value = ""
      implementationSource.value = "all"
      editorStep.value = 1
      editorOpen.value = true
    }

    function createFilter() {
      editFilter(emptyFilter(), -1)
    }

    function startFromTemplate(template: FilterTemplate): void {
      const next = clone(template.filter)
      next.id = filterId(template.id)
      resetEditor(next)
      implementationQuery.value = ""
      implementationSource.value = "all"
      editorStep.value = 2
      testResult.value = null
      editorOpen.value = true
    }

    function goToEditorStep(step: number): void {
      const target = Number(step)
      if (target > 1 && !selectedImplementation.value) return toast("请先选择一个过滤器实现")
      if (target > 2 && !editor.name.trim()) return toast("请先填写过滤器名称")
      editorStep.value = Math.max(1, Math.min(3, target))
    }

    function nextEditorStep() {
      goToEditorStep(editorStep.value + 1)
    }

    function previousEditorStep() {
      editorStep.value = Math.max(1, editorStep.value - 1)
    }

    function validateEditor() {
      const implementation = selectedImplementation.value
      if (!editor.name.trim()) return toast("请填写过滤器名称")
      if (!implementation) return toast("请选择支持当前阶段的过滤器实现")
      const priority = Number(editor.priority)
      if (!Number.isInteger(priority) || priority < -10000 || priority > 10000) return toast("优先级请输入 -10000 到 10000 之间的整数")
      const required = new Set(implementation.parameters?.required || [])
      for (const field of selectedFields.value) {
        if (field.name === "text") continue
        const value = argument(field).value
        if (required.has(field.name) && (value === "" || value === null || value === undefined)) return toast(`请填写「${field.schema.title || field.name}」`)
      }
      return implementation
    }

    function draftFilter() {
      const item = clone(editor)
      item.id ||= filterId()
      item.priority = Number(item.priority)
      const args = Object.fromEntries(selectedFields.value
        .filter(field => field.name !== "text")
        .map(field => [field.name, { value: argument(field).value }]))
      item.implementation = { type: "filter", id: item.implementation.id, arguments: args }
      item.onFailure = "continue"
      return item
    }

    function normalizeStagePriority(stage: string, suppliedOrder: MessageFilter[] | null = null): void {
      const ordered = suppliedOrder || filterGroups.value.find(group => group.stage.id === stage)?.filters || []
      const ids = new Set(ordered.map(item => item.id))
      const normalized = new Map(ordered.map((filter, index) => [filter.id, { ...filter, priority: (index + 1) * 100 }]))
      filters.value = filters.value.map(filter => ids.has(filter.id) ? normalized.get(filter.id) || filter : filter)
    }

    function placeFilter(item: MessageFilter): void {
      const previous = editingIndex.value >= 0 ? filters.value[editingIndex.value] : null
      if (editingIndex.value >= 0) filters.value.splice(editingIndex.value, 1)
      if (previous && previous.stage !== item.stage) {
        const source = filters.value
          .map((filter, index) => ({ filter, index }))
          .filter(entry => entry.filter.stage === previous.stage)
          .sort((left, right) => Number(left.filter.priority ?? 100) - Number(right.filter.priority ?? 100) || left.index - right.index)
          .map(entry => entry.filter)
        const target = filters.value
          .map((filter, index) => ({ filter, index }))
          .filter(entry => entry.filter.stage === item.stage)
          .sort((left, right) => Number(left.filter.priority ?? 100) - Number(right.filter.priority ?? 100) || left.index - right.index)
          .map(entry => entry.filter)
        target.push(item)
        filters.value.push(item)
        normalizeStagePriority(previous.stage, source)
        normalizeStagePriority(item.stage, target)
        return
      }
      if (editingIndex.value >= 0) filters.value.splice(editingIndex.value, 0, item)
      else filters.value.push(item)
    }

    async function saveFilter() {
      if (!validateEditor()) return
      placeFilter(draftFilter())
      editorOpen.value = false
      await persist()
    }

    async function confirmTestEffects() {
      if (!effectsNeedConfirmation.value) return true
      const effects = selectedImplementation.value?.effects || []
      const message = effects.includes("delivery")
        ? "这个过滤器可能产生语音或其他发送记录。试跑不会自动形成安全沙箱。"
        : "这个过滤器可能访问外部服务。试跑不会自动形成安全沙箱。"
      return confirmAction({ title: "这次试跑可能产生真实副作用", message, confirmText: "继续真实试跑", tone: "warn", icon: "alert" })
    }

    async function testFilter() {
      if (!validateEditor()) return
      if (!await confirmTestEffects()) return
      testRunning.value = true
      testResult.value = null
      try {
        const result = await request("/api/message-filters/test", { method: "POST", body: JSON.stringify({ filter: draftFilter(), text: testText.value }) })
        testResult.value = result.result || null
        toast("过滤器测试已完成")
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        testRunning.value = false
      }
    }

    function setCatalog(result: MessageFiltersResponse = {}): void {
      implementations.value = result.implementations || []
      stages.value = result.stages?.length ? result.stages : stages.value
      templates.value = result.templates || []
    }

    async function persist() {
      saving.value = true
      try {
        const result = await request("/api/message-filters", { method: "PUT", body: JSON.stringify({ enabled: enabled.value, filters: filters.value }) }) as MessageFiltersResponse
        filters.value = result.filtering?.filters || []
        store.config = result.config || store.config
        store.filters = result
        setCatalog(result)
        toast("代码过滤器规则已保存")
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        saving.value = false
      }
    }

    async function removeFilter(index: number): Promise<void> {
      const filter = filters.value[index]
      const accepted = await confirmAction({ title: `删除「${filter?.name || "这个过滤器"}」？`, message: "删除后不会再对后续消息执行该过滤器。", confirmText: "确认删除", tone: "danger", icon: "trash" })
      if (!accepted) return
      filters.value.splice(index, 1)
      await persist()
    }

    async function toggleFilter(index: number, value: boolean): Promise<void> {
      if (!filters.value[index]) return
      filters.value[index].enabled = value
      await persist()
    }

    function filterIndex(filter: MessageFilter): number {
      return filters.value.findIndex(item => item.id === filter?.id)
    }

    function startFilterDrag(filter: MessageFilter, event: DragEvent): void {
      if (saving.value) return
      Object.assign(dragState, { id: filter.id, stage: filter.stage, overId: filter.id })
      event.dataTransfer?.setData("text/plain", filter.id)
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
    }

    function endFilterDrag() {
      Object.assign(dragState, { id: "", stage: "", overId: "" })
    }

    async function reorderWithinStage(filterId: string, targetIndex: number): Promise<void> {
      const group = filterGroups.value.find(item => item.stage.id === dragState.stage || item.filters.some(filter => filter.id === filterId))
      if (!group) return
      const currentIndex = group.filters.findIndex(filter => filter.id === filterId)
      if (currentIndex < 0) return
      const next = [...group.filters]
      const [moved] = next.splice(currentIndex, 1)
      next.splice(Math.max(0, Math.min(next.length, Number(targetIndex))), 0, moved)
      if (next.every((filter, index) => filter.id === group.filters[index]?.id)) return
      const reordered = next.map((filter, index) => ({ ...filter, priority: (index + 1) * 100 }))
      const otherStages = ["input", "output"].flatMap(stage => stage === group.stage.id ? reordered : (filterGroups.value.find(item => item.stage.id === stage)?.filters || []))
      filters.value = otherStages
      endFilterDrag()
      await persist()
    }

    async function dropOnFilter(target: MessageFilter): Promise<void> {
      if (!dragState.id) return
      if (dragState.stage !== target.stage) {
        toast("输入和输出属于不同阶段，请在同一阶段内排序")
        endFilterDrag()
        return
      }
      const group = filterGroups.value.find(item => item.stage.id === target.stage)
      await reorderWithinStage(dragState.id, group?.filters.findIndex(filter => filter.id === target.id) ?? 0)
    }

    async function dropAtStageEnd(stage: string): Promise<void> {
      if (!dragState.id) return
      if (dragState.stage !== stage) {
        toast("输入和输出属于不同阶段，请在同一阶段内排序")
        endFilterDrag()
        return
      }
      const group = filterGroups.value.find(item => item.stage.id === stage)
      await reorderWithinStage(dragState.id, group?.filters.length ?? 0)
    }

    async function moveFilter(filter: MessageFilter, offset: number): Promise<void> {
      if (saving.value) return
      Object.assign(dragState, { id: filter.id, stage: filter.stage, overId: "" })
      const group = filterGroups.value.find(item => item.stage.id === filter.stage)
      const index = group?.filters.findIndex(item => item.id === filter.id) ?? -1
      await reorderWithinStage(filter.id, index + Number(offset))
      endFilterDrag()
    }

    function openImplementationBuilder(view = "code") {
      editorOpen.value = false
      emit("open-implementations", { stage: editor.stage, view })
    }

    function focusImplementationCatalog(): void {
      document.querySelector<HTMLInputElement>(".processor-catalog-filter input")?.focus()
    }

    async function load() {
      loading.value = true
      try {
        const result = await request("/api/message-filters") as MessageFiltersResponse
        enabled.value = result.filtering?.enabled !== false
        filters.value = result.filtering?.filters || []
        store.filters = result
        setCatalog(result)
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        loading.value = false
      }
    }

    function boundValue(field: FieldEntry): unknown {
      const value = argument(field).value
      if (field.schema.type === "boolean") return value === true ? "true" : "false"
      return value ?? ""
    }

    function updateBoundValue(field: FieldEntry, value: unknown): void {
      argument(field).value = field.schema.type === "boolean" ? value === "true" : value
    }

    function implementationName(id = "") {
      const implementation = implementations.value.find(item => item.id === id)
      return implementation?.displayNameZh || implementation?.displayName || id || "未选择实现"
    }

    onMounted(load)
    return {
      loading,
      saving,
      enabled,
      filters,
      filterGroups,
      templates,
      stages,
      implementations,
      editorOpen,
      editor,
      editingIndex,
      selectedStage,
      stageOptions,
      selectedImplementation,
      selectedFields,
      selectableImplementations,
      implementationSources,
      filteredImplementations,
      implementationQuery,
      implementationSource,
      activeFilterCount,
      implementationCount,
      editorStep,
      editorSteps,
      testText,
      testRunning,
      testResult,
      dragState,
      effectsNeedConfirmation,
      argument,
      boundValue,
      updateBoundValue,
      setImplementation,
      setStage,
      editFilter,
      startFromTemplate,
      createFilter,
      goToEditorStep,
      nextEditorStep,
      previousEditorStep,
      saveFilter,
      testFilter,
      removeFilter,
      toggleFilter,
      filterIndex,
      startFilterDrag,
      endFilterDrag,
      dropOnFilter,
      dropAtStageEnd,
      moveFilter,
      openImplementationBuilder,
      focusImplementationCatalog,
      persist,
      load,
      sourceIcon,
      sourceName,
      implementationName,
    }
  },
  template: `
    <div class="settings-stack">
      <Panel class="message-processing-hero">
        <div class="message-processing-hero-main">
          <span class="message-processing-hero-icon"><Icon name="filter" :size="20" /></span>
          <div class="message-processing-hero-copy">
            <div class="row-title"><h2>代码过滤器</h2><span class="badge" :class="enabled ? 'on' : 'risk-medium'">{{ enabled ? '运行中' : '已暂停' }}</span></div>
            <p>像一条确定性流水线，在消息进入模型前或回复发出前，依次整理、拦截或转换正文。</p>
            <div class="message-processing-stats"><span><b>{{ activeFilterCount }}</b> 条规则生效</span><span><b>{{ implementationCount }}</b> 个代码实现可选</span></div>
          </div>
          <div class="message-processing-hero-actions"><label class="inline-switch"><Switch v-model="enabled" @update:modelValue="persist" /><span>{{ enabled ? '总开关已开启' : '总开关已关闭' }}</span></label></div>
        </div>
      </Panel>

      <Panel title="规则链" :subtitle="filters.length ? '输入过滤器永远在前；每组内数字越小越先执行，拖动后自动按 100 递增重排。' : '还没有规则，推荐先从示例开始。'" icon="filter">
        <template #actions><button class="btn primary" type="button" @click="createFilter"><Icon name="plus" :size="14" />新建规则</button></template>
        <div v-if="templates.length" class="message-template-strip"><span class="message-template-icon"><Icon name="sparkles" :size="16" /></span><div><strong>第一次使用？试试「{{ templates[0].name }}」</strong><p>{{ templates[0].description }}</p></div><button class="btn small outline" type="button" @click="startFromTemplate(templates[0])"><Icon name="copy" :size="13" />使用示例</button></div>
        <div v-if="loading" class="empty-state">正在读取过滤器…</div>
        <div v-else-if="filters.length" class="message-filter-groups">
          <section v-for="group in filterGroups" :key="group.stage.id" class="message-filter-group" @dragover.prevent @drop="dropAtStageEnd(group.stage.id)">
            <header class="message-filter-group-head"><span class="message-stage-icon"><Icon :name="group.stage.id === 'input' ? 'message' : 'sparkles'" :size="15" /></span><div><strong>{{ group.stage.shortLabel }}</strong><small>{{ group.stage.label }} · {{ group.filters.length }} 条</small></div><span class="pill">{{ group.stage.id === 'input' ? '先执行' : '后执行' }}</span></header>
            <div v-if="group.filters.length" class="list-stack">
              <article v-for="(filter, groupIndex) in group.filters" :key="filter.id" class="message-rule-card" :class="{ disabled: !filter.enabled, dragging: dragState.id === filter.id, 'drag-over': dragState.overId === filter.id && dragState.id !== filter.id }" @dragenter.prevent="dragState.overId = filter.id" @dragover.prevent @drop.stop="dropOnFilter(filter)">
                <button class="message-filter-drag" type="button" draggable="true" aria-label="拖动调整优先级" data-tip="拖动调整顺序" @dragstart="startFilterDrag(filter, $event)" @dragend="endFilterDrag"><Icon name="menu" :size="15" /></button>
                <span class="message-rule-card-icon"><Icon :name="filter.stage === 'input' ? 'message' : 'sparkles'" :size="16" /></span>
                <div class="message-rule-card-copy"><div class="row-title"><strong>{{ filter.name || filter.id }}</strong><span class="pill">优先级 {{ filter.priority ?? 100 }}</span></div><p><b>{{ implementationName(filter.implementation?.id) }}</b><span>·</span>{{ filter.condition?.minTextLength ? '满 ' + filter.condition.minTextLength + ' 字时执行' : '每条消息都执行' }}</p></div>
                <div class="message-rule-card-actions"><button class="icon-btn" type="button" :disabled="groupIndex === 0 || saving" data-tip="上移" @click="moveFilter(filter, -1)"><Icon name="chevron-up" :size="14" /></button><button class="icon-btn" type="button" :disabled="groupIndex === group.filters.length - 1 || saving" data-tip="下移" @click="moveFilter(filter, 1)"><Icon name="chevron-down" :size="14" /></button><label class="inline-switch"><Switch :model-value="filter.enabled" @update:modelValue="value => toggleFilter(filterIndex(filter), value)" /><span>{{ filter.enabled ? '启用' : '停用' }}</span></label><button class="btn small outline" type="button" @click="editFilter(filter, filterIndex(filter))"><Icon name="pencil" :size="13" />编辑</button><button class="icon-btn danger" type="button" data-tip="删除过滤器" @click="removeFilter(filterIndex(filter))"><Icon name="trash" :size="14" /></button></div>
              </article>
            </div>
            <div v-else class="message-filter-group-empty">暂无{{ group.stage.shortLabel }}</div>
          </section>
        </div>
        <div v-else-if="!loading" class="message-rules-empty"><span><Icon name="filter" :size="22" /></span><strong>还没有代码过滤器规则</strong><p>从示例开始最快，也可以自己选择阶段和代码实现。</p><div class="row"><button v-if="templates.length" class="btn primary" type="button" @click="startFromTemplate(templates[0])">使用推荐示例</button><button class="btn outline" type="button" @click="createFilter">自己创建</button></div></div>
      </Panel>

      <SideDrawer :open="editorOpen" :title="editingIndex >= 0 ? '编辑代码过滤器规则' : '新建代码过滤器规则'" subtitle="跟着 3 步完成设置；保存前可以试跑一次。" icon="filter" width="880px" :modal="true" @close="editorOpen = false">
        <nav class="message-rule-steps" aria-label="过滤器设置步骤"><button v-for="step in editorSteps" :key="step.value" type="button" :class="{ active: editorStep === step.value, done: editorStep > step.value }" @click="goToEditorStep(step.value)"><span><Icon v-if="editorStep > step.value" name="check" :size="13" /><template v-else>{{ step.value }}</template></span><span><strong>{{ step.label }}</strong><small>{{ step.description }}</small></span></button></nav>

        <div v-if="editorStep === 1" class="message-rule-step">
          <div class="message-rule-step-intro"><span>1</span><div><h3>这个规则在什么时候运行？</h3><p>多数回复整理、内容过滤和语音输出都选“回复发出前”。</p></div></div>
          <div class="message-stage-grid"><button v-for="stage in stages" :key="stage.id" type="button" :class="{ selected: editor.stage === stage.id }" @click="setStage(stage.id)"><span class="message-stage-icon"><Icon :name="stage.id === 'input' ? 'message' : 'sparkles'" :size="17" /></span><span><strong>{{ stage.shortLabel || stage.label }}</strong><small>{{ stage.label }} · {{ stage.description }}</small></span><Icon :name="editor.stage === stage.id ? 'check' : 'chevron-right'" :size="15" /></button></div>
          <div class="message-filter-implementation-paths"><button type="button" @click="focusImplementationCatalog"><span class="processor-choice-icon builtin"><Icon name="dashboard" :size="16" /></span><span><strong>选择已有实现</strong><small>只显示内置代码与 Custom 代码过滤器</small></span></button><button type="button" @click="openImplementationBuilder('code')"><span class="processor-choice-icon custom"><Icon name="cpu" :size="16" /></span><span><strong>编写自定义代码</strong><small>创建独立的 createFilters 实现</small></span></button><button type="button" @click="openImplementationBuilder('resources')"><span class="processor-choice-icon custom"><Icon name="link" :size="16" /></span><span><strong>接入框架资源</strong><small>声明资源后，再用少量代码包装成过滤器</small></span></button></div>
          <div class="section-heading-row"><div><div class="section-title"><Icon name="dashboard" :size="13" />选择代码实现</div><p class="muted small">只显示支持“{{ selectedStage.label }}”的实现。</p></div><span class="filter-count">{{ filteredImplementations.length }}/{{ selectableImplementations.length }}</span></div>
          <div class="list-filter processor-catalog-filter"><div class="filter-search"><Icon name="search" :size="14" /><input v-model="implementationQuery" placeholder="搜索代码过滤器实现" /></div><div class="segmented processor-source-tabs" role="group" aria-label="过滤器实现来源筛选"><button v-for="source in implementationSources" :key="source.id" :class="{ active: implementationSource === source.id }" type="button" @click="implementationSource = source.id">{{ source.label }} <span>{{ source.count }}</span></button></div></div>
          <div v-if="filteredImplementations.length" class="processor-catalog"><button v-for="implementation in filteredImplementations" :key="implementation.id" class="processor-choice" :class="{ selected: editor.implementation.id === implementation.id }" type="button" @click="setImplementation(implementation)"><span class="processor-choice-icon" :class="implementation.source"><Icon :name="sourceIcon(implementation)" :size="17" /></span><span class="processor-choice-copy"><span class="processor-choice-title"><strong>{{ implementation.displayNameZh || implementation.displayName || implementation.id }}</strong><code>{{ implementation.id }}</code></span><span class="processor-choice-description">{{ implementation.description || '该实现暂未填写说明。' }}</span><span class="processor-choice-meta"><span class="badge">{{ sourceName(implementation) }}</span><span v-if="!implementation.enabled" class="pill">当前未启用</span></span></span><Icon :name="editor.implementation.id === implementation.id ? 'check' : 'chevron-right'" :size="16" /></button></div>
          <div v-else class="processor-catalog-empty"><Icon name="search" :size="22" /><strong>没有找到可用实现</strong><p v-if="selectableImplementations.length">清空搜索或切换来源后再试。</p><p v-else>当前还没有支持这个阶段的代码实现，可先到“代码实现”创建一个 Custom Filter。</p></div>
        </div>

        <div v-else-if="editorStep === 2" class="message-rule-step">
          <div class="message-rule-step-intro"><span>2</span><div><h3>命名并设置执行顺序</h3><p>新手保持优先级 100 即可；需要调整顺序时，数字越小越先执行。</p></div></div>
          <div class="message-rule-basics"><Field label="过滤器名称" v-model="editor.name" placeholder="例如：长回复转语音" /><Field label="优先级" type="number" v-model="editor.priority" hint="数字越小越先执行；拖动后会自动按 100 递增" /><Field :label="selectedStage.textLabel + '至少多少字'" type="number" v-model="editor.condition.minTextLength" hint="0 表示每条消息" /><label class="field"><span class="field-label">保存后状态</span><span class="message-enable-choice"><Switch v-model="editor.enabled" /><span><b>{{ editor.enabled ? '立即启用' : '先保存，不启用' }}</b><small>{{ editor.enabled ? '保存后开始处理新消息' : '可稍后在规则链中开启' }}</small></span></span></label></div>
          <div v-if="selectedImplementation" class="form-section message-parameter-section"><div class="section-heading-row"><div><div class="section-title"><Icon name="gear" :size="13" />{{ selectedImplementation.displayNameZh || selectedImplementation.displayName || selectedImplementation.id }} 的设置</div><p class="muted small">{{ selectedImplementation.description || '按需要补充固定处理参数。' }}</p></div><button class="btn small outline" type="button" @click="editorStep = 1">更换实现</button></div><div class="form-grid"><template v-for="field in selectedFields" :key="field.name"><Field v-if="field.schema.type === 'boolean'" :label="field.schema.title || field.name" type="select" :options="[{ value: 'false', label: '否' }, { value: 'true', label: '是' }]" :model-value="boundValue(field)" @update:model-value="value => updateBoundValue(field, value)" /><Field v-else-if="Array.isArray(field.schema.enum)" :label="field.schema.title || field.name" type="select" :options="field.schema.enum.map(value => ({ value, label: field.schema.enumLabels?.[value] || value }))" :model-value="boundValue(field)" @update:model-value="value => updateBoundValue(field, value)" /><Field v-else-if="field.name !== 'text'" :label="field.schema.title || field.name" :type="field.schema.type === 'number' ? 'number' : 'text'" :placeholder="field.schema.description || ''" :model-value="boundValue(field)" @update:model-value="value => updateBoundValue(field, value)" /><div v-else class="field"><span class="field-label">{{ field.schema.title || field.name }}</span><div class="field-readonly">自动使用{{ selectedStage.textLabel }}</div></div></template></div></div>
          <div class="hint-banner ok"><Icon name="info" :size="14" /><span>代码过滤器和 AI Tool 的启用状态、角色权限彼此独立；正文由过滤链自动注入。</span></div>
        </div>

        <div v-else class="message-rule-step">
          <div class="message-rule-step-intro"><span>3</span><div><h3>最后检查一次，也可以先试跑</h3><p>试跑直接执行已选择的代码实现；网络或发送类实现会要求再次确认。</p></div></div>
          <div class="message-rule-review"><div><span>规则</span><strong>{{ editor.name }}</strong></div><div><span>执行阶段</span><strong>{{ selectedStage.label }}</strong></div><div><span>实现</span><strong>{{ selectedImplementation ? (selectedImplementation.displayNameZh || selectedImplementation.displayName || selectedImplementation.id) : '' }}</strong></div><div><span>优先级</span><strong>{{ editor.priority }}（数字越小越先执行）</strong></div><div><span>触发条件</span><strong>{{ editor.condition.minTextLength ? selectedStage.textLabel + '满 ' + editor.condition.minTextLength + ' 字' : '每条消息' }}</strong></div><div><span>保存后</span><strong :class="{ 'good-text': editor.enabled }">{{ editor.enabled ? '立即启用' : '保持停用' }}</strong></div></div>
          <div v-if="effectsNeedConfirmation" class="hint-banner warn"><Icon name="alert" :size="14" /><span>该实现可能访问网络或产生发送记录。测试时会执行真实逻辑，不是安全沙箱。</span></div>
          <div class="form-section message-test-section"><div class="section-title"><Icon name="play" :size="13" />规则试跑</div><Field :label="'模拟' + selectedStage.textLabel" type="textarea" rows="4" v-model="testText" /><button class="btn small outline" type="button" :disabled="testRunning" @click="testFilter"><Icon name="play" :size="14" />{{ testRunning ? '试跑中…' : '运行一次测试' }}</button><JsonBlock v-if="testResult" title="测试结果" :value="testResult" :open="true" /></div>
        </div>
        <template #actions><button class="btn outline" type="button" @click="editorStep === 1 ? editorOpen = false : previousEditorStep()">{{ editorStep === 1 ? '取消' : '上一步' }}</button><span class="spacer"></span><button v-if="editorStep < 3" class="btn primary" type="button" @click="nextEditorStep">下一步<Icon name="chevron-right" :size="14" /></button><button v-else class="btn primary" type="button" :disabled="saving" @click="saveFilter"><Icon name="save" :size="14" />保存规则</button></template>
      </SideDrawer>
    </div>
  `,
}
