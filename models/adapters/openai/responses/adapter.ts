import { fetchWithTimeout } from "../../../../core/network/fetch-timeout.js"
import { notifyModelRequest } from "../../base.js"
import type { ModelChannel, ModelRequest, ModelResponse } from "../../../protocol/types.js"
import { OpenAICompatibleAdapter } from "../chat/adapter.js"
import { parseResponsesResponse, parseResponsesStreamResponse } from "./response-adapter.js"
import { ResponsesConversationStateMachine } from "./state-machine.js"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

async function readJson(response: Response): Promise<UnknownRecord> {
  const body = await response.text()
  if (!body) return {}
  try {
    const parsed: unknown = JSON.parse(body)
    return record(parsed)
  } catch {
    return { error: { message: body } }
  }
}

function responseError(data: UnknownRecord, status: number): Error {
  const error = record(data.error)
  const result = new Error(String(error.message || error.code || `HTTP ${status}`))
  Object.assign(result, { status, code: String(error.code || "") })
  return result
}

/** OpenAI Responses API 适配器；复用现有模型列表、鉴权和 embedding 边界。 */
export class OpenAIResponsesAdapter extends OpenAICompatibleAdapter {
  override readonly id = "openai-responses"
  override readonly protocol = "responses"
  override readonly supportsStreaming = true
  override readonly supportsNativeToolSearch = true

  override buildUrl(channel: ModelChannel): URL {
    const baseURL = (channel.baseURL || this.getDefaultBaseURL()).replace(/\/$/, "")
    const url = new URL(`${baseURL}/responses`)
    for (const [key, value] of Object.entries(record(channel.query))) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value))
    }
    if (channel.authType === "query" && channel.apiKey) url.searchParams.set(String(channel.authQueryName || "api_key"), channel.apiKey)
    return url
  }

  override async sendMessage(request: ModelRequest): Promise<ModelResponse> {
    const { channel, signal } = request
    const state = new ResponsesConversationStateMachine(request)
    const body = state.initialRequest()
    const send = (requestBody: UnknownRecord, phase = "initial"): Promise<ModelResponse> => {
      notifyModelRequest(request.onRequest, this.protocol, requestBody, phase)
      return fetchWithTimeout(this.buildUrl(channel), {
        method: "POST",
        headers: this.buildHeaders(channel),
        body: JSON.stringify(requestBody),
        timeoutMs: channel.timeoutMs || 90000,
        signal,
        consume: async response => {
          const contentType = String(response.headers.get("content-type") || "").toLowerCase()
          if (channel.stream === true && contentType.includes("text/event-stream")) return parseResponsesStreamResponse(response)
          const data = await readJson(response)
          if (!response.ok) throw responseError(data, response.status)
          return parseResponsesResponse(data)
        },
      })
    }
    try {
      return state.complete(await send(body))
    } catch (error) {
      const recovery = state.recoveryRequest(error)
      if (!recovery) throw error
      return state.complete(await send(recovery.body, "recovery"), recovery.recovery)
    }
  }
}
