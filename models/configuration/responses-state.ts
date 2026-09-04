type UnknownRecord = Record<string, unknown>

export type ResponsesStateMode = "auto" | "local" | "previous_response_id"

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

/** Responses 上下文归属是模型级选择；未知值使用自动恢复模式。 */
export function responsesStateMode(modelConfig: unknown = {}): ResponsesStateMode {
  const value = text(record(record(modelConfig).responses).stateMode)
  if (value === "local" || value === "previous_response_id") return value
  return "auto"
}

/** 自动与严格上游模式都会建立 Response ID 链；只有自动模式允许一般断链恢复。 */
export function responsesUsesUpstreamState(mode: ResponsesStateMode): boolean {
  return mode !== "local"
}

export function responsesAllowsStateRecovery(mode: ResponsesStateMode): boolean {
  return mode === "auto"
}

/** 同一个本地会话可能 fallback 到不同渠道，上游链必须按实际渠道与模型隔离。 */
export function responsesStateKey(channel: unknown = {}): string {
  const value = record(channel)
  const provider = record(value.provider)
  return [
    text(value.id || record(value.modelConfig).name || "responses"),
    text(provider.name || record(value.modelConfig).apiProvider),
    text(value.model || record(value.modelConfig).modelIdentifier),
  ].map(part => part.trim()).join("|")
}
