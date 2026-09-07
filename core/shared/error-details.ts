import type { UnknownRecord } from "../message/types.js"

const MAX_MESSAGE_LENGTH = 500
const MAX_CAUSE_DEPTH = 3
const MAX_CAUSES = 8

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

/**
 * 错误信息可能来自供应商、undici 或自定义工具，先移除凭证和过长正文，
 * 再写入控制台/SQLite。这里不接入 model-log，避免网络层与持久化层形成环。
 */
export function redactErrorText(value: unknown, limit = MAX_MESSAGE_LENGTH): string {
  return text(value)
    .replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi, "<redacted-private-key>")
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|token|secret|password|credential|authorization|cookie)(?:["']?)\s*[:=]\s*(?:["']?))[^"'\s,;}&]+/gi, "$1<redacted>")
    .replace(/([?&](?:api[_-]?key|key|access[_-]?token|token|secret|password)=)[^&#\s]+/gi, "$1<redacted>")
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1<redacted>@")
    .replace(/\s+/g, " ")
    .slice(0, Math.max(1, limit))
}

function optionalText(value: unknown): string | undefined {
  const result = redactErrorText(value, 160).trim()
  return result || undefined
}

function numberOrText(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  const result = optionalText(value)
  return result
}

function nestedError(value: unknown, depth: number): UnknownRecord | undefined {
  if (depth > MAX_CAUSE_DEPTH || value === undefined || value === null) return undefined
  const source = record(value)
  const message = optionalText(source.message || value)
  const name = optionalText(source.name)
  const code = optionalText(source.code)
  const status = numberOrText(source.status)
  const providerType = optionalText(source.providerType || source.type)
  const providerStatus = optionalText(source.providerStatus)
  const syscall = optionalText(source.syscall)
  const address = optionalText(source.address)
  const port = numberOrText(source.port)
  const network = record(source.yuiNetwork)
  const target = optionalText(network.target || source.requestTarget)
  const method = optionalText(network.method || source.requestMethod)
  const timeoutMs = numberOrText(network.timeoutMs || source.timeoutMs)
  const responseReceived = typeof network.responseReceived === "boolean"
    ? network.responseReceived
    : typeof source.responseReceived === "boolean" ? source.responseReceived : undefined
  const result: UnknownRecord = {}
  if (name) result.name = name
  if (message) result.message = message
  if (code) result.code = code
  if (status !== undefined) result.status = status
  if (providerType) result.providerType = providerType
  if (providerStatus) result.providerStatus = providerStatus
  if (syscall) result.syscall = syscall
  if (address) result.address = address
  if (port !== undefined) result.port = port
  if (target) result.target = target
  if (method) result.method = method
  if (timeoutMs !== undefined) result.timeoutMs = timeoutMs
  if (responseReceived !== undefined) result.responseReceived = responseReceived
  const cause = nestedError(source.cause, depth + 1)
  if (cause) result.cause = cause
  const errors = Array.isArray(source.errors) ? source.errors : []
  const causes = errors.slice(0, MAX_CAUSES)
    .map(item => nestedError(item, depth + 1))
    .filter((item): item is UnknownRecord => Boolean(item))
  if (causes.length) result.causes = causes
  if (errors.length > MAX_CAUSES) result.causesTruncated = true
  return Object.keys(result).length ? result : undefined
}

/**
 * 将 Error、AggregateError 和网络请求附加信息整理成可安全持久化的结构。
 * 只读取有限字段，避免把 undici 的内部对象或请求体整棵写入日志。
 */
export function errorDetails(error: unknown): UnknownRecord {
  const source = record(error)
  const result = nestedError(error, 0) || { message: "unknown error" }
  const network = record(source.yuiNetwork)
  const target = optionalText(network.target || source.requestTarget)
  const method = optionalText(network.method || source.requestMethod)
  const timeoutMs = numberOrText(network.timeoutMs || source.timeoutMs)
  const responseReceived = typeof network.responseReceived === "boolean"
    ? network.responseReceived
    : typeof source.responseReceived === "boolean" ? source.responseReceived : undefined
  if (target) result.target = target
  if (method) result.method = method
  if (timeoutMs !== undefined) result.timeoutMs = timeoutMs
  if (responseReceived !== undefined) result.responseReceived = responseReceived

  return result
}

function causeLabel(value: UnknownRecord): string {
  const name = text(value.name)
  const message = text(value.message)
  const code = text(value.code)
  const location = [text(value.address), value.port !== undefined ? text(value.port) : ""].filter(Boolean).join(":")
  const head = [name, message].filter(Boolean).join(": ") || "unknown error"
  return [head, code ? `code=${code}` : "", location ? `address=${location}` : "", value.target ? `target=${text(value.target)}` : ""].filter(Boolean).join(" ")
}

function nestedCauseLabels(value: UnknownRecord, output: string[] = [], depth = 0): string[] {
  if (depth > MAX_CAUSE_DEPTH || output.length >= MAX_CAUSES) return output
  const cause = record(value.cause)
  if (Object.keys(cause).length) {
    output.push(causeLabel(cause))
    nestedCauseLabels(cause, output, depth + 1)
  }
  for (const item of Array.isArray(value.causes) ? value.causes : []) {
    if (output.length >= MAX_CAUSES) break
    const nested = record(item)
    output.push(causeLabel(nested))
    nestedCauseLabels(nested, output, depth + 1)
  }
  return output
}

/** 适合一行控制台/普通日志的有限长度错误摘要。 */
export function errorSummary(error: unknown, limit = 1200): string {
  const details = errorDetails(error)
  const parts = [causeLabel(details)]
  if (details.status !== undefined) parts.push(`status=${text(details.status)}`)
  if (details.target) parts.push(`target=${text(details.target)}`)
  if (details.method) parts.push(`method=${text(details.method)}`)
  if (details.responseReceived !== undefined) parts.push(`response=${details.responseReceived ? "received" : "none"}`)
  if (Array.isArray(details.causes)) {
    const labels = details.causes.map(item => causeLabel(record(item))).filter(Boolean)
    if (labels.length) parts.push(`causes=[${labels.join(" | ")}]`)
  }
  const nested = nestedCauseLabels(details)
  if (nested.length) parts.push(`nested=[${nested.join(" | ")}]`)
  return redactErrorText(parts.join(" "), limit)
}
