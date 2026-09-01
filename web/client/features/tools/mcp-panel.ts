import { computed, reactive, ref } from "vue"
import { confirmAction, store, request, toast, refreshTab, saveConfigPatch } from "../../app/store/store.js"
import { splitTokens, parseJsonText, toJson } from "../../shared/format.js"
import { asRecord, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { BOOL_OPTIONS, MCP_RISK_OPTIONS } from "./shared.js"

interface McpServer extends UnknownRecord {
  id?: string
  name?: string
  description?: string
  descriptionZh?: string
  enabled?: boolean
  transport?: string
  type?: string
  url?: string
  endpoint?: string
  command?: string
  args?: string[]
  argsText?: string
  category?: string
  risk?: string
  requiresFinalReply?: boolean
  execution?: UnknownRecord | string
  executionByAction?: UnknownRecord | string
  tags?: string[] | string
  env?: UnknownRecord | string
  policy?: UnknownRecord | string
  toolPolicies?: UnknownRecord | string
}

interface McpEditorDraft {
  mode: "create" | "edit"
  id: string
  description: string
  enabled: string
  connection: string
  url: string
  command: string
  args: string
  category: string
  risk: string
  requiresFinalReply: string
  execution: string
  executionByAction: string
  tags: string
  env: string
  policy: string
  toolPolicies: string
}

interface McpSlice extends UnknownRecord {
  config?: { enabled?: boolean; servers?: Record<string, McpServer> }
}

const MCP_CONNECTION_OPTIONS = [
  { value: "stdio", label: "标准输入 / 输出 (stdio)" },
  { value: "sse", label: "服务器发送事件 (sse)" },
  { value: "streamableHttp", label: "可流式传输的 HTTP (streamableHttp)" },
]

function defaultMcpEditor(): McpEditorDraft {
  return {
    mode: "create",
    id: "",
    description: "",
    enabled: "true",
    connection: "stdio",
    url: "",
    command: "",
    args: "",
    category: "mcp",
    risk: "external",
    requiresFinalReply: "true",
    execution: "{}",
    executionByAction: "{}",
    tags: "mcp, external",
    env: "",
    policy: toJson({ externalNetwork: true }),
    toolPolicies: "{}",
  }
}

function serverRequiresFinalReply(server: McpServer = {}) {
  return server.requiresFinalReply !== false
}

function envToLines(value: unknown): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  return Object.entries(value).map(([key, item]) => `${key}=${String(item ?? "")}`).join("\n")
}

function parseEnvText(value: unknown): UnknownRecord {
  const text = String(value || "").trim()
  if (!text) return {}
  return Object.fromEntries(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const separator = line.indexOf("=")
    if (separator <= 0) throw new Error("环境变量请按 KEY=value 每行填写")
    return [line.slice(0, separator).trim(), line.slice(separator + 1)]
  }))
}

function importedServerConfig(value: unknown): { id: string; server: McpServer } {
  const source = asRecord(value)
  const collection = asRecord(source.mcp).servers || source.mcpServers || source.servers
  if (collection && typeof collection === "object" && !Array.isArray(collection)) {
    const entries = Object.entries(collection)
    if (!entries.length) throw new Error("MCP JSON 中没有服务配置")
    const [id, server] = entries[0]
    return { id, server: asRecord<McpServer>(server) }
  }
  const server = asRecord<McpServer>(source.server)
  if (Object.keys(server).length) {
    return { id: String(source.id || source.name || server.id || server.name || ""), server }
  }
  return { id: String(source.id || source.name || ""), server: asRecord<McpServer>(source) }
}

// MCP Server 管理。
export const McpPanel = {
  name: "McpPanel",
  setup() {
    const draft = reactive({
      mcpEnabled: String((asRecord<McpSlice>(store.mcp).config?.enabled ?? asRecord<{ mcp?: { enabled?: boolean } }>(store.config).mcp?.enabled ?? true) !== false),
    })
    const showEditor = ref(false)
    const editorMode = ref("quick")
    const importJsonText = ref("")
    const editor = reactive<McpEditorDraft>(defaultMcpEditor())
    const serverMap = computed<Record<string, McpServer>>(() => asRecord<McpSlice>(store.mcp).config?.servers
      || asRecord<{ mcp?: { servers?: Record<string, McpServer> } }>(store.config).mcp?.servers
      || {})
    const serverList = computed(() => Object.entries(serverMap.value || {}).map(([id, server]) => ({
      id,
      ...(server || {}),
    })).sort((a, b) => String(a.id || "").localeCompare(String(b.id || ""), "zh-Hans-CN")))
    const editorTitle = computed(() => `${editor.mode === "create" ? "新增" : "编辑"} MCP 服务`)
    const editorSubtitle = computed(() => editor.mode === "create"
      ? "快速填写连接信息，或导入已有 MCP 配置。"
      : (editor.connection === "stdio"
        ? "本地命令行 MCP 服务配置。"
        : (editor.connection === "streamableHttp" ? "支持 MCP Streamable HTTP 的远端服务配置。" : "服务器发送事件（SSE）服务配置。")))

    function applyEditor(id: string, server: McpServer = {}, mode: "create" | "edit" = "edit") {
      Object.assign(editor, defaultMcpEditor(), {
        mode,
        id,
        description: server.description || server.descriptionZh || "",
        enabled: String(server.enabled !== false),
        connection: ["stdio", "sse", "streamableHttp"].includes(String(server.transport || server.type || ""))
          ? String(server.transport || server.type)
          : (server.command ? "stdio" : "sse"),
        url: server.url || server.endpoint || "",
        command: server.command || "",
        args: Array.isArray(server.args) ? server.args.join("\n") : (server.argsText || ""),
        category: server.category || "mcp",
        risk: server.risk || "external",
        requiresFinalReply: String(serverRequiresFinalReply(server)),
        execution: typeof server.execution === "string" ? server.execution : toJson(server.execution || {}),
        executionByAction: typeof server.executionByAction === "string" ? server.executionByAction : toJson(server.executionByAction || {}),
        tags: Array.isArray(server.tags) ? server.tags.join(", ") : (server.tags || "mcp, external"),
        env: envToLines(server.env),
        policy: typeof server.policy === "string" ? server.policy : toJson(server.policy || { externalNetwork: true }),
        toolPolicies: typeof server.toolPolicies === "string" ? server.toolPolicies : toJson(server.toolPolicies || {}),
      })
      showEditor.value = true
    }
    function openCreate() {
      applyEditor("", {}, "create")
      editorMode.value = "quick"
      importJsonText.value = ""
    }
    function openEdit(id: string) {
      const server = serverMap.value?.[id]
      if (!server) return toast(`MCP 服务 ${id} 不存在`)
      applyEditor(id, server, "edit")
      editorMode.value = "quick"
    }
    function serverStatus(server: McpServer = {}) {
      return server.enabled === false ? { label: "未启用" } : { label: "已启用", active: true }
    }
    function serverTransport(server: McpServer = {}): string {
      if (server.command) {
        const args = Array.isArray(server.args) && server.args.length ? ` ${server.args.join(" ")}` : ""
        return `Stdio · ${server.command}${args}`
      }
      if (server.url) {
        const safeUrl = String(server.url)
          .replace(/([?&](?:api[_-]?key|token|access[_-]?token|secret)=)[^&#\s]+/gi, "$1••••••")
          .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1••••••@")
        const transport = server.transport || server.type
        return `${transport === "streamableHttp" ? "Streamable HTTP" : "SSE"} · ${safeUrl}`
      }
      return "未配置连接"
    }
    async function toggleGlobal(enabled: boolean) {
      const next = Boolean(enabled)
      if (!next) {
        const accepted = await confirmAction({ title: "关闭 MCP 总开关？", message: "所有 MCP 服务及其工具都会停止向模型提供。", confirmText: "确认关闭", tone: "warn", icon: "power" })
        if (!accepted) return
      }
      const previous = draft.mcpEnabled
      draft.mcpEnabled = String(next)
      try {
        await saveConfigPatch({ "mcp.enabled": next }, "mcp-global-toggle")
      } catch (err) {
        draft.mcpEnabled = previous
        toast(errorMessage(err))
      }
    }
    function importJsonToEditor() {
      try {
        const parsed = parseJsonText(importJsonText.value, "MCP 配置 JSON", {})
        const { id, server } = importedServerConfig(parsed)
        if (!id) throw new Error("JSON 中需要提供 id / name，或 servers 对象中的服务名")
        applyEditor(id, server, "create")
        editorMode.value = "quick"
        toast("已读取 JSON，请确认后保存服务")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function saveEditor() {
      try {
        if (editorMode.value === "json" && editor.mode === "create") return importJsonToEditor()
        const id = String(editor.id || "").trim()
        if (!id) throw new Error("请输入 MCP 服务名称或 ID")
        const payload: UnknownRecord = {
          id,
          description: String(editor.description || "").trim().slice(0, 240),
          enabled: editor.enabled === "true",
          mcpEnabled: draft.mcpEnabled === "true",
          transport: editor.connection,
          category: editor.category || "mcp",
          risk: editor.risk || "external",
          requiresFinalReply: editor.requiresFinalReply === "true",
          execution: parseJsonText(editor.execution, "执行策略", {}),
          executionByAction: parseJsonText(editor.executionByAction, "按动作执行策略", {}),
          tags: splitTokens(editor.tags),
          env: parseEnvText(editor.env),
          policy: parseJsonText(editor.policy, "Server Policy", { externalNetwork: true }),
          toolPolicies: parseJsonText(editor.toolPolicies, "Tool Policies", {}),
        }
        if (editor.connection === "stdio") {
          if (!String(editor.command || "").trim()) throw new Error("请选择标准输入 / 输出时必须填写命令")
          payload.command = String(editor.command || "").trim()
          payload.argsText = editor.args || ""
        } else {
          if (!String(editor.url || "").trim()) throw new Error("请选择 HTTP 连接方式时必须填写 URL")
          payload.url = String(editor.url || "").trim()
        }
        await request("/api/mcp/server", { method: "POST", body: JSON.stringify(payload) })
        toast(`已保存 MCP 服务 ${id}`)
        showEditor.value = false
        await refreshTab("tools")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function toggleServer(id: string, enabled: boolean) {
      if (!enabled) {
        const accepted = await confirmAction({ title: `停用 MCP 服务“${id}”？`, message: "来自该服务的工具将不再提供给模型调用。", confirmText: "确认停用", tone: "warn", icon: "power" })
        if (!accepted) return
      }
      try {
        await request(`/api/mcp/${encodeURIComponent(id)}/enabled`, { method: "POST", body: JSON.stringify({ enabled, mcpEnabled: draft.mcpEnabled === "true" }) })
        toast(`${enabled ? "已启用" : "已停用"} MCP 服务 ${id}`)
        await refreshTab("tools")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function requestRemoveServer(id: string): Promise<boolean> {
      if (!id) return false
      const accepted = await confirmAction({
        title: `删除 MCP 服务“${id}”？`,
        message: "服务连接和单独权限配置会一并移除，来自该服务的工具将不再可用。",
        detail: serverTransport(serverMap.value?.[id] || {}),
        confirmText: "确认删除服务",
      })
      if (!accepted) return false
      try {
        await request(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE" })
        toast(`已删除 MCP 服务 ${id}`)
        await refreshTab("tools")
        return true
      } catch (err) { toast(errorMessage(err)); return false }
    }
    async function deleteEditorServer() {
      if (await requestRemoveServer(String(editor.id || "").trim())) showEditor.value = false
    }
    return {
      draft,
      showEditor,
      editorMode,
      importJsonText,
      editor,
      serverList,
      editorTitle,
      editorSubtitle,
      openCreate,
      openEdit,
      toggleGlobal,
      importJsonToEditor,
      saveEditor,
      toggleServer,
      requestRemoveServer,
      deleteEditorServer,
      serverStatus,
      serverTransport,
      BOOL_OPTIONS,
      MCP_RISK_OPTIONS,
      MCP_CONNECTION_OPTIONS,
      mcpStatus: computed(() => store.mcp || store.tools?.mcp),
    }
  },
  template: `
    <Panel title="MCP 能力" icon="link">
      <template #actions>
        <div class="row mcp-panel-actions">
          <label class="mcp-global-switch"><span>MCP 总开关</span><Switch :model-value="draft.mcpEnabled === 'true'" tip="关闭后模型完全看不到 MCP 工具，但服务配置会保留。" @update:model-value="toggleGlobal" /></label>
          <button class="btn primary small" type="button" @click="openCreate"><Icon name="plus" :size="14" />新增 MCP</button>
        </div>
      </template>
      <PagedList :rows="serverList" :page-size="6" label="MCP 服务" empty="还没有 MCP 服务。点击右上角“新增 MCP”开始配置。" v-slot="{ item }">
        <div class="item subtle mcp-server-item">
          <div class="item-head">
            <div class="mcp-server-copy">
              <div class="item-title">{{ item.id }}</div>
              <p v-if="item.description" class="muted tiny">{{ item.description }}</p>
              <p class="muted tiny">{{ serverTransport(item) }}</p>
            </div>
            <div class="row mcp-server-actions">
              <Pill v-bind="serverStatus(item)" />
              <Switch :model-value="item.enabled !== false" :tip="item.enabled === false ? '启用服务' : '停用服务'" @update:model-value="toggleServer(item.id, $event)" />
              <button class="btn small" type="button" @click="openEdit(item.id)"><Icon name="pencil" :size="14" />编辑</button>
            </div>
          </div>
        </div>
      </PagedList>
      <SideDrawer
        :open="showEditor"
        :title="editorTitle"
        :subtitle="editorSubtitle"
        icon="link"
        width="760px"
        @close="showEditor = false"
      >
        <div v-if="editor.mode === 'create'" class="segmented mcp-editor-methods" role="tablist" aria-label="MCP 新增方式">
          <button type="button" :class="{ active: editorMode === 'quick' }" @click="editorMode = 'quick'"><Icon name="sliders" :size="13" />快速创建</button>
          <button type="button" :class="{ active: editorMode === 'json' }" @click="editorMode = 'json'"><Icon name="code" :size="13" />JSON 导入</button>
        </div>
        <template v-if="editor.mode === 'create' && editorMode === 'json'">
          <div class="item subtle mcp-json-hint">
            <div class="item-title">导入单个 MCP 服务配置</div>
            <p class="muted tiny">支持服务对象、{ "id": "...", "url": "..." }，也支持带 servers 的 MCP 配置。导入后会回到表单确认，再写入配置。</p>
          </div>
          <Field label="MCP 配置 JSON" type="textarea" rows="16" v-model="importJsonText" placeholder='{\n  "id": "demo",\n  "url": "http://127.0.0.1:3000/sse"\n}' tip="只读取配置，不会执行 JSON 中的命令；保存前仍可在表单中检查和修改。" />
        </template>
        <template v-else>
          <p class="muted small">先填写名称和连接方式；环境变量、策略和工具级覆盖都放在高级设置里，普通场景不用管。</p>
          <div class="form-grid">
            <Field label="名称 / 服务 ID" v-model="editor.id" placeholder="例如 filesystem" tip="保存时作为唯一标识；建议使用字母、数字、横线或下划线。" />
            <Field label="启用状态" type="select" :options="BOOL_OPTIONS" v-model="editor.enabled" tip="只控制这个 MCP 服务是否加载。" />
            <Field label="描述" type="textarea" rows="3" v-model="editor.description" placeholder="说明这个 MCP 服务适合做什么" tip="用于列表识别和管理备注，不会替换 MCP 工具本身的说明。" />
            <Field label="连接方式" type="select" :options="MCP_CONNECTION_OPTIONS" v-model="editor.connection" tip="本地命令行选 stdio，传统推送选 sse，新版可流式 HTTP 服务选 streamableHttp。" />
            <Field v-if="editor.connection !== 'stdio'" :label="editor.connection === 'streamableHttp' ? '可流式传输的 HTTP 地址' : '服务器发送事件地址'" v-model="editor.url" :placeholder="editor.connection === 'streamableHttp' ? 'https://example.com/mcp' : 'https://example.com/sse'" tip="填写 MCP 服务提供的连接地址。" />
            <Field v-else label="启动命令" v-model="editor.command" placeholder="例如 npx、uvx、node 或 python" tip="填写可执行程序或命令路径。" />
            <Field v-if="editor.connection === 'stdio'" label="命令参数" type="textarea" rows="4" v-model="editor.args" placeholder="server.js\n--port\n3000" tip="每行一个参数；保存时会按空白拆分为命令参数。" />
            <Field v-if="editor.connection === 'stdio'" label="环境变量" type="textarea" rows="4" v-model="editor.env" placeholder="KEY=value\nANOTHER_KEY=value" tip="每行一个 KEY=value，仅启动本地命令时通常需要。" />
          </div>
          <Collapse title="高级设置" hint="分类、风险、标签、服务策略和工具级策略" nested>
            <div class="form-grid">
              <Field label="分类" v-model="editor.category" tip="默认保留 mcp 即可；只有想按业务细分时再改。" />
              <Field label="风险" type="select" :options="MCP_RISK_OPTIONS" v-model="editor.risk" tip="涉及外部网络或管理动作时，请按实际风险选择。" />
              <Field label="需要最终回复" type="select" :options="BOOL_OPTIONS" v-model="editor.requiresFinalReply" tip="默认开启。关闭后，只有本轮单独调用该 MCP 工具时才允许不发送模型文字回复；工具级 toolPolicies.requiresFinalReply 可以覆盖单个工具。" />
              <Field label="执行策略 JSON" type="textarea" rows="6" v-model="editor.execution" tip="统一配置 effect、repeatPolicy、supportsCount、countField、maxCount、targetFields、retryPolicy、maxAttempts 等执行属性；普通查询工具可留空。" />
              <Field label="按 action 覆盖 JSON" type="textarea" rows="5" v-model="editor.executionByAction" tip="复合 MCP 工具可按 action 覆盖执行效果和重试策略；工具级 toolPolicies.execution 优先级更高。" />
              <Field label="标签" v-model="editor.tags" tip="逗号分隔，用来标记来源、用途或供应商。" />
            </div>
            <Field v-if="editor.connection !== 'stdio'" label="环境变量" type="textarea" rows="4" v-model="editor.env" placeholder="KEY=value\nANOTHER_KEY=value" tip="每行一个 KEY=value；远端连接通常不需要。" />
            <Field label="服务策略 JSON" type="textarea" rows="5" v-model="editor.policy" tip="给整个 MCP 服务设置默认策略，例如 externalNetwork、requiresMaster 等。" />
              <Field label="工具策略 JSON" type="textarea" rows="6" v-model="editor.toolPolicies" tip="可按工具名覆盖权限、requiresFinalReply、execution 和 executionByAction；普通场景保留空对象即可。" />
          </Collapse>
        </template>
        <template #actions>
          <button v-if="editor.mode === 'edit'" class="icon-btn danger mcp-editor-delete" type="button" data-tip="删除此 MCP 服务" @click="deleteEditorServer"><Icon name="trash" :size="15" /></button>
          <button class="btn outline" type="button" @click="showEditor = false"><Icon name="x" :size="14" />关闭</button>
          <button v-if="editor.mode === 'create' && editorMode === 'json'" class="btn primary small" type="button" @click="importJsonToEditor"><Icon name="download" :size="14" />读取 JSON</button>
          <button v-else class="btn primary small" type="button" @click="saveEditor"><Icon name="save" :size="14" />保存服务</button>
        </template>
      </SideDrawer>
      <Collapse title="MCP 运行状态" hint="排查连接错误时查看"><JsonBlock title="原始状态" :value="mcpStatus" /></Collapse>
    </Panel>
  `,
}
