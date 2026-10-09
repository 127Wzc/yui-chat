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
  assert.equal(check().allowed, false, 'default is master only')
  assert.equal(check('master').allowed, true)
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
  tool.common.risk = 'high'
  tool.common.policy.highRisk = true
  assert.equal(check().allowed, true, 'high risk is a label and can be granted to ordinary users')
  tool.common.policy.externalNetwork = true
  config.tools.policy.allowExternalNetwork = false
  assert.equal(check().allowed, false, 'global network safety switch remains effective')
  config.tools.policy.allowExternalNetwork = true
  tool.common.policy.externalNetwork = false
  boundary.customPackages.fixture = { minRole: 'user', enabled: true }
  boundary.roles.user.allowedSources = ['custom']
  boundary.roles.user.allowAllEnabledTools = true
  assert.equal(check().allowed, false, 'retired source/minRole/all-tools grants are ignored')
  boundary.customPackages.fixture = { roles: { user: true } }
  const mcpTool = normalizeTool({ name: 'mcp_fixture_query', execute: async () => ({}) }, { source: 'mcp', risk: 'low', provenance: { serverName: 'fixture', originalName: 'query' } })
  config.mcp.enabled = true
  config.mcp.servers.fixture = { enabled: true, allowedTools: null }
  config.tools.policy.allowMcpTools = true
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
  assert.equal(configStore.get().tools.boundaryAccess.enabled, undefined, 'retired bypass switch is discarded')
  assert.equal((await change(request)).status, 200)

  // User overrides persist across reloads and cover package, service and Skill grants.
  const { capabilityStore } = await import('../output/runtime/tools/access/capability-store.js')
  capabilityStore.rules.push({subject_type:'group',subject_id:'20001',group_id:'',resource_type:'tool',resource_id:tool.name,effect:'allow'})
  assert.equal(capabilityStore.decision(previewToolEvent('user'),tool.name),'','retired whole-group overrides cannot grant capabilities')
  capabilityStore.rules = []
  const overrideUrl = url.replace('/tools/access-role', '/capabilities/overrides')
  async function userRule(body, authorized = true) {
    const response = await fetch(overrideUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { 'yui-chat-token': 'permissions-fixture-token' } : {}) }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const personal = { subjectId: '10001', groupId: '20001', resourceType: 'customPackages', resourceId: 'fixture', effect: 'allow' }
  assert.equal((await userRule(personal, false)).status, 401)
  for (const patch of [{subjectId:''}, {groupId:'bad'}, {effect:'yes'}, {resourceType:'bad'}, {resourceId:'__proto__'}]) assert.equal((await userRule({...personal,...patch})).status,400)
  boundary.customPackages.fixture = {}
  assert.equal((await userRule(personal)).status, 200)
  await capabilityStore.load()
  assert.equal(check().allowed, true, 'individual may use high risk tool')
  boundary.roles.user.deniedTools.push(tool.name)
  boundary.customPackages.fixture = { roles: { user: false } }
  assert.equal(check().allowed, true, 'personal package allow overrides explicit role denies')
  await userRule({...personal,effect:'default'})
  await userRule({...personal,resourceType:'tool',resourceId:tool.name})
  assert.equal(check().allowed, true, 'personal tool allow overrides role and parent deny')
  await userRule({...personal,effect:'deny'})
  assert.equal(check().allowed, false, 'personal deny still wins over personal tool allow')
  await userRule({...personal,resourceType:'tool',resourceId:tool.name,effect:'default'})
  boundary.roles.user.deniedTools = boundary.roles.user.deniedTools.filter(name => name !== tool.name)
  boundary.customPackages.fixture = {}
  await userRule(personal)
  const { defaultActionRole } = await import('../output/runtime/core/actions/execution.js')
  assert.equal(defaultActionRole(tool, config), 'master', 'action creation inherits roles, not sample user exceptions')
  const { buildToolAccessMatrix } = await import('../output/runtime/tools/access/matrix.js')
  const roleOnly = await buildToolAccessMatrix([tool])
  assert.equal(roleOnly.rows[0].decisions.user.allowed, false, 'role overview must ignore example user overrides')
  const actualUser = await buildToolAccessMatrix([tool], {userId:'10001',groupId:'20001'})
  assert.equal(actualUser.rows[0].decisions.user.allowed, true)
  assert.equal(explainToolPolicy(tool,{config,e:{user_id:'10001',message_type:'private',group_id:'20001'}}).allowed,false,'group-scoped user grants never apply to private temporary sessions')
  assert.equal(explainToolPolicy(tool, {config, e:previewToolEvent('user',{groupId:'20002'})}).allowed,false, 'user grant is group scoped')
  assert.equal((await userRule({...personal,effect:'deny'})).status,200)
  assert.equal(check().allowed,false)
  await userRule({...personal,effect:'default'})
  assert.equal(check().allowed,false)
  await userRule({...personal,resourceType:'skillPackages',resourceId:'demo'})
  boundary.skillPackages.demo = {}
  assert.equal(skillManager.allowedByPackage({id:'demo'},previewToolEvent('user'),config),true)
  await userRule({...personal,resourceType:'skillPackages',resourceId:'demo',effect:'default'})
  assert.equal(skillManager.allowedByPackage({id:'demo'},previewToolEvent('user'),config),false)
  config.mcp.servers.fixture.allowedTools = null
  boundary.mcpServers.fixture = {}
  await userRule({...personal,resourceType:'mcpServers'})
  assert.equal(explainToolPolicy(mcpTool,{config,e:previewToolEvent('user')}).allowed,true)
  config.mcp.servers.fixture.allowedTools = []
  assert.equal(explainToolPolicy(mcpTool,{config,e:previewToolEvent('user')}).allowed,false)
  await userRule({...personal,resourceType:'mcpServers',effect:'default'})

  const { createBuiltinTools } = await import('../output/runtime/tools/builtins/index.js')
  const { builtinRoleRecommendations, applyBuiltinRolePreset } = await import('../output/runtime/tools/access/role-presets.js')
  assert.deepEqual(Object.keys(builtinRoleRecommendations).sort(), createBuiltinTools().map(t => t.name).sort(), 'recommendations cover every registered builtin')
  const preset = applyBuiltinRolePreset({allowedTools:['custom_keep'],deniedTools:['other_keep']},'user',Object.keys(builtinRoleRecommendations))
  assert(preset.allowedTools.includes('custom_keep') && preset.allowedTools.includes('weather'))
  assert(preset.deniedTools.includes('other_keep') && preset.deniedTools.includes('kick_out'))
  assert(!createBuiltinTools().find(t => t.name === 'knowledge_manage').common.parameters.properties.action.enum.includes('handoff'))
  const presetUrl = url.replace('access-role','role-preset')
  assert.equal((await fetch(presetUrl)).status,401)
  const presetResponse = await fetch(presetUrl,{method:'POST',headers:{'content-type':'application/json','yui-chat-token':'permissions-fixture-token'},body:JSON.stringify({role:'user'})})
  assert.equal(presetResponse.status,200)
  assert.equal((await presetResponse.json()).hotApplied,true)
  assert(configStore.get().tools.boundaryAccess.roles.user.allowedTools.includes('weather'))
  assert.equal(configStore.get().tools.boundaryAccess.mcpServers['fixture.with.dot'].roles.user,true)
  await configStore.update(value => {value.tools.boundaryAccess.roles.user = structuredClone(defaults.tools.boundaryAccess.roles.user)})
  const publicConfig = structuredClone(defaults)
  const publicNames = ['bilibili_media','image_media','message_send','tool_search']
  for (const name of publicNames) {
    const builtin = createBuiltinTools().find(t => t.name === name)
    for (const role of ['user','groupAdmin','groupOwner','master']) assert.equal(explainToolPolicy(builtin,{config:publicConfig,e:previewToolEvent(role)}).allowed,true,`${name} defaults public for ${role}`)
    publicConfig.tools.boundaryAccess.roles.user.deniedTools.push(name)
    assert.equal(explainToolPolicy(builtin,{config:publicConfig,e:previewToolEvent('user')}).allowed,false,'explicit deny overrides public default')
    publicConfig.tools.boundaryAccess.roles.user.deniedTools = []
    publicConfig.tools.enabledTools = publicConfig.tools.enabledTools.filter(n => n !== name)
    assert.equal(explainToolPolicy(builtin,{config:publicConfig,e:previewToolEvent('user')}).allowed,false,'disabled still denied')
    publicConfig.tools.enabledTools.push(name)
    await userRule({...personal,resourceType:'tool',resourceId:name,effect:'deny'})
    assert.equal(explainToolPolicy(builtin,{config:publicConfig,e:previewToolEvent('user')}).allowed,false,'personal deny overrides public default')
    await userRule({...personal,resourceType:'tool',resourceId:name,effect:'default'})
  }
  for (const name of ['knowledge_manage','memory_manage','schedule_task','music_play','weather','web_search','query_userinfo','render_image','send_dice','send_rps']) {
    const cfg = structuredClone(defaults)
    cfg.tools.enabledTools.push(name)
    const builtin = createBuiltinTools().find(t=>t.name===name)
    assert.equal(explainToolPolicy(builtin,{config:cfg,e:previewToolEvent('user')}).allowed,true,`${name} daily builtin default`)
  }
  for (const name of ['kick_out','message_manage','persona_punishment_release']) {
    const cfg = structuredClone(defaults)
    cfg.tools.enabledTools.push(name)
    const builtin = createBuiltinTools().find(t=>t.name===name)
    assert.equal(explainToolPolicy(builtin,{config:cfg,e:previewToolEvent('user')}).allowed,false)
    assert.equal(explainToolPolicy(builtin,{config:cfg,e:previewToolEvent('groupAdmin')}).allowed,true)
  }
  const mediaMatrix = await buildToolAccessMatrix(createBuiltinTools().filter(t => publicNames.includes(t.name)))
  assert(mediaMatrix.rows.every(row => row.tool.common.defaultRoleLabel === '默认所有角色'))
  const highConfig = structuredClone(defaults)
  highConfig.tools.enabledTools.push('render_url_screenshot')
  highConfig.response.render.url.enabled = true
  for (const name of ['render_url_screenshot','dispatch_subagent']) {
    const builtin = createBuiltinTools().find(tool => tool.name === name)
    assert.equal(explainToolPolicy(builtin,{config:highConfig,e:previewToolEvent('user')}).allowed,false)
    highConfig.tools.boundaryAccess.roles.user.allowedTools.push(name)
    assert.equal(explainToolPolicy(builtin,{config:highConfig,e:previewToolEvent('user')}).allowed,true,`${name} can be manually opened to ordinary members`)
  }

  // Exercise Registry -> parameter authorization -> real builtins with a fake host.
  const { ToolRegistry } = await import('../output/runtime/tools/support/registry.js')
  const { MuteUserTool, EditCardTool, SetTitleTool, KickOutTool } = await import('../output/runtime/tools/builtins/group-admin.js')
  const { BlockUserTool } = await import('../output/runtime/tools/builtins/social.js')
  const { blockUser, checkAccess, clearBlockedUsers, listBlockedUsers } = await import('../output/runtime/core/chat/access-control.js')
  const registry = new ToolRegistry()
  for (const builtin of [new MuteUserTool(),new EditCardTool(),new SetTitleTool(),new KickOutTool(),new BlockUserTool()]) registry.register(builtin)
  const selfConfig = structuredClone(defaults)
  selfConfig.tools.enabledTools = ['mute_user','edit_card','set_title','kick_out','block_user']
  for (const role of ['user','groupAdmin']) selfConfig.tools.boundaryAccess.roles[role].allowedTools = [...selfConfig.tools.enabledTools]
  const calls = []
  const self = {...previewToolEvent('user'),self_id:'99999',group:{async getMemberMap(){return new Map([[99999,{role:'admin'}],[10001,{role:'member',shutup_time:0}]])},async muteMember(...args){calls.push(args)},async setCard(...args){calls.push(args)},async setTitle(...args){calls.push(args);return true}}}
  const admin = {...self,user_id:'10002',sender:{role:'admin'}}
  const run = (name,args,e=self,extra={}) => registry.execute(name,args,{config:selfConfig,e,...extra})
  assert((await registry.getAllowedTools({config:selfConfig,e:self})).some(item=>item.name==='mute_user'))
  const savedSelfRoles = structuredClone(selfConfig.tools.boundaryAccess.roles)
  selfConfig.tools.boundaryAccess.roles = structuredClone(defaults.tools.boundaryAccess.roles)
  for (const name of ['mute_user','edit_card','set_title']) assert((await registry.getAllowedTools({config:selfConfig,e:self})).some(t=>t.name===name),'self tools visible without role grants')
  await userRule({...personal,resourceType:'tool',resourceId:'set_title',effect:'deny'})
  await assert.rejects(()=>run('set_title',{title:'个人禁止'}),/单独禁止/)
  await userRule({...personal,resourceType:'tool',resourceId:'set_title',effect:'default'})
  await assert.rejects(()=>run('set_title',{title:'私聊'},{user_id:'10001',message_type:'private'}),/群聊/)
  await run('set_title',{title:'本人头衔'})
  await run('edit_card',{card:'本人名片'})
  await run('mute_user',{seconds:60},{...self,msg:'禁言我一分钟'})
  await assert.rejects(()=>run('set_title',{title:'他人',qq:'10002'}),/管理他人/)
  await assert.rejects(()=>run('set_title',{title:'跨群',groupId:'20002'}),/当前群/)
  await run('set_title',{title:'管理员默认管理',qq:'10001'},admin)
  await assert.rejects(()=>run('mute_user',{seconds:0}),/解除禁言/)
  selfConfig.tools.boundaryAccess.roles.user.deniedTools.push('set_title')
  await assert.rejects(()=>run('set_title',{title:'禁止'}),/明确禁止/)
  selfConfig.tools.boundaryAccess.roles = savedSelfRoles
  selfConfig.tools.enabledTools = selfConfig.tools.enabledTools.filter(n=>n!=='set_title')
  await assert.rejects(()=>run('set_title',{title:'关闭'}),/未启用/)
  selfConfig.tools.enabledTools.push('set_title')
  await run('set_title',{title:'授权后他人',qq:'10001'},admin)
  calls.length = 0
  await run('mute_user',{seconds:60},{...self,msg:'禁言我一分钟'})
  assert.deepEqual(calls[0],[10001,60])
  await run('edit_card',{card:'new name'})
  await assert.rejects(()=>run('mute_user',{seconds:60,qq:'10002'}),/管理他人/)
  await assert.rejects(()=>run('mute_user',{seconds:0}),/解除禁言/)
  await assert.rejects(()=>run('edit_card',{card:'x',groupId:'20002'}),/当前群/)
  await assert.rejects(()=>run('mute_user',{seconds:60,qq:'10001',groupId:'20002'},admin),/当前群/)
  await assert.rejects(()=>run('kick_out',{qq:'10002'}),/管理员/)
  await assert.rejects(()=>run('mute_user',{seconds:60,qq:'all'}),/用户 ID/)
  await assert.rejects(()=>run('mute_user',{seconds:-1}),/参数无效|时长/)
  await assert.rejects(()=>run('mute_user',{seconds:0.1}),/参数无效|整数/)
  const invalidIdentity = {...self,user_id:'',sender:{role:'member'}}
  await assert.rejects(()=>run('mute_user',{seconds:60},invalidIdentity),/用户 ID/)
  selfConfig.actions = {enabled:true,items:{selfMute:{enabled:true,tool:'mute_user',minRole:'user',scope:'group'}}}
  await assert.rejects(()=>run('mute_user',{seconds:60,qq:'10002'},self,{actionId:'selfMute'}),/管理他人/)
  await run('mute_user',{seconds:60,qq:'10001'},admin)
  await run('block_user',{action:'block'},{...self,msg:'屏蔽我'})
  await run('block_user',{action:'block',userId:'10001'},admin)
  assert.equal(listBlockedUsers().length,2,'self and management restrictions coexist')
  assert.equal(checkAccess(self,selfConfig).ok,false)
  assert.equal(checkAccess({...self,group_id:'20002',group:undefined},selfConfig).ok,true,'group block never leaks into another group')
  await assert.rejects(()=>run('block_user',{action:'unblock'},self),/管理员或主人/)
  assert.equal(listBlockedUsers().length,2)
  await assert.rejects(()=>run('block_user',{action:'block',userId:'10002'}),/只能/)
  await assert.rejects(()=>run('block_user',{action:'block',scope:'global'},admin),/主人/)
  await run('block_user',{action:'unblock',userId:'10001'},admin)
  assert.equal(checkAccess(self,selfConfig).ok,true)
  clearBlockedUsers()
  const privateSelf = {msg:'屏蔽我',user_id:'10001',message_type:'private',group_id:'20001'}
  await run('block_user',{action:'block'},privateSelf)
  assert.equal(checkAccess(privateSelf,selfConfig).ok,false)
  assert.equal(checkAccess(self,selfConfig).ok,true,'private self block does not affect group usage')
  const { YuiChat } = await import('../output/runtime/apps/chat.js')
  assert.equal(typeof new YuiChat().unblockSelfCommand,'undefined')
  await assert.rejects(()=>run('block_user',{action:'unblock'},privateSelf),/管理员或主人/)
  await run('block_user',{action:'unblock',userId:'10001'},{...privateSelf,user_id:'10002',isMaster:true})
  assert.equal(checkAccess(privateSelf,selfConfig).ok,true)
  await run('block_user',{action:'block',userId:'10001',scope:'global'},{...admin,isMaster:true})
  assert.equal(checkAccess(self,selfConfig).ok,false)
  assert.equal(checkAccess(privateSelf,selfConfig).ok,false)
  clearBlockedUsers()

  const { PersonaPunishTool, PersonaPunishmentReleaseTool } = await import('../output/runtime/tools/builtins/persona-punishment.js')
  const { listPersonaPunishments, loadPersonaPunishments } = await import('../output/runtime/core/chat/persona-punishments.js')
  registry.register(new PersonaPunishTool())
  registry.register(new PersonaPunishmentReleaseTool())
  selfConfig.tools.enabledTools.push('persona_punish', 'persona_punishment_release')
  selfConfig.tools.boundaryAccess.roles.user.allowedTools.push('persona_punish')
  const punishmentArgs = {kind:'ignore',seconds:60,reason:'持续辱骂，提醒后仍继续'}
  await assert.rejects(()=>run('persona_punish',punishmentArgs),/未开启/)
  const punishmentCfg = selfConfig.tools.runtimeVariables.persona_punish
  punishmentCfg.enabled = true
  const members = new Map([[99999,{role:'admin'}],[10001,{role:'member',shutup_time:0}]])
  let muteMode = 'ok'
  const punishmentEvent = {...self,msg:'你真讨厌',group:{
    async getMemberMap(){return members},
    async muteMember(qq,seconds){
      calls.push([qq,seconds])
      if(muteMode==='fail') throw new Error('host timeout')
      members.get(qq).shutup_time = seconds ? Math.floor(Date.now()/1000)+seconds : 0
      return true
    },
  }}
  await assert.rejects(()=>run('mute_user',{seconds:60},punishmentEvent),/自助请求/)
  await assert.rejects(()=>run('block_user',{action:'block'},punishmentEvent),/自助请求/)
  await assert.rejects(()=>run('persona_punish',{...punishmentArgs,kind:'kick'},punishmentEvent),/参数无效|只允许/)
  await assert.rejects(()=>run('persona_punish',{...punishmentArgs,userId:'10002'},punishmentEvent),/参数无效|其他目标/)
  await assert.rejects(()=>run('persona_punish',{...punishmentArgs,seconds:2592001},punishmentEvent),/参数无效|最多/)
  for(const protectedEvent of [{...punishmentEvent,isMaster:true},{...punishmentEvent,sender:{role:'admin'}},{...punishmentEvent,sender:{role:'owner'}}]) {
    await assert.rejects(()=>run('persona_punish',punishmentArgs,protectedEvent),/受保护/)
  }
  members.get(10001).role = 'admin'
  await assert.rejects(()=>run('persona_punish',punishmentArgs,punishmentEvent),/普通成员/)
  members.get(10001).role = 'member'
  await assert.rejects(()=>run('persona_punish',punishmentArgs,punishmentEvent,{agent:{depth:1}}),/子代理/)
  selfConfig.actions.items.punish={enabled:true,tool:'persona_punish',minRole:'user',scope:'group'}
  await assert.rejects(()=>run('persona_punish',punishmentArgs,punishmentEvent,{actionId:'punish'}),/模型会话/)
  const race = await Promise.allSettled([run('persona_punish',punishmentArgs,punishmentEvent),run('persona_punish',punishmentArgs,punishmentEvent)])
  assert.equal(race.filter(row=>row.status==='fulfilled').length,1,'concurrent punishments reserve once')
  assert.equal(checkAccess(punishmentEvent,selfConfig).ok,false)
  assert.equal(checkAccess({...punishmentEvent,group_id:'20002',group:undefined},selfConfig).ok,true)
  assert.equal(checkAccess({...punishmentEvent,self_id:'99998'},selfConfig).ok,true)
  await loadPersonaPunishments()
  assert.equal(checkAccess(punishmentEvent,selfConfig).ok,false)
  let [punishmentRow] = await listPersonaPunishments()
  const persisted = JSON.parse(await fs.readFile(path.join(runtimeRoot,'data/yui-chat/persona-punishments.json'),'utf8'))
  assert.equal(persisted[0].id,punishmentRow.id,'punishment persisted before successful return')
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath,['--input-type=module','-e',`
    const {loadPersonaPunishments,personaIgnored}=await import(${JSON.stringify(path.join(root,'output/runtime/core/chat/persona-punishments.js'))});
    await loadPersonaPunishments();
    if(!personaIgnored({user_id:'10001',group_id:'20001',self_id:'99999',isGroup:true}))process.exit(1);
  `],{cwd:root,env:process.env})
  const realNow = Date.now
  try { Date.now = ()=>punishmentRow.until+1; assert.equal(checkAccess(punishmentEvent,selfConfig).ok,true,'expiry restores replies') }
  finally { Date.now = realNow }
  await assert.rejects(()=>run('persona_punishment_release',{id:punishmentRow.id},punishmentEvent),/管理员/)
  const masterEvent = {...punishmentEvent,isMaster:true}
  blockUser(punishmentEvent,{origin:'management',durationMs:120000})
  await run('persona_punishment_release',{id:punishmentRow.id},masterEvent)
  assert.equal(checkAccess(punishmentEvent,selfConfig).ok,false,'release preserves separate management block')
  clearBlockedUsers()
  assert.equal(checkAccess(punishmentEvent,selfConfig).ok,true)
  await run('persona_punish',punishmentArgs,punishmentEvent)
  const renewed = (await listPersonaPunishments()).find(row=>row.groupId==='20001')
  await run('persona_punishment_release',{id:renewed.id},masterEvent)
  const nextGroupEvent = {...punishmentEvent,group_id:'20002'}
  await assert.rejects(()=>run('persona_punish',{...punishmentArgs,kind:'mute'},nextGroupEvent),/未允许/)
  punishmentCfg.allowMute = true
  members.get(10001).shutup_time = Math.floor(Date.now()/1000)+100
  await assert.rejects(()=>run('persona_punish',{...punishmentArgs,kind:'mute'},nextGroupEvent),/已有禁言/)
  members.get(10001).shutup_time = 0
  await run('persona_punish',{...punishmentArgs,kind:'mute'},nextGroupEvent)
  punishmentRow = (await listPersonaPunishments()).find(row=>row.groupId==='20002')
  assert.equal(punishmentRow.status,'active')
  members.get(10001).shutup_time += 300
  await assert.rejects(()=>run('persona_punishment_release',{id:punishmentRow.id},{...nextGroupEvent,isMaster:true}),/已变化/)
  members.get(10001).shutup_time = Math.floor(punishmentRow.until/1000)
  await run('persona_punishment_release',{id:punishmentRow.id},{...nextGroupEvent,isMaster:true})
  assert.deepEqual(calls.at(-1),[10001,0])
  muteMode='fail'
  await assert.rejects(()=>run('persona_punish',{...punishmentArgs,kind:'mute'},{...nextGroupEvent,group_id:'20003'}),/host timeout/)
  assert.equal((await listPersonaPunishments()).find(row=>row.groupId==='20003').status,'uncertain')
  await assert.rejects(()=>run('persona_punish',{...punishmentArgs,kind:'mute'},{...nextGroupEvent,group_id:'20003'}),/处罚期/)
  const privatePunished = {user_id:'11001',self_id:'99999',message_type:'private',msg:'持续辱骂'}
  await assert.rejects(()=>run('persona_punish',{...punishmentArgs,kind:'mute'},privatePunished),/只能在当前群/)
  selfConfig.tools.boundaryAccess.roles.user.deniedTools.push('persona_punish')
  await assert.rejects(()=>run('persona_punish',punishmentArgs,privatePunished),/禁止/)
  selfConfig.tools.boundaryAccess.roles.user.deniedTools = []
  await run('persona_punish',punishmentArgs,privatePunished)
  const { preflight } = await import('../output/runtime/core/chat/response-pipeline.js')
  const privateBlocked = await preflight(privatePunished,'你好',selfConfig)
  assert.equal(privateBlocked.ok,false)
  assert.equal(privateBlocked.silent,true,'punishment blocks model preflight')
  const privateRow = (await listPersonaPunishments()).find(row=>row.userId==='11001')
  selfConfig.tools.boundaryAccess.roles.groupAdmin.allowedTools.push('persona_punishment_release')
  await run('persona_punish',punishmentArgs,punishmentEvent)
  await run('persona_punishment_release',{userId:'10001'},{...punishmentEvent,user_id:'10002',sender:{role:'admin'}})
  assert.equal(checkAccess(punishmentEvent,selfConfig).ok,true,'admin can release by QQ without a master-provided record ID')
  await assert.rejects(()=>run('persona_punishment_release',{id:privateRow.id},admin),/当前群/)
  const invalidPunishmentConfig = structuredClone(selfConfig)
  invalidPunishmentConfig.tools.runtimeVariables.persona_punish.maxMuteSeconds = 2592001
  assert(validateConfig(invalidPunishmentConfig).errors.some(row=>row.path.endsWith('maxMuteSeconds')))
  await assert.rejects(()=>run('mute_user',{seconds:60},{...self,msg:'禁言我的是谁？'}),/自助请求/)
  await assert.rejects(()=>run('block_user',{action:'block'},{...self,msg:'不要屏蔽我'}),/自助请求/)
  assert.equal(defaults.tools.runtimeVariables.persona_punish.maxMuteSeconds,2592000)
  muteMode='ok'
  members.get(10001).shutup_time=0
  const longMuteEvent={...punishmentEvent,group_id:'20004'}
  await assert.rejects(()=>run('persona_punish',{...punishmentArgs,kind:'mute',seconds:2592001},longMuteEvent),/参数无效|最多/)
  punishmentCfg.maxMuteSeconds=3600
  await assert.rejects(()=>run('persona_punish',{...punishmentArgs,kind:'mute',seconds:3601},longMuteEvent),/最多 3600 秒/)
  punishmentCfg.maxMuteSeconds=2592000
  await run('persona_punish',{...punishmentArgs,kind:'mute',seconds:2592000},longMuteEvent)
  assert.deepEqual(calls.at(-1),[10001,2592000])
  const longRow=(await listPersonaPunishments()).find(row=>row.groupId==='20004')
  assert.equal(longRow.until-longRow.startedAt,2592000000)
  await run('persona_punishment_release',{id:longRow.id},{...longMuteEvent,isMaster:true})
  assert.deepEqual(calls.at(-1),[10001,0])
  await run('persona_punish',{...punishmentArgs,seconds:2592000},longMuteEvent)
  const longIgnore=(await listPersonaPunishments()).find(row=>row.groupId==='20004')
  assert.equal(longIgnore.until-longIgnore.startedAt,2592000000)
  const { YuiChatMaster } = await import('../output/runtime/apps/master.js')
  const masterApp = new YuiChatMaster()
  let listReply = ''
  masterApp.e = {...masterEvent}
  masterApp.reply = async value=>{listReply=value}
  await masterApp.personaPunishmentList()
  assert.match(listReply,/10001/)
  assert.match(listReply,/20003/)
  assert.match(listReply,/待核实/)
  assert.match(listReply,/解除处罚/)
  const { toolRegistry: sharedRegistry } = await import('../output/runtime/tools/support/registry.js')
  sharedRegistry.register(new PersonaPunishmentReleaseTool())
  masterApp.e = {...privatePunished,isMaster:true,msg:`#yui解除处罚 ${privateRow.id}`}
  await masterApp.personaPunishmentRelease()
  assert.match(listReply,/已解除/)
  assert.equal(checkAccess(privatePunished,selfConfig).ok,true)
  masterApp.e = punishmentEvent
  await masterApp.personaPunishmentList()
  assert.match(listReply,/仅主人/)

  // Actual authenticated runtime-variable saves must affect the next Registry call.
  sharedRegistry.register(new PersonaPunishTool())
  await configStore.update(value => {
    value.tools.enabled = true
    value.tools.enabledTools = [...new Set([...value.tools.enabledTools,'persona_punish'])]
    value.tools.boundaryAccess.roles.user.allowedTools.push('persona_punish')
  })
  const hotUrl = `http://127.0.0.1:${server.address().port}/yui-chat/api/tools/persona_punish/runtime-config`
  async function savePunishmentVariables(value, authenticated = true) {
    return fetch(hotUrl,{method:'PUT',headers:{'content-type':'application/json',...(authenticated?{'yui-chat-token':'permissions-fixture-token'}:{})},body:JSON.stringify({value})})
  }
  assert.equal((await savePunishmentVariables({enabled:true},false)).status,401)
  assert.equal((await savePunishmentVariables({maxMuteSeconds:2592001})).status,400)
  assert.equal((await savePunishmentVariables({cooldownSeconds:60.5})).status,400)
  assert.equal((await savePunishmentVariables({maxMuteSeconds:2592000})).status,200)
  assert.equal((await savePunishmentVariables({enabled:true,allowIgnore:true,maxIgnoreSeconds:10})).status,200)
  const hotEvent = {...privatePunished,user_id:'11002'}
  await assert.rejects(()=>sharedRegistry.execute('persona_punish',{...punishmentArgs,seconds:11},{e:hotEvent}),/最多 10 秒/)
  await sharedRegistry.execute('persona_punish',{...punishmentArgs,seconds:10},{e:hotEvent})
  const hotRow = (await listPersonaPunishments()).find(row=>row.userId==='11002')
  assert.equal(hotRow.until-hotRow.startedAt,10000)
  assert.equal((await savePunishmentVariables({enabled:true,allowIgnore:true,maxIgnoreSeconds:20})).status,200)
  const preservedRow = (await listPersonaPunishments()).find(row=>row.id===hotRow.id)
  assert.equal(preservedRow.until,hotRow.until)
  await sharedRegistry.execute('persona_punish',{...punishmentArgs,seconds:20},{e:{...hotEvent,user_id:'11003'}})
  assert.equal((await savePunishmentVariables({enabled:false})).status,200)
  await assert.rejects(()=>sharedRegistry.execute('persona_punish',punishmentArgs,{e:{...hotEvent,user_id:'11004'}}),/未开启/)
  const listedPunishment = (await sharedRegistry.list()).find(row=>row.name==='persona_punish')
  assert.equal(listedPunishment.common.configSchema.properties.maxIgnoreSeconds.default,2592000)

  // Render real Vue templates and exercise shared state without executing tools.
  global.location = { hash: '', pathname: '/yui-chat', search: '' }
  global.localStorage = { getItem() { return null } }
  const { createSSRApp, h, ref } = await import('vue')
  const { renderToString } = await import('vue/server-renderer')
  const { compile } = await import('vue')
  const { store } = await import('../output/runtime/web/client/app/store/store.js')
  const { setDirtyScope, setTab, discardPendingNavigation } = await import('../output/runtime/web/client/app/store/store.js')
  global.history = {replaceState(){}}
  store.activeTab = 'tools'
  setDirtyScope('tool-permissions',true)
  setDirtyScope('permission-single',true)
  assert.equal(setTab('overview'),false)
  discardPendingNavigation()
  assert.equal(store.activeTab,'overview','discard leaves page even with child form dirty scopes')
  assert.equal(Object.keys(store.dirtyScopes).length,0)

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
  assert(overviewHtml.includes('permission-inline-select') && !overviewHtml.includes('保存此项'), 'matrix edits inline without a save drawer')
  assert(overviewHtml.includes('permission-role-column') && overviewHtml.includes('aria-pressed="false"'))
  assert(!overviewHtml.includes('type="checkbox"'), 'difference filtering uses a compact button')
  // Exercise inline selection against success/failure responses without opening a confirmation dialog.
  let inline
  const editProps = {editingBlocked:false}
  const inlineSaving = ref(false)
  const inlineView = createSSRApp({setup(){inline = PermissionOverview.setup(editProps); return ()=>null}})
  inlineView.provide('capabilityAccessMatrix',matrix)
  inlineView.provide('capabilityAccessSaving',inlineSaving)
  inlineView.provide('reloadCapabilityAccess',async()=>{})
  await renderToString(inlineView)
  const originalFetch = global.fetch
  try {
    let posted
    global.fetch = async (_url, options) => {
      posted = JSON.parse(options.body)
      return new Response(JSON.stringify({ok:true,config:{tools:{boundaryAccess:{roles:{user:{allowedTools:['one'],deniedTools:[]}}}}}}),{status:200})
    }
    const selection = {value:'allow'}
    await inline.changeItem(matrix.value.rows[0],'user',{target:selection})
    assert.deepEqual(posted,{scope:'tool',id:'one',role:'user',allowed:true})
    assert.equal(inline.savedOverride('one','user'),'allow')
    global.fetch = async()=>{throw new Error('fixture save failure')}
    selection.value = 'deny'
    await inline.changeItem(matrix.value.rows[0],'user',{target:selection})
    assert.equal(selection.value,'allow','failed immediate save restores committed choice')
    assert.equal(inlineSaving.value,false)
    editProps.editingBlocked = true
    selection.value = 'default'
    await inline.changeItem(matrix.value.rows[0],'user',{target:selection})
    assert.equal(selection.value,'allow','dirty role draft blocks inline edits')
  } finally {global.fetch = originalFetch}
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
  for (const [file, name] of [['permission-preset-panel', 'PermissionPresetPanel'], ['permission-overview', 'PermissionOverview'], ['tools-list-panel', 'ToolListPanel'], ['extension-library-panel', 'ExtensionLibraryPanel'], ['mcp-panel', 'McpPanel'], ['mcp-tools-panel', 'McpToolsPanel'], ['permission-panel', 'BoundaryAccessPanel'], ['permission-role-drawer', 'PermissionRoleDrawer'], ['permission-user-panel', 'PermissionUserPanel'], ['builtin-category-panel','BuiltinCategorySettingsPanel']]) {
    const component = (await import(`../output/runtime/web/client/features/tools/${file}.js`))[name]
    compile(component.template, { onError(error) { throw error } })
  }
  console.log('ok capability permissions: policy, Skill, validation, concurrent HTTP edits, persona punishment/recovery/persistence, Vue rendering')
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  const { mcpManager } = await import('../output/runtime/mcp/index.js')
  await mcpManager.destroy()
  await modelLogStore?.stop({ flush: true })
  await sqliteClient?.close()
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}
process.exit(0)
