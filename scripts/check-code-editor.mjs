import assert from "node:assert/strict"
import fs from "node:fs/promises"
import vm from "node:vm"
import { applyCustomBuilder, customBuilderFromManifest, customBuilderHasActionPolicy, customBuilderIsBackground } from "../output/runtime/web/client/features/tools/custom-builder.js"

const sandbox = { window: {} }
vm.runInNewContext(await fs.readFile(new URL("../web/client/vendor/code-editor/beautify.min.js", import.meta.url), "utf8"), sandbox)
const format = sandbox.window.js_beautify
const source = 'export const tool={value:"}",regex:/[{}]/,text:`[]`,/* } */\nexecute(){return [1,2];}};'
const formatted = format(source, { indent_size: 2 })
assert(formatted.includes("/* } */"))
assert(formatted.includes('regex: /[{}]/'))
assert(formatted.includes("\n"))
assert.equal(format(formatted, { indent_size: 2 }), formatted)
const manifest = { tools: [{ name: "sticker_pick", execution: { effect: "read", timeoutMs: 8000, backgroundSilent: true } }] }
const builder = customBuilderFromManifest(manifest)
assert.equal(builder.backgroundSilent, "true")
assert.equal(customBuilderIsBackground(builder), true)
assert.equal(customBuilderHasActionPolicy(builder), false)
builder.backgroundSilent = "false"
const updated = applyCustomBuilder(manifest, builder)
assert.equal(updated.tools[0].execution.backgroundSilent, undefined)
assert.equal(updated.tools[0].execution.timeoutMs, 8000)
assert.equal(updated.tools[0].execution.effect, "read")
assert.equal(updated.tools[0].requiresFinalReply, undefined)
const actionBuilder = { ...builder, parameters: [{ name: "action" }], executionByAction: "{}" }
assert.equal(customBuilderHasActionPolicy(actionBuilder), true)
assert.equal(customBuilderIsBackground({ ...builder, backgroundSilent: "false", execution: '{ "background": true }' }), true)
const silent = applyCustomBuilder(manifest, { ...builder, backgroundSilent: "true", requiresFinalReply: "false" })
assert.equal(silent.tools[0].requiresFinalReply, undefined)
assert.equal(silent.tools[0].execution.backgroundSilent, true)
console.log("ok editor: JavaScript formatting preserves literals, formatting is idempotent, background switch round trip")
