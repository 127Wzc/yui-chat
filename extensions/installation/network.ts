import crypto from "node:crypto"
import { configStore } from "../../config/store.js"
import { scopedNetworkAddresses, type ScopedNetworkGrant } from "../../core/network/link-safety-policy.js"
import { credentialStore } from "../credentials.js"
import { createScopedFetch } from "../../core/network/scoped-fetch.js"

function grants(): ScopedNetworkGrant[] {
  const safety = (configStore.get().security as Record<string, unknown>)?.linkSafety as Record<string, unknown>
  return Array.isArray(safety?.extensionGrants) ? safety.extensionGrants as unknown as ScopedNetworkGrant[] : []
}
export async function createNetworkGrant(input: Record<string, unknown>): Promise<ScopedNetworkGrant> {
  const url = new URL(String(input.url || ""))
  if (url.search || url.hash || url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("授权地址无效")
  if (!["repository-fetch", "mcp-connect"].includes(String(input.purpose)) || !input.targetId) throw new Error("授权用途或目标无效")
  const grant: ScopedNetworkGrant = { id: `net_${crypto.randomUUID()}`, purpose: input.purpose as ScopedNetworkGrant["purpose"], targetId: String(input.targetId), origin: url.origin, paths: [url.pathname], addresses: Array.isArray(input.addresses) ? input.addresses.map(String) : [], allowHttpCredentials: input.allowHttpCredentials === true, version: 1, revoked: false, ...(typeof input.ca === "string" && input.ca.length < 65536 ? { ca: input.ca } : {}) }
  if (Array.isArray(input.paths)) {
    if (input.paths.length > 8 || input.paths.some(item => typeof item !== "string" || !item.startsWith("/") || item.includes("?"))) throw new Error("授权路径无效")
    grant.paths = [...new Set([...grant.paths, ...input.paths as string[]])]
  }
  if (!grant.addresses.length) throw new Error("请明确填写允许连接的 IP；授权不会自动扩大到 DNS 后续地址")
  await scopedNetworkAddresses(url, grant)
  await configStore.update(config => {
    const security = config.security as Record<string, any>
    security.linkSafety.extensionGrants.push(grant)
  })
  return grant
}
export async function revokeNetworkGrant(id: string): Promise<void> {
  await configStore.update(config => {
    const safety = (config.security as Record<string, any>).linkSafety
    safety.extensionGrants = safety.extensionGrants.map((grant: ScopedNetworkGrant) => grant.id === id ? { ...grant, revoked: true, version: grant.version + 1 } : grant)
  })
}
export function networkGrant(id: string | undefined, purpose: string, targetId: string): ScopedNetworkGrant | undefined {
  if (!id) return undefined
  const grant = grants().find(item => item.id === id)
  if (!grant || grant.revoked || grant.purpose !== purpose || grant.targetId !== targetId) throw new Error("NETWORK_GRANT_REVOKED_OR_MISMATCH")
  return grant
}
export function listNetworkGrants() { return grants() }
export function managedMcpFetch(id: string, config: Record<string, unknown>, probing = false): typeof fetch {
  if (config.transport === "stdio" || config.command || config.env || config.headers || String(config.url).includes("${env:")) throw new Error("MANAGED_MCP_BINDING_REQUIRED")
  const expectedUrl = String(config.url)
  return createScopedFetch({
    authorize: (url, grant) => {
      const expected = new URL(expectedUrl)
      if (url.origin !== expected.origin || (!grant && url.pathname !== expected.pathname)) throw new Error("NETWORK_GRANT_SCOPE_MISMATCH")
    },
    grant: async () => {
      const current = (configStore.get().mcp?.servers as Record<string, Record<string, unknown>>)?.[id]
      // Temporary discovery is allowed for saved, disabled services; deleted or changed endpoints fail closed.
      if (!current || (!probing && current.enabled !== true) || current.url !== expectedUrl || current.installationId !== config.installationId) throw new Error("MCP_CONFIGURATION_CHANGED")
      return networkGrant(String(current.networkGrantId || "") || undefined, "mcp-connect", id)
    },
    headers: async () => {
      const current = (configStore.get().mcp?.servers as Record<string, Record<string, unknown>>)?.[id]
      if (!current?.credentialId) return {}
      const result = await credentialStore.resolve(String(current.credentialId), "mcp-auth", new URL(expectedUrl).origin, id)
      const value = JSON.parse(result.value) as Record<string, string>
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(item => typeof item !== "string")) throw new Error("CREDENTIAL_HEADERS_INVALID")
      return value
    },
  })
}
