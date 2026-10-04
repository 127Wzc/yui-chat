import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import express from 'express'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await fs.mkdir(path.join(root, 'cache'), { recursive: true })
const runtimeRoot = await fs.mkdtemp(path.join(root, 'cache', 'permissions-check-'))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.env.YUI_CHAT_PLUGIN_ROOT = root
process.chdir(path.resolve(root, '../..'))
global.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {} }
global.Bot = { express: null, wsf: {}, uin: [] }
global.plugin = class {}
let server, sqliteClient, modelLogStore
try {
  const { defaults } = await import('../output/runtime/config/defaults.js')
  const { configStore } = await import('../output/runtime/config/store.js')
  const { validateConfig } = await import('../output/runtime/config/validator.js')
  const { normalizeTool } = await import('../output/runtime/tools/support/contract.js')
  const { explainToolPolicy } = await import('../output/runtime/tools/access/policy.js')
  const { previewToolEvent } = await import('../output/runtime/tools/access/matrix.js')
  const { skillManager } = await import('../output/runtime/skills/index.js')
  const { normalizeBoundaryAccess } = await import('../output/runtime/web/client/features/tools/permission-shared.js')
  const tool = normalizeTool({ name: 'permission_fixture', description: 'test', parameters: { type: 'object', properties: {} }, execute: async () => ({}) }, { source: 'custom', risk: 'low', provenance: { packageId: 'fixture' } })
  const config = structuredClone(defaults)
  config.tools.enabled = true
  config.tools.policy.allowCustomTools = true
  const boundary = config.tools.boundaryAccess
  const check = (role = 'user') => explainToolPolicy(tool, { config, e: previewToolEvent(role) })
  boundary.roles.user.allowedSources = ['custom']
  boundary.customPackages.fixture = { roles: { user: false, groupAdmin: true } }
  assert.equal(check().allowed, false, 'explicit package deny defeats source grant')
  assert.equal(check('groupAdmin').allowed, true, 'package role grant works without source grant')
  boundary.roles.user.allowedTools = [tool.name]
  assert.equal(check().allowed, false, 'package deny still blocks explicit tool grant')
  boundary.customPackages.fixture.roles.user = true
  assert.equal(check().allowed, true)
  boundary.roles.user.deniedTools = [tool.name]
  assert.equal(check().allowed, false, 'tool deny wins over package allow')
  boundary.roles.user.deniedTools = []
  tool.common.policy.requiresMaster = true
  assert.equal(check().allowed, false, 'grant cannot bypass hard tool policy')
  tool.common.policy.requiresMaster = false
  boundary.roles.user.allowedTools = []
  tool.common.policy.externalNetwork = true
  boundary.roles.user.allowExternalNetwork = false
  assert.equal(check().allowed, false, 'package grant keeps external network guard')
  tool.common.policy.externalNetwork = false
  boundary.customPackages.fixture = { minRole: 'master' }
  assert.equal(check().allowed, true, 'existing supplementary minRole semantics preserved')
  boundary.customPackages.fixture = { enabled: false, roles: { user: true } }
  assert.equal(check().allowed, false, 'package disabled remains authoritative')
  const mcpTool = normalizeTool({ name: 'mcp_fixture_query', execute: async () => ({}) }, { source: 'mcp', risk: 'low', provenance: { serverName: 'fixture', originalName: 'query' } })
  config.mcp.enabled = true
  config.mcp.servers.fixture = { enabled: true, allowedTools: null }
  config.tools.policy.allowMcpTools = true
  boundary.roles.user.allowedSources = ['custom', 'mcp']
  boundary.mcpServers.fixture = { roles: { user: false } }
  assert.equal(explainToolPolicy(mcpTool, { config, e: previewToolEvent('user') }).allowed, false)
  boundary.mcpServers.fixture.roles.user = true
  assert.equal(explainToolPolicy(mcpTool, { config, e: previewToolEvent('user') }).allowed, true)
  config.mcp.servers.fixture.allowedTools = []
  assert.equal(explainToolPolicy(mcpTool, { config, e: previewToolEvent('user') }).allowed, false, 'role grant cannot override MCP injection list')
  config.actions = { enabled: true, items: { fixture: { enabled: true, tool: tool.name, minRole: 'user', scope: 'all' } } }
  assert.equal(explainToolPolicy(tool, { config, e: previewToolEvent('user'), actionId: 'fixture' }).allowed, true, 'saved actions retain independent authorization')
  boundary.skillPackages.demo = { roles: { user: false, groupOwner: true } }
  assert.equal(skillManager.allowedByPackage({ id: 'demo' }, previewToolEvent('user'), config), false)
  assert.equal(skillManager.allowedByPackage({ id: 'demo' }, previewToolEvent('groupOwner'), config), true)
  assert.deepEqual(normalizeBoundaryAccess(boundary).skillPackages.demo.roles, { user: false, groupOwner: true }, 'advanced editor preserves role overrides')
  boundary.skillPackages.demo.roles.user = 'yes'
  assert(validateConfig(config).issues.some(item => item.path.includes('roles.user') && item.level === 'error'))

  ;({ sqliteClient } = await import('../output/runtime/core/storage/sqlite/client.js'))
  ;({ modelLogStore } = await import('../output/runtime/core/observability/model-log.js'))
  const { SqliteRuntimeConfigRepository } = await import('../output/runtime/core/storage/sqlite/runtime-config-repository.js')
  await sqliteClient.init(await configStore.load())
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  await configStore.update(value => {
    value.web.authToken = 'permissions-fixture-token'
    value.mcp.enabled = false
    value.mcp.servers = { 'fixture.with.dot': { enabled: false, transport: 'stdio', command: 'disabled-fixture' } }
  })
  const { createWebApp } = await import('../output/runtime/web/http/app.js')
  const app = express()
  app.use('/yui-chat', createWebApp())
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/yui-chat/api/tools/access-role`
  async function change(body, headers = { 'yui-chat-token': 'permissions-fixture-token' }) {
    const result = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: result.status, body: await result.json() }
  }
  const request = { scope: 'mcpServers', id: 'fixture.with.dot', role: 'user', allowed: true }
  assert.equal((await change(request, {})).status, 401)
  for (const patch of [{ role: 'bogus' }, { role: null }, { allowed: 'true' }, { id: '__proto__' }, { id: 'missing' }, { scope: 'invalid' }]) {
    assert.equal((await change({ ...request, ...patch })).status, 400, JSON.stringify(patch))
  }
  const updates = await Promise.all([change(request), change({ ...request, role: 'groupAdmin', allowed: false })])
  assert(updates.every(item => item.status === 200), JSON.stringify(updates))
  assert.deepEqual(configStore.get().tools.boundaryAccess.mcpServers[request.id].roles, { user: true, groupAdmin: false }, 'concurrent role edits preserve both writes and dotted IDs')
  assert.equal(configStore.get().mcp.servers[request.id].enabled, false, 'permission change never enables a service')
  await change({ ...request, allowed: null })
  assert.deepEqual(configStore.get().tools.boundaryAccess.mcpServers[request.id].roles, { groupAdmin: false })
  await change({ ...request, role: null, allowed: null })
  assert.equal(configStore.get().tools.boundaryAccess.mcpServers[request.id], undefined)
  const toolRequest = { scope: 'tool', id: 'weather', role: 'user', allowed: false }
  assert.equal((await change(toolRequest)).status, 200)
  assert(configStore.get().tools.boundaryAccess.roles.user.deniedTools.includes('weather'))
  assert.equal((await change({ ...toolRequest, allowed: true })).status, 200)
  assert(configStore.get().tools.boundaryAccess.roles.user.allowedTools.includes('weather'))
  assert(!configStore.get().tools.boundaryAccess.roles.user.deniedTools.includes('weather'))
  assert.equal((await change({ ...toolRequest, role: null, allowed: null })).status, 200)
  assert(!configStore.get().tools.boundaryAccess.roles.user.allowedTools.includes('weather'))
  await configStore.update(value => { value.tools.boundaryAccess.enabled = false })
  assert.equal((await change(request)).status, 400, 'disabled boundary cannot silently accept ineffective edits')

  // Render real Vue templates and exercise shared state without executing tools.
  global.location = { hash: '', pathname: '/yui-chat', search: '' }
  global.localStorage = { getItem() { return null } }
  const { createSSRApp, h, ref } = await import('vue')
  const { renderToString } = await import('vue/server-renderer')
  const { compile } = await import('vue')
  const { store } = await import('../output/runtime/web/client/app/store/store.js')
  const { CapabilityRoleButtons } = await import('../output/runtime/web/client/features/tools/capability-role-buttons.js')
  store.config = { tools: { boundaryAccess: { enabled: true, roles: {}, customPackages: { fixture: { roles: { user: true } } } } } }
  const matrix = ref({ rows: [
    { tool: { name: 'one', common: { provenance: { packageId: 'fixture' } } }, decisions: { user: { allowed: true } } },
    { tool: { name: 'two', common: { provenance: { packageId: 'fixture' } } }, decisions: { user: { allowed: false, reason: '工具需要主人' } } },
  ] })
  const view = createSSRApp({ render: () => h(CapabilityRoleButtons, { scope: 'customPackages', id: 'fixture', details: true }) })
  view.provide('capabilityAccessMatrix', matrix)
  view.provide('capabilityAccessSaving', ref(false))
  view.provide('reloadCapabilityAccess', async () => {})
  const html = await renderToString(view)
  assert(html.includes('部分可用 1/2'))
  assert(html.includes('工具需要主人'))
  assert(html.includes('单独设置 2 个工具'))
  assert(html.includes('普通用户') && html.includes('管理员') && html.includes('群主') && html.includes('主人'))
  const { PermissionOverview } = await import('../output/runtime/web/client/features/tools/permission-overview.js')
  const overviewView = createSSRApp({ render: () => h(PermissionOverview) })
  const sharedUi = (await import('../output/runtime/web/client/ui/components.js')).components
  for (const [name, component] of Object.entries(sharedUi)) overviewView.component(name, component)
  overviewView.provide('capabilityAccessMatrix', matrix)
  overviewView.provide('capabilityAccessSaving', ref(false))
  overviewView.provide('reloadCapabilityAccess', async () => {})
  const overviewHtml = await renderToString(overviewView)
  assert(overviewHtml.includes('权限总览') && overviewHtml.includes('权限查询') && overviewHtml.includes('one') && overviewHtml.includes('two'))
  assert(overviewHtml.includes('工具需要主人') && overviewHtml.includes('只看角色差异'))
  assert(overviewHtml.includes('permission-role-column') && overviewHtml.includes('aria-pressed="false"'))
  assert(!overviewHtml.includes('type="checkbox"'), 'difference filtering uses a compact button')
  const { CapabilityFilterBar } = await import('../output/runtime/web/client/features/tools/capability-filter-bar.js')
  const filterView = createSSRApp({ render: () => h(CapabilityFilterBar, { query: '天气', status: 'disabled', category: 'custom', categoryOptions: [['all', '全部类型'], ['custom', 'Custom']], count: 1, total: 12 }, { extra: () => h('select', { 'aria-label': '分类' }), summary: () => h('span', '词元统计') }) })
  filterView.component('Icon', { render: () => null })
  const filterHtml = await renderToString(filterView)
  assert(filterHtml.includes('value="天气"') && filterHtml.includes('aria-pressed="true">未启用'))
  assert(filterHtml.indexOf('capability-category-select') < filterHtml.indexOf('filter-search'))
  assert(filterHtml.includes('value="custom"') && filterHtml.includes('Custom</option>'))
  assert(filterHtml.includes('清空筛选') && filterHtml.includes('1/12') && filterHtml.includes('词元统计') && filterHtml.includes('aria-label="分类"'))
  const { CapabilityList, CapabilityRisk, capabilityRisk } = await import('../output/runtime/web/client/features/tools/capability-list.js')
  assert.equal(capabilityRisk({}).label, '待确认')
  assert.equal(capabilityRisk({ common: { risk: 'low', policy: { highRisk: true } } }).tone, 'risk-high')
  assert.equal(capabilityRisk({ risk: 'external' }).label, '外网访问')
  const listView = createSSRApp({ render: () => h(CapabilityList, { rows: Array.from({ length: 12 }, (_, i) => ({ name: `tool-${i}`, risk: 'high' })) }, {
    identity: ({ item }) => h('strong', item.name),
    risk: ({ item }) => h(CapabilityRisk, { tool: item }),
    actions: () => h('button', '配置'),
    roles: () => h('span', '角色操作'),
  }) })
  const { components } = await import('../output/runtime/web/client/ui/components.js')
  for (const [name, component] of Object.entries(components)) listView.component(name, component)
  const listHtml = await renderToString(listView)
  assert(listHtml.includes('风险等级') && listHtml.includes('高风险') && listHtml.includes('角色操作'))
  assert(listHtml.includes('tool-9') && !listHtml.includes('tool-10'), 'shared list paginates actual rows')
  assert(listHtml.indexOf('class="pager"') > listHtml.indexOf('tool-9'), 'pagination follows the list content')
  const emptyHtml = await renderToString(createSSRApp({ render: () => h(CapabilityList, { rows: [], empty: '空列表提示' }) }))
  assert(emptyHtml.includes('空列表提示') && !emptyHtml.includes('capability-list-row'))
  for (const [file, name] of [['permission-overview', 'PermissionOverview'], ['tools-list-panel', 'ToolListPanel'], ['extension-library-panel', 'ExtensionLibraryPanel'], ['mcp-panel', 'McpPanel'], ['mcp-tools-panel', 'McpToolsPanel'], ['permission-panel', 'BoundaryAccessPanel'], ['permission-role-drawer', 'PermissionRoleDrawer']]) {
    const component = (await import(`../output/runtime/web/client/features/tools/${file}.js`))[name]
    compile(component.template, { onError(error) { throw error } })
  }
  console.log('ok capability permissions: policy, Skill, validation, concurrent authenticated HTTP edits, reset, Vue rendering')
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  const { mcpManager } = await import('../output/runtime/mcp/index.js')
  await mcpManager.destroy()
  await modelLogStore?.stop({ flush: true })
  await sqliteClient?.close()
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}
process.exit(0)
