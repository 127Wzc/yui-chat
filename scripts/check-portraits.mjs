import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { runStateMigrations } from "../output/runtime/core/storage/sqlite/migration-runner.js"
import { parse as parseYaml } from "yaml"
import { createRequire, registerHooks } from "node:module"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-portraits-"))
process.env.YUI_CHAT_RUNTIME_ROOT = root
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/lib/plugins/loader.js')) return { shortCircuit: true, url: 'data:text/javascript,export default { priority: [], deal: async()=>false }' }
  return next(specifier, context)
} })
global.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {} }
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = { image: value => value }
global.plugin = class {}
let sqliteClient, capture
try {
  // 从真实线上边界 009 升级，验证迁移记录、原数据和按类型唯一约束。
  const upgrade = new Database(":memory:")
  try {
    const migrationDir = new URL("../core/storage/sqlite/migrations/", import.meta.url)
    const files = (await fs.readdir(migrationDir)).filter(f => f.endsWith(".sql")).sort()
    const onlineFiles = files.filter(f => f < "010")
    assert.equal(onlineFiles.at(-1), "009-command-availability.sql")
    upgrade.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY,applied_at INTEGER NOT NULL) STRICT")
    for (const file of onlineFiles) {
      upgrade.exec(await fs.readFile(new URL(file, migrationDir), "utf8"))
      upgrade.prepare("INSERT INTO schema_migrations VALUES(?,1)").run(file)
    }
    upgrade.prepare("INSERT INTO memory_items(id,scope_type,owner_id,type,text,normalized_key,last_confirmed_at,created_at,updated_at) VALUES('before-upgrade','user','u','fact','升级前事实','before-upgrade',1,1,1)").run()
    const migrations = runStateMigrations(upgrade)
    assert.deepEqual(migrations.map(row => row.id), [...onlineFiles, "010-memory-portraits.sql"])
    assert(migrations.slice(0, -1).every(row => row.applied_at === 1), "existing migrations must not rerun")
    assert.equal(upgrade.prepare("SELECT text FROM memory_items WHERE id='before-upgrade'").get().text, "升级前事实")
    assert.deepEqual(upgrade.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'portrait_%' ORDER BY name").all().map(row => row.name), ["portrait_jobs", "portrait_monthly_usage", "portrait_reports", "portrait_type_defaults"])
    const insertReport = upgrade.prepare("INSERT INTO portrait_reports(id,group_id,user_id,type_id,version,month,report_json,sources_json,created_at) VALUES(?,'g','u',?,1,'2026-10','{}',?,1)")
    const sources = JSON.stringify({ memories: [{ id: "before-upgrade" }] })
    insertReport.run("positive-report", "positive", sources)
    insertReport.run("negative-report", "negative", sources)
    assert.throws(() => insertReport.run("duplicate-report", "positive", sources), /UNIQUE/)
    const insertQuota = upgrade.prepare("INSERT INTO portrait_monthly_usage VALUES('g','u',?,'2026-10',?)")
    insertQuota.run("positive", "positive-report"); insertQuota.run("negative", "negative-report")
    assert.throws(() => insertQuota.run("positive", "duplicate-report"), /UNIQUE/)
    const insertJob = upgrade.prepare("INSERT INTO portrait_jobs(id,group_id,user_id,type_id,month,actor_id,forced,status,started_at) VALUES(?,'g','u',?,'2026-10','u',0,'running',1)")
    insertJob.run("positive-job", "positive"); insertJob.run("negative-job", "negative")
    assert.throws(() => insertJob.run("duplicate-job", "positive"), /UNIQUE/)
    assert.deepEqual(runStateMigrations(upgrade), migrations, "restart must not recreate portrait tables or reset quotas")
    assert.equal(upgrade.prepare("SELECT COUNT(*) AS n FROM portrait_monthly_usage").get().n, 2)
    upgrade.prepare("DELETE FROM memory_items WHERE id='before-upgrade'").run()
    assert(upgrade.prepare("SELECT status FROM portrait_reports").all().every(row => row.status === "invalid"))
    assert.equal(upgrade.pragma("quick_check", { simple: true }), "ok")
  } finally { upgrade.close() }
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  ;({ groupCaptureStore: capture } = await import("../output/runtime/memory/group-capture.js"))
  const { memoryRepository } = await import("../output/runtime/memory/repository.js")
  const { PortraitStore, portraitStore, portraitMonth, validatePortraitContent, PORTRAIT_SYSTEM_PROMPT } = await import("../output/runtime/memory/portrait.js")
  const { PORTRAIT_TYPES } = await import("../output/runtime/memory/portrait-types.js")
  const { runPortraitCommand } = await import("../output/runtime/apps/commands/portrait.js")
  const { buildPortraitHtml, buildPortraitPreviewDocument } = await import("../output/runtime/core/rendering/portrait-template.js")
  const { registerPortraitRoutes } = await import("../output/runtime/web/http/routes/knowledge/portraits.js")
  const { requireWebAuth } = await import("../output/runtime/web/http/auth.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { estimateTokens } = await import("../output/runtime/core/chat/token-budget.js")
  assert.equal(defaults.memory.portrait.inputTokenLimit, 300000)
  assert.equal(defaults.memory.portrait.historyCount, 200)
  assert.equal(defaults.memory.portrait.maxTokens, 10000)
  assert.equal(defaults.memory.portrait.defaultType, "positive")
  const upstreamPrompts = parseYaml(await fs.readFile(new URL("../resources/portrait/builtin_prompts.yaml", import.meta.url), "utf8"))
  assert.equal(PORTRAIT_TYPES.length, 5)
  for (const type of PORTRAIT_TYPES) assert.equal(type.prompt, upstreamPrompts.find(p => p.command === type.command).content.trim())
  await configStore.load()
  await sqliteClient.init(defaults)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  await configStore.update(c => { c.memory.groupCapture.consolidation.enabled = false })
  await configStore.update(c => { c.memory.portrait.defaultStyle = "sharp"; c.memory.portrait.styles = [{ id: "old" }] })
  assert(!Object.hasOwn(configStore.get().memory.portrait, "styles"))
  assert(!Object.hasOwn(configStore.get().memory.portrait, "defaultStyle"))
  let now = Date.now()
  const actor = { userId: "user-a", admin: false }, admin = { userId: "owner", admin: true }
  for (const group of ["group-a", "group-b", "group-fail", "group-race", "group-backfill"]) await capture.setPolicy("group", group, { enabled: true })
  async function message(group, id, user = "user-a", text = "我喜欢看科幻小说。", segments = [], at = Date.now()) {
    await sqliteClient.run(`INSERT INTO group_memory_messages(id,group_id,message_id,sender_id,sender_name,sender_role,sent_at,text_content,segments_json,content_hash,is_command,expires_at)
      VALUES(?,?,?,?,?,'member',?,?,?,?,0,?)`, [id, group, id, user, "示例成员", at, text, JSON.stringify(segments), id, Date.now() + 86400000])
  }
  const fact = await memoryRepository.insert({ scopeType: "user", ownerId: "user-a", type: "fact", text: "用户喜欢科幻小说。", tags: ["preference"], factKey: "preference.reading", factValue: "scifi" })
  await memoryRepository.insert({ scopeType: "user_group", ownerId: "user-a", groupId: "other-group", type: "fact", text: "其他群的秘密约定" })
  await memoryRepository.insert({ scopeType: "user", ownerId: "user-other", type: "fact", text: "其他成员的私人记忆" })
  await message("group-a", "context", "user-other", "最近看什么？")
  await message("group-a", "a1", "user-a", "我最近在看科幻小说。", [{ type: "reply", messageId: "context" }])
  await message("group-a", "a-sensitive", "user-a", "手机号是 13812345678")
  await message("group-b", "b1")
  let calls = 0, inputs = [], mode = "normal", release
  const model = async options => {
    calls++; inputs.push(options)
    if (mode === "fail") throw new Error("provider failed Authorization: should-never-leak")
    if (mode === "pause") await new Promise(resolve => { release = resolve })
    const input = JSON.parse(options.prompt)
    return { text: JSON.stringify({ ...(input.task.id === "clone" ? { personaPrompt: "你正在模拟一位喜欢科幻阅读的虚构群聊角色。使用简洁直接的句子，面对不同意见先询问理由。不要声称自己是真实用户，不编造身份资料。" } : {}), title: "把兴趣说清楚", summary: mode === "process" ? "<think>先检查聊天资料</think>" : "持续关注科幻话题，表达自己的阅读偏好。", keywords: ["科幻"], sections: [{ heading: "兴趣与表达", text: "喜欢科幻小说，可能会乐于分享阅读感受。" }], uncertainties: "样本有限，尚不足以判断其他场景的表现。" }) }
  }
  const service = new PortraitStore(model, () => now)
  assert.equal(portraitMonth(Date.parse("2026-10-31T15:59:59Z")).month, "2026-10")
  assert.equal(portraitMonth(Date.parse("2026-10-31T16:00:00Z")).month, "2026-11")
  assert.equal(portraitMonth(Date.parse("2026-12-31T16:00:00Z")).nextAt, Date.parse("2027-01-31T16:00:00Z"))
  await assert.rejects(service.generate("disabled", "user-a", { actor }), /未开启/)
  await assert.rejects(service.generate("group-a", "user-other", { actor }), /只能/)
  await assert.rejects(service.generate("group-a", "user-a", { actor, force: true }), /只能/)
  assert.equal(calls, 0)

  // 同一 Store 的并发去重，以及跨 Store 的 SQLite 任务预留。
  mode = "pause"
  const first = service.generate("group-a", "user-a", { actor, supplement: false })
  for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert(release)
  const second = service.generate("group-a", "user-a", { actor, supplement: false })
  const separate = new PortraitStore(model, () => now)
  await assert.rejects(separate.generate("group-a", "user-a", { actor, supplement: false }), /已有画像/)
  release(); mode = "normal"
  const [one, two] = await Promise.all([first, second])
  assert.equal(one.report.id, two.report.id)
  assert.equal(calls, 1)
  const input = JSON.parse(inputs[0].prompt)
  assert(!inputs[0].prompt.includes("其他群的秘密") && !inputs[0].prompt.includes("私人记忆") && !inputs[0].prompt.includes("13812345678"))
  assert.equal(input.contextMessages[0].contextOnly, true)
  assert.equal(input.contextMessages[0].author, "其他成员")
  assert.equal(input.messages[0].replyTo, input.contextMessages[0].id)
  assert(!Object.hasOwn(input, "targetUserId") && !Object.hasOwn(input, "groupId") && !Object.hasOwn(input, "manualProfile"))
  assert(!inputs[0].prompt.includes("evidenceId") && !inputs[0].prompt.includes("messageId") && !inputs[0].prompt.includes("user-a"))
  assert(estimateTokens(inputs[0].prompt) + estimateTokens(PORTRAIT_SYSTEM_PROMPT) <= configStore.get().memory.portrait.inputTokenLimit)
  assert.equal(one.report.messageCount, 1)
  assert.deepEqual(one.report.sections, [{ heading: "兴趣与表达", text: "喜欢科幻小说，可能会乐于分享阅读感受。" }])
  assert.equal(inputs[0].maxTokens, 10000, "portrait output defaults to the 10000-token ceiling")
  // 已保存的旧结构保留原样，读取与重提炼都不能要求重新生成或迁移。
  const legacyReport = { ...one.report, sections: one.report.sections.map(section => ({ ...section, kind: "self_report", evidenceIds: ["s:a1"] })) }
  await sqliteClient.run("UPDATE portrait_reports SET report_json=? WHERE id=?", [JSON.stringify(legacyReport), one.report.id])
  assert.deepEqual((await service.view("group-a", "user-a", actor)).report.sections, legacyReport.sections)
  const cached = await service.generate("group-a", "user-a", { actor, historyCount: 500 })
  assert(cached.cached); assert.equal(calls, 1)
  assert.equal((await service.view("group-a", "user-a", actor)).used, true)
  const restarted = new PortraitStore(model, () => now)
  assert((await restarted.generate("group-a", "user-a", { actor })).cached, "persisted quota survives new Store instances")

  await service.setDefaultType("group-a", "", "negative")
  await service.setDefaultType("group-a", "user-a", "positive")
  assert.equal((await service.typeSettings("group-a", "user-a")).type.id, "positive")
  assert.equal((await service.typeSettings("group-b", "user-a")).type.id, "positive")
  assert.equal((await service.view("group-a", "user-a", actor)).report.typeId, "positive")
  const forced = await service.generate("group-a", "user-a", { actor: admin, force: true, supplement: false })
  assert.equal(forced.report.typeId, "positive"); assert.equal(forced.report.version, 2)
  const previousInput = JSON.parse(inputs.at(-1).prompt).previous
  assert.deepEqual(previousInput.sections, one.report.sections)
  assert.equal(previousInput.referenceOnly, true)
  assert(!JSON.stringify(previousInput).includes("evidenceIds"), "old evidence identifiers must not become new evidence")
  assert.equal((await service.view("group-a", "user-a", admin)).reports.length, 2)
  await service.setDefaultType("group-a", "user-a", "")
  assert.equal((await service.typeSettings("group-a", "user-a")).type.id, "negative")
  await service.setDefaultType("group-a", "", "")
  await assert.rejects(service.setDefaultType("group-a", "user-a", "missing"), /内置/)
  await service.generate("group-b", "user-a", { actor, supplement: false })
  assert.equal(calls, 3, "quota is per group and user")

  // 回复链接只在本次输入使用短编号；重复回复共享上下文，本人发言不重复发送。
  await capture.setPolicy("group", "group-replies", { enabled: true })
  const replyTime = Date.now() - 10000
  await message("group-replies", "own-quote", "user-a", "我想配一台电脑。", [], replyTime)
  await message("group-replies", "own-reply", "user-a", "预算再加一些。", [{ type: "reply", messageId: "own-quote" }], replyTime + 1000)
  await message("group-replies", "other-quote", "user-other", "主要用来做什么？", [], replyTime + 2000)
  await message("group-replies", "reply-one", "user-a", "主要是工作。", [{ type: "reply", messageId: "other-quote" }], replyTime + 3000)
  await message("group-replies", "reply-two", "user-a", "主要是工作，也会玩游戏。", [{ type: "reply", messageId: "other-quote" }], replyTime + 4000)
  await message("group-replies", "reply-missing", "user-a", "这条回复的原文已经不可用。", [{ type: "reply", messageId: "missing" }], replyTime + 5000)
  await message("group-replies", "private-quote", "user-other", "手机号是 13812345678", [], replyTime + 6000)
  await message("group-replies", "reply-private", "user-a", "好的，知道了。", [{ type: "reply", messageId: "private-quote" }], replyTime + 7000)
  const linked = await service.generate("group-replies", "user-a", { actor, supplement: false })
  const linkedInput = JSON.parse(inputs.at(-1).prompt)
  const byText = text => linkedInput.messages.find(item => item.text === text)
  assert.equal(linkedInput.messages.length, 6)
  assert.equal(linkedInput.contextMessages.length, 1)
  assert.equal(byText("预算再加一些。").replyTo, byText("我想配一台电脑。").id)
  assert.equal(byText("主要是工作。").replyTo, linkedInput.contextMessages[0].id)
  assert.equal(byText("主要是工作，也会玩游戏。").replyTo, linkedInput.contextMessages[0].id)
  assert(!Object.hasOwn(byText("这条回复的原文已经不可用。"), "replyTo"))
  assert(!Object.hasOwn(byText("好的，知道了。"), "replyTo"))
  assert(!inputs.at(-1).prompt.includes("13812345678"))
  assert(!inputs.at(-1).prompt.includes("other-quote") && !inputs.at(-1).prompt.includes("user-other"))
  assert.equal((await service.evidence("group-replies", "user-a", linked.report.id, admin)).filter(item => item.type === "context").length, 1)
  await sqliteClient.run("DELETE FROM group_memory_messages WHERE id='other-quote'")
  assert.equal((await service.view("group-replies", "user-a", actor)).report, null, "撤回未逐段引用的回复上下文仍停用画像")
  await capture.setPolicy("group", "group-a", { enabled: false })
  await assert.rejects(service.view("group-a", "user-a", admin), /未开启/)
  await assert.rejects(service.generate("group-a", "user-a", { actor: admin, force: true }), /未开启/)
  await capture.setPolicy("group", "group-a", { enabled: true })

  // 模型失败和资料不足不会占用额度，原副本在重提炼失败时保持。
  mode = "fail"
  await assert.rejects(service.generate("group-fail", "user-a", { actor, supplement: false }), e => !e.message.includes("Authorization") && /未完成/.test(e.message))
  assert.equal((await service.view("group-fail", "user-a", actor)).used, false)
  await assert.rejects(service.generate("group-a", "user-a", { actor: admin, force: true, supplement: false }))
  assert.equal((await service.view("group-a", "user-a", actor)).report.id, forced.report.id)
  mode = "process"
  await assert.rejects(service.generate("group-fail", "user-a", { actor, supplement: false }), /过程文本/)
  assert.equal((await service.view("group-fail", "user-a", actor)).used, false, "process text must not be published or consume the monthly quota")
  mode = "normal"
  await assert.rejects(service.generate("group-fail", "empty-user", { actor: { userId: "empty-user", admin: false }, supplement: false }), /没有足够/)
  assert.equal((await service.view("group-fail", "empty-user", admin)).used, false)
  await service.generate("group-fail", "user-a", { actor, supplement: false })
  // 编辑或删除依据后旧副本不能继续作为模型证据，也不能用重试绕过月额度。
  await memoryRepository.update(fact.id, { text: "用户现在更喜欢历史小说。" })
  assert.equal((await service.view("group-a", "user-a", actor)).report, null)
  await assert.rejects(service.generate("group-a", "user-a", { actor, supplement: false }), /失效/)
  await service.generate("group-a", "user-a", { actor: admin, force: true, supplement: false })
  await sqliteClient.run("DELETE FROM group_memory_messages WHERE id='context'")
  assert.equal((await service.view("group-a", "user-a", actor)).report, null, "withdrawing reply context invalidates derived analysis")

  // 原文自然清理保留报告；主动清空群资料时报告失效。
  await sqliteClient.run("UPDATE group_memory_messages SET expires_at=? WHERE id='b1'", [Date.now() + 150])
  const fresh = await service.generate("group-b", "user-a", { actor: admin, force: true, supplement: false })
  await new Promise(resolve => setTimeout(resolve, 170))
  await sqliteClient.run("DELETE FROM group_memory_messages WHERE id='b1'")
  now += 2 * 86400000
  assert.equal((await service.view("group-b", "user-a", actor)).report.id, fresh.report.id)
  await capture.clear("group", "group-b", "raw")
  assert.equal((await service.view("group-b", "user-a", actor)).report, null)
  now = Date.now()
  mode = "pause"; release = null
  const race = service.generate("group-race", "user-a", { actor, supplement: false })
  for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5))
  await capture.setPolicy("group", "group-race", { enabled: false }); release()
  await assert.rejects(race, /未开启/)
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS n FROM portrait_monthly_usage WHERE group_id='group-race'")).n, 0)
  mode = "normal"

  // 模型不返回来源编号时，生成期间资料被修改仍必须拒绝保存且不占额度。
  await capture.setPolicy("group", "group-source-race", { enabled: true })
  await message("group-source-race", "race-source", "user-race", "我喜欢读小说。")
  const raceActor = { userId: "user-race", admin: false }
  mode = "pause"; release = null
  const sourceRace = service.generate("group-source-race", "user-race", { actor: raceActor, supplement: false })
  for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert(release)
  await sqliteClient.run("UPDATE group_memory_messages SET text_content=? WHERE id='race-source'", ["我的兴趣已经改变。"])
  release(); mode = "normal"
  await assert.rejects(sourceRace, /生成期间资料已修改/)
  const afterSourceRace = await service.view("group-source-race", "user-race", raceActor)
  assert.equal(afterSourceRace.report, null)
  assert.equal(afterSourceRace.used, false)

  // 原生接口补录：只保存期限内消息，不新增历史提炼任务。
  let pages = 0
  global.Bot.pickGroup = async () => ({ getChatHistory: async () => { pages++; return [
    { message_id: "native-a", user_id: "user-a", time: Math.floor(Date.now() / 1000) - 600, raw_message: "我最近喜欢历史小说", sender: { user_id: "user-a", nickname: "用户" } },
    { message_id: "native-old", user_id: "user-a", time: Math.floor(Date.now() / 1000) - 40 * 86400, raw_message: "不应恢复的过期原文", sender: { user_id: "user-a" } },
  ] } })
  await service.generate("group-backfill", "user-a", { actor, historyCount: 50 })
  assert.equal(pages, 1)
  assert(await sqliteClient.get("SELECT id FROM group_memory_messages WHERE message_id='native-a'"))
  assert(!await sqliteClient.get("SELECT id FROM group_memory_messages WHERE message_id='native-old'"))
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS n FROM group_memory_extraction_jobs WHERE group_id='group-backfill'")).n, 0)
  await service.generate("group-backfill", "user-a", { actor })
  assert.equal(pages, 1, "cached reports never fetch platform history")

  // 补录只归档历史，不得回滚本人或其他群成员的当前平台身份。
  await capture.setPolicy("group", "identity-history", { enabled: true })
  const identityUsers = ["identity-person", "identity-other"]
  for (const user of identityUsers) capture.record({ isGroup: true, group_id: "identity-history", user_id: user, message_id: `live-${user}`, time: Math.floor(Date.now() / 1000), raw_message: "当前消息", sender: { user_id: user, nickname: `当前昵称-${user}`, card: `当前名片-${user}` } })
  await capture.drain()
  const identityRows = () => sqliteClient.all("SELECT owner_id,group_id,fact_key,fact_value FROM memory_items WHERE owner_id IN ('identity-person','identity-other') AND status='active' ORDER BY owner_id,fact_key")
  const currentIdentities = await identityRows()
  assert.equal(currentIdentities.length, 4)
  const originalPickGroup = global.Bot.pickGroup
  global.Bot.pickGroup = async () => ({ getChatHistory: async () => identityUsers.map(user => ({ message_id: `history-${user}`, user_id: user, time: Math.floor(Date.now() / 1000) - 86400, raw_message: "旧消息仍可归档", sender: { user_id: user, nickname: `旧昵称-${user}`, card: `旧名片-${user}` } })) })
  try {
    await capture.backfillHistory("group", "identity-history", { limit: 20, queueExtraction: false, respectRetention: true })
    assert.deepEqual(await identityRows(), currentIdentities)
    assert.equal((await sqliteClient.get("SELECT COUNT(*) AS n FROM group_memory_messages WHERE group_id='identity-history'")).n, 4)
    // 管理员的普通补录也不能覆盖身份。
    await capture.backfillHistory("group", "identity-history", { limit: 20 })
    assert.deepEqual(await identityRows(), currentIdentities)
  } finally { global.Bot.pickGroup = originalPickGroup }
  capture.record({ isGroup: true, group_id: "identity-history", user_id: identityUsers[0], message_id: "live-new-name", raw_message: "新实时消息", sender: { user_id: identityUsers[0], nickname: "新实时昵称", card: "新实时名片" } })
  await capture.drain()
  assert((await identityRows()).some(row => row.fact_value === "新实时昵称"))

  // 月份推进由请求触发，前一个月的副本不会在后台自动重生成。
  const beforeMonthCalls = calls
  now = portraitMonth(now).nextAt + 1
  const next = await service.generate("group-fail", "user-a", { actor, supplement: false })
  assert.equal(next.cached, false); assert.equal(calls, beforeMonthCalls + 1)
  assert.equal(next.report.month, portraitMonth(now).month)

  // 超过旧 30000 Token 上限的原文能在默认预算内完整进入模型，不截断消息。
  now = Date.now()
  await capture.setPolicy("group", "group-large", { enabled: true })
  const longText = "星".repeat(1000)
  for (let i = 0; i < 70; i++) await message("group-large", `large-${i}`, "user-a", `${longText}，第${i}次分享。`)
  const large = await service.generate("group-large", "user-a", { actor, historyCount: 100, supplement: false })
  const largeTokens = estimateTokens(inputs.at(-1).prompt) + estimateTokens(PORTRAIT_SYSTEM_PROMPT)
  assert(largeTokens > 30000 && largeTokens <= 300000)
  assert.equal(large.report.messageCount, 70)
  assert.equal(inputs.at(-1).maxTokens, 10000)

  await configStore.update(c => { c.memory.portrait.inputTokenLimit = 3000 })
  const small = await service.generate("group-large", "user-a", { actor: admin, force: true, historyCount: 100, supplement: false })
  assert(small.report.messageCount < 70)
  assert(estimateTokens(inputs.at(-1).prompt) + estimateTokens(PORTRAIT_SYSTEM_PROMPT) <= 3000)
  assert(JSON.parse(inputs.at(-1).prompt).messages.every(m => m.text.includes(longText)), "individual messages remain complete")

  // 预算不足以装入回复上下文时，不能留下指向缺失内容的编号。
  await capture.setPolicy("group", "group-context-budget", { enabled: true })
  await message("group-context-budget", "large-context", "user-other", "背景".repeat(10000), [], Date.now() - 1000)
  await message("group-context-budget", "budget-reply", "user-a", "好的。", [{ type: "reply", messageId: "large-context" }])
  const budgetResult = await service.generate("group-context-budget", "user-a", { actor, supplement: false })
  const budgetInput = JSON.parse(inputs.at(-1).prompt)
  assert.equal(budgetInput.contextMessages.length, 0)
  assert(!Object.hasOwn(budgetInput.messages[0], "replyTo"))
  assert(estimateTokens(inputs.at(-1).prompt) + estimateTokens(PORTRAIT_SYSTEM_PROMPT) <= 3000)
  assert(!(await service.evidence("group-context-budget", "user-a", budgetResult.report.id, admin)).some(item => item.type === "context"))
  await configStore.update(c => { c.memory.portrait.inputTokenLimit = 300000 })

  // 大批量既验证 2000 条与 30 万预算，也验证不限、较高预算和分批来源核验。
  await capture.setPolicy("group", "group-2000", { enabled: true })
  const largeUser = "user-2000", largeActor = { userId: largeUser, admin: false }, largeText = "星".repeat(300)
  const largeNow = Date.now()
  await sqliteClient.transaction(Array.from({ length: 2000 }, (_, i) => {
    const id = `batch-${i}`
    return { sql: `INSERT INTO group_memory_messages(id,group_id,message_id,sender_id,sender_name,sender_role,sent_at,text_content,segments_json,content_hash,is_command,expires_at)
      VALUES(?,?,?,?,?,'member',?,?,?,?,0,?)`, params: [id, "group-2000", id, largeUser, "示例成员", largeNow + i, `${largeText}第${i}条`, "[]", id, largeNow + 86400000] }
  }))
  const defaultBudget = await service.generate("group-2000", largeUser, { actor: largeActor, historyCount: 2000, supplement: false })
  const defaultPromptTokens = estimateTokens(inputs.at(-1).prompt) + estimateTokens(PORTRAIT_SYSTEM_PROMPT)
  assert(defaultBudget.report.messageCount > 500 && defaultBudget.report.messageCount < 2000)
  assert(defaultPromptTokens <= 300000)
  await configStore.update(c => { c.memory.portrait.inputTokenLimit = 500000; c.memory.portrait.historyCount = 2000 })
  const raisedBudget = await service.generate("group-2000", largeUser, { actor: admin, force: true, supplement: false })
  assert.equal(raisedBudget.report.requestedCount, 2000)
  assert.equal(raisedBudget.report.messageCount, 2000)
  assert(estimateTokens(inputs.at(-1).prompt) + estimateTokens(PORTRAIT_SYSTEM_PROMPT) > 300000)
  await configStore.update(c => { c.memory.portrait.inputTokenLimit = 0; c.memory.portrait.maxTokens = 65536 })
  assert.equal((await configStore.load()).memory.portrait.inputTokenLimit, 0, "不限值必须在配置持久化后保留")
  const storedConfig = await sqliteClient.get("SELECT overrides_json FROM runtime_config WHERE id=1")
  assert.equal(JSON.parse(storedConfig.overrides_json).memory.portrait.inputTokenLimit, 0)
  const unlimited = await service.generate("group-2000", largeUser, { actor: admin, force: true, supplement: false })
  assert.equal(unlimited.report.messageCount, 2000)
  assert(estimateTokens(inputs.at(-1).prompt) + estimateTokens(PORTRAIT_SYSTEM_PROMPT) > 300000)
  assert.equal(inputs.at(-1).maxTokens, 65536)
  assert.equal((await service.view("group-2000", largeUser, largeActor)).report.id, unlimited.report.id)
  await assert.rejects(service.generate("group-2000", largeUser, { actor: admin, force: true, historyCount: 2001, supplement: false }), /50–2000/)
  await sqliteClient.run("UPDATE group_memory_messages SET text_content=? WHERE id='batch-0'", ["这条资料已改变。"])
  assert.equal((await service.view("group-2000", largeUser, largeActor)).report, null, "2000 条输入中的任意来源修改仍会停用画像")
  await configStore.update(c => { c.memory.portrait.inputTokenLimit = 300000; c.memory.portrait.historyCount = 200; c.memory.portrait.maxTokens = 10000 })

  // 同一成员五种报告独立生成、缓存和保留，默认打开正画像。
  await capture.setPolicy("group", "group-types", { enabled: true })
  const typedReports = new Map()
  for (const type of PORTRAIT_TYPES) {
    const before = calls
    const result = await service.generate("group-types", "user-a", { actor, typeId: type.id, supplement: false })
    assert.equal(result.report.typeId, type.id)
    assert.equal(result.report.version, 1)
    assert.equal(result.report.type.prompt, type.prompt)
    const sent = JSON.parse(inputs.at(-1).prompt)
    assert.equal(sent.task.prompt, type.prompt, "send the upstream task prompt verbatim")
    assert(!Object.hasOwn(sent, "style"), "language styles have been removed")
    assert.equal(sent.previous, null, "another type's report does not become this type's previous report")
    assert((await service.generate("group-types", "user-a", { actor, typeId: type.id })).cached)
    assert.equal(calls, before + 1)
    typedReports.set(type.id, result.report)
  }
  assert.equal((await service.view("group-types", "user-a", actor)).report.id, typedReports.get("positive").id)
  assert(typedReports.get("clone").personaPrompt)
  await service.setDefaultType("group-types", "user-a", "negative")
  assert.equal((await service.view("group-types", "user-a", actor)).report.id, typedReports.get("negative").id)
  assert.equal((await service.getReport("group-types", "user-a", typedReports.get("clone").id, actor)).typeId, "clone")
  assert((await service.evidence("group-types", "user-a", typedReports.get("positive").id, actor)).length > 0)
  await assert.rejects(service.getReport("group-a", "user-a", typedReports.get("clone").id, actor), /不存在/)
  await assert.rejects(service.getReport("group-types", "user-a", typedReports.get("clone").id, { userId: "other", admin: false }), /只能/)
  for (let i = 0; i < 4; i++) await service.generate("group-types", "user-a", { actor: admin, typeId: "general", force: true, supplement: false })
  assert.equal((await service.view("group-types", "user-a", admin, "general")).reports.length, 3)
  assert.equal((await service.view("group-types", "user-a", actor, "positive")).report.id, typedReports.get("positive").id)
  mode = "fail"
  await assert.rejects(service.generate("group-types", "user-a", { actor: admin, typeId: "negative", force: true, supplement: false }))
  assert.equal((await service.view("group-types", "user-a", actor, "negative")).report.id, typedReports.get("negative").id)
  mode = "normal"
  await assert.rejects(service.generate("group-types", "user-a", { actor, typeId: "missing" }), /内置/)

  // 同群同成员的不同类型可以并行，SQLite 唯一锁和版本号也按类型隔离。
  await capture.setPolicy("group", "group-parallel", { enabled: true })
  const gates = []
  const parallelModel = async options => { await new Promise(resolve => gates.push(resolve)); return model(options) }
  const parallel = new PortraitStore(parallelModel, () => now)
  const parallelOther = new PortraitStore(parallelModel, () => now)
  const pending = [parallel.generate("group-parallel", "user-a", { actor, typeId: "positive", supplement: false }), parallelOther.generate("group-parallel", "user-a", { actor, typeId: "negative", supplement: false })]
  for (let i = 0; gates.length < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(gates.length, 2)
  gates.forEach(release => release())
  const parallelReports = await Promise.all(pending)
  assert.deepEqual(parallelReports.map(r => r.report.version), [1, 1])

  const valid = { title: "合法标题", summary: "合法摘要", sections: [{ heading: "兴趣", text: "合法正文" }] }
  assert.deepEqual(validatePortraitContent(valid, new Set()).sections, valid.sections)
  assert.deepEqual(validatePortraitContent({ ...valid, sections: [{ ...valid.sections[0], kind: "inference", evidenceIds: Array.from({ length: 13 }, (_, i) => `fake-${i}`) }] }, new Set()).sections, valid.sections, "额外编号和分类不影响保存，也不作为依赖")
  assert.throws(() => validatePortraitContent(valid, new Set(), "clone"), /格式/)
  assert.throws(() => validatePortraitContent({ ...valid, summary: "手机号 13812345678" }, new Set()), /隐私/)
  for (const summary of ["<think>先检查资料</think>", "思考过程：先分析用户", "## 推理过程：逐条判断"]) assert.throws(() => validatePortraitContent({ ...valid, summary }, new Set()), /过程文本/)
  const cloneOnly = validatePortraitContent({ personaPrompt: "你正在模拟一个喜欢阅读的虚构角色。用简洁自然的语言回应。" }, new Set(), "clone")
  assert.equal(cloneOnly.sections.length, 0)
  assert.equal(cloneOnly.summary, "")
  assert.equal(cloneOnly.title, "")
  assert(cloneOnly.personaPrompt)
  assert.throws(() => validatePortraitContent({ personaPrompt: "手机号 13812345678" }, new Set(), "clone"), /隐私/)
  assert.equal(validatePortraitContent({ ...valid, personaPrompt: cloneOnly.personaPrompt }, new Set(), "clone").sections.length, 1)
  const cleanReport = { ...next.report, name: "示例成员", title: "一份谨慎的正向印象", uncertainties: "样本有限，无法判断。", backfillNote: "平台历史补录说明，仅供管理端核对。" }
  const html = buildPortraitHtml({ ...cleanReport, summary: '<img src=x onerror="bad()">' })
  assert(!html.includes('<img src=x')); assert(html.includes('&lt;img'))
  assert(!html.includes("YUI CHAT / PORTRAIT"), "正文不再显示多余的英文标题")
  assert(html.includes(`<h1>示例成员 · ${cleanReport.type.name}</h1>`), "正文顶部显示昵称和画像类型")
  const taggedHtml = buildPortraitHtml({ ...cleanReport, keywords: ["自然亲切", "<表达简洁>"] })
  assert(taggedHtml.includes('<div class="keywords"><span>自然亲切</span><span>&lt;表达简洁&gt;</span></div>'), "标签分别呈现并转义")
  for (const hidden of [cleanReport.title, cleanReport.uncertainties, cleanReport.backfillNote, "项依据", "本人自述 / 已存事实", "本群行为观察", "原文范围", "不代表完整人格"]) assert(!html.includes(hidden), `finished portrait must omit metadata: ${hidden}`)
  assert(html.includes(cleanReport.sections[0].text))
  const cloneReport = { ...typedReports.get("clone"), summary: "内部摘要不进入克隆成品", keywords: ["内部标签"], sections: [{ heading: "内部说明", text: "内部依据解释", kind: "observation", evidenceIds: ["private-id"] }] }
  const cloneHtml = buildPortraitHtml(cloneReport)
  assert(cloneHtml.includes(cloneReport.personaPrompt))
  for (const hidden of [cloneReport.summary, "内部标签", "内部说明", "内部依据解释"]) assert(!cloneHtml.includes(hidden))
  const preview = buildPortraitPreviewDocument(cleanReport)
  assert(preview.includes("window-buttons"))
  const reportDate = new Date(cleanReport.createdAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })
  assert(preview.includes('<div class="window-title"></div><div class="window-tag"></div>'), "顶部工具栏不显示文字")
  assert(preview.includes(`<header class="portrait-header"><h1>示例成员 · ${cleanReport.type.name}</h1><span class="portrait-date">${reportDate}</span></header>`))
  const escapedPreview = buildPortraitPreviewDocument({ ...cleanReport, name: '<img src=x onerror="bad()">' })
  assert(!escapedPreview.includes('<img src=x') && escapedPreview.includes('&lt;img src=x'))
  assert(!preview.includes(cleanReport.title) && !preview.includes(cleanReport.uncertainties), "preview and PNG share the same finished content")
  assert(PORTRAIT_SYSTEM_PROMPT.includes("资料不足就少写") && PORTRAIT_SYSTEM_PROMPT.includes("不展示得出结论的过程"))
  const badConfig = structuredClone(await configStore.load())
  assert.equal(validateConfig(badConfig).ok, true)
  for (const limit of [0, 3000, 300000, 1000000]) { badConfig.memory.portrait.inputTokenLimit = limit; assert.equal(validateConfig(badConfig).ok, true) }
  for (const limit of [-1, 1, 2999, "", null]) { badConfig.memory.portrait.inputTokenLimit = limit; assert.equal(validateConfig(badConfig).ok, false) }
  badConfig.memory.portrait.inputTokenLimit = 300000
  for (const count of [50, 200, 2000]) { badConfig.memory.portrait.historyCount = count; assert.equal(validateConfig(badConfig).ok, true) }
  for (const count of [49, 2001]) { badConfig.memory.portrait.historyCount = count; assert.equal(validateConfig(badConfig).ok, false) }
  badConfig.memory.portrait.historyCount = 200
  for (const limit of [1024, 10000, 65536]) { badConfig.memory.portrait.maxTokens = limit; assert.equal(validateConfig(badConfig).ok, true) }
  for (const limit of [1023, 65537]) { badConfig.memory.portrait.maxTokens = limit; assert.equal(validateConfig(badConfig).ok, false) }
  badConfig.memory.portrait.maxTokens = 10000
  badConfig.memory.portrait.defaultType = "missing"
  assert.equal(validateConfig(badConfig).ok, false)

  // 命令不能通过昵称文字伪造目标，普通入口不能触及他人或执行重提炼。
  assert.match(await runPortraitCommand({ isGroup: true, group_id: "group-a", user_id: "user-a", msg: "#yui我的画像", message: [{ type: "text", text: "#yui我的画像 " }, { type: "at", qq: "user-other" }] }), /只能/)
  assert.match(await runPortraitCommand({ isGroup: false, user_id: "user-a", msg: "#yui我的画像" }), /群中/)
  assert.match(await runPortraitCommand({ isMaster: false }, true), /只有主人/)

  // 真实命令解析：普通成员选类型仍固定本人，主人可重提炼指定目标。
  const originalGenerate = portraitStore.generate
  const parsedCommands = []
  portraitStore.generate = async (group, user, options) => { parsedCommands.push({ group, user, options }); throw Object.assign(new Error("解析完成"), { statusCode: 400 }) }
  try {
    for (const type of PORTRAIT_TYPES) {
      const reply = await runPortraitCommand({ isGroup: true, group_id: "group-a", user_id: "user-a", msg: `#yui${type.command} 150` })
      assert.equal(reply, "解析完成")
      assert.equal(parsedCommands.at(-1).user, "user-a")
      assert.equal(parsedCommands.at(-1).options.typeId, type.id)
      assert.equal(parsedCommands.at(-1).options.historyCount, 150)
      assert.equal(parsedCommands.at(-1).options.force, false)
    }
    await runPortraitCommand({ isGroup: true, group_id: "group-a", user_id: "owner", isMaster: true, message: [{ type: "text", text: "#yui重提炼画像 找对象 300 " }, { type: "at", qq: "123456" }] }, true)
    assert.equal(parsedCommands.at(-1).user, "123456")
    assert.equal(parsedCommands.at(-1).options.typeId, "matchmaking")
    assert.equal(parsedCommands.at(-1).options.force, true)
    assert.equal(parsedCommands.at(-1).options.historyCount, 300)
    assert.equal(await runPortraitCommand({ isGroup: true, group_id: "group-a", user_id: "user-a", msg: "#yui我的画像 2000" }), "解析完成")
    assert.equal(parsedCommands.at(-1).options.historyCount, 2000)
    assert.equal(await runPortraitCommand({ isGroup: true, group_id: "group-a", user_id: "owner", isMaster: true, msg: "#yui重提炼画像 123456 正画像 2000" }, true), "解析完成")
    assert.equal(parsedCommands.at(-1).user, "123456")
    assert.equal(parsedCommands.at(-1).options.historyCount, 2000)
    assert.match(await runPortraitCommand({ isGroup: true, group_id: "group-a", user_id: "user-a", msg: "#yui我的画像 2001" }), /50–2000/)
  } finally { portraitStore.generate = originalGenerate }

  const routes = []
  const app = Object.fromEntries(["get", "put", "post"].map(method => [method, (url, ...handlers) => routes.push({ method, url, handlers })]))
  registerPortraitRoutes(app)
  assert(routes.length >= 9)
  assert(routes.every(r => r.handlers[0] === requireWebAuth), "every portrait API must authenticate")
  const getRoute = routes.find(r => r.method === "get" && r.url.endsWith("/members/:userId"))
  const settingsRoute = routes.find(r => r.method === "get" && r.url.endsWith("/settings"))
  const apiResponse = () => ({ code: 200, status(n) { this.code = n; return this }, json(v) { this.value = v }, set() { return this } })
  const typedResponse = apiResponse()
  await getRoute.handlers.at(-1)({ params: { groupId: "group-types", userId: "user-a" }, query: { typeId: "clone" }, body: {} }, typedResponse)
  assert.equal(typedResponse.value.report.typeId, "clone")
  assert(typedResponse.value.used)
  // Web 手动生成和主人对其他成员重提炼均可保存无编号段落，并从同一成员视图读取。
  await capture.setPolicy("group", "group-web-portrait", { enabled: true })
  await message("group-web-portrait", "web-target-message", "123456", "我喜欢阅读。")
  const postRoute = routes.find(r => r.method === "post" && r.url.endsWith("/members/:userId"))
  const modelBeforeApi = portraitStore.model
  portraitStore.model = model
  try {
    const created = apiResponse()
    await postRoute.handlers.at(-1)({ params: { groupId: "group-web-portrait", userId: "123456" }, query: {}, body: { typeId: "positive", historyCount: 2000, supplement: false } }, created)
    assert.equal(created.value.ok, true)
    assert.equal(created.value.report.userId, "123456")
    assert.equal(created.value.report.requestedCount, 2000)
    assert(!Object.hasOwn(created.value.report.sections[0], "evidenceIds"))
    const managed = await service.generate("group-web-portrait", "123456", { actor: admin, force: true, typeId: "positive", supplement: false })
    const viewed = apiResponse()
    await getRoute.handlers.at(-1)({ params: { groupId: "group-web-portrait", userId: "123456" }, query: { typeId: "positive" }, body: {} }, viewed)
    assert.equal(viewed.value.report.id, managed.report.id)
    assert.equal(viewed.value.report.version, 2)
    assert.equal(inputs.at(-1).event.user_id, "123456")
  } finally { portraitStore.model = modelBeforeApi }
  const settingsResponse = apiResponse()
  await settingsRoute.handlers.at(-1)({}, settingsResponse)
  assert.equal(settingsResponse.value.types.length, 5)
  assert.equal(settingsResponse.value.settings.defaultType, "positive")
  const endpoint = routes.find(r => r.url.endsWith("/:reportId/preview"))
  const response = { code: 200, status(n) { this.code = n; return this }, json(v) { this.value = v }, set() { return this } }
  await endpoint.handlers.at(-1)({ params: { groupId: "disabled", userId: "user-a", reportId: "unknown" }, query: {}, body: {} }, response)
  assert.equal(response.code, 403)
  assert.equal(response.value.ok, false)

  const updateSettings = routes.find(r => r.method === "put" && r.url.endsWith("/settings"))
  const rejectedStyles = apiResponse()
  await updateSettings.handlers.at(-1)({ body: { settings: { styles: [] } } }, rejectedStyles)
  assert.equal(rejectedStyles.code, 400)
  await memoryRepository.update(fact.id, { text: "用户现已明确更改阅读兴趣。" })
  for (const type of PORTRAIT_TYPES) assert.equal((await service.view("group-types", "user-a", admin, type.id)).report, null, "source withdrawal invalidates every dependent type")

  // Vue 真正编译所有新增模板，避免仅检查源码字符串。
  const require = createRequire(import.meta.url)
  const ts = require("typescript")
  const { compile } = require("vue")
  const client = await fs.readFile(new URL("../web/client/features/memory/memory-portrait.ts", import.meta.url), "utf8")
  const templates = [...client.matchAll(/template:\s*`([\s\S]*?)`/g)].map(m => m[1])
  assert.equal(templates.length, 3)
  for (const template of templates) {
    const errors = []
    compile(template, { onError: e => errors.push(e.message), onWarn: () => {} })
    assert.deepEqual(errors, [])
  }
  // 实际渲染管理端成品卡片，资料说明只在单独的依据抽屉中出现。
  global.location = { pathname: "/yui-chat", hash: "", search: "" }
  global.localStorage = { getItem() { return null } }
  const { createSSRApp } = require("vue")
  const { renderToString } = await import("vue/server-renderer")
  const { components } = await import("../output/runtime/web/client/ui/components.js")
  async function renderWorkspace(report, showEvidence = false, overrides = {}) {
    const state = { enabled: true, data: { types: [], type: report.type, used: false }, report, name: report.name, selectedType: report.typeId, busy: false, loading: false, error: "", showDefaults: false, showGenerate: false, showReport: false, showEvidence, showVersions: false, evidence: [], previewHtml: "", imageUrl: "", historyCount: 200, supplement: false, stamp: () => "日期", ...overrides }
    for (const method of ["openGenerate", "selectType", "load", "copyPersona", "openEvidence", "openReport", "closeDefaults", "generate"]) state[method] = () => {}
    const app = createSSRApp({ template: templates[1], setup: () => state })
    for (const [name, component] of Object.entries(components)) app.component(name, component)
    app.component("PortraitScopeDefaults", { template: "<div />" })
    const context = {}
    const body = await renderToString(app, context)
    return body + Object.values(context.teleports || {}).join("")
  }
  const card = await renderWorkspace(cleanReport)
  assert(card.includes(cleanReport.summary) && card.includes(cleanReport.sections[0].text))
  for (const hidden of [cleanReport.title, cleanReport.uncertainties, cleanReport.backfillNote, "本群观察 / 建议"]) assert(!card.includes(hidden))
  const evidenceView = await renderWorkspace(cleanReport, true)
  assert(evidenceView.includes(cleanReport.uncertainties) && evidenceView.includes(cleanReport.backfillNote), "management evidence view retains missing-data notes")
  const generateView = await renderWorkspace(cleanReport, false, { showGenerate: true, historyCount: 2000 })
  assert(generateView.includes("50–2000 条") && generateView.includes('value="2000"'))
  assert(!/<button[^>]+disabled[^>]*>[^<]*生成画像/.test(generateView), "2000 条必须能够在管理端提交")
  const settingsApp = createSSRApp({ template: templates[2], setup: () => ({ settings: { ...defaults.memory.portrait, inputTokenLimit: 0 }, types: [], dirty: false, busy: false, error: "", typeOptions: [], modelOptions: [], fixedPrompt: "", save() {} }) })
  for (const [name, component] of Object.entries(components)) settingsApp.component(name, component)
  const settingsHtml = await renderToString(settingsApp)
  assert(settingsHtml.includes("默认 300000") && settingsHtml.includes("填 0 不限制本地预算") && settingsHtml.includes("1024–65536"))
  assert(settingsHtml.includes('value="0"'), "不限值必须在设置页正确显示")
  const cloneCard = await renderWorkspace(cloneReport)
  assert(cloneCard.includes(cloneReport.personaPrompt))
  assert(!cloneCard.includes(cloneReport.summary) && !cloneCard.includes("内部依据解释"))
  const compiled = ts.transpileModule(client, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  assert(!compiled.diagnostics?.length)
  console.log("ok portraits: quota per type, concurrency, isolation, builtin prompts, failure recovery, source withdrawal, native backfill, routes, templates")
} finally {
  await capture?.stop({ flush: false })
  await sqliteClient?.close()
  await fs.rm(root, { recursive: true, force: true })
  hooks.deregister()
}
