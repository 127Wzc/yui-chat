type UnknownRecord = Record<string, unknown>

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const envReferencePattern = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** 解析显式环境变量引用；配置和接口只保存占位符，不保存运行时密钥。 */
export function resolveMcpTemplate(value: string, environment: NodeJS.ProcessEnv = process.env): string {
  return value.replace(envReferencePattern, (_match, name: string) => {
    const resolved = environment[name]
    if (typeof resolved !== "string") throw new Error(`MCP 环境变量未设置：${name}`)
    return resolved
  })
}

/** 解析 stdio 子进程环境；未引用的普通值保持兼容。 */
export function resolveMcpEnv(value: unknown, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new Error("MCP env 必须是对象")
  const result: Record<string, string> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (!envNamePattern.test(name)) throw new Error(`MCP 环境变量名无效：${name}`)
    result[name] = resolveMcpTemplate(String(raw ?? ""), environment)
  }
  return result
}

/** 解析并校验远端 HTTP 请求头；值只在创建传输时短暂存在内存。 */
export function resolveMcpHeaders(value: unknown, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new Error("MCP headers 必须是对象")
  const result: Record<string, string> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (!headerNamePattern.test(name)) throw new Error(`MCP HTTP Header 名称无效：${name}`)
    if (typeof raw !== "string") throw new Error(`MCP HTTP Header ${name} 的值必须是字符串`)
    const resolved = resolveMcpTemplate(raw, environment)
    if (/[\r\n]/.test(resolved)) throw new Error(`MCP HTTP Header ${name} 的值不能包含换行符`)
    result[name] = resolved
  }
  return result
}

export function resolveMcpUrl(value: unknown, environment: NodeJS.ProcessEnv = process.env): string {
  if (typeof value !== "string" || !value.trim()) return ""
  return resolveMcpTemplate(value.trim(), environment)
}
