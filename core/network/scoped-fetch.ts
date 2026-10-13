import * as http from "node:http"
import * as https from "node:https"
import { scopedNetworkAddresses, type ScopedNetworkGrant } from "./link-safety-policy.js"

interface ScopedFetchOptions {
  authorize?: (url: URL, grant?: ScopedNetworkGrant) => void
  grant?: () => Promise<ScopedNetworkGrant | undefined>
  headers?: () => Promise<Record<string, string>>
  maxBytes?: number
  handshakeMs?: number
  signal?: AbortSignal
}
/** Native direct sockets, pinned lookup, verified TLS, no inherited proxy and no redirect credential forwarding. */
export function createScopedFetch(options: ScopedFetchOptions): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const grant = await options.grant?.()
    options.authorize?.(url, grant)
    const addresses = await scopedNetworkAddresses(url, grant)
    const headers = new Headers(init.headers)
    if (["host", "origin", "proxy-authorization"].some(name => headers.has(name))) throw new Error("NETWORK_HEADER_FORBIDDEN")
    const authHeaders = await options.headers?.() || {}
    if (Object.keys(authHeaders).length && url.protocol === "http:" && !grant?.allowHttpCredentials) throw new Error("HTTP_CREDENTIAL_GRANT_REQUIRED")
    for (const [name, value] of Object.entries(authHeaders)) {
      if (["host", "origin", "proxy-authorization"].includes(name.toLowerCase()) || /[\r\n]/.test(value)) throw new Error("NETWORK_HEADER_FORBIDDEN")
      headers.set(name, value)
    }
    headers.set("accept-encoding", "identity")
    const controller = new AbortController()
    const signals = [init.signal, options.signal].filter(Boolean) as AbortSignal[]
    const abort = () => controller.abort()
    for (const signal of signals) { if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }) }
    const timeout = setTimeout(abort, options.handshakeMs || 30000)
    return new Promise<Response>((resolve, reject) => {
      const transport = url.protocol === "https:" ? https.request : http.request
      const request = transport(url, {
        method: init.method || "GET", headers: Object.fromEntries(headers.entries()), signal: controller.signal,
        agent: false, rejectUnauthorized: true, ...(grant?.ca ? { ca: grant.ca } : {}),
        lookup: (_hostname: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => callback(null, ...(lookupOptions?.all ? [addresses] : [addresses[0].address, addresses[0].family])),
      }, response => {
        clearTimeout(timeout)
        const cleanup = () => { for (const signal of signals) signal.removeEventListener("abort", abort) }
        response.once("close", cleanup)
        const status = Number(response.statusCode || 500)
        if (status >= 300 && status < 400) { response.destroy(); reject(new Error("NETWORK_REDIRECT_REQUIRES_REAUTHORIZATION")); return }
        if (String(response.headers["content-encoding"] || "identity") !== "identity") { response.destroy(); reject(new Error("NETWORK_ENCODING_UNSUPPORTED")); return }
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value))
        if ([204, 205, 304].includes(status) || init.method === "HEAD") { response.resume(); resolve(new Response(null, { status, headers: responseHeaders })); return }
        let size = 0
        const stream = new ReadableStream<Uint8Array>({
          start(output) {
            response.on("data", chunk => {
              size += chunk.length
              if (size > (options.maxBytes || 8 * 1024 * 1024)) { response.destroy(new Error("NETWORK_RESPONSE_LIMIT")); return }
              output.enqueue(chunk)
              response.pause()
            })
            response.once("end", () => output.close())
            response.once("error", error => output.error(new Error(controller.signal.aborted ? "NETWORK_ABORTED" : String((error as Error).message === "NETWORK_RESPONSE_LIMIT" ? "NETWORK_RESPONSE_LIMIT" : "NETWORK_STREAM_FAILED"))))
            response.once("aborted", () => output.error(new Error("NETWORK_STREAM_FAILED")))
          },
          pull() { response.resume() },
          cancel() { response.destroy(); controller.abort() },
        })
        resolve(new Response(stream, { status, headers: responseHeaders }))
      })
      request.once("error", () => { clearTimeout(timeout); for (const signal of signals) signal.removeEventListener("abort", abort); reject(new Error(controller.signal.aborted ? "NETWORK_ABORTED" : "NETWORK_CONNECT_FAILED")) })
      request.setTimeout(60000, abort)
      if (init.body !== undefined && init.body !== null) {
        if (typeof init.body !== "string" && !(init.body instanceof Uint8Array)) { request.destroy(); reject(new Error("NETWORK_BODY_UNSUPPORTED")); return }
        request.write(init.body)
      }
      request.end()
    })
  }) as typeof fetch
}
