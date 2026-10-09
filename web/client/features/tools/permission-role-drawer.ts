import { ref } from "vue"
import {
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
  roleLabel,
  roleProfile,
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
    function overrideValue(bucket: OverrideBucket, id: string): string {
      const value = props.draft[bucket]?.[id]?.roles?.[props.editingRole]
      return value === true ? "allow" : value === false ? "deny" : ""
    }
    function setOverride(bucket: OverrideBucket, id: string, value: string) {
      props.draft[bucket][id] ||= { roles: {} }
      const roles = props.draft[bucket][id].roles ||= {}
      if (!value) delete roles[props.editingRole]
      else roles[props.editingRole] = value === "allow"
    }
    const section = ref("exceptions")
    return {
      section,
              BOUNDARY_ROLE_OPTIONS,
              roleLabel,
      profile,
      toolAccessOverride,
      setToolAccessOverride,
      toolFilterRows,
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
          <button v-for="tab in [['exceptions','工具角色授权'],['packages','扩展与 MCP']]" :key="tab[0]" :class="{ active: section === tab[0] }" :aria-pressed="section === tab[0]" @click="section = tab[0]">{{ tab[1] }}</button>
        </div>
        <template v-if="section === 'exceptions'">
          <p class="muted small">内置工具未设置时按默认角色表开放，扩展继承包或服务；风险仅作标签，授权不会赋予群管理身份。</p>
          <p class="muted small">禁言、群名片、头衔未设置规则时默认允许本人操作；明确禁止可关闭本人操作。单独允许 {{ profile(editingRole).allowedTools.length }} · 单独禁止 {{ profile(editingRole).deniedTools.length }}。单独允许仍受能力开关和工具硬性要求限制。</p>
          <div class="filter-search"><Icon name="search" :size="14" /><input :value="toolFilters[editingRole]" aria-label="搜索单项工具" placeholder="搜索名称、ID、说明或来源" @input="toolFilters[editingRole] = $event.target.value" /></div>
          <PagedList :rows="toolFilterRows(editingRole)" :page-size="8" label="工具" empty="没有匹配的工具。" list-class="permission-edit-items" v-slot="{ item: tool }">
            <div class="permission-edit-item"><div><strong>{{ toolDisplayName(tool) }}</strong><small>{{ tool.name }} · {{ sourceLabel(toolSource(tool)) }}</small><span class="badge" :class="riskBadgeClass(toolCommon(tool).risk)">{{ riskLabel(tool) }}</span></div><select :aria-label="toolDisplayName(tool) + '单项规则'" :value="toolAccessOverride(editingRole, tool.name)" @change="setToolAccessOverride(editingRole, tool.name, $event.target.value)"><option value="">未设置（本人自助／默认／继承）</option><option value="allow">允许此角色</option><option value="deny">禁止此角色</option></select></div>
          </PagedList>
        </template>
        <template v-else>
          <p class="muted small">仅设置当前角色对扩展包、Skill 和 MCP 服务的权限。包或服务禁止优先于逐工具允许。</p>
          <section v-for="group in [{key:'customPackages',label:'本地扩展包',rows:customPackages},{key:'skillPackages',label:'Markdown Skill',rows:skillPackages},{key:'mcpServers',label:'MCP 服务',rows:mcpServers}]" :key="group.key" class="permission-edit-section">
            <h3>{{ group.label }} <span class="muted">{{ group.rows.length }}</span></h3>
            <p v-if="!group.rows.length" class="muted small">暂无项目</p>
            <div v-for="item in group.rows" :key="item.id || item.name" class="permission-edit-item"><div><strong>{{ item.name || item.id }}</strong><small>{{ item.description || item.transport || item.id }}</small></div><select :aria-label="(item.name || item.id) + '开放级别'" :value="overrideValue(group.key, group.key === 'mcpServers' ? (item.name || item.id) : item.id)" @change="setOverride(group.key, group.key === 'mcpServers' ? (item.name || item.id) : item.id, $event.target.value)"><option value="">默认仅主人</option><option value="allow">允许</option><option value="deny">禁止</option></select></div>
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
