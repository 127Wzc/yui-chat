// HTTP 客户端：封装 token / basePath / 统一错误处理。
// 后端契约不变，仅前端消费层。
type UnknownRecord = Record<string, unknown>

export interface ApiClientOptions {
  basePath?: string
  getToken?: () => string
}

export function createApiClient({
  basePath = location.pathname,
  getToken = () => "",
}: ApiClientOptions = {}) {
  const normalizedBasePath = basePath.replace(/\/$/, "")

  function api(path: string): string {
    return `${normalizedBasePath}${path}`
  }

  function token(): string {
    return getToken() || ""
  }

  async function request(path: string, options: RequestInit = {}): Promise<UnknownRecord> {
    const res = await fetchResponse(path, options)
    const json: unknown = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
    const payload = json && typeof json === "object" && !Array.isArray(json) ? json as UnknownRecord : {}
    if (!res.ok || payload.ok === false) throw new Error(String(payload.error || "request failed"))
    return payload
  }

  async function fetchResponse(path: string, options: RequestInit): Promise<Response> {
    const currentToken = token()
    const { headers = {}, ...requestOptions } = options
    return fetch(api(path), {
      ...requestOptions,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(currentToken ? { "yui-chat-token": currentToken } : {}),
        ...headers,
      },
    })
  }

  async function requestStream(path: string, options: RequestInit, onEvent: (type: string, data: UnknownRecord) => void): Promise<UnknownRecord> {
    const res = await fetchResponse(path, options)
    if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
      const payload = await res.json() as UnknownRecord
      if (!res.ok || payload.ok === false) throw new Error(String(payload.error || `HTTP ${res.status}`))
      return payload
    }
    if (!res.body) throw new Error("没有可读取的对话事件流。")
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = "", type = "", data: string[] = []
    let completed: UnknownRecord | undefined
    const dispatch = () => {
      if (!data.length) { type = ""; return }
      const payload = JSON.parse(data.join("\n")) as UnknownRecord
      const event = type
      data = []; type = ""
      if (event === "error") throw new Error(String(payload.error || "生成失败。"))
      if (event === "complete") completed = payload
      else onEvent(event, payload)
    }
    try {
      while (true) {
        const part = await reader.read()
        buffer += decoder.decode(part.value, { stream: !part.done })
        if (buffer.length + data.reduce((size, line) => size + line.length, 0) > 4 * 1024 * 1024) throw new Error("对话事件超过展示上限。")
        const lines = buffer.split(/\r?\n/)
        buffer = part.done ? "" : lines.pop() || ""
        for (const line of lines) {
          if (!line) dispatch()
          else if (line.startsWith("event:")) type = line.slice(6).trim()
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
        }
        if (part.done) { dispatch(); break }
      }
      if (!completed) throw new Error("连接提前结束，请查看本轮历史；已执行的操作不会自动重试。")
      return completed
    } finally { await reader.cancel().catch(() => { /* 连接已关闭时无需再次取消。 */ }); reader.releaseLock() }
  }

  return { api, request, requestStream }
}
