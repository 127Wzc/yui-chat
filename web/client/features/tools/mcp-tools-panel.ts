import { computed, ref } from "vue"
import { store, request, refreshTab, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage } from "../../shared/data.js"

/** 独立即时保存，修改名单不覆盖连接信息或尚未提交的服务编辑。 */
export const McpToolsPanel = {
  props: { serverId: { type: String, required: true } },
  setup(props: { serverId: string }) {
    const busy = ref(false)
    const probe = ref<Record<string, unknown> | null>(null)
    const slice = computed(() => asRecord(store.mcp))
    const status = computed(() => asRecord(slice.value.status || store.tools?.mcp))
    const server = computed(() => asRecord(asRecord(asRecord(slice.value.config).servers)[props.serverId]))
    const all = computed(() => server.value.allowedTools == null)
    const selected = computed<string[]>(() => Array.isArray(server.value.allowedTools) ? server.value.allowedTools as string[] : [])
    const activeCatalog = computed(() => asRecords(status.value.catalog).filter(tool => tool.server === props.serverId))
    const catalog = computed(() => asRecords(probe.value?.catalog || activeCatalog.value).filter(tool => tool.server === props.serverId))
    const rows = computed(() => {
      const names = new Set(catalog.value.map(tool => String(tool.originalName)))
      return [...catalog.value, ...selected.value.filter(name => !names.has(name)).map(originalName => ({ originalName, description: "已配置，但当前服务未发现此工具", missing: true }))]
    })
    const connection = computed(() => {
      const error = asRecords(status.value.errors).find(item => item.server === props.serverId)
      if (probe.value) return `测试成功：发现 ${catalog.value.length} 个工具，耗时 ${Number(probe.value.elapsedMs || 0)} ms。`
      if (error) return `连接失败：${String(error.error)}`
      if (!Array.isArray(status.value.clients) || !status.value.clients.includes(props.serverId)) return "服务未连接；启用并成功连接后可查看发现的工具。"
      return `发现 ${catalog.value.length} 个工具；开放仅代表允许注入，调用仍受角色和工具权限控制。`
    })
    async function save(allowedTools: string[] | null) {
      if (busy.value) return
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
    return { busy, all, selected, rows, connection, save, toggle, discover, catalog }
  },
  template: `
    <Collapse title="工具开放配置" hint="查看工具与控制注入；修改立即保存" nested>
      <p class="muted small">{{ connection }}</p>
      <div class="row">
        <button class="btn small" :disabled="busy" @click="discover">测试连接 / 发现工具</button>
        <button class="btn small" :disabled="busy || all" @click="save(null)">全部开放（含未来新增）</button>
        <button class="btn small" :disabled="busy || !all" @click="save(catalog.map(tool => tool.originalName))">仅开放当前清单</button>
        <button class="btn small" :disabled="busy" @click="save([])">全部关闭</button>
        <span class="muted tiny">{{ all ? '全部开放模式' : '名单模式：新增工具默认关闭' }}</span>
      </div>
      <PagedList :rows="rows" :page-size="10" label="工具" empty="尚未发现工具。" v-slot="{ item }">
        <div class="item subtle">
          <div class="item-head">
            <div><div class="item-title">{{ item.originalName }}</div><p class="muted tiny">{{ item.description }}</p><p v-if="item.name" class="muted tiny">{{ item.name }}</p></div>
            <label><input type="checkbox" :disabled="busy" :checked="all || selected.includes(item.originalName)" @change="toggle(item.originalName, $event.target.checked)" /> 开放</label>
          </div>
        </div>
      </PagedList>
    </Collapse>
  `,
}
