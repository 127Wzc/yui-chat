import { fetchWithTimeout } from "../network/fetch-timeout.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import type { UnknownRecord } from "../message/types.js"

type TtsConfig = UnknownRecord & {
  response?: UnknownRecord
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

function ttsConfig(config: unknown): UnknownRecord {
  return record(record(config).response).tts && typeof record(record(config).response).tts === "object"
    ? record(record(record(config).response).tts)
    : {}
}

function withTtsOverrides(config: unknown, overrides: unknown): TtsConfig {
  const root = record(config)
  const response = record(root.response)
  return {
    ...root,
    response: {
      ...response,
      tts: { ...ttsConfig(root), ...record(overrides) },
    },
  }
}

function bytesFrom(arrayBuffer: ArrayBuffer): unknown {
  // 宿主的 segment.record 通常接收 Buffer；浏览器或测试环境没有 Buffer 时再退回 Uint8Array。
  const buffer = (globalThis as typeof globalThis & {
    Buffer?: { from(value: ArrayBuffer): unknown }
  }).Buffer
  return typeof buffer?.from === "function" ? buffer.from(arrayBuffer) : new Uint8Array(arrayBuffer)
}

function jsonRecord(value: unknown): UnknownRecord {
  return record(value)
}

async function synthesizeOpenAiCompatible(textValue: string, config: unknown): Promise<unknown> {
  const tts = ttsConfig(config)
  const endpoint = text(tts.endpoint).replace(/\/$/, "")
  const apiKey = text(tts.apiKey)
  if (!endpoint || !apiKey) return null
  const response = await fetchWithTimeout(`${endpoint}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: text(tts.model) || "tts-1",
      voice: text(tts.voice) || "alloy",
      input: textValue.slice(0, number(tts.maxChars, 300)),
      response_format: text(tts.format) || "mp3",
    }),
    timeoutMs: number(tts.timeoutMs, 30000),
  })
  if (!response.ok) throw new Error(`TTS HTTP ${response.status}: ${await response.text()}`)
  return bytesFrom(await response.arrayBuffer())
}

async function synthesizeGeneric(textValue: string, config: unknown): Promise<unknown> {
  const tts = ttsConfig(config)
  const endpoint = text(tts.endpoint)
  if (!endpoint) return null
  const apiKey = text(tts.apiKey)
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: textValue.slice(0, number(tts.maxChars, 300)),
      voice: tts.voice,
      model: tts.model,
      format: tts.format,
    }),
    timeoutMs: number(tts.timeoutMs, 30000),
  })
  if (!response.ok) throw new Error(`TTS HTTP ${response.status}: ${await response.text()}`)
  const contentType = text(response.headers.get("content-type"))
  if (contentType.includes("application/json")) {
    const json = jsonRecord(await response.json())
    const data = record(json.data)
    return json.url || json.audioUrl || data.url || null
  }
  return bytesFrom(await response.arrayBuffer())
}

export function stripForSpeech(value: unknown = ""): string {
  return text(value).replace(/\[[^\]]+]/g, "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim()
}

/** 普通语音模式和规则工具共用的受配置约束的合成入口。 */
export async function synthesizeSpeech(value: unknown, config: unknown = {}, overrides: unknown = {}): Promise<unknown> {
  const scoped = withTtsOverrides(config, overrides)
  const tts = ttsConfig(scoped)
  if (tts.enabled !== true) return null
  try {
    return text(tts.mode) === "generic"
      ? await synthesizeGeneric(stripForSpeech(value), scoped)
      : await synthesizeOpenAiCompatible(stripForSpeech(value), scoped)
  } catch (error) {
    hostRuntime.logger?.debug?.("[yui-chat] 语音合成请求失败", error)
    throw error
  }
}
