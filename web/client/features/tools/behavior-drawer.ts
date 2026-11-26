import { RuntimeVariableFields } from "./runtime-variable-fields.js"
import { collectRuntimeValues, runtimeDraftValues, runtimeFieldRow } from "./shared.js"
import { ToolConfigurationPanel } from "./tool-configuration-panel.js"
import { RenderPanel } from "./render-panel.js"
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue"
import { PagedList } from "../../ui/components.js"
import { applyConfigResponse, confirmAction, request, setDirtyScope, store, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, sameJsonValue, type UnknownRecord } from "../../shared/data.js"
import { BEHAVIOR_SECTIONS, BehaviorFields } from "./behavior-fields.js"

export interface BehaviorTarget { scope: string; id: string; owner?: { scope: string; id: string } }
interface ToolBehavior extends UnknownRecord { name: string; label: string; source: string; parent?: BehaviorTarget; inherited: UnknownRecord; actions: UnknownRecord; capabilities: UnknownRecord }
export const BehaviorDrawer = {
  name: "BehaviorDrawer",
  components: { RuntimeVariableFields, ToolConfigurationPanel, RenderPanel, BehaviorFields, PagedList },
  props: { open: Boolean, target: { type: Object, default: null } },
  emits: ["close"],
  setup(props: { open: boolean; target: BehaviorTarget | null }, { emit }: { emit: (event: string) => void }) {
    const skillSchema = ref<UnknownRecord>({}), skillDraft = reactive<Record<string, string>>({}), skillBaseline = ref("")
    const backgroundEnabled = computed(() => {
      const execution = asRecord(asRecord(asRecord(store.config).chat).execution)
      return asRecord(execution.background).enabled !== false
    })
    const isSkill = computed(() => props.target?.scope === "skills")
    const skillRows = computed(() => Object.entries(asRecord(skillSchema.value.properties)).map(([name, field]) => runtimeFieldRow(name, field, Boolean(skillDraft[name]))))
    const tools = ref<ToolBehavior[]>([]), settings = ref<UnknownRecord>({})
    const runtimePanel = ref<{ saveAll: () => Promise<void> } | null>(null)
    const runtimeDirty = ref(false), runtimeSaving = ref(false), renderDirty = ref(false), renderSaving = ref(false)
    const specificMounted = ref(false)
    const activeSection = ref("common")
    const runtimeTool = computed(() => asRecords(store.tools?.tools).find(tool => tool.name === props.target?.id))
    const hasRuntime = computed(() => runtimeTool.value && (["image_media", "web_search", "tool_search"].includes(String(runtimeTool.value.name)) || Object.keys(asRecord(asRecord(runtimeTool.value.common).configSchema).properties || {}).length > 0))
    const loading = ref(false), saving = ref(false), stage = ref(1), action = ref("")
    const loadError = ref("")
    const busy = computed(() => saving.value || runtimeSaving.value || renderSaving.value)
    const selected = ref<string[]>([]), filter = reactive({ source: "all", query: "" })
    const drafts = reactive<Record<string, UnknownRecord>>({}), resets = reactive<Record<string, boolean>>({})
    const selectedTools = computed(() => props.target
      ? tools.value.filter(tool => props.target?.scope === "tools" ? tool.name === props.target.id && (!props.target.owner || tool.parent?.scope === props.target.owner.scope && tool.parent?.id === props.target.owner.id) : tool.parent?.scope === props.target?.scope && tool.parent?.id === props.target?.id)
      : tools.value.filter(tool => selected.value.includes(tool.name)))
    const single = computed(() => props.target?.scope === "tools" ? selectedTools.value[0] : null)
    const ownEntry = computed(() => props.target ? asRecord(asRecord(settings.value[props.target.scope])[props.target.id]) : {})
    const currentValues = computed(() => {
      if (resets[action.value] || resets[""] && action.value) return {}
      return action.value ? asRecord(asRecord(ownEntry.value.actions)[action.value]) : asRecord(ownEntry.value.values)
    })
    const values = computed(() => {
      const value = { ...currentValues.value }
      for (const [key, item] of Object.entries(drafts[action.value] || {})) { if (item === null && props.target) delete value[key]; else value[key] = item }
      return value
    })
    const inherited = computed(() => {
      if (!single.value) return {}
      if (!action.value) return single.value.inherited
      const snapshot = asRecord(single.value.actions[action.value])
      const base = { ...asRecord(resets[""] ? snapshot.baseInherited : snapshot.inherited) }
      for (const [key, value] of Object.entries(drafts[""] || {})) {
        if (value === null) base[key] = asRecord(snapshot.baseInherited)[key]
        else base[key] = value
      }
      return base
    })
    const capabilities = computed(() => selectedTools.value.map(tool => action.value ? asRecord(asRecord(tool.actions[action.value]).capabilities) : tool.capabilities))
    const sections = computed(() => [
      ...(single.value && (hasRuntime.value || single.value.name === "render_image") ? [{ id: "specific", label: "工具专属" }] : []),
      ...BEHAVIOR_SECTIONS,
    ])
    function selectSection(id: string) {
      if (busy.value) return
      activeSection.value = id
      if (id === "specific") specificMounted.value = true
    }
    const actionOptions = computed(() => [{ value: "", label: "整个工具" }, ...Object.keys(single.value?.actions || {}).map(value => ({ value, label: value }))])
    const dirty = computed(() => Object.values(drafts).some(value => Object.keys(value).length > 0) || Object.values(resets).some(Boolean) || isSkill.value && JSON.stringify(skillDraft) !== skillBaseline.value)
    watch([dirty, runtimeDirty, renderDirty], ([value, extra, render]) => setDirtyScope("tool-behavior", value || extra || render))
    onBeforeUnmount(() => setDirtyScope("tool-behavior", false))
    const title = computed(() => !props.target ? "批量配置工具" : isSkill.value ? `${props.target.id} · Skill 配置` : props.target.scope === "tools" ? `${single.value?.label || props.target.id} · 配置` : `${props.target.id} · 范围默认设置`)
    const visible = computed(() => tools.value.filter(tool => (filter.source === "all" || tool.source === filter.source) && `${tool.name} ${tool.label}`.toLowerCase().includes(filter.query.toLowerCase())))
    function clearDrafts() { for (const key of Object.keys(drafts)) delete drafts[key]; for (const key of Object.keys(resets)) delete resets[key] }
    function syncSkill(schema: unknown, values: unknown) {
      skillSchema.value = asRecord(schema)
      for (const key of Object.keys(skillDraft)) delete skillDraft[key]
      Object.assign(skillDraft, runtimeDraftValues(skillSchema.value, values))
      skillBaseline.value = JSON.stringify(skillDraft)
    }
    let loadVersion = 0
    async function load() {
      const version = ++loadVersion
      loading.value = true
      loadError.value = ""
      try {
        if (isSkill.value) {
          const response = await request(`/api/skills/${encodeURIComponent(props.target?.id || "")}`)
          if (version !== loadVersion || !props.open) return
          const result = asRecord(response.result)
          syncSkill(asRecord(result.manifest).configSchema, result.runtimeConfig)
          return
        }
        const response = await request("/api/tools/behavior")
        if (version !== loadVersion || !props.open) return
        tools.value = asRecords<ToolBehavior>(response.tools)
        settings.value = asRecord(response.settings)
        selectSection(sections.value[0].id)
      } catch (error) {
        if (version === loadVersion) loadError.value = errorMessage(error)
        throw error
      } finally { if (version === loadVersion) loading.value = false }
    }
    watch(() => [props.open, props.target?.scope, props.target?.id], async () => {
      if (!props.open) { loadVersion++; return }
      tools.value = []; settings.value = {}; skillSchema.value = {}
      for (const key of Object.keys(skillDraft)) delete skillDraft[key]
      skillBaseline.value = JSON.stringify(skillDraft)
      clearDrafts(); runtimeDirty.value = false; runtimeSaving.value = false; renderDirty.value = false; renderSaving.value = false; specificMounted.value = false; selected.value = []; action.value = ""; stage.value = props.target ? 2 : 1; activeSection.value = "common"
      filter.source = "all"; filter.query = ""
      try { await load() } catch (error) { toast(errorMessage(error)) }
    }, { immediate: true })
    function change(key: string, value: unknown) {
      const original = currentValues.value[key]
      const changes = drafts[action.value] ||= {}
      if (!props.target) { if (value === undefined) delete changes[key]; else changes[key] = value; return }
      if (sameJsonValue(original, value === null ? undefined : value)) delete changes[key]
      else changes[key] = value
    }
    function toggle(name: string, checked: boolean) { selected.value = checked ? [...new Set([...selected.value, name])] : selected.value.filter(item => item !== name) }
    function resetCurrent() {
      if (!action.value) clearDrafts()
      resets[action.value] = true
      drafts[action.value] = {}
    }
    async function close() {
      if (busy.value) return
      if ((dirty.value || runtimeDirty.value || renderDirty.value) && !await confirmAction({ title: "放弃未保存的工具配置？", message: "本次修改尚未生效。", confirmText: "放弃修改", tone: "warn" })) return
      clearDrafts(); runtimeDirty.value = false; renderDirty.value = false; emit("close")
    }
    async function back() {
      if (busy.value) return
      if ((dirty.value || runtimeDirty.value || renderDirty.value) && !await confirmAction({ title: "重新选择工具？", message: "将放弃本次尚未保存的修改。", confirmText: "重新选择", tone: "warn" })) return
      clearDrafts(); stage.value = 1
    }
    async function save() {
      if (busy.value || loading.value || loadError.value || !dirty.value) return
      if (isSkill.value) {
        saving.value = true
        try {
          const value = collectRuntimeValues(skillSchema.value, skillDraft)
          const response = await request(`/api/skills/${encodeURIComponent(props.target?.id || "")}/runtime-config`, { method: "PUT", body: JSON.stringify({ value }) })
          applyConfigResponse(response)
          const skill = asRecord(response.skill)
          syncSkill(skill.configSchema, skill.runtimeConfig)
          toast("Skill 运行变量已保存")
        } catch (error) { toast(errorMessage(error)) }
        finally { saving.value = false }
        return
      }
      const targets = props.target ? [props.target] : selectedTools.value.map(tool => ({ scope: "tools", id: tool.name, ...(tool.parent ? {owner: tool.parent} : {}) }))
      if (!targets.length) return
      if ((targets.length > 1 || props.target?.scope !== "tools") && !await confirmAction({ title: "应用范围配置？", message: props.target ? "将作为该范围内工具的管理默认值，单工具设置仍优先。" : "只修改选中的配置项，其余设置保持各工具原值。", detail: props.target?.id || selectedTools.value.map(tool => tool.label).join("、"), confirmText: "应用配置", tone: "warn" })) return
      saving.value = true
      try {
        const edits = [...new Set([...Object.keys(drafts), ...Object.keys(resets)])].filter(key => resets[key] || Object.keys(drafts[key] || {}).length).sort((a, b) => a === "" ? -1 : b === "" ? 1 : 0).map(key => ({ action: key, reset: resets[key] === true, changes: drafts[key] || {} }))
        // 保存期间不接受新的表单输入，成功后才清除草稿。
        const response = await request("/api/tools/behavior", { method: "PUT", body: JSON.stringify({ targets, edits }) })
        applyConfigResponse(response)
        if (Array.isArray(response.tools)) store.tools = { ...asRecord(store.tools), tools: response.tools }
        tools.value = asRecords<ToolBehavior>(asRecord(response.behavior).tools)
        settings.value = asRecord(asRecord(response.behavior).settings)
        clearDrafts(); toast("工具配置已生效")
      } catch (error) { toast(errorMessage(error)) }
      finally { saving.value = false }
    }
    async function reload() { try { await load() } catch (error) { toast(errorMessage(error)) } }

    return { busy, renderSaving, activeSection, sections, selectSection, backgroundEnabled, renderDirty, specificMounted, loadError, reload, isSkill, skillSchema, skillDraft, skillRows, runtimePanel, runtimeDirty, runtimeSaving, runtimeTool, hasRuntime, tools, selectedTools, single, loading, saving, stage, selected, filter, visible, title, values, inherited, capabilities, action, actionOptions, dirty, change, toggle, resetCurrent, close, back, save }
  },
  template: `
    <SideDrawer :open="open" :title="title" subtitle="全局限制 → 服务或扩展默认 → 单工具 → 动作。仅保存明确修改的项。" icon="sliders" width="1100px" :modal="true" @close="close">
      <div class="tool-detail-modal tool-behavior-modal">
        <p v-if="loading" class="tool-detail-page muted">正在读取当前设置…</p>
        <div v-else-if="loadError" class="tool-config-empty"><p>读取当前设置失败：{{ loadError }}</p><button class="btn outline" @click="reload">重新读取</button></div>
        <section v-else-if="isSkill" class="tool-detail-page">
          <p class="muted small">Skill 提供工作流指令，这里配置已声明的运行变量；工具执行策略由各工具管理。</p>
          <fieldset class="behavior-form form-grid tool-runtime-grid" :disabled="saving"><RuntimeVariableFields v-if="skillRows.length" :rows="skillRows" :draft="skillDraft" /><p v-else class="muted">该 Skill 没有声明运行变量。可通过“编辑”维护指令正文。</p></fieldset>
        </section>
        <section v-else-if="stage === 1" class="tool-detail-page">
          <p class="muted small">先选择工具，再分类修改配置项。未选择的项保持各工具原值。</p>
          <div class="form-grid"><Field label="工具来源" type="select" :options="[{value:'all',label:'全部'},{value:'builtin',label:'内置'},{value:'custom',label:'Custom'},{value:'mcp',label:'MCP'}]" v-model="filter.source" /><Field label="搜索工具" v-model="filter.query" /></div>
          <div class="row"><button class="btn small outline" @click="visible.forEach(tool => toggle(tool.name, true))">选择筛选结果</button><button class="btn small outline" @click="selected = []">清空选择</button><span>已选择 {{ selected.length }} 个</span></div>
          <PagedList :rows="visible" :page-size="10" label="工具" empty="当前目录没有匹配工具。"><template #default="{ item }"><label class="behavior-target"><input type="checkbox" :checked="selected.includes(item.name)" @change="toggle(item.name, $event.target.checked)" /><span>{{ item.label }} <small class="muted">{{ item.name }}</small></span></label></template></PagedList>
        </section>
        <div v-else-if="target?.scope === 'tools' && !single" class="tool-config-empty"><p>该工具不在当前可配置目录中，或工具名称与其他扩展冲突。请先检查扩展加载状态。</p></div>
        <template v-else>
          <nav class="tool-detail-tabs" role="tablist" aria-label="工具配置分类">
            <button v-for="section in sections" :key="section.id" type="button" role="tab" :aria-selected="activeSection === section.id" :class="{active: activeSection === section.id}" :disabled="busy" @click="selectSection(section.id)">{{ section.label }}</button>
          </nav>
          <section v-show="activeSection === 'specific'" class="tool-detail-page">
            <template v-if="specificMounted && hasRuntime"><ToolConfigurationPanel ref="runtimePanel" :tool="runtimeTool" @dirty="runtimeDirty = $event" @saving="runtimeSaving = $event" /></template>
            <RenderPanel v-if="specificMounted && single?.name === 'render_image'" @dirty="renderDirty = $event" @saving="renderSaving = $event" />
          </section>
          <section v-show="activeSection !== 'specific'" class="tool-detail-page">
            <p class="muted small">{{ target?.scope === 'tools' ? '单独设置优先；恢复默认后继承服务或扩展设置，再使用工具原始声明。' : target ? '影响此服务或扩展下的工具，包括后续新增工具；单工具设置优先，仅应用适用项。' : '仅影响已选的 ' + selected.length + ' 个工具；只保存选中的修改项，不启用工具或修改权限。' }}</p>
            <p v-if="single?.parent" class="muted tiny">默认来源：{{ single.parent.scope === 'mcpServers' ? 'MCP 服务' : 'Custom 扩展' }} {{ single.parent.id }}</p>
            <p v-if="single && !single.loaded" class="muted small">当前工具未加载，仅展示清单声明；启用后以实际工具定义为准。</p>
            <p v-if="activeSection === 'common' && backgroundEnabled === false" class="muted small">后台执行总开关已关闭，可在“全局配置”中启用。</p>
            <Field v-if="actionOptions.length > 1" label="配置层级" type="select" :options="actionOptions" :disabled="busy" v-model="action" />
            <fieldset :disabled="busy" class="behavior-form"><BehaviorFields :values="values" :inherited="inherited" :capabilities="capabilities" :action="Boolean(action)" :batch="!target" :section="activeSection" @change="change" /></fieldset>
            <button v-if="target" class="btn small outline" :disabled="busy" @click="resetCurrent">恢复{{ action ? '当前动作' : '整个工具或范围' }}执行默认</button>
          </section>
        </template>
      </div>
      <template #actions>
        <button v-if="stage === 2 && !target" class="btn outline" :disabled="busy" @click="back">重新选择工具</button>
        <button v-if="stage === 1" class="btn primary" :disabled="!selected.length || loading" @click="stage = 2">下一步：分类配置</button>
        <button v-else-if="activeSection === 'specific' && hasRuntime" class="btn primary" :disabled="busy || !runtimeDirty" @click="runtimePanel?.saveAll()">保存专属设置</button>
        <button v-else-if="activeSection !== 'specific'" class="btn primary" :disabled="!dirty || busy || loading || Boolean(loadError)" @click="save">{{ saving ? '正在保存…' : isSkill ? '保存运行变量' : '保存执行设置' }}</button>
        <button class="btn outline" :disabled="busy" @click="close">关闭</button>
      </template>
    </SideDrawer>
  `,
}
