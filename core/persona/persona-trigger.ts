import { hostRuntime } from "../runtime/host-runtime.js"
import { firstPersonMatch, type FirstPersonMatch } from "./persona-chain.js"
import type { UnknownRecord } from "../message/types.js"
import { groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"
import { clearConversationContinuationState, consumeConversationContinuation, conversationContinuationStats } from "./conversation-continuation.js"

interface TriggerResult extends UnknownRecord {
  ok: boolean
  reason: string
  match: FirstPersonMatch & { byPoke?: boolean }
}

const cooldowns = new Map<string, number>()

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function rootPersona(config: unknown): UnknownRecord {
  return record(record(config).persona)
}

function keyFor(event: unknown, namespace = "message"): string {
  const e = record(event)
  return isGroupEvent(e)
    ? `${namespace}:g:${groupIdFromEvent(e)}`
    : `${namespace}:p:${text(e.user_id || e.operator_id || "unknown")}`
}

function groupDisabled(event: unknown, trigger: UnknownRecord): boolean {
  const e = record(event)
  return isGroupEvent(e) && (Array.isArray(trigger.disabledGroupIds) ? trigger.disabledGroupIds : []).map(text).includes(groupIdFromEvent(e))
}

function ownMessage(event: unknown): boolean {
  const e = record(event)
  const bot = record(e.bot)
  const selfId = e.self_id || bot.uin
  if (!selfId) return false
  return text(e.user_id || record(e.sender).user_id) === text(selfId)
}

function ambientAllowed(event: unknown, trigger: UnknownRecord, message: unknown): boolean {
  const ambient = record(trigger.ambient)
  const e = record(event)
  if (ambient.enabled !== true || ownMessage(event)) return false
  if (ambient.groupOnly !== false && !isGroupEvent(e)) return false
  return text(message).trim().length >= Math.max(0, Number(ambient.minMessageChars) || 0)
}

function probabilityHit(percent: unknown = 100): boolean {
  const value = Math.max(0, Math.min(100, Number(percent)))
  if (value >= 100) return true
  if (value <= 0) return false
  return Math.random() * 100 < value
}

function cooldownHit(event: unknown, trigger: UnknownRecord, namespace = "message"): boolean {
  const e = record(event)
  const cooldownMs = Math.max(0, Number(trigger.cooldownMs) || 0)
  const groupCooldownMs = isGroupEvent(e) ? Math.max(0, Number(trigger.groupCooldownMs) || 0) : 0
  const ttl = Math.max(cooldownMs, groupCooldownMs)
  if (!ttl) return false
  return Date.now() - (cooldowns.get(keyFor(event, namespace)) || 0) < ttl
}

function markCooldown(event: unknown, trigger: UnknownRecord, namespace = "message"): void {
  const e = record(event)
  const cooldownMs = Math.max(0, Number(trigger.cooldownMs) || 0)
  const groupCooldownMs = isGroupEvent(e) ? Math.max(0, Number(trigger.groupCooldownMs) || 0) : 0
  if (Math.max(cooldownMs, groupCooldownMs) > 0) cooldowns.set(keyFor(event, namespace), Date.now())
}

function keywordInstruction(message: string, trigger: UnknownRecord): { prompt: string; matched: string[]; recallMs: number } {
  const keywords = (Array.isArray(trigger.enhanceKeywords) ? trigger.enhanceKeywords : []).map(text).filter(Boolean)
  const matched = keywords.filter(keyword => message.includes(keyword))
  if (!matched.length) return { prompt: "", matched: [], recallMs: 0 }
  return { prompt: text(trigger.enhancePrompt), matched, recallMs: Math.max(0, Number(trigger.enhanceRecallMs) || 0) }
}

function botIds(event: unknown): string[] {
  const e = record(event)
  const bot = record(e.bot)
  const hostBot = record(hostRuntime.bot)
  const hostUin = Array.isArray(hostBot.uin) ? hostBot.uin : [hostBot.uin]
  return [e.self_id, bot.uin, ...hostUin].map(text).filter(Boolean)
}

function pokeOperatorId(event: unknown): string {
  const e = record(event)
  return text(e.operator_id || e.user_id || record(e.sender).user_id)
}

export function isPokeEvent(event: unknown = {}): boolean {
  const e = record(event)
  return e.sub_type === "poke" || e.notice_type === "poke" || e.raw_notice_type === "poke"
}

export function isPokeToBot(event: unknown): boolean {
  if (!isPokeEvent(event)) return false
  const ids = botIds(event)
  if (!ids.length) return false
  const e = record(event)
  const targetId = text(e.target_id || e.targetId)
  if (targetId && !ids.includes(targetId)) return false
  const operatorId = pokeOperatorId(event)
  return !(operatorId && ids.includes(operatorId))
}

function pokePrompt(event: unknown, config: unknown): string {
  const persona = rootPersona(config)
  const trigger = record(persona.trigger)
  const poke = record(trigger.poke)
  const firstPerson = text(persona.firstPerson || persona.assistantLabel || "AI")
  const e = record(event)
  return text(poke.prompt || "用户戳了[first_person]。请自然回应一句。")
    .replace(/\[first_person]/g, firstPerson)
    .replace(/\[user_id]/g, pokeOperatorId(event))
    .replace(/\[group_id]/g, text(e.group_id))
}

export function evaluateFirstPersonTrigger(event: unknown = {}, config: unknown = {}): TriggerResult {
  const e = record(event)
  const persona = rootPersona(config)
  const trigger = record(persona.trigger)
  const message = text(e.msg || e.raw_message)
  const match = firstPersonMatch(event, config, { msg: message })
  const passiveMatch = firstPersonMatch(event, config, { msg: message, ignoreTriggerSwitches: true })
  const ambient = !passiveMatch.matched && persona.enabled !== false ? ambientAllowed(event, trigger, message) : false
  const continuation = !passiveMatch.matched && persona.enabled !== false
    ? consumeConversationContinuation(event, message)
    : { matched: false }
  if (!match.matched && !ambient && continuation.matched !== true) return { ok: false, reason: "not-matched", match }
  if (groupDisabled(event, trigger)) return { ok: false, reason: "disabled-group", match }

  const directName = match.byName && trigger.alwaysRespondToName !== false
  const directAt = match.byAt && trigger.alwaysRespondToAt !== false
  if (continuation.matched === true) {
    // 刚发送成功的一次性续聊属于明确上下文，不再受随机旁路概率影响。
  } else if (ambient) {
    if (cooldownHit(event, trigger) || !probabilityHit(record(trigger.ambient).probabilityPercent ?? 10)) {
      return { ok: false, reason: cooldownHit(event, trigger) ? "cooldown" : "probability", match }
    }
  } else if (!directName && !directAt) {
    if (cooldownHit(event, trigger) || !probabilityHit(trigger.probabilityPercent ?? 100)) {
      return { ok: false, reason: cooldownHit(event, trigger) ? "cooldown" : "probability", match }
    }
  }

  markCooldown(event, trigger)
  const keyword = keywordInstruction(message, trigger)
  return {
    ok: true,
    reason: directName ? "direct-name" : directAt ? "direct-at" : continuation.matched === true ? "continuation" : ambient ? "ambient" : "probability",
    match,
    continuationReason: continuation.reason,
    extraSystemPrompt: keyword.prompt,
    outputOptions: keyword.recallMs ? { recallMsg: Math.ceil(keyword.recallMs / 1000) } : {},
    matchedEnhanceKeywords: keyword.matched,
  }
}

export function evaluateFirstPersonPokeTrigger(event: unknown = {}, config: unknown = {}): TriggerResult {
  const persona = rootPersona(config)
  const trigger = record(persona.trigger)
  const poke = record(trigger.poke)
  const match = { matched: false, byName: false, byAt: false, byPoke: true, names: [] }
  if (persona.enabled === false || persona.respondToFirstPersonCall === false) return { ok: false, reason: "persona-disabled", match }
  if (poke.enabled !== true) return { ok: false, reason: "poke-disabled", match }
  if (groupDisabled(event, trigger)) return { ok: false, reason: "disabled-group", match }
  if (poke.respondToBotPoke !== false && !isPokeToBot(event)) return { ok: false, reason: "not-bot-poke", match }
  if (cooldownHit(event, poke, "poke")) return { ok: false, reason: "cooldown", match }
  if (!probabilityHit(poke.probabilityPercent ?? 100)) return { ok: false, reason: "probability", match }
  markCooldown(event, poke, "poke")
  const prompt = pokePrompt(event, config)
  return { ok: true, reason: "poke", match, prompt, extraSystemPrompt: prompt }
}

export function clearPersonaTriggerState(): { cooldowns: number; continuationWindows: number } {
  const count = cooldowns.size
  cooldowns.clear()
  return { cooldowns: count, continuationWindows: clearConversationContinuationState() }
}

export function personaTriggerStats(): { cooldowns: number; continuationWindows: number; continuationWindowMs: number } {
  const continuation = conversationContinuationStats()
  return { cooldowns: cooldowns.size, continuationWindows: continuation.windows, continuationWindowMs: continuation.windowMs }
}
