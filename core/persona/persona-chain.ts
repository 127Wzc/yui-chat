import { commandObserver } from "../../knowledge/command-observer.js"
import { knowledgeStore } from "../../knowledge/store.js"
import { memoryStore } from "../../memory/store.js"
import { skillManager } from "../../skills/index.js"
import { resolvePersonaRuntimePrompt } from "./prompt-composer.js"
import { recentContextStore } from "../chat/recent-context.js"
import { buildMediaUserContent, summarizeMediaContext } from "../message/media-context.js"
import { buildOpenAiUserContent, extractMessageContext, mentionsBot, summarizeMessageContext } from "../message/message-context.js"
import { isGroupEvent } from "../message/event-scope.js"
import type { MessageContext, UnknownRecord } from "../message/types.js"
import type { ResolvedMediaContext } from "../message/media-context.js"

export interface FirstPersonMatch {
  matched: boolean
  byName: boolean
  byAt: boolean
  names: string[]
}

interface FirstPersonMatchOptions {
  ignoreTriggerSwitches?: boolean
  msg?: unknown
  context?: Partial<MessageContext>
  aliases?: unknown[]
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

/** 生成每轮对话使用的北京时间简写，不受服务器所在时区影响。 */
export function formatPersonaBeijingTime(value: Date = new Date()): string {
  const now = Number.isNaN(value.getTime()) ? new Date() : value
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  }).formatToParts(now)
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === type)?.value || ""
  return `当前北京时间：${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}（${pick("weekday")}）`
}

function replaceVars(value: unknown, vars: UnknownRecord): string {
  return text(value).replace(/\[([a-zA-Z0-9_]+)]/g, (_match, key: string) => text(vars[key]))
}

function userName(event: unknown): string {
  const e = record(event)
  const sender = record(e.sender)
  return text(sender.card || sender.nickname || e.user_id || "User")
}

function botName(event: unknown, config: UnknownRecord): string {
  const e = record(event)
  const persona = record(config.persona)
  const bot = record(e.bot)
  if (!isGroupEvent(e)) return text(bot.nickname || persona.assistantLabel)
  try {
    const group = record(e.group)
    const pickMember = group.pickMember
    if (typeof pickMember === "function") {
      const member = record(pickMember.call(e.group, e.self_id))
      return text(member.card || member.nickname || bot.nickname || persona.assistantLabel)
    }
  } catch {
    // 宿主未加载群成员缓存时回退到机器人昵称。
  }
  return text(bot.nickname || persona.assistantLabel)
}

function groupName(event: unknown): string {
  const e = record(event)
  const group = record(e.group)
  return text(e.group_name || group.name || group.group_name || e.group_id)
}

export function shouldRespondToFirstPerson(event: unknown, config: unknown): boolean {
  const root = record(config)
  const persona = record(root.persona)
  if (persona.enabled !== true || persona.respondToFirstPersonCall !== true) return false
  const msg = text(record(event).msg || record(event).raw_message)
  const firstPerson = text(persona.firstPerson)
  const context = extractMessageContext(event, msg)
  const aliases = [firstPerson, ...(Array.isArray(persona.aliases) ? persona.aliases : [])].filter(Boolean)
  return firstPersonMatch(event, root, { msg, context, aliases }).matched
}

export function firstPersonMatch(event: unknown, config: unknown, options: FirstPersonMatchOptions = {}): FirstPersonMatch {
  const root = record(config)
  const persona = record(root.persona)
  const inspectDisabledTriggers = options.ignoreTriggerSwitches === true
  if (persona.enabled !== true || (!inspectDisabledTriggers && persona.respondToFirstPersonCall !== true)) {
    return { matched: false, byName: false, byAt: false, names: [] }
  }
  const e = record(event)
  const msg = text(options.msg ?? e.msg ?? e.raw_message)
  const context = options.context || extractMessageContext(event, msg)
  const aliases = options.aliases || [persona.firstPerson, ...(Array.isArray(persona.aliases) ? persona.aliases : [])].filter(Boolean)
  const names = aliases.map(text).filter(name => name && msg.includes(name))
  const byAt = (inspectDisabledTriggers || persona.respondToAt !== false) && mentionsBot(event, context)
  return { matched: Boolean(names.length || byAt), byName: Boolean(names.length), byAt, names }
}

function mediaValue(value: unknown): Partial<ResolvedMediaContext> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Partial<ResolvedMediaContext>
}

export interface PersonaContextSection {
  source: string
  label: string
  content: string
}

export interface PersonaMessagesWithContext {
  messages: Array<{ role: "system"; content: string }>
  sections: PersonaContextSection[]
}

async function buildPersonaPrompt(event: unknown, prompt: unknown, config: unknown, options: UnknownRecord = {}): Promise<{ content: string; sections: PersonaContextSection[] }> {
  const root = record(config)
  const persona = record(root.persona)
  const media = mediaValue(options.media)
  const context = media?.base || extractMessageContext(event, prompt)
  const e = record(event)
  const vars: UnknownRecord = {
    first_person: persona.firstPerson,
    assistant_label: persona.assistantLabel,
    user_name: userName(event),
    user_id: e.user_id || "",
    bot_name: botName(event, root),
    group_name: groupName(event),
    group_id: e.group_id || "",
  }
  const parts: string[] = []
  const sections: PersonaContextSection[] = []
  const add = (source: string, label: string, value: unknown): void => {
    const content = text(value)
    if (!content) return
    parts.push(content)
    sections.push({ source, label, content })
  }
  if (persona.enabled === true) add("persona", "角色设定", replaceVars(persona.characterPrompt, vars))
  add("persona-runtime", "系统运行规则", replaceVars(resolvePersonaRuntimePrompt(persona.runtimePrompt), vars))
  add("runtime-time", "当前时间", formatPersonaBeijingTime())
  if (options.extraSystemPrompt) add("persona-extra", "额外系统提示", options.extraSystemPrompt)
  if (/指令|命令|怎么|如何|帮助|help/i.test(text(prompt))) {
    add("command-knowledge", "内置指令知识", `当前内置指令知识库已索引 ${commandObserver.stats().commands} 条指令。`)
  }
  const skillPrompt = await skillManager.buildPrompt(text(prompt), { e: event, config: root })
  if (skillPrompt) add("skill", "Skill 指令", skillPrompt)
  const attachmentSummary = media ? summarizeMediaContext(media) : summarizeMessageContext(context)
  if (attachmentSummary) add("media", "媒体与消息附加内容", `本轮用户消息包含以下附加内容。若模型不能直接读取媒体，只能根据链接和上下文谨慎回答：\n${attachmentSummary}`)
  const memoryPrompt = await memoryStore.buildPrompt(event, prompt)
  if (memoryPrompt) add("memory", "记忆召回", memoryPrompt)
  const knowledgePrompt = await knowledgeStore.buildPrompt(event, prompt)
  if (knowledgePrompt) add("knowledge", "知识库召回", knowledgePrompt)
  const recentPrompt = recentContextStore.buildPrompt(event)
  if (recentPrompt) add("recent", "最近消息上下文", recentPrompt)
  return { content: parts.join("\n"), sections }
}

/** 组合人格、Skill、记忆、知识和最近消息为模型可消费的系统消息，并保留审计侧来源分段。 */
export async function buildPersonaMessagesWithContext(event: unknown, prompt: unknown, config: unknown, options: UnknownRecord = {}): Promise<PersonaMessagesWithContext> {
  const built = await buildPersonaPrompt(event, prompt, config, options)
  return { messages: [{ role: "system", content: built.content }], sections: built.sections }
}

/** 组合人格、Skill、记忆、知识和最近消息为模型可消费的系统消息。 */
export async function buildPersonaMessages(event: unknown, prompt: unknown, config: unknown, options: UnknownRecord = {}): Promise<Array<{ role: "system"; content: string }>> {
  return (await buildPersonaMessagesWithContext(event, prompt, config, options)).messages
}

export function buildUserMessage(event: unknown, prompt: unknown, _config: unknown = {}, options: UnknownRecord = {}): { role: "user"; content: ReturnType<typeof buildOpenAiUserContent> } {
  const media = mediaValue(options.media)
  const context = media?.base || extractMessageContext(event, prompt)
  const e = record(event)
  const prefix = isGroupEvent(e)
    ? `群聊「${groupName(event)}」中，${userName(event)}(${text(e.user_id)}) 说：`
    : `${userName(event)}(${text(e.user_id)}) 说：`
  const value = `${prefix}${context.text || text(prompt)}`
  return {
    role: "user",
    content: media
      ? buildMediaUserContent(value, media, Boolean(options.vision))
      : buildOpenAiUserContent(value, context, Boolean(options.vision)),
  }
}
