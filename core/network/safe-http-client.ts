import * as http from "node:http"
import * as https from "node:https"
import { assertSafeHttpUrl, lookupSafeHttpAddress } from "./link-safety-policy.js"

export interface SafeHttpOptions {
  method?: string
  headers?: HeadersInit
  allowPrivateHosts?: boolean
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  maxUrlLength?: number
  signal?: AbortSignal
}

export interface SafeHttpResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Headers
  redirected: boolean
  url: string
  arrayBuffer(): Promise<ArrayBuffer>
  json(): Promise<unknown>
  text(): Promise<string>
}

type BufferLike = Uint8Array & {
  toString(encoding?: string): string
}

type IncomingMessage = http.IncomingMessage
type RequestOptions = http.RequestOptions
type ClientRequest = http.ClientRequest
type HttpTransport = typeof http.request

interface RedirectResult {
  response: IncomingMessage
  location?: string
  bytes?: BufferLike
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function bufferFactory(): {
  from(value: unknown, encoding?: string): BufferLike
  concat(values: BufferLike[]): BufferLike
  alloc(size: number): BufferLike
} | null {
  const value = (globalThis as typeof globalThis & {
    Buffer?: {
      from(input: unknown, encoding?: string): BufferLike
      concat(values: BufferLike[]): BufferLike
      alloc(size: number): BufferLike
    }
  }).Buffer
  return value || null
}

function bufferFrom(value: unknown): BufferLike {
  const factory = bufferFactory()
  if (factory) return factory.from(value)
  if (value instanceof Uint8Array) return value as BufferLike
  return new Uint8Array(0) as BufferLike
}

function bufferConcat(values: BufferLike[]): BufferLike {
  const factory = bufferFactory()
  if (factory) return factory.concat(values)
  const total = values.reduce((sum, value) => sum + value.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.byteLength
  }
  return result as BufferLike
}

function requestHeaders(value: HeadersInit = {}): Record<string, string> {
  const headers: Record<string, string> = {}
  const entries = value instanceof Headers ? value.entries() : Object.entries(value)
  for (const [key, item] of entries) if (item !== undefined && item !== null) headers[text(key).toLowerCase()] = text(item)
  headers["accept-encoding"] ||= "identity"
  return headers
}

function responseHeaders(value: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers()
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) item.forEach(entry => headers.append(key, entry))
    else if (item !== undefined) headers.set(key, item)
  }
  return headers
}

function readResponse(response: IncomingMessage, maxBytes: number): Promise<BufferLike> {
  return new Promise((resolve, reject) => {
    const contentEncoding = text(response.headers["content-encoding"] || "identity").toLowerCase()
    if (contentEncoding !== "identity") {
      response.destroy()
      reject(new Error(`远程服务未遵守 identity 编码要求：${contentEncoding}`))
      return
    }
    const declaredBytes = Number(response.headers["content-length"] || 0)
    if (declaredBytes && declaredBytes > maxBytes) {
      response.destroy()
      reject(new Error(`响应大小超过限制：${maxBytes} bytes`))
      return
    }
    const chunks: BufferLike[] = []
    let total = 0
    response.on("data", chunk => {
      const bytes = bufferFrom(chunk)
      total += bytes.length
      if (total > maxBytes) {
        response.destroy(new Error(`响应大小超过限制：${maxBytes} bytes`))
        return
      }
      chunks.push(bytes)
    })
    response.once("aborted", () => reject(new Error("远程响应在完成前中断。")))
    response.once("error", reject)
    response.once("end", () => resolve(bufferConcat(chunks)))
  })
}

function requestOnce(url: URL, options: RequestOptions, signal: AbortSignal): Promise<RedirectResult> {
  return new Promise((resolve, reject) => {
    const transport: HttpTransport = url.protocol === "https:" ? https.request : http.request
    const request: ClientRequest = transport(url, {
      method: options.method,
      headers: options.headers,
      signal,
      ...(options.allowPrivateHosts ? {} : { lookup: lookupSafeHttpAddress }),
    }, async response => {
      const location = response.headers.location
      if ([301, 302, 303, 307, 308].includes(Number(response.statusCode)) && location) {
        response.resume()
        resolve({ response, location: Array.isArray(location) ? location[0] : location })
        return
      }
      try {
        resolve({ response, bytes: await readResponse(response, Number(options.maxBytes) || 1) })
      } catch (error) {
        reject(error)
      }
    })
    request.once("error", reject)
    request.end()
  })
}

function toSafeResponse(result: RedirectResult, url: URL, redirected: boolean): SafeHttpResponse {
  const bytes = result.bytes || bufferFactory()?.alloc(0) || new Uint8Array(0) as BufferLike
  const status = Number(result.response.statusCode || 0)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: http.STATUS_CODES[status] || "",
    headers: responseHeaders(result.response.headers),
    redirected,
    url: url.toString(),
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    },
    async json() {
      return JSON.parse(bytes.toString("utf8")) as unknown
    },
    async text() {
      return bytes.toString("utf8")
    },
  }
}

/** 只用于读取不可信 HTTP(S) URL：逐跳校验重定向、固定实际 DNS 解析结果，并限制总时长与响应体。 */
export async function fetchSafeHttp(inputUrl: unknown, options: SafeHttpOptions = {}): Promise<SafeHttpResponse> {
  const method = text(options.method || "GET").toUpperCase()
  if (!["GET", "HEAD"].includes(method)) throw new Error("安全 HTTP 客户端只允许 GET/HEAD。")
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 15000)
  const maxBytes = Math.max(1, Number(options.maxBytes) || 2 * 1024 * 1024)
  const maxRedirects = Math.max(0, Math.min(10, Number(options.maxRedirects ?? 5)))
  const allowPrivateHosts = options.allowPrivateHosts === true
  const controller = new AbortController()
  const abortFromExternal = (): void => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) controller.abort(options.signal.reason)
  else options.signal?.addEventListener?.("abort", abortFromExternal, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error(`请求超时：${timeoutMs}ms`)), timeoutMs)
  let headers = requestHeaders(options.headers)
  let current: URL
  let redirected = false
  try {
    current = new URL(await assertSafeHttpUrl(inputUrl, { allowPrivateHosts, maxUrlLength: options.maxUrlLength }))
    for (let count = 0; ; count += 1) {
      const result = await requestOnce(current, { allowPrivateHosts, headers, maxBytes, method }, controller.signal)
      if (!result.location) return toSafeResponse(result, current, redirected)
      if (count >= maxRedirects) throw new Error(`重定向次数超过限制：${maxRedirects}`)
      const next = new URL(await assertSafeHttpUrl(new URL(result.location, current).toString(), { allowPrivateHosts, maxUrlLength: options.maxUrlLength }))
      if (next.origin !== current.origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !["authorization", "cookie", "host", "proxy-authorization"].includes(key)))
      }
      current = next
      redirected = true
    }
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      throw new Error(reason instanceof Error ? reason.message : text(reason || `请求超时：${timeoutMs}ms`))
    }
    throw error
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener?.("abort", abortFromExternal)
  }
}
