import { computed, reactive, ref } from "vue"
import { confirmAction, refreshTab, request, saveConfigPatch, store, toast } from "../../app/store/store.js"
import { isFoldedRenderTool, toolCommon, toolDisplayName, toolSource } from "./shared.js"
import { asRecord, asRecords, errorMessage } from "../../shared/data.js"
import {
  BOUNDARY_CATEGORY_ORDER,
  BOUNDARY_ROLE_OPTIONS,
  PREVIEW_ROLE_OPTIONS,
  draftToolAllowed,
  normalizeBoundaryAccess,
  roleLabel,
  roleProfile,
  type AccessPreviewTool,
  type MatrixResult,
  type PackageItem,
  type PermissionConfigRoot,
  type PermissionDraft,
  type PreviewResult,
  type ToolItem,
  type ToolsSlice,
} from "./permission-shared.js"
import { PermissionPreviewDrawer } from "./permission-preview-drawer.js"
import { PermissionRoleGrid } from "./permission-role-grid.js"
import { PermissionRoleDrawer } from "./permission-role-drawer.js"

// 兼容既有外部导入；实现以 permission-shared.js 为准。
export { BOUNDARY_ROLE_OPTIONS } from "./permission-shared.js"

export const BoundaryAccessPanel = {
  name: "BoundaryAccessPanel",
  components: { PermissionPreviewDrawer, PermissionRoleGrid, PermissionRoleDrawer },
  setup() {
    const current = normalizeBoundaryAccess(asRecord<PermissionConfigRoot>(store.config).tools?.boundaryAccess || {})
    const draft = reactive<PermissionDraft>({
      enabled: String(Boolean(current.enabled)),
      previewRole: "user",
      previewGroupId: "20001",
      previewUserId: "10001",
      roles: JSON.parse(JSON.stringify(current.roles || {})),
      customPackages: JSON.parse(JSON.stringify(current.customPackages || {})),
      skillPackages: JSON.parse(JSON.stringify(current.skillPackages || {})),
      mcpServers: JSON.parse(JSON.stringify(current.mcpServers || {})),
    })
    const previewResult = ref<PreviewResult | null>(null)
    const previewSurface = ref("")
    const matrixResult = ref<MatrixResult | null>(null)
    const showDrawer = ref(false)
    const showPreviewDrawer = ref(false)
    const editingRole = ref("user")

    const builtinCategories = computed(() => {
      const rows = asRecords<ToolItem>(asRecord<ToolsSlice>(store.tools).tools)
        .filter(tool => toolSource(tool) === "builtin" && !isFoldedRenderTool(tool))
      const byCategory = new Map<string, { id: string; label: string }>()
      for (const tool of rows) {
        const common = toolCommon(tool)
        if (!common.category || byCategory.has(common.category)) continue
        byCategory.set(String(common.category), { id: String(common.category), label: String(common.categoryLabel || common.category) })
      }
      return [...byCategory.values()].sort((a, b) => {
        const ai = BOUNDARY_CATEGORY_ORDER.indexOf(a.id)
        const bi = BOUNDARY_CATEGORY_ORDER.indexOf(b.id)
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
      })
    })
    const selectableTools = computed<ToolItem[]>(() => {
      const rows = asRecords<ToolItem>(asRecord<ToolsSlice>(store.tools).tools).filter(tool => !isFoldedRenderTool(tool) && tool.enabled)
      return [...rows].sort((a, b) => {
        const sourceOrder: Record<string, number> = { builtin: 0, custom: 1, skill: 2, mcp: 3 }
        const left = sourceOrder[toolSource(a)] ?? 99
        const right = sourceOrder[toolSource(b)] ?? 99
        if (left !== right) return left - right
        return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN")
      })
    })
    const customPackages = computed<PackageItem[]>(() => asRecord<ToolsSlice>(store.tools).custom?.catalog || [])
    const skillPackages = computed<PackageItem[]>(() => asRecord<ToolsSlice>(store.tools).skills?.catalog || [])
    const mcpServers = computed<PackageItem[]>(() => asRecord<ToolsSlice>(store.tools).mcp?.servers || [])
    const toolFilters = reactive<Record<string, string>>(Object.fromEntries(BOUNDARY_ROLE_OPTIONS.map(item => [item.value, ""])))

    const roleSummaries = computed(() => BOUNDARY_ROLE_OPTIONS.map(role => {
      const profile = roleProfile(draft.roles, role.value)
      const allowedCount = selectableTools.value.filter(tool => draftToolAllowed(profile, tool)).length
      const totalCount = selectableTools.value.length
      return {
        ...role,
        summary: `可使用 ${allowedCount} / ${totalCount} 项已启用能力`,
        allowedCount,
        totalCount,
        deniedCount: profile.deniedTools?.length || 0,
        external: profile.allowExternalNetwork,
        highRisk: profile.allowHighRisk,
        all: profile.allowAllEnabledTools,
      }
    }))
    function openRole(role: string) {
      editingRole.value = role
      draft.previewRole = role
      showDrawer.value = true
    }
    function selectEditingRole(role: string) {
      editingRole.value = role
      draft.previewRole = role
      if (previewSurface.value === "drawer" && previewResult.value?.role !== role) previewResult.value = null
    }
    const previewAllowedRows = computed(() => (previewResult.value?.allowed || []).map(name => {
      const tool = asRecords<ToolItem>(asRecord<ToolsSlice>(store.tools).tools).find(item => item.name === name)
      return { name, label: tool ? toolDisplayName(tool) : name }
    }))
    const previewBlockedRows = computed(() => (previewResult.value?.blocked || []).map(item => {
      const tool = asRecords<ToolItem>(asRecord<ToolsSlice>(store.tools).tools).find(row => row.name === item.name)
      return { ...item, label: tool ? toolDisplayName(tool) : item.name }
    }))
    async function save() {
      try {
        const accepted = await confirmAction({ title: "保存角色与扩展权限？", message: "新的使用范围会立即影响所有用户、管理员和主人可见的工具与 Skill。", confirmText: "确认保存权限", tone: "warn", icon: "key" })
        if (!accepted) return
        await saveConfigPatch({
          "tools.boundaryAccess": normalizeBoundaryAccess({
            enabled: draft.enabled === "true",
            roles: draft.roles,
            customPackages: draft.customPackages,
            skillPackages: draft.skillPackages,
            mcpServers: draft.mcpServers,
          }),
        })
        toast("边界权限已保存")
        await refreshTab("tools")
      } catch (err) { toast(errorMessage(err)) }
    }
    function clearPreview() {
      previewResult.value = null
      matrixResult.value = null
      previewSurface.value = ""
    }
    function closePreviewDrawer() {
      showPreviewDrawer.value = false
      clearPreview()
    }
    async function openRolePreview(role: string) {
      await previewAccess(role, "preview")
      if (previewResult.value?.role === role) showPreviewDrawer.value = true
    }
    async function previewAccess(role: string = draft.previewRole, surface = "card") {
      try {
        if (typeof role === "string") draft.previewRole = role
        const query = new URLSearchParams({ role: draft.previewRole, groupId: draft.previewGroupId, userId: draft.previewUserId })
        const result = asRecord<{ tools?: AccessPreviewTool[] }>(await request(`/api/tools/access-preview?${query}`))
        const tools = result.tools || []
        const allowed = tools.filter(t => t.access?.allowed)
        const blocked = tools.filter(t => !t.access?.allowed && t.enabled)
        previewResult.value = { role: draft.previewRole, allowed: allowed.map(t => t.name), blocked: blocked.map(t => ({ name: t.name, reason: t.access?.reason })) }
        previewSurface.value = surface
        matrixResult.value = null
      } catch (err) { toast(errorMessage(err)) }
    }
    async function previewMatrix() {
      try {
        const query = new URLSearchParams({ groupId: draft.previewGroupId, userId: draft.previewUserId })
        const result = asRecord<{ matrix?: MatrixResult }>(await request(`/api/tools/access-matrix?${query}`))
        matrixResult.value = result.matrix || null
        previewResult.value = null
        previewSurface.value = "preview"
        showPreviewDrawer.value = true
        toast("工具权限矩阵已生成")
      } catch (err) { toast(errorMessage(err)) }
    }
    const matrixRows = computed(() => {
      const m = matrixResult.value
      if (!m) return []
      const roles = m.roles || []
      return (m.rows || []).filter(row => row.tool?.enabled && roles.some(role => !row.decisions?.[role]?.allowed)).slice(0, 28)
    })
    return {
      store,
      draft,
      previewResult,
      previewSurface,
      matrixResult,
      matrixRows,
      showDrawer,
      showPreviewDrawer,
      editingRole,
      save,
      previewAccess,
      previewMatrix,
      clearPreview,
      closePreviewDrawer,
      openRolePreview,
      BOUNDARY_ROLE_OPTIONS,
      builtinCategories,
      selectableTools,
      customPackages,
      skillPackages,
      mcpServers,
      toolFilters,
      roleLabel,
      roleSummaries,
      openRole,
      selectEditingRole,
      previewAllowedRows,
      previewBlockedRows,
    }
  },
  template: `
    <Panel title="角色使用范围" icon="key">
      <template #actions>
        <button class="btn small outline" type="button" @click="openRole(draft.previewRole)"><Icon name="sliders" :size="14" />配置角色权限</button>
      </template>
      <PermissionRoleDrawer
        :open="showDrawer"
        :editing-role="editingRole"
        :draft="draft"
        :tool-filters="toolFilters"
        :selectable-tools="selectableTools"
        :builtin-categories="builtinCategories"
        :custom-packages="customPackages"
        :skill-packages="skillPackages"
        :mcp-servers="mcpServers"
        :preview-result="previewResult"
        :preview-surface="previewSurface"
        :preview-allowed-rows="previewAllowedRows"
        :preview-blocked-rows="previewBlockedRows"
        :matrix-result="matrixResult"
        :matrix-rows="matrixRows"
        :developer-mode="store.developerMode"
        @close="showDrawer = false"
        @save="save"
        @select-role="selectEditingRole"
        @preview-role="previewAccess($event, 'drawer')"
        @preview-matrix="previewMatrix"
        @clear-preview="clearPreview"
      />
      <PermissionPreviewDrawer
        :open="showPreviewDrawer"
        :role-name="previewResult ? roleLabel(previewResult.role) : ''"
        :preview-result="previewResult"
        :allowed-rows="previewAllowedRows"
        :blocked-rows="previewBlockedRows"
        :matrix-result="matrixResult"
        :matrix-rows="matrixRows"
        :developer-mode="store.developerMode"
        @close="closePreviewDrawer"
        @preview-matrix="previewMatrix"
      />
      <PillList :items="[
        { label: draft.enabled === 'true' ? '角色权限已生效' : '角色权限未生效', active: draft.enabled === 'true' },
        { label: '角色 ' + BOUNDARY_ROLE_OPTIONS.length },
        { label: '预览 ' + roleLabel(draft.previewRole), tone: 'accent' }
      ]" />
      <div class="capability-relationship compact permission-intro"><span><strong>这里不启停能力</strong><small>只决定能力中心里“已启用”的项目由哪些角色使用。</small></span></div>
      <PermissionRoleGrid
        :summaries="roleSummaries"
        :previewed-role="previewResult?.role || ''"
        @open-role="openRole"
        @preview-role="openRolePreview"
      />
    </Panel>
  `,
}
