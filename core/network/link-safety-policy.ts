import dns from "node:dns/promises"
import net from "node:net"

export interface SafeUrlOptions {
  allowPrivateHosts?: boolean
  maxUrlLength?: number
}

export interface TrustedResourceRequest {
  policyId: string
  url: string
  allowPrivateHosts: boolean
}

export interface LinkSafetyConfig {
  allowPrivateHosts: boolean
  trustedPrivateDnsBypass: boolean
  screenshotAllowedHosts: readonly unknown[]
}

interface TrustedResourcePolicy {
  targets: readonly string[]
  privateDnsEligible: boolean
}

/**
 * 可信资源的域名/IP 只在这里维护。域名覆盖自身及子域名，IP 只精确匹配。
 * 私网 DNS 例外由 security.linkSafety 统一授权。
 */
export const trustedResourcePolicies: Readonly<Record<string, TrustedResourcePolicy>> = Object.freeze({
  "bilibili-cdn": Object.freeze({ targets: Object.freeze(["hdslb.com"]), privateDnsEligible: true }),
  "bilibili-page": Object.freeze({ targets: Object.freeze(["bilibili.com", "bilivideo.com"]), privateDnsEligible: false }),
  "qq-media": Object.freeze({ targets: Object.freeze(["qq.com.cn"]), privateDnsEligible: true }),
})

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function record(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 唯一的运行时链接安全配置入口。 */
export function linkSafetyConfig(config: unknown = {}): LinkSafetyConfig {
  const root = record(config)
  const safety = record(record(root.security).linkSafety)
  return {
    allowPrivateHosts: safety.allowPrivateHosts !== false,
    trustedPrivateDnsBypass: safety.trustedPrivateDnsBypass !== false,
    screenshotAllowedHosts: Array.isArray(safety.screenshotAllowedHosts) ? safety.screenshotAllowedHosts : ["*"],
  }
}

function normalizeHost(value: unknown): string {
  return text(value).trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b, c] = parts
  return (
    a === 0
    || a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0 || b === 2 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  )
}

function isPrivateIpv6(value: string): boolean {
  const lower = value.toLowerCase()
  return lower === "::"
    || lower === "::1"
    || lower.startsWith("::ffff:")
    || lower.startsWith("fc")
    || lower.startsWith("fd")
    || /^fe[89ab]/.test(lower)
    || lower.startsWith("ff")
    || lower.startsWith("2001:db8:")
}

export function isPrivateIp(value: unknown): boolean {
  const normalized = normalizeHost(value)
  if (net.isIPv4(normalized)) return isPrivateIpv4(normalized)
  if (net.isIPv6(normalized)) return isPrivateIpv6(normalized)
  return false
}

export function matchesHostTarget(hostname: string, targets: readonly string[]): boolean {
  const host = normalizeHost(hostname)
  return targets.some(value => {
    const target = normalizeHost(value)
    if (!target) return false
    return net.isIP(target) ? host === target : host === target || host.endsWith(`.${target}`)
  })
}

/** URL 截图允许列表中的全域、精确域名或子域通配模式校验。 */
export function isValidAllowedHostPattern(value: unknown = ""): boolean {
  const pattern = text(value).trim()
  if (pattern === "*") return true
  if (!pattern || pattern.length > 253 || /[\s/:@?#]/.test(pattern)) return false
  const hostname = pattern.startsWith("*.") ? pattern.slice(2) : pattern
  if (!hostname || hostname.endsWith(".")) return false
  return hostname.split(".").every(label => (
    label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ))
}

/** URL 截图允许列表：`*` 匹配全部，普通域名精确匹配，`*.example.com` 只匹配子域名。 */
export function matchesAllowedHost(hostname: unknown, allowedHosts: readonly unknown[] = []): boolean {
  const host = normalizeHost(hostname)
  if (!host || !Array.isArray(allowedHosts)) return false
  return allowedHosts.some(value => {
    const pattern = normalizeHost(value)
    if (!pattern) return false
    if (pattern === "*") return true
    if (!pattern.startsWith("*.")) return host === pattern
    const suffix = pattern.slice(2)
    return Boolean(suffix) && host !== suffix && host.endsWith(`.${suffix}`)
  })
}

export function parseHttpUrl(value: unknown): URL | null {
  try {
    const url = new URL(text(value).trim())
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null
    return url
  } catch {
    // 可选可信匹配失败后仍由通用 URL 校验返回稳定的错误信息。
    return null
  }
}

export function resolveTrustedResourceRequest(value: string, policyIds: readonly string[] = Object.keys(trustedResourcePolicies), config: unknown = {}): TrustedResourceRequest | null {
  const url = parseHttpUrl(value)
  if (!url) return null
  const safety = linkSafetyConfig(config)
  for (const policyId of policyIds) {
    const policy = trustedResourcePolicies[policyId]
    if (policy && matchesHostTarget(url.hostname, policy.targets)) {
      return {
        policyId,
        url: url.toString(),
        allowPrivateHosts: safety.allowPrivateHosts || (safety.trustedPrivateDnsBypass && policy.privateDnsEligible),
      }
    }
  }
  return null
}

export function trustedResourceRequest(policyId: string, value: string, config: unknown = {}): TrustedResourceRequest {
  if (!trustedResourcePolicies[policyId]) throw new Error(`未知可信资源策略：${policyId}`)
  const request = resolveTrustedResourceRequest(value, [policyId], config)
  if (request) return request
  const url = parseHttpUrl(value)
  if (!url) throw new Error(`${policyId} 资源地址必须是不含凭证的 HTTP(S) URL。`)
  throw new Error(`${policyId} 资源地址不属于可信域名或 IP：${url.hostname || "unknown"}`)
}

/** 仅判断用户 URL；实际读取仍必须经过 safe-http-client。 */
export async function assertSafeHttpUrl(value: unknown = "", options: SafeUrlOptions = {}): Promise<string> {
  const raw = text(value).trim()
  const maxUrlLength = Math.max(32, Number(options.maxUrlLength) || 2048)
  const allowPrivateHosts = options.allowPrivateHosts === true
  if (!raw) throw new Error("URL 不能为空。")
  if (raw.length > maxUrlLength) throw new Error(`URL 长度超过限制：${maxUrlLength}`)
  const url = new URL(raw)
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只允许访问 http/https URL。")
  if (url.username || url.password) throw new Error("URL 不允许包含用户名或密码。")
  const hostname = normalizeHost(url.hostname)
  if (!allowPrivateHosts && (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local"))) {
    throw new Error("默认禁止访问 localhost/local 地址。")
  }
  if (!allowPrivateHosts) {
    if (isPrivateIp(hostname)) throw new Error("默认禁止访问私网 IP。")
    const records = await dns.lookup(hostname, { all: true, verbatim: true })
    if (!records.length) throw new Error("URL 主机无法解析。")
    if (records.some(item => isPrivateIp(item.address))) throw new Error("默认禁止访问解析到私网地址的 URL。")
  }
  return url.toString()
}

/** 为 HTTP 连接固定经同一策略审查的公网 DNS 结果，防止 DNS rebinding。 */
export function lookupSafeHttpAddress(hostname: string, options: unknown, callback: (...args: unknown[]) => void): void {
  const optionRecord = options && typeof options === "object" ? options as Record<string, unknown> : {}
  const family = typeof options === "number" ? options : Number(optionRecord.family) || 0
  const all = typeof options === "object" && optionRecord.all === true
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) return callback(new Error("目标地址属于本机、私网或保留地址。"))
    const item = { address: hostname, family: net.isIP(hostname) }
    return all ? callback(null, [item]) : callback(null, item.address, item.family)
  }
  dns.lookup(hostname, { all: true, verbatim: true }).then(records => {
    if (!records.length) throw new Error(`无法解析目标主机：${hostname}`)
    if (records.some(item => isPrivateIp(item.address))) throw new Error("目标主机解析到本机、私网或保留地址。")
    const eligible = family ? records.filter(item => item.family === family) : records
    if (!eligible.length) throw new Error(`目标主机没有 IPv${family} 地址：${hostname}`)
    callback(null, ...(all ? [eligible] : [eligible[0].address, eligible[0].family]))
  }).catch(callback)
}
