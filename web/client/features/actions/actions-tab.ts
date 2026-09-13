import { InvocationGuide } from "./invocation-guide.js"
import { actionEditorIssues } from "./validation.js"
import { FrameworkResourcePicker } from "../../ui/framework-resource-picker.js"
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue"
import { store, request, refreshSlices, toast, confirmAction, setDirtyScope, setTab } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage } from "../../shared/data.js"
import type { UnknownRecord } from "../../shared/data.js"
import { actionParameterFields, parameterLabel, parameterInputValue, parseParameterInput, updateParameterValue } from "./parameter-fields.js"

interface Action extends UnknownRecord {
  kind: string; source: { frameworkResources: {target: string}; exportName: string; method: string; callStyle: string; risk: string; useInputAsMessage: boolean } | null;
  reply: {mode: string; path: string; template: string};
  id: string; name: string; description: string; categoryId: string; tags: string[]; enabled: boolean; command: string; aliases: string[];
  stage: string; priority: number; minRole: string; scope: string; tool: string; defaults: UnknownRecord;
  textParam: string; textTemplate: string; overridable: string[]; version?: string; fullCommand?: string;
  input: { mode: string; images: string; imageParam: string; requireImage: boolean };
}
const split = (text: string) => [...new Set(text.split(/[\n,，、]/).map(item => item.trim()).filter(Boolean))]
const parseObject = (text: string): UnknownRecord => {
  const value: unknown = JSON.parse(text || "{}")
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("默认参数必须是 JSON 对象")
  return value as UnknownRecord
}
const json = (value: unknown) => JSON.stringify(value, null, 2)
function blank(): Action {
  return { kind: "tool", source: null, reply: {mode:"auto",path:"",template:""}, id: "draft", name: "", description: "", categoryId: "", tags: [], enabled: true, command: "", aliases: [], stage: "rule", priority: 1137, minRole: "user", scope: "all", tool: "", defaults: {}, textParam: "", textTemplate: "",
    overridable: [], input: { mode: "text", images: "none", imageParam: "referenceImages", requireImage: false } }
}

export const ActionsTab = {
  name: "ActionsTab",
  components: { FrameworkResourcePicker, InvocationGuide },
  setup() {
    const query = ref("")
    const category = ref("all")
    const stateFilter = ref("all")
    const roleFilter = ref("all")
    const data = computed(() => asRecord(store.actions))
    const items = computed(() => asRecords<Action>(data.value.items))
    const categories = computed(() => asRecords(data.value.categories))
    const tools = computed(() => asRecords(data.value.tools))
    const roles = computed(() => asRecords(data.value.roles))
    const runtime = computed(() => asRecord(data.value.runtime))
    const enabledCount = computed(() => items.value.filter(item => item.enabled).length)
    const categoryName = (id: unknown) => String(categories.value.find(item => item.id === id)?.name || "未分类")
    const toolName = (name: unknown) => String(tools.value.find(item => item.name === name)?.label || name)
    const roleName = (name: unknown) => String(roles.value.find(item => item.value === name)?.label || name)
    const unavailable = (item: Action) => item.enabled && (asRecord(asRecord(item.access).master).allowed === false || (Array.isArray(item.setupIssues) && item.setupIssues.length > 0))
    const availabilityHint = (item: Action) => [asRecord(asRecord(item.access).master).reason, ...(Array.isArray(item.setupIssues) ? item.setupIssues : [])].filter(Boolean).join("；")
    const filtered = computed(() => items.value.filter(item => {
      const search = [item.name, item.description, item.command, ...item.aliases, ...item.tags, toolName(item.tool), categoryName(item.categoryId)].join(" ").toLowerCase()
      return (!query.value || search.includes(query.value.toLowerCase())) && (category.value === "all" || item.categoryId === category.value)
        && (stateFilter.value === "all" || (stateFilter.value === "enabled" ? item.enabled : stateFilter.value === "disabled" ? !item.enabled : unavailable(item)))
        && (roleFilter.value === "all" || item.minRole === roleFilter.value)
    }))
    const editorStep = ref(0)
    const editorSteps = [
      { label: "指令", icon: "plus", title: "先定义如何触发", hint: "填写名称、指令与使用范围。示例默认停用，可先保存再检查。" },
      { label: "执行方式", icon: "code", title: "选择要复用的能力", hint: "选择现成工具，或指定项目文件中的函数；复制动作会继续共享同一份实现。" },
      { label: "配置参数", icon: "sliders", title: "填好常用参数", hint: "设置默认要求、图片来源和其他参数。这些值只用于当前动作。" },
      { label: "回复", icon: "message", title: "决定结果如何回复", hint: "可直接回复，也可以从 JSON 中提取字段。粘贴样例即可预览。" },
      { label: "测试", icon: "play", title: "先预览，再按需运行", hint: "预览不执行工具。真实测试需要先保存并启用动作。" },
    ]
    const showIssues = ref(false)
    function stepIssue(step: number): string { return validationIssues.value.find(issue=>issue.step===step)?.message || "" }
    function nextStep() {
      showIssues.value = true
      editorError.value = ""
      if (!stepIssue(editorStep.value)) editorStep.value = Math.min(editorStep.value + 1, editorSteps.length - 1)
    }
    function validateEditor() {
      showIssues.value = true
      const issue = validationIssues.value[0]
      if (issue) { editorStep.value = issue.step; editorError.value = ""; return false }
      return true
    }
    function goStep(step: number) { editorStep.value = step; editorError.value = "" }
    const opened = ref(false)
    const editingId = ref("")
    const draft = reactive<Action>(blank())
    const aliasesText = ref("")
    const tagsText = ref("")
    const overrideText = ref("")
    const defaultsText = ref("{}")
    const parameterDrafts = reactive<Record<string, string | number>>({})
    const parameterErrors = reactive<Record<string, string>>({})
    function clearParameterDrafts() {
      for (const key of Object.keys(parameterDrafts)) delete parameterDrafts[key]
      for (const key of Object.keys(parameterErrors)) delete parameterErrors[key]
    }
    function setDefaultsText(value: string) { defaultsText.value = value; clearParameterDrafts() }
    const baseline = ref("")
    const saving = ref(false)
    const busy = ref("")
    const editorError = ref("")
    const preview = ref<UnknownRecord | null>(null)
    const result = ref<UnknownRecord | null>(null)
    const testText = ref("")
    const previewRole = ref("user")
    const previewScope = ref("group")
    const imageCount = ref(0)
    const imageUrls = ref("")
    const testing = ref(false)
    const taskId = ref("")
    let editorGeneration = 0
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const snapshot = () => json({ draft, aliasesText: aliasesText.value, tagsText: tagsText.value, overrideText: overrideText.value, defaultsText: defaultsText.value, parameterDrafts })
    const dirty = computed(() => opened.value && snapshot() !== baseline.value)
    watch(dirty, value => setDirtyScope("actions-editor", value))
    const resourceOpen = ref(false)
    const sampleText = ref('{"data":{"text":"查询成功","image":"https://example.com/photo.png"}}')
    const replyPreview = ref<UnknownRecord | null>(null)
    const replyFields = ref<string[]>([])
    const replyError = ref("")
    const replyBusy = ref(false)
    function chooseKind(kind: string) {
      draft.kind = kind
      if (kind === "source") {
        draft.source ||= { frameworkResources: {target:""}, exportName:"default", method:"", callStyle:"function", risk:"medium", useInputAsMessage:false }
        draft.textParam ||= "text"
      }
    }
    function chooseResource(item: UnknownRecord) {
      chooseKind("source")
      draft.source!.frameworkResources.target = String(item.reference || "")
      if (item.type !== "module") draft.source!.callStyle = "resource"
      resourceOpen.value = false
    }
    async function previewReply() {
      replyBusy.value = true; replyError.value = ""
      const generation = editorGeneration
      let sample: unknown = sampleText.value
      try { sample = JSON.parse(sampleText.value) } catch { /* 允许直接粘贴纯文本。 */ }
      try {
        const response = await request("/api/actions/reply-preview", { method:"POST", body:JSON.stringify({action:{...payload(),name:draft.name || "回复预览",command:draft.command || "回复预览",tool:draft.tool || "preview"},sample}) })
        if (generation !== editorGeneration) return
        replyPreview.value = asRecord(response.preview); replyFields.value = Array.isArray(response.fields) ? response.fields.map(String) : []
      } catch(error) { if (generation === editorGeneration) replyError.value = errorMessage(error) }
      finally { if (generation === editorGeneration) replyBusy.value = false }
    }
    function chooseReplyField(path: string) { draft.reply.path = path; void previewReply() }
    const replyModes = [ {value:"auto",label:"自动回复（推荐）"}, {value:"text",label:"纯文本 / 提取字段"}, {value:"json",label:"格式化 JSON"}, {value:"image",label:"发送图片"}, {value:"message",label:"按消息体发送"}, {value:"silent",label:"由执行方法自行回复"} ]
    const replyHint = computed(() => ({auto:"文本直接回复，图片地址作为图片，普通链接保留为链接。",text:"只取需要的字段，也可以给回复加上一句说明。",json:"将结果整理成易读的 JSON 文本。",image:"支持图片地址、图片数组或标准图片消息段。",message:"支持 parts、chain 或消息段数组，经 message_send 发送到当前会话。",silent:"不追加回复，适合源码方法已经调用 reply 的情况。"}[draft.reply.mode] || ""))
    const executionLabel = (item: Action) => item.kind === "source" ? "项目源码" : toolName(item.tool)
    const selectedTool = computed(() => tools.value.find(tool => tool.name === draft.tool))
    const validationIssues = computed(() => [
      ...actionEditorIssues(draft, defaultsText.value, selectedTool.value?.parameters, split(aliasesText.value), split(overrideText.value)),
      ...Object.entries(parameterErrors).map(([key,message])=>({step:2,message:key+'：'+message})),
    ])
    const setupIssues = computed(() => draft.kind === "tool" && Array.isArray(selectedTool.value?.setupIssues) ? selectedTool.value.setupIssues : [])
    const properties = computed<UnknownRecord>(() => {
      if (draft.kind !== "source") return asRecord(asRecord(selectedTool.value?.parameters).properties)
      let args: UnknownRecord = {}
      try { args = parseObject(defaultsText.value) } catch { /* 编辑中的 JSON 允许暂时不完整。 */ }
      return { text:{type:"string"}, ...(draft.input.images !== "none" ? {referenceImages:{type:"array"}} : {}), ...Object.fromEntries(Object.entries(args).map(([key,value]) => [key,{type:Array.isArray(value)?"array":value === null ? "null" : typeof value}])) }
    })
    const parameterOptions = computed(() => [{ value: "", label: "不绑定文字" }, ...Object.keys(properties.value).filter(key => asRecord(properties.value[key]).type === "string").map(key => ({ value: key, label: `${parameterLabel(key, properties.value[key])} · ${key}` }))])
    const imageOptions = computed(() => Object.keys(properties.value).filter(key => asRecord(properties.value[key]).type === "array").map(key => ({ value: key, label: key })))
    const schemaFields = computed(() => actionParameterFields({ ...asRecord(selectedTool.value?.parameters), properties: properties.value }, [draft.textParam, ...(draft.input.images === "none" ? [] : [draft.input.imageParam])], draft.kind === "tool" ? draft.tool : ""))
    const textField = computed(() => actionParameterFields({ ...asRecord(selectedTool.value?.parameters), properties: properties.value }, [], draft.kind === "tool" ? draft.tool : "").find(field => field.key === draft.textParam))
    const paramValue = (key: string) => {
      if (Object.hasOwn(parameterDrafts, key)) return parameterDrafts[key]
      try { return parameterInputValue(properties.value[key], parseObject(defaultsText.value)[key]) } catch { return "" }
    }
    function setParam(key: string, value: unknown) {
      parameterDrafts[key] = typeof value === "number" ? value : String(value)
      try {
        const args = parseObject(defaultsText.value)
        defaultsText.value = json(updateParameterValue(args, key, parseParameterInput(properties.value[key], value)))
        delete parameterErrors[key]; delete parameterDrafts[key]
      } catch (error) { parameterErrors[key] = errorMessage(error) }
    }
    function payload(): Action {
      if (Object.keys(parameterErrors).length) throw new Error("请先修正标红的参数，再保存或预览。")
      return { ...draft, aliases: split(aliasesText.value), tags: split(tagsText.value), overridable: split(overrideText.value), defaults: parseObject(defaultsText.value), input: { ...draft.input } }
    }
    async function close() {
      if (saving.value) return false
      if (dirty.value && !await confirmAction({ title: "放弃未保存的修改？", message: "动作原有配置不会改变。", confirmText: "放弃修改", tone: "warn" })) return false
      editorGeneration++; testing.value = false; opened.value = false; setDirtyScope("actions-editor", false); clearTimeout(pollTimer); return true
    }
    async function open(item?: Action, copy = false) {
      if (opened.value && !await close()) return false
      editorGeneration++; testing.value = false; editorStep.value = 0; showIssues.value = false
      clearParameterDrafts()
      Object.assign(draft, blank(), item ? parseObject(json(item)) : {})
      draft.input = { ...blank().input, ...asRecord(item?.input) }
      draft.reply = { ...blank().reply, ...asRecord(item?.reply) }
      if (draft.source) draft.source.useInputAsMessage ??= false
      replyPreview.value = null; replyFields.value = []; replyError.value = ""; replyBusy.value = false
      editingId.value = item && !copy ? item.id : ""
      if (copy) {
        draft.id = "draft"; draft.name += " 副本"; draft.enabled = false; draft.aliases = []
        let suffix = 2
        const commands = new Set(items.value.flatMap(row => [row.command, ...row.aliases]))
        while (commands.has(`${draft.command}${suffix}`)) suffix++
        draft.command += suffix
      }
      aliasesText.value = draft.aliases.join("、"); tagsText.value = draft.tags.join("、"); overrideText.value = draft.overridable.join("、"); defaultsText.value = json(draft.defaults)
      editorError.value = ""; preview.value = null; result.value = null; testText.value = ""; taskId.value = ""; imageUrls.value = ""; imageCount.value = 0
      baseline.value = snapshot(); opened.value = true
      return true
    }
    async function fromExample(example: Action) {
      const template = parseObject(json(example)) as Action
      if (!categories.value.some(item => item.id === template.categoryId)) template.categoryId = ""
      template.enabled = false
      if (!await open(template, true)) return
      draft.name = template.name
      const commands = new Set(items.value.flatMap(item => [item.command, ...item.aliases]))
      if (!commands.has(template.command)) draft.command = template.command
      baseline.value = snapshot()
    }
    function selectTool(name: string) {
      clearParameterDrafts()
      draft.kind = "tool"; draft.tool = name; draft.textParam = ""; draft.textTemplate = ""; defaultsText.value = "{}"; overrideText.value = ""
      draft.input = { ...blank().input }
      const fields = asRecord(asRecord(tools.value.find(tool => tool.name === name)?.parameters).properties)
      draft.textParam = ["prompt", "query", "text"].find(key => asRecord(fields[key]).type === "string") || ""
      if (name === "generate_image") draft.input = { ...blank().input, images:"current-or-quote" }
    }
    async function refresh() { await refreshSlices(["actions"]) }
    function reportApply(response: UnknownRecord) {
      const applied = asRecord(asRecord(response.runtime).actions)
      toast(applied.error ? `已保存，动态注册失败：${applied.error}` : "已保存动作", applied.error ? "warn" : "success")
    }
    async function save() {
      if (saving.value) return
      if (!validateEditor()) return
      saving.value = true; editorError.value = ""
      try {
        const response = await request(editingId.value ? `/api/actions/${editingId.value}` : "/api/actions", { method: editingId.value ? "PUT" : "POST", body: JSON.stringify({ action: payload(), version: draft.version }) })
        editingId.value ||= String(response.id)
        await refresh()
        const saved = items.value.find(item => item.id === editingId.value)
        if (saved) { draft.id = saved.id; draft.version = saved.version }
        baseline.value = snapshot(); reportApply(response)
      } catch (error) { editorError.value = errorMessage(error) } finally { saving.value = false }
    }
    async function toggle(item: Action) {
      if (busy.value) return
      busy.value = item.id
      try { const response = await request(`/api/actions/${item.id}`, { method: "PUT", body: JSON.stringify({ action: { ...item, enabled: !item.enabled }, version: item.version }) }); await refresh(); reportApply(response) }
      catch (error) { toast(errorMessage(error)) } finally { busy.value = "" }
    }
    async function remove(item: Action) {
      if (!await confirmAction({ title: `删除“${item.name}”？`, message: "只删除这份动作预设，关联工具和其他动作不受影响。", confirmText: "删除动作" })) return
      try { await request(`/api/actions/${item.id}`, { method: "DELETE", body: JSON.stringify({ version: item.version }) }); await refresh(); toast("已删除动作") } catch (error) { toast(errorMessage(error)) }
    }
    async function previewAction() {
      if (!validateEditor()) return
      const generation = editorGeneration
      testing.value = true; editorError.value = ""
      try {
        const prefix = String(data.value.prefix || "")
        const response = await request("/api/actions/preview", { method: "POST", body: JSON.stringify({ action: payload(), message: `${prefix}${draft.command}${testText.value ? ` ${testText.value}` : ""}`, role: previewRole.value, scope: previewScope.value, imageCount: imageCount.value }) })
        if (generation !== editorGeneration) return
        preview.value = asRecord(response.preview)
      } catch (error) { if (generation === editorGeneration) editorError.value = errorMessage(error) } finally { if (generation === editorGeneration) testing.value = false }
    }
    async function poll() {
      if (!opened.value || !taskId.value) return
      const generation = editorGeneration
      try {
        const response = await request(`/api/actions/${editingId.value}/tasks/${taskId.value}`)
        if (generation !== editorGeneration) return
        const task = asRecord(response.task)
        result.value = task
        if (["queued", "running"].includes(String(task.status))) pollTimer = setTimeout(poll, 2000)
        else testing.value = false
      } catch (error) { if (generation === editorGeneration) { editorError.value = errorMessage(error); testing.value = false } }
    }
    async function testAction() {
      if (!editingId.value || dirty.value) { editorError.value = "请先保存动作，再测试已保存的配置。"; return }
      if (!await confirmAction({ title: `测试“${draft.name}”？`, message: "会真实执行工具，可能调用模型或产生外部操作。浏览器没有机器人会话发送目标。", confirmText: "运行测试", tone: "warn", icon: "play" })) return
      const generation = editorGeneration
      testing.value = true; editorError.value = ""; result.value = null
      try {
        const response = await request(`/api/actions/${editingId.value}/test`, { method: "POST", body: JSON.stringify({ version: draft.version, text: testText.value, images: split(imageUrls.value) }) })
        if (generation !== editorGeneration) return
        result.value = asRecord(response.result); taskId.value = String(result.value.taskId || "")
        if (taskId.value) pollTimer = setTimeout(poll, 1000)
        else testing.value = false
      } catch (error) { if (generation === editorGeneration) { editorError.value = errorMessage(error); testing.value = false } }
    }
    const categoryOpen = ref(false)
    const categoryDraft = ref<Array<{ id: string; name: string }>>([])
    const categoryBaseline = ref("")
    const categoryVersion = ref("")
    watch(() => json(categoryDraft.value), value => setDirtyScope("actions-categories", categoryOpen.value && value !== categoryBaseline.value))
    function manageCategories() { categoryDraft.value = categories.value.map(item => ({ id: String(item.id), name: String(item.name) })); categoryBaseline.value = json(categoryDraft.value); categoryVersion.value = String(data.value.categoriesVersion); categoryOpen.value = true }
    async function closeCategories() {
      if (json(categoryDraft.value) !== categoryBaseline.value && !await confirmAction({ title: "放弃分类修改？", confirmText: "放弃修改", tone: "warn" })) return
      categoryOpen.value = false; setDirtyScope("actions-categories", false)
    }
    async function deleteCategory(id: string) {
      if (!await confirmAction({ title: "移除此分类？", message: "保存后，其中的动作会归入未分类。", confirmText: "移除分类", tone: "warn" })) return
      categoryDraft.value = categoryDraft.value.filter(item => item.id !== id)
    }
    async function saveCategories() {
      try { await request("/api/actions/categories", { method: "PUT", body: JSON.stringify({ categories: categoryDraft.value, version: categoryVersion.value }) }); categoryOpen.value = false; setDirtyScope("actions-categories", false); await refresh(); toast("已保存分类") } catch (error) { toast(errorMessage(error)) }
    }
    const transferOpen = ref(false)
    const importText = ref("")
    const importPreview = ref<UnknownRecord[] | null>(null)
    watch(importText, () => { importPreview.value = null; setDirtyScope("actions-import", transferOpen.value && Boolean(importText.value)) })
    async function closeTransfer() {
      if (importText.value && !await confirmAction({ title: "关闭导入草稿？", confirmText: "关闭", tone: "warn" })) return
      transferOpen.value = false; setDirtyScope("actions-import", false)
    }
    async function importActions(apply = false) {
      try {
        if (apply && !await confirmAction({ title: "导入动作？", message: "导入的动作默认为停用，核对后可逐条启用。", confirmText: "导入", tone: "warn" })) return
        const response = await request("/api/actions/import", { method: "POST", body: JSON.stringify({ bundle: JSON.parse(importText.value), apply }) })
        if (apply) { transferOpen.value = false; importText.value = ""; setDirtyScope("actions-import", false); await refresh(); toast(`已导入 ${response.count} 个动作`) }
        else importPreview.value = asRecords(response.preview)
      } catch (error) { toast(errorMessage(error)) }
    }
    async function exportActions(item?: Action) {
      try {
        const response = await request(`/api/actions/export${item ? `?id=${encodeURIComponent(item.id)}` : ""}`)
        const url = URL.createObjectURL(new Blob([json(response.bundle)], { type: "application/json" }))
        const link = document.createElement("a"); link.href = url; link.download = `yui-chat-actions${item ? `-${item.id}` : ""}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      } catch (error) { toast(errorMessage(error)) }
    }
    async function copyCommand(item: Action) { try { await navigator.clipboard.writeText(String(item.fullCommand)); toast("已复制指令") } catch { toast("无法访问剪贴板，请手动选择指令复制") } }
    function openTool(action = "config") { if (!draft.tool) return; const name = draft.tool; close().then(closed => { if (closed) { store.toolDetailSeed = { name, action }; setTab("tools") } }) }
    onMounted(() => {
      const seed = store.actionSeed
      if (seed) { store.actionSeed = null; const item = { ...blank(), tool: String(seed.tool || ""), defaults: asRecord(seed.args) }; void open(item, true).then(() => { draft.name = ""; draft.command = ""; baseline.value = snapshot() }) }
    })
    onUnmounted(() => { editorGeneration++; clearTimeout(pollTimer); setDirtyScope("actions-editor", false); setDirtyScope("actions-categories", false); setDirtyScope("actions-import", false) })
    const resultImages = computed(() => {
      const inner = asRecord(result.value?.result)
      return asRecords(asRecord(result.value?.reply).parts || inner.chain).filter(part => part.type === "image").map(part => asRecord(part.source)).filter(source => source.kind === "base64").map(source => {
        const value = String(source.value || "")
        if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(value)) return value
        const mime = String(source.mimeType || "image/png")
        return /^image\/(png|jpeg|webp)$/.test(mime) && /^[A-Za-z0-9+/=\s]+$/.test(value) ? `data:${mime};base64,${value}` : ""
      }).filter(Boolean)
    })
    return { validationIssues, showIssues, editorStep, editorSteps, nextStep, goStep, examples: computed(() => asRecords<Action>(data.value.examples)), fromExample, setupIssues, availabilityHint, textField, parameterErrors, setDefaultsText, resourceOpen, chooseResource, chooseKind, executionLabel, sampleText, replyPreview, replyFields, replyError, replyBusy, previewReply, chooseReplyField, replyModes, replyHint, data, items, categories, roles, runtime, query, category, stateFilter, roleFilter, filtered, enabledCount, categoryName, toolName, roleName, unavailable,
      opened, editingId, draft, aliasesText, tagsText, overrideText, defaultsText, saving, busy, editorError, dirty, selectedTool, schemaFields, parameterOptions, imageOptions, tools, paramValue, setParam,
      open, close, selectTool, save, toggle, remove, copyCommand, preview, result, resultImages, testText, previewRole, previewScope, imageCount, imageUrls, testing, previewAction, testAction,
      categoryOpen, categoryDraft, manageCategories, closeCategories, deleteCategory, saveCategories, addCategory: () => categoryDraft.value.push({ id: `category-${crypto.randomUUID().slice(0, 8)}`, name: "" }),
      transferOpen, importText, importPreview, closeTransfer, importActions, exportActions, openTool, asRecord,
      categoryOptions: computed(() => [{ value: "", label: "未分类" }, ...categories.value.map(item => ({ value: item.id, label: item.name }))]),
      toolOptions: computed(() => [{ value: "", label: "选择一个执行能力" }, ...tools.value.map(tool => ({ value: tool.name, label: `${tool.label}${tool.enabled ? "" : " · 已停用"}` }))]),
    }
  },
  template: `
    <section class="actions-page">
      <div class="actions-heading"><div><h2>让常用能力，一步到位</h2><p>选好执行方式，常用操作一句话完成。</p></div><div class="row"><button class="btn primary" @click="open()"><Icon name="plus" :size="14" />新建动作</button></div></div>
      <div class="actions-examples"><button v-for="example in examples" :key="example.id" class="actions-example" @click="fromExample(example)"><Icon :name="example.kind==='source'?'code':'sparkles'" :size="19" /><span><b>{{example.kind==='source'?'源码示例':'工具示例'}} · {{example.name}}</b><small>{{example.description}}</small></span><span class="badge">默认停用</span></button></div>
      <div v-if="runtime.error" class="hint-banner warn"><Icon name="alert" :size="15" /><span>配置已保存，动态注册尚未生效：{{ runtime.error }}</span></div>
      <div v-if="data.enabled === false" class="hint-banner warn">动作中心已在系统配置中停用。</div>
      <section class="panel actions-panel">
        <div class="actions-toolbar"><div class="actions-search"><Icon name="search" :size="15" /><input v-model="query" placeholder="搜索动作、指令或标签…" aria-label="搜索动作" /></div><div class="row"><Field type="select" v-model="stateFilter" :options="[{value:'all',label:'全部状态'},{value:'enabled',label:'已启用'},{value:'disabled',label:'已停用'},{value:'unavailable',label:'依赖不可用'}]" /><Field type="select" v-model="roleFilter" :options="[{value:'all',label:'全部权限'},...roles]" /><details class="actions-menu"><summary class="btn outline" aria-label="更多动作"><Icon name="sliders" :size="14" />管理</summary><div><button class="btn outline" @click="manageCategories">管理分类</button><button class="btn outline" @click="transferOpen = true">导入动作</button><button class="btn outline" @click="exportActions()">导出全部</button></div></details></div></div>
        <div class="actions-categories"><button :class="{active:category==='all'}" @click="category='all'">全部 <span>{{ items.length }}</span></button><button v-for="entry in categories" :key="entry.id" :class="{active:category===entry.id}" @click="category=entry.id">{{ entry.name }}</button><button :class="{active:category===''}" @click="category=''">未分类</button><span class="actions-count">{{ enabledCount }} 个已启用</span></div>
        <div v-if="!items.length" class="actions-empty"><span><Icon name="sparkles" :size="25" /></span><h3>从一个常用动作开始</h3><p>选一个工具，填入默认参数。以后只需一条指令。</p><button class="btn primary" @click="open()"><Icon name="plus" :size="14" />新建动作</button></div>
        <div v-else-if="!filtered.length" class="actions-empty"><Icon name="search" :size="22" /><h3>没有匹配的动作</h3><p>试试其他关键词或分类。</p></div>
        <template v-else><div class="actions-grid actions-columns"><span>动作 / 指令</span><span>执行能力</span><span>使用权限</span><span>状态</span><span>操作</span></div><PagedList :rows="filtered" :page-size="12" label="动作" list-class="actions-list" v-slot="{ item }"><article class="actions-grid actions-row"><div class="actions-identity"><button class="actions-name" @click="open(item)">{{ item.name }}</button><button class="actions-command" title="复制指令" @click="copyCommand(item)">{{ item.fullCommand }}<Icon name="copy" :size="11" /></button><p v-if="item.description">{{ item.description }}</p></div><div class="actions-tool"><b>{{ executionLabel(item) }}</b><small>{{ categoryName(item.categoryId) }} · {{ item.stage==='accept'?'前置':'普通' }} {{ item.priority }}</small></div><span class="actions-role">{{ roleName(item.minRole) }}</span><span class="badge" :class="unavailable(item)?'risk-medium':item.enabled?'on':''" :title="availabilityHint(item)">{{ unavailable(item)?'依赖不可用':item.enabled?'已启用':'已停用' }}</span><div class="actions-row-buttons"><button class="icon-btn" title="编辑动作" @click="open(item)"><Icon name="pencil" :size="15" /></button><button class="icon-btn" title="复制动作" @click="open(item,true)"><Icon name="copy" :size="15" /></button><button class="icon-btn" :title="item.enabled?'停用动作':'启用动作'" :disabled="!!busy" @click="toggle(item)"><Icon name="power" :size="15" /></button><details class="actions-menu"><summary class="icon-btn" aria-label="更多操作"><Icon name="chevron-down" :size="14" /></summary><div><button class="btn outline" @click="exportActions(item)">导出</button><button class="btn danger" @click="remove(item)">删除</button></div></details></div></article></PagedList></template>
      </section>
      <SideDrawer :open="opened" :title="editingId ? '编辑动作' : '新建动作'" subtitle="调整这份预设，关联工具的实现不会改变" icon="sparkles" width="920px" :modal="true" @close="close">
        <div class="custom-builder-nav" role="tablist" aria-label="动作配置步骤"><button v-for="(step,index) in editorSteps" :key="step.label" type="button" role="tab" :aria-selected="editorStep===index" :aria-controls="'action-step-'+index" :class="{active:editorStep===index}" @click="goStep(index)"><Icon :name="step.icon" :size="14" />{{index+1}} · {{step.label}}<span v-if="showIssues && validationIssues.some(issue=>issue.step===index)" class="form-error" aria-label="此步骤有错误">!</span></button></div>
        <div class="extension-result-preview"><Icon :name="editorSteps[editorStep].icon" :size="17" /><div><strong>{{editorSteps[editorStep].title}}</strong><p>{{editorSteps[editorStep].hint}}</p></div></div>
        <div v-if="showIssues && validationIssues.length" class="actions-validation" role="alert"><strong>请检查以下设置</strong><button v-for="issue in validationIssues" type="button" @click="goStep(issue.step)">{{editorSteps[issue.step].label}} · {{issue.message}}</button></div>
        <div class="actions-editor" role="tabpanel" :id="'action-step-'+editorStep" :aria-label="editorSteps[editorStep].label">
          <section v-if="editorStep===0" class="actions-step"><h3><span>1</span> 设置触发指令</h3><div class="form-grid"><Field label="动作名称" v-model="draft.name" placeholder="例如：手办化" /><Field label="触发指令" v-model="draft.command" :hint="'前缀 ' + (data.prefix || '')" placeholder="手办化" /></div><p class="muted tiny">使用 {{ (data.prefix || '') + (draft.command || '指令名') }}，后面可以加上补充要求。</p></section>
          <section v-if="editorStep===1" class="actions-step"><h3><span>2</span> 选择执行方式</h3>
            <div class="actions-kind"><button class="btn" :class="draft.kind==='tool'?'primary':'outline'" @click="chooseKind('tool')"><Icon name="sparkles" :size="15" />现成工具</button><button class="btn" :class="draft.kind==='source'?'primary':'outline'" @click="chooseKind('source')"><Icon name="code" :size="15" />项目源码</button></div>
            <template v-if="draft.kind==='tool'"><Field label="用哪个工具" type="select" :model-value="draft.tool" @update:model-value="selectTool" :options="toolOptions" /><p v-if="selectedTool?.enabled === false" class="form-error">工具尚未启用。请在 AI 能力中启用后使用。</p><div v-if="selectedTool" class="actions-tool-settings"><p class="muted small">下面设置本动作的输入；渠道、密钥等由工具统一管理。</p><button class="btn small outline" @click="openTool('config')"><Icon name="sliders" :size="14" />渠道与变量</button></div><div v-for="issue in setupIssues" class="hint-banner warn">{{ issue }}</div></template>
            <template v-else-if="draft.source"><div class="actions-source-file"><Field label="项目文件" v-model="draft.source.frameworkResources.target" placeholder="点击右侧选择文件" /><button class="btn outline" @click="resourceOpen=true"><Icon name="folder" :size="15" />选文件</button></div><Field label="调用方式" type="select" v-model="draft.source.callStyle" :options="[{value:'function',label:'调用导出的函数'},{value:'plugin',label:'调用 Yunzai 插件方法'},{value:'resource',label:'读取 JSON / 文本文件'}]" /><div v-if="draft.source.callStyle!=='resource'" class="form-grid"><Field label="导出名称" v-model="draft.source.exportName" placeholder="default" tip="export default 用 default；export class banana 用 banana。" /><Field :label="draft.source.callStyle==='plugin'?'插件方法名':'对象方法名（可留空）'" v-model="draft.source.method" placeholder="例如：draw" /></div><label v-if="draft.source.callStyle==='plugin'" class="actions-check"><input type="checkbox" v-model="draft.source.useInputAsMessage" />用下方默认要求和补充文字作为方法收到的消息</label></template>
            <InvocationGuide :kind="draft.kind" :call-style="draft.source?.callStyle" :prefix="data.prefix" />
          </section>
          <section v-if="editorStep===2" class="actions-step">
            <Field v-if="draft.textParam && (draft.kind!=='source' || draft.source?.callStyle!=='resource')" :label="'默认要求' + (draft.textParam ? ' · ' + draft.textParam : '')" :hint="textField?.required ? '必填 · 可由指令后的文字提供' : '可留空'" type="textarea" :rows="3" v-model="draft.textTemplate" placeholder="例如：把参考图中的主体制作成精致手办" tip="指令后的补充文字会自动追加，也可以用 {{text}} 指定插入位置。" />
            <div v-if="draft.textParam && (draft.kind!=='source' || draft.source?.callStyle!=='resource')" class="actions-template-help">
              <div v-pre class="actions-template-tokens"><span>可用占位符</span><span><code>{{text}}</code> 补充文字</span><span><code>{{userName}}</code> 群名片 / 昵称</span><span><code>{{userId}}</code> 用户 ID</span><span><code>{{groupId}}</code> 群 ID（私聊为空）</span></div>
              <p v-pre>仅在“默认要求”中替换。普通文字模式下，不写 {{text}} 也会自动追加补充文字；参数名=值模式下 {{text}} 为空。无群名片和昵称时，{{userName}} 使用用户 ID。</p>
            </div>
            <div class="form-grid"><Field label="把指令后的文字填到" type="select" v-model="draft.textParam" :options="parameterOptions" /><Field label="图片来源" type="select" v-model="draft.input.images" :options="[{value:'none',label:'不需要图片'},{value:'current-or-quote',label:'当前图片，缺少时用引用图片'},{value:'current',label:'仅当前图片'},{value:'quote',label:'仅引用图片'}]" /></div>
            <p v-if="textField" class="muted tiny">{{ textField.hint }}</p>
            <div v-if="draft.input.images!=='none'" class="form-grid"><Field label="把图片填到" type="select" v-model="draft.input.imageParam" :options="imageOptions" /><label class="actions-check"><input type="checkbox" v-model="draft.input.requireImage" />必须提供图片</label></div>
            <div v-if="schemaFields.length" class="actions-parameters"><h4>执行参数 <span>{{ schemaFields.length }} 项</span></h4><p class="muted small">填写后仅用于这个动作；留空跟随工具默认值。</p><div class="form-grid"><div v-for="field in schemaFields" :key="field.key" class="actions-parameter" :class="{'actions-parameter-wide':field.complex}"><Field :label="field.label" :hint="field.key + (field.required ? ' · 必填' : ' · 可选')" :type="field.type" :rows="3" :options="field.options" :placeholder="field.placeholder" :model-value="paramValue(field.key)" @update:model-value="setParam(field.key,$event)" /><p class="muted tiny">{{ field.hint }}</p><p v-if="parameterErrors[field.key]" class="form-error" role="alert">{{parameterErrors[field.key]}}</p></div></div></div>
            <details class="actions-fold"><summary>高级输入设置<span>参数覆盖与完整 JSON</span><Icon name="chevron-down" :size="13" /></summary><Field label="输入方式" type="select" v-model="draft.input.mode" :options="[{value:'text',label:'普通文字（推荐）'},{value:'parameters',label:'参数名=值'}]" /><Field label="默认参数 JSON" type="textarea" :rows="4" :model-value="defaultsText" @update:model-value="setDefaultsText" placeholder='{"count":1}' /><p v-if="draft.kind==='source'" class="muted small">源码没有声明参数表时，在这里添加参数；保存为有效 JSON 后，上方会生成对应输入项。</p><Field label="用户可修改的参数" v-model="overrideText" placeholder="仅参数名=值模式使用，顿号分隔" /></details>
          </section>
          <section v-if="editorStep===3" class="actions-step"><h3><span>4</span> 结果怎样回复</h3><Field label="回复方式" type="select" v-model="draft.reply.mode" :options="replyModes" /><p class="muted small">{{ replyHint }}</p><template v-if="!['auto','silent'].includes(draft.reply.mode)"><Field label="提取结果中的字段（可留空）" v-model="draft.reply.path" placeholder="例如：data.text 或 data.images[0].url" tip="留空使用完整返回值。可以在下面粘贴样例，点击字段选择。" /><Field v-if="['text','json'].includes(draft.reply.mode)" label="回复文字模板（可留空）" v-model="draft.reply.template" placeholder="例如：查询结果：{{value}}" /><p v-if="['text','json'].includes(draft.reply.mode)" class="actions-template-help"><span v-pre>回复模板只支持 <code>{{value}}</code>：提取后的结果文字，未指定字段时为完整结果。例如：查询结果：{{value}}。</span></p></template>
            <details v-if="draft.reply.mode!=='silent'" class="actions-fold"><summary>粘贴返回值，看看回复效果<span>不会执行工具或源码</span><Icon name="play" :size="13" /></summary><Field label="返回值样例" type="textarea" :rows="4" v-model="sampleText" /><button class="btn outline" :disabled="replyBusy" @click="previewReply">预览回复</button><p v-if="replyError" class="form-error">{{ replyError }}</p><div v-if="replyFields.length && !['auto','silent'].includes(draft.reply.mode)" class="actions-field-chips"><button v-for="path in replyFields" class="btn small outline" @click="chooseReplyField(path)">{{path}}</button></div><div v-if="replyPreview" class="actions-reply-preview"><pre v-if="replyPreview.message">{{replyPreview.message}}</pre><p v-for="part in replyPreview.parts.filter(p=>p.type!=='text')">{{part.type==='image'?'图片':part.type}} · {{asRecord(part.source).kind==='base64'?'内嵌图片':asRecord(part.source).value || '消息片段'}}</p><small>{{replyPreview.note}}</small></div></details>
          </section>
          <details v-if="editorStep===0" class="actions-fold"><summary>分类、权限与高级设置<span>默认所有用户，普通优先级</span><Icon name="chevron-down" :size="13" /></summary><Field label="说明" v-model="draft.description" /><div class="form-grid"><Field label="分类" type="select" v-model="draft.categoryId" :options="categoryOptions" /><Field label="标签" v-model="tagsText" placeholder="顿号分隔" /><Field label="谁可以触发" type="select" v-model="draft.minRole" :options="roles" /><Field label="适用会话" type="select" v-model="draft.scope" :options="[{value:'all',label:'群聊与私聊'},{value:'group',label:'仅群聊'},{value:'private',label:'仅私聊'}]" /></div><p class="muted tiny">仍遵守工具策略与项目访问控制。</p><Field v-if="draft.kind==='source' && draft.source" label="源码能力风险" type="select" v-model="draft.source.risk" :options="[{value:'low',label:'低风险'},{value:'medium',label:'普通操作'},{value:'high',label:'高风险（仅主人）'},{value:'external',label:'需要外部服务'}]" /><Field label="指令别名" v-model="aliasesText" placeholder="不带前缀，顿号分隔" /><div class="form-grid"><Field label="执行阶段" type="select" v-model="draft.stage" :options="[{value:'rule',label:'普通指令（默认）'},{value:'accept',label:'前置触发'}]" /><Field label="优先级" type="number" v-model="draft.priority" tip="数字越小越先执行，前置触发先于普通指令。" /></div><button v-if="draft.kind==='tool' && selectedTool" class="btn small outline" @click="openTool('view')">查看工具详情</button></details>
          <section v-if="editorStep===4" class="actions-step"><Field label="指令后的输入" v-model="testText" placeholder="例如：加一个透明底座" /><div class="form-grid"><Field label="预览角色" type="select" v-model="previewRole" :options="roles" /><Field label="预览会话" type="select" v-model="previewScope" :options="[{value:'group',label:'群聊'},{value:'private',label:'私聊'}]" /></div><Field v-if="draft.input.images!=='none'" label="模拟图片数量" type="number" v-model="imageCount" /><button class="btn outline" :disabled="testing" @click="previewAction">只预览，不执行</button><div v-if="preview" class="actions-preview"><b>{{ preview.matched ? '指令匹配成功' : '未命中动作' }}</b><p>{{ asRecord(preview.access).allowed ? '所选角色允许执行' : asRecord(preview.access).reason }}</p><p v-for="issue in preview.issues" class="form-error">{{ issue }}</p><p v-for="conflict in preview.conflicts" class="form-error">同时命中：{{ conflict.name }} · {{ conflict.stage }} {{ conflict.priority }}</p><JsonBlock title="将传入的参数" :value="preview.arguments" /></div><div class="actions-real-test"><p class="muted small">实际试跑会执行已保存的工具或源码。浏览器没有机器人会话投递目标。</p><Field v-if="draft.input.images!=='none'" label="测试参考图地址" type="textarea" :rows="2" v-model="imageUrls" placeholder="HTTP(S) 地址，每行一个" /><button class="btn outline" :disabled="testing || !editingId || dirty || !draft.enabled" @click="testAction">{{ testing?'执行中…':'实际试跑' }}</button><p v-if="!editingId || dirty" class="muted tiny">请先保存动作后再试跑。</p><div v-if="result" class="actions-reply-preview"><b>回复效果</b><pre>{{asRecord(result.reply).message || result.message || result.error || result.status}}</pre></div><div class="actions-result-images"><img v-for="src in resultImages" :src="src" alt="动作生成的图片" /></div><JsonBlock v-if="result" title="查看原始结果" :value="result" /></div></section>
          <p v-if="editorError" class="form-error" role="alert">{{ editorError }}</p>
        </div>
        <template #actions><label class="actions-check"><input type="checkbox" v-model="draft.enabled" />启用动作</label><span class="actions-footer-space"></span><button v-if="editorStep>0" class="btn outline" @click="goStep(editorStep-1)">上一步</button><button v-if="editorStep<editorSteps.length-1" class="btn primary" @click="nextStep">下一步</button><button class="btn" :class="editorStep===editorSteps.length-1 ? 'primary' : 'outline'" :disabled="saving" @click="save">{{ saving?'保存中…':'保存动作' }}</button></template>
      </SideDrawer>
      <FrameworkResourcePicker :open="resourceOpen" @close="resourceOpen=false" @select="chooseResource" />
      <SideDrawer :open="categoryOpen" title="管理分类" subtitle="分类只影响展示，不改变动作权限" icon="folder" width="460px" :modal="true" @close="closeCategories"><div class="actions-category-editor"><div v-for="entry in categoryDraft" :key="entry.id" class="row"><Field v-model="entry.name" placeholder="分类名称" /><button class="icon-btn" title="移除分类" @click="deleteCategory(entry.id)"><Icon name="trash" :size="14" /></button></div><button class="btn outline" @click="addCategory"><Icon name="plus" :size="14" />添加分类</button></div><template #actions><button class="btn outline" @click="closeCategories">取消</button><button class="btn primary" @click="saveCategories">保存分类</button></template></SideDrawer>
      <SideDrawer :open="transferOpen" title="导入动作" subtitle="导入参数预设，共享已有工具实现" icon="upload" width="600px" :modal="true" @close="closeTransfer"><Field label="动作配置包 JSON" type="textarea" :rows="12" v-model="importText" /><button class="btn outline" @click="importActions(false)">预览导入</button><div v-if="importPreview" class="actions-preview"><b>{{ importPreview.length }} 个动作，导入后默认停用</b><p v-for="item in importPreview">{{ item.name }} · {{ item.tool }}</p></div><template #actions><button class="btn outline" @click="closeTransfer">取消</button><button class="btn primary" :disabled="!importPreview" @click="importActions(true)">导入动作</button></template></SideDrawer>
    </section>
  `,
}
