import { withExtensionLock, assertExtensionWritable } from "../../../../extensions/installation/guard.js"
import { installationStore } from "../../../../extensions/installation/store.js"
import { installationWebActor } from "./installation.js"
import { recordExtensionManagement } from "../../../../extensions/installation/management.js"
import { configStore, mergeRedactedConfigSecrets, redactConfigSecrets } from "../../../../config/store.js"
import { mcpManager } from "../../../../mcp/index.js"
import { toolRegistry } from "../../../../tools/support/registry.js"
import { requireWebAuth as auth } from "../../auth.js"
import { sanitizeWebId as sanitizeId, stringArray as arrayFrom } from "../../request-context.js"
import { updateConfigAndApply } from "../../runtime-config.js"
import { handleRoute, type RouteApp } from "../../route-handler.js"
import type { RuntimeConfigObject } from "../../../../config/types.js"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function configValue(value: UnknownRecord): RuntimeConfigObject {
  return value as RuntimeConfigObject
}

function normalizeAllowedTools(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some(name => typeof name !== "string" || !name.trim() || name !== name.trim())) {
    throw new Error("allowedTools 必须为 null 或原始工具名数组")
  }
  return [...new Set(value)]
}

function preserveMap(body: UnknownRecord, previous: UnknownRecord, key: "env" | "headers"): UnknownRecord | undefined {
  if (body[key] === undefined) return previous[key] && typeof previous[key] === "object" && !Array.isArray(previous[key]) ? previous[key] as UnknownRecord : undefined
  if (!body[key] || typeof body[key] !== "object" || Array.isArray(body[key])) throw new Error(`MCP ${key} 必须是对象`)
  return mergeRedactedConfigSecrets(body[key], previous[key], key) as UnknownRecord
}

function buildServerConfig(body: UnknownRecord, previous: UnknownRecord = {}): UnknownRecord {
  const requestedTransport = String(body.transport || "")
  const transport = ["stdio", "sse", "streamableHttp"].includes(requestedTransport) ? requestedTransport : (body.url ? "sse" : "stdio")
  const env = preserveMap(body, previous, "env")
  const headers = preserveMap(body, previous, "headers")
  const server: UnknownRecord = {
    enabled: body.enabled !== false,
    transport,
    ...(body.description ? { description: String(body.description).trim().slice(0, 240) } : {}),
    ...(body.url ? { url: String(body.url).trim() } : {}),
    ...(body.command ? { command: String(body.command).trim() } : {}),
    ...(Array.isArray(body.args) ? { args: body.args.map(String) } : body.argsText ? { args: String(body.argsText).split(/\s+/).filter(Boolean) } : {}),
    ...(env ? { env } : {}),
    ...(headers ? { headers } : {}),
    category: sanitizeId(body.category || "mcp"),
    risk: ["low", "medium", "high", "external"].includes(String(body.risk || "")) ? String(body.risk) : "external",
    ...(typeof body.requiresFinalReply === "boolean" ? { requiresFinalReply: body.requiresFinalReply } : {}),
    ...(body.execution && typeof body.execution === "object" && !Array.isArray(body.execution) ? { execution: body.execution } : {}),
    ...(body.executionByAction && typeof body.executionByAction === "object" && !Array.isArray(body.executionByAction) ? { executionByAction: body.executionByAction } : {}),
    tags: arrayFrom(body.tags),
    policy: body.policy && typeof body.policy === "object" ? body.policy : { externalNetwork: true },
    toolPolicies: body.toolPolicies && typeof body.toolPolicies === "object" ? body.toolPolicies : {},
    allowedTools: body.allowedTools === undefined ? normalizeAllowedTools(previous.allowedTools) : normalizeAllowedTools(body.allowedTools),
  }
  if (server.transport === "stdio" && !server.command) throw new Error("stdio MCP server must define command")
  if (server.transport !== "stdio" && !server.url) throw new Error(`${server.transport} MCP server must define url`)
  return server
}

/** MCP 服务配置、探测、工具开放范围和删除接口。 */
export function registerMcpRoutes(app: RouteApp): void {
  app.get("/api/mcp", auth, handleRoute(async (_req, res) => {
    res.json({ ok: true, config: redactConfigSecrets(configStore.get().mcp), status: toolRegistry.mcpStatus() })
  }, { errorStatus: 400 }))
  app.post("/api/mcp/test", auth, handleRoute(async (req, res) => {
    const body = req.body || {}
    const id = sanitizeId(body.id || body.name || "mcp-test")
    await withExtensionLock("mcp", id, async () => {
      assertExtensionWritable("mcp", id)
    if (await installationStore.receipt("mcp", id)) throw new Error("受管理服务请使用已保存服务的发现入口")
    const probe = await mcpManager.testServer(id, buildServerConfig(body))
    res.json({ ok: true, probe })
    })
  }, { errorStatus: 400 }))
  app.post("/api/mcp/server", auth, handleRoute(async (req, res) => {
    const body = req.body || {}
    const id = sanitizeId(body.id || body.name || "mcp-server")
    await withExtensionLock("mcp", id, async () => {
      assertExtensionWritable("mcp", id)
    const current = record(record(configStore.get().mcp).servers)[id]
    if (record(current).installationId || await installationStore.receipt("mcp", id)) throw new Error("受管理服务端点修改需要新安装计划；启停、凭据与工具开放使用独立入口")
    const server = buildServerConfig(body, record(current))
    const { saved, runtime } = await updateConfigAndApply(config => configValue({
      ...config,
      mcp: {
        ...record(config.mcp),
        enabled: body.mcpEnabled === undefined ? Boolean(record(config.mcp).enabled ?? true) : Boolean(body.mcpEnabled),
        servers: { ...record(record(config.mcp).servers), [id]: server },
      },
    }))
    res.json({ ok: true, id, server: redactConfigSecrets(record(record(saved.mcp).servers)[id]), config: redactConfigSecrets(saved.mcp), runtime, status: toolRegistry.mcpStatus() })
    })
  }, { errorStatus: 400 }))
  app.post("/api/mcp/:id/discover", auth, handleRoute(async (req, res) => {
    const id = sanitizeId(req.params.id)
    await withExtensionLock("mcp", id, async () => {
      assertExtensionWritable("mcp", id)
    const server = record(record(configStore.get().mcp).servers)[id]
    if (!server || typeof server !== "object" || Array.isArray(server)) throw new Error("MCP 服务不存在")
    const probe = await recordExtensionManagement("mcp", id, "discover", installationWebActor(req), () => mcpManager.testServer(id, record(server)))
    if (record(server).installationId) await configStore.update(config => {
      const current = (config.mcp!.servers as Record<string, Record<string, any>>)[id]
      if (current.url !== record(server).url) throw new Error("服务配置已改变")
      current.discoveredToolSchemas = Object.fromEntries(probe.catalog.map(tool => [tool.originalName, tool.schemaDigest]))
    })
    res.json({ ok: true, probe, status: toolRegistry.mcpStatus() })
    })
  }, { errorStatus: 400 }))
  app.post("/api/mcp/:id/tools", auth, handleRoute(async (req, res) => {
    const id = sanitizeId(req.params.id)
    await withExtensionLock("mcp", id, async () => {
      assertExtensionWritable("mcp", id)
    const allowedTools = normalizeAllowedTools(req.body?.allowedTools)
    const managed = record(record(record(configStore.get().mcp).servers)[id]).installationId
    if (managed && allowedTools === null) throw new Error("受管理服务必须明确选择已发现工具，不允许全开放")
    const { saved, runtime } = await recordExtensionManagement("mcp", id, "update", installationWebActor(req), () => updateConfigAndApply(config => {
      const mcp = record(config.mcp)
      const servers = record(mcp.servers)
      if (!Object.hasOwn(servers, id)) throw new Error("MCP 服务不存在")
      const current = record(servers[id])
      const reviewed = record(current.discoveredToolSchemas)
      if (managed && allowedTools?.some(name => typeof reviewed[name] !== "string")) throw new Error("请先发现并审阅工具，再选择开放名单")
      return configValue({ ...config, mcp: { ...mcp, servers: { ...servers, [id]: { ...current, allowedTools, ...(managed ? { reviewedToolSchemas: Object.fromEntries((allowedTools || []).map(name => [name, reviewed[name]])) } : {}) } } } })
    }))
    res.json({ ok: true, config: redactConfigSecrets(saved.mcp), runtime, status: toolRegistry.mcpStatus() })
    })
  }, { errorStatus: 400 }))
  app.post("/api/mcp/:id/enabled", auth, handleRoute(async (req, res) => {
    const id = sanitizeId(req.params.id)
    await withExtensionLock("mcp", id, async () => {
      assertExtensionWritable("mcp", id)
    const operation = req.body.enabled === false ? "disable" : "activate"
    const { saved, runtime } = await recordExtensionManagement("mcp", id, operation, installationWebActor(req), () => updateConfigAndApply(config => {
      const mcp = record(config.mcp)
      const servers = record(mcp.servers)
      const current = record(servers[id])
      if (!Object.hasOwn(servers, id)) throw new Error(`MCP server ${id} not found`)
      return configValue({
        ...config,
        mcp: {
          ...mcp,
          enabled: req.body?.mcpEnabled === undefined ? Boolean(mcp.enabled ?? true) : Boolean(req.body.mcpEnabled),
          servers: { ...servers, [id]: { ...current, enabled: req.body?.enabled !== false } },
        },
      })
    }))
    res.json({ ok: true, id, config: redactConfigSecrets(saved.mcp), runtime, status: toolRegistry.mcpStatus() })
    })
  }, { errorStatus: 400 }))
  app.delete("/api/mcp/:id", auth, handleRoute(async (req, res) => {
    const id = sanitizeId(req.params.id)
    await withExtensionLock("mcp", id, async () => {
      assertExtensionWritable("mcp", id)
    const { saved, runtime } = await recordExtensionManagement("mcp", id, "uninstall", installationWebActor(req), async () => {
      const result = await updateConfigAndApply(config => {
      const mcp = record(config.mcp)
      const servers = { ...record(mcp.servers) }
      delete servers[id]
      return configValue({ ...config, mcp: { ...mcp, servers } })
    })
      await installationStore.retireReceipt("mcp", id)
      return result
    })
    res.json({ ok: true, id, config: redactConfigSecrets(saved.mcp), runtime, status: toolRegistry.mcpStatus() })
    })
  }, { errorStatus: 400 }))
}
