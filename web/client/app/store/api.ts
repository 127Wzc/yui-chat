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
    const currentToken = token()
    const { headers = {}, ...requestOptions } = options
    const res = await fetch(api(path), {
      ...requestOptions,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(currentToken ? { "yui-chat-token": currentToken } : {}),
        ...headers,
      },
    })
    const json: unknown = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
    const payload = json && typeof json === "object" && !Array.isArray(json) ? json as UnknownRecord : {}
    if (!res.ok || payload.ok === false) throw new Error(String(payload.error || "request failed"))
    return payload
  }

  return { api, request }
}
