import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import * as vue from 'vue'
import { buildReasoningPayload, getReasoningOptions, migrateStoredReasoning } from '../output/runtime/models/configuration/reasoning.js'
import { validateConfig } from '../output/runtime/config/validator.js'
import { defaults } from '../output/runtime/config/defaults.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const unknown = { type: 'openai-compatible', model: 'custom-model', provider: { name: 'gateway', type: 'openai-compatible' } }
assert.equal(getReasoningOptions(unknown).target, 'auto')
assert.deepEqual(getReasoningOptions(unknown).efforts, [])
assert.throws(() => buildReasoningPayload({ ...unknown, reasoning: { effort: 'medium' } }), /推理配置无效/)
const deepseek = { type: 'claude', model: 'deepseek-flash' }
assert.equal(getReasoningOptions(deepseek).target, 'deepseek')
assert.deepEqual(buildReasoningPayload({ ...deepseek, reasoning: { effort: 'none' } }), { thinking: { type: 'disabled' } })
assert.deepEqual(buildReasoningPayload({ type: 'openai-responses', model: 'gpt-5', reasoning: { effort: 'medium' } }), { reasoning: { effort: 'medium' } })
for (const [target, effort] of [['openai', 'medium'], ['deepseek', 'high'], ['claude', 'high']]) {
  const channel = { type: target === 'claude' ? 'claude' : 'openai-compatible', reasoning: { target, effort: '' } }
  assert.equal(getReasoningOptions(channel).defaultEffort, effort)
  assert.equal(buildReasoningPayload(channel), null)
}
const config = structuredClone(defaults)
config.models[0] = { ...config.models[0], adapter: 'openai-compatible', modelIdentifier: 'deepseek-flash', reasoning: { target: 'auto', effort: 'medium' } }
assert(validateConfig(config).errors.some(issue => issue.path.endsWith('reasoning.effort')))
migrateStoredReasoning(config)
assert.equal(config.models[0].reasoning.effort, 'high')
assert(!validateConfig(config).errors.some(issue => issue.path.endsWith('reasoning.effort')))
migrateStoredReasoning(config)
assert.equal(config.models[0].reasoning.effort, 'high')

const legacyUnknown = { models: [{ adapter: 'openai-compatible', modelIdentifier: 'custom-model', reasoning: { target: 'auto', effort: 'high' } }] }
migrateStoredReasoning(legacyUnknown)
assert.equal(legacyUnknown.models[0].reasoning.effort, '', 'legacy ignored effort becomes an explicit default')

// Exercise the real Store startup/save boundary with an isolated repository.
fs.mkdirSync(path.join(root, 'cache'), { recursive: true })
const runtimeRoot = fs.mkdtempSync(path.join(root, 'cache', 'reasoning-check-'))
try {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    const { ConfigStore, configFile } = await import('./output/runtime/config/store.js')
    const { defaults } = await import('./output/runtime/config/defaults.js')
    const store = new ConfigStore()
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    await fs.mkdir(path.dirname(configFile), { recursive: true })
    await fs.writeFile(configFile, JSON.stringify({ $runtimeConfig: 'sqlite' }))
    let overrides = { models: [{ ...structuredClone(defaults.models[0]), adapter: 'openai-compatible', modelIdentifier: 'deepseek-flash', reasoning: { target: 'auto', effort: 'medium' } }] }
    let writes = 0
    const repository = { load: async () => ({ exists: true, overrides }), save: async value => { overrides = structuredClone(value); writes++ } }
    await store.attachRuntimeConfigRepository(repository)
    assert.equal(store.get().models[0].reasoning.effort, 'high')
    assert.equal(overrides.models[0].reasoning.effort, 'high')
    assert.equal(writes, 1)
    const reopened = new ConfigStore()
    await reopened.attachRuntimeConfigRepository(repository)
    assert.equal(reopened.get().models[0].reasoning.effort, 'high')
    assert.equal(writes, 1, 'canonical stored config needs no second migration write')
    await assert.rejects(() => reopened.update(config => { config.models[0].reasoning.effort = 'medium'; return config }), /推理等级/)
  `], { cwd: root, env: { ...process.env, YUI_CHAT_RUNTIME_ROOT: runtimeRoot, YUI_CHAT_PLUGIN_ROOT: root }, stdio: 'pipe' })
} finally {
  fs.rmSync(runtimeRoot, { recursive: true, force: true })
}

// Execute the actual Vue setup and save flow with a local API stub; no DOM or network.
let savedPatch
let heldRequests = null
const app = {
  store: vue.reactive({ config: {}, tools: [], providers: {} }),
  toast(message) { throw new Error(message) },
  refreshTab: async () => {},
  request: async (url, options) => {
    const body = JSON.parse(options.body)
    if (url.endsWith('/reasoning-options')) {
      if (heldRequests) return new Promise(resolve => heldRequests.push({ body, resolve }))
      return getReasoningOptions({ type: body.adapter, model: body.modelIdentifier, reasoning: { target: body.target } })
    }
    savedPatch = body
    return { config: {} }
  },
}
// Successful saves emit a toast; record it without masking thrown errors from save.
app.toast = message => { if (!message.startsWith('已保存模型')) throw new Error(message) }
const modules = new Map()
function loadClient(file) {
  if (file.endsWith('/app/store/store.ts')) return app
  if (modules.has(file)) return modules.get(file)
  const exports = {}
  modules.set(file, exports)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const require = spec => spec === 'vue' ? vue : loadClient(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')))
  vm.runInNewContext(code, { exports, require, console, setTimeout, clearTimeout }, { filename: file })
  return exports
}
const { ModelEditor } = loadClient(path.join(root, 'web/client/features/providers/provider-editors.ts'))
const settle = async () => { await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }
const model = { name: 'fixture', adapter: 'openai-compatible', modelIdentifier: 'gpt-5', reasoning: { target: 'auto', effort: '' } }
for (const target of ['auto', 'openai', 'deepseek', 'claude']) {
  const scope = vue.effectScope()
  const editor = scope.run(() => ModelEditor.setup({ model: { ...model, adapter: target === 'claude' ? 'claude' : model.adapter, reasoning: { target, effort: '' } } }, { emit() {} }))
  await settle()
  assert.equal(editor.draft.reasoningEffort, '', 'explicit default survives reopening')
  await editor.save()
  assert.equal(savedPatch.reasoning.effort, '', 'explicit default survives saving unrelated fields')
  assert.equal(savedPatch.reasoning.target, target)
  scope.stop()
}
const scope = vue.effectScope()
heldRequests = []
const editor = scope.run(() => ModelEditor.setup({ model: { ...model, reasoning: undefined } }, { emit() {} }))
editor.draft.modelIdentifier = 'deepseek-flash'
await vue.nextTick()
assert.equal(heldRequests.length, 2)
heldRequests[1].resolve(getReasoningOptions({ type: 'openai-compatible', model: 'deepseek-flash' }))
await settle()
heldRequests[0].resolve(getReasoningOptions({ type: 'openai-compatible', model: 'gpt-5' }))
await settle()
assert.equal(editor.draft.reasoningEffort, 'high', 'stale response cannot overwrite new provider default')
assert(!editor.reasoningEffortOptions.value.some(option => option.value === 'medium'))
scope.stop()
console.log('ok reasoning: protocol payloads, defaults, stored migration, Vue save/reopen and response races')
