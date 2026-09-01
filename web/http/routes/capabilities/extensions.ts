import fs from "node:fs/promises"
import path from "node:path"
import { configStore, pluginRoot } from "../../../../config/store.js"
import { createSkillPackage, createSkillTemplate, deleteSkillPackage, getSkillPackage, installRemoteSkill, listSkills, setSkillEnabled, updateRemoteSkill, updateSkillPackage } from "../../../../skills/index.js"
import { customToolManager } from "../../../../tools/custom/manager.js"
import { applyToolPreset, toolPresets } from "../../../../tools/custom/presets.js"
import { toolRegistry } from "../../../../tools/support/registry.js"
import { toolSource } from "../../../../tools/support/contract.js"
import { backgroundTaskService } from "../../../../core/scheduling/background-task-service.js"
import { applyToolRuntimeConfigUpdate } from "../../../../extensions/runtime-config.js"
import { requireWebAuth as auth } from "../../auth.js"
import { createPermissionPreviewEvent as previewEvent, sanitizeWebId as sanitizeId, stringArray as arrayFrom } from "../../request-context.js"
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

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

const sourcePreviewLimit = 30_000
let builtinSourceFilesPromise: Promise<Array<{ file: string; source: string }>> | null = null

async function builtinSourceFiles(): Promise<Array<{ file: string; source: string }>> {
  if (!builtinSourceFilesPromise) {
    builtinSourceFilesPromise = (async () => {
      const directory = path.join(pluginRoot, "tools", "builtins")
      const entries = await fs.readdir(directory, { withFileTypes: true })
      const files = entries
        .filter(entry => entry.isFile() && /\.(?:ts|js)$/i.test(entry.name) && !/\.d\.ts$/i.test(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b))
      return Promise.all(files.map(async file => ({ file: path.posix.join("tools/builtins", file), source: await fs.readFile(path.join(directory, file), "utf8") })))
    })().catch(error => {
      builtinSourceFilesPromise = null
      throw error
    })
  }
  return builtinSourceFilesPromise
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function builtinToolSourcePreview(name: string): Promise<UnknownRecord> {
  for (const item of await builtinSourceFiles()) {
    const marker = new RegExp(`\\bname\\s*=\\s*[\"']${escapeRegExp(name)}[\"']`).exec(item.source)
    if (!marker) continue
    const classStart = item.source.lastIndexOf("export class ", marker.index)
    if (classStart < 0) continue
    const declaration = /^export class\s+([A-Za-z0-9_$]+)/.exec(item.source.slice(classStart))
    const candidates = [
      item.source.indexOf("\nexport class ", marker.index),
      item.source.indexOf("\nexport function ", marker.index),
      item.source.indexOf("\nexport const ", marker.index),
    ].filter(index => index > classStart)
    const end = candidates.length ? Math.min(...candidates) : item.source.length
    const full = item.source.slice(classStart, end).trim()
    const truncated = full.length > sourcePreviewLimit
    return {
      available: true,
      file: item.file,
      symbol: declaration?.[1] || name,
      language: item.file.endsWith(".ts") ? "typescript" : "javascript",
      source: truncated ? `${full.slice(0, sourcePreviewLimit)}\n\n/* 片段过长，已截断 */` : full,
      truncated,
    }
  }
  return { available: false, reason: "未找到与该工具对应的内置实现片段。" }
}

/** 注册工具、Custom Tool、Skill、MCP 与后台任务管理接口。 */
export function registerExtensionRoutes(app: RouteApp): void {
  app.get("/api/tools", auth, handleRoute(async (_req, res) => {
    res.json({
      ok: true,
      tools: await toolRegistry.list(),
      presets: toolPresets,
      mcp: toolRegistry.mcpStatus(),
      custom: toolRegistry.customStatus(),
      skills: toolRegistry.skillStatus(),
      extensionDigest: toolRegistry.extensionDigest(),
      skillErrors: toolRegistry.skillErrors,
      registryErrors: toolRegistry.registryErrors,
    })
  }))
  app.get("/api/tools/background-tasks", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, tasks: backgroundTaskService.list({ limit: req.query?.limit }) })
  }, { errorStatus: 400 }))
  app.post("/api/tools/background-tasks/:id/cancel", auth, handleRoute(async (req, res) => {
    const canceled = backgroundTaskService.cancel(req.params.id)
    if (!canceled) throw new Error("后台任务不存在或已被清理")
    res.json({ ok: true, task: backgroundTaskService.get(req.params.id) })
  }, { errorStatus: 400 }))
  app.get("/api/extensions", auth, handleRoute(async (_req, res) => {
    res.json({ ok: true, digest: toolRegistry.extensionDigest() })
  }))
  // 供控制台主动同步磁盘上的扩展变更；避免仅刷新页面时仍展示旧的内存注册表。
  app.post("/api/tools/reload", auth, handleRoute(async (_req, res) => {
    await toolRegistry.init()
    res.json({ ok: true, tools: await toolRegistry.list(), extensionDigest: toolRegistry.extensionDigest() })
  }, { errorStatus: 400 }))
  app.get("/api/tools/access-preview", auth, handleRoute(async (req, res) => {
    const role = String(req.query.role || "user")
    const e = previewEvent(role, req.query)
    res.json({
      ok: true,
      role,
      tools: await toolRegistry.list({ e }),
    })
  }))
  app.get("/api/tools/access-matrix", auth, handleRoute(async (req, res) => {
    res.json({
      ok: true,
      matrix: await toolRegistry.accessMatrix({
        userId: String(req.query.userId || "") || undefined,
        groupId: String(req.query.groupId || "") || undefined,
      }),
    })
  }))
  app.post("/api/tools/apply-preset", auth, handleRoute(async (req, res) => {
    const requested = req.body?.preset || req.body?.presets || req.body?.presetNames || []
    const presets = Array.isArray(requested) ? requested : [requested]
    const { saved, runtime } = await updateConfigAndApply(config => {
      const next = record(applyToolPreset(config as unknown as UnknownRecord, presets))
      const configTools = record(config.tools)
      const nextTools = record(next.tools || configTools)
      nextTools.activePresets = [...new Set([
        ...stringList(configTools.activePresets),
        ...presets.map(String).filter(Boolean),
      ])]
      next.tools = nextTools
      return configValue(next)
    })
    res.json({ ok: true, presets, config: saved, runtime, tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.post("/api/tools/enabled", auth, handleRoute(async (req, res) => {
    const toolName = String(req.body?.tool || req.body?.name || "").trim()
    if (!toolName) throw new Error("tool is required")
    const { saved, runtime } = await updateConfigAndApply(config => {
      const configTools = record(config.tools)
      const enabled = new Set(stringList(configTools.enabledTools))
      if (req.body?.enabled === false) enabled.delete(toolName)
      else enabled.add(toolName)
      return configValue({
        ...config,
        tools: {
          ...configTools,
          enabledTools: [...enabled],
        },
      })
    })
    res.json({ ok: true, config: saved, runtime, tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.get("/api/tools/:name/source-preview", auth, handleRoute(async (req, res) => {
    const name = String(req.params.name || "").trim()
    const tool = toolRegistry.get(name)
    if (!tool) throw new Error("工具不存在")
    if (toolSource(tool) !== "builtin") {
      return res.json({ ok: true, preview: { available: false, reason: "动态扩展和外部服务只展示模型定义，不读取其源码。" } })
    }
    res.json({ ok: true, preview: await builtinToolSourcePreview(name) })
  }, { errorStatus: 404 }))
  app.put("/api/tools/:name/runtime-config", auth, handleRoute(async (req, res) => {
    const name = String(req.params.name || "").trim()
    const current = record(record(configStore.get().tools).runtimeVariables)[name] || {}
    const value = toolRegistry.applyRuntimeConfigUpdate(name, req.body?.value, current)
    const { saved, runtime } = await updateConfigAndApply(config => {
      const configTools = record(config.tools)
      const runtimeVariables = { ...record(configTools.runtimeVariables) }
      if (Object.keys(value).length) runtimeVariables[name] = value
      else delete runtimeVariables[name]
      return configValue({ ...config, tools: { ...configTools, runtimeVariables } })
    })
    res.json({ ok: true, config: saved, runtime, tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.get("/api/custom-tools", auth, handleRoute(async (_req, res) => {
    await customToolManager.listPackages()
    res.json({ ok: true, custom: toolRegistry.customStatus() })
  }, { errorStatus: 400 }))
  app.post("/api/custom-tools/template", auth, handleRoute(async (req, res) => {
    const dryRun = req.body?.dryRun === true
    const result = await customToolManager.createTemplate(String(req.body?.toolId || req.body?.id || "hello-tool"), { dryRun })
    if (dryRun) return res.json({ ok: true, result })
    await toolRegistry.init()
    res.json({ ok: true, result, custom: toolRegistry.customStatus(), tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.post("/api/custom-tools", auth, handleRoute(async (req, res) => {
    const result = await customToolManager.createPackage(req.body || {})
    await toolRegistry.init()
    res.json({ ok: true, result, custom: toolRegistry.customStatus(), tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.post("/api/custom-tools/:id/enabled", auth, handleRoute(async (req, res) => {
    const result = await customToolManager.setPackageEnabled(req.params.id, req.body?.enabled)
    await toolRegistry.init()
    res.json({ ok: true, result, custom: toolRegistry.customStatus(), tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.get("/api/custom-tools/:id", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, result: await customToolManager.getPackage(req.params.id) })
  }, { errorStatus: 400 }))
  app.put("/api/custom-tools/:id", auth, handleRoute(async (req, res) => {
    const result = await customToolManager.updatePackage(req.params.id, req.body || {})
    await toolRegistry.init()
    res.json({ ok: true, result, custom: toolRegistry.customStatus(), tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.post("/api/custom-tools/:id/test", auth, handleRoute(async (req, res) => {
    const tool = String(req.body?.tool || "").trim()
    if (!tool) throw new Error("请选择要测试的工具")
    const args = req.body?.args === undefined ? {} : req.body.args
    const runtimeConfig = req.body?.runtimeConfig === undefined ? {} : req.body.runtimeConfig
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("测试参数必须是 JSON 对象")
    if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) throw new Error("测试运行变量必须是 JSON 对象")
    const result = await customToolManager.testTool(req.params.id, tool, args as UnknownRecord, {
      e: { isMaster: true, isGroup: false, user_id: "web-custom-test" },
      config: await configStore.load(),
      runtimeConfig: runtimeConfig as UnknownRecord,
      timeoutMs: req.body?.timeoutMs,
    })
    res.json({ ok: true, result })
  }, { errorStatus: 400 }))
  app.delete("/api/custom-tools/:id", auth, handleRoute(async (req, res) => {
    const result = await customToolManager.deletePackage(req.params.id)
    await toolRegistry.init()
    res.json({ ok: true, result, custom: toolRegistry.customStatus(), tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.get("/api/mcp", auth, handleRoute(async (_req, res) => {
    res.json({ ok: true, config: configStore.get().mcp, status: toolRegistry.mcpStatus() })
  }, { errorStatus: 400 }))
  app.post("/api/mcp/server", auth, handleRoute(async (req, res) => {
    const body = req.body || {}
    const id = sanitizeId(body.id || body.name || "mcp-server")
    const requestedTransport = String(body.transport || "")
    const transport = ["stdio", "sse", "streamableHttp"].includes(requestedTransport)
      ? requestedTransport
      : (body.url ? "sse" : "stdio")
    const server: UnknownRecord = {
      enabled: body.enabled !== false,
      transport,
      ...(body.description ? { description: String(body.description).trim().slice(0, 240) } : {}),
      ...(body.url ? { url: String(body.url).trim() } : {}),
      ...(body.command ? { command: String(body.command).trim() } : {}),
      ...(Array.isArray(body.args) ? { args: body.args.map(String) } : body.argsText ? { args: String(body.argsText).split(/\s+/).filter(Boolean) } : {}),
      ...(body.env && typeof body.env === "object" ? { env: body.env } : {}),
      category: sanitizeId(body.category || "mcp"),
      risk: ["low", "medium", "high", "external"].includes(String(body.risk || "")) ? String(body.risk) : "external",
      ...(typeof body.requiresFinalReply === "boolean" ? { requiresFinalReply: body.requiresFinalReply } : {}),
      ...(body.execution && typeof body.execution === "object" && !Array.isArray(body.execution)
        ? { execution: body.execution }
        : {}),
      ...(body.executionByAction && typeof body.executionByAction === "object" && !Array.isArray(body.executionByAction)
        ? { executionByAction: body.executionByAction }
        : {}),
      tags: arrayFrom(body.tags),
      policy: body.policy && typeof body.policy === "object" ? body.policy : { externalNetwork: true },
      toolPolicies: body.toolPolicies && typeof body.toolPolicies === "object" ? body.toolPolicies : {},
    }
    if (server.transport === "stdio" && !server.command) throw new Error("stdio MCP server must define command")
    if (server.transport !== "stdio" && !server.url) throw new Error(`${server.transport} MCP server must define url`)
    const { saved, runtime } = await updateConfigAndApply(config => configValue({
      ...config,
      mcp: {
        ...record(config.mcp),
        enabled: body.mcpEnabled === undefined ? Boolean(record(config.mcp).enabled ?? true) : Boolean(body.mcpEnabled),
        servers: {
          ...record(record(config.mcp).servers),
          [id]: server,
        },
      },
    }))
    res.json({ ok: true, id, server, config: saved.mcp, runtime, status: toolRegistry.mcpStatus() })
  }, { errorStatus: 400 }))
  app.post("/api/mcp/:id/enabled", auth, handleRoute(async (req, res) => {
    const id = sanitizeId(req.params.id)
    const { saved, runtime } = await updateConfigAndApply(config => {
      const mcp = record(config.mcp)
      const servers = record(mcp.servers)
      const current = record(servers[id])
      if (!Object.hasOwn(servers, id)) throw new Error(`MCP server ${id} not found`)
      return configValue({
        ...config,
        mcp: {
          ...mcp,
          enabled: req.body?.mcpEnabled === undefined ? Boolean(mcp.enabled ?? true) : Boolean(req.body.mcpEnabled),
          servers: {
            ...servers,
            [id]: { ...current, enabled: req.body?.enabled !== false },
          },
        },
      })
    })
    res.json({ ok: true, id, config: saved.mcp, runtime, status: toolRegistry.mcpStatus() })
  }, { errorStatus: 400 }))
  app.delete("/api/mcp/:id", auth, handleRoute(async (req, res) => {
    const id = sanitizeId(req.params.id)
    const { saved, runtime } = await updateConfigAndApply(config => {
      const mcp = record(config.mcp)
      const servers = { ...record(mcp.servers) }
      delete servers[id]
      return configValue({
        ...config,
        mcp: { ...mcp, servers },
      })
    })
    res.json({ ok: true, id, config: saved.mcp, runtime, status: toolRegistry.mcpStatus() })
  }, { errorStatus: 400 }))
  app.get("/api/skills", auth, handleRoute(async (_req, res) => {
    res.json({ ok: true, skills: await listSkills(), status: toolRegistry.skillStatus(), errors: toolRegistry.skillErrors })
  }, { errorStatus: 400 }))
  app.post("/api/skills/template", auth, handleRoute(async (req, res) => {
    const dryRun = req.body?.dryRun === true
    const result = await createSkillTemplate(String(req.body?.skillId || req.body?.id || "my-skill"), { dryRun })
    if (dryRun) return res.json({ ok: true, result })
    await toolRegistry.init()
    res.json({ ok: true, result, skills: await listSkills(), tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.post("/api/skills", auth, handleRoute(async (req, res) => {
    const result = await createSkillPackage(req.body || {})
    await toolRegistry.init()
    res.json({ ok: true, result, skills: await listSkills(), status: toolRegistry.skillStatus(), tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.post("/api/skills/install", auth, handleRoute(async (req, res) => {
    const result = await installRemoteSkill(req.body || {})
    await toolRegistry.init()
    res.json({ ok: true, result, skills: await listSkills(), status: toolRegistry.skillStatus(), tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.post("/api/skills/:id/enabled", auth, handleRoute(async (req, res) => {
    const result = await setSkillEnabled(req.params.id, req.body?.enabled)
    await toolRegistry.init()
    res.json({ ok: true, result, skills: await listSkills(), status: toolRegistry.skillStatus(), tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.put("/api/skills/:id/runtime-config", auth, handleRoute(async (req, res) => {
    const id = sanitizeId(req.params.id)
    const skill = (await listSkills()).find(item => item.id === id)
    if (!skill) throw new Error(`Skill ${id} not found`)
    const current = record(record(configStore.get().skills).runtimeVariables)[id] || {}
    const value = applyToolRuntimeConfigUpdate({ name: id, configSchema: skill.configSchema }, req.body?.value, current)
    const { saved, runtime } = await updateConfigAndApply(config => {
      const skills = record(config.skills)
      const runtimeVariables = { ...record(skills.runtimeVariables) }
      if (Object.keys(value).length) runtimeVariables[id] = value
      else delete runtimeVariables[id]
      return configValue({ ...config, skills: { ...skills, runtimeVariables } })
    })
    res.json({ ok: true, config: saved, runtime, skills: await listSkills() })
  }, { errorStatus: 400 }))
  app.post("/api/skills/:id/update-remote", auth, handleRoute(async (req, res) => {
    const result = await updateRemoteSkill(req.params.id)
    await toolRegistry.init()
    res.json({ ok: true, result, skills: await listSkills(), status: toolRegistry.skillStatus(), tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.get("/api/skills/:id", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, result: await getSkillPackage(req.params.id) })
  }, { errorStatus: 400 }))
  app.put("/api/skills/:id", auth, handleRoute(async (req, res) => {
    const result = await updateSkillPackage(req.params.id, req.body || {})
    await toolRegistry.init()
    res.json({ ok: true, result, skills: await listSkills(), status: toolRegistry.skillStatus(), tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
  app.delete("/api/skills/:id", auth, handleRoute(async (req, res) => {
    const result = await deleteSkillPackage(req.params.id)
    await toolRegistry.init()
    res.json({ ok: true, result, skills: await listSkills(), status: toolRegistry.skillStatus(), tools: await toolRegistry.list() })
  }, { errorStatus: 400 }))
}
