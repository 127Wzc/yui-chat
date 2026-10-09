import { computed, inject, reactive, ref, watch, type Ref } from "vue"
import { store, request, toast } from "../../app/store/store.js"
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
    function savedOverride(name: string, role: string) {
      const profile = asRecord(asRecord(boundary.value.roles)[role])
      return Array.isArray(profile.deniedTools) && profile.deniedTools.includes(name) ? "deny"
        : Array.isArray(profile.allowedTools) && profile.allowedTools.includes(name) ? "allow" : "default"
    }
    const rows = computed(() => asRecords<MatrixRow>(matrix.value?.rows).filter(row => {
      const decisions = roles.value.map(role => row.decisions?.[role.value])
      const query = filter.query.trim().toLowerCase()
      return (!query || [toolDisplayName(row.tool), row.tool.name, ...decisions.map(d => d?.reason || "")].join(" ").toLowerCase().includes(query))
        && (filter.source === "all" || toolSource(row.tool) === filter.source)
        && (!filter.differences || new Set(BOUNDARY_ROLE_OPTIONS.map(role => row.decisions?.[role.value]?.allowed)).size > 1)
        && (filter.status === "all" || (filter.status === "blocked" ? decisions.some(d => !d?.allowed) : roles.value.some(r => savedOverride(row.tool.name, r.value) !== "default")))
    }))
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
    const feedback = ref("")
    const pending = ref("")
    async function changeItem(row: MatrixRow, role: string, event: Event) {
      const input = event.target as HTMLSelectElement
      const value = input.value
      if (saving.value || props.editingBlocked || !["default", "allow", "deny"].includes(value)) {
        input.value = savedOverride(row.tool.name, role)
        return
      }
      if (value === savedOverride(row.tool.name, role)) return
      saving.value = true
      pending.value = `${row.tool.name}:${role}`
      feedback.value = "正在保存…"
      let committed = false
      try {
        const result = await request("/api/tools/access-role", { method: "POST", body: JSON.stringify({ scope: "tool", id: row.tool.name, role, allowed: value === "default" ? null : value === "allow" }) })
        store.config = asRecord(result.config)
        committed = true
        feedback.value = `${toolDisplayName(row.tool)} · ${BOUNDARY_ROLE_OPTIONS.find(r => r.value === role)?.label}：已${value === "default" ? "恢复默认" : value === "allow" ? "允许" : "禁止"}`
        await reload()
      } catch (err) {
        feedback.value = committed ? `权限已保存，结果刷新失败：${errorMessage(err)}` : `保存失败，已恢复原设置：${errorMessage(err)}`
        toast(feedback.value)
      } finally {
        input.value = savedOverride(row.tool.name, role)
        pending.value = ""
        saving.value = false
      }
    }
    function reset() { filter.query = ""; filter.status = "all"; filter.source = "all"; filter.differences = false }
    return { mode, filter, context, matrix, rows, roles, stale, busy, error, queryAccess, reset, savedOverride, changeItem, pending, feedback, saving, boundary, toolDisplayName, toolSource, sourceLabel, BOUNDARY_ROLE_OPTIONS }
  },
  template: `
    <section class="permission-overview">
      <div class="permission-overview-toolbar">
        <div class="segmented" aria-label="权限查看方式"><button :class="{ active: mode === 'overview' }" @click="mode = 'overview'">权限总览</button><button :class="{ active: mode === 'query' }" @click="mode = 'query'">权限查询</button></div>
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
            <div v-for="role in roles" :key="role.value" class="permission-decision" :class="{ allowed: item.decisions?.[role.value]?.allowed }" :title="String(item.decisions?.[role.value]?.reason || '符合当前规则')">
              <select v-if="mode === 'overview'" class="permission-inline-select" :aria-label="toolDisplayName(item.tool) + ' · ' + role.label + '权限'" :value="savedOverride(item.tool.name, role.value)" :disabled="saving || editingBlocked" @change="changeItem(item, role.value, $event)">
                <option value="default">默认</option><option value="allow">允许</option><option value="deny">禁止</option>
              </select>
              <small v-if="pending === item.tool.name + ':' + role.value">保存中…</small>
              <span class="permission-mobile-role">{{ role.label }}</span><span>{{ item.decisions?.[role.value]?.allowed ? '✓ 可用' : '○ 不可用' }}{{ savedOverride(item.tool.name, role.value) !== 'default' ? ' ·' : '' }}</span>
              <small>{{ savedOverride(item.tool.name, role.value) === 'allow' ? '角色允许' : savedOverride(item.tool.name, role.value) === 'deny' ? '角色禁止' : item.tool.common?.defaultRoleLabel || '未单独设置' }}</small>
              <small v-if="mode === 'query'">{{ item.decisions?.[role.value]?.reason }}</small>
            </div>
          </div>
        </PagedList>
      </template>
      <p class="muted tiny">总览中选择默认／允许／禁止即保存，作用于该角色的所有用户；默认表示清除单项覆盖。实际可用性仍受启停、个人规则和操作限制影响，悬停状态查看原因。查询仅用于验证；Skill 在角色配置中管理。</p>
      <p v-if="editingBlocked" class="danger small">角色草稿尚未保存，请先保存或丢弃，再快捷修改。</p>
      <p role="status" aria-live="polite" class="muted small">{{ feedback }}</p>
    </section>
  `,
}
