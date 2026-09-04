import { hostRuntime } from "../runtime/host-runtime.js"
import { errorDetails, errorSummary } from "../shared/error-details.js"

export interface FetchTimeoutOptions extends RequestInit {
  timeoutMs?: number
}

export interface FetchTimeoutConsumeOptions<T = unknown> extends FetchTimeoutOptions {
  consume: (response: Response) => T | Promise<T>
}

/** 为模型和工具网络请求提供统一的超时、外部取消和响应消费边界。 */
export async function fetchWithTimeout<T>(url: string | URL, options: FetchTimeoutConsumeOptions<T>): Promise<T>
export async function fetchWithTimeout(url: string | URL, options?: FetchTimeoutOptions): Promise<Response>
export async function fetchWithTimeout<T>(url: string | URL, options: FetchTimeoutOptions & { consume?: (response: Response) => T | Promise<T> } = {}): Promise<Response | T> {
  const timeoutMs = Number(options.timeoutMs || 30000)
  const consume = typeof options.consume === "function" ? options.consume : undefined
  const controller = new AbortController()
  const externalSignal = options.signal
  const method = String(options.method || "GET").toUpperCase()
  const target = safeRequestTarget(url)
  let timedOut = false
  let responseReceived = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`Timeout after ${timeoutMs}ms`))
  }, timeoutMs)
  const abortFromExternal = (): void => controller.abort(externalSignal?.reason)
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason)
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true })
  }
  try {
    const { timeoutMs: _timeoutMs, signal: _signal, consume: _consume, ...rest } = options
    const response = await fetch(url, { ...rest, signal: controller.signal })
    responseReceived = true
    return consume ? await consume(response) : response
  } catch (error) {
    const enriched = enrichError(error, { target, method, timeoutMs, responseReceived })
    // 外部取消是业务控制流，不应伪装成网络错误；内部超时则保留明确错误码。
    if (timedOut) {
      const timeoutError = enrichError(new Error(`请求超时：${timeoutMs}ms`, { cause: error }), {
        target,
        method,
        timeoutMs,
        responseReceived,
        code: "ETIMEDOUT",
      })
      logNetworkFailure(timeoutError)
      throw timeoutError
    }
    if (externalSignal?.aborted) throw enriched
    if (!responseReceived) logNetworkFailure(enriched)
    throw enriched
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener("abort", abortFromExternal)
  }
}

function safeRequestTarget(value: string | URL): string {
  try {
    const parsed = new URL(String(value))
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 300)
  } catch {
    return String(value).replace(/[?&#].*$/, "").slice(0, 300)
  }
}

function enrichError(error: unknown, metadata: { target: string; method: string; timeoutMs: number; responseReceived: boolean; code?: string }): Error {
  const result = error instanceof Error ? error : new Error(String(error || "unknown error"))
  const current = result as Error & { yuiNetwork?: Record<string, unknown>; code?: string }
  const yuiNetwork = { target: metadata.target, method: metadata.method, timeoutMs: metadata.timeoutMs, responseReceived: metadata.responseReceived }
  try { current.yuiNetwork = yuiNetwork } catch { /* 某些第三方错误对象不可扩展，仍返回原错误。 */ }
  if (metadata.code) {
    try { current.code = metadata.code } catch { /* 仅用于诊断，无法附加时不影响调用。 */ }
  }
  return result
}

function logNetworkFailure(error: unknown): void {
  try {
    const details = errorDetails(error)
    hostRuntime.logger?.error?.(`[yui-chat] 网络请求失败 ${errorSummary(error)}`, details)
  } catch {
    // 日志本身不能再次打断模型/工具错误传播。
  }
}
