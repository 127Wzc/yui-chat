import { computed, inject, onBeforeUnmount, reactive, ref, watch, type Ref } from "vue"
import { store, request, toast, confirmAction, setDirtyScope } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage } from "../../shared/data.js"
import { CapabilityFilterBar } from "./capability-filter-bar.js"
import { CapabilityRisk } from "./capability-list.js"
import { BOUNDARY_ROLE_OPTIONS, type MatrixRow, type MatrixResult } from "./permission-shared.js"
import { toolDisplayName, toolSource, sourceLabel } from "./shared.js"

/** 读取服务端决策；单项编辑只提交指定工具和角色，不能覆盖整份角色草稿。 */
export const PermissionOverview = {
  components: { CapabilityFilterBar, CapabilityRisk },
  props: { editingBlocked: Boolean },
  emits: ["open-role"],
  setup(props: { editingBlocked: boolean }) {
    const saved = inject<Ref<MatrixResult | null>>("capabilityAccessMatrix", ref(null))
    const saving = inject<Ref<boolean>>("capabilityAccessSaving", ref(false))
    const reload = inject<() => Promise<void>>("reloadCapabilityAccess", async () => {})
    const mode = ref("overview")
    const filter = reactive({ query: "", status: "all", source: "all", differences: false })
    const context = reactive({ role: "user", userId: "", groupId: "" })
    const submitted = ref("")
    const queried = ref<MatrixResult | null>(null)
    const busy = ref(false)
    const error = ref("")
    let generation = 0
    const contextKey = () => JSON.stringify(context)
    const stale = computed(() => submitted.value !== contextKey())
    const matrix = computed(() => mode.value === "overview" ? saved.value : stale.value ? null : queried.value)
    const roles = computed(() => mode.value === "query" ? BOUNDARY_ROLE_OPTIONS.filter(r => r.value === context.role) : BOUNDARY_ROLE_OPTIONS)
    const boundary = computed(() => asRecord(asRecord(store.config?.tools).boundaryAccess))
    const selected = ref<{ name: string; role: string } | null>(null)
    const override = ref("default")
    const feedback = ref("")
    function savedOverride(name: string, role: string) {
      const profile = asRecord(asRecord(boundary.value.roles)[role])
      return Array.isArray(profile.deniedTools) && profile.deniedTools.includes(name) ? "deny"
        : Array.isArray(profile.allowedTools) && profile.allowedTools.includes(name) ? "allow" : "default"
    }
    watch(() => selected.value ? `${selected.value.name}:${selected.value.role}:${override.value}:${savedOverride(selected.value.name, selected.value.role)}` : "", () => {
      setDirtyScope("permission-single", !!selected.value && override.value !== savedOverride(selected.value.name, selected.value.role))
    })
    onBeforeUnmount(() => setDirtyScope("permission-single", false))
    const rows = computed(() => asRecords<MatrixRow>(matrix.value?.rows).filter(row => {
      const decisions = roles.value.map(role => row.decisions?.[role.value])
      const query = filter.query.trim().toLowerCase()
      return (!query || [toolDisplayName(row.tool), row.tool.name, ...decisions.map(d => d?.reason || "")].join(" ").toLowerCase().includes(query))
        && (filter.source === "all" || toolSource(row.tool) === filter.source)
        && (!filter.differences || new Set(BOUNDARY_ROLE_OPTIONS.map(role => row.decisions?.[role.value]?.allowed)).size > 1)
        && (filter.status === "all" || (filter.status === "blocked" ? decisions.some(d => !d?.allowed) : roles.value.some(r => savedOverride(row.tool.name, r.value) !== "default")))
    }))
    const selectedRow = computed(() => asRecords<MatrixRow>(matrix.value?.rows).find(r => r.tool.name === selected.value?.name))
    const selectedDecision = computed(() => selected.value ? selectedRow.value?.decisions?.[selected.value.role] : null)
    const selectedLabel = computed(() => BOUNDARY_ROLE_OPTIONS.find(r => r.value === selected.value?.role)?.label || "")
    async function queryAccess() {
      const token = ++generation
      const key = contextKey()
      const params = new URLSearchParams({ userId: context.userId.trim(), groupId: context.groupId.trim() })
      busy.value = true; error.value = ""; queried.value = null
      try {
        const result = await request(`/api/tools/access-matrix?${params}`)
        if (token === generation) { queried.value = asRecord<MatrixResult>(result.matrix); submitted.value = key }
      } catch (err) { if (token === generation) error.value = errorMessage(err) }
      finally { if (token === generation) busy.value = false }
    }
    watch([() => store.config, () => saved.value], () => { generation++; busy.value = false; queried.value = null; submitted.value = "" })
    function open(row: MatrixRow, role: string) {
      selected.value = { name: row.tool.name, role }
      override.value = savedOverride(row.tool.name, role)
      feedback.value = ""
    }
    async function saveItem() {
      const target = selected.value
      if (!target || saving.value || props.editingBlocked || !selectedRow.value) return
      const allowed = override.value === "default" ? null : override.value === "allow"
      const accepted = await confirmAction({ title: "保存单项角色权限？", message: `仅调整 ${selectedLabel.value} 对 ${toolDisplayName(selectedRow.value.tool)} 的权限：${override.value === 'default' ? '不单独设置' : allowed ? '单独允许' : '单独禁止'}。此设置作用于该角色的所有用户，不是仅对查询中的 QQ 或群号授权。工具硬性要求仍会检查。`, confirmText: "保存此项", tone: "warn", icon: "key" })
      if (!accepted) return
      saving.value = true
      try {
        const result = await request("/api/tools/access-role", { method: "POST", body: JSON.stringify({ scope: "tool", id: target.name, role: target.role, allowed }) })
        store.config = asRecord(result.config)
        await reload()
        if (mode.value === "query") await queryAccess()
        feedback.value = "已保存；下方为重新验证后的实际结果。"
        toast("单项权限已保存")
      } catch (err) { feedback.value = errorMessage(err); toast(feedback.value) }
      finally { saving.value = false }
    }
    function reset() { filter.query = ""; filter.status = "all"; filter.source = "all"; filter.differences = false }
    return { mode, filter, context, matrix, rows, roles, stale, busy, error, queryAccess, reset, savedOverride, open, selected, selectedRow, selectedDecision, selectedLabel, override, saveItem, feedback, saving, boundary, toolDisplayName, toolSource, sourceLabel, BOUNDARY_ROLE_OPTIONS }
  },
  template: `
    <section class="permission-overview">
      <div class="permission-overview-toolbar">
        <div class="segmented" aria-label="权限查看方式"><button :class="{ active: mode === 'overview' }" @click="mode = 'overview'; selected = null">权限总览</button><button :class="{ active: mode === 'query' }" @click="mode = 'query'; selected = null">权限查询</button></div>
        <div class="permission-overview-options"><span class="permission-boundary-status active">角色规则 + 用户例外</span><button class="btn small outline permission-difference-toggle" :class="{ active: filter.differences }" :aria-pressed="filter.differences" @click="filter.differences = !filter.differences"><Icon name="sliders" :size="13" />只看角色差异</button></div>
      </div>
      <div v-if="mode === 'query'" class="permission-context-fields">
        <label>角色<select v-model="context.role"><option v-for="role in BOUNDARY_ROLE_OPTIONS" :value="role.value">{{ role.label }}</option></select></label>
        <label>用户 QQ<input v-model="context.userId" placeholder="留空仅验证角色" /></label>
        <label>群号<input v-model="context.groupId" placeholder="留空使用示例 20001" /></label>
        <button class="btn primary small" :disabled="busy" @click="queryAccess">{{ busy ? '查询中…' : '查询权限' }}</button>
      </div>
      <p v-if="mode === 'query'" class="muted small">按所选角色模拟群聊权限；用户 QQ 留空时不应用用户例外，群号留空使用示例 20001。查询不会修改权限。</p>
      <CapabilityFilterBar v-model:query="filter.query" v-model:status="filter.status" v-model:category="filter.source" :category-options="[['all','全部来源'],['builtin','内置能力'],['custom','Custom'],['mcp','MCP']]" :status-options="[['all','全部结果'],['blocked','有禁止项'],['override','单独设置']]" :count="rows.length" :total="matrix?.rows?.length || 0" placeholder="搜索能力名称、ID 或限制原因" @reset="reset" />
      <p v-if="error" class="danger small">{{ error }}</p>
      <p v-if="!matrix" class="muted small">{{ mode === 'query' ? '请查询当前条件，查看实际权限结果。' : '权限结果尚未载入，请刷新管理台重试。' }}</p>
      <template v-else>
        <div class="permission-comparison-head"><span>能力 / 风险</span><button v-for="role in roles" :key="role.value" class="permission-role-column" :title="'配置' + role.label + '的默认权限'" @click="$emit('open-role', role.value)"><span><span class="role-dot role-identity" :data-role="role.value"></span>{{ role.label }} <Icon name="sliders" :size="12" /></span><small>{{ matrix.rows.filter(row => row.decisions?.[role.value]?.allowed).length }} / {{ matrix.rows.length }} 项可用</small></button></div>
        <PagedList :rows="rows" :page-size="10" label="能力" empty="没有匹配的权限结果。" list-class="permission-comparison-items" v-slot="{ item }">
          <div class="permission-comparison-row" :class="{ 'single-role': roles.length === 1 }">
            <div class="permission-comparison-copy"><strong>{{ toolDisplayName(item.tool) }}</strong><small>{{ sourceLabel(toolSource(item.tool)) }} · {{ item.tool.name }}</small><CapabilityRisk :tool="item.tool" /><span v-if="!item.tool.enabled" class="badge">未启用</span></div>
            <button v-for="role in roles" :key="role.value" class="permission-decision" :class="{ allowed: item.decisions?.[role.value]?.allowed }" :title="String(item.decisions?.[role.value]?.reason || '符合当前规则')" @click="open(item, role.value)">
              <span class="permission-mobile-role">{{ role.label }}</span><span>{{ item.decisions?.[role.value]?.allowed ? '✓ 可用' : '○ 不可用' }}{{ savedOverride(item.tool.name, role.value) !== 'default' ? ' ·' : '' }}</span>
              <small>{{ savedOverride(item.tool.name, role.value) === 'allow' ? '角色允许' : savedOverride(item.tool.name, role.value) === 'deny' ? '角色禁止' : ['mute_user','edit_card','set_title'].includes(item.tool.name) ? '默认仅本人' : toolSource(item.tool) === 'builtin' ? '默认仅主人' : '继承包／服务' }}</small>
              <small v-if="mode === 'query'">{{ item.decisions?.[role.value]?.reason }}</small>
            </button>
          </div>
        </PagedList>
      </template>
      <p class="muted tiny">点击状态调整单项权限，点击角色列头配置默认范围。· 为单独设置。总览按示例群聊验证；具体对象请用权限查询。Skill 范围在角色配置中管理。</p>
      <SideDrawer :open="!!selected" title="单项权限" :subtitle="selected ? selected.name + ' · ' + selectedLabel : ''" width="520px" @close="selected = null">
        <template v-if="selected">
          <div class="item subtle"><strong>实际结果：{{ !selectedRow ? '等待重新查询' : selectedDecision?.allowed ? '可用' : '不可用' }}</strong><p class="muted small">{{ selectedDecision?.reason || (selectedRow ? '符合当前规则' : '查询条件或配置已变化，请重新查询。') }}</p></div>
          <p class="muted small">不单独设置：禁言、群名片和头衔默认允许本人操作；其他内置工具默认仅主人可用；扩展工具继承所属包或服务的角色设置，包或服务未设置时也仅主人可用。各角色独立，不继承其他角色。</p>
          <p class="muted small">只调整此角色对此工具的权限。单独允许仍受能力启停、全局规则和工具硬性要求限制。</p>
          <Field label="单项规则" type="select" :options="[{value:'default',label:'不单独设置'},{value:'allow',label:'允许此角色使用'},{value:'deny',label:'禁止此角色使用'}]" v-model="override" />
          <p v-if="editingBlocked" class="danger small">角色配置有未保存更改，请先保存后再编辑单项，避免覆盖。</p>
          <p class="muted small">这里修改的是角色规则，适用于该角色的所有用户；查询中的 QQ 和群号仅用于验证。</p>
          <p aria-live="polite" class="muted small">{{ feedback }}</p>
        </template>
        <template #actions><button class="btn outline" @click="selected = null">关闭</button><button class="btn primary" :disabled="saving || editingBlocked || !selectedRow" @click="saveItem">{{ saving ? '保存中…' : '保存此项' }}</button></template>
      </SideDrawer>
    </section>
  `,
}
