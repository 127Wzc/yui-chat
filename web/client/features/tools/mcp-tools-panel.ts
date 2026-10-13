import { CapabilityList, CapabilityRisk } from "./capability-list.js"
import { CapabilityRoleButtons } from "./capability-role-buttons.js"
import { computed, ref } from "vue"
import { store, request, refreshTab, toast, confirmAction } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage } from "../../shared/data.js"

/** 独立即时保存，修改名单不覆盖连接信息或尚未提交的服务编辑。 */
export const McpToolsPanel = {
  components: { CapabilityRoleButtons, CapabilityList, CapabilityRisk },
  props: { serverId: { type: String, required: true } },
  setup(props: { serverId: string }) {
    const busy = ref(false)
    const probe = ref<Record<string, unknown> | null>(null)
    const slice = computed(() => asRecord(store.mcp))
    const status = computed(() => asRecord(slice.value.status || store.tools?.mcp))
    const server = computed(() => asRecord(asRecord(asRecord(slice.value.config).servers)[props.serverId]))
    const managed = computed(() => Boolean(server.value.installationId))
    const all = computed(() => server.value.allowedTools == null)
    const selected = computed<string[]>(() => Array.isArray(server.value.allowedTools) ? server.value.allowedTools as string[] : [])
    const activeCatalog = computed(() => asRecords(status.value.catalog).filter(tool => tool.server === props.serverId))
    const catalog = computed(() => asRecords(probe.value?.catalog || activeCatalog.value).filter(tool => tool.server === props.serverId))
    const rows = computed(() => {
      const names = new Set(catalog.value.map(tool => String(tool.originalName)))
      const reviewed = asRecord(server.value.reviewedToolSchemas)
      return [...catalog.value.map(tool => ({ ...tool, reviewRequired: managed.value && selected.value.includes(String(tool.originalName)) && reviewed[String(tool.originalName)] !== tool.schemaDigest })), ...selected.value.filter(name => !names.has(name)).map(originalName => ({ originalName, description: "已配置，但当前服务未发现此工具", missing: true }))]
    })
    const connection = computed(() => {
      const error = asRecords(status.value.errors).find(item => item.server === props.serverId)
      if (probe.value) return `测试成功：发现 ${catalog.value.length} 个工具，耗时 ${Number(probe.value.elapsedMs || 0)} ms。`
      if (error) return `当前异常${error.phase ? `（${String(error.phase)}）` : ''}：${String(error.error)}；已保留开放状态，后续调用会自动重连。`
      if (!Array.isArray(status.value.clients) || !status.value.clients.includes(props.serverId)) return "服务未连接；启用并成功连接后可查看发现的工具。"
      return `发现 ${catalog.value.length} 个工具；开放仅代表允许注入，调用仍受角色和工具权限控制。`
    })
    async function save(allowedTools: string[] | null) {
      if (busy.value) return
      if (managed.value && allowedTools?.some(name => !selected.value.includes(name) || asRecord(server.value.reviewedToolSchemas)[name] !== catalog.value.find(tool => tool.originalName === name)?.schemaDigest)
        && !await confirmAction({ title: "开放已审阅的 MCP 工具？", message: "请先审阅参数定义和服务端声明；调用仍受角色与网络授权约束。", detail: allowedTools.join("、"), confirmText: "开放已审阅工具", tone: "warn", icon: "link" })) return
      busy.value = true
      try {
        await request(`/api/mcp/${encodeURIComponent(props.serverId)}/tools`, { method: "POST", body: JSON.stringify({ allowedTools }) })
        await refreshTab("tools")
        toast("MCP 工具开放配置已保存")
      } catch (error) { toast(errorMessage(error)) }
      finally { busy.value = false }
    }
    async function discover() {
      if (busy.value) return
      busy.value = true
      try {
        const result = await request(`/api/mcp/${encodeURIComponent(props.serverId)}/discover`, { method: "POST", body: "{}" })
        probe.value = asRecord(result.probe)
        toast(`已发现 ${asRecords(asRecord(result.probe).catalog).length} 个 MCP 工具`)
      } catch (error) { toast(errorMessage(error)) }
      finally { busy.value = false }
    }
    function toggle(name: string, enabled: boolean) {
      const names = new Set(all.value ? catalog.value.map(tool => String(tool.originalName)) : selected.value)
      if (enabled) names.add(name)
      else names.delete(name)
      void save([...names])
    }
    function toolRisk(item: Record<string, unknown>) {
      const loaded = asRecords(store.tools?.tools).find(tool => tool.name === item.name)
      if (loaded) return loaded
      const override = asRecord(asRecord(server.value.toolPolicies)[String(item.originalName)] || asRecord(server.value.toolPolicies)[String(item.name)])
      return { risk: override.risk || server.value.risk || "external", policy: { externalNetwork: true, ...asRecord(server.value.policy), ...asRecord(override.policy) } }
    }
    return { toolRisk, busy, managed, all, selected, rows, connection, save, toggle, discover, catalog }
  },
  template: `
    <Collapse title="工具开放配置" hint="查看工具与控制注入；修改立即保存" nested>
      <p class="muted small">{{ connection }}</p><p v-if="managed" class="muted small">受管理服务仅开放明确审阅的工具；定义变化后需要重新发现和选择。</p>
      <div class="row">
        <button class="btn small" :disabled="busy" @click="discover">测试连接 / 发现工具</button>
        <button class="btn small" :disabled="busy || all || managed" @click="save(null)">全部开放（含未来新增）</button>
        <button class="btn small" :disabled="busy || (!all && !managed)" @click="save(catalog.map(tool => tool.originalName))">仅开放当前清单</button>
        <button class="btn small" :disabled="busy" @click="save([])">全部关闭</button>
        <span class="muted tiny">{{ all ? '全部开放模式' : '名单模式：新增工具默认关闭' }}</span>
      </div>
      <CapabilityList :rows="rows" label="工具" empty="尚未发现工具。">
        <template #identity="{ item }"><strong>{{ item.originalName }}</strong><div class="cell-sub">{{ item.name }}</div><div class="cell-sub">{{ item.description }}</div><p v-if="item.status === 'unavailable'" class="danger tiny">当前异常：{{ item.error || '服务连接暂时不可用' }}；后续调用会自动重连。</p></template>
        <template #risk="{ item }"><CapabilityRisk :tool="toolRisk(item)" /></template>
        <template #status="{ item }"><span v-if="item.reviewRequired" class="badge">定义变化，待审阅</span><span v-if="item.missing" class="badge">未发现</span></template>
        <template #actions="{ item }"><label><input type="checkbox" :disabled="busy" :checked="all || (!item.reviewRequired && selected.includes(item.originalName))" @click.prevent="toggle(item.originalName, !(all || (!item.reviewRequired && selected.includes(item.originalName))))" /> 开放</label></template>
        <template #details="{ item }"><JsonBlock v-if="item.inputSchema" title="参数定义" :value="item.inputSchema" /><JsonBlock v-if="item.annotations" title="服务端声明" :value="item.annotations" /></template>
        <template #roles="{ item }"><CapabilityRoleButtons v-if="item.name" :id="item.name" /></template>
      </CapabilityList>
    </Collapse>
  `,
}
