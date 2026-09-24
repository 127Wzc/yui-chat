import { fetchWithTimeout } from "../../core/network/fetch-timeout.js"
import { ModelAdapter, notifyModelRequest, tokenUsage } from "./base.js"
import type { DecisionAnswer, DecisionRequest, DecisionResponse, ModelChannel, ModelListRequest, ModelRequest, ModelResponse } from "../protocol/types.js"

type UnknownRecord = Record<string, unknown>

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1"
const DEFAULT_MODEL = "jev-latest"

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function finite(value: unknown): number | undefined {
  const result = Number(value)
  return value === undefined || value === null || !Number.isFinite(result) ? undefined : result
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter(([, item]) => item !== undefined && item !== null).map(([key, item]) => [key, String(item)]))
}

function probabilities(value: unknown): Record<string, number> | undefined {
  const source = record(value)
  const entries = Object.entries(source).map(([key, item]) => [key, finite(item)] as const).filter((entry): entry is readonly [string, number] => entry[1] !== undefined)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function retryableNetworkError(error: unknown): boolean {
  const source = error as { code?: unknown; yuiNetwork?: { responseReceived?: unknown } } | null
  return Boolean(source?.yuiNetwork) && source?.yuiNetwork?.responseReceived === false && source?.code !== "ETIMEDOUT"
}

function normalizeAnswer(value: unknown): DecisionAnswer {
  const source = record(value)
  const answer: DecisionAnswer = { type: String(source.type || "") }
  const noul = finite(source.noul)
  const score = finite(source.score)
  const confidence = finite(source.confidence)
  const distribution = probabilities(source.probabilities)
  if (noul !== undefined) answer.noul = noul
  if (typeof source.choice === "string") answer.choice = source.choice
  if (score !== undefined) answer.score = score
  if (confidence !== undefined) answer.confidence = confidence
  if (distribution) answer.probabilities = distribution
  return answer
}

/**
 * TypeSafe System One 决策适配器。
 *
 * 只实现 noul/choice/score 结构化判断，不参与文本对话；Base URL 可以填到
 * `/v1`，也可以直接填写完整的 `/systemone` 端点。
 */
export class TypeSafeAdapter extends ModelAdapter {
  override readonly id = "typesafe"
  override readonly protocol = "typesafe-systemone"
  override readonly supportsDecision = true

  endpoint(channel: ModelChannel): URL {
    const base = String(channel.baseURL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "")
    const url = new URL(/\/systemone$/i.test(base) ? base : `${base}/systemone`)
    for (const [key, value] of Object.entries(record(channel.query))) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value))
    }
    return url
  }

  headers(channel: ModelChannel): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...stringRecord(channel.headers) }
    if (!channel.apiKey || channel.authType === "none") return headers
    const authHeader = String(channel.authHeader || "Authorization")
    if (channel.authType === "x-api-key") headers["x-api-key"] = channel.apiKey
    else if (channel.authType === "custom-header") headers[authHeader] = channel.apiKey
    else headers[authHeader] = `Bearer ${channel.apiKey}`
    return headers
  }

  override async sendMessage(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("决策模型只用于结构化判断，不能作为对话模型使用")
  }

  override async listModels(_request?: ModelListRequest): Promise<unknown[]> {
    return [{ id: DEFAULT_MODEL, label: DEFAULT_MODEL, description: "TypeSafe System One 最新决策模型" }]
  }

  override async decide({ channel, state, questions, signal, onRequest }: DecisionRequest): Promise<DecisionResponse> {
    if (!channel.apiKey && channel.authType !== "none") throw new Error("决策渠道缺少 API Key")
    const body = { ...record(channel.params), state, model: channel.model || DEFAULT_MODEL, questions }
    notifyModelRequest(onRequest, this.protocol, body)
    const send = () => fetchWithTimeout(this.endpoint(channel), {
      method: "POST",
      headers: this.headers(channel),
      body: JSON.stringify(body),
      timeoutMs: Number(channel.timeoutMs || 15000),
      signal,
      consume: async response => {
        const raw = await response.text()
        let data: unknown = {}
        try { data = raw ? JSON.parse(raw) : {} } catch { data = { error: raw.slice(0, 300) } }
        const payload = record(data)
        if (!response.ok) {
          const error = payload.error
          const message = record(error).message || payload.detail || payload.message || error || `HTTP ${response.status}`
          throw new Error(`决策请求失败（${response.status}）：${typeof message === "string" ? message : JSON.stringify(message)}`)
        }
        const answers = Object.fromEntries(Object.entries(record(payload.answers)).map(([key, value]) => [key, normalizeAnswer(value)]))
        return { model: String(payload.model || channel.model || DEFAULT_MODEL), answers, usage: tokenUsage(payload) }
      },
    })
    try {
      return await send()
    } catch (error) {
      // 连接在收到响应前被对端断开时重试一次；超时、取消和 HTTP 错误不重试。
      if (!retryableNetworkError(error) || signal?.aborted) throw error
      return send()
    }
  }
}
