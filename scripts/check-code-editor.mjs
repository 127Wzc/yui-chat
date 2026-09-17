import assert from "node:assert/strict"
import fs from "node:fs/promises"
import vm from "node:vm"
import { applyCustomBuilder, customBuilderFromManifest } from "../output/runtime/web/client/features/tools/custom-builder.js"

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
builder.backgroundSilent = "false"
const updated = applyCustomBuilder(manifest, builder)
assert.equal(updated.tools[0].execution.backgroundSilent, false)
assert.equal(updated.tools[0].execution.timeoutMs, 8000)
assert.equal(updated.tools[0].execution.effect, "read")
console.log("ok editor: JavaScript formatting preserves literals, formatting is idempotent, background switch round trip")
