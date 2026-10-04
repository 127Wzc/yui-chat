import { computed, inject, ref, type Ref } from "vue"
import { confirmAction, request, store, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage } from "../../shared/data.js"
import { BOUNDARY_ROLE_OPTIONS } from "./permission-shared.js"

/** 同一能力页共享一次服务端权限矩阵，不为每个按钮重复请求。 */
export const CapabilityRoleButtons = {
  name: "CapabilityRoleButtons",
  props: {
    scope: { type: String, default: "tool" },
    id: { type: String, required: true },
    details: Boolean,
  },
  setup(props: { scope: string; id: string; details: boolean }) {
    const matrix = inject<Ref<Record<string, unknown> | null>>("capabilityAccessMatrix", ref(null))
    const saving = inject<Ref<boolean>>("capabilityAccessSaving", ref(false))
    const reload = inject<() => Promise<void>>("reloadCapabilityAccess", async () => {})
    const feedback = ref("")
    const boundary = computed(() => asRecord(asRecord(store.config?.tools).boundaryAccess))
    const entry = computed(() => asRecord(asRecord(boundary.value[props.scope])[props.id]))
    const rows = computed(() => asRecords(matrix.value?.rows).filter(row => {
      const tool = asRecord(row.tool)
      const provenance = asRecord(asRecord(tool.common).provenance)
      return props.scope === "tool" ? tool.name === props.id
        : props.scope === "customPackages" ? provenance.packageId === props.id
          : props.scope === "mcpServers" ? provenance.serverName === props.id : false
    }))
    const states = computed(() => BOUNDARY_ROLE_OPTIONS.map((role, index) => {
      const profile = asRecord(asRecord(boundary.value.roles)[role.value])
      const override = props.scope === "tool"
        ? (Array.isArray(profile.deniedTools) && profile.deniedTools.includes(props.id) ? false
          : Array.isArray(profile.allowedTools) && profile.allowedTools.includes(props.id) ? true : undefined)
        : asRecord(entry.value.roles)[role.value]
      const decisions = rows.value.map(row => asRecord(asRecord(row.decisions)[role.value]))
      let count = decisions.filter(item => item.allowed === true).length
      let total = decisions.length
      if (props.scope === "skillPackages") {
        total = 1
        const minimum = BOUNDARY_ROLE_OPTIONS.findIndex(item => item.value === entry.value.minRole)
        const catalog = asRecords(asRecord(store.tools?.skills).catalog)
        const skill = catalog.find(item => item.id === props.id)
        count = asRecord(store.config?.skills).enabled !== false && skill?.enabled === true && asRecord(skill.validation).ok !== false && (boundary.value.enabled === false || (entry.value.enabled !== false && (typeof override === "boolean" ? override : index >= minimum))) ? 1 : 0
      }
      const allowed = total > 0 && count === total
      const partial = count > 0 && count < total
      const selected = typeof override === "boolean" ? override : allowed
      const reasons = [...new Set(decisions.filter(item => !item.allowed).map(item => String(item.reason || "权限限制")))]
      const status = !total ? "尚未加载，暂不能验证" : partial ? `部分可用 ${count}/${total}` : allowed ? "可用" : "不可用"
      return { value: role.value, label: index === 0 ? "普通用户" : role.label, selected, partial,
        warning: selected && !allowed, title: `${status}；${typeof override === "boolean" ? override ? "已单独允许" : "已单独禁止" : "跟随默认"}${reasons.length ? '。' + reasons.join('；') : ''}` }
    }))
    async function change(role: string | null, allowed: boolean | null) {
      if (saving.value) return
      saving.value = true
      try {
        const sensitive = props.scope !== "tool" || rows.value.some(row => {
          const common = asRecord(asRecord(row.tool).common)
          const policy = asRecord(common.policy)
          return common.risk === "high" || common.risk === "external" || policy.highRisk === true || policy.externalNetwork === true || policy.requiresMaster === true
        })
        if (allowed !== false && sensitive) {
          const accepted = await confirmAction({ title: allowed === null ? "恢复默认权限？" : "允许此角色使用？", message: allowed === null ? `将清除 ${props.id} 的单独设置，默认权限可能重新开放此能力。` : `将开放 ${props.id} 的角色权限；工具硬性要求、全局策略和单项禁止仍会检查。`, confirmText: allowed === null ? "恢复默认" : "允许使用", tone: "warn", icon: "key" })
          if (!accepted) return
        }
        const result = await request("/api/tools/access-role", { method: "POST", body: JSON.stringify({ scope: props.scope, id: props.id, role, allowed }) })
        store.config = asRecord(result.config)
        await reload()
        feedback.value = role ? states.value.find(item => item.value === role)?.title || "已保存" : "已恢复默认权限"
        toast("权限已保存")
      } catch (error) { feedback.value = errorMessage(error); toast(feedback.value) }
      finally { saving.value = false }
    }
    return { states, rows, saving, feedback, change, boundary, matrix }
  },
  template: `
    <div class="capability-role-control" @click.stop>
      <div class="capability-role-buttons" role="group" :aria-label="id + ' 使用角色'">
        <button v-for="role in states" :key="role.value" type="button" class="role-dot-button" :data-role="role.value"
          :class="{ active: role.selected, 'role-partial': role.partial, 'role-limited': role.warning }"
          :aria-pressed="role.selected" :aria-label="role.label + '：' + role.title" :title="role.label + '：' + role.title"
          :disabled="saving || !matrix || boundary.enabled !== true || (scope === 'tool' && !rows.length)" @click="change(role.value, !role.selected)">
          <span class="role-dot" aria-hidden="true"></span>
        </button>
        <button class="role-reset-button" type="button" aria-label="恢复默认权限" :disabled="saving || !matrix || boundary.enabled !== true || (scope === 'tool' && !rows.length)" title="清除此项单独设置，重新跟随角色默认权限" @click="change(null, null)"><span aria-hidden="true">↺</span></button>
      </div>
      <small v-if="boundary.enabled !== true" class="muted">角色权限未启用，请在使用权限页开启。</small>
      <small v-else-if="!matrix" class="muted">权限验证尚未完成</small>
      <small v-else-if="scope === 'tool' && !rows.length" class="muted">工具尚未开放或加载，可先设置所属包或服务的角色权限。</small>
      <small v-if="feedback" class="muted" aria-live="polite">{{ feedback }}</small>
      <details v-if="details && rows.length" class="capability-role-details">
        <summary>单独设置 {{ rows.length }} 个工具</summary>
        <div v-for="row in rows" :key="row.tool.name" class="item subtle">
          <span>{{ row.tool.common?.displayNameZh || row.tool.name }}</span>
          <CapabilityRoleButtons :id="row.tool.name" />
        </div>
      </details>
    </div>
  `,
}
