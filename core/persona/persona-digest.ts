import { commandObserver } from "../../knowledge/command-observer.js"
import { memoryStore } from "../../memory/store.js"
import { mutedStats } from "../chat/access-control.js"
import { mediaCacheStats } from "../media/media-cache.js"
import { recentContextStore } from "../chat/recent-context.js"
import type { UnknownRecord } from "../message/types.js"
import { linkSafetyConfig } from "../network/link-safety-policy.js"
import { personaTriggerStats } from "./persona-trigger.js"
import { defaultPersonaRuntimePrompt } from "../../config/defaults.js"
import { composePersonaSystemPrompt, resolvePersonaRuntimePrompt } from "./prompt-composer.js"
import { formatPersonaBeijingTime } from "./persona-chain.js"

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 汇总人格、记忆、媒体和访问控制的只读状态，供诊断页与状态接口复用。 */
export async function buildPersonaDigest(config: unknown = {}): Promise<UnknownRecord> {
  const root = record(config)
  const persona = record(root.persona)
  const trigger = record(persona.trigger)
  const output = record(persona.output)
  const context = record(root.context)
  const knowledgeConfig = record(root.knowledge)
  const memoryConfig = record(root.memory)
  const mediaRecognition = record(root.mediaRecognition)
  const remoteFetch = record(mediaRecognition.remoteFetch)
  const linkSafety = linkSafetyConfig(config)
  const response = record(root.response)
  const segmentation = record(response.segmentation)
  const tts = record(response.tts)
  const chat = record(root.chat)
  const access = record(chat.access)
  const ambient = record(trigger.ambient)
  const poke = record(trigger.poke)
  const mediaCache = await mediaCacheStats()
  const knowledge = commandObserver.stats()
  const memory = record(await memoryStore.stats())
  const recentContext = recentContextStore.stats()
  const muted = mutedStats()
  const triggerStats = personaTriggerStats()
  const aliases = list(persona.aliases)
  const whitelist = list(access.whitelist)
  const blacklist = list(access.blacklist)
  const disabledGroupIds = list(trigger.disabledGroupIds)
  const enhanceKeywords = list(trigger.enhanceKeywords)
  const fallbackMessages = list(poke.fallbackMessages)
  const runtimePrompt = resolvePersonaRuntimePrompt(persona.runtimePrompt)

  return {
    generatedAt: new Date().toISOString(),
    enabled: Boolean(persona.enabled),
    firstPersonEnabled: persona.respondToFirstPersonCall !== false,
    identity: {
      firstPerson: text(persona.firstPerson),
      assistantLabel: text(persona.assistantLabel),
      aliases,
      aliasCount: aliases.length,
    },
    prompt: {
      runtimePrompt,
      defaultRuntimePrompt: defaultPersonaRuntimePrompt,
      characterPrompt: text(persona.characterPrompt),
      composedPreview: composePersonaSystemPrompt(persona.characterPrompt, runtimePrompt),
      currentTime: formatPersonaBeijingTime(),
    },
    trigger: {
      probabilityPercent: number(trigger.probabilityPercent, 100),
      alwaysRespondToName: trigger.alwaysRespondToName !== false,
      alwaysRespondToAt: trigger.alwaysRespondToAt !== false,
      cooldownMs: number(trigger.cooldownMs),
      groupCooldownMs: number(trigger.groupCooldownMs),
      disabledGroupCount: disabledGroupIds.length,
      enhanceKeywordCount: enhanceKeywords.length,
      enhanceRecallMs: number(trigger.enhanceRecallMs),
      ambientEnabled: ambient.enabled === true,
      ambientGroupOnly: ambient.groupOnly !== false,
      ambientMinMessageChars: number(ambient.minMessageChars),
      ambientProbabilityPercent: number(ambient.probabilityPercent, 10),
      pokeEnabled: poke.enabled === true,
      pokeBotOnly: poke.respondToBotPoke !== false,
      pokeResponseMode: text(poke.responseMode || "ai-with-fallback"),
      pokeProbabilityPercent: number(poke.probabilityPercent, 100),
      pokeCooldownMs: number(poke.cooldownMs),
      pokeGroupCooldownMs: number(poke.groupCooldownMs),
      pokeFallbackMessages: fallbackMessages.length,
      runtimeCooldowns: number(triggerStats.cooldowns),
    },
    context: {
      recentMessageCount: number(context.recentMessageCount),
      scopes: recentContext.scopes,
      messages: recentContext.messages,
    },
    knowledge: {
      enabled: knowledgeConfig.enabled !== false,
      characterPromptEnabled: Boolean(persona.enabled && text(persona.characterPrompt).trim()),
      commands: number(knowledge.commands),
      events: number(knowledge.events),
      observedCommands: number(knowledge.observedCommands),
    },
    memory: {
      enabled: memoryConfig.enabled !== false,
      injectProfile: memoryConfig.injectProfile !== false,
      injectRelevantFacts: memoryConfig.injectRelevantFacts !== false,
      users: number(memory.users),
      scopes: number(memory.scopes),
    },
    media: {
      enabled: mediaRecognition.enabled !== false,
      remoteFetch: remoteFetch.enabled !== false,
      preferNativeVision: mediaRecognition.preferNativeVision !== false,
      allowPrivateHosts: linkSafety.allowPrivateHosts,
      cacheFiles: number(mediaCache.files),
      cacheBytes: number(mediaCache.bytes),
    },
    output: {
      defaultMode: text(response.defaultMode || "text"),
      omitChannelPrefixInFirstPerson: output.omitChannelPrefixInFirstPerson !== false,
      segmentation: {
        enabled: segmentation.enabled === true,
        intervalMethod: text(segmentation.intervalMethod || "random"),
        thresholdChars: number(segmentation.thresholdChars, 150),
        mode: text(segmentation.mode || "regex"),
      },
      autoUsePicture: response.autoUsePicture !== false,
      autoUsePictureThreshold: number(response.autoUsePictureThreshold),
      ttsEnabled: tts.enabled === true,
    },
    access: {
      privateChatEnabled: access.privateChatEnabled !== false,
      masterBypass: access.masterBypass !== false,
      whitelistCount: whitelist.length,
      blacklistCount: blacklist.length,
      mutedScopes: number(muted.mutedScopes),
    },
  }
}
