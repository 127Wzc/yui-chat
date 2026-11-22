import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yui-body-links-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
const host = path.join(runtimeRoot, "host")
process.env.YUI_CHAT_PLUGIN_ROOT = path.join(host, "plugins/yui-chat")
await fs.mkdir(path.join(host, "plugins/yui-chat"), { recursive: true })
await fs.mkdir(path.join(host, "lib/plugins"), { recursive: true })
await fs.writeFile(path.join(host, "package.json"), '{"type":"module"}')
await fs.writeFile(path.join(host, "lib/plugins/loader.js"), "export default { priority: [], deal: async () => false }")
global.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {} }
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = { image: value => ({ type: "image", file: value }) }
global.plugin = class {}

try {
  const { cleanBodyLinks } = await import("../output/runtime/filters/builtins/body-links.js")
  const marked = "https://example.com/news?utm_source=openai"
  const cases = [
    [`结论。([来源](${marked}))`, "结论。"],
    [`结论。（[example.com](${marked})）`, "结论。"],
    ["结论。([economictimes.indiatimes.com](https://economictimes.indiatimes.com/world/us/anthropic/articleshow/135989520.cms?utm_source=openai))", "结论。"],
    [`阅读[完整报告](${marked})。`, "阅读。"],
    [`访问 ${marked}`, "访问 "],
    [`<${marked}>（${marked}）`, ""],
    ["https://example.com/a(b(c(d)))?id=10&utm_source=openai。后文", "。后文"],
    ["[来源](https://example.com/a?id=10&amp;utm_source=openai \"标题\")", ""],
    ["[来源](<https://example.com/a?utm_source=openai> \"标题\")", ""],
    ["https://example.com/a?UTM_SOURCE=OpenAI", ""],
    ["https://example.com/a?utm%5Fsource=%6fpenai", ""],
  ]
  const unchanged = [
    "阅读[完整报告](https://example.com/report)。",
    "https://example.com/a_(b(c)). 后文", "www.example.com/a",
    "https://example.com/a?utm_source=google", "https://example.com/a?utm_source=openai-other",
    "https://example.com/utm_source=openai", "https://example.com/a#utm_source=openai",
    "https://example.com/a?redirect=https%3A%2F%2Fother.example%2F%3Futm_source%3Dopenai",
    "[访问 https://ordinary.example/a](https://ordinary.example/b)",
    "区间 [1,2]，取第 [3] 项。H₂O 和 x²，2026 年。",
    "结论[1][^2]citeturn1search0【3†source】", "([example.com](⁶?utm_source=openai))",
    `\`${marked}\``, `\`\`${marked}\`\``,
    `\`\`\`js\nconst link = '${marked}'\n\`\`\``, `\`\`\`text\n${marked}`,
    `\`\`\`\`md\n\`\`\`text\n${marked}\n\`\`\`\n\`\`\`\``, `~~~text\n${marked}\n~~~`,
    `    ${marked}`, `![图片](${marked})`, `![a[b]](${marked})`,
    `![图片][img]\n\n[img]: ${marked}`,
  ]
  cases.push(...unchanged.map(input => [input, input]))
  for (const [input, expected] of cases) {
    assert.equal(cleanBodyLinks(input), expected, input)
    assert.equal(cleanBodyLinks(expected), expected, "cleanup must be idempotent")
  }
  const malformedPrefix = "[".repeat(50000)
  assert.equal(cleanBodyLinks(`${malformedPrefix}${marked}`), malformedPrefix, "unclosed Markdown brackets must not prevent targeted link removal")
  const malformedMarkers = "citex【1†x".repeat(16000)
  const started = performance.now()
  assert.equal(cleanBodyLinks(malformedMarkers), malformedMarkers)
  assert(performance.now() - started < 1000, "unclosed source markers must not trigger repeated scans")

  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { createBuiltinFilters } = await import("../output/runtime/filters/builtins/index.js")
  const { filterRegistry } = await import("../output/runtime/filters/core/registry.js")
  const { applyOutputFilters, applyOutputChainFilters } = await import("../output/runtime/filters/message/message-filter-service.js")
  for (const definition of createBuiltinFilters()) filterRegistry.register(definition)
  const config = structuredClone(defaults)
  assert(validateConfig(config).ok)
  assert.equal(config.response.messageFilters.filters[0].implementation.id, "body_link_cleanup")
  const native = filterRegistry.get("body_link_cleanup")
  assert.equal(native.source, "builtin"); assert.deepEqual(native.effects, ["pure"])
  assert.deepEqual(native.stages, ["output"])
  assert.equal(native.parameters.properties.allowedHosts, undefined)
  const input = `结论。([来源](${marked}))\n阅读[报告](https://ordinary.example/a)`
  const processed = await applyOutputFilters(input, { config })
  assert.equal(processed.text, "结论。\n阅读[报告](https://ordinary.example/a)")
  assert.equal(processed.traces[0].filter, "body_link_cleanup")
  const orderedConfig = structuredClone(config)
  orderedConfig.response.messageFilters.filters.push({ id: "rewrite-first", enabled: true, stage: "output", priority: -2000,
    implementation: { type: "filter", id: "text_transform", arguments: { operation: "replace", find: "utm_source=custom", replace: "utm_source=openai" } } })
  assert.equal((await applyOutputFilters("[报告](https://example.com/a?utm_source=custom)", { config: orderedConfig })).text, "", "link cleanup must respect preceding filter priorities")
  const chain = [
    { type: "text", text: input },
    { type: "image", source: { kind: "url", value: marked } },
    { type: "forward", nodes: [{ nickname: "来源", parts: [{ type: "text", text: `链接：${marked}` }] }] },
  ]
  const original = structuredClone(chain)
  const filtered = await applyOutputChainFilters(chain, { config })
  assert.equal(filtered.chain[0].text, processed.text)
  assert.deepEqual(filtered.chain.slice(1), original.slice(1), "media resources and source forwards must remain unchanged")
  assert.deepEqual(chain, original, "filtering must not mutate shared tool arguments")
  const media = await filterRegistry.execute("body_link_cleanup", { text: "https://blocked.example/image.png" }, { stage: "output", target: "media" })
  assert.equal(media.text, "https://blocked.example/image.png", "the body filter must never remove media URLs")
  config.response.messageFilters.enabled = false
  assert.equal((await applyOutputFilters(input, { config })).text, input)
  config.response.messageFilters.enabled = true
  config.response.messageFilters.filters[0].enabled = false
  assert.equal((await applyOutputFilters(input, { config })).text, input)
  config.response.messageFilters.filters[0].enabled = true

  // Ordinary source URLs must survive even when also listed in hosted search metadata.
  const { userSettingsStore } = await import("../output/runtime/user/settings.js")
  const getSettings = userSettingsStore.get
  const { sendChatOutput } = await import("../output/runtime/core/chat/output-service.js")
  const sent = []
  const event = { user_id: "body-links-fixture", isMaster: true, reply: async payload => { sent.push(payload); return { message_id: "body-link-receipt" } } }
  const { deliverMessageChain } = await import("../output/runtime/core/message-chain/delivery.js")
  const delivered = await deliverMessageChain([chain[0], chain[2]], { e: event, config, recordImages: false })
  assert.equal(delivered.deliveredText, processed.text, "receipts must expose the actual filtered top-level text, excluding source forwards")
  assert.equal(sent[0], processed.text)
  sent.length = 0
  userSettingsStore.get = async () => ({ mode: "text" })
  try {
    const sources = [{ title: "普通来源", url: "https://ordinary.example/a" }, { title: "OpenAI 来源", url: marked }]
    await sendChatOutput(event, { channel: "fixture", text: input, hostedSearchSources: sources }, config, { armContinuation: false })
    assert.equal(sent[0], `[fixture] ${processed.text}`, "ordinary source URLs must not undergo a second fixed cleanup")
    assert(JSON.stringify(sent.slice(1)).includes(marked), "independent source forwards retain their original links")
    config.response.messageFilters.filters[0].enabled = false
    sent.length = 0
    await sendChatOutput(event, { channel: "fixture", text: input, hostedSearchSources: sources }, config, { armContinuation: false })
    assert.equal(sent[0], `[fixture] ${input}`, "disabling the rule must not leave hidden citation cleanup enabled")
  } finally { userSettingsStore.get = getSettings }
  console.log("ok OpenAI citation filter: exact query markers, ordinary content preservation, Markdown/code/images, bounded malformed input, toggles, receipts and ordinary reply delivery")
} finally {
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}
