import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-memory-p1-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot

global.logger = {
  mark() {}, info() {}, warn() {}, error() {}, debug() {},
  blue: value => value, cyan: value => value, red: value => value,
}
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = { at: id => `[at:${id}]`, image: value => `[image:${value}]`, record: value => `[record:${value}]`, video: value => `[video:${value}]`, reply: value => `[reply:${value}]` }
global.plugin = class { constructor(options = {}) { this.options = options } }

let sqliteClient
let groupCaptureStore

try {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  const { sqliteMemoryStore } = await import("../output/runtime/memory/sqlite-store.js")
  const { validateMemoryWrite } = await import("../output/runtime/memory/write-policy.js")
  const { groupCaptureStore: capture, serializeExtractionResult } = await import("../output/runtime/memory/group-capture.js")
  groupCaptureStore = capture

  for (const value of [
    "请记住我的手机号是 13812345678",
    "请记住我的手机号是 +86 (138) 1234-5678",
    "请记住我的手机号是 138.1234.5678",
    "请记住短信验证码 731926",
    "请记住验证码 A1B2C3",
    "请记住我住在北京市朝阳区建国路88号3单元",
    "请记住我家在上海市浦东新区汤臣一品8栋302室",
    "请记住身份证号 11010519491231002X",
    "请记住身份证号 110105491231002",
    "请记住银行卡 4539 1488 0343 6467",
  ]) {
    assert.throws(() => validateMemoryWrite(value), /保护隐私/, `must reject sensitive memory: ${value}`)
  }
  assert.equal(validateMemoryWrite("请记住我喜欢手冲咖啡"), "请记住我喜欢手冲咖啡")
  // 15 位数字仅在形如旧证件号（第 9-12 位是合法月日）时拦截，任意 15 位编号不误伤。
  assert.equal(validateMemoryWrite("请记住订单号 123456789012345"), "请记住订单号 123456789012345")

  const oversized = serializeExtractionResult({
    items: Array.from({ length: 900 }, (_, index) => ({ id: `memory-${index}`, text: `第${index}条${"长文本".repeat(120)}` })),
    modelCallCount: 3,
    messageCount: 900,
  })
  const parsedOversized = JSON.parse(oversized)
  assert(oversized.length <= 200000, "structured extraction result must respect the SQLite field limit")
  assert.equal(parsedOversized.truncated, true)
  assert(parsedOversized.omittedItemCount > 0)
  assert(Array.isArray(parsedOversized.items))
  assert.equal(parsedOversized.memoryResultCount, 900, "cropped extraction results must retain the full meaningful-result count")
  assert.equal(parsedOversized.ignoredResultCount, 0)

  await configStore.load()
  await sqliteClient.init(defaults)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  await configStore.update(config => { config.memory.groupCapture.enabled = true })
  await sqliteClient.run(
    "INSERT INTO group_memory_extraction_jobs(id, group_id, window_start, window_end, content_hash, extractor_version, status, result_json, created_at, updated_at) VALUES('oversized-result', 'result-group', 1, 2, 'hash', 'test', 'completed', ?, 1, 1)",
    [oversized],
  )
  assert.deepEqual(
    await sqliteClient.get("SELECT json_valid(result_json) AS valid, length(result_json) AS length FROM group_memory_extraction_jobs WHERE id='oversized-result'"),
    { valid: 1, length: oversized.length },
    "the cropped result must satisfy the baseline JSON constraint",
  )
  await groupCaptureStore.init()
  await groupCaptureStore.setPolicy("group", "drain-group", { enabled: true })

  const message = index => ({
    isGroup: true,
    message_type: "group",
    group_id: "drain-group",
    user_id: "drain-user",
    message_id: `drain-${index}`,
    time: 1700000000 + index,
    sender: { role: "member" },
    message: [{ type: "text", data: { text: `第 ${index} 条待落盘消息` } }],
  })
  for (let index = 0; index < 501; index += 1) assert.equal(groupCaptureStore.record(message(index)), true)
  const flushed = await groupCaptureStore.flush()
  assert.equal(flushed.written, 501, "one explicit flush must drain more than one bounded batch")
  assert.equal(groupCaptureStore.stats().pendingMessages, 0)
  assert.equal(Number((await sqliteClient.get("SELECT COUNT(*) AS count FROM group_memory_messages WHERE group_id='drain-group'"))?.count), 501)

  for (let index = 501; index < 1002; index += 1) assert.equal(groupCaptureStore.record(message(index)), true)
  await groupCaptureStore.stop({ flush: true })
  assert.equal(groupCaptureStore.stats().pendingMessages, 0, "stop must drain every pending batch")
  assert.equal(Number((await sqliteClient.get("SELECT COUNT(*) AS count FROM group_memory_messages WHERE group_id='drain-group'"))?.count), 1002)

  // 历史补录：协议只有 seq/count 游标，按日期补录用“最旧一条 message_id”向前翻页并逐页落盘。
  await groupCaptureStore.setPolicy("group", "backfill-group", { enabled: true })
  await configStore.update(config => { config.memory.groupCapture.historyBackfillMaxMessages = 2000 })
  const backfillTotal = 1250
  const backfillBase = Math.floor(Date.now() / 1000) - 6 * 3600
  const newestFirst = Array.from({ length: backfillTotal }, (_, index) => {
    const ordinal = backfillTotal - 1 - index
    return {
      message_id: `bf-${ordinal}`,
      user_id: "backfill-user",
      sender: { user_id: "backfill-user", role: "member" },
      time: backfillBase + ordinal,
      message: [{ type: "text", data: { text: `补录消息 ${ordinal}` } }],
    }
  })
  const pageCalls = []
  global.Bot.pickGroup = () => ({
    getChatHistory: async (cursor, count) => {
      pageCalls.push({ cursor, count })
      const anchor = cursor ? newestFirst.findIndex(row => row.message_id === String(cursor)) + 1 : 0
      return newestFirst.slice(anchor, anchor + count)
    },
  })
  const sinceAt = (backfillBase + 500) * 1000
  const backfill = await groupCaptureStore.backfillHistory("group", "backfill-group", { sinceAt })
  assert.equal(backfill.reachedSince, true, "date backfill must stop after crossing sinceAt")
  assert(pageCalls.length >= 4, "date backfill must page with the message cursor")
  assert.equal(groupCaptureStore.stats().pendingMessages, 0, "each backfill page must be drained to SQLite")
  assert.equal(Number((await sqliteClient.get("SELECT COUNT(*) AS count FROM group_memory_messages WHERE group_id='backfill-group'"))?.count), 750)
  assert.equal(
    Number((await sqliteClient.get("SELECT COUNT(*) AS count FROM group_memory_messages WHERE group_id='backfill-group' AND sent_at < ?", [sinceAt]))?.count),
    0,
    "messages older than sinceAt must not be saved",
  )

  // 起点游标与递进补录：指定消息 ID 从该处向前拉取；continueFromOldest 从已存最旧一条继续，
  // hasMore/nextCursor 提示还有更早历史，多次请求即可递进补齐大群历史。
  pageCalls.length = 0
  const fromCursor = await groupCaptureStore.backfillHistory("group", "backfill-group", { limit: 200, beforeMessageId: "bf-500" })
  assert.equal(pageCalls[0]?.cursor, "bf-500", "explicit start message must seed the page cursor")
  assert.equal(fromCursor.startedFrom, "bf-500")
  assert.equal(fromCursor.received, 200)
  assert.equal(fromCursor.nextCursor, "bf-300", "next cursor must be the oldest fetched message")
  assert.equal(fromCursor.hasMore, true, "full pages below the start cursor must report more history")
  assert.equal(Number((await sqliteClient.get("SELECT COUNT(*) AS count FROM group_memory_messages WHERE group_id='backfill-group'"))?.count), 950)
  pageCalls.length = 0
  const continued = await groupCaptureStore.backfillHistory("group", "backfill-group", { limit: 500, continueFromOldest: true })
  assert.equal(pageCalls[0]?.cursor, "bf-300", "continueFromOldest must seed the host cursor with the oldest stored message")
  assert.equal(continued.startedFrom, "bf-300", "continueFromOldest must resume from the oldest stored message")
  assert.equal(continued.hasMore, false, "exhausted history must clear hasMore")
  assert.equal(Number((await sqliteClient.get("SELECT COUNT(*) AS count FROM group_memory_messages WHERE group_id='backfill-group'"))?.count), 1250)

  // 大历史量：轮询只读取策略/进度，不扫描原始消息正文；原始消息默认倒序且支持正序，运行记录稳定倒序分页。
  await groupCaptureStore.setPolicy("group", "perf-group", { enabled: true })
  const perfStartDate = new Date()
  perfStartDate.setHours(0, 0, 0, 0)
  perfStartDate.setDate(perfStartDate.getDate() - 200)
  const perfStart = perfStartDate.getTime()
  const localDayAt = (base, offset) => {
    const date = new Date(base)
    date.setDate(date.getDate() + Number(offset || 0))
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }
  const nextLocalDay = value => localDayAt(value, 1)
  const perfOperations = Array.from({ length: 20000 }, (_, index) => {
    const day = Math.floor(index / 100)
    const sentAt = localDayAt(perfStart, day) + (index % 100) * 60000
    return {
      sql: `INSERT INTO group_memory_messages(
        id, group_id, message_id, sender_id, sender_name, sender_role, sent_at,
        text_content, segments_json, content_hash, is_command, expires_at
      ) VALUES(?, 'perf-group', ?, 'perf-user', '性能用户', 'member', ?, ?, '[]', ?, 0, 0)`,
      params: [`perf-row-${index}`, `perf-${String(index).padStart(5, "0")}`, sentAt, `性能消息 ${index}`, `hash-${index}`],
    }
  })
  for (let offset = 0; offset < perfOperations.length; offset += 1000) {
    await sqliteClient.transaction(perfOperations.slice(offset, offset + 1000))
  }
  const originalAll = sqliteClient.all.bind(sqliteClient)
  const lightPolicySql = []
  sqliteClient.all = async (...args) => {
    lightPolicySql.push(String(args[0] || ""))
    return originalAll(...args)
  }
  try {
    await groupCaptureStore.listPolicies({ includeMessageStats: false })
  } finally {
    sqliteClient.all = originalAll
  }
  assert(
    lightPolicySql.every(sql => !sql.includes("group_memory_messages")),
    "polling policy summaries must not scan the raw message table",
  )
  const perfPolicy = (await groupCaptureStore.listPolicies()).find(policy => policy.scopeId === "perf-group")
  assert.equal(perfPolicy?.messageCount, 20000)
  const rawPage = await groupCaptureStore.listMessagePage("group", "perf-group", { page: 2, pageSize: 50, order: "desc" })
  assert.equal(rawPage.total, 20000)
  assert.equal(rawPage.order, "desc")
  assert.equal(rawPage.items[0]?.messageId, "perf-19949", "raw message pages must be newest-first and stable")
  const rawAscendingPage = await groupCaptureStore.listMessagePage("group", "perf-group", { page: 2, pageSize: 50, order: "asc" })
  assert.equal(rawAscendingPage.order, "asc")
  assert.equal(rawAscendingPage.items[0]?.messageId, "perf-00050", "raw message pages must support oldest-first ordering")

  const perfWindowOperations = Array.from({ length: 120 }, (_, index) => {
    const windowStart = localDayAt(perfStart, index)
    return {
      sql: `INSERT INTO group_memory_extraction_jobs(
        id, group_id, window_start, window_end, content_hash, extractor_version,
        status, result_json, created_at, updated_at
      ) VALUES(?, 'perf-group', ?, ?, ?, 'group-memory-v4-daily', 'completed', '[]', ?, ?)`,
      params: [`perf-window-${String(index).padStart(3, "0")}`, windowStart, nextLocalDay(windowStart), `window-hash-${index}`, windowStart, windowStart],
    }
  })
  await sqliteClient.transaction(perfWindowOperations)
  const windowPage = await groupCaptureStore.listWindowPage("group", "perf-group", { page: 2, pageSize: 20 })
  assert.equal(windowPage.total, 120)
  assert.equal(windowPage.items.length, 20)
  assert.equal(windowPage.items[0]?.id, "perf-window-099", "window pages must be newest-first")

  // 点阵日历只返回按日摘要，并稳定区分五种主状态；pending/running 由 windowStatus
  // 作为附加任务态表达，不挤占“尚未提炼”的主色。
  await sqliteClient.transaction([
    {
      sql: "UPDATE group_memory_extraction_jobs SET status='completed', result_json=? WHERE id='perf-window-000'",
      params: [serializeExtractionResult({ items: [{ id: "calendar-memory", action: "added", scopeType: "user", ownerId: "perf-user", text: "形成一条记忆" }], modelCallCount: 1, messageCount: 100 })],
    },
    {
      sql: "UPDATE group_memory_extraction_jobs SET status='completed', result_json=? WHERE id='perf-window-001'",
      params: [serializeExtractionResult({ items: [], modelCallCount: 1, messageCount: 100 })],
    },
    { sql: "UPDATE group_memory_extraction_jobs SET status='failed' WHERE id='perf-window-002'", params: [] },
    { sql: "DELETE FROM group_memory_extraction_jobs WHERE id='perf-window-003'", params: [] },
    {
      sql: "UPDATE group_memory_extraction_jobs SET status='completed', result_json=? WHERE id='perf-window-004'",
      params: ['[{"action":"ignored","text":"旧数组忽略项"},{"action":"added","text":"旧数组记忆"}]'],
    },
    {
      sql: "UPDATE group_memory_extraction_jobs SET status='completed', result_json=? WHERE id='perf-window-005'",
      params: ['{"items":[{"action":"ignored","text":"旧对象忽略项"},{"action":"added","text":"旧对象记忆"}]}'],
    },
  ])
  const localDayKey = value => {
    const date = new Date(value)
    const pad = number => String(number).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  const calendar = await groupCaptureStore.getDailyCalendar("group", "perf-group", {
    fromDay: localDayKey(perfStart),
    toDay: localDayKey(localDayAt(perfStart, 3)),
  })
  assert.equal(calendar.fromDay, localDayKey(perfStart))
  assert.equal(calendar.toDay, localDayKey(localDayAt(perfStart, 3)))
  assert.equal(Object.values(calendar.counts).reduce((sum, value) => sum + value, 0), calendar.dayCount)
  assert.deepEqual(calendar.items.map(item => item.status), ["memory", "no_result", "failed", "unprocessed"])
  assert.equal(calendar.items[0].memoryResultCount, 1)
  assert.equal(calendar.items[0].messageCount, 100)
  assert(calendar.items[0].updatedAt > 0, "daily summaries must expose the task update time for detail-cache invalidation")
  assert(calendar.items[0].estimatedInputTokens > 0)
  assert.equal(calendar.items[2].windowStatus, "failed")
  assert.equal(calendar.items[3].windowId, "")
  assert.equal(calendar.items[3].canReextract, true)
  const legacyResultDetail = await groupCaptureStore.getWindowDetail("group", "perf-group", "perf-window-000")
  assert.equal(legacyResultDetail.window.result[0]?.targetName, "性能用户", "old extraction results should resolve the target's group card from source messages")
  const compactResultDetail = await groupCaptureStore.getWindowDetail("group", "perf-group", "perf-window-000", { includeMessages: false })
  assert.equal(compactResultDetail.messages.length, 0, "extraction result lookup should support omitting duplicate raw messages")
  assert.equal(compactResultDetail.window.result[0]?.targetName, "性能用户")
  const legacyCalendar = await groupCaptureStore.getDailyCalendar("group", "perf-group", {
    fromDay: localDayKey(localDayAt(perfStart, 4)),
    toDay: localDayKey(localDayAt(perfStart, 5)),
  })
  assert.deepEqual(legacyCalendar.items.map(item => item.status), ["memory", "memory"], "legacy result formats must retain formed-memory status")
  assert.equal(legacyCalendar.items[0].memoryResultCount, 1, "legacy top-level result arrays must count meaningful items in SQLite")
  assert.equal(legacyCalendar.items[0].ignoredResultCount, 1)
  assert.equal(legacyCalendar.items[1].memoryResultCount, 1, "legacy result objects must count items in SQLite")
  assert.equal(legacyCalendar.items[1].ignoredResultCount, 1)
  await assert.rejects(
    groupCaptureStore.getDailyCalendar("group", "perf-group", { fromDay: "2026-02-31", toDay: localDayKey(Date.now()) }),
    /不是有效的自然日/,
  )
  await assert.rejects(
    groupCaptureStore.getDailyCalendar("group", "perf-group", { fromDay: localDayKey(localDayAt(perfStart, 2)), toDay: localDayKey(perfStart) }),
    /fromDay 不能晚于 toDay/,
  )
  const emptyDay = new Date(perfStart)
  emptyDay.setDate(emptyDay.getDate() + 200)
  const emptyCalendar = await groupCaptureStore.getDailyCalendar("group", "perf-group", {
    fromDay: localDayKey(emptyDay),
    toDay: localDayKey(emptyDay),
  })
  assert.equal(emptyCalendar.items[0]?.status, "empty")
  assert.equal(emptyCalendar.items[0]?.messageCount, 0)
  const oversizedCalendarStart = new Date()
  oversizedCalendarStart.setHours(0, 0, 0, 0)
  oversizedCalendarStart.setDate(oversizedCalendarStart.getDate() - 371)
  await assert.rejects(
    groupCaptureStore.getDailyCalendar("group", "perf-group", {
      fromDay: localDayKey(oversizedCalendarStart),
      toDay: localDayKey(Date.now()),
    }),
    /最多查看 371 天/,
  )

  // 精准窗口选择与日期范围共用同一重入队链路：已完成/失败/未创建会入队，
  // pending/running 不重复入队，原文已过期的窗口明确跳过。
  await configStore.update(config => { config.memory.groupCapture.consolidation.enabled = false })
  const selectedStarts = Array.from({ length: 5 }, (_, index) => localDayAt(perfStart, index))
  await sqliteClient.run(
    "UPDATE group_memory_extraction_jobs SET status='failed', attempt_count=2, error_message='expected failure', completed_at=1 WHERE id='perf-window-001'",
  )
  await sqliteClient.run(
    "UPDATE group_memory_extraction_jobs SET status='pending', attempt_count=1 WHERE id='perf-window-002'",
  )
  await sqliteClient.run("DELETE FROM group_memory_extraction_jobs WHERE id='perf-window-003'")
  await sqliteClient.run(
    "DELETE FROM group_memory_messages WHERE group_id='perf-group' AND sent_at>=? AND sent_at<?",
    [selectedStarts[4], nextLocalDay(selectedStarts[4])],
  )
  const selectedQueue = await groupCaptureStore.queueWindowStarts("group", "perf-group", [
    ...selectedStarts,
    selectedStarts[0],
  ])
  assert.deepEqual(
    {
      requested: selectedQueue.requested,
      queued: selectedQueue.queued,
      alreadyQueued: selectedQueue.alreadyQueued,
      skippedEmpty: selectedQueue.skippedEmpty,
    },
    { requested: 5, queued: 3, alreadyQueued: 1, skippedEmpty: 1 },
  )
  assert.equal(selectedQueue.messageCount, 300)
  assert(selectedQueue.estimatedInputTokens > 0)
  assert(selectedQueue.estimatedModelCalls > 0)
  assert.deepEqual(selectedQueue.queuedWindowStarts, [selectedStarts[0], selectedStarts[1], selectedStarts[3]])
  assert.deepEqual(selectedQueue.alreadyQueuedWindowStarts, [selectedStarts[2]])
  assert.deepEqual(selectedQueue.skippedEmptyWindowStarts, [selectedStarts[4]])
  const selectedRows = await sqliteClient.all(
    `SELECT window_start, status, attempt_count, next_attempt_at, error_message, result_json, completed_at, needs_reextract, content_hash
     FROM group_memory_extraction_jobs
     WHERE group_id='perf-group' AND window_start IN (?, ?, ?, ?)
     ORDER BY window_start ASC`,
    selectedStarts.slice(0, 4),
  )
  assert.equal(selectedRows.length, 4)
  for (const row of selectedRows) {
    assert.equal(row.status, "pending")
    if (row.window_start === selectedStarts[2]) continue
    assert.equal(row.attempt_count, 0)
    assert.equal(row.next_attempt_at, 0)
    assert.equal(row.error_message, "")
    assert.equal(row.result_json, "[]")
    assert.equal(row.completed_at, 0)
    assert.equal(row.needs_reextract, 0)
  }
  assert.notEqual(selectedRows[0].content_hash, "window-hash-0", "selected windows must hash the current raw messages")
  const repeatedQueue = await groupCaptureStore.queueWindowStarts("group", "perf-group", selectedStarts)
  assert.equal(repeatedQueue.queued, 0)
  assert.equal(repeatedQueue.alreadyQueued, 4)
  assert.equal(repeatedQueue.skippedEmpty, 1)
  await assert.rejects(
    groupCaptureStore.queueWindowStarts("group", "perf-group", Array.from({ length: 101 }, (_, index) => localDayAt(perfStart, index))),
    /最多选择 100 个/,
  )
  await assert.rejects(
    groupCaptureStore.queueWindowStarts("group", "perf-group", [perfStart + 1]),
    /自然日开始时间/,
  )

  await groupCaptureStore.setPolicy("group", "retry-group", { enabled: true })
  const sourceRows = [{
    id: "retry-event",
    message_id: "retry-message",
    sender_id: "retry-user",
    sender_role: "member",
    sent_at: Date.now(),
  }]
  const candidates = [{
    operation: "add",
    scope: "user",
    subjectId: "retry-user",
    speakerId: "retry-user",
    factKey: "preference.coffee",
    factValue: "hand_brew",
    text: "用户喜欢手冲咖啡",
    confidence: 0.9,
    evidenceMessageIds: ["retry-message"],
  }]
  const retryWindow = { id: "retry-window", group_id: "retry-group" }
  await groupCaptureStore.applyCandidates(retryWindow, sourceRows, candidates)
  const first = await sqliteClient.get("SELECT id, confidence FROM memory_items WHERE owner_id='retry-user' AND fact_key='preference.coffee'")
  await groupCaptureStore.applyCandidates(retryWindow, sourceRows, candidates)
  const second = await sqliteClient.get("SELECT id, confidence FROM memory_items WHERE owner_id='retry-user' AND fact_key='preference.coffee'")
  assert.deepEqual(second, first, "retrying the same window evidence must not reinforce the memory twice")
  assert.equal(Number((await sqliteClient.get("SELECT COUNT(*) AS count FROM memory_items WHERE owner_id='retry-user' AND fact_key='preference.coffee'"))?.count), 1)
  assert.equal(Number((await sqliteClient.get("SELECT COUNT(*) AS count FROM memory_evidence WHERE memory_id=?", [first.id]))?.count), 1)

  const memberRows = [
    { id: "member-list-message-a", messageId: "member-list-message-a", userId: "member-list-a", name: "记忆较多成员" },
    { id: "member-list-message-b", messageId: "member-list-message-b", userId: "member-list-b", name: "记忆较少成员" },
    { id: "member-list-message-c", messageId: "member-list-message-c", userId: "member-list-c", name: "没有记忆成员" },
  ]
  await sqliteClient.transaction(memberRows.map(row => ({
    sql: `INSERT INTO group_memory_messages(
      id, group_id, message_id, sender_id, sender_name, sender_role, sent_at,
      text_content, segments_json, content_hash, is_command, expires_at
    ) VALUES(?, 'member-list-group', ?, ?, ?, 'member', ?, ?, '[]', ?, 0, 0)`,
    params: [row.id, row.messageId, row.userId, row.name, Date.now(), `${row.name} 的群聊消息`, row.id],
  })))
  await groupCaptureStore.applyCandidates(
    { id: "member-list-window", group_id: "member-list-group" },
    memberRows.map(row => ({ id: row.id, message_id: row.messageId, sender_id: row.userId, sender_name: row.name, sender_role: "member" })),
    [
      { scope: "user_group", subjectId: "member-list-a", speakerId: "member-list-a", factKey: "preference.coffee", factValue: "hand_brew", text: "用户喜欢手冲咖啡", confidence: 0.9, evidenceMessageIds: ["member-list-message-a"] },
      { scope: "user_group", subjectId: "member-list-a", speakerId: "member-list-a", factKey: "preference.tea", factValue: "oolong", text: "用户喜欢乌龙茶", confidence: 0.9, evidenceMessageIds: ["member-list-message-a"] },
      { scope: "user_group", subjectId: "member-list-b", speakerId: "member-list-b", factKey: "preference.reading", factValue: "fiction", text: "用户喜欢读小说", confidence: 0.9, evidenceMessageIds: ["member-list-message-b"] },
    ],
  )
  const memberWorkspace = await sqliteMemoryStore.getGroupWorkspace("member-list-group")
  assert.deepEqual(
    memberWorkspace.members.map(member => ({ userId: member.userId, memoryCount: member.memoryCount })),
    [{ userId: "member-list-a", memoryCount: 2 }, { userId: "member-list-b", memoryCount: 1 }],
    "group member workspace should hide members without memory blocks and order by memory count descending",
  )

  await configStore.update(config => { config.memory.groupCapture.consolidation.enabled = true })
  await groupCaptureStore.setPolicy("group", "manual-run-group", { enabled: true })
  const manualWindowStart = Date.now() - 60000
  const manualWindowEnd = Date.now() + 60000
  await sqliteClient.transaction([
    {
      sql: `INSERT INTO group_memory_messages(
        id, group_id, message_id, sender_id, sender_name, sender_role, sent_at,
        text_content, segments_json, content_hash, is_command, expires_at
      ) VALUES('manual-run-message', 'manual-run-group', 'manual-run-message', 'manual-run-user', '手动执行用户', 'member', ?, '可用于手动提炼的消息', '[]', 'manual-run-hash', 0, 0)`,
      params: [manualWindowStart + 1],
    },
    {
      sql: `INSERT INTO group_memory_extraction_jobs(
        id, group_id, window_start, window_end, content_hash, extractor_version,
        status, attempt_count, next_attempt_at, error_message, result_json, created_at, updated_at
      ) VALUES('manual-run-window', 'manual-run-group', ?, ?, 'manual-run-hash', 'group-memory-v4-daily', 'failed', 3, ?, '上次失败', '[{"text":"旧结果"}]', ?, ?)`,
      params: [manualWindowStart, manualWindowEnd, Date.now() + 600000, manualWindowStart, manualWindowStart],
    },
  ])
  const originalProcessWindow = groupCaptureStore.processWindow
  groupCaptureStore.processWindow = async () => {}
  try {
    const manuallyQueued = await groupCaptureStore.runWindow("group", "manual-run-group", "manual-run-window", { retry: true })
    assert.equal(manuallyQueued.queued, true)
    assert.equal(manuallyQueued.retried, true)
    const manuallyQueuedRow = await sqliteClient.get(
      "SELECT status, attempt_count, next_attempt_at, error_message, result_json FROM group_memory_extraction_jobs WHERE id='manual-run-window'",
    )
    assert.deepEqual(manuallyQueuedRow, { status: "pending", attempt_count: 0, next_attempt_at: 0, error_message: "", result_json: "[]" }, "manual retry must reset the failed job before background execution")
    await new Promise(resolve => setTimeout(resolve, 10))
    await sqliteClient.run("UPDATE group_memory_extraction_jobs SET status='completed', needs_reextract=0 WHERE id='manual-run-window'")
    await assert.rejects(
      groupCaptureStore.runWindow("group", "manual-run-group", "manual-run-window", { retry: true }),
      /只有等待处理的任务可以立即执行/,
      "retry=true must not force a paid rerun of an already healthy completed window",
    )
  } finally {
    groupCaptureStore.processWindow = originalProcessWindow
    await configStore.update(config => { config.memory.groupCapture.consolidation.enabled = false })
  }

  await assert.rejects(
    sqliteMemoryStore.addFact({ user_id: "explicit-sensitive", isGroup: false }, "请记住手机号 13812345678", { source: "explicit-user" }),
    /保护隐私/,
  )
  const sensitiveRows = [
    { id: "sensitive-phone", message_id: "sensitive-phone", sender_id: "sensitive-user", sender_role: "member", sent_at: Date.now() },
    { id: "sensitive-otp", message_id: "sensitive-otp", sender_id: "sensitive-user", sender_role: "member", sent_at: Date.now() },
    { id: "sensitive-address", message_id: "sensitive-address", sender_id: "sensitive-user", sender_role: "member", sent_at: Date.now() },
  ]
  const sensitiveCandidates = [
    { scope: "user", subjectId: "sensitive-user", speakerId: "sensitive-user", factKey: "profile.phone", factValue: "13812345678", text: "用户手机号为 13812345678", confidence: 0.99, evidenceMessageIds: ["sensitive-phone"] },
    { scope: "user", subjectId: "sensitive-user", speakerId: "sensitive-user", factKey: "profile.otp", factValue: "731926", text: "用户验证码是 731926", confidence: 0.99, evidenceMessageIds: ["sensitive-otp"] },
    { scope: "user", subjectId: "sensitive-user", speakerId: "sensitive-user", factKey: "profile.address", factValue: "北京市朝阳区建国路88号", text: "用户住在北京市朝阳区建国路88号", confidence: 0.99, evidenceMessageIds: ["sensitive-address"] },
  ]
  assert.deepEqual(await groupCaptureStore.applyCandidates({ id: "sensitive-window", group_id: "retry-group" }, sensitiveRows, sensitiveCandidates), [])
  assert.equal(Number((await sqliteClient.get("SELECT COUNT(*) AS count FROM memory_items WHERE owner_id='sensitive-user'"))?.count), 0)

  console.log("ok memory-p1")
} finally {
  await groupCaptureStore?.stop({ flush: true }).catch(() => {})
  await sqliteClient?.close().catch(() => {})
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}
