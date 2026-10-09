import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue"
import { confirmAction, request, setDirtyScope, store, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage } from "../../shared/data.js"
import { toolDisplayName } from "./shared.js"

/** 用户例外只在使用权限页编辑，能力页继续只呈现角色。 */
export const PermissionUserPanel = {
  name: "PermissionUserPanel",
  setup() {
    const rules = ref<Record<string, unknown>[]>([])
    const busy = ref(false)
    const reload = inject<() => Promise<void>>("reloadCapabilityAccess", async () => {})
    const draft = reactive({ subjectId: "", groupId: "", resourceType: "tool", resourceId: "", effect: "allow" })
    const saved = ref(JSON.stringify(draft))
    watch(() => JSON.stringify(draft), value => setDirtyScope("permission-user", value !== saved.value))
    onBeforeUnmount(() => setDirtyScope("permission-user", false))
    const types = [{ value: "tool", label: "单个工具" }, { value: "customPackages", label: "Custom 扩展包" }, { value: "skillPackages", label: "Skill" }, { value: "mcpServers", label: "MCP 服务" }]
    const resources = computed(() => {
      if (draft.resourceType === "tool") return asRecords(store.tools?.tools).map(item => ({ value: String(item.name), label: toolDisplayName(item) }))
      const rows = draft.resourceType === "customPackages" ? asRecords(asRecord(store.tools?.custom).catalog)
        : draft.resourceType === "skillPackages" ? asRecords(asRecord(store.tools?.skills).catalog) : asRecords(asRecord(store.tools?.mcp).servers)
      return rows.map(item => ({ value: String(draft.resourceType === "mcpServers" ? item.name || item.id : item.id), label: String(item.name || item.id) }))
    })
    watch(() => draft.resourceType, () => { draft.resourceId = "" })
    async function load() {
      try { rules.value = asRecords((await request("/api/capabilities/overrides")).rules) }
      catch (error) { toast(errorMessage(error)) }
    }
    onMounted(load)
    async function save() {
      if (busy.value) return
      if (!/^[1-9]\d*$/.test(draft.subjectId) || (draft.groupId && !/^[1-9]\d*$/.test(draft.groupId)) || !draft.resourceId) {
        toast("请填写有效的用户 QQ、可选群号并选择能力。")
        return
      }
      const submitted = { ...draft }
      if (!await confirmAction({ title: "保存用户权限？", message: `仅调整用户 ${submitted.subjectId}${submitted.groupId ? ' 在群 ' + submitted.groupId : ' 在所有会话'} 对 ${submitted.resourceId} 的权限。个人允许覆盖角色及包/服务的角色禁止；能力开关、管理他人的身份要求仍生效。`, confirmText: "保存", tone: "warn", icon: "key" })) return
      busy.value = true
      try {
        const result = await request("/api/capabilities/overrides", { method: "POST", body: JSON.stringify(submitted) })
        rules.value = asRecords(result.rules)
        saved.value = JSON.stringify(submitted)
        setDirtyScope("permission-user", JSON.stringify(draft) !== saved.value)
        await reload()
        toast("用户权限已保存")
      } catch (error) { toast(errorMessage(error)) }
      finally { busy.value = false }
    }
    async function edit(row: Record<string, unknown>) {
      draft.resourceType = String(row.resource_type)
      await nextTick()
      Object.assign(draft, { subjectId: String(row.subject_id), groupId: String(row.group_id || ""), resourceId: String(row.resource_id), effect: String(row.effect) })
    }
    return { draft, rules, busy, types, resources, save, edit }
  },
  template: `
    <Collapse title="用户单独权限" hint="只调整指定用户，不改变角色规则">
      <p class="muted small">个人禁止优先于个人允许；个人允许可覆盖角色及包/服务的角色禁止。授权不赋予群管理员身份，风险标签不限制手动授权。</p>
      <div class="form-grid">
        <Field label="用户 QQ" v-model="draft.subjectId" />
        <Field label="限定群号（留空为所有会话）" v-model="draft.groupId" />
        <Field label="能力类型" type="select" :options="types" v-model="draft.resourceType" />
        <Field label="能力" type="select" :options="[{value:'',label:'请选择能力'},...resources]" v-model="draft.resourceId" />
        <Field label="规则" type="select" :options="[{value:'allow',label:'允许此用户（覆盖角色）'},{value:'deny',label:'禁止此用户（优先）'},{value:'default',label:'删除例外，恢复角色规则'}]" v-model="draft.effect" />
      </div>
      <button class="btn primary small" :disabled="busy" @click="save">保存用户权限</button>
      <PagedList :rows="rules" :page-size="8" label="用户规则" empty="尚无用户单独权限。" v-slot="{item}">
        <div class="permission-edit-item"><div><strong>{{item.subject_id}} · {{item.group_id ? '群 ' + item.group_id : '所有会话'}}</strong><small>{{item.resource_type}} / {{item.resource_id}} · {{item.effect === 'allow' ? '允许' : '禁止'}}</small></div><button class="btn small outline" @click="edit(item)">编辑／恢复继承</button></div>
      </PagedList>
    </Collapse>
  `,
}
