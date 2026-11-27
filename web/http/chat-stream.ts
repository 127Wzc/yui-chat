import type { RouteRequest, RouteResponse } from "./route-handler.js"
import { redactErrorText } from "../../core/shared/error-details.js"
import type { ChatProgressObserver } from "../../core/chat/chat-progress.js"

type Payload = Record<string, unknown>
interface StreamResponse extends RouteResponse {
  write(data: string): boolean
  end(): void
  flushHeaders(): void
  on(event: "close", handler: () => void): void
  writableLength: number
}

/** 每次请求独享事件流；沿用 POST 鉴权及同源校验，不使用 URL 凭证或广播。 */
export async function sendWebChatResponse(req: RouteRequest, response: RouteResponse, run: (transport: { signal?: AbortSignal; onProgress?: ChatProgressObserver; onDelivery?: (content: unknown) => void }) => Promise<Payload>): Promise<unknown> {
  if (req.body?.stream !== true) return response.json(await run({}))
  const res = response as StreamResponse
  const controller = new AbortController()
  let closed = false
  let completed = false
  // 宿主的 compression 中间件会缓冲小分片；no-transform 让事件流保持即时发送。
  res.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" })
  res.flushHeaders()
  const send = (type: string, data: unknown) => {
    if (closed) return
    if (res.writableLength > 1024 * 1024) { controller.abort(new Error("网页读取过慢，已停止生成。")); res.end(); return }
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const heartbeat = setInterval(() => { if (!closed) res.write(": heartbeat\n\n") }, 15000)
  res.on("close", () => {
    closed = true
    clearInterval(heartbeat)
    if (!completed) controller.abort(new Error("网页已停止接收，生成已终止。"))
  })
  try {
    send("ready", { ok: true })
    const result = await run({ signal: controller.signal, onProgress: data => send("progress", data), onDelivery: content => send("delivery", { content }) })
    completed = true
    send("complete", result)
  } catch (error) {
    send("error", { ok: false, error: redactErrorText(error instanceof Error ? error.message : error, 2000, true) })
  } finally {
    completed = true
    clearInterval(heartbeat)
    if (!closed) res.end()
  }
  return undefined
}
