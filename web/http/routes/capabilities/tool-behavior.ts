import { configStore, redactConfigSecrets } from "../../../../config/store.js"
import { normalizeTool, getToolCommon, toolSource, type NormalizedTool } from "../../../../tools/support/contract.js"
import { toolRegistry } from "../../../../tools/support/registry.js"
import { McpToolAdapter } from "../../../../mcp/index.js"
import { applicableBehaviorValues, applyToolBehavior, behaviorScopes, behaviorToolOnlyFields, behaviorValues, record, toolBehaviorScope, updateBehaviorEntry, validBehaviorId, validateBehaviorValues, type BehaviorScope } from "../../../../tools/support/behavior-settings.js"
import { requireWebAuth as auth } from "../../auth.js"
import { handleRoute, type RouteApp } from "../../route-handler.js"
import { updateConfigAndApply } from "../../runtime-config.js"
import type { UnknownRecord } from "../../../../core/message/types.js"

function catalogTools(): NormalizedTool[] {
  const tools = new Map(toolRegistry.tools)
  const custom = record(toolRegistry.customStatus()).catalog
  for (const item of Array.isArray(custom) ? custom : []) {
    const pkg = record(item)
    for (const value of Array.isArray(pkg.tools) ? pkg.tools : []) {
      const raw = record(value)
      if (typeof raw.name !== "string" || tools.has(raw.name)) continue
      const tool = normalizeTool({ ...raw, source: "custom", packageId: pkg.id, execute: () => undefined })
      if (tool) tools.set(tool.name, tool)
    }
  }
  const mcp = toolRegistry.mcpStatus()
  for (const value of Array.isArray(mcp.catalog) ? mcp.catalog : []) {
    const item = record(value), server = String(item.server || "")
    const servers = record(record(configStore.get().mcp).servers)
    const adapter = new McpToolAdapter(server, null, { name: String(item.originalName || ""), description: String(item.description || ""), inputSchema: record(item.inputSchema), annotations: record(item.annotations) }, record(servers[server]))
    const tool = normalizeTool(adapter)
    if (tool && !tools.has(tool.name)) tools.set(tool.name, tool)
  }
  return [...tools.values()]
}

function descriptor(tool: NormalizedTool, config: unknown): UnknownRecord {
  const inherited = applyToolBehavior(tool, config, false)
  const effective = applyToolBehavior(tool, config)
  const actionInherited = applyToolBehavior(tool, config, true, false)
  const base = getToolCommon(tool), common = getToolCommon(effective)
  const actions = Object.fromEntries(Object.entries(record(common.executionByAction)).map(([action, execution]) => [action, {
    inherited: behaviorValues({ ...base, execution: record(getToolCommon(actionInherited).executionByAction)[action] }),
    baseInherited: behaviorValues({ ...base, execution: record(getToolCommon(inherited).executionByAction)[action] }),
    capabilities: { ...record(execution), backgroundAvailable: record(common.policy).requiresModelContext !== true },
  }]))
  return { name: tool.name, label: common.displayNameZh || tool.name, source: toolSource(tool), parent: toolBehaviorScope(tool),
    loaded: toolRegistry.tools.has(tool.name),
    inherited: behaviorValues(getToolCommon(inherited)),
    actions, capabilities: { ...record(common.execution), backgroundAvailable: record(common.policy).requiresModelContext !== true, autoDelivery: Boolean(common.autoDelivery) },
  }
}

/** 只编辑运行策略，不启用扩展、不执行工具，也不修改 MCP 连接或权限。 */
export function registerToolBehaviorRoutes(app: RouteApp): void {
  app.get("/api/tools/behavior", auth, handleRoute(async (_req, res) => {
    // 同步已更新的 MCP 目录；list 仅读取，不触发外部发现或连接。
    await toolRegistry.list()
    const config = configStore.get()
    res.json({ ok: true, tools: catalogTools().map(tool => descriptor(tool, config)), settings: record(record(config.tools).behavior) })
  }, { errorStatus: 400 }))
  app.put("/api/tools/behavior", auth, handleRoute(async (req, res) => {
    const body = record(req.body)
    const edits = (Array.isArray(body.edits) ? body.edits : [body]).map(value => {
      const edit = record(value), changes = record(edit.changes), action = edit.action === undefined ? "" : String(edit.action)
      validateBehaviorValues(edit.changes ?? {}, true)
      if (action && !validBehaviorId(action)) throw new Error("无效的动作")
      return { changes, action, reset: edit.reset === true }
    })
    if (!Array.isArray(body.targets) || !body.targets.length) throw new Error("请选择配置目标")
    const targets = body.targets.map(value => {
      const item = record(value)
      if (!behaviorScopes.includes(item.scope as BehaviorScope) || !validBehaviorId(item.id)) throw new Error("无效的配置目标")
      const owner = record(item.owner)
      if (item.owner !== undefined && (!["customPackages", "mcpServers"].includes(String(owner.scope)) || !validBehaviorId(owner.id))) throw new Error("无效的工具归属")
      return { scope: item.scope as BehaviorScope, id: item.id, owner: item.owner === undefined ? null : owner }
    })
    const { saved } = await updateConfigAndApply(config => {
      const tools = catalogTools()
      for (const target of targets) for (const { changes, action, reset } of edits) {
        let values = changes
        if (target.scope === "tools") {
          const tool = tools.find(tool => tool.name === target.id)
          if (!tool) throw new Error("工具不在当前目录，请刷新列表")
          const owner = toolBehaviorScope(tool)
          if (target.owner && (owner?.scope !== target.owner.scope || owner?.id !== target.owner.id)) throw new Error("工具归属已变化或名称冲突，请刷新列表")
          if (action && !Object.hasOwn(record(getToolCommon(tool).executionByAction), action)) throw new Error("工具未声明该动作")
          const common = getToolCommon(tool)
          values = applicableBehaviorValues(action ? { ...common, execution: record(common.executionByAction)[action] } : common, changes)
        } else {
          if (action) throw new Error("范围默认设置不支持动作覆盖")
          const exists = target.scope === "mcpServers"
            ? Object.hasOwn(record(record(config.mcp).servers), target.id)
            : (record(toolRegistry.customStatus()).catalog as UnknownRecord[]).some(item => item.id === target.id)
          if (!exists) throw new Error("服务或扩展不存在，请刷新列表")
        }
        if (action && Object.keys(changes).some(key => behaviorToolOnlyFields.includes(key))) throw new Error("该项只支持工具级配置")
        updateBehaviorEntry(config as UnknownRecord, target.scope, target.id, values, action, reset)
      }
      return config
    }, {}, { reinitTools: false, reinitFilters: false, restartInitiativeGreeting: false, restartScheduleTasks: false })
    res.json({ ok: true, config: redactConfigSecrets(saved), tools: await toolRegistry.list(),
      behavior: { tools: catalogTools().map(tool => descriptor(tool, saved)), settings: record(record(saved.tools).behavior) },
    })
  }, { errorStatus: 400 }))
}
