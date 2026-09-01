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
  const timeout = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
  const abortFromExternal = (): void => controller.abort(externalSignal?.reason)
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason)
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true })
  }
  try {
    const { timeoutMs: _timeoutMs, signal: _signal, consume: _consume, ...rest } = options
    const response = await fetch(url, { ...rest, signal: controller.signal })
    return consume ? await consume(response) : response
  } catch (error) {
    if (controller.signal.aborted) throw new Error(error instanceof Error ? error.message : `请求超时：${timeoutMs}ms`)
    throw error
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener("abort", abortFromExternal)
  }
}
