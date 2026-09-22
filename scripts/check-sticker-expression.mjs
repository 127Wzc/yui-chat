import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
await fs.mkdir(path.join(root, "cache"), { recursive: true })
const runtimeRoot = await fs.mkdtemp(path.join(root, "cache", "sticker-expression-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.env.YUI_CHAT_PLUGIN_ROOT = root
process.chdir(path.resolve(root, "../.."))
global.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {} }
global.Bot = { express: null, wsf: {}, uin: [] }
global.plugin = class {}

try {
  const { selectStickerExpression, extractStickerCandidates, recordStickerExpressionSent, resetStickerExpressionState } = await import("../output/runtime/tools/builtins/sticker-expression.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { McpToolAdapter } = await import("../output/runtime/mcp/index.js")
  const originalGet = toolRegistry.get
  const originalExecute = toolRegistry.execute
  const calls = []
  toolRegistry.get = name => name === "mcp_gallery_search_images" ? { name, common: { source: "mcp", execution: { effect: "read" } } } : null
  toolRegistry.execute = async (name, args) => {
    calls.push({ name, args })
    const images = calls.length > 1
      ? [{ id: "context-match", url: "https://example.test/pat.gif", description: "温柔安慰，摸摸头，治愈疲惫的朋友", tags: ["安慰", "摸摸头", "治愈"], score: 0.5 }]
      : [
          { id: "remote-high", url: "https://example.test/idle.gif", description: "上班摸鱼", tags: ["摸鱼"], score: 0.95 },
          { id: "context-match", url: "https://example.test/pat.gif", description: "温柔安慰，摸摸头，治愈疲惫的朋友", tags: ["安慰", "摸摸头", "治愈"], score: 0.5 },
        ]
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          match: "semantic",
          sort: "relevance",
          images,
        }),
      }],
    }
  }

  const config = {
    tools: { enabled: true, runtimeVariables: {} },
    mcp: { enabled: true, servers: { gallery: { enabled: true, allowedTools: ["search_images"] } } },
  }
  const result = await selectStickerExpression({ keyword: "加班很累，想要温柔安慰摸摸头" }, {
    config,
    toolConfig: { primaryTool: "mcp_gallery_search_images", candidateCount: 10, selectionMode: "best", recentWindowSeconds: 7200 },
    e: { group_id: "group-1", user_id: "user-1" },
  }, { trackRecent: false })
  assert.equal(result.status, "selected")
  assert.equal(result.selected.url, "https://example.test/pat.gif")
  assert.equal(result.binding.toolName, "mcp_gallery_search_images")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, "mcp_gallery_search_images")
  assert.deepEqual(calls[0].args, {
    keyword: "加班很累，想要温柔安慰摸摸头",
    match: "semantic",
    sort: "relevance",
    count: 10,
  })

  const structured = extractStickerCandidates({ structuredContent: { images: [{ id: "structured", url: "https://example.test/a.png" }] } })
  assert.equal(structured[0].id, "structured")
  const directUrl = extractStickerCandidates({ images: ["https://example.test/direct.gif"] })
  assert.equal(directUrl.length, 1)
  const hiddenAdapter = new McpToolAdapter("gallery", { callTool: async () => ({}) }, { name: "search_images", annotations: { readOnlyHint: true } }, { toolPolicies: { search_images: { hiddenFromModel: true } } })
  assert.equal(hiddenAdapter.hiddenFromModel, true)
  const duplicateBeforeReceipt = await selectStickerExpression({ keyword: "加班很累，想要温柔安慰摸摸头" }, {
    config,
    toolConfig: { primaryTool: "mcp_gallery_search_images", candidateCount: 10, selectionMode: "best", recentWindowSeconds: 7200 },
    e: { group_id: "group-1", user_id: "user-1" },
  }, { trackRecent: false })
  assert.equal(duplicateBeforeReceipt.status, "selected")
  recordStickerExpressionSent("group:group-1", "tool:mcp_gallery_search_images", "context-match", 120)
  const duplicate = await selectStickerExpression({ keyword: "加班很累，想要温柔安慰摸摸头" }, {
    config,
    toolConfig: { primaryTool: "mcp_gallery_search_images", candidateCount: 10, selectionMode: "best", recentWindowSeconds: 7200 },
    e: { group_id: "group-1", user_id: "user-1" },
  }, { trackRecent: false })
  assert.equal(duplicate.status, "skipped")

  resetStickerExpressionState()
  toolRegistry.get = originalGet
  toolRegistry.execute = originalExecute
  await toolRegistry.destroy()
  console.log("Sticker expression checks passed (MCP binding, semantic ranking, plan, and dedupe).")
} finally {
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}

process.exit(0)
