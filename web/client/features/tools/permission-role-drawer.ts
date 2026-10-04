import { ref } from "vue"
import {
  BOOL_OFF_OPTIONS,
  BOOL_OPTIONS,
  riskBadgeClass,
  riskLabel,
  sourceLabel,
  sourceTechLabel,
  toolCommon,
  toolDescription,
  toolDisplayName,
  toolEnglishName,
  toolSource,
} from "./shared.js"
import {
  BOUNDARY_ROLE_OPTIONS,
  BOUNDARY_SOURCE_OPTIONS,
  EXTENSION_OVERRIDE_OPTIONS,
  roleLabel,
  roleProfile,
  toggleInList,
  type OverrideBucket,
  type PackageItem,
  type PermissionDraft,
  type RoleProfile,
  type ToolItem,
} from "./permission-shared.js"
import { PermissionMatrixTable, PermissionPreviewResult } from "./permission-preview.js"

// 规则编辑抽屉：角色切换、范围开关、单项例外与扩展限权；草稿对象由父组件持有，动作全部上浮。
export const PermissionRoleDrawer = {
  name: "PermissionRoleDrawer",
  components: { PermissionPreviewResult, PermissionMatrixTable },
  props: {
    open: Boolean,
    editingRole: { type: String, default: "user" },
    draft: { type: Object, required: true },
    toolFilters: { type: Object, required: true },
    selectableTools: { type: Array, default: () => [] },
    builtinCategories: { type: Array, default: () => [] },
    customPackages: { type: Array, default: () => [] },
    skillPackages: { type: Array, default: () => [] },
    mcpServers: { type: Array, default: () => [] },
    previewResult: { type: Object, default: null },
    previewSurface: { type: String, default: "" },
    previewAllowedRows: { type: Array, default: () => [] },
    previewBlockedRows: { type: Array, default: () => [] },
    matrixResult: { type: Object, default: null },
    matrixRows: { type: Array, default: () => [] },
    developerMode: { type: Boolean, default: false },
  },
  emits: ["close", "save", "select-role", "preview-role", "preview-matrix", "clear-preview"],
  setup(props: {
    editingRole: string
    draft: PermissionDraft
    toolFilters: Record<string, string>
    selectableTools: ToolItem[]
    customPackages: PackageItem[]
    skillPackages: PackageItem[]
    mcpServers: PackageItem[]
  }) {
    function profile(role: string): RoleProfile {
      return roleProfile(props.draft.roles, role)
    }
    function toggleCategory(role: string, category: string) {
      const target = profile(role)
      target.enabledCategories = toggleInList(target.enabledCategories, category)
    }
    function toggleSource(role: string, source: string) {
      const target = profile(role)
      target.allowedSources = toggleInList(target.allowedSources, source)
    }
    function toolAccessOverride(role: string, toolName: string): string {
      const target = profile(role)
      if (target.deniedTools.includes(toolName)) return "deny"
      if (target.allowedTools.includes(toolName)) return "allow"
      return ""
    }
    function setToolAccessOverride(role: string, toolName: string, value: string) {
      const target = profile(role)
      target.allowedTools = target.allowedTools.filter(name => name !== toolName)
      target.deniedTools = target.deniedTools.filter(name => name !== toolName)
      if (value === "allow") target.allowedTools.push(toolName)
      if (value === "deny") target.deniedTools.push(toolName)
    }
    function toolGrantState(role: string, tool: ToolItem = { name: "" }) {
      const common = toolCommon(tool)
      const target = profile(role)
      const states = []
      if ((target.deniedTools || []).includes(tool.name)) return [{ label: "单独禁止", tone: "risk-high" }]
      if ((target.allowedTools || []).includes(tool.name)) return [{ label: "单独允许", tone: "accent" }]
      if (target.allowAllEnabledTools) states.push({ label: "全部已开", active: true })
      if (common.source === "builtin" && (target.enabledCategories || []).includes(String(common.category || ""))) {
        states.push({ label: "分类已开" })
      } else if (common.source !== "builtin" && (target.allowedSources || []).includes(String(common.source || ""))) {
        states.push({ label: "来源已开" })
      }
      return states
    }
    function toolFilterRows(role: string): ToolItem[] {
      const query = String(props.toolFilters[role] || "").trim().toLowerCase()
      const target = profile(role)
      const selected = new Set([...(target.allowedTools || []), ...(target.deniedTools || [])])
      const rows = props.selectableTools
        .filter(tool => !query || [toolCommon(tool).displayNameZh, tool.name, toolCommon(tool).descriptionZh, toolCommon(tool).description, toolSource(tool), toolCommon(tool).categoryLabel, toolCommon(tool).category]
          .join(" ").toLowerCase().includes(query))
        .sort((a, b) => {
          const aSelected = selected.has(a.name) ? 1 : 0
          const bSelected = selected.has(b.name) ? 1 : 0
          if (aSelected !== bSelected) return bSelected - aSelected
          const sourceOrder: Record<string, number> = { builtin: 0, custom: 1, skill: 2, mcp: 3 }
          const left = sourceOrder[toolSource(a)] ?? 99
          const right = sourceOrder[toolSource(b)] ?? 99
          if (left !== right) return left - right
          return toolDisplayName(a).localeCompare(toolDisplayName(b), "zh-Hans-CN")
        })
      return rows
    }
    function profilePills(role: string) {
      const target = profile(role)
      const labels = []
      if (target.allowAllEnabledTools) labels.push({ label: "全部已启用工具", active: true })
      if (target.allowHighRisk) labels.push({ label: "高风险", tone: "risk-high" })
      if (target.allowExternalNetwork) labels.push({ label: "外网", tone: "accent" })
      if (target.allowedTools?.length) labels.push({ label: `单独允许 ${target.allowedTools.length}`, tone: "accent" })
      if (target.deniedTools?.length) labels.push({ label: `单独禁止 ${target.deniedTools.length}`, tone: "risk-high" })
      if (target.allowedSources?.length) labels.push({ label: `扩展 ${target.allowedSources.length}` })
      if (target.enabledCategories?.length) labels.push({ label: `内置分类 ${target.enabledCategories.length}` })
      return labels
    }
    function overrideValue(bucket: OverrideBucket, id: string): string {
      const row = props.draft[bucket]?.[id]
      if (!row) return ""
      if (row.roles && Object.keys(row.roles).length) return "custom"
      if (row.enabled === false) return "disabled"
      return row.minRole || ""
    }
    function setOverride(bucket: OverrideBucket, id: string, value: string) {
      if (value === "custom") return
      props.draft[bucket] ||= {}
      if (!value) delete props.draft[bucket][id]
      else if (value === "disabled") props.draft[bucket][id] = { enabled: false }
      else props.draft[bucket][id] = { enabled: true, minRole: value }
    }
    const section = ref("range")
    return {
      section,
      BOOL_OPTIONS,
      BOOL_OFF_OPTIONS,
      BOUNDARY_ROLE_OPTIONS,
      BOUNDARY_SOURCE_OPTIONS,
      EXTENSION_OVERRIDE_OPTIONS,
      roleLabel,
      profile,
      toggleCategory,
      toggleSource,
      toolAccessOverride,
      setToolAccessOverride,
      toolGrantState,
      toolFilterRows,
      profilePills,
      overrideValue,
      setOverride,
      sourceLabel,
      sourceTechLabel,
      toolCommon,
      toolSource,
      riskBadgeClass,
      riskLabel,
      toolDescription,
      toolDisplayName,
      toolEnglishName,
    }
  },
  template: `
    <SideDrawer
      :open="open"
      :title="'编辑' + roleLabel(editingRole) + '的使用范围'"
      subtitle="只管理谁能使用已启用能力；不会启用或停用能力本身。"
      icon="key"
      width="680px"
      @close="$emit('close')"
    >
      <div class="permission-edit-layout">
        <div class="permission-role-switcher" role="group" aria-label="选择角色">
          <button v-for="role in BOUNDARY_ROLE_OPTIONS" :key="role.value" type="button" :class="{ active: editingRole === role.value }" :aria-pressed="editingRole === role.value" @click="$emit('select-role', role.value)"><span class="role-dot role-identity" :data-role="role.value"></span>{{ role.label }}</button>
        </div>
        <div class="permission-edit-tabs segmented" role="group" aria-label="编辑内容">
          <button v-for="tab in [['range','默认范围'],['exceptions','单项例外'],['packages','扩展限权']]" :key="tab[0]" :class="{ active: section === tab[0] }" :aria-pressed="section === tab[0]" @click="section = tab[0]">{{ tab[1] }}</button>
        </div>
        <template v-if="section === 'range'">
          <div class="permission-setting-row"><span><strong>使用全部已启用工具</strong><small>开启后不按下方分类与来源筛选，风险限制和单项禁止仍生效。</small></span><Switch :model-value="profile(editingRole).allowAllEnabledTools" @update:model-value="profile(editingRole).allowAllEnabledTools = $event" /></div>
          <div class="permission-setting-row"><span><strong>允许外网能力</strong><small>允许使用需要访问外部网络的工具。</small></span><Switch :model-value="profile(editingRole).allowExternalNetwork" @update:model-value="profile(editingRole).allowExternalNetwork = $event" /></div>
          <div class="permission-setting-row"><span><strong>允许高风险能力</strong><small>仍需满足工具自身的角色与场景要求。</small></span><Switch :model-value="profile(editingRole).allowHighRisk" @update:model-value="profile(editingRole).allowHighRisk = $event" /></div>
          <template v-if="!profile(editingRole).allowAllEnabledTools">
            <section class="permission-edit-section"><h3>内置分类</h3><div class="permission-choice-list"><button v-for="category in builtinCategories" :key="category.id" class="btn small outline" :class="{ active: profile(editingRole).enabledCategories.includes(category.id) }" :aria-pressed="profile(editingRole).enabledCategories.includes(category.id)" @click="toggleCategory(editingRole, category.id)">{{ category.label }}</button></div></section>
            <section class="permission-edit-section"><h3>扩展来源</h3><div class="permission-choice-list"><button v-for="source in BOUNDARY_SOURCE_OPTIONS" :key="source.value" class="btn small outline" :class="{ active: profile(editingRole).allowedSources.includes(source.value) }" :aria-pressed="profile(editingRole).allowedSources.includes(source.value)" @click="toggleSource(editingRole, source.value)">{{ source.label }}</button></div></section>
          </template>
          <Collapse title="全局控制" hint="影响全部角色" nested>
            <div class="permission-setting-row"><span><strong>启用角色权限</strong><small>关闭后不再按角色过滤能力。</small></span><Switch :model-value="draft.enabled === 'true'" @update:model-value="draft.enabled = String($event)" /></div>
          </Collapse>
        </template>
        <template v-else-if="section === 'exceptions'">
          <p class="muted small">单独允许 {{ profile(editingRole).allowedTools.length }} · 单独禁止 {{ profile(editingRole).deniedTools.length }}。单独允许仍受能力开关和工具硬性要求限制。</p>
          <div class="filter-search"><Icon name="search" :size="14" /><input :value="toolFilters[editingRole]" aria-label="搜索单项工具" placeholder="搜索名称、ID、说明或来源" @input="toolFilters[editingRole] = $event.target.value" /></div>
          <PagedList :rows="toolFilterRows(editingRole)" :page-size="8" label="工具" empty="没有匹配的工具。" list-class="permission-edit-items" v-slot="{ item: tool }">
            <div class="permission-edit-item"><div><strong>{{ toolDisplayName(tool) }}</strong><small>{{ tool.name }} · {{ sourceLabel(toolSource(tool)) }}</small><span class="badge" :class="riskBadgeClass(toolCommon(tool).risk)">{{ riskLabel(tool) }}</span></div><select :aria-label="toolDisplayName(tool) + '单项规则'" :value="toolAccessOverride(editingRole, tool.name)" @change="setToolAccessOverride(editingRole, tool.name, $event.target.value)"><option value="">跟随角色默认</option><option value="allow">单独允许</option><option value="deny">单独禁止</option></select></div>
          </PagedList>
        </template>
        <template v-else>
          <p class="muted small">这里设置扩展整体开放级别，影响全部角色。已有按角色单独设置的项目，可在能力列表中精确调整。</p>
          <section v-for="group in [{key:'customPackages',label:'本地扩展包',rows:customPackages},{key:'skillPackages',label:'Markdown Skill',rows:skillPackages},{key:'mcpServers',label:'MCP 服务',rows:mcpServers}]" :key="group.key" class="permission-edit-section">
            <h3>{{ group.label }} <span class="muted">{{ group.rows.length }}</span></h3>
            <p v-if="!group.rows.length" class="muted small">暂无项目</p>
            <div v-for="item in group.rows" :key="item.id || item.name" class="permission-edit-item"><div><strong>{{ item.name || item.id }}</strong><small>{{ item.description || item.transport || item.id }}</small></div><select :aria-label="(item.name || item.id) + '开放级别'" :value="overrideValue(group.key, group.key === 'mcpServers' ? (item.name || item.id) : item.id)" @change="setOverride(group.key, group.key === 'mcpServers' ? (item.name || item.id) : item.id, $event.target.value)"><option value="custom" disabled>已按角色单独设置</option><option v-for="opt in EXTENSION_OVERRIDE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option></select></div>
          </section>
        </template>
        <Collapse title="验证已保存权限" hint="不含本次未保存修改" nested>
          <div class="form-grid"><Field label="验证群号" v-model="draft.previewGroupId" /><Field label="验证用户" v-model="draft.previewUserId" /></div>
          <div class="toolbar wrap"><button class="btn small outline" @click="$emit('preview-role', editingRole)">验证此角色</button><button class="btn small outline" @click="$emit('preview-matrix')">比较全部角色</button></div>
          <PermissionPreviewResult v-if="previewSurface === 'drawer' && previewResult?.role === editingRole" :role-name="roleLabel(previewResult.role)" :allowed-rows="previewAllowedRows" :blocked-rows="previewBlockedRows" :raw-value="previewResult" :developer-mode="developerMode" @close="$emit('clear-preview')" />
          <PermissionMatrixTable v-if="matrixResult" :matrix="matrixResult" :rows="matrixRows" />
        </Collapse>
      </div>
      <template #actions>
        <button class="btn outline" type="button" @click="$emit('close')"><Icon name="x" :size="14" />关闭</button>
        <button class="btn primary small" type="button" @click="$emit('save')"><Icon name="save" :size="14" />保存使用范围</button>
      </template>
    </SideDrawer>
  `,
}
