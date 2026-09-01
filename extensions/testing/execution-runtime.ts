type UnknownRecord = Record<string, unknown>

interface SchemaField extends UnknownRecord {
  type?: string
  enum?: unknown[]
  minimum?: number
  maximum?: number
  description?: string
  default?: unknown
}

interface JsonSchema extends UnknownRecord {
  properties?: Record<string, SchemaField>
  required?: unknown[]
}

interface ExecutionContext extends UnknownRecord {
  signal?: AbortSignal
}

interface ExecutionTestOptions {
  schema?: unknown
  args?: UnknownRecord
  execute?: (context: ExecutionContext) => unknown | Promise<unknown>
  context?: ExecutionContext
  timeoutMs?: number
}

const secretKeyPattern = /(?:token|secret|password|credential|authorization|cookie|api[_-]?key)/i

function parseShortcutValue(raw = "", quote = ""): unknown {
  if (quote === '"') return JSON.parse(`"${raw}"`)
  if (quote === "'") return raw.replace(/\\'/g, "'").replace(/\\\\/g, "\\")
  if (raw === "true") return true
  if (raw === "false") return false
  if (raw === "null") return null
  if (/^-?(?:\d+|\d*\.\d+)$/.test(raw)) return Number(raw)
  if (/^[{[]/.test(raw)) return JSON.parse(raw)
  return raw
}

export function parseTestArguments(source = ""): UnknownRecord {
  const args: UnknownRecord = {}
  const matcher = /([a-zA-Z_][a-zA-Z0-9_.-]*)=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s]+))/g
  let cursor = 0
  let count = 0
  let match: RegExpExecArray | null
  while ((match = matcher.exec(source))) {
    if (source.slice(cursor, match.index).trim()) throw new Error("快捷参数请使用 参数名=值，例如 text=你好 mode=trim")
    const key = match[1]
    if (Object.hasOwn(args, key)) throw new Error(`参数 ${key} 重复`)
    try {
      args[key] = parseShortcutValue(match[2] ?? match[3] ?? match[4] ?? "", match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : "")
    } catch {
      throw new Error(`参数 ${key} 的值无法解析；复杂对象请改用 JSON`)
    }
    cursor = matcher.lastIndex
    count++
  }
  if (!count || source.slice(cursor).trim()) throw new Error("快捷参数请使用 参数名=值，例如 text=你好 mode=trim")
  return args
}

export function parseExecutionTestPayload(message = "", command = "#yui测试工具"): { name: string; args: UnknownRecord } {
  const escaped = String(command).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = String(message || "").match(new RegExp(`^${escaped}(?:\\s+([a-zA-Z0-9_.-]+))?(?:\\s+([\\s\\S]*))?$`))
  const name = String(match?.[1] || "").trim()
  const source = String(match?.[2] || "").trim()
  if (!name) return { name: "", args: {} }
  if (source.length > 8000) throw new Error("测试参数不能超过 8000 个字符")
  if (!source) return { name, args: {} }
  let args: unknown
  try {
    args = source.startsWith("{") ? JSON.parse(source) : parseTestArguments(source)
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}；可用 text=你好 mode=trim，复杂参数再用 {"text":"你好"}`)
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("测试参数必须是 JSON 对象")
  return { name, args: args as UnknownRecord }
}

function typeMatches(value: unknown, type: unknown): boolean {
  if (!type) return true
  if (type === "array") return Array.isArray(value)
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value)
  if (type === "integer") return typeof value === "number" && Number.isInteger(value)
  return typeof value === type
}

// 命令和 Web 试跑只做最基础的参数引导校验；实际执行仍由实现自身完成最终校验。
export function validateExecutionArguments(schema: unknown = {}, args: UnknownRecord = {}): UnknownRecord {
  const normalized = schema && typeof schema === "object" && !Array.isArray(schema) ? schema as JsonSchema : {}
  const properties = normalized.properties || {}
  const required = new Set(Array.isArray(normalized.required) ? normalized.required.map(String) : [])
  const issues: string[] = []
  for (const name of required) {
    if (args[name] === undefined || args[name] === "") issues.push(`${name} 为必填项`)
  }
  for (const [name, value] of Object.entries(args || {})) {
    const field = properties[name]
    if (!field || value === undefined || value === null) continue
    if (!typeMatches(value, field.type)) {
      issues.push(`${name} 必须是 ${field.type}`)
      continue
    }
    if (Array.isArray(field.enum) && !field.enum.includes(value)) issues.push(`${name} 不在允许值范围内`)
    if (typeof value === "number" && field.minimum !== undefined && value < field.minimum) issues.push(`${name} 不能小于 ${field.minimum}`)
    if (typeof value === "number" && field.maximum !== undefined && value > field.maximum) issues.push(`${name} 不能大于 ${field.maximum}`)
  }
  if (issues.length) throw new Error(`参数校验失败：${issues.join("；")}`)
  return args
}

function redactValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (secretKeyPattern.test(key)) return "********"
  if (value === null || value === undefined || typeof value !== "object") {
    if (typeof value === "bigint") return value.toString()
    return value
  }
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Buffer.isBuffer(value)) return { type: "Buffer", bytes: value.length }
  if (Array.isArray(value)) return value.map(item => redactValue(item, "", seen))
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item, name, seen)]))
}

export function serializeExecutionResult(result: unknown, maxChars = 6000): string {
  let serialized: string
  if (typeof result === "string") serialized = result
  else {
    try { serialized = JSON.stringify(redactValue(result), null, 2) || "" } catch { serialized = String(result) }
  }
  return serialized.length > maxChars ? `${serialized.slice(0, maxChars)}\n…（结果已截断）` : serialized
}

export function formatExecutionParameterGuide({ kind = "工具", name = "", schema = {}, testCommand = "" }: { kind?: string; name?: unknown; schema?: unknown; testCommand?: string } = {}): string {
  const normalized = schema && typeof schema === "object" && !Array.isArray(schema) ? schema as JsonSchema : {}
  const properties = normalized.properties || {}
  const required = new Set(Array.isArray(normalized.required) ? normalized.required.map(String) : [])
  const entries = Object.entries(properties)
  if (!entries.length) return `${kind} ${name} 无需额外参数。${testCommand ? `\n测试：${testCommand}` : ""}`
  const lines = entries.map(([fieldName, field = {}]) => {
    const type = field.type || "string"
    const state = required.has(fieldName) ? "必填" : "可选"
    const enumText = Array.isArray(field.enum) && field.enum.length ? `；可选：${field.enum.join(" / ")}` : ""
    return `- ${fieldName}（${type}，${state}）${field.description ? `：${field.description}` : ""}${enumText}`
  })
  const example = entries.map(([fieldName, field = {}]) => {
    const value = field.default ?? field.enum?.[0] ?? (field.type === "boolean" ? true : field.type === "number" || field.type === "integer" ? 1 : "示例")
    return `${fieldName}=${String(value)}`
  }).join(" ")
  return `${kind} ${name} 参数：\n${lines.join("\n")}\n${testCommand ? `快捷测试：${testCommand} ${example}\n复杂对象仍可用 JSON：${testCommand} {"参数名":"值"}` : ""}`
}

export async function runExecutionTest({ schema = {}, args = {}, execute, context = {}, timeoutMs = 15000 }: ExecutionTestOptions = {}): Promise<{ result: unknown; durationMs: number; serialized: string }> {
  if (typeof execute !== "function") throw new Error("测试执行函数不可用")
  validateExecutionArguments(schema, args)
  const controller = new AbortController()
  const safeTimeout = Math.max(1000, Math.min(30000, Number(timeoutMs) || 15000))
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      execute({ ...context, signal: context.signal || controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`测试超过 ${safeTimeout}ms`))
          reject(new Error(`测试超过 ${safeTimeout}ms`))
        }, safeTimeout)
      }),
    ])
    return { result, durationMs: Date.now() - startedAt, serialized: serializeExecutionResult(result) }
  } finally {
    clearTimeout(timer)
  }
}
