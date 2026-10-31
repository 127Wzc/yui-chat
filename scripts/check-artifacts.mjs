import assert from "node:assert/strict"
import { ArtifactStore } from "../output/runtime/tools/support/artifact-store.js"
import { defaultArtifactRetentionMs } from "../output/runtime/config/defaults.js"

const store = new ArtifactStore()
const scope = (userId, sessionId = userId) => store.open({ key: `channel:g:group:${userId}`, sessionId, userId, groupId: "group", ttlMs: 60000 })
const a = scope("a")
const b = scope("b")
const first = a.create({ kind: "text", title: "万圣节", source: "web_search", runId: "run-1", toolCallId: "call-1", value: { text: "南瓜灯" } })
const second = a.create({ kind: "text", title: "旅行", source: "web_search", runId: "run-2", value: { text: "海边" } })
const other = b.create({ kind: "text", title: "旅行", source: "web_search", value: { text: "山里" } })
assert.notEqual(first.id, second.id)
assert.notEqual(first.id, other.id)
assert.deepEqual(scope("a").get(first.id).value, { text: "南瓜灯" }, "the same session must reuse the exact reference")
assert.deepEqual(scope("a").get(second.id).value, { text: "海边" }, "multiple results in the same session remain distinct")
assert.throws(() => b.get(first.id), /不存在|过期/, "another sender cannot use the reference")
a.get(first.id, { tool: "generate_image", runId: "run-3", toolCallId: "call-3" })
assert.equal(store.get(first.id).uses[0].tool, "generate_image")
assert.equal(store.get(first.id).userId, "a")
assert.equal(store.list().find(item => item.id === first.id).useCount, 1)
assert(!Object.hasOwn(store.list().find(item => item.id === first.id), "value"), "the management list should not include reference bodies")
const task = a.snapshot([first.id])
assert(store.delete(first.id))
assert.throws(() => a.get(first.id), /不存在|过期/)
assert.equal(task.get(first.id).value.text, "南瓜灯", "an accepted background task owns its selected reference")
assert.throws(() => task.get(second.id), /不存在|过期/, "a task snapshot contains only selected references")
const continued = scope("a", "new-session")
assert.equal(continued.get(second.id).value.text, "海边", "automatic history expiry must preserve the same conversation's references")
assert.throws(() => a.get(second.id), /不存在|过期/, "the previous in-flight context must be invalidated")
store.clearKeys(["channel:g:group:a"])
assert.throws(() => continued.get(second.id), /不存在|过期/)
assert.throws(() => scope("a", "after-clear").get(second.id), /不存在|过期/, "an explicitly ended conversation must start without the old references")
assert.equal(task.get(first.id).value.text, "南瓜灯")
assert.equal(b.get(other.id).value.text, "山里", "clearing one conversation must not affect another")

const actualNow = Date.now
try {
  let now = 1000000
  Date.now = () => now
  const expiring = scope("expiring")
  const entry = expiring.create({ kind: "text", title: "临时", source: "test", value: "文本" })
  now += 60001
  assert.throws(() => expiring.get(entry.id), /不存在|过期/)
  assert(!store.list().some(item => item.id === entry.id))
} finally { Date.now = actualNow }

try {
  let now = 1000000
  Date.now = () => now
  const retentionStore = new ArtifactStore()
  const input = { key: "retention", sessionId: "old", userId: "a", groupId: "g" }
  const original = retentionStore.open(input)
  const entry = original.create({ kind: "text", title: "长期资料", source: "test", value: "内容" })
  assert.equal(defaultArtifactRetentionMs, 30 * 24 * 60 * 60 * 1000)
  const expiresAt = now + defaultArtifactRetentionMs
  assert.equal(retentionStore.get(entry.id).expiresAt, expiresAt)
  now += 7 * 60 * 60 * 1000
  const afterHistoryExpiry = retentionStore.open({ ...input, sessionId: "new" })
  assert.equal(afterHistoryExpiry.get(entry.id).value, "内容")
  assert.throws(() => original.get(entry.id), /不存在|过期/)
  assert.equal(retentionStore.get(entry.id).sessionId, "new")
  now += 29 * 24 * 60 * 60 * 1000
  const continuedConversation = retentionStore.open({ ...input, sessionId: "new" })
  assert.equal(continuedConversation.get(entry.id).value, "内容")
  assert.equal(retentionStore.get(entry.id).expiresAt, expiresAt, "continuing the conversation must not renew old references")
  const laterEntry = continuedConversation.create({ kind: "text", title: "更新的资料", source: "test", value: "新内容" })
  assert.equal(retentionStore.get(laterEntry.id).expiresAt, now + defaultArtifactRetentionMs)
  now = expiresAt - 1
  assert.equal(continuedConversation.get(entry.id).value, "内容")
  now++
  assert.throws(() => continuedConversation.get(entry.id), /不存在|过期/)
  assert(!retentionStore.list().some(item => item.id === entry.id))
  assert.equal(continuedConversation.get(laterEntry.id).value, "新内容", "newer references must have their own expiry")
  assert.throws(() => retentionStore.open({ ...input, sessionId: "later" }).get(entry.id), /不存在|过期/)
} finally { Date.now = actualNow }

const bounded = scope("bounded")
const entries = Array.from({ length: 21 }, (_, index) => bounded.create({ kind: "text", title: `资料${index}`, source: "test", value: String(index) }))
assert.equal(bounded.list().length, 20)
assert.throws(() => bounded.get(entries[0].id), /不存在|过期/)
assert.equal(bounded.get(entries[20].id).value, "20")
const activeStore = new ArtifactStore()
const active = activeStore.open({ key: "same-conversation", sessionId: "new", userId: "a", groupId: "g", ttlMs: 60000 })
const activeRef = active.create({ kind: "text", title: "新会话", source: "test", value: "有效" })
const stale = activeStore.open({ key: "same-conversation", sessionId: "old", userId: "a", groupId: "g", ttlMs: 60000, isCurrent: () => false })
assert.throws(() => stale.create({ kind: "text", title: "旧会话", source: "test", value: "过期" }), /已结束/)
assert.equal(active.get(activeRef.id).value, "有效", "a stale in-flight request must not evict the new session")

// 使用真实 Vue 模板渲染详情，验证内容、分页和文本转义。
global.location = { pathname: "/yui-chat", hash: "", search: "" }
global.localStorage = { getItem: () => null }
const { createSSRApp } = await import("vue")
const { renderToString } = await import("vue/server-renderer")
const { ArtifactPanel } = await import("../output/runtime/web/client/features/logs/artifact-panel.js")
const { components } = await import("../output/runtime/web/client/ui/components.js")
const detail = { id: "ref-display", title: "本人记忆", kind: "memory", source: "memory_manage", userId: "a", groupId: "g", sessionId: "session", createdAt: 1, expiresAt: 2, value: { scope: "self", referenceGroupId: "g" } }
const preview = Array.from({ length: 11 }, (_, index) => ({ id: String(index), userId: "a", groupId: index === 0 ? "other" : "", scope: index === 0 ? "user_group" : "user", type: "fact", text: index === 0 ? "<script>安全文本</script>\n第二行" : `记忆第 ${index + 1} 条` }))
const panel = { ...ArtifactPanel, setup(props, context) { const state = ArtifactPanel.setup(props, context); state.selected.value = detail; state.memoryRecords.value = preview; return state } }
const app = createSSRApp(panel)
for (const [name, component] of Object.entries(components)) if (name !== "SideDrawer") app.component(name, component)
app.component("SideDrawer", { props: ["open"], template: '<div v-if="open"><slot /><footer><slot name="actions" /></footer></div>' })
const html = await renderToString(app)
assert(html.includes("当前有效记忆") && html.includes("内容可能与之前画图时不同"))
assert(html.includes("&lt;script&gt;安全文本&lt;/script&gt;") && !html.includes("<script>安全文本</script>"), "reference text must be rendered as text")
assert(html.includes("群 other 的记忆"), "another group's memory must not be labeled as current-group memory")
assert(html.includes("记忆 1-10 / 11") && !html.includes("记忆第 11 条"), "the real detail view must paginate long memory lists")
console.log("ok artifacts: multiple references, session isolation, reuse, task snapshots, usage lineage, expiry and bounded cleanup")
