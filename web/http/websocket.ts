import { configStore } from "../../config/store.js"
import { commandObserver } from "../../knowledge/command-observer.js"
import { toolRegistry } from "../../tools/support/registry.js"
import { readWebToken, validateWebToken } from "./auth.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"

type UnknownRecord = Record<string, unknown>

interface SocketLike {
  close: () => unknown
  on: (event: string, handler: (raw: unknown) => unknown) => unknown
  send?: (payload: string) => unknown
  sendMsg?: (payload: unknown) => unknown
}

interface SocketRequest {
  url?: unknown
  headers?: UnknownRecord
}

interface WebSocketHandler {
  (ws: SocketLike, req: SocketRequest): unknown
  __yuiChat?: boolean
  __yuiChatKey?: string
}

const wsHandlers = new Map<string, WebSocketHandler>()

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

export function registerWebSocket(): void {
  const bot = hostRuntime.bot
  if (!bot?.wsf) return
  const wsf = bot.wsf as Record<string, unknown>
  const mountPath = String(record(configStore.get().web).mountPath || "/yui-chat")
  const wsKey = mountPath.replace(/^\/+|\/+$/g, "") || "yui-chat"
  const wsPath = `${mountPath.replace(/\/$/, "")}/ws`
  const existing = Array.isArray(wsf[wsKey]) ? wsf[wsKey] as WebSocketHandler[] : []
  if (!Array.isArray(wsf[wsKey])) wsf[wsKey] = existing
  if (existing.some(fn => fn.__yuiChat)) return
  const handler: WebSocketHandler = (ws, req) => {
    const url = req?.url || ""
    const requestPath = String(url).split("?")[0]
    if (requestPath && requestPath !== wsPath && requestPath !== "/ws") return ws.close()
    const token = readWebToken({ headers: req?.headers })
    if (!validateWebToken(token)) return ws.close()
    sendWs(ws, { type: "hello", payload: { ok: true, stats: commandObserver.stats() } })
    ws.on("message", async raw => {
      let data: UnknownRecord = {}
      try {
        const parsed: unknown = JSON.parse(String(raw))
        data = record(parsed)
      } catch {
        sendWs(ws, { type: "error", error: "Invalid JSON" })
        return
      }
      if (data.type === "ping") sendWs(ws, { type: "pong", time: Date.now() })
      else if (data.type === "status") {
        sendWs(ws, {
          type: "status",
          payload: {
            knowledge: commandObserver.stats(),
            mcp: toolRegistry.mcpStatus(),
          },
        })
      } else sendWs(ws, { type: "echo", payload: data })
    })
  }
  handler.__yuiChat = true
  handler.__yuiChatKey = wsKey
  existing.push(handler)
  wsHandlers.set(wsKey, handler)
}

export function unregisterWebSocket(): void {
  const wsf = hostRuntime.bot?.wsf as Record<string, unknown> | undefined
  if (!wsf) return
  for (const [wsKey, handler] of wsHandlers) {
    if (Array.isArray(wsf[wsKey])) {
      wsf[wsKey] = (wsf[wsKey] as WebSocketHandler[]).filter(item => item !== handler)
    }
  }
  for (const [wsKey, handlers] of Object.entries(wsf)) {
    if (Array.isArray(handlers)) {
      wsf[wsKey] = (handlers as WebSocketHandler[]).filter(handler => !handler.__yuiChat)
    }
  }
  wsHandlers.clear()
}

function sendWs(ws: SocketLike, payload: UnknownRecord): unknown {
  if (typeof ws.sendMsg === "function") return ws.sendMsg(payload)
  return ws.send?.(JSON.stringify(payload))
}
