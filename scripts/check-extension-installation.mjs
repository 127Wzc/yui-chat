import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import './check-installation-writer.mjs'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yui-chat-installation-'))
process.env.YUI_CHAT_RUNTIME_ROOT = root
process.env.YUI_CHAT_PLUGIN_ROOT = pluginRoot
process.chdir(path.resolve(pluginRoot, '../..'))
global.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
global.Bot = { express: null, wsf: {} }
global.plugin = class { constructor(options) { this.options = options } }
const load = name => import(new URL(`../output/runtime/${name}.js`, import.meta.url))
const { configStore } = await load('config/store')
const { sqliteClient } = await load('core/storage/sqlite/client')
const { SqliteRuntimeConfigRepository } = await load('core/storage/sqlite/runtime-config-repository')
const { InstallationInstaller, installationInstaller, installationSummary } = await load('extensions/installation/installer')
const { installationStore } = await load('extensions/installation/store')
const { issueWebInstallationActor, issueOwnerInstallationActor } = await load('extensions/installation/authorization')
const { credentialStore } = await load('extensions/credentials')
const { createNetworkGrant } = await load('extensions/installation/network')
const { unpackPackage, selectSkill, digest, fileManifest } = await load('extensions/installation/validation')
const { createScopedFetch } = await load('core/network/scoped-fetch')
const { fetchSafeHttp } = await load('core/network/safe-http-client')
const { fetchSource } = await load('extensions/installation/sources/index')
const { skillManager, setSkillEnabled, updateSkillPackage, deleteSkillPackage } = await load('skills/index')
const { mcpManager } = await load('mcp/index')
const { assertManagedConfigWrite } = await load('extensions/installation/configuration-guard')
const { hostRuntime } = await load('core/runtime/host-runtime')
const { YuiChatMaster } = await load('apps/master')
const { ExtensionInstallTool } = await load('tools/builtins/extension-install')
const { createWebApp } = await load('web/http/app')
const { toolRegistry } = await load('tools/support/registry')
const limits = { maxDownloadBytes: 20971520, maxExpandedBytes: 83886080, maxFiles: 1000, maxDepth: 12 }
const markdown = name => `---\nname: ${name}\ndescription: Test workflow\n---\n\nUse the workflow safely.\n`
const sha = 'a'.repeat(40), blob = 'b'.repeat(40)
let releaseBlockedSource
let mode = 'normal', endpointCalls = 0, schemaVersion = 1
const sseStreams = new Map()
const requests = []
const remote = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  requests.push({ path: url.pathname, headers: req.headers, method: req.method })
  const send = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
  if (url.pathname === '/sse' && req.method === 'GET') {
    const session = crypto.randomUUID(); sseStreams.set(session, res)
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.flushHeaders()
    res.write(`event: endpoint\ndata: /messages?sessionId=${session}\n\n`)
    req.on('close', () => sseStreams.delete(session)); return
  }
  if (url.pathname === '/messages') {
    let body = ''; for await (const chunk of req) body += chunk
    const message = JSON.parse(body)
    if ('id' in message) {
      const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'sse-fixture', version: '1' } } : { tools: [{ name: 'sse_tool', description: 'SSE fixture', inputSchema: { type: 'object', properties: {} } }] }
      sseStreams.get(url.searchParams.get('sessionId'))?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
    }
    res.statusCode = 202; res.end(); return
  }
  if (url.pathname === '/mcp') {
    endpointCalls++
    if (req.method === 'GET') { res.statusCode = 405; res.end(); return }
    let body = ''; for await (const chunk of req) body += chunk
    const message = JSON.parse(body || '{}')
    if (!('id' in message)) { res.statusCode = 202; res.end(); return }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : message.method === 'tools/list' ? { tools: [{ name: 'hello', description: `hello ${schemaVersion}`, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] } : { content: [{ type: 'text', text: 'hello' }] }
    send({ jsonrpc: '2.0', id: message.id, result }); return
  }
  if (url.pathname === '/blocked/SKILL.md') { await new Promise(resolve => { releaseBlockedSource = resolve }); res.end(markdown('blocked-source')); return }
  if (url.pathname === '/secret-source/SKILL.md') { res.end(markdown('downloaded')); return }
  if (url.pathname === '/redirect') { res.statusCode = 302; res.setHeader('Location', `http://localhost:${remote.address().port}/received`); res.end(); return }
  if (url.pathname === '/received') { res.end('received'); return }
  if (mode === 'requires-credential' && !req.headers.authorization) { res.statusCode = 404; res.end('private source'); return }
  if (mode === 'auth-failed') { res.statusCode = 401; res.end('should never expose sensitive response'); return }
  if (/\/commits\/HEAD$/.test(url.pathname)) { send(url.pathname.startsWith('/gitlab') ? { id: sha } : { sha }); return }
  if (/\/git\/trees\//.test(url.pathname) || /\/repository\/tree$/.test(url.pathname)) {
    const tree = [{ path: 'SKILL.md', type: 'blob', mode: '100644', sha: blob, id: blob }]
    if (mode === 'symlink') tree.push({ path: 'bad', type: 'blob', mode: '120000', sha: blob })
    send(url.pathname.startsWith('/gitlab') ? tree : { tree, truncated: false }); return
  }
  if (/\/blobs\//.test(url.pathname)) { if (url.pathname.startsWith('/gitlab')) res.end(markdown('private-gitlab')); else send({ encoding: 'base64', content: Buffer.from(markdown(url.pathname.startsWith('/gitee') ? 'private-gitee' : 'private-github')).toString('base64') }); return }
  res.statusCode = 404; res.end('not found')
})
let webServer, tlsServer, wrongTlsServer
function actor(key = crypto.randomUUID()) { return issueWebInstallationActor('test-admin', key) }
async function waitTask(id, statuses = ['succeeded', 'failed', 'awaiting_input', 'awaiting_confirmation', 'canceled', 'needs_attention', 'expired']) {
  for (let i = 0; i < 200; i++) { const task = await installationStore.get(id); if (statuses.includes(task.status)) return task; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error(`task ${id} did not settle`)
}
function tar(entries) {
  const chunks = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    const bytes = Buffer.from(entry.content || '')
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write(entry.type || '0', 156); header.write(entry.link || '', 157, 100)
    header.write('ustar\0', 257); const sum = header.reduce((total, byte) => total + byte, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)])
}
try {
  assert.equal((await sqliteClient.init(await configStore.load())).available, true)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  const leaseFile = path.join(root, 'data/yui-chat/installation-writer.json')
  const originalActive = installationStore.active
  try {
    installationStore.active = async () => { throw new Error('injected startup recovery failure') }
    await assert.rejects(installationInstaller.init(), /injected startup recovery failure/)
    await assert.rejects(fs.access(leaseFile), { code: 'ENOENT' })
  } finally { installationStore.active = originalActive }
  const initializing = installationInstaller.init()
  assert.equal(installationInstaller.init(), initializing, 'concurrent init shares startup')
  await initializing
  const lease = await fs.readFile(leaseFile, 'utf8')
  const duplicateInstaller = new InstallationInstaller()
  await assert.rejects(duplicateInstaller.init(), { code: 'INSTALLATION_WRITER_ALREADY_ACTIVE' })
  await duplicateInstaller.stop()
  assert.equal(await fs.readFile(leaseFile, 'utf8'), lease, 'failed contender cannot release the active installer')
  await installationInstaller.stop()
  // Stop during initialization must wait for recovery and release its owned lease.
  await Promise.all([installationInstaller.init(), installationInstaller.stop()])
  await assert.rejects(fs.access(leaseFile), { code: 'ENOENT' })
  await installationInstaller.init(); installationInstaller.start()
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${remote.address().port}`
  await configStore.update(config => { config.web.authToken = 'installation-test-token'; config.installation.providers = [] })
  // Source origin is exact, provider registry supports a separate API base. Run each provider with the same source origin in turn.
  console.log('installation checks: publication and plans')
  const workflow = Buffer.from(markdown('uploaded'))
  const submitter = actor('upload-request-id')
  const input = { kind: 'skill', provider: 'upload', source: 'SKILL.md', upload: workflow.toString('base64') }
  const submitted = await installationInstaller.submit(input, submitter)
  assert.equal((await installationInstaller.submit(input, submitter)).id, submitted.id, 'request-level idempotency')
  const finished = await waitTask(submitted.id)
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.result.activation, 'disabled')
  assert.equal(configStore.get().tools.enabledTools.includes('extension_install'), false)
  assert.equal(finished.result.runtimeCheck, 'not_run')
  assert.equal((await skillManager.listSkills()).find(item => item.id === 'uploaded').enabled, false)
  assert.equal(await skillManager.buildPrompt('$uploaded', { e: { isMaster: true } }), '')
  const events = await installationStore.events(submitted.id)
  assert.ok(events.some(event => event.type === 'commit_intent'))
  assert.ok(events.some(event => event.type === 'target_protected'))
  assert.ok(events.some(event => event.type === 'files_published'))
  assert.equal((await installationStore.receipt('skill', 'uploaded')).installationId, submitted.id)
  const conflict = await installationInstaller.submit(input, actor())
  assert.equal((await waitTask(conflict.id)).reasonCode, 'TARGET_EXISTS')
  const inspected = await installationInstaller.submit({ ...input, upload: Buffer.from(markdown('inspected')).toString('base64') }, actor(), 'inspect')
  let prepared = await waitTask(inspected.id)
  assert.equal(prepared.status, 'awaiting_confirmation')
  assert.equal((await skillManager.listSkills()).some(item => item.id === 'inspected'), false)
  await assert.rejects(installationInstaller.apply(prepared.plan.id, { entry: 'web', id: 'forged', requestId: 'forged' }), /TRUSTED_ENTRY/)
  await installationInstaller.apply(prepared.plan.id, actor())
  assert.equal((await waitTask(inspected.id)).status, 'succeeded')
  await assert.rejects(installationInstaller.apply(prepared.plan.id, actor()), /PLAN/)
  const corrupt = await installationInstaller.submit({ ...input, upload: Buffer.from(markdown('corrupt')).toString('base64') }, actor(), 'inspect')
  prepared = await waitTask(corrupt.id)
  await fs.writeFile(path.join(root, 'data', 'yui-chat', 'extensions', '.install-work', corrupt.id, 'SKILL.md'), markdown('tampered')).catch(async () => {
    // Runtime root layout is derived by config/store rather than assuming the Yunzai default.
    const { userExtensionsDir } = await load('extensions/storage'); await fs.writeFile(path.join(userExtensionsDir, '.install-work', corrupt.id, 'SKILL.md'), markdown('tampered'))
  })
  await installationInstaller.apply(prepared.plan.id, actor())
  assert.equal((await waitTask(corrupt.id)).reasonCode, 'ARTIFACT_CHANGED')
  const originalReceiptWrite = installationStore.saveReceipt.bind(installationStore)
  installationStore.saveReceipt = async task => { if (task.plan.targetId === 'recoverable') throw new Error('injected audit write failure'); return originalReceiptWrite(task) }
  const recovery = await installationInstaller.submit({ ...input, upload: Buffer.from(markdown('recoverable')).toString('base64') }, actor())
  const attention = await waitTask(recovery.id)
  assert.equal(attention.status, 'needs_attention')
  assert.equal(attention.phase, 'configured')
  await assert.rejects(setSkillEnabled('recoverable', true), /恢复/)
  installationStore.saveReceipt = originalReceiptWrite
  await installationInstaller.stop(); await installationInstaller.init(); installationInstaller.start()
  assert.equal((await waitTask(recovery.id, ['succeeded', 'needs_attention'])).status, 'succeeded', 'published files recover without a second installation')
  assert.equal((await installationStore.receipt('skill', 'recoverable')).installationId, recovery.id)
  const rowsBeforeCas = await installationStore.events(submitted.id)
  await assert.rejects(installationStore.change({ ...finished, version: finished.version - 1 }, {}, { type: 'stale_write' }), /刷新/)
  assert.deepEqual(await installationStore.events(submitted.id), rowsBeforeCas, 'failed CAS cannot append an event')
  for (const checkpoint of ['commit_intent', 'target_protected', 'files_published']) {
    const change = installationStore.change.bind(installationStore); let injected = false
    installationStore.change = async (task, patch, event) => { const next = await change(task, patch, event); if (event.type === checkpoint && !injected) { injected = true; throw new Error('simulated abrupt checkpoint failure') }; return next }
    const fault = await installationInstaller.submit({ ...input, upload: Buffer.from(markdown(`fault-${checkpoint.replaceAll('_', '-')}`)).toString('base64') }, actor())
    const stopped = await waitTask(fault.id, ['needs_attention']); assert.ok(stopped.phase)
    installationStore.change = change
    await installationInstaller.recover(fault.id, actor())
    assert.equal((await waitTask(fault.id, ['succeeded', 'needs_attention'])).status, 'succeeded', `${checkpoint} resumes a verified disabled commit`)
  }
  const cancel = await installationInstaller.submit({ ...input, upload: Buffer.from(markdown('cancelled')).toString('base64') }, actor(), 'inspect')
  await waitTask(cancel.id); await installationInstaller.cancel(cancel.id, actor())
  assert.equal((await waitTask(cancel.id, ['canceled'])).status, 'canceled')
  await assert.rejects(issueOwnerInstallationActor({ isMaster: true, user_id: 1, self_id: 2, message_id: 3 }, 'owner_command'), /TRUSTED_OWNER/)
  await assert.rejects(new ExtensionInstallTool().execute({ action: 'install', source: 'https://example.com/x' }, { e: { isMaster: true }, agent: {} }), /TRUSTED_OWNER/)
  const master = new YuiChatMaster(); let reply = ''; master.e = { msg: '#yui扩展安装 https://example.com/x', isMaster: true, user_id: 1 }; master.reply = value => { reply = String(value) }
  await master.extensionInstallationCommand(); assert.match(reply, /TRUSTED_OWNER/)
  for (const entry of [{ name: '../escape' }, { name: '/absolute' }, { name: 'link', type: '2', link: '/tmp' }, { name: 'device', type: '3' }, { name: '.env', content: 'SECRET=x' }]) assert.throws(() => unpackPackage(tar([entry]), 'test.tar'), /UNSAFE|SENSITIVE|UNSUPPORTED/)
  assert.throws(() => unpackPackage(tar([{ name: 'A' }, { name: 'a' }]), 'test.tar'), /DUPLICATE/)
  assert.throws(() => unpackPackage(tar([{ name: 'large', content: 'x'.repeat(100) }]), 'test.tar', { ...limits, maxExpandedBytes: 20 }), /LIMIT/)
  assert.equal(selectSkill(unpackPackage(tar([{ name: 'one/SKILL.md', content: markdown('one') }, { name: 'two/SKILL.md', content: markdown('two') }]), 'test.tar')).candidates.length, 2)
  const blockedUrl = `${origin}/blocked/SKILL.md`
  const blockedGrant = await createNetworkGrant({ url: blockedUrl, purpose: 'repository-fetch', targetId: blockedUrl, addresses: ['127.0.0.1'] })
  await configStore.update(config => { config.installation.sourceGrants[blockedUrl] = blockedGrant.id })
  const blocked = await installationInstaller.submit({ source: blockedUrl, kind: 'skill' }, actor())
  for (let i = 0; i < 100 && !releaseBlockedSource; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(releaseBlockedSource, 'first worker is occupied downloading')
  const queued = await installationInstaller.submit({ ...input, upload: Buffer.from(markdown('queued-cancel')).toString('base64') }, actor())
  assert.equal((await installationInstaller.cancel(queued.id, actor())).status, 'canceled', 'queued cancellation is immediate while another worker is blocked')
  await installationInstaller.cancel(blocked.id, actor()); releaseBlockedSource()
  assert.equal((await waitTask(blocked.id, ['canceled'])).status, 'canceled')
  console.log('installation checks: providers and credentials')
  const token = 'private-token-not-in-audit'
  for (const provider of ['github', 'gitlab', 'gitee']) {
    const sourceUrl = `${origin}/owner/repo`
    await configStore.update(config => { config.installation.providers = [{ provider, origin, apiBase: `${origin}/${provider}` }] })
    const credentialId = await credentialStore.put({ purpose: 'repository-read', origin, scope: sourceUrl, value: token })
    const repoBase = provider === 'gitlab' ? `/gitlab/projects/owner%2Frepo/repository` : `/${provider}/repos/owner/repo`
    const paths = [`${repoBase}/commits/HEAD`, provider === 'gitlab' ? `${repoBase}/tree` : `${repoBase}/git/trees/${sha}`, provider === 'gitlab' ? `${repoBase}/blobs/${blob}/raw` : `${repoBase}/git/blobs/${blob}`]
    const grant = await createNetworkGrant({ url: `${origin}${paths[0]}`, purpose: 'repository-fetch', targetId: sourceUrl, paths, addresses: ['127.0.0.1'], allowHttpCredentials: true })
    await configStore.update(config => { config.installation.sourceGrants[sourceUrl] = grant.id })
    const source = await fetchSource({ source: sourceUrl, kind: 'skill', provider, credentialId }, limits, new AbortController().signal)
    assert.equal(source.resolvedCommit, sha)
    assert.equal(selectSkill(source.files).targetId, `private-${provider}`)
    const auth = requests.at(-1).headers
    assert.equal(provider === 'gitlab' ? auth['private-token'] : auth.authorization, provider === 'gitlab' ? token : `Bearer ${token}`)
    mode = 'symlink'; await assert.rejects(fetchSource({ source: sourceUrl, kind: 'skill', provider, credentialId }, limits, new AbortController().signal), /UNSUPPORTED_ARCHIVE_ENTRY/); mode = 'normal'
    mode = 'auth-failed'; await assert.rejects(fetchSource({ source: sourceUrl, kind: 'skill', provider, credentialId }, limits, new AbortController().signal), /SOURCE_AUTH_FAILED/); mode = 'normal'
    const stored = await sqliteClient.get('SELECT payload FROM extension_credentials WHERE id=?', [credentialId]); assert.ok(!stored.payload.includes(token))
    assert.ok(!JSON.stringify(await credentialStore.list()).includes(token))
    await credentialStore.revoke(credentialId); await assert.rejects(credentialStore.resolve(credentialId, 'repository-read', origin, sourceUrl), /REVOKED/)
  }
  console.log('installation checks: real ingress, independent owner entry and Web takeover')
  const host = path.join(root, 'test-host'); await fs.mkdir(path.join(host, 'lib/config'), { recursive: true })
  await fs.writeFile(path.join(host, 'package.json'), JSON.stringify({ type: 'module' }))
  await fs.writeFile(path.join(host, 'lib/config/config.js'), 'export default { master: { "2": ["1"] } }')
  const notifications = []; global.Bot = new EventEmitter(); global.Bot['2'] = { pickUser: () => ({ sendMsg: async text => { notifications.push(text); return {} } }) }; hostRuntime.registerInboundMessages(host)
  const message = text => { const e = { user_id: 1, self_id: 2, message_id: crypto.randomUUID(), msg: text, message: [{ type: 'text', text }] }; global.Bot.emit('message', e); return e }
  await configStore.update(config => { config.tools.enabled = false; config.tools.enabledTools = [] })
  const ownerEvent = message(`#yui扩展安装 ${origin}/mcp type=mcp id=owner-entry`)
  const command = new YuiChatMaster(); command.e = ownerEvent; let accepted = ''; command.reply = value => { accepted = String(value) }
  await command.extensionInstallationCommand(); assert.match(accepted, /已受理/)
  const ownerId = accepted.match(/ins_[a-f0-9-]+/)[0]
  assert.equal((await waitTask(ownerId)).status, 'succeeded', 'owner command needs no model or model tool')
  for (let i = 0; i < 100 && (await installationStore.get(ownerId)).notification !== 'sent'; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(notifications.filter(text => text.includes(ownerId)).length, 1, 'terminal notification has a durable intent and local deduplication')
  assert.equal((await installationStore.get(ownerId)).notification, 'sent')
  await assert.rejects(issueOwnerInstallationActor(ownerEvent, 'model', { observability: { source: 'chat' } }), /MODEL_INSTALL_DISABLED/)
  const synthetic = { ...ownerEvent }; await assert.rejects(issueOwnerInstallationActor(synthetic, 'owner_command'), /TRUSTED_OWNER/)
  const changed = message('主人原始文字没有安装指令'); command.e = changed; changed.msg = ownerEvent.msg; await command.extensionInstallationCommand(); assert.match(accepted, /原始消息/)
  await configStore.update(config => { config.tools.enabled = true; config.tools.enabledTools = ['extension_install'] })
  const modelEvent = message(`检查 ${origin}/mcp`)
  const modelContext = { e: modelEvent, observability: { source: 'chat' } }
  const modelInspected = JSON.parse(await new ExtensionInstallTool().execute({ action: 'inspect', kind: 'mcp', source: `${origin}/mcp`, mcp: { id: 'model-entry', url: `${origin}/mcp`, transport: 'streamableHttp' } }, modelContext))
  const waiting = await waitTask(modelInspected.installId); assert.equal(waiting.status, 'awaiting_confirmation')
  await assert.rejects(new ExtensionInstallTool().execute({ action: 'install', source: `${origin}/elsewhere` }, modelContext), /EXPLICIT_SOURCE_INTENT/)
  await assert.rejects(issueOwnerInstallationActor(modelEvent, 'model', { ...modelContext, agent: {} }), /TRUSTED_OWNER/)
  await configStore.update(config => { config.tools.enabled = false })
  const confirmation = message(`确认 ${waiting.plan.id}`)
  await assert.rejects(new ExtensionInstallTool().execute({ action: 'apply', planId: waiting.plan.id }, { e: confirmation, observability: { source: 'chat' } }), /MODEL_INSTALL_DISABLED/)
  await installationInstaller.apply(waiting.plan.id, actor())
  const taken = await waitTask(waiting.id, ['succeeded']); assert.equal(taken.origin.entry, 'model'); assert.equal(taken.actor.entry, 'web')
  const ownerQuery = await issueOwnerInstallationActor(message(`#yui扩展进度 ${waiting.id}`), 'owner_command')
  assert.equal((await installationInstaller.get(waiting.id, ownerQuery)).id, waiting.id, 'original owner can still query after Web takeover')
  await configStore.update(config => { config.installation.providers = [{ provider: 'github', origin, apiBase: `${origin}/github` }] })
  const privateUrl = `${origin}/owner/repo`
  const resumeBase = '/github/repos/owner/repo'
  const resumeGrant = await createNetworkGrant({ url: `${origin}${resumeBase}/commits/HEAD`, purpose: 'repository-fetch', targetId: privateUrl, paths: [`${resumeBase}/commits/HEAD`, `${resumeBase}/git/trees/${sha}`, `${resumeBase}/git/blobs/${blob}`], addresses: ['127.0.0.1'], allowHttpCredentials: true })
  await configStore.update(config => { config.installation.sourceGrants[privateUrl] = resumeGrant.id })
  mode = 'requires-credential'
  const pending = await installationInstaller.submit({ source: privateUrl, kind: 'skill' }, actor())
  const missing = await waitTask(pending.id); assert.equal(missing.status, 'awaiting_input'); assert.equal(missing.reasonCode, 'SOURCE_NOT_FOUND_OR_NOT_AUTHORIZED')
  const privateCredential = await credentialStore.put({ purpose: 'repository-read', origin, scope: privateUrl, value: token })
  await installationInstaller.inputs(pending.id, { expectedVersion: missing.version, credentialId: privateCredential }, actor())
  assert.equal((await waitTask(pending.id, ['succeeded', 'failed'])).status, 'succeeded', 'credential binding resumes the same private installation')
  mode = 'normal'
  const originalReceipt = await installationStore.receipt('skill', 'private-github')
  await deleteSkillPackage('private-github'); assert.equal(await installationStore.receipt('skill', 'private-github'), undefined)
  const replacement = await installationInstaller.submit({ ...input, upload: Buffer.from(markdown('private-github')).toString('base64') }, actor())
  assert.equal((await waitTask(replacement.id)).status, 'succeeded', 'explicit uninstall permits a new installation while preserving old receipt')
  assert.ok((await sqliteClient.get('SELECT retired_at FROM extension_installation_receipts WHERE installation_id=?', [originalReceipt.installationId])).retired_at)
  console.log('installation checks: scoped network and MCP SDK')
  await assert.rejects(createScopedFetch({})(`${origin}/mcp`), /NETWORK_GRANT_REQUIRED/)
  const mcpGrant = await createNetworkGrant({ url: `${origin}/mcp`, purpose: 'mcp-connect', targetId: 'test-mcp', addresses: ['127.0.0.1'] })
  const transport = createScopedFetch({ grant: async () => mcpGrant })
  await assert.rejects(transport(`${origin}/elsewhere`), /SCOPE_MISMATCH/)
  await assert.rejects(createScopedFetch({ grant: async () => ({ ...mcpGrant, addresses: ['127.0.0.2'] }) })(`${origin}/mcp`), /NETWORK_GRANT_REQUIRED|ADDRESS_CHANGED/)
  await assert.rejects(createScopedFetch({ grant: async () => mcpGrant, headers: async () => ({ Authorization: token }) })(`${origin}/mcp`), /HTTP_CREDENTIAL_GRANT_REQUIRED/)
  await fetchSafeHttp(`${origin}/redirect`, { allowPrivateHosts: true, headers: { 'X-Source-Key': token, Authorization: token } })
  assert.equal(requests.at(-1).headers['x-source-key'], undefined); assert.equal(requests.at(-1).headers.authorization, undefined)
  const mcp = await installationInstaller.submit({ source: `${origin}/mcp`, kind: 'mcp', mcp: { id: 'test-mcp', url: `${origin}/mcp`, transport: 'streamableHttp' } }, actor())
  const callsBefore = endpointCalls
  assert.equal((await waitTask(mcp.id)).status, 'succeeded'); assert.equal(endpointCalls, callsBefore, 'MCP import must not connect')
  assert.deepEqual(configStore.get().mcp.servers['test-mcp'].allowedTools, [])
  await configStore.update(config => { config.mcp.servers['test-mcp'].networkGrantId = mcpGrant.id })
  const probe = await mcpManager.testServer('test-mcp', configStore.get().mcp.servers['test-mcp'])
  assert.equal(probe.catalog[0].originalName, 'hello'); assert.deepEqual(probe.exposed, [])
  assert.equal(configStore.get().mcp.servers['test-mcp'].enabled, false)
  await configStore.update(config => { config.mcp.enabled = true; Object.assign(config.mcp.servers['test-mcp'], { enabled: true, allowedTools: ['hello'], reviewedToolSchemas: { hello: probe.catalog[0].schemaDigest } }) })
  await mcpManager.init(); assert.equal(mcpManager.getTools().some(tool => tool.originalName === 'hello'), true)
  schemaVersion++; await mcpManager.init(); assert.equal(mcpManager.getTools().some(tool => tool.originalName === 'hello'), false, 'schema change revokes old name authorization')
  await assert.rejects(mcpManager.testServer('test-mcp', { ...configStore.get().mcp.servers['test-mcp'], url: `${origin}/elsewhere` }), /ENDPOINT_CHANGED/)
  const forge = { ...configStore.get().mcp.servers['test-mcp'], headers: { Authorization: '${env:UNAUTHORIZED_SECRET}' } }
  process.env.UNAUTHORIZED_SECRET = token
  await assert.rejects(mcpManager.testServer('test-mcp', forge), /MANAGED_MCP_BINDING_REQUIRED/)
  const sseGrant = await createNetworkGrant({ url: `${origin}/sse`, purpose: 'mcp-connect', targetId: 'test-sse', paths: ['/messages'], addresses: ['127.0.0.1'] })
  const sse = await installationInstaller.submit({ source: `${origin}/sse`, kind: 'mcp', mcp: { id: 'test-sse', url: `${origin}/sse`, transport: 'sse' } }, actor())
  assert.equal((await waitTask(sse.id)).status, 'succeeded')
  await configStore.update(config => { config.mcp.servers['test-sse'].networkGrantId = sseGrant.id })
  const sseProbe = await mcpManager.testServer('test-sse', configStore.get().mcp.servers['test-sse'])
  assert.equal(sseProbe.catalog[0].originalName, 'sse_tool', 'real SSE SDK GET and endpoint POST use controlled transport')
  console.log('installation checks: service CA and hostname verification')
  const keyFile = path.join(root, 'tls.key'), certFile = path.join(root, 'tls.crt')
  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1'], { encoding: 'utf8' })
  assert.equal(certificate.status, 0, 'openssl is required to exercise certificate validation')
  const tlsOptions = { key: await fs.readFile(keyFile), cert: await fs.readFile(certFile) }
  tlsServer = https.createServer(tlsOptions, (_req, res) => res.end('tls-ok')); await new Promise(resolve => tlsServer.listen(0, '127.0.0.1', resolve))
  const tlsUrl = `https://127.0.0.1:${tlsServer.address().port}/mcp`
  const tlsGrant = await createNetworkGrant({ url: tlsUrl, targetId: 'tls-service', purpose: 'mcp-connect', addresses: ['127.0.0.1'], ca: tlsOptions.cert.toString('utf8') })
  assert.equal(await (await createScopedFetch({ grant: async () => tlsGrant })(tlsUrl)).text(), 'tls-ok')
  await assert.rejects(createScopedFetch({ grant: async () => ({ ...tlsGrant, ca: undefined }) })(tlsUrl), /NETWORK_CONNECT_FAILED/)
  const wrongCert = path.join(root, 'wrong.crt')
  assert.equal(spawnSync('openssl', ['req', '-x509', '-new', '-key', keyFile, '-out', wrongCert, '-subj', '/CN=wrong.example', '-addext', 'subjectAltName=DNS:wrong.example', '-days', '1']).status, 0)
  wrongTlsServer = https.createServer({ key: tlsOptions.key, cert: await fs.readFile(wrongCert) }, (_req, res) => res.end('wrong-host')); await new Promise(resolve => wrongTlsServer.listen(0, '127.0.0.1', resolve))
  const wrongUrl = `https://127.0.0.1:${wrongTlsServer.address().port}/mcp`
  const wrongGrant = await createNetworkGrant({ url: wrongUrl, targetId: 'wrong-service', purpose: 'mcp-connect', addresses: ['127.0.0.1'], ca: (await fs.readFile(wrongCert)).toString('utf8') })
  await assert.rejects(createScopedFetch({ grant: async () => wrongGrant })(wrongUrl), /NETWORK_CONNECT_FAILED/, 'trusted CA cannot bypass hostname verification')
  console.log('installation checks: authenticated Web API')
  const express = (await import('express')).default; const api = express(); api.use(createWebApp()); webServer = http.createServer(api); await new Promise(resolve => webServer.listen(0, '127.0.0.1', resolve))
  const apiOrigin = `http://127.0.0.1:${webServer.address().port}`
  let response = await fetch(`${apiOrigin}/api/extensions/installations`); assert.equal(response.status, 401)
  response = await fetch(`${apiOrigin}/api/extensions/installations/${mcp.id}/events`); assert.equal(response.status, 401)
  response = await fetch(`${apiOrigin}/api/extensions/installations`, { headers: { 'yui-chat-token': 'installation-test-token' } }); assert.equal(response.status, 200); assert.ok((await response.json()).tasks.some(task => task.id === mcp.id))
  response = await fetch(`${apiOrigin}/api/extensions/installations/${submitted.id}/inputs`, { method: 'POST', headers: { 'yui-chat-token': 'installation-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: finished.version, actor: { isMaster: true } }) }); assert.equal(response.status, 400)
  const before = await configStore.load(), bypass = structuredClone(before); bypass.skills.disabled = bypass.skills.disabled.filter(id => id !== 'private-github')
  await assert.rejects(assertManagedConfigWrite(before, bypass), /独立入口/)
  const largeBody = { source: 'large-SKILL.md', kind: 'skill', provider: 'upload', upload: Buffer.from(markdown('large-upload') + 'x'.repeat(1100000)).toString('base64') }
  response = await fetch(`${apiOrigin}/api/extensions/installations/inspect`, { method: 'POST', headers: { 'yui-chat-token': 'installation-test-token', 'Content-Type': 'application/json', 'Idempotency-Key': 'large-upload-test' }, body: JSON.stringify(largeBody) }); assert.equal(response.status, 202, 'authenticated bounded upload exceeds the normal 1 MiB JSON ceiling')
  const uploaded = await response.json(); assert.equal((await waitTask(uploaded.task.id)).status, 'awaiting_confirmation'); await installationInstaller.cancel(uploaded.task.id, actor())
  assert.ok(!JSON.stringify(await installationStore.events(submitted.id)).includes(token))
  const receiptBefore = await installationStore.receipt('skill', 'uploaded')
  await setSkillEnabled('uploaded', true)
  assert.equal((await installationStore.receipt('skill', 'uploaded')).activationAtInstall, receiptBefore.activationAtInstall)
  await installationInstaller.stop(); await installationInstaller.init(); installationInstaller.start()
  assert.equal((await installationStore.get(submitted.id)).status, 'succeeded', 'persistent task survives restart')
  assert.equal((await sqliteClient.get('SELECT COUNT(*) AS total FROM ai_runs')).total, 0, 'installation and discovery do not fabricate model runs')
  global.location = { hash: '', pathname: '/yui-chat', search: '' }; global.localStorage = { getItem() { return null } }
  const { createSSRApp, h } = await import('vue'); const { renderToString } = await import('vue/server-renderer')
  const { InstallationPanel } = await load('web/client/features/tools/installation-panel')
  const view = { ...InstallationPanel, setup() { const panel = InstallationPanel.setup(); panel.selected.value = { id: 'fixture', version: 1, kind: 'skill', status: 'awaiting_input', currentStep: 'waiting', sourceIdentity: '<img src="https://tracker.invalid/pixel" onerror="alert(1)">', origin: { entry: 'model', id: 'owner' }, candidates: ['one', 'two'] }; return panel } }
  const html = await renderToString(createSSRApp({ render: () => h(view) }))
  assert.ok(html.includes('补齐并继续原任务')); assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img src="https://tracker.invalid'))
  console.log('installation checks: Vue task rendering and escaped private source identity')
  console.log('ok extension installation: persistent three-entry boundaries, idempotency, immutable plans, disabled publication, safe files, encrypted scoped credentials, three provider fixtures, private network pinning and real MCP HTTP SDK')
} finally {
  await installationInstaller.stop().catch(() => {})
  await mcpManager.destroy().catch(() => {})
  await toolRegistry.destroy().catch(() => {})
  await sqliteClient.close().catch(() => {})
  remote.closeAllConnections()
  await new Promise(resolve => remote.close(resolve))
  for (const server of [tlsServer, wrongTlsServer]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  if (webServer) { webServer.closeAllConnections(); await new Promise(resolve => webServer.close(resolve)) }
  await fs.rm(root, { recursive: true, force: true })
}

process.exit(0)
