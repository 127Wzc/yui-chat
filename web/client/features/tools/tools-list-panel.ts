import { reactive, computed, watch } from "vue"
import { confirmAction, store, request, toast, refreshTab } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage } from "../../shared/data.js"
import {
  BUILTIN_CATEGORY_META,
  isFoldedRenderTool,
  riskBadgeClass,
  riskLabel,
  toolCommon,
  toolProvenance,
  toolSource,
  toolDescription,
  toolDescriptionExtra,
  toolDisplayName,
  toolEnglishName,
  toolMatchesFilter,
  toolRepeatabilityLabel,
  toolHasRepeatProtection,
  type ToolConfigRoot,
  type ToolGroup,
  type ToolRecord,
  type ToolsSlice,
} from "./shared.js"

// 工具列表：标签筛选 + 单一清晰表格 + 行内开关。
export const ToolListPanel = {
  name: "ToolListPanel",
  props: { selectedCategory: { type: String, default: "all" } },
  emits: ["open-tool-detail", "category-change"],
  setup(props: { selectedCategory: string }, { emit }: { emit: (event: string, payload?: unknown) => void }) {
    const filter = reactive({ query: "", status: "all", tag: props.selectedCategory || "all" })
    const allTools = computed<ToolRecord[]>(() => asRecords<ToolRecord>(asRecord<ToolsSlice>(store.tools).tools).filter(tool => toolSource(tool) === "builtin" && !isFoldedRenderTool(tool)))
    const toolTags = computed(() => {
      const groups = new Map<string, ToolGroup>()
      for (const tool of allTools.value) {
        const common = toolCommon(tool)
        const name = String(common.category || "unknown")
        const meta = BUILTIN_CATEGORY_META[name] || { title: common.categoryLabel || name, description: "该分类下的内置能力。", icon: "wrench", order: 99 }
        if (!groups.has(name)) groups.set(name, { name, ...meta, names: [], tools: [], unavailable: [], disabled: [], enabled: [], highRisk: [], external: [], ready: false })
        const group = groups.get(name)
        if (!group) continue
        group.names.push(tool.name)
        group.tools.push(tool)
      }
      return [...groups.values()].map(group => {
        const { names, tools, unavailable } = group
        const disabled = tools.filter(tool => !tool.enabled)
        const enabled = tools.filter(tool => tool.enabled)
        const highRisk = tools.filter(tool => toolCommon(tool).risk === "high" || toolCommon(tool).policy?.highRisk || toolCommon(tool).policy?.requiresMaster)
        const external = tools.filter(tool => toolCommon(tool).policy?.externalNetwork)
        return { ...group, disabled, enabled, highRisk, external, ready: names.length > 0 && disabled.length === 0 && unavailable.length === 0 }
      }).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "zh-Hans-CN"))
    })
    const selectedTag = computed(() => toolTags.value.find(item => item.name === filter.tag) || null)
    const enabledToolTokenEstimate = computed(() => allTools.value
      .filter(tool => tool.enabled)
      .reduce((sum, tool) => sum + Number(tool.modelTokenEstimate || 0), 0))
    const visible = computed(() => {
      const taggedNames = selectedTag.value ? new Set(selectedTag.value.names) : null
      return allTools.value.filter(tool => (!taggedNames || taggedNames.has(tool.name)) && toolMatchesFilter(tool, filter))
    })
    const statusOptions = [["all", "全部"], ["enabled", "已启用"], ["disabled", "未启用"], ["high-risk", "高风险"], ["external", "外网"]]

    async function toggleTool(tool: string, enabled: boolean) {
      if (!enabled) {
        const accepted = await confirmAction({ title: `停用工具“${tool}”？`, message: "停用后，模型不会再看到或调用这个工具。", confirmText: "确认停用", tone: "warn", icon: "power" })
        if (!accepted) return
      } else {
        const meta = allTools.value.find(item => item.name === tool)
        const common = meta ? toolCommon(meta) : {}
        if (meta && (common.risk === "high" || common.risk === "external" || common.policy?.highRisk || common.policy?.externalNetwork)) {
          const accepted = await confirmAction({ title: `启用${common.risk === "high" ? "高风险" : "外部"}工具“${tool}”？`, message: common.descriptionZh || common.description || "该工具可能执行高权限操作或访问外部网络。", confirmText: "确认启用", tone: "warn", icon: "alert" })
          if (!accepted) return
        }
      }
      try {
        await request("/api/tools/enabled", { method: "POST", body: JSON.stringify({ tool, enabled }) })
        toast(`${enabled ? "已启用" : "已停用"} ${tool}，已立即生效（无需重启）`)
        await refreshTab("tools")
      } catch (err) { toast(errorMessage(err)) }
    }
    function emitCategoryChange() { emit("category-change", filter.tag) }
    function reset() { filter.query = ""; filter.status = "all"; filter.tag = "all"; emitCategoryChange() }
    function clearTag() { filter.tag = "all"; emitCategoryChange() }
    function formatTokenEstimate(value: unknown) { return Number(value || 0).toLocaleString("zh-CN") }
    const subAgentEnabled = computed(() => asRecord<ToolConfigRoot>(store.config).subAgent?.enabled === true)
    async function reloadTools() {
      try {
        await refreshTab("tools")
        toast("内置能力列表已刷新")
      } catch (err) { toast(errorMessage(err)) }
    }
    function hasRuntimeConfig(tool: unknown) {
      return ["image_media", "web_search", "tool_search"].includes(String(asRecord(tool).name || "")) || Object.keys(toolCommon(tool).configSchema?.properties || {}).length > 0
    }
    function hasWebConfig(tool: unknown) {
      return String(asRecord(tool).name || "") === "render_image" || hasRuntimeConfig(tool)
    }
    function openToolDetail(tool: ToolRecord, action = "view") {
      emit("open-tool-detail", { name: tool.name, action })
    }
    watch(() => props.selectedCategory, value => {
      const next = String(value || "all")
      if (filter.tag !== next) filter.tag = next
    })
    return { filter, toolTags, selectedTag, allTools, visible, statusOptions, enabledToolTokenEstimate, toggleTool, reset, clearTag, emitCategoryChange, reloadTools, formatTokenEstimate, subAgentEnabled, hasRuntimeConfig, hasWebConfig, openToolDetail, riskBadgeClass, riskLabel, toolCommon, toolProvenance, toolSource, toolDescription, toolDescriptionExtra, toolDisplayName, toolEnglishName, toolRepeatabilityLabel, toolHasRepeatProtection }
  },
  template: `
    <Panel title="内置能力" icon="wrench">
      <div class="capability-tool-list">
        <div class="list-filter">
          <label class="capability-category-select">
            <Icon name="list" :size="14" />
            <select v-model="filter.tag" aria-label="能力分类" @change="emitCategoryChange">
              <option value="all">全部分类</option>
              <option v-for="tag in toolTags" :key="tag.name" :value="tag.name">{{ tag.title }}（{{ tag.enabled.length }}/{{ tag.names.length }}）</option>
            </select>
          </label>
          <button v-if="filter.tag !== 'all'" class="icon-btn" type="button" data-tip="清空指令分类" @click="clearTag"><Icon name="x" :size="15" /></button>
          <div class="filter-search">
            <Icon name="search" :size="14" />
            <input :value="filter.query" placeholder="搜索中文名、工具 ID、标签、说明" @input="filter.query = $event.target.value" />
          </div>
          <div class="segmented" role="group" aria-label="工具状态筛选">
            <button v-for="[value, label] in statusOptions" :key="value" :class="{ active: filter.status === value }" type="button" @click="filter.status = value">{{ label }}</button>
          </div>
          <button class="icon-btn" type="button" data-tip="清空筛选" @click="reset"><Icon name="x" :size="15" /></button>
          <span class="filter-count" data-tip="已启用工具定义的估算值；当前角色、模型协议和缓存会使实际输入不同。">已启用预计：{{ formatTokenEstimate(enabledToolTokenEstimate) }} 词元</span>
          <span class="filter-count">{{ visible.length }}/{{ allTools.length }}</span>
        </div>
        <div v-if="!visible.length" class="capability-detail-empty"><p class="muted small">{{ allTools.length ? '没有匹配的内置能力，请清空筛选条件后重试。' : '内置能力数据尚未载入，请刷新当前页。' }}</p><button v-if="!allTools.length" class="btn small outline" type="button" @click="reloadTools"><Icon name="refresh" :size="13" />刷新列表</button></div>
        <div v-else class="table-wrap capability-table-wrap">
            <table class="data-table capability-tool-table">
              <thead><tr><th data-tip="工具名称右侧数字表示启用后预计加入模型上下文的词元数。">工具（预估词元）</th><th data-tip="按工具能力和权限边界给出的概览等级。">风险</th><th>标记</th><th class="col-actions">操作</th></tr></thead>
              <tbody>
                <tr v-for="tool in visible" :key="tool.name" :data-tip="toolDescription(tool)">
                  <td class="cell-title">
                    <div class="capability-tool-name">
                      <span>{{ toolDisplayName(tool) }}</span>
                      <span v-if="tool.modelTokenEstimate" class="tool-token-estimate" :class="tool.enabled ? 'enabled' : 'disabled'" :data-tip="'启用后预计占用 ' + formatTokenEstimate(tool.modelTokenEstimate) + ' 词元；点“查看”可看到实际发送结构。'">{{ formatTokenEstimate(tool.modelTokenEstimate) }}</span>
                    </div>
                    <div v-if="toolEnglishName(tool)" class="cell-sub truncate" style="max-width:280px">{{ toolEnglishName(tool) }}</div>
                    <div class="cell-sub truncate" style="max-width:280px">{{ toolDescription(tool) }}</div>
                    <div v-if="toolDescriptionExtra(tool)" class="cell-sub truncate" style="max-width:280px;opacity:.72">{{ toolDescriptionExtra(tool) }}</div>
                  </td>
                  <td><span class="badge" :class="riskBadgeClass(toolCommon(tool).risk)">{{ riskLabel(tool) }}</span></td>
                  <td>
                    <span v-if="hasWebConfig(tool)" class="badge" :data-tip="tool.name === 'render_image' ? '调整工具和系统渲染策略' : '该工具有可配置的运行变量（如密钥、超时）'">可配置</span>
                    <span v-if="toolHasRepeatProtection(tool)" class="badge" :data-tip="toolRepeatabilityLabel(tool)">重复保护</span>
                    <span v-if="tool.name === 'dispatch_subagent' && !subAgentEnabled" class="badge risk-medium" data-tip="工具已在列表启用，但需在「模型渠道 · 对话流程 · 子代理」开启后才会真正对 AI 生效">待开启子代理</span>
                  </td>
                  <td class="col-actions">
                    <div class="capability-row-actions">
                      <button class="btn small outline" type="button" data-tip="查看工具详情" @click="openToolDetail(tool)"><Icon name="info" :size="13" />查看</button>
                      <button v-if="toolSource(tool) === 'custom'" class="btn small outline" type="button" data-tip="编辑 Custom 工具" @click="openToolDetail(tool, 'edit')"><Icon name="pencil" :size="13" />编辑</button>
                      <button v-if="hasWebConfig(tool)" class="btn small outline" type="button" :data-tip="tool.name === 'render_image' ? '调整工具和系统渲染策略' : '设置密钥等运行变量'" @click="openToolDetail(tool, 'config')"><Icon name="sliders" :size="13" />配置</button>
                    </div>
                    <Switch :model-value="tool.enabled" @update:model-value="toggleTool(tool.name, $event)" />
                  </td>
                </tr>
              </tbody>
            </table>
        </div>
      </div>
    </Panel>
  `,
}
