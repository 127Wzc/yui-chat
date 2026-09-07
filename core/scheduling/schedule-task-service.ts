import path from "node:path"
import { dataDir } from "../../config/store.js"
import { AtomicJsonRepository } from "../storage/atomic-json-repository.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { convertCQCodes } from "../message/cq-code.js"
import { estimateCronIntervalMinutes, matchesCronExpression } from "./cron.js"

type UnknownRecord = Record<string, unknown>

interface ScheduleEvent extends UnknownRecord {
  isGroup?: boolean
  group_id?: unknown
  user_id?: unknown
  sender?: UnknownRecord
}

interface TaskRow extends UnknownRecord {
  id?: unknown
  scopeType?: unknown
  groupId?: unknown
  userId?: unknown
  content?: unknown
  runAtMs?: unknown
  runAt?: unknown
  createdAt?: unknown
  cron?: unknown
  lastRunMinute?: unknown
  failedAt?: unknown
  attempts?: unknown
  nextAttemptAtMs?: unknown
  nextAttemptAt?: unknown
  lastAttemptAt?: unknown
  lastDeliveredAt?: unknown
  lastFailedAt?: unknown
}

interface TaskStore {
  oneTime: TaskRow[]
  cron: TaskRow[]
}

interface ScheduleConfig {
  enabled: boolean
  maxPerUser: number
  cronMaxPerUser: number
  maxDelayMinutes: number
  cronMinIntervalMinutes: number
  tickMs: number
}

interface ScheduleRepository {
  load(): Promise<TaskStore>
  update(mutator: (current: TaskStore) => TaskStore | void | Promise<TaskStore | void>): Promise<TaskStore>
}

interface SendTarget {
  sendMsg?: (payload: unknown) => Promise<unknown> | unknown
}

interface ScheduleBot {
  pickGroup?: (id: number, noCache?: boolean) => Promise<SendTarget | null> | SendTarget | null
  pickUser?: (id: number, noCache?: boolean) => Promise<SendTarget | null> | SendTarget | null
  pickFriend?: (id: number, noCache?: boolean) => Promise<SendTarget | null> | SendTarget | null
}

interface ScheduleServiceOptions {
  repository?: ScheduleRepository
  sender?: (row: TaskRow, config: unknown) => Promise<void>
  clock?: () => number
}

interface FormatScheduleTaskListOptions {
  title?: string
  emptyText?: string
  showOwner?: boolean
  footer?: string
}

const taskFile = path.join(dataDir, "scheduled-tasks.json")
const deliveryMaxAttempts = 3
const deliveryRetryDelaysMs = [60_000, 5 * 60_000]

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

function nowMs(): number {
  return Date.now()
}

function userId(e: ScheduleEvent = {}): string {
  return text(e.user_id || e.sender?.user_id)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function eventUserAliases(e: ScheduleEvent = {}): string[] {
  const sender = record(e.sender)
  return [...new Set([
    sender.card,
    sender.nickname,
    sender.name,
    e.card,
    e.nickname,
  ].map(value => text(value).trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
}

/**
 * 模型只需保存“要提醒什么”。收件人由任务作用域保证，不应再次出现在正文中。
 * 此处同时兼容清理既有任务中的“提醒昵称(QQ) 正文”格式。
 */
function normalizeReminderContent(value: unknown, options: { userId?: unknown; aliases?: string[] } = {}): string {
  const original = text(value).trim().slice(0, 300)
  let content = original.replace(/^定时提醒\s*[:：]?\s*/u, "")
  content = content.replace(/^提醒(?:一下)?\s*(?:我|自己|本人)\s*[:：,，]?\s*/u, "")

  const uid = text(options.userId).trim()
  if (uid) {
    const escapedUid = escapeRegExp(uid)
    content = content.replace(new RegExp(`^提醒(?:一下)?\\s*.{0,40}?[（(]\\s*${escapedUid}\\s*[)）]\\s*[:：,，]?\\s*`, "u"), "")
    content = content.replace(new RegExp(`^提醒(?:一下)?\\s*@?${escapedUid}\\s*[:：,，]?\\s*`, "u"), "")
  }

  for (const alias of options.aliases || []) {
    const escapedAlias = escapeRegExp(alias)
    const uidSuffix = uid ? `(?:\\s*[（(]\\s*${escapeRegExp(uid)}\\s*[)）])?` : ""
    content = content.replace(new RegExp(`^提醒(?:一下)?\\s*@?${escapedAlias}${uidSuffix}\\s*[:：,，]?\\s*`, "u"), "")
  }
  return content.trim() || original
}

function scopeFromEvent(e: ScheduleEvent = {}): { type: "group" | "private"; groupId: string; userId: string } {
  return {
    type: e.isGroup ? "group" : "private",
    groupId: e.isGroup ? text(e.group_id) : "",
    userId: userId(e),
  }
}

function shortId(prefix = "task"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function scheduleConfig(config: unknown = {}): ScheduleConfig {
  const cfg = record(record(record(config).tools).builtin)
  const schedule = record(cfg.scheduleTask)
  return {
    enabled: schedule.enabled !== false,
    maxPerUser: Math.max(1, Math.min(numberValue(schedule.maxPerUser, 1) || 1, 20)),
    cronMaxPerUser: Math.max(1, Math.min(numberValue(schedule.cronMaxPerUser, 1) || 1, 20)),
    maxDelayMinutes: Math.max(1, Math.min(numberValue(schedule.maxDelayMinutes, 43200) || 43200, 43200)),
    cronMinIntervalMinutes: Math.max(1, Math.min(numberValue(schedule.cronMinIntervalMinutes, 60) || 60, 1440)),
    tickMs: Math.max(10000, Math.min(numberValue(schedule.tickMs, 60000) || 60000, 300000)),
  }
}

function normalizeStore(store: unknown = {}): TaskStore {
  if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error("定时任务文件必须是 JSON 对象")
  const value = store as UnknownRecord
  return {
    oneTime: Array.isArray(value.oneTime) ? value.oneTime.filter(item => item && typeof item === "object" && !Array.isArray(item)) as TaskRow[] : [],
    cron: Array.isArray(value.cron) ? value.cron.filter(item => item && typeof item === "object" && !Array.isArray(item)) as TaskRow[] : [],
  }
}

const taskRepository: ScheduleRepository = new AtomicJsonRepository<TaskStore>({
  file: taskFile,
  defaultValue: normalizeStore(),
  normalize: normalizeStore,
  serialize: value => JSON.stringify(value, null, 2),
  onReadError(error) {
    hostRuntime.logger?.warn?.("[yui-chat] 读取定时任务失败，损坏文件已隔离并使用空任务列表", error)
  },
})

function matchesCron(task: TaskRow, date = new Date()): boolean {
  return matchesCronExpression(task.cron, date)
}

function visibleTask(row: TaskRow): UnknownRecord {
  const attempts = Math.max(0, numberValue(row.attempts, 0))
  const status = row.failedAt ? "failed" : attempts > 0 ? "retrying" : "pending"
  return {
    id: row.id,
    scopeType: row.scopeType,
    groupId: row.groupId,
    userId: row.userId,
    content: normalizeReminderContent(row.content, { userId: row.userId }),
    runAt: row.runAt,
    cron: row.cron,
    createdAt: row.createdAt,
    status,
    attempts,
    maxAttempts: deliveryMaxAttempts,
    nextAttemptAt: row.nextAttemptAt || "",
    failedAt: row.failedAt || "",
  }
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0")
}

function formatLocalDate(value: unknown): string {
  const date = new Date(text(value))
  if (!Number.isFinite(date.getTime())) return text(value) || "时间未知"
  const now = new Date()
  const year = date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()}年`
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
}

function formatCron(expression: unknown): string {
  const raw = text(expression).trim()
  const fields = raw.split(/\s+/)
  if (fields.length !== 5) return `循环计划（${raw || "时间未知"}）`
  const [minute, hour, day, month, weekday] = fields
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== "*") return `循环计划（${raw}）`
  const time = `${twoDigits(Number(hour))}:${twoDigits(Number(minute))}`
  if (day === "*" && weekday === "*") return `每天 ${time}`
  if (day === "*" && weekday === "1-5") return `工作日 ${time}`
  if (day === "*" && /^[0-7]$/.test(weekday)) {
    const names = ["日", "一", "二", "三", "四", "五", "六", "日"]
    return `每周${names[Number(weekday)]} ${time}`
  }
  if (/^\d+$/.test(day) && weekday === "*") return `每月${Number(day)}日 ${time}`
  return `循环计划（${raw}）`
}

function taskRows(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[]
    : []
}

export function formatScheduleTaskList(
  rows: UnknownRecord = {},
  options: FormatScheduleTaskListOptions = {},
): string {
  const onceRows = taskRows(rows.oneTime).sort((left, right) => Date.parse(text(left.runAt)) - Date.parse(text(right.runAt)))
  const cronRows = taskRows(rows.cron)
  const tasks = [
    ...onceRows.map(row => ({ row, schedule: `⏰ ${formatLocalDate(row.runAt)}` })),
    ...cronRows.map(row => ({ row, schedule: `🔁 ${formatCron(row.cron)}` })),
  ]
  if (!tasks.length) return options.emptyText || "你目前没有待执行的定时任务。"

  const lines = [`${options.title || "你的定时任务"}（${tasks.length} 个）：`]
  tasks.forEach(({ row, schedule }, index) => {
    let delivery = ""
    if (row.status === "retrying") delivery = ` · 正在重试 ${Number(row.attempts) || 0}/${Number(row.maxAttempts) || deliveryMaxAttempts}`
    if (row.status === "failed") delivery = " · 发送失败，请取消后重新创建"
    const owner = options.showOwner
      ? ` · ${text(row.scopeType) === "group" ? `群 ${text(row.groupId)} · 用户 ${text(row.userId)}` : `私聊用户 ${text(row.userId)}`}`
      : ""
    lines.push(`${index + 1}. ${schedule}${delivery}${owner}`)
    lines.push(`   ${text(row.content) || "（无提醒内容）"}`)
    lines.push(`   编号：${text(row.id)}`)
  })
  lines.push("", options.footer || "取消时告诉我任务编号即可。")
  return lines.join("\n")
}

function oneTimeDueAt(row: TaskRow): number {
  if (row.failedAt) return Number.POSITIVE_INFINITY
  return numberValue(row.nextAttemptAtMs || row.runAtMs, 0)
}

function markOneTimeFailure(row: TaskRow, currentTime: number): void {
  const attempts = Math.max(0, numberValue(row.attempts, 0)) + 1
  const failedAt = new Date(currentTime).toISOString()
  row.attempts = attempts
  row.lastAttemptAt = failedAt
  if (attempts >= deliveryMaxAttempts) {
    row.failedAt = failedAt
    delete row.nextAttemptAt
    delete row.nextAttemptAtMs
    return
  }
  const retryAtMs = currentTime + (deliveryRetryDelaysMs[attempts - 1] || deliveryRetryDelaysMs.at(-1) || 0)
  row.nextAttemptAtMs = retryAtMs
  row.nextAttemptAt = new Date(retryAtMs).toISOString()
}

/** 定时任务的宿主投递适配器；任务存储和 cron 状态机不直接依赖 Yunzai 全局对象。 */
export async function sendTaskMessage(row: TaskRow, config: unknown = {}): Promise<void> {
  const bot = hostRuntime.bot as unknown as ScheduleBot | undefined
  const response = record(record(config).response)
  const reminder = normalizeReminderContent(row.content, { userId: row.userId })
  const content = convertCQCodes(reminder, { removeUnsupported: response.removeCQCode !== false })
  if (row.scopeType === "group") {
    const group = await bot?.pickGroup?.(Number(row.groupId), true)
    if (!group?.sendMsg) throw new Error(`无法获取群 ${text(row.groupId)}`)
    const at = typeof hostRuntime.segment?.at === "function" ? hostRuntime.segment.at(Number(row.userId)) : `@${text(row.userId)}`
    await group.sendMsg([at, " 到时间啦～\n", ...(Array.isArray(content) ? content : [content])])
    return
  }
  const user = await bot?.pickUser?.(Number(row.userId), true) || await bot?.pickFriend?.(Number(row.userId), true)
  if (!user?.sendMsg) throw new Error(`无法获取用户 ${text(row.userId)}`)
  await user.sendMsg(["到时间啦～\n", ...(Array.isArray(content) ? content : [content])])
}

export class ScheduleTaskService {
  timer: ReturnType<typeof setInterval> | null = null
  config: unknown = null
  store: TaskStore = normalizeStore()
  loaded = false
  running = false
  private readonly repository: ScheduleRepository
  private readonly sender: (row: TaskRow, config: unknown) => Promise<void>
  private readonly clock: () => number

  constructor(opts: ScheduleServiceOptions = {}) {
    this.repository = opts.repository || taskRepository
    this.sender = opts.sender || sendTaskMessage
    this.clock = opts.clock || nowMs
  }

  async load(): Promise<TaskStore> {
    if (this.loaded) return this.store
    this.store = await this.repository.load()
    this.loaded = true
    return this.store
  }

  async updateStore(mutator: (current: TaskStore) => TaskStore | void | Promise<TaskStore | void>): Promise<TaskStore> {
    this.store = await this.repository.update(mutator)
    this.loaded = true
    return this.store
  }

  start(config: unknown = {}): UnknownRecord {
    this.config = config
    const cfg = scheduleConfig(config)
    if (!cfg.enabled) {
      this.stop()
      return { enabled: false, tasks: this.store.oneTime.length, cron: this.store.cron.length }
    }
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      this.tick().catch(error => hostRuntime.logger?.warn?.("[yui-chat] 定时任务执行失败", error))
    }, cfg.tickMs)
    this.timer.unref?.()
    this.tick().catch(error => hostRuntime.logger?.warn?.("[yui-chat] 定时任务启动检查失败", error))
    return { enabled: true, intervalMs: cfg.tickMs, tasks: this.store.oneTime.length, cron: this.store.cron.length }
  }

  stop(): UnknownRecord {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return this.stats()
  }

  stats(): UnknownRecord {
    return {
      enabled: Boolean(this.timer),
      oneTime: this.store.oneTime.length,
      cron: this.store.cron.length,
    }
  }

  async tick(date = new Date()): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.load()
      const currentTime = date.getTime()
      const due = this.store.oneTime.filter(row => oneTimeDueAt(row) <= currentTime)
      for (const row of due) {
        const delivered = await this.deliver(row)
        await this.updateStore(store => {
          const index = store.oneTime.findIndex(item => item.id === row.id)
          if (index < 0) return
          if (delivered) store.oneTime.splice(index, 1)
          else markOneTimeFailure(store.oneTime[index], currentTime)
        })
      }

      const minuteKey = date.toISOString().slice(0, 16)
      const cronDue = this.store.cron.filter(row => text(row.lastRunMinute) !== minuteKey && matchesCron(row, date))
      for (const row of cronDue) {
        const delivered = await this.deliver(row)
        await this.updateStore(store => {
          const current = store.cron.find(item => item.id === row.id)
          if (!current) return
          current.lastRunMinute = minuteKey
          const attemptedAt = date.toISOString()
          if (delivered) current.lastDeliveredAt = attemptedAt
          else current.lastFailedAt = attemptedAt
        })
      }
    } finally {
      this.running = false
    }
  }

  async deliver(row: TaskRow): Promise<boolean> {
    try {
      await this.sender(row, this.config || {})
      hostRuntime.logger?.mark?.(`[yui-chat] 已发送定时提醒 ${text(row.id)}`)
      return true
    } catch (error) {
      hostRuntime.logger?.warn?.(`[yui-chat] 定时提醒发送失败 ${text(row.id)}`, error)
      return false
    }
  }

  async addOneTime(e: ScheduleEvent = {}, args: UnknownRecord = {}, config: unknown = this.config || {}): Promise<string> {
    await this.load()
    const cfg = scheduleConfig(config)
    if (!cfg.enabled) return "定时任务未启用。"
    const scope = scopeFromEvent(e)
    const content = normalizeReminderContent(args.content, { userId: scope.userId, aliases: eventUserAliases(e) })
    if (!content) return "缺少提醒内容。"
    const requestedDelay = Number(args.delayMinutes)
    if (!Number.isFinite(requestedDelay) || requestedDelay <= 0) return "delayMinutes 必须是正数。"
    const delayMinutes = Math.min(requestedDelay, cfg.maxDelayMinutes)
    const createdAtMs = this.clock()
    const runAtMs = createdAtMs + delayMinutes * 60 * 1000
    const row: TaskRow = {
      id: shortId("once"),
      scopeType: scope.type,
      groupId: scope.groupId,
      userId: scope.userId,
      content,
      runAtMs,
      runAt: new Date(runAtMs).toISOString(),
      createdAt: new Date(createdAtMs).toISOString(),
    }
    let result = ""
    await this.updateStore(store => {
      const count = store.oneTime.filter(item => text(item.userId) === scope.userId).length
      if (count >= cfg.maxPerUser) {
        result = `每个用户最多保留 ${cfg.maxPerUser} 个一次性定时任务。`
        return
      }
      store.oneTime.push(row)
      result = `好～已经记下了。\n${formatLocalDate(row.runAt)}提醒你：${content}\n任务编号：${text(row.id)}`
    })
    return result
  }

  async addCron(e: ScheduleEvent = {}, args: UnknownRecord = {}, config: unknown = this.config || {}): Promise<string> {
    await this.load()
    const cfg = scheduleConfig(config)
    if (!cfg.enabled) return "定时任务未启用。"
    const scope = scopeFromEvent(e)
    const content = normalizeReminderContent(args.content, { userId: scope.userId, aliases: eventUserAliases(e) })
    const cron = text(args.cron).trim()
    if (!content) return "缺少提醒内容。"
    let interval: number
    try {
      interval = estimateCronIntervalMinutes(cron)
    } catch (error) {
      return `cron 表达式无效：${text(record(error).message || error)}`
    }
    if (interval < cfg.cronMinIntervalMinutes) {
      return `cron 间隔过短：当前估算 ${interval} 分钟，最小允许 ${cfg.cronMinIntervalMinutes} 分钟。`
    }
    const createdAtMs = this.clock()
    const row: TaskRow = {
      id: shortId("cron"),
      scopeType: scope.type,
      groupId: scope.groupId,
      userId: scope.userId,
      content,
      cron,
      createdAt: new Date(createdAtMs).toISOString(),
      lastRunMinute: "",
    }
    let result = ""
    await this.updateStore(store => {
      const count = store.cron.filter(item => text(item.userId) === scope.userId).length
      if (count >= cfg.cronMaxPerUser) {
        result = `每个用户最多保留 ${cfg.cronMaxPerUser} 个循环定时任务。`
        return
      }
      store.cron.push(row)
      result = `好～已经记下了。\n${formatCron(cron)}提醒你：${content}\n任务编号：${text(row.id)}`
    })
    return result
  }

  async list(e: ScheduleEvent = {}, type: unknown = "all"): Promise<{ oneTime: UnknownRecord[]; cron: UnknownRecord[] }> {
    await this.load()
    const uid = userId(e)
    const typeText = text(type)
    const includeOnce = typeText === "all" || typeText === "once"
    const includeCron = typeText === "all" || typeText === "cron"
    return {
      oneTime: includeOnce ? this.store.oneTime.filter(row => text(row.userId) === uid).map(visibleTask) : [],
      cron: includeCron ? this.store.cron.filter(row => text(row.userId) === uid).map(visibleTask) : [],
    }
  }

  async listAll(type: unknown = "all"): Promise<{ oneTime: UnknownRecord[]; cron: UnknownRecord[] }> {
    await this.load()
    const typeText = text(type)
    const includeOnce = typeText === "all" || typeText === "once"
    const includeCron = typeText === "all" || typeText === "cron"
    return {
      oneTime: includeOnce ? this.store.oneTime.map(visibleTask) : [],
      cron: includeCron ? this.store.cron.map(visibleTask) : [],
    }
  }

  async cancel(e: ScheduleEvent = {}, id: unknown = ""): Promise<number> {
    await this.load()
    const uid = userId(e)
    const targetId = text(id)
    let removed = 0
    await this.updateStore(store => {
      const before = store.oneTime.length + store.cron.length
      store.oneTime = store.oneTime.filter(row => !(text(row.id) === targetId && text(row.userId) === uid))
      store.cron = store.cron.filter(row => !(text(row.id) === targetId && text(row.userId) === uid))
      removed = before - store.oneTime.length - store.cron.length
    })
    return removed
  }
}

export const scheduleTaskService = new ScheduleTaskService()
