import { configStore } from "../../../config/store.js"
import { fetchSafeHttp } from "../../../core/network/safe-http-client.js"
import { credentialStore } from "../../credentials.js"
import { networkGrant } from "../network.js"
import { InstallationError, type SourceInput } from "../types.js"
import { unpackPackage, validateRelativePath, type PackageFiles, type PackageLimits } from "../validation.js"

type Provider = "github" | "gitlab" | "gitee"
export interface SourceIdentity { identity: string; provider: string; origin: string; repo?: string; apiBase?: string; url: string; ref?: string }
export function sourceIdentity(input: SourceInput): SourceIdentity {
  const raw = /^[\w.-]+\/[\w.-]+$/.test(input.source) ? `https://github.com/${input.source}` : input.source
  if (input.provider === "upload") return { identity: "upload", provider: "upload", origin: "", url: "" }
  const url = new URL(raw)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new InstallationError("SOURCE_URL_INVALID")
  const platforms = (configStore.get().installation as Record<string, any>)?.providers || []
  const match = [...platforms, { origin: "https://github.com", provider: "github", apiBase: "https://api.github.com" }, { origin: "https://gitlab.com", provider: "gitlab", apiBase: "https://gitlab.com/api/v4" }, { origin: "https://gitee.com", provider: "gitee", apiBase: "https://gitee.com/api/v5" }].find(item => item.origin === url.origin && (!input.provider || input.provider === item.provider))
  if (!match || input.provider === "archive" || /\.(zip|tar|gz|tgz|md)$/i.test(url.pathname)) return { identity: `${url.origin}${url.pathname}`, provider: "archive", origin: url.origin, url: raw }
  const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean)
  const tree = parts.findIndex(part => ["tree", "blob", "-"].includes(part))
  if (tree >= 0) throw new InstallationError("USE_REPOSITORY_URL_WITH_REF_SUBDIR")
  if (parts.length < 2 || match.provider !== "gitlab" && parts.length !== 2) throw new InstallationError("SOURCE_REPOSITORY_INVALID")
  const repo = parts.join("/")
  return { identity: `${match.origin}/${repo}`, origin: new URL(match.apiBase).origin, provider: match.provider, repo, apiBase: match.apiBase, url: raw, ref: input.ref }
}
export async function fetchSource(input: SourceInput, limits: PackageLimits, signal: AbortSignal): Promise<{ files: PackageFiles; resolvedCommit?: string; credentialVersion?: number; credentialId?: string }> {
  const source = sourceIdentity(input)
  input = { ...input }
  if (source.provider !== "upload" && !input.credentialId) input.credentialId = await credentialStore.boundCredential("repository-read", source.origin, source.identity)
  if (source.provider === "upload") {
    if (!input.upload || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.upload) || input.upload.length > Math.ceil(limits.maxDownloadBytes * 4 / 3) + 4) throw new InstallationError("UPLOAD_INVALID_OR_TOO_LARGE")
    return { files: unpackPackage(Buffer.from(input.upload, "base64"), input.source || "upload.zip", limits) }
  }
  const installation = configStore.get().installation as Record<string, any>
  const grantId = installation?.sourceGrants?.[source.identity]
  let credentialVersion: number | undefined
  let downloadedBytes = 0
  const get = async (url: string, json = true): Promise<any> => {
    let headers: Record<string, string> = { "user-agent": "yui-chat", accept: "application/json" }
    if (input.credentialId) {
      const secret = await credentialStore.resolve(input.credentialId, "repository-read", source.origin, source.identity)
      credentialVersion = secret.version
      if (source.provider === "gitlab") headers["PRIVATE-TOKEN"] = secret.value
      else if (source.provider === "archive") {
        try { headers = { ...headers, ...JSON.parse(secret.value) } } catch { throw new InstallationError("CREDENTIAL_HEADERS_INVALID") }
      } else headers.Authorization = `Bearer ${secret.value}`
    }
    if (Object.keys(headers).some(key => ["host", "origin", "proxy-authorization"].includes(key.toLowerCase())) || Object.values(headers).some(value => typeof value !== "string" || /[\r\n]/.test(value))) throw new InstallationError("CREDENTIAL_HEADERS_INVALID")
    if (input.credentialId && new URL(url).protocol === "http:" && !networkGrant(grantId, "repository-fetch", source.identity)?.allowHttpCredentials) throw new InstallationError("HTTP_CREDENTIAL_GRANT_REQUIRED")
    const response = await fetchSafeHttp(url, { headers, allowPrivateHosts: false, networkGrant: networkGrant(grantId, "repository-fetch", source.identity), maxRedirects: input.credentialId ? 0 : 3, maxBytes: limits.maxDownloadBytes - downloadedBytes, timeoutMs: 30000, signal })
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? "SOURCE_AUTH_FAILED" : response.status === 404 ? "SOURCE_NOT_FOUND_OR_NOT_AUTHORIZED" : response.status === 429 ? "SOURCE_RATE_LIMITED" : "SOURCE_UNREACHABLE"
      throw new InstallationError(code, response.status >= 500 || response.status === 429)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    downloadedBytes += bytes.length
    if (downloadedBytes > limits.maxDownloadBytes) throw new InstallationError("PACKAGE_LIMIT_EXCEEDED")
    return json ? JSON.parse(bytes.toString("utf8")) : bytes
  }
  if (source.provider === "archive") return { files: unpackPackage(await get(source.url, false), new URL(source.url).pathname, limits), credentialVersion, credentialId: input.credentialId }
  const provider = source.provider as Provider
  const repo = provider === "gitlab" ? encodeURIComponent(source.repo!) : source.repo!.split("/").map(encodeURIComponent).join("/")
  const base = provider === "gitlab" ? `${source.apiBase}/projects/${repo}/repository` : `${source.apiBase}/repos/${repo}`
  const ref = encodeURIComponent(input.ref || "HEAD")
  const commit = await get(`${base}/commits/${ref}`)
  const resolvedCommit = provider === "gitlab" ? commit.id : commit.sha
  if (typeof resolvedCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(resolvedCommit)) throw new InstallationError("SOURCE_COMMIT_INVALID")
  let tree: any[] = []
  if (provider === "gitlab") {
    for (let page = 1; ; page++) {
      if (page > 10) throw new InstallationError("PACKAGE_LIMIT_EXCEEDED")
      const entries = await get(`${base}/tree?ref=${resolvedCommit}&recursive=true&per_page=100&page=${page}`)
      if (!Array.isArray(entries)) throw new InstallationError("SOURCE_TREE_INVALID")
      tree.push(...entries)
      if (entries.length < 100) break
    }
  } else {
    const result = await get(`${base}/git/trees/${resolvedCommit}?recursive=1`)
    if (result.truncated || !Array.isArray(result.tree)) throw new InstallationError("SOURCE_TREE_TRUNCATED")
    tree = result.tree
  }
  if (tree.length > limits.maxFiles) throw new InstallationError("PACKAGE_LIMIT_EXCEEDED")
  const seen = new Set<string>()
  for (const item of tree) {
    if (seen.has(String(item.path).toLowerCase())) throw new InstallationError("DUPLICATE_PACKAGE_PATH")
    seen.add(String(item.path).toLowerCase())
    validateRelativePath(item.path, limits.maxDepth)
    if (!["040000", "100644", "100755"].includes(String(item.mode)) || !["tree", "blob"].includes(item.type)) throw new InstallationError("UNSUPPORTED_ARCHIVE_ENTRY")
  }
  const files: PackageFiles = new Map()
  let total = 0
  const candidates = tree.filter(item => item.type === "blob" && item.path.split("/").pop() === "SKILL.md")
  const roots = input.subdir !== undefined ? [input.subdir.replace(/^\.\/?/, "")] : candidates.length === 1 ? [candidates[0].path.replace(/(^|\/)SKILL\.md$/, "")] : []
  for (const item of tree.filter(item => item.type === "blob" && (roots.length ? roots.some(root => !root || item.path.startsWith(`${root}/`)) : item.path.split("/").pop() === "SKILL.md"))) {
    const blobId = provider === "gitlab" ? item.id : item.sha
    if (!/^[a-f0-9]{40,64}$/.test(blobId)) throw new InstallationError("SOURCE_BLOB_INVALID")
    const data = provider === "gitlab" ? await get(`${base}/blobs/${blobId}/raw`, false) : await get(`${base}/git/blobs/${blobId}`)
    if (provider !== "gitlab" && data.encoding !== "base64") throw new InstallationError("SOURCE_BLOB_INVALID")
    const bytes = provider === "gitlab" ? data as Buffer : Buffer.from(data.content, "base64")
    total += bytes.length
    if (total > limits.maxExpandedBytes) throw new InstallationError("PACKAGE_LIMIT_EXCEEDED")
    files.set(item.path, bytes)
  }
  return { files, resolvedCommit, credentialVersion, credentialId: input.credentialId }
}
