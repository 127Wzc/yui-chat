/** 管理员显式配置的服务地址；支持 Cloud、自建服务、端口及代理路径前缀。 */
export function normalizeLangfuseBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || /[\r\n\\]/.test(value)) return null
  const candidate = value.trim()
  if (!candidate || candidate.length > 2048 || /\s/.test(candidate)) return null
  try {
    const url = new URL(candidate)
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return null
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
  } catch { return null /* 未配置/非法 URL 交给配置校验报告。 */ }
}

export function validLangfuseBaseUrl(value: unknown): boolean {
  return normalizeLangfuseBaseUrl(value) !== null
}
