import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue"
import { confirmAction, store, request, toast, refreshTab } from "../../app/store/store.js"
import { splitTokens, parseJsonText, toJson } from "../../shared/format.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { CUSTOM_BUILDER_STEPS, CUSTOM_FIELD_TYPES, applyCustomBuilder, customBuilderFromManifest, customCommandArguments, customTestDraft } from "./custom-builder.js"
import { ExtensionCreateDrawer } from "./extension-create-drawer.js"
import { ExtensionEditorDrawer } from "./extension-editor-drawer.js"
import { ExtensionLibraryPanel } from "./extension-library-panel.js"
import { ToolDetailModal } from "./tool-detail-modal.js"
import {
  BOOL_OFF_OPTIONS,
  BOOL_OPTIONS,
  MCP_RISK_OPTIONS,
  toolCommon,
  toolProvenance,
  toolSource,
} from "./shared.js"

interface ExtensionItem extends UnknownRecord {
  id: string
  name?: string
  displayNameZh?: string
  description?: string
  descriptionZh?: string
  enabled?: boolean
  validation?: { issues?: Array<{ level?: string }> }
  loadedTools?: unknown[]
  tools?: unknown[]
  resources?: UnknownRecord
  frameworkResources?: Array<{ alias?: string }>
}

interface ToolDetailItem extends UnknownRecord {
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

interface ExtensionEditorDraft {
  type: "custom" | "skill"
  mode: "create" | "edit"
  id: string
  name: string
  displayNameZh: string
  description: string
  descriptionZh: string
  category: string
  risk: string
  tags: string
  enabled: string
  source: string
  manifestJson: string
  manifestFile: string
  indexFile: string
  baseManifest: UnknownRecord
  runtimeConfigText: string
}

interface CustomTestState {
  tool: string
  args: string
  runtimeConfig: string
  result: unknown
  error: string
  running: boolean
}

interface BuilderDraft extends UnknownRecord {
  toolName: string
  toolDescription: string
  requiresFinalReply: string
  execution: string
  executionByAction: string
  resources: Array<{ alias?: string; reference?: string }>
  parameters: UnknownRecord[]
  runtimeFields: UnknownRecord[]
}

interface ExtensionResponse extends UnknownRecord {
  id?: string
  result?: ExtensionItem
  manifest?: UnknownRecord
  source?: string
  metadata?: UnknownRecord
  body?: string
  manifestFile?: string
  indexFile?: string
  runtimeConfig?: UnknownRecord
}
// 扩展管理（Custom / Skill）：列表、编辑抽屉和创建入口的状态与动作都在这里组合。
export const ExtensionPanel = {
  name: "ExtensionPanel",
  components: { ExtensionCreateDrawer, ExtensionEditorDrawer, ExtensionLibraryPanel, ToolDetailModal },
  setup() {
    const customCatalog = computed<ExtensionItem[]>(() => asRecords<ExtensionItem>(asRecord<{ custom?: { catalog?: ExtensionItem[] } }>(store.tools).custom?.catalog))
    const skillCatalog = computed<ExtensionItem[]>(() => asRecords<ExtensionItem>(asRecord<{ skills?: { catalog?: ExtensionItem[] } }>(store.tools).skills?.catalog))
    const showCreateDrawer = ref(false)
    const showEditor = ref(false)
    const showToolDetail = ref(false)
    const createMode = ref("")
    const remoteDraft = reactive({ repo: "", ref: "", subdir: "", skillId: "", overwrite: "false" })
    const libraryFilter = reactive({ query: "", type: "all", status: "all" })
    const toolDetail = reactive<ToolDetailItem>({
      name: "",
      common: {
        displayNameZh: "",
        description: "",
        descriptionZh: "",
        category: "",
        categoryLabel: "",
        risk: "",
        tags: [],
        parameters: {},
        policy: {},
        delivery: "silent",
        requiresFinalReply: true,
        configSchema: {},
        provenance: {},
      },
      runtimeConfig: {},
      modelDefinition: {},
      modelPrompt: "",
      modelPromptCharacters: 0,
      modelTokenEstimate: 0,
      modelPromptNote: "",
      enabled: false,
    })
    const editor = reactive<ExtensionEditorDraft>({
      type: "custom",
      mode: "edit",
      id: "",
      name: "",
      displayNameZh: "",
      description: "",
      descriptionZh: "",
      category: "custom",
      risk: "medium",
      tags: "",
      enabled: "true",
      source: "",
      manifestJson: "{}",
      manifestFile: "",
      indexFile: "",
      baseManifest: {},
      runtimeConfigText: "{}",
    })
    const customTest = reactive<CustomTestState>({ tool: "", args: "{}", runtimeConfig: "{}", result: null, error: "", running: false })
    const customBuilder = reactive<BuilderDraft>(asRecord<BuilderDraft>(customBuilderFromManifest()))
    const customTestToolOptions = computed(() => {
      if (editor.type === "custom" && customBuilder.toolName) return [{ value: customBuilder.toolName, label: customBuilder.toolName }]
      try {
        const manifest = asRecord(JSON.parse(editor.manifestJson || "{}"))
        return asRecords(asRecord(manifest).tools).filter(item => item.name).map(item => ({ value: String(item.name), label: String(item.displayNameZh || item.name) }))
      } catch {
        return []
      }
    })
    const customCommandPreview = computed(() => {
      const name = customTest.tool || customBuilder.toolName || "工具名"
      let args = ""
      try { args = customCommandArguments(JSON.parse(customTest.args || "{}")) } catch { /* 草稿尚未完成时保留无参示例。 */ }
      return `#yui测试工具 ${name}${args ? ` ${args}` : ""}`
    })
    const customParameterCommand = computed(() => `#yui工具参数 ${customTest.tool || customBuilder.toolName || "工具名"}`)

    const createModeMeta = computed(() => ({
      custom: { title: "新建单个工具", subtitle: "适合一个输入、一个结果的明确动作，例如查库存、生成链接或调用本地函数。", icon: "cpu", result: "创建 Custom 工具骨架，并立即进入名称、说明和源码编辑。" },
      skill: { title: "新建 Markdown Skill", subtitle: "按照 OpenAI 原生格式创建 SKILL.md，用自然语言定义可重复工作流。", icon: "sparkles", result: "创建包含 name、description 和 Markdown 指令的 SKILL.md，并立即进入编辑。" },
      remote: { title: "安装原生 Skill", subtitle: "从 Git 仓库导入包含 SKILL.md 的 OpenAI / Agent Skills 目录。", icon: "download", result: "复制完整 Skill 目录，并加载其中的 SKILL.md、scripts、references 和 assets。" },
    })[createMode.value as "custom" | "skill" | "remote"])
    const extensionLibraryRows = computed(() => [
      ...customCatalog.value.map(item => ({ ...item, extensionType: "custom" })),
      ...skillCatalog.value.map(item => ({ ...item, extensionType: "skill" })),
    ].filter(item => {
      if (libraryFilter.type !== "all" && item.extensionType !== libraryFilter.type) return false
      if (libraryFilter.status === "enabled" && !item.enabled) return false
      if (libraryFilter.status === "disabled" && item.enabled) return false
      if (libraryFilter.status === "issues" && !(item.validation?.issues || []).length) return false
      const query = libraryFilter.query.trim().toLowerCase()
      if (!query) return true
      return [item.id, item.name, item.displayNameZh, item.descriptionZh, item.description, packageToolSummary(item)].join(" ").toLowerCase().includes(query)
    }))
    const extensionLibraryTotal = computed(() => customCatalog.value.length + skillCatalog.value.length)
    const hasLibraryFilter = computed(() => Boolean(libraryFilter.query.trim()) || libraryFilter.type !== "all" || libraryFilter.status !== "all")
    const editorTitle = computed(() => `${editor.mode === "create" ? "新建" : "编辑"}${editor.type === "skill" ? " Skill" : " Custom"} 扩展`)
    const editorSubtitle = computed(() => editor.type === "skill"
      ? "编辑 OpenAI 原生 SKILL.md：description 决定何时触发，正文定义完整工作流。"
      : "适合直接在本插件里补一个本地工具。保存后即可启停、授权和调试。")
    async function act(fn: () => Promise<unknown>, message?: string) {
      try { await fn(); if (message) toast(message); await refreshTab("tools") } catch (err) { toast(errorMessage(err)) }
    }

    async function reloadExtensions() {
      try {
        await request("/api/tools/reload", { method: "POST", body: "{}" })
        await refreshTab("tools")
        toast("已重新扫描扩展目录")
      } catch (err) { toast(errorMessage(err)) }
    }

    function resetLibraryFilter() {
      libraryFilter.query = ""
      libraryFilter.type = "all"
      libraryFilter.status = "all"
    }

    function closeCreateDrawer() { createMode.value = ""; showCreateDrawer.value = false }

    function nextExtensionId(type: "custom" | "skill") {
      const used = new Set((type === "skill" ? skillCatalog.value : customCatalog.value).map(item => item.id))
      const base = type === "skill" ? "new-skill" : "new-tool"
      for (let index = 1; ; index += 1) { const id = index === 1 ? base : `${base}-${index}`; if (!used.has(id)) return id }
    }

    // 草稿模板：Skill 模板返回 metadata/body，这里对齐 getSkillPackage 的结构再进编辑器。
    function templateDraft(result: ExtensionResponse = {}, type: "custom" | "skill") {
      if (type !== "skill") return result
      const metadata = result.metadata || {}
      return {
        id: result.id || "",
        manifest: { ...metadata, id: result.id, descriptionZh: metadata.description || "", enabled: true },
        source: result.body || "",
      }
    }

    // 新建只取模板草稿，不落盘；目录会在“保存扩展”时按内容特征生成唯一 ID 后创建。
    async function openCreate(mode = "") {
      if (!mode) { createMode.value = ""; showCreateDrawer.value = true; return }
      if (mode === "skill" || mode === "custom") {
        const id = nextExtensionId(mode)
        try {
          const response = await request(mode === "skill" ? "/api/skills/template" : "/api/custom-tools/template", {
            method: "POST",
            body: JSON.stringify({ dryRun: true, ...(mode === "skill" ? { skillId: id } : { toolId: id }) }),
          })
          applyEditor(templateDraft(asRecord<ExtensionResponse>(response.result), mode), mode, "create")
          showCreateDrawer.value = false
        } catch (err) { toast(errorMessage(err)) }
        return
      }
      createMode.value = mode; showCreateDrawer.value = true
    }

    function applyEditor(result: ExtensionResponse, type: "custom" | "skill", mode: "create" | "edit" = "edit") {
      const manifest = asRecord(result.manifest)
      editor.type = type
      editor.mode = mode
      editor.id = String(result.id || manifest.id || "")
      editor.name = String(manifest.name || editor.id)
      editor.displayNameZh = String(manifest.displayNameZh || manifest.nameZh || "")
      editor.description = String(manifest.description || "")
      editor.descriptionZh = String(manifest.descriptionZh || "")
      editor.category = String(manifest.category || (type === "skill" ? "skill" : "custom"))
      editor.risk = String(manifest.risk || "medium")
      editor.tags = Array.isArray(manifest.tags) ? manifest.tags.map(String).join(", ") : String(manifest.tags || "")
      editor.enabled = String(manifest.enabled !== false)
      editor.source = String(result.source || "")
      editor.manifestJson = toJson(manifest || {})
      editor.manifestFile = String(result.manifestFile || "")
      editor.indexFile = String(result.indexFile || "")
      editor.baseManifest = JSON.parse(JSON.stringify(manifest || {}))
      editor.runtimeConfigText = toJson(result.runtimeConfig || {})
      if (type === "custom") Object.assign(customBuilder, customBuilderFromManifest(manifest, editor.id))
      customTest.tool = type === "custom" ? String(asRecords(manifest.tools).find(item => item.name)?.name || "") : ""
      const testDraft = customTestDraft(editor.source, customBuilder)
      customTest.args = toJson(testDraft.args)
      customTest.runtimeConfig = toJson(testDraft.runtimeConfig)
      customTest.result = null
      customTest.error = ""
      showEditor.value = true
    }

    async function openCustom(id: string, mode: "create" | "edit" = "edit") {
      const result = asRecord<ExtensionResponse>(await request(`/api/custom-tools/${encodeURIComponent(id)}`))
      applyEditor(asRecord<ExtensionResponse>(result.result), "custom", mode)
    }

    async function openSkill(id: string, mode: "create" | "edit" = "edit") {
      const result = asRecord<ExtensionResponse>(await request(`/api/skills/${encodeURIComponent(id)}`))
      applyEditor(asRecord<ExtensionResponse>(result.result), "skill", mode)
    }

    function openToolDetail(tool: ToolDetailItem = toolDetail) {
      const common = toolCommon(tool)
      Object.assign(toolDetail, JSON.parse(JSON.stringify({
        name: tool.name || "",
        common: {
          ...common,
          tags: Array.isArray(common.tags) ? [...common.tags] : [],
          policy: { ...asRecord(common.policy) },
          provenance: { ...toolProvenance(tool) },
        },
        runtimeConfig: tool.runtimeConfig || {},
        modelDefinition: tool.modelDefinition || {},
        modelPrompt: tool.modelPrompt || "",
        modelPromptCharacters: tool.modelPromptCharacters || 0,
        modelTokenEstimate: tool.modelTokenEstimate || 0,
        modelPromptNote: tool.modelPromptNote || "",
        enabled: Boolean(tool.enabled),
      })))
      showToolDetail.value = true
    }

    // 允许其它面板按工具名打开详情，Custom 编辑则直接进入编辑器。
    async function handleOpenToolDetail(event: Event) {
      const detail = (event as CustomEvent<{ name?: string; action?: string }>).detail || {}
      const name = String(detail.name || "")
      const action = String(detail.action || "view")
      const tool = asRecords<ToolDetailItem>(asRecord<{ tools?: ToolDetailItem[] }>(store.tools).tools).find(item => item.name === name)
      if (!tool) return
      const provenance = toolProvenance(tool)
      if (action === "edit" && toolSource(tool) === "custom" && provenance.packageId) {
        try {
          await openCustom(String(provenance.packageId))
        } catch (err) { toast(errorMessage(err, "打开 Custom 工具编辑器失败")) }
        return
      }
      openToolDetail(tool)
    }

    onMounted(() => {
      window.addEventListener("yui-chat:open-tool-detail", handleOpenToolDetail)
    })

    onBeforeUnmount(() => {
      window.removeEventListener("yui-chat:open-tool-detail", handleOpenToolDetail)
    })

    async function installRemoteSkill() {
      try {
        if (!remoteDraft.repo.trim()) throw new Error("请填写 Git 仓库地址或 owner/repo")
        if (remoteDraft.overwrite === "true") {
          const accepted = await confirmAction({ title: "覆盖同名 Markdown Skill？", message: "同名 Skill 目录及其中的本地修改会被远程仓库内容替换。", detail: remoteDraft.skillId.trim() || remoteDraft.repo.trim(), confirmText: "确认覆盖安装", tone: "warn", icon: "download" })
          if (!accepted) return
        }
        const result = asRecord<ExtensionResponse>(await request("/api/skills/install", {
          method: "POST",
          body: JSON.stringify({
            repo: remoteDraft.repo.trim(),
            ref: remoteDraft.ref.trim(),
            subdir: remoteDraft.subdir.trim(),
            skillId: remoteDraft.skillId.trim(),
            overwrite: remoteDraft.overwrite === "true",
          }),
        }))
        const id = result.result?.id
        toast(`已安装远程 Skill ${id}`)
        await refreshTab("tools")
        if (id) {
          showCreateDrawer.value = false
          await openSkill(id, "edit")
        }
      } catch (err) { toast(errorMessage(err)) }
    }

    async function toggleCustom(id: string, enabled: boolean) {
      if (!enabled) {
        const accepted = await confirmAction({ title: `停用 Custom 功能块“${id}”？`, message: "停用后，其中的工具不会再提供给模型调用。", confirmText: "确认停用", tone: "warn", icon: "power" })
        if (!accepted) return
      }
      return act(() => request(`/api/custom-tools/${encodeURIComponent(id)}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) }), `${enabled ? "已启用" : "已停用"} ${id}`)
    }

    async function toggleSkill(id: string, enabled: boolean) {
      if (!enabled) {
        const accepted = await confirmAction({ title: `停用 Markdown Skill“${id}”？`, message: "停用后，该工作流不会再参与本轮 Skill 匹配。", confirmText: "确认停用", tone: "warn", icon: "power" })
        if (!accepted) return
      }
      return act(() => request(`/api/skills/${encodeURIComponent(id)}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) }), `${enabled ? "已启用" : "已停用"} ${id}`)
    }

    async function requestRemove(type: "skill" | "custom", id: string) {
      const label = type === "skill" ? "Markdown Skill" : "Custom 功能块"
      const accepted = await confirmAction({
        title: `删除${label}“${id}”？`,
        message: "对应本地目录和定义会被永久删除，现有配置引用也可能失效。",
        detail: id,
        confirmText: "确认永久删除",
      })
      if (!accepted) return
      try {
        const path = type === "skill" ? "/api/skills/" : "/api/custom-tools/"
        await request(`${path}${encodeURIComponent(id)}`, { method: "DELETE" })
        toast(`已删除 ${label} ${id}`)
        await refreshTab("tools")
      } catch (err) { toast(errorMessage(err)) }
    }

    async function updateRemoteSkill(id: string) {
      const accepted = await confirmAction({ title: `更新远程 Skill“${id}”？`, message: "当前本地目录会被远程仓库版本替换，本地未提交的修改可能丢失。", confirmText: "确认更新", tone: "warn", icon: "download" })
      if (!accepted) return
      return act(() => request(`/api/skills/${encodeURIComponent(id)}/update-remote`, { method: "POST" }), `已更新远程 Skill ${id}`)
    }

    async function saveEditor() {
      try {
        const creating = editor.mode === "create"
        if (!creating && !editor.id.trim()) throw new Error("缺少扩展 ID")
        if (editor.type === "skill") {
          const name = String(editor.name || editor.id).trim().toLowerCase()
          if (skillCatalog.value.some(item => item.id !== editor.id && String(item.name || item.id).trim().toLowerCase() === name)) throw new Error(`Skill name “${editor.name}” 已存在`)
        }
        const manifest = editor.type === "skill"
          ? {
              ...editor.baseManifest,
              id: editor.id.trim(),
              name: editor.name.trim() || editor.id.trim(),
              description: editor.descriptionZh.trim() || editor.description.trim(),
              enabled: editor.enabled === "true",
            }
          : applyCustomBuilder(parseJsonText(editor.manifestJson || "{}", "高级 manifest JSON", {}), customBuilder)
        if (editor.type !== "skill") {
          manifest.id = editor.id.trim()
          manifest.name = editor.name.trim() || editor.id.trim()
          if (editor.displayNameZh.trim()) manifest.displayNameZh = editor.displayNameZh.trim()
          else delete manifest.displayNameZh
          if (editor.displayNameZh.trim()) manifest.nameZh = editor.displayNameZh.trim()
          else delete manifest.nameZh
          manifest.description = editor.description.trim()
          if (editor.descriptionZh.trim()) manifest.descriptionZh = editor.descriptionZh.trim()
          else delete manifest.descriptionZh
          manifest.category = editor.category.trim() || "custom"
          manifest.risk = editor.risk
          manifest.tags = splitTokens(editor.tags)
          manifest.enabled = editor.enabled === "true"
        }
        const base = editor.type === "skill" ? "/api/skills" : "/api/custom-tools"
        if (creating) {
          const response = asRecord<ExtensionResponse>(await request(base, { method: "POST", body: JSON.stringify({ manifest, source: editor.source }) }))
          editor.id = String(response.result?.id || editor.id)
          editor.mode = "edit"
        } else {
          await request(`${base}/${encodeURIComponent(editor.id)}`, { method: "PUT", body: JSON.stringify({ manifest, source: editor.source }) })
        }
        if (editor.type === "skill") {
          const value = parseJsonText(editor.runtimeConfigText || "{}", "Skill 运行变量", {})
          await request(`/api/skills/${encodeURIComponent(editor.id)}/runtime-config`, { method: "PUT", body: JSON.stringify({ value }) })
        }
        toast(`已${creating ? "新建" : "保存"}${editor.type === "skill" ? " Skill" : " Custom"} 扩展 ${editor.id}`)
        showEditor.value = false
        await refreshTab("tools")
      } catch (err) { toast(errorMessage(err)) }
    }

    async function testCustomTool() {
      customTest.running = true
      customTest.result = null
      customTest.error = ""
      try {
        if (editor.mode === "create") throw new Error("请先保存扩展，再运行真实测试")
        if (!customTest.tool) throw new Error("请选择要测试的工具")
        const args = parseJsonText(customTest.args || "{}", "测试参数", {})
        const runtimeConfig = parseJsonText(customTest.runtimeConfig || "{}", "测试运行变量", {})
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("测试参数必须是 JSON 对象")
        if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) throw new Error("测试运行变量必须是 JSON 对象")
        const accepted = await confirmAction({ title: `运行测试“${customTest.tool}”？`, message: "测试会真实执行已保存的工具代码；dryRun 只是上下文提示，是否产生外部操作取决于工具实现。", detail: customTest.args || "{}", confirmText: "确认运行测试", tone: "warn", icon: "play" })
        if (!accepted) return
        const response = asRecord<ExtensionResponse>(await request(`/api/custom-tools/${encodeURIComponent(editor.id)}/test`, {
          method: "POST",
          body: JSON.stringify({ tool: customTest.tool, args, runtimeConfig }),
        }))
        customTest.result = response.result
        toast(`测试完成：${customTest.tool}`)
      } catch (err) {
        customTest.error = errorMessage(err)
      } finally {
        customTest.running = false
      }
    }

    async function copyCustomCommand() {
      try {
        await navigator.clipboard.writeText(customCommandPreview.value)
        toast("测试指令已复制")
      } catch {
        toast("复制失败，请手动选择指令")
      }
    }

    function seedCustomTestDraft() {
      const draft = customTestDraft(editor.source, customBuilder)
      customTest.tool = customBuilder.toolName || customTest.tool
      customTest.args = toJson(draft.args)
      customTest.runtimeConfig = toJson(draft.runtimeConfig)
    }

    function packageToolSummary(item: ExtensionItem = { id: "" }) {
      const loaded = Array.isArray(item.loadedTools) ? item.loadedTools : []
      const hinted = Array.isArray(item.tools) ? item.tools : []
      const rows = loaded.length ? loaded : hinted
      if (!rows.length) return "未声明工具或尚未加载"
      return rows.map(tool => {
        const source = asRecord(tool)
        return String(toolCommon(source).displayNameZh || source.name || "")
      }).filter(Boolean).join("、")
    }

    // 列表行事件：按扩展类型分发到对应动作。
    function editLibraryItem(item: ExtensionItem & { extensionType?: string }) {
      return item.extensionType === "skill" ? openSkill(item.id) : openCustom(item.id)
    }
    function toggleLibraryItem(item: ExtensionItem & { extensionType?: string }) {
      return item.extensionType === "skill" ? toggleSkill(item.id, !item.enabled) : toggleCustom(item.id, !item.enabled)
    }
    return {
      customCatalog,
      skillCatalog,
      extensionLibraryRows,
      extensionLibraryTotal,
      hasLibraryFilter,
      createMode,
      createModeMeta,
      libraryFilter,
      remoteDraft,
      showCreateDrawer,
      showEditor,
      showToolDetail,
      editor,
      customTest,
      customTestToolOptions,
      customCommandPreview,
      customParameterCommand,
      customBuilder,
      customBuilderSteps: CUSTOM_BUILDER_STEPS,
      customFieldTypes: CUSTOM_FIELD_TYPES,
      toolDetail,
      editorTitle,
      editorSubtitle,
      openCreate,
      reloadExtensions,
      resetLibraryFilter,
      closeCreateDrawer,
      installRemoteSkill,
      updateRemoteSkill,
      openCustom,
      openSkill,
      openToolDetail,
      saveEditor,
      testCustomTool,
      copyCustomCommand,
      seedCustomTestDraft,
      editLibraryItem,
      toggleLibraryItem,
      requestRemove,
      BOOL_OPTIONS,
      BOOL_OFF_OPTIONS,
      MCP_RISK_OPTIONS,
    }
  },
  template: `
    <Panel title="扩展能力" icon="cpu">
      <template #actions>
        <button class="btn primary small" type="button" @click="openCreate()"><Icon name="plus" :size="14" />新增扩展</button>
        <button class="btn small outline" type="button" @click="openCreate('remote')"><Icon name="download" :size="14" />导入 Skill</button>
      </template>
      <ExtensionCreateDrawer
        :open="showCreateDrawer" :create-mode="createMode" :create-mode-meta="createModeMeta"
        :remote-draft="remoteDraft" :bool-off-options="BOOL_OFF_OPTIONS"
        @create="openCreate" @close="closeCreateDrawer" @install-remote="installRemoteSkill"
      />
      <ToolDetailModal :open="showToolDetail" :tool="toolDetail" @close="showToolDetail = false" />
      <ExtensionEditorDrawer
        :open="showEditor"
        :editor-title="editorTitle"
        :editor-subtitle="editorSubtitle"
        :editor="editor"
        :custom-builder="customBuilder"
        :custom-test="customTest"
        :builder-steps="customBuilderSteps"
        :field-types="customFieldTypes"
        :test-tool-options="customTestToolOptions"
        :command-preview="customCommandPreview"
        :parameter-command="customParameterCommand"
        :bool-options="BOOL_OPTIONS"
        :risk-options="MCP_RISK_OPTIONS"
        @close="showEditor = false"
        @save="saveEditor"
        @test="testCustomTool"
        @seed-test="seedCustomTestDraft"
        @copy-command="copyCustomCommand"
      />
      <ExtensionLibraryPanel
        :rows="extensionLibraryRows"
        :custom-count="customCatalog.length"
        :skill-count="skillCatalog.length"
        :total="extensionLibraryTotal"
        :filter="libraryFilter"
        :has-filter="hasLibraryFilter"
        @reload="reloadExtensions"
        @reset-filter="resetLibraryFilter"
        @open-create="openCreate()"
        @edit="editLibraryItem"
        @toggle="toggleLibraryItem"
        @update-remote="updateRemoteSkill($event.id)"
        @remove="requestRemove($event.extensionType, $event.id)"
      />
    </Panel>
  `,
}
