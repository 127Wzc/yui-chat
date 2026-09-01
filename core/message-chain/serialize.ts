import type { ContentPart, JsonValue, ToolOutput } from "./types.js"

const inlineMediaPattern = /^(?:base64:\/\/|data:[^;,]+;base64,)/i

function redactInlineMedia(value: JsonValue, key = ""): JsonValue {
  if (typeof value === "string") return key === "inlineData" || inlineMediaPattern.test(value) ? "[inline media omitted]" : value
  if (Array.isArray(value)) return value.map(item => redactInlineMedia(item, key))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, redactInlineMedia(item, childKey)]))
  }
  return value
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const items = value.map(jsonValue)
    return items.every(item => item !== undefined) ? items as JsonValue[] : undefined
  }
  if (!value || typeof value !== "object") return undefined
  const entries = Object.entries(value).map(([key, item]) => [key, jsonValue(item)] as const)
  if (entries.some(([, item]) => item === undefined)) return undefined
  return Object.fromEntries(entries) as { [key: string]: JsonValue }
}

/** 将结构化结果转成有界、可供模型读取的文本，并阻止内联媒体正文泄漏。 */
export function serializeForModel(value: unknown): string {
  if (typeof value === "string") return inlineMediaPattern.test(value) ? "[inline media omitted]" : value
  const normalized = jsonValue(value)
  if (normalized === undefined) return String(value ?? "")
  return JSON.stringify(redactInlineMedia(normalized))
}

export function serializeToolOutput(output: ToolOutput): string {
  return serializeForModel(output.structuredContent ?? output.chain)
}

export function contentPartCount(content: ContentPart[] = []): number {
  return content.length
}

export function summarizeToolOutput(output: ToolOutput): Record<string, JsonValue> {
  return {
    kind: output.kind,
    isError: output.isError,
    contentParts: output.chain.length,
    contentTypes: output.chain.map(part => part.type),
    issues: output.issues,
    ...(output.receipt ? {
      receipt: {
        id: output.receipt.id,
        status: output.receipt.status,
        partCount: output.receipt.partCount,
        sentCount: output.receipt.sentCount,
        failedCount: output.receipt.failedCount,
      },
    } : {}),
  }
}
