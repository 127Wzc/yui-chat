import { configStore } from "../../config/store.js"
import { chatService } from "../chat/chat-service.js"
import { isEmptyResponse, normalizeResponseText } from "../chat/response-pipeline.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import type { UnknownRecord } from "../message/types.js"

const fallbackGreetings = [
  "有人想聊点什么吗？",
  "我在，想找我聊天也可以。",
  "今天群里有点安静，要不要聊两句？",
  "路过冒个泡，有事可以叫我。",
  "我来打个招呼，大家今天怎么样？",
]

interface GreetingTarget {
  groupId: string
  label: string
  send(payload: unknown): Promise<unknown>
}

interface GreetingPreview extends UnknownRecord {
  groupId: string
  text: string
  target: string
  time: string
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function greetingConfig(config: unknown): UnknownRecord {
  const persona = record(record(config).persona)
  return {
    enabled: true,
    prompt: "写一句轻松自然的群聊打招呼，像在群里主动找大家聊天，20字以内，不要解释。",
    fallbackMessages: fallbackGreetings,
    maxChars: 60,
    ...record(persona.initiativeGreeting),
  }
}

function compactGreeting(value: unknown, maxChars = 60): string {
  const normalized = normalizeResponseText(value)
    .replace(/^["“”'「」]+|["“”'「」]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!normalized) return ""
  return normalized.slice(0, Math.max(8, number(maxChars, 60)))
}

function fallbackGreeting(config: unknown): string {
  const cfg = greetingConfig(config)
  const list = Array.isArray(cfg.fallbackMessages) && cfg.fallbackMessages.length ? cfg.fallbackMessages : fallbackGreetings
  return text(list[Math.floor(Math.random() * list.length)] || fallbackGreetings[0])
}

async function groupTarget(event: UnknownRecord, groupId = ""): Promise<GreetingTarget> {
  const targetId = text(groupId).trim()
  if (!targetId) {
    if (event.isGroup !== true) throw new Error("当前不是群聊，请指定群号。")
    const reply = event.reply
    if (typeof reply !== "function") throw new Error("当前事件不支持群消息发送。")
    const currentId = text(event.group_id)
    return { groupId: currentId, label: `群 ${currentId}`, send: payload => (reply as (value: unknown, quote?: unknown) => Promise<unknown>).call(event, payload, false) }
  }
  return {
    groupId: targetId,
    label: `群 ${targetId}`,
    async send(payload: unknown): Promise<unknown> {
      const bot = record(event.bot || hostRuntime.bot)
      const pickGroup = bot.pickGroup
      const group = typeof pickGroup === "function" ? record(await pickGroup.call(event.bot || hostRuntime.bot, Number(targetId), true)) : {}
      const sendMsg = group.sendMsg
      if (typeof sendMsg !== "function") throw new Error(`无法获取群 ${targetId}，请确认机器人在该群。`)
      return sendMsg.call(group, payload)
    },
  }
}

export async function generateInitiativeGreeting(event: unknown, config: unknown): Promise<string> {
  const cfg = greetingConfig(config)
  if (cfg.enabled === false) return fallbackGreeting(config)
  const prompt = text(cfg.prompt).trim() || "写一句轻松自然的群聊打招呼，20字以内。"
  try {
    const result = await chatService.send(event, prompt, {
      source: "initiativeGreeting",
      transient: true,
      extraSystemPrompt: [
        "你正在主动在群里打招呼。",
        "只输出一句自然的中文短句，不要解释，不要带命令格式，不要提到系统或模型。",
      ].join("\n"),
    })
    const value = compactGreeting(result.text, number(cfg.maxChars, 60))
    if (!isEmptyResponse(value)) return value
  } catch (error) {
    hostRuntime.logger?.warn?.("[yui-chat] 主动打招呼生成失败，使用 fallback", error)
  }
  return fallbackGreeting(config)
}

export async function sendInitiativeGreeting(event: unknown, options: UnknownRecord = {}): Promise<{ target: string; text: string }> {
  const config = options.config || await configStore.load()
  const cfg = greetingConfig(config)
  if (cfg.enabled === false) throw new Error("主动打招呼功能未启用。")
  const target = await groupTarget(record(event), text(options.groupId))
  const value = options.text || await generateInitiativeGreeting({
    ...record(event),
    isGroup: true,
    group_id: target.groupId,
    msg: cfg.prompt,
    raw_message: cfg.prompt,
  }, config)
  await target.send(value)
  return { target: target.label, text: text(value) }
}

class InitiativeGreetingScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private config: UnknownRecord | null = null
  private startedAt = 0
  private nextRunAt = 0
  private running = false
  private lastRunAt = 0
  private lastSent: GreetingPreview[] = []
  private lastPreview: GreetingPreview[] = []
  private lastError = ""

  start(config: unknown = {}): UnknownRecord {
    this.stop()
    const cfg = greetingConfig(config)
    this.config = record(config)
    this.lastError = ""
    if (cfg.enabled === false || cfg.scheduledEnabled !== true) return this.stats()
    const intervalMs = Math.max(1, number(cfg.intervalHours, 3)) * 60 * 60 * 1000
    this.startedAt = Date.now()
    this.nextRunAt = this.startedAt + intervalMs
    this.timer = setInterval(() => {
      void this.runOnce({ reason: "interval" }).catch(error => {
        this.lastError = text(error instanceof Error ? error.message : error)
        hostRuntime.logger?.warn?.("[yui-chat] 定时主动打招呼失败", error)
      })
    }, intervalMs)
    const timer = this.timer as ReturnType<typeof setInterval> & { unref?: () => void }
    timer.unref?.()
    return this.stats()
  }

  stop(): UnknownRecord {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.nextRunAt = 0
    return this.stats()
  }

  async runOnce(options: UnknownRecord = {}): Promise<UnknownRecord> {
    if (this.running) return { skipped: true, reason: "running" }
    const config = options.config || this.config || await configStore.load()
    const cfg = greetingConfig(config)
    if (cfg.enabled === false || (options.force !== true && cfg.scheduledEnabled !== true)) return { skipped: true, reason: "disabled" }
    const groups = (Array.isArray(cfg.groups) ? cfg.groups : []).map(text).map(item => item.trim()).filter(Boolean)
    if (!groups.length) return { skipped: true, reason: "empty-groups" }
    this.running = true
    this.lastRunAt = Date.now()
    this.lastSent = []
    this.lastPreview = []
    try {
      const probability = Math.max(0, Math.min(100, number(cfg.probabilityPercent, 50)))
      for (const groupId of groups) {
        if (options.force !== true && Math.random() * 100 >= probability) continue
        if (options.dryRun === true) {
          const value = options.text || await generateInitiativeGreeting({
            isGroup: true, group_id: groupId, user_id: "system", msg: cfg.prompt, raw_message: cfg.prompt,
            bot: options.bot || hostRuntime.bot, sender: { user_id: "system", nickname: "Yui Chat" },
          }, config)
          this.lastPreview.push({ groupId, text: text(value), target: `群 ${groupId}`, time: new Date().toISOString() })
          continue
        }
        const result = await sendInitiativeGreeting({
          isGroup: true, group_id: groupId, user_id: "system", msg: cfg.prompt, raw_message: cfg.prompt,
          bot: options.bot || hostRuntime.bot, sender: { user_id: "system", nickname: "Yui Chat" },
        }, { config, groupId })
        this.lastSent.push({ groupId, text: result.text, target: result.target, time: new Date().toISOString() })
      }
      this.lastError = ""
      return { skipped: false, dryRun: options.dryRun === true, sent: this.lastSent.length, planned: this.lastPreview.length, groups: groups.length, preview: this.lastPreview.slice(-8) }
    } catch (error) {
      this.lastError = text(error instanceof Error ? error.message : error)
      throw error
    } finally {
      this.running = false
      const intervalMs = Math.max(1, number(cfg.intervalHours, 3)) * 60 * 60 * 1000
      if (this.timer) this.nextRunAt = Date.now() + intervalMs
    }
  }

  stats(): UnknownRecord {
    const cfg = greetingConfig(this.config || {})
    return {
      enabled: cfg.enabled !== false,
      scheduledEnabled: cfg.scheduledEnabled === true,
      active: Boolean(this.timer),
      running: this.running,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : "",
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : "",
      lastRunAt: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : "",
      lastSent: this.lastSent.slice(-8),
      lastPreview: this.lastPreview.slice(-8),
      lastError: this.lastError,
    }
  }
}

export const initiativeGreetingScheduler = new InitiativeGreetingScheduler()

export function buildInitiativeGreetingStatus(config: unknown = {}): UnknownRecord {
  const cfg = greetingConfig(config)
  return {
    config: {
      enabled: cfg.enabled !== false,
      scheduledEnabled: cfg.scheduledEnabled === true,
      groups: Array.isArray(cfg.groups) ? cfg.groups.map(text).filter(Boolean) : [],
      intervalHours: number(cfg.intervalHours, 3),
      probabilityPercent: number(cfg.probabilityPercent, 50),
      maxChars: number(cfg.maxChars, 60),
      prompt: text(cfg.prompt),
      fallbackMessages: Array.isArray(cfg.fallbackMessages) ? cfg.fallbackMessages : fallbackGreetings,
    },
    scheduler: initiativeGreetingScheduler.stats(),
  }
}

export const initiativeGreeting = {
  buildInitiativeGreetingStatus,
  generateInitiativeGreeting,
  sendInitiativeGreeting,
  scheduler: initiativeGreetingScheduler,
}
