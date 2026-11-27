import { redactErrorText } from "../shared/error-details.js"

type Entry = Record<string, unknown>
export type ChatProgressObserver = (event: Entry) => void
const TEXT_LIMIT = 64_000
const ENTRY_LIMIT = 128

function record(value: unknown): Entry { return value && typeof value === "object" && !Array.isArray(value) ? value as Entry : {} }

/** 进度只保留有界的展示快照；不收集协议原文、加密推理、签名和媒体字节。 */
function safe(value: unknown, key = "", depth = 0): unknown {
  if (/token|key|secret|password|credential|authorization|cookie|signature|encrypted/i.test(key) && !/^(?:maxTokens|inputTokens|outputTokens|totalTokens)$/.test(key)) return "<redacted>"
  if (depth > 10) return "[已省略]"
  if (typeof value === "string") return redactErrorText(value, TEXT_LIMIT, true).replace(/\b(?:sk|rk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]*/gi, "<redacted-token>")
  if (Array.isArray(value)) return value.slice(0, 256).map(item => safe(item, "", depth + 1))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 80).map(([name, child]) => [name, name === "value" && record(value).kind === "bytes" ? "[inline media omitted]" : safe(child, name, depth + 1)]))
  return value
}

function bounded(value: unknown, limit: number): unknown {
  const sanitized = safe(value)
  const encoded = JSON.stringify(sanitized) || ""
  return encoded.length <= limit ? sanitized : { preview: encoded.slice(0, limit), truncated: true }
}

function view(entry: Entry): Entry {
  const result = safe(entry) as Entry
  if (result.kind === "model" && typeof result.text === "string") {
    const text = String(result.text || "").trim()
    result.text = "<EMPTY>".startsWith(text) ? "" : text.replace(/^<EMPTY>|<EMPTY>$/g, "").trim()
  }
  return result
}

export function createChatProgress(observer?: ChatProgressObserver) {
  const entries = new Map<string, Entry>()
  const pending = new Set<string>()
  const publishedText = new Map<string, Entry>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  const publish = (entry: Entry, incremental = false) => {
    if (finished) return
    const id = String(entry.id)
    const content = incremental ? view({ id, kind: entry.kind, text: entry.text, reasoning: entry.reasoning }) : view(entry)
    const sent = publishedText.get(id) || {}
    const update = { ...content }
    for (const field of ["text", "reasoning"]) {
      if (typeof content[field] !== "string") continue
      if (incremental) {
        const before = String(sent[field] || ""), after = String(content[field])
        if (before === after) { delete update[field]; continue }
        let offset = 0
        while (offset < before.length && offset < after.length && before[offset] === after[offset]) offset++
        update[`${field}Offset`] = offset
        update[field] = after.slice(offset)
      }
      sent[field] = content[field]
    }
    publishedText.set(id, sent)
    if (incremental && update.text === undefined && update.reasoning === undefined) return
    try { observer?.(update) }
    catch { /* 观察端关闭或失败不改变实际模型与工具执行结果。 */ }
  }
  const flush = () => {
    clearTimeout(timer); timer = undefined
    for (const id of pending) { const item = entries.get(id); if (item) publish(item, true) }
    pending.clear()
  }
  return {
    emit(event: Entry) {
      if (!observer) return
      const type = String(event.type || "")
      const kind = type.startsWith("model-") ? "model" : "tool"
      const id = kind === "tool" ? JSON.stringify([kind, event.progressScope || event.parentToolId || "", event.round || 0, event.id]) : `${kind}:${event.id}`
      if (!entries.has(id) && entries.size >= ENTRY_LIMIT) return
      const previous = entries.get(id) || { id, kind, at: new Date().toISOString(), text: "", reasoning: "" }
      if (type === "model-delta") {
        const delta = record(event.delta)
        const field = delta.type === "reasoning" ? "reasoning" : "text"
        previous[field] = `${previous[field] || ""}${String(delta.text || "")}`.slice(0, TEXT_LIMIT)
        pending.add(id)
        if (!finished && !timer) timer = setTimeout(flush, 40)
      } else {
        if (pending.delete(id)) publish(previous, true)
        const { type: _type, id: _id, ...details } = event
        if (Array.isArray(details.tools)) details.tools = details.tools.slice(0, 80).map(value => {
          const tool = record(value)
          return { name: tool.name, description: String(tool.description || "").slice(0, 1500), parameters: bounded(tool.parameters, 3000) }
        })
        if (details.arguments) details.arguments = bounded(details.arguments, 16000)
        if (typeof details.result === "string") details.result = details.result.slice(0, 16000)
        Object.assign(previous, details, { status: type.endsWith("start") ? "running" : event.status || "ok" })
        if (typeof previous.text === "string") previous.text = previous.text.slice(0, TEXT_LIMIT)
        if (typeof previous.reasoning === "string") previous.reasoning = previous.reasoning.slice(0, TEXT_LIMIT)
        // 定义随开始/请求变更发送，结束只更新本次事件字段；不重复完整条目。
        publish({ id, kind, at: previous.at, ...details, status: previous.status })
      }
      entries.set(id, previous)
    },
    snapshot(): Entry[] {
      const result: Entry[] = []
      let size = 0
      for (const entry of entries.values()) {
        const item = view(entry)
        const length = JSON.stringify(item).length
        if (size + length > 512_000) { if (result.length) result[result.length - 1].historyTruncated = true; break }
        result.push(item); size += length
      }
      return result
    },
    finish() { flush(); finished = true },
  }
}
