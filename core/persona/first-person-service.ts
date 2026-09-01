import { configStore } from "../../config/store.js"
import { isCommandMessage } from "../message/command-prefixes.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { chatService } from "../chat/chat-service.js"
import { isEmptyResponse, preflight, releasePreflight, sendConfirm } from "../chat/response-pipeline.js"
import { sendChatOutput } from "../chat/output-service.js"
import { normalizeEventScope } from "../message/event-scope.js"
import type { UnknownRecord } from "../message/types.js"
import { evaluateFirstPersonPokeTrigger, evaluateFirstPersonTrigger } from "./persona-trigger.js"

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function modelFailureMessage(config: unknown, error: unknown): string {
  const persona = record(record(config).persona)
  const name = text(persona.firstPerson || persona.assistantLabel || "助手")
  const detail = text(error instanceof Error ? error.message : error)
  if (/504|gateway time-?out/i.test(detail)) return `${name}暂时连接不上回复模型（网关超时），请稍后再试。`
  if (/timeout|超时/i.test(detail)) return `${name}等待回复模型超时了，请稍后再试。`
  return `${name}暂时没能连接到回复模型，请稍后再试。`
}

async function replyDirectTriggerFailure(event: UnknownRecord, config: unknown, trigger: UnknownRecord, error: unknown): Promise<boolean> {
  const reply = event.reply
  if (!["direct-name", "direct-at"].includes(text(trigger.reason)) || typeof reply !== "function") return false
  try {
    event.__yuiChatReplied = true
    await (reply as (value: unknown, quote?: unknown) => Promise<unknown>).call(event, modelFailureMessage(config, error), record(record(config).response).quoteReply)
    return true
  } catch (replyError) {
    hostRuntime.logger?.warn?.("[yui-chat] 第一人称失败提示发送失败", replyError)
    return false
  }
}

export async function handleFirstPersonMessage(event: unknown, options: UnknownRecord = {}): Promise<boolean> {
  const e = normalizeEventScope(record(event))
  if (e.__yuiChatReplied) return false
  const config = await configStore.load()
  const message = text(e.msg || e.raw_message)
  if (isCommandMessage(message.trim(), config)) return false
  const trigger = record(evaluateFirstPersonTrigger(e, config))
  if (trigger.ok !== true) return false
  const continuation = trigger.reason === "continuation"
  const gate = await preflight(e, message, config)
  if (!gate.ok) return false
  try {
    await sendConfirm(e, config)
    const result = await chatService.send(e, message, { source: continuation ? "firstPersonContinuation" : "firstPerson", extraSystemPrompt: trigger.extraSystemPrompt })
    e.__yuiChatReplied = true
    await sendChatOutput(e, result, config, { source: "firstPerson", replyOptions: trigger.outputOptions, armContinuation: !continuation })
    return true
  } catch (error) {
    hostRuntime.logger?.error?.(text(options.logPrefix || "[yui-chat] 第一人称回应失败"), error)
    return replyDirectTriggerFailure(e, config, trigger, error)
  } finally {
    releasePreflight(gate)
  }
}

function renderPokeFallback(event: UnknownRecord, config: unknown): string {
  const persona = record(record(config).persona)
  const poke = record(record(persona.trigger).poke)
  const configured = Array.isArray(poke.fallbackMessages) ? poke.fallbackMessages : []
  const list = configured.length ? configured : ["[first_person]在哦。"]
  const firstPerson = text(persona.firstPerson || persona.assistantLabel || "AI")
  return text(list[Math.floor(Math.random() * list.length)] || list[0])
    .replace(/\[first_person]/g, firstPerson)
    .replace(/\[user_id]/g, text(event.operator_id || event.user_id))
    .replace(/\[group_id]/g, text(event.group_id))
    .trim()
}

async function sendPokeFallback(event: UnknownRecord, config: unknown): Promise<boolean> {
  const value = renderPokeFallback(event, config)
  if (!value) return false
  event.__yuiChatReplied = true
  await sendChatOutput(event, { text: value, channel: "poke-fallback", source: "firstPerson" }, config, { source: "firstPerson" })
  return true
}

export async function handleFirstPersonPokeEvent(event: unknown, options: UnknownRecord = {}): Promise<boolean> {
  const e = normalizeEventScope(record(event))
  if (e.__yuiChatReplied) return false
  const config = await configStore.load()
  const userId = e.operator_id || e.user_id || record(e.sender).user_id
  if (!userId) return false
  e.user_id = userId
  e.sender = { ...record(e.sender), user_id: userId }
  const trigger = record(evaluateFirstPersonPokeTrigger(e, config))
  if (trigger.ok !== true) return false
  const prompt = text(trigger.prompt || "用户戳了你，请自然回应一句。")
  e.msg = prompt
  e.raw_message = prompt
  const gate = await preflight(e, prompt, config)
  if (!gate.ok) return false
  const poke = record(record(record(config).persona).trigger).poke
  const responseMode = text(record(poke).responseMode || "ai-with-fallback")
  try {
    await sendConfirm(e, config)
    if (responseMode === "fallback") return sendPokeFallback(e, config)
    const result = await chatService.send(e, prompt, { source: "firstPerson", extraSystemPrompt: trigger.extraSystemPrompt })
    if (responseMode === "ai-with-fallback" && isEmptyResponse(result.text)) return sendPokeFallback(e, config)
    e.__yuiChatReplied = true
    await sendChatOutput(e, result, config, { source: "firstPerson" })
    return true
  } catch (error) {
    if (responseMode === "ai-with-fallback") {
      hostRuntime.logger?.warn?.(text(options.logPrefix || "[yui-chat] 第一人称戳一戳回应失败，使用 fallback"), error)
      return sendPokeFallback(e, config)
    }
    hostRuntime.logger?.error?.(text(options.logPrefix || "[yui-chat] 第一人称戳一戳回应失败"), error)
    return false
  } finally {
    releasePreflight(gate)
  }
}
