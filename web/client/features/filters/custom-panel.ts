import { computed, onMounted, reactive, ref, watch } from "vue"
import { confirmAction, request, store, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { parseJsonText, splitTokens, toJson } from "../../shared/format.js"
import {
  CUSTOM_FILTER_BUILDER_STEPS,
  CUSTOM_FILTER_FIELD_TYPES,
  applyCustomFilterBuilder,
  customFilterBuilderFromManifest,
  customFilterCodeExample,
  customFilterTestDraft,
} from "./custom-builder.js"
import { CustomFilterEditorDrawer } from "./custom-filter-editor-drawer.js"
import { CustomFilterLibraryPanel } from "./custom-filter-library-panel.js"

const BOOL_OPTIONS = [{ value: "true", label: "开启" }, { value: "false", label: "关闭" }]
const EFFECT_OPTIONS = [
  { value: "pure", label: "纯处理：只改写或拦截正文" },
  { value: "network", label: "网络：可能访问外部服务" },
  { value: "delivery", label: "发送：可能产生语音等输出记录" },
]
const STAGE_OPTIONS = [
  { value: "input", label: "输入：发送模型前" },
  { value: "output", label: "输出：回复发送前" },
  { value: "both", label: "输入和输出都可用" },
]

interface FilterDefinition extends UnknownRecord {
  id?: string
  displayName?: string
  displayNameZh?: string
  description?: string
  descriptionZh?: string
  stages?: string[]
  effects?: string[]
  parameters?: UnknownRecord
  configSchema?: UnknownRecord
}

interface CustomFilterItem extends UnknownRecord {
  id: string
  name?: string
  displayNameZh?: string
  description?: string
  descriptionZh?: string
  enabled?: boolean
  filters?: FilterDefinition[]
  frameworkResources?: Record<string, unknown>
}

interface CustomImplementation extends FilterDefinition {
  id: string
  source?: string
}

interface FilterManifest extends UnknownRecord {
  id?: string
  name?: string
  nameZh?: string
  displayNameZh?: string
  description?: string
  descriptionZh?: string
  enabled?: boolean
  tags?: string[]
  filters?: FilterDefinition[]
  frameworkResources?: Record<string, unknown>
}

interface FilterDetails extends UnknownRecord {
  id?: string
  manifest?: FilterManifest
  source?: string
  manifestFile?: string
  indexFile?: string
  runtimeConfig?: Record<string, UnknownRecord>
}

interface CustomFiltersResponse extends UnknownRecord {
  result?: FilterDetails
  custom?: { catalog?: CustomFilterItem[]; [key: string]: unknown }
  catalog?: CustomFilterItem[]
  implementations?: CustomImplementation[]
}

interface ResourceEntry extends UnknownRecord {
  name?: string
  path: string
  reference: string
  kind?: string
}

interface ResourceFolderResponse extends UnknownRecord {
  path?: string
  parent?: string
  entries?: ResourceEntry[]
  truncated?: boolean
}

interface ResourceReference {
  alias: string
  reference: string
}

interface BuilderRow extends UnknownRecord {
  name: string
  type?: string
  description?: string
  required?: string
  secret?: string
  defaultValue?: unknown
}

interface CustomBuilderDraft extends UnknownRecord {
  step: string
  filterId: string
  displayName: string
  description: string
  stage: string
  effect: string
  resources: ResourceReference[]
  parameters: BuilderRow[]
  runtimeFields: BuilderRow[]
}

interface CustomEditor extends UnknownRecord {
  mode: "edit" | "create"
  id: string
  name: string
  displayNameZh: string
  description: string
  descriptionZh: string
  tags: string
  enabled: string
  source: string
  manifestJson: string
  manifestFile: string
  indexFile: string
  baseManifest: FilterManifest
  runtimeConfigText: string
}

interface TestState {
  text: string
  params: string
  runtimeConfig: string
  result: unknown
  error: string
  running: boolean
}

interface ResourceBrowserState {
  open: boolean
  loading: boolean
  error: string
  path: string
  parent: string
  entries: ResourceEntry[]
  targetIndex: number
  truncated: boolean
}

interface AiDraft {
  manifest?: FilterManifest
  source?: string
  [key: string]: unknown
}

interface AiState {
  requirement: string
  running: boolean
  error: string
  draft: AiDraft | null
}

interface CreateIntent {
  nonce?: number
  stage?: string
  view?: string
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value || {})) as T
}

function effectText(effects: string[] = []): string {
  if (effects.includes("delivery")) return "可能产生发送类副作用"
  if (effects.includes("network")) return "可能访问外部服务"
  return "纯代码处理"
}

function stageText(stages: string[] = []): string {
  if (stages.includes("input") && stages.includes("output")) return "输入和输出"
  return stages.includes("input") ? "输入" : "输出"
}

export const CustomFiltersPanel = {
  name: "CustomFiltersPanel",
  components: { CustomFilterEditorDrawer, CustomFilterLibraryPanel },
  props: {
    createIntent: { type: Object, default: null },
  },
  setup(props: { createIntent?: CreateIntent | null }) {
    const catalog = ref<CustomFilterItem[]>([])
    const implementations = ref<CustomImplementation[]>([])
    const loading = ref(false)
    const apiError = ref("")
    const showEditor = ref(false)
    const editor = reactive<CustomEditor>({
      mode: "edit",
      id: "",
      name: "",
      displayNameZh: "",
      description: "",
      descriptionZh: "",
      tags: "",
      enabled: "true",
      source: "",
      manifestJson: "{}",
      manifestFile: "",
      indexFile: "",
      baseManifest: {},
      runtimeConfigText: "{}",
    })
    const builder = reactive(customFilterBuilderFromManifest() as CustomBuilderDraft)
    const test = reactive<TestState>({ text: "这是一段用于测试的消息 123。", params: "{}", runtimeConfig: "{}", result: null, error: "", running: false })
    const resourceBrowser = reactive<ResourceBrowserState>({ open: false, loading: false, error: "", path: "plugins", parent: "", entries: [], targetIndex: -1, truncated: false })
    const ai = reactive<AiState>({ requirement: "", running: false, error: "", draft: null })
    const editorTitle = computed(() => `${editor.mode === "create" ? "新建" : "编辑"} Custom 代码过滤器`)
    const editorSubtitle = computed(() => "代码过滤器不会交给模型调用；它在固定阶段接收正文并返回处理结果。")
    const builtinImplementations = computed(() => implementations.value.filter(item => item.source === "builtin"))
    const customFilterCount = computed(() => implementations.value.filter(item => item.source === "custom").length)
    const effectsNeedConfirmation = computed(() => builder.effect === "network" || builder.effect === "delivery")

    function nextPackageId() {
      const used = new Set(catalog.value.map(item => item.id))
      for (let index = 1; ; index += 1) {
        const id = index === 1 ? "new-filter" : `new-filter-${index}`
        if (!used.has(id)) return id
      }
    }

    async function load({ quiet = false } = {}) {
      loading.value = true
      apiError.value = ""
      try {
        const result = await request("/api/custom-filters") as CustomFiltersResponse
        catalog.value = result.custom?.catalog || result.catalog || []
        implementations.value = result.implementations || []
        store.filters = {
          ...asRecord(store.filters),
          custom: result.custom || { catalog: catalog.value },
          customImplementations: implementations.value,
        }
      } catch (err) {
        apiError.value = errorMessage(err, "暂时无法读取 Custom Filter")
        if (!quiet) toast(apiError.value)
      } finally {
        loading.value = false
      }
    }

    function applyEditor(result: FilterDetails = {}, mode: "edit" | "create" = "edit"): void {
      const manifest = result.manifest || {}
      editor.mode = mode
      editor.id = result.id || manifest.id || ""
      editor.name = manifest.name || editor.id
      editor.displayNameZh = manifest.displayNameZh || manifest.nameZh || ""
      editor.description = manifest.description || ""
      editor.descriptionZh = manifest.descriptionZh || ""
      editor.tags = (manifest.tags || []).join(", ")
      editor.enabled = String(manifest.enabled !== false)
      editor.source = result.source || ""
      editor.manifestJson = toJson(manifest)
      editor.manifestFile = result.manifestFile || ""
      editor.indexFile = result.indexFile || ""
      editor.baseManifest = clone(manifest)
      const filterId = manifest.filters?.[0]?.id || ""
      const savedRuntimeConfig = (filterId ? result.runtimeConfig?.[filterId] : undefined) || {}
      editor.runtimeConfigText = toJson(savedRuntimeConfig)
      Object.assign(builder, customFilterBuilderFromManifest(manifest, editor.id))
      test.result = null
      test.error = ""
      resourceBrowser.open = false
      ai.error = ""
      ai.draft = null
      seedTestDraft()
      if (Object.keys(savedRuntimeConfig).length) test.runtimeConfig = toJson(savedRuntimeConfig)
      showEditor.value = true
    }

    async function openFilter(id: string, mode: "edit" | "create" = "edit"): Promise<void> {
      try {
        const result = await request(`/api/custom-filters/${encodeURIComponent(id)}`) as CustomFiltersResponse
        applyEditor(result.result || asRecord(result) as FilterDetails, mode)
      } catch (err) {
        toast(errorMessage(err, "打开 Custom Filter 失败"))
      }
    }

    async function createFilter(stage = "output", view = "create") {
      const id = nextPackageId()
      try {
        const result = await request("/api/custom-filters/template", {
          method: "POST",
          body: JSON.stringify({ filterId: id }),
        })
        const template = result as CustomFiltersResponse
        await openFilter(template.result?.id || id, "create")
        builder.stage = ["input", "output", "both"].includes(stage) ? stage : "output"
        builder.displayName = builder.stage === "input" ? "我的输入过滤器" : "我的输出过滤器"
        builder.description = builder.stage === "input" ? "在消息发送给模型前处理正文。" : "在回复发送前处理正文。"
        useCodeExample()
        builder.step = view === "resources" ? "resources" : (view === "code" ? "code" : "create")
      } catch (err) {
        toast(errorMessage(err, "创建 Custom Filter 模板失败"))
      }
    }

    function useCodeExample() {
      editor.source = customFilterCodeExample(builder)
      toast("已填入 createFilters 代码示例")
    }

    function folderFromReference(reference = "") {
      const raw = String(reference || "").trim().replace(/\\/g, "/")
      let projectPath = ""
      const pluginMatch = raw.match(/^plugin:([^/]+)\/(.+)$/)
      if (pluginMatch) projectPath = `plugins/${pluginMatch[1]}/${pluginMatch[2]}`
      else if (raw.startsWith("yunzai:")) projectPath = raw.slice("yunzai:".length)
      if (!projectPath) return "plugins"
      const index = projectPath.lastIndexOf("/")
      return index > 0 ? projectPath.slice(0, index) : ""
    }

    async function loadResourceFolder(projectPath = "") {
      resourceBrowser.loading = true
      resourceBrowser.error = ""
      try {
        const result = await request(`/api/extension-authoring/resources?path=${encodeURIComponent(projectPath)}`)
        const value = (asRecord(result.result) as ResourceFolderResponse) || result as ResourceFolderResponse
        resourceBrowser.path = value.path || ""
        resourceBrowser.parent = value.parent || ""
        resourceBrowser.entries = value.entries || []
        resourceBrowser.truncated = Boolean(value.truncated)
      } catch (err) {
        resourceBrowser.error = errorMessage(err, "无法读取项目文件夹")
      } finally {
        resourceBrowser.loading = false
      }
    }

    async function openResourceBrowser(index = -1) {
      resourceBrowser.targetIndex = index
      resourceBrowser.open = true
      const reference = index >= 0 ? builder.resources[index]?.reference : ""
      await loadResourceFolder(folderFromReference(reference))
    }

    async function selectResourceEntry(item: ResourceEntry): Promise<unknown> {
      if (item.kind === "directory") return loadResourceFolder(item.path)
      let index = resourceBrowser.targetIndex
      if (index < 0 || !builder.resources[index]) {
        builder.resources.push({ alias: "", reference: "" })
        index = builder.resources.length - 1
      }
      const row = builder.resources[index]
      row.reference = item.reference
      if (!row.alias.trim()) {
        const base = String(item.name || "resource").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
        const used = new Set(builder.resources.filter((_value, current) => current !== index).map(value => value.alias))
        let alias = base || "resource"
        let suffix = 2
        while (used.has(alias)) alias = `${base || "resource"}-${suffix++}`
        row.alias = alias
      }
      resourceBrowser.open = false
      toast(`已引用 ${item.reference}`)
    }

    async function generateWithProjectAi() {
      ai.error = ""
      ai.draft = null
      let manifest
      try {
        manifest = buildManifest()
      } catch (err) {
        ai.error = errorMessage(err)
        return
      }
      if (!ai.requirement.trim()) {
        ai.error = "请先描述希望 AI 编写的处理逻辑"
        return
      }
      const resourceCount = Object.keys(manifest.frameworkResources || {}).length
      if (resourceCount) {
        const accepted = await confirmAction({
          title: "把已选框架资源交给项目 AI？",
          message: `系统会读取 ${resourceCount} 个已声明文件的源码并发送给当前项目模型，用于生成代码草稿。运行配置、数据目录和常见密钥文件不会读取。`,
          confirmText: "生成代码草稿",
          tone: "warn",
          icon: "sparkles",
        })
        if (!accepted) return
      }
      ai.running = true
      try {
        const result = await request("/api/extension-authoring/filter-draft", {
          method: "POST",
          body: JSON.stringify({
            requirement: ai.requirement,
            manifest,
            source: editor.source,
          }),
        })
        const response = result as CustomFiltersResponse
        ai.draft = asRecord(response.result || response) as AiDraft
        toast("项目 AI 草稿已生成，请检查后应用")
      } catch (err) {
        ai.error = errorMessage(err, "项目 AI 生成失败")
        toast(ai.error)
      } finally {
        ai.running = false
      }
    }

    function applyAiDraft() {
      const draft = ai.draft
      if (!draft?.manifest || !draft?.source) return
      const manifest = draft.manifest
      editor.name = manifest.name || editor.name
      editor.displayNameZh = manifest.displayNameZh || manifest.nameZh || editor.displayNameZh
      editor.description = manifest.description || ""
      editor.descriptionZh = manifest.descriptionZh || ""
      editor.tags = (manifest.tags || []).join(", ")
      editor.manifestJson = toJson(manifest)
      editor.source = draft.source
      const nextBuilder = customFilterBuilderFromManifest(manifest, editor.id)
      nextBuilder.step = "code"
      Object.assign(builder, nextBuilder)
      seedTestDraft()
      ai.draft = null
      toast("AI 草稿已应用到编辑器，保存前仍可继续修改")
    }

    function seedTestDraft() {
      const draft = customFilterTestDraft(editor.source, builder)
      test.params = toJson(draft.params)
      test.runtimeConfig = toJson(draft.runtimeConfig)
    }

    function buildManifest() {
      if (!editor.id.trim()) throw new Error("缺少扩展 ID")
      if (!builder.filterId.trim()) throw new Error("请填写过滤器 ID")
      const manifest = applyCustomFilterBuilder(parseJsonText(editor.manifestJson || "{}", "高级 manifest JSON", {}), builder)
      manifest.id = editor.id.trim()
      manifest.name = editor.name.trim() || editor.id.trim()
      manifest.enabled = editor.enabled === "true"
      manifest.description = editor.description.trim()
      if (editor.displayNameZh.trim()) {
        manifest.displayNameZh = editor.displayNameZh.trim()
        manifest.nameZh = editor.displayNameZh.trim()
      } else {
        delete manifest.displayNameZh
        delete manifest.nameZh
      }
      if (editor.descriptionZh.trim()) manifest.descriptionZh = editor.descriptionZh.trim()
      else delete manifest.descriptionZh
      manifest.tags = splitTokens(editor.tags)
      return manifest
    }

    async function saveEditor() {
      try {
        const manifest = buildManifest()
        const result = await request(`/api/custom-filters/${encodeURIComponent(editor.id)}`, {
          method: "PUT",
          body: JSON.stringify({ manifest, source: editor.source }),
        })
        const response = result as CustomFiltersResponse
        editor.manifestJson = toJson(response.result?.manifest || manifest)
        toast("Custom Filter 已保存并重新加载")
        await load({ quiet: true })
      } catch (err) {
        toast(errorMessage(err, "保存 Custom Filter 失败"))
      }
    }

    async function saveRuntimeConfig() {
      try {
        const value = parseJsonText(test.runtimeConfig || "{}", "测试运行变量 JSON", {})
        await request(`/api/custom-filters/${encodeURIComponent(editor.id)}/runtime-config`, {
          method: "PUT",
          body: JSON.stringify({ filter: builder.filterId, value }),
        })
        editor.runtimeConfigText = toJson(value)
        toast("过滤器运行变量已保存")
      } catch (err) {
        toast(errorMessage(err, "保存运行变量失败"))
      }
    }

    async function confirmTestEffects() {
      if (!effectsNeedConfirmation.value) return true
      return confirmAction({
        title: "这次试跑可能产生真实副作用",
        message: builder.effect === "delivery"
          ? "该过滤器可能生成语音或其他发送记录。试跑不会自动形成安全沙箱。"
          : "该过滤器可能访问外部网络。试跑不会自动形成安全沙箱。",
        confirmText: "继续真实试跑",
        tone: "warn",
        icon: "alert",
      })
    }

    async function testFilter() {
      if (!editor.id) return toast("请先创建并保存代码过滤器")
      if (!await confirmTestEffects()) return
      test.running = true
      test.error = ""
      test.result = null
      try {
        const params = parseJsonText(test.params || "{}", "测试参数 JSON", {})
        const runtimeConfig = parseJsonText(test.runtimeConfig || "{}", "测试运行变量 JSON", {})
        const result = await request(`/api/custom-filters/${encodeURIComponent(editor.id)}/test`, {
          method: "POST",
          body: JSON.stringify({
            filter: builder.filterId,
            text: test.text,
            params,
            runtimeConfig,
            stage: builder.stage === "input" ? "input" : "output",
          }),
        })
        test.result = result.result || result
        toast("代码过滤器测试已完成")
      } catch (err) {
        test.error = errorMessage(err, "测试失败")
        toast(test.error)
      } finally {
        test.running = false
      }
    }

    async function toggleFilter(item: CustomFilterItem, enabled: boolean): Promise<void> {
      if (!enabled) {
        const accepted = await confirmAction({
          title: `停用 Custom Filter“${item.id}”？`,
          message: "停用后，它不会再作为过滤器实现运行；已有规则会保留，直到重新启用或替换。",
          confirmText: "确认停用",
          tone: "warn",
          icon: "power",
        })
        if (!accepted) return
      }
      try {
        await request(`/api/custom-filters/${encodeURIComponent(item.id)}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) })
        toast(`${enabled ? "已启用" : "已停用"} ${item.id}`)
        await load({ quiet: true })
      } catch (err) {
        toast(errorMessage(err, "更新启用状态失败"))
      }
    }

    async function removeFilter(item: CustomFilterItem): Promise<void> {
      const accepted = await confirmAction({
        title: `删除 Custom Filter“${item.id}”？`,
        message: "对应本地代码和定义会被永久删除；如果仍被规则引用，系统会阻止删除并列出引用。",
        detail: item.id,
        confirmText: "确认永久删除",
      })
      if (!accepted) return
      try {
        await request(`/api/custom-filters/${encodeURIComponent(item.id)}`, { method: "DELETE" })
        toast(`已删除 Custom Filter ${item.id}`)
        await load({ quiet: true })
      } catch (err) {
        toast(errorMessage(err, "删除 Custom Filter 失败"))
      }
    }

    watch(() => props.createIntent?.nonce, nonce => {
      if (nonce) createFilter(props.createIntent?.stage || "output", props.createIntent?.view || "code")
    })
    onMounted(() => load({ quiet: true }))

    return {
      catalog,
      implementations,
      builtinImplementations,
      loading,
      apiError,
      showEditor,
      editor,
      builder,
      test,
      resourceBrowser,
      ai,
      editorTitle,
      editorSubtitle,
      customFilterCount,
      effectsNeedConfirmation,
      customFilterBuilderSteps: CUSTOM_FILTER_BUILDER_STEPS,
      customFilterFieldTypes: CUSTOM_FILTER_FIELD_TYPES,
      boolOptions: BOOL_OPTIONS,
      stageOptions: STAGE_OPTIONS,
      effectOptions: EFFECT_OPTIONS,
      effectText,
      stageText,
      createFilter,
      openFilter,
      useCodeExample,
      openResourceBrowser,
      loadResourceFolder,
      selectResourceEntry,
      generateWithProjectAi,
      applyAiDraft,
      seedTestDraft,
      saveEditor,
      saveRuntimeConfig,
      testFilter,
      toggleFilter,
      removeFilter,
      load,
    }
  },
  template: `
    <div class="settings-stack">
      <CustomFilterLibraryPanel
        :loading="loading"
        :api-error="apiError"
        :builtin-implementations="builtinImplementations"
        :catalog="catalog"
        :custom-filter-count="customFilterCount"
        :effect-text="effectText"
        :stage-text="stageText"
        @retry="load"
        @create-filter="createFilter"
        @open-filter="openFilter"
        @toggle-filter="toggleFilter"
        @remove-filter="removeFilter"
      />
      <CustomFilterEditorDrawer
        :open="showEditor"
        :title="editorTitle"
        :subtitle="editorSubtitle"
        :editor="editor"
        :builder="builder"
        :test="test"
        :resource-browser="resourceBrowser"
        :ai="ai"
        :builder-steps="customFilterBuilderSteps"
        :field-types="customFilterFieldTypes"
        :bool-options="boolOptions"
        :stage-options="stageOptions"
        :effect-options="effectOptions"
        :effect-text="effectText"
        @close="showEditor = false"
        @save="saveEditor"
        @open-resource-browser="openResourceBrowser"
        @load-resource-folder="loadResourceFolder"
        @select-resource-entry="selectResourceEntry"
        @generate-ai="generateWithProjectAi"
        @apply-ai="applyAiDraft"
        @use-code-example="useCodeExample"
        @seed-test-draft="seedTestDraft"
        @save-runtime-config="saveRuntimeConfig"
        @test-filter="testFilter"
      />
    </div>
  `,
}
