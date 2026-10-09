import { computed, inject, onMounted, ref } from "vue"
import { confirmAction, request, store, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage } from "../../shared/data.js"
import { BOUNDARY_ROLE_OPTIONS } from "./permission-shared.js"
import { toolDisplayName } from "./shared.js"

type Recommendation = { group: string; description: string; roles: Record<string, string> }
export const PermissionPresetPanel = {
  props: { editingBlocked: Boolean },
  setup(props: { editingBlocked: boolean }) {
    const recommendations = ref<Record<string, Recommendation>>({})
    const role = ref("user")
    const busy = ref(false)
    const reload = inject<() => Promise<void>>("reloadCapabilityAccess", async () => {})
    const labels: Record<string, string> = { allow: "允许", optional: "按需（不授权）", deny: "禁止", protected: "受保护（不授权）" }
    const rows = computed(() => Object.entries(recommendations.value).map(([name, item]) => ({
      name, ...item,
      title: toolDisplayName(asRecords(store.tools?.tools).find(tool => tool.name === name) || { name }),
      choice: labels[item.roles[role.value]],
    })))
    onMounted(async () => {
      try { recommendations.value = asRecord<Record<string, Recommendation>>((await request("/api/tools/role-preset")).recommendations) }
      catch (error) { toast(errorMessage(error)) }
    })
    async function apply() {
      if (busy.value || props.editingBlocked || !rows.value.length) return
      const target = role.value
      busy.value = true
      try {
        if (!await confirmAction({ title: "应用角色推荐方案？", message: `将按预览覆盖${BOUNDARY_ROLE_OPTIONS.find(item => item.value === target)?.label}的 ${rows.value.length} 项内置工具规则。按需及受保护项目设为禁止，可随后逐项修改。扩展、MCP、用户例外和工具启停保持现状。`, confirmText: "应用并立即生效", tone: "warn", icon: "key" })) return
        const result = await request("/api/tools/role-preset", { method: "POST", body: JSON.stringify({ role: target }) })
        store.config = asRecord(result.config)
        await reload()
        toast("推荐方案已生效，可继续逐项调整")
      } catch (error) { toast(errorMessage(error)) }
      finally { busy.value = false }
    }
    return { role, busy, rows, apply, BOUNDARY_ROLE_OPTIONS }
  },
  template: `
    <Collapse title="内置工具推荐权限" hint="先预览，再按角色应用；不会自动启用工具">
      <p class="muted small">出厂默认仅主人可用，禁言、群名片和头衔例外：开启后默认允许本人操作，明确禁止可关闭。每个角色独立配置；推荐方案不会自动应用，也不作为继承规则。保存权限立即生效，具体操作仍受功能开关、对象身份和平台权限限制。</p>
      <Field label="预览角色" type="select" :options="BOUNDARY_ROLE_OPTIONS" v-model="role" />
      <PagedList :rows="rows" :page-size="40" label="内置工具" empty="正在加载推荐方案" v-slot="{item}">
        <div class="permission-edit-item"><div><strong>{{item.title}} · {{item.choice}}</strong><small>{{item.group}} · {{item.name}}</small><p class="muted small">{{item.description}}</p></div></div>
      </PagedList>
      <p v-if="editingBlocked" class="danger small">请先保存角色编辑中的更改，再应用推荐方案。</p>
      <button class="btn primary small" :disabled="busy || editingBlocked || !rows.length" @click="apply">{{busy ? '处理中…' : '应用此角色推荐方案'}}</button>
    </Collapse>
  `,
}
