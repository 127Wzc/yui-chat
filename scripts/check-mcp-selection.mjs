import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import express from "express"
import { once } from "node:events"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
await fs.mkdir(path.join(root, "cache"), { recursive: true })
const runtimeRoot = await fs.mkdtemp(path.join(root, "cache", "mcp-selection-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.env.YUI_CHAT_PLUGIN_ROOT = root
process.chdir(path.resolve(root, "../.."))
global.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {} }
global.Bot = { express: null, wsf: {}, uin: [] }
global.plugin = class {}
  let manager, coldManager, server, mcpHttpServer, sqliteClient, modelLogStore
try {
  const fixture = path.join(runtimeRoot, "server.mjs")
  await fs.writeFile(fixture, `import readline from 'node:readline';
const tool = name => ({name, description: name, inputSchema: {type:'object',properties:{}}, annotations:{readOnlyHint:true}});
readline.createInterface({input:process.stdin}).on('line', line => {
 const req = JSON.parse(line); if (req.id === undefined) return;
 let result = {};
 if (req.method === 'initialize') result = {protocolVersion:req.params.protocolVersion, capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 if (req.method === 'tools/list' && process.env.MCP_FIXTURE_FAIL === '1') process.exit(1);
 if (req.method === 'tools/list') result = req.params?.cursor ? {tools:[tool('delete_image')]} : {tools:[tool('search_images')],nextCursor:'second'};
 if (req.method === 'tools/call') result = {content:[{type:'text',text:'ok'}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
});`)
  const { configStore } = await import("../output/runtime/config/store.js")
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { resolveMcpEnv, resolveMcpHeaders, resolveMcpUrl } = await import("../output/runtime/mcp/transport-auth.js")
  const { mergeRedactedConfigSecrets, redactConfigSecrets } = await import("../output/runtime/config/store.js")
  const { McpManager } = await import("../output/runtime/mcp/index.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  process.env.MCP_SELECTION_TEST_TOKEN = "selection-secret"
  assert.equal(resolveMcpUrl("https://example.test/${env:MCP_SELECTION_TEST_TOKEN}/mcp"), "https://example.test/selection-secret/mcp")
  assert.deepEqual(resolveMcpHeaders({ Authorization: "Bearer ${env:MCP_SELECTION_TEST_TOKEN}" }), { Authorization: "Bearer selection-secret" })
  assert.deepEqual(resolveMcpEnv({ IMAGE_API_KEY: "${env:MCP_SELECTION_TEST_TOKEN}" }), { IMAGE_API_KEY: "selection-secret" })
  await assert.rejects(async () => resolveMcpHeaders({ Authorization: "${env:MCP_SELECTION_MISSING}" }), /环境变量未设置/)
  assert.deepEqual(redactConfigSecrets({ headers: { Authorization: "Bearer selection-secret", "X-Trace": "trace" } }), { headers: { Authorization: "********", "X-Trace": "trace" } })
  assert.deepEqual(mergeRedactedConfigSecrets({ headers: { Authorization: "********" } }, { headers: { Authorization: "Bearer selection-secret" } }), { headers: { Authorization: "Bearer selection-secret" } })
  const httpRequests = []
  const mcpHttpApp = express()
  mcpHttpApp.use(express.json())
  mcpHttpApp.post("/mcp", (req, res) => {
    httpRequests.push(req.headers)
    const rpc = req.body || {}
    if (rpc.id === undefined) return res.status(202).end()
    const tool = name => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } })
    let result = {}
    if (rpc.method === "initialize") result = { protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1" } }
    if (rpc.method === "tools/list") result = { tools: [tool("search_images")] }
    res.set("mcp-session-id", "selection-test-session").json({ jsonrpc: "2.0", id: rpc.id, result })
  })
  mcpHttpServer = mcpHttpApp.listen(0, "127.0.0.1")
  await once(mcpHttpServer, "listening")
  const httpManager = new McpManager()
  const previousScopedToken = process.env.MCP_SCOPED_HEADER_TOKEN
  delete process.env.MCP_SCOPED_HEADER_TOKEN
  const httpProbe = await httpManager.testServer("http-gallery", {
    transport: "streamableHttp",
    url: `http://127.0.0.1:${mcpHttpServer.address().port}/mcp`,
    env: { MCP_SCOPED_HEADER_TOKEN: "scoped-secret" },
    headers: { Authorization: "Bearer ${env:MCP_SCOPED_HEADER_TOKEN}" },
  })
  assert.deepEqual(httpProbe.exposed, ["search_images"])
  assert.equal(httpRequests[0]?.authorization, "Bearer scoped-secret", "streamable HTTP must send scoped Authorization")
  assert.equal(process.env.MCP_SCOPED_HEADER_TOKEN, undefined, "MCP env must not mutate the host process environment")
  if (previousScopedToken === undefined) delete process.env.MCP_SCOPED_HEADER_TOKEN
  else process.env.MCP_SCOPED_HEADER_TOKEN = previousScopedToken
  await httpManager.destroy()
  const config = structuredClone(defaults)
  config.mcp.enabled = true
  config.mcp.servers = { gallery: { command: process.execPath, args: [fixture], transport: "stdio", allowedTools: ["search_images"] } }
  config.tools.boundaryAccess.enabled = false
  const originalLoad = configStore.load
  const originalGet = configStore.get
  configStore.load = async () => structuredClone(config)
  configStore.get = () => config
  // 冷启动首次连接失败时，名单中的工具仍先以待恢复适配器注入，后续调用可主动重连。
  config.mcp.servers.gallery.env = { MCP_FIXTURE_FAIL: "1" }
  coldManager = new McpManager()
  await coldManager.init()
  assert.deepEqual(coldManager.getTools().map(tool => tool.originalName), ["search_images"], "冷启动失败仍保留已配置工具")
  assert.equal(coldManager.status().catalog[0]?.status, "unavailable")
  delete config.mcp.servers.gallery.env
  assert.equal((await coldManager.getTools()[0].execute({})).content[0].text, "ok", "冷启动失败后的首次触发可以重连")
  await coldManager.destroy()
  // 全开放模式没有可预先注入的工具名，后续异步入口会主动重试发现并补回工具。
  config.mcp.servers.gallery.allowedTools = null
  config.mcp.servers.gallery.env = { MCP_FIXTURE_FAIL: "1" }
  coldManager = new McpManager()
  await coldManager.init()
  assert.equal(coldManager.getTools().length, 0)
  delete config.mcp.servers.gallery.env
  assert.equal(await coldManager.retryFailedServers(), true, "后续入口可以重试冷启动失败的服务")
  assert.deepEqual(coldManager.getTools().map(tool => tool.originalName), ["search_images", "delete_image"])
  await coldManager.destroy()
  config.mcp.servers.gallery.allowedTools = ["search_images"]
  manager = new McpManager()
  await manager.init()
  assert.deepEqual(manager.status().errors, [])
  assert.equal(manager.status().catalog.length, 2, "discover every page, including closed tools")
  assert.deepEqual(manager.getTools().map(tool => tool.originalName), ["search_images"])
  assert.equal(manager.status().catalog.find(tool => tool.originalName === "delete_image").exposed, false)
  const probe = await manager.testServer("probe-gallery", config.mcp.servers.gallery)
  assert.deepEqual(probe.catalog.map(tool => tool.originalName), ["search_images", "delete_image"])
  assert.deepEqual(probe.exposed, ["search_images"])
  assert.equal(manager.status().clients.includes("probe-gallery"), false, "probe must not replace runtime connections")
  for (const tool of manager.getTools()) toolRegistry.register(tool)
  const context = { config, e: { isMaster: true, user_id: 'tester' } }
  assert.equal((await toolRegistry.execute('mcp_gallery_search_images', {}, context)).content[0].text, 'ok')
  await assert.rejects(() => toolRegistry.execute('mcp_gallery_delete_image', {}, context), /not found/)
  // 断线只改变运行状态，不撤销已经注入的工具；下一次调用会按原工具对象自动恢复。
  config.mcp.servers.gallery.env = { MCP_FIXTURE_FAIL: "1" }
  await manager.init()
  assert.deepEqual(manager.getTools().map(tool => tool.originalName), ["search_images"], "断线时保留已开放工具")
  assert.equal(manager.status().catalog.find(tool => tool.originalName === "search_images").status, "unavailable")
  assert.match(manager.status().errors.find(error => error.server === "gallery")?.error || "", /MCP|exit|closed|断开/i)
  const disconnectedTool = manager.getTools()[0]
  await assert.rejects(() => disconnectedTool.execute({}), /当前不可用/)
  delete config.mcp.servers.gallery.env
  assert.equal((await disconnectedTool.execute({})).content[0].text, "ok", "下一次调用重新连接并复用工具")
  assert.equal(manager.status().clients.includes("gallery"), true)
  assert.equal(manager.status().catalog.find(tool => tool.originalName === "search_images").status, "available")
  assert.equal(manager.status().errors.some(error => error.server === "gallery"), false)
  config.mcp.servers.gallery.allowedTools = []
  await assert.rejects(() => toolRegistry.execute('mcp_gallery_search_images', {}, { ...context, allowDisabledTool: true }), /注入已关闭/)
  assert.equal((await toolRegistry.searchAllowedTools('search_images', context, 10)).length, 0)
  await manager.init()
  assert.equal(manager.getTools().length, 0)
  assert.equal(manager.status().catalog.length, 2)
  config.mcp.servers.gallery.allowedTools = null
  await manager.init()
  assert.equal(manager.getTools().length, 2)
  delete config.mcp.servers.gallery.allowedTools
  await manager.init()
  assert.equal(manager.getTools().length, 2, 'legacy configurations retain all tools')
  config.mcp.servers.gallery.allowedTools = ['missing']
  await manager.init()
  assert.equal(manager.getTools().length, 0, 'unknown names never fall back to all')
  for (const invalid of ['search_images', [1], [''], [' search_images']]) {
    config.mcp.servers.gallery.allowedTools = invalid
    assert.equal(validateConfig(config).ok, false)
  }
  config.mcp.servers.gallery.allowedTools = []
  config.mcp.enabled = false
  await manager.init()
  assert.equal(manager.status().catalog.length, 0)
  assert.equal(manager.status().clients.length, 0)
  configStore.load = originalLoad
  configStore.get = originalGet
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  ;({ modelLogStore } = await import("../output/runtime/core/observability/model-log.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  await sqliteClient.init(await configStore.load())
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  await configStore.update(value => {
    value.web.authToken = "mcp-selection-test-local"
    value.mcp.enabled = false
    value.mcp.servers = { gallery: { enabled: false, transport: "stdio", command: process.execPath, args: [fixture], allowedTools: ["search_images"] } }
  })
  const { createWebApp } = await import("../output/runtime/web/http/app.js")
  const app = express()
  app.use("/yui-chat", createWebApp())
  server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  async function api(endpoint, body, authorized = true) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/yui-chat${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json", ...(authorized ? { "yui-chat-token": "mcp-selection-test-local" } : {}) }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await api("/api/mcp/gallery/tools", { allowedTools: [] }, false)).status, 401)
  assert.equal((await api("/api/mcp/gallery/tools", { allowedTools: "search_images" })).status, 400)
  assert.equal((await api("/api/mcp/missing/tools", { allowedTools: [] })).status, 400)
  let response = await api("/api/mcp/gallery/tools", { allowedTools: ["search_images", "search_images"] })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.config.servers.gallery.allowedTools, ["search_images"])
  assert.equal(response.body.config.servers.gallery.command, process.execPath)
  response = await api("/api/mcp/server", { id: "gallery", transport: "stdio", command: process.execPath, argsText: fixture, enabled: false })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.server.allowedTools, ["search_images"], "connection edits preserve selection")
  response = await api("/api/mcp/gallery/discover", {})
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.probe.exposed, ["search_images"])
  response = await api("/api/mcp/test", { id: "unsaved-gallery", transport: "stdio", command: process.execPath, argsText: fixture, allowedTools: ["delete_image"] })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.probe.exposed, ["delete_image"], "unsaved probe uses the submitted allowlist")
  for (const allowedTools of [[], null]) {
    response = await api("/api/mcp/gallery/tools", { allowedTools })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.config.servers.gallery.allowedTools, allowedTools)
  }
  console.log('MCP selection checks passed (discovery, pagination, injection, revocation, config and HTTP)')
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  if (mcpHttpServer) { mcpHttpServer.closeAllConnections(); await new Promise(resolve => mcpHttpServer.close(resolve)) }
  await manager?.destroy()
  await coldManager?.destroy()
  const { mcpManager } = await import("../output/runtime/mcp/index.js")
  await mcpManager.destroy()
  await modelLogStore?.stop({ flush: true })
  await sqliteClient?.close()
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}

process.exit(0)
