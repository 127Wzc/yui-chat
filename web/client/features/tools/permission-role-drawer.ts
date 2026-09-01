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
      return rows.slice(0, 80)
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
      if (row.enabled === false) return "disabled"
      return row.minRole || ""
    }
    function setOverride(bucket: OverrideBucket, id: string, value: string) {
      props.draft[bucket] ||= {}
      if (!value) delete props.draft[bucket][id]
      else if (value === "disabled") props.draft[bucket][id] = { enabled: false }
      else props.draft[bucket][id] = { enabled: true, minRole: value }
    }
    return {
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
      width="760px"
      @close="$emit('close')"
    >
      <div class="capability-relationship compact">
        <span><strong>能力开关优先</strong><small>能力中心已停用的项目，在这里无法放行。</small></span>
      </div>
      <div class="permission-role-switcher" role="tablist" aria-label="选择角色">
        <button v-for="role in BOUNDARY_ROLE_OPTIONS" :key="role.value" type="button" :class="{ active: editingRole === role.value }" @click="$emit('select-role', role.value)">{{ role.label }}</button>
      </div>
      <section class="drawer-role-verification">
        <span><strong>验证 {{ roleLabel(editingRole) }}</strong><small>按已保存配置检查实际可用与被拦截的能力。</small></span>
        <button class="btn small outline" type="button" @click="$emit('preview-role', editingRole)"><Icon name="eye" :size="14" />验证此角色</button>
      </section>
      <PermissionPreviewResult
        v-if="previewSurface === 'drawer' && previewResult?.role === editingRole"
        class="drawer-permission-preview"
        :role-name="roleLabel(previewResult.role)"
        :allowed-rows="previewAllowedRows"
        :blocked-rows="previewBlockedRows"
        :raw-value="previewResult"
        :developer-mode="developerMode"
        @close="$emit('clear-preview')"
      />
      <div class="list" style="margin-top:10px">
        <div class="item permission-editor">
          <div class="item-head">
            <div><div class="item-title truncate">{{ roleLabel(editingRole) }}</div><div class="cell-sub">先选择大范围，再用单项例外精确覆盖。</div></div>
          </div>
          <PillList :items="profilePills(editingRole)" />
          <div class="form-grid dense" style="margin-top:8px">
            <Field label="允许外网能力" type="select" :options="BOOL_OPTIONS" :model-value="String(profile(editingRole).allowExternalNetwork)" @update:model-value="profile(editingRole).allowExternalNetwork = $event === 'true'" />
            <Field label="允许高风险能力" type="select" :options="BOOL_OFF_OPTIONS" :model-value="String(profile(editingRole).allowHighRisk)" @update:model-value="profile(editingRole).allowHighRisk = $event === 'true'" />
            <Field label="使用全部已启用能力" type="select" :options="BOOL_OFF_OPTIONS" :model-value="String(profile(editingRole).allowAllEnabledTools)" @update:model-value="profile(editingRole).allowAllEnabledTools = $event === 'true'" />
          </div>
          <div class="section-title" style="margin-top:10px"><Icon name="grid" :size="13" />内置分类</div>
          <div class="toolbar wrap">
            <button
              v-for="category in builtinCategories"
              :key="category.id"
              class="btn small"
              :class="profile(editingRole).enabledCategories.includes(category.id) ? 'primary' : 'outline'"
              type="button"
              @click="toggleCategory(editingRole, category.id)"
            >{{ category.label }}</button>
          </div>
          <div class="section-title" style="margin-top:10px"><Icon name="package" :size="13" />扩展来源</div>
          <div class="toolbar wrap">
            <button
              v-for="source in BOUNDARY_SOURCE_OPTIONS"
              :key="source.value"
              class="btn small"
              :class="profile(editingRole).allowedSources.includes(source.value) ? 'primary' : 'outline'"
              type="button"
              @click="toggleSource(editingRole, source.value)"
            >{{ source.label }}</button>
          </div>
          <Collapse title="单项例外" :hint="'允许 ' + profile(editingRole).allowedTools.length + ' · 禁止 ' + profile(editingRole).deniedTools.length" nested>
            <div class="list-filter" style="margin-top:8px">
              <div class="filter-search">
                <Icon name="search" :size="14" />
                <input :value="toolFilters[editingRole]" placeholder="搜索中文名、工具 ID、说明、来源" @input="toolFilters[editingRole] = $event.target.value" />
              </div>
              <span class="filter-count">{{ toolFilterRows(editingRole).length }}/{{ selectableTools.length }}</span>
            </div>
            <p class="muted small">“跟随范围”采用上面的分类和总开关；“单独允许 / 禁止”会覆盖范围设置，适合停用组内某一项。</p>
            <div class="table-wrap" style="overflow:visible;max-height:260px;overflow:auto">
              <table class="data-table">
                <thead><tr><th>工具</th><th>来源</th><th>风险</th><th>当前状态</th><th class="col-actions">单项规则</th></tr></thead>
                <tbody>
                  <tr v-for="tool in toolFilterRows(editingRole)" :key="editingRole + ':' + tool.name">
                    <td class="cell-title">
                      {{ toolDisplayName(tool) }}
                      <div v-if="toolEnglishName(tool)" class="cell-sub truncate" style="max-width:320px">{{ toolEnglishName(tool) }}</div>
                      <div class="cell-sub truncate" style="max-width:320px">{{ toolDescription(tool) || '暂无说明' }}</div>
                    </td>
                    <td class="cell-title">{{ sourceLabel(toolSource(tool)) }} / {{ toolCommon(tool).categoryLabel || toolCommon(tool).category || '未分类' }}<div v-if="sourceTechLabel(toolSource(tool))" class="cell-sub truncate" style="max-width:180px">{{ sourceTechLabel(toolSource(tool)) }}</div></td>
                    <td><span class="badge" :class="riskBadgeClass(toolCommon(tool).risk)">{{ riskLabel(tool) }}</span></td>
                    <td><PillList :items="toolGrantState(editingRole, tool)" /></td>
                    <td class="col-actions">
                      <select class="permission-override-select" :value="toolAccessOverride(editingRole, tool.name)" @change="setToolAccessOverride(editingRole, tool.name, $event.target.value)">
                        <option value="">跟随范围</option>
                        <option value="allow">单独允许</option>
                        <option value="deny">单独禁止</option>
                      </select>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Collapse>
        </div>
      </div>

      <Collapse title="扩展与 Skill 单独限权" hint="工具来源和 Markdown Skill 分开管理，互不重复">
        <div class="list" style="margin-top:8px">
          <div class="item" v-if="customPackages.length">
            <div class="item-head"><div class="item-title">本地扩展包</div></div>
            <div class="table-wrap" style="overflow:visible">
              <table class="data-table">
                <thead><tr><th>扩展包</th><th class="col-actions">开放级别</th></tr></thead>
                <tbody>
                  <tr v-for="item in customPackages" :key="item.id">
                    <td class="cell-title">
                      {{ item.name || item.id }}
                      <div class="cell-sub truncate" style="max-width:320px">{{ item.description || item.id }}</div>
                    </td>
                    <td class="col-actions">
                      <select :value="overrideValue('customPackages', item.id)" @change="setOverride('customPackages', item.id, $event.target.value)">
                        <option v-for="opt in EXTENSION_OVERRIDE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                      </select>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="item" v-if="skillPackages.length">
            <div class="item-head"><div class="item-title">Markdown Skill 使用权限</div></div>
            <div class="table-wrap" style="overflow:visible">
              <table class="data-table">
                <thead><tr><th>Skill</th><th class="col-actions">开放级别</th></tr></thead>
                <tbody>
                  <tr v-for="item in skillPackages" :key="item.id">
                    <td class="cell-title">
                      {{ item.name || item.id }}
                      <div class="cell-sub truncate" style="max-width:320px">{{ item.description || item.id }}</div>
                    </td>
                    <td class="col-actions">
                      <select :value="overrideValue('skillPackages', item.id)" @change="setOverride('skillPackages', item.id, $event.target.value)">
                        <option v-for="opt in EXTENSION_OVERRIDE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                      </select>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="item" v-if="mcpServers.length">
            <div class="item-head"><div class="item-title">MCP 服务</div></div>
            <div class="table-wrap" style="overflow:visible">
              <table class="data-table">
                <thead><tr><th>Server</th><th class="col-actions">开放级别</th></tr></thead>
                <tbody>
                  <tr v-for="item in mcpServers" :key="item.name">
                    <td class="cell-title">
                      {{ item.name }}
                      <div class="cell-sub truncate" style="max-width:320px">{{ item.transport || 'unknown' }}</div>
                    </td>
                    <td class="col-actions">
                      <select :value="overrideValue('mcpServers', item.name)" @change="setOverride('mcpServers', item.name, $event.target.value)">
                        <option v-for="opt in EXTENSION_OVERRIDE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                      </select>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Collapse>
      <Collapse title="权限系统与验证" hint="高级设置，日常不需要修改">
        <div class="form-grid" style="margin-top:8px">
          <Field label="启用角色权限" type="select" :options="BOOL_OFF_OPTIONS" v-model="draft.enabled" tip="关闭后将不再按角色过滤能力。建议保持开启。" />
          <Field label="验证群号" v-model="draft.previewGroupId" />
          <Field label="验证用户" v-model="draft.previewUserId" />
        </div>
        <div class="action-bar">
          <button class="btn small outline" type="button" @click="$emit('preview-matrix')"><Icon name="filter" :size="14" />比较全部角色</button>
        </div>
        <PermissionMatrixTable v-if="matrixResult" :matrix="matrixResult" :rows="matrixRows" />
      </Collapse>
      <template #actions>
        <button class="btn outline" type="button" @click="$emit('close')"><Icon name="x" :size="14" />关闭</button>
        <button class="btn primary small" type="button" @click="$emit('save')"><Icon name="save" :size="14" />保存使用范围</button>
      </template>
    </SideDrawer>
  `,
}
