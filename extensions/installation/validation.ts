import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { gunzipSync, inflateRawSync } from "node:zlib"
import { parseSkillMarkdown } from "../../skills/index.js"
import { InstallationError } from "./types.js"

export interface PackageLimits { maxDownloadBytes: number; maxExpandedBytes: number; maxFiles: number; maxDepth: number }
export const packageDefaults: PackageLimits = { maxDownloadBytes: 20 * 1024 * 1024, maxExpandedBytes: 80 * 1024 * 1024, maxFiles: 1000, maxDepth: 12 }
export function digest(bytes: string | Uint8Array): string { return crypto.createHash("sha256").update(bytes).digest("hex") }
export function validateRelativePath(value: string, maxDepth = 12): string {
  if (!value || value.length > 512 || value.includes("\\") || value.startsWith("/") || /[\x00-\x1f:]/.test(value) || value.split("/").some(part => !part || [".", ".."].includes(part)) || value.split("/").length > maxDepth) throw new InstallationError("UNSAFE_PACKAGE_PATH")
  if (value.split("/").some(part => /^\.env(?:\.|$)|^id_(?:rsa|ed25519)$|^\.git$|^\.ssh$|\.pem$|\.key$/i.test(part))) throw new InstallationError("SENSITIVE_PACKAGE_FILE")
  return value
}
export function validateTargetId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value) || ["constructor", "prototype", "__proto__"].includes(value)) throw new InstallationError("INVALID_TARGET_ID")
  return value
}
export type PackageFiles = Map<string, Buffer>
function addFile(files: PackageFiles, name: string, bytes: Buffer, limits: PackageLimits): void {
  validateRelativePath(name, limits.maxDepth)
  if ([...files.keys()].some(key => key.toLowerCase() === name.toLowerCase() || key.startsWith(`${name}/`) || name.startsWith(`${key}/`))) throw new InstallationError("DUPLICATE_PACKAGE_PATH")
  if (bytes.includes(Buffer.from("-----BEGIN PRIVATE KEY-----")) || bytes.toString("utf8", 0, 80).startsWith("version https://git-lfs.github.com/spec/v1")) throw new InstallationError("UNSUPPORTED_PACKAGE_CONTENT")
  if (files.size >= limits.maxFiles || [...files.values()].reduce((sum, item) => sum + item.length, bytes.length) > limits.maxExpandedBytes) throw new InstallationError("PACKAGE_LIMIT_EXCEEDED")
  files.set(name, bytes)
}
/** Decode only regular tar/zip entries. No extraction process or package code is executed. */
export function unpackPackage(input: Uint8Array, filename: string, limits = packageDefaults): PackageFiles {
  if (input.length > limits.maxDownloadBytes) throw new InstallationError("PACKAGE_LIMIT_EXCEEDED")
  let bytes = Buffer.from(input)
  const files: PackageFiles = new Map()
  if (filename.endsWith("SKILL.md")) { addFile(files, "SKILL.md", bytes, limits); return files }
  if (bytes.readUInt16LE(0) === 0x8b1f) bytes = gunzipSync(bytes, { maxOutputLength: limits.maxExpandedBytes + 1024 * 1024 })
  if (bytes.readUInt32LE(0) === 0x04034b50) {
    // Central directory is authoritative; reject unsupported ZIP64, encryption and link modes.
    let end = bytes.length - 22
    while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new InstallationError("INVALID_ARCHIVE")
    const count = bytes.readUInt16LE(end + 10)
    if (count > limits.maxFiles + 100 || count === 65535) throw new InstallationError("PACKAGE_LIMIT_EXCEEDED")
    let offset = bytes.readUInt32LE(end + 16)
    const seen = new Set<string>()
    for (let index = 0; index < count; index++) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new InstallationError("INVALID_ARCHIVE")
      const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10)
      const size = bytes.readUInt32LE(offset + 24), compressed = bytes.readUInt32LE(offset + 20)
      const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32)
      const mode = bytes.readUInt32LE(offset + 38) >>> 16
      const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength)
      validateRelativePath(name.replace(/\/$/, ""), limits.maxDepth)
      if (seen.has(name.toLowerCase())) throw new InstallationError("DUPLICATE_PACKAGE_PATH")
      seen.add(name.toLowerCase())
      if (flags & 1 || ![0, 8].includes(method) || (mode & 0xf000) && ![0x8000, 0x4000].includes(mode & 0xf000)) throw new InstallationError("UNSUPPORTED_ARCHIVE_ENTRY")
      const local = bytes.readUInt32LE(offset + 42)
      if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== method) throw new InstallationError("INVALID_ARCHIVE")
      const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28)
      if (bytes.toString("utf8", local + 30, local + 30 + localNameLength) !== name) throw new InstallationError("INVALID_ARCHIVE")
      const start = local + 30 + localNameLength + localExtraLength
      if (start + compressed > offset || size > limits.maxExpandedBytes) throw new InstallationError("PACKAGE_LIMIT_EXCEEDED")
      const content = method === 0 ? bytes.subarray(start, start + compressed) : inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: Math.max(1, size) })
      if (content.length !== size) throw new InstallationError("INVALID_ARCHIVE")
      if (!name.endsWith("/")) addFile(files, name, content, limits)
      offset += 46 + nameLength + extraLength + commentLength
    }
  } else {
    let offset = 0, entries = 0
    const seen = new Set<string>()
    while (offset + 512 <= bytes.length && bytes[offset] !== 0) {
      if (++entries > limits.maxFiles + 100) throw new InstallationError("PACKAGE_LIMIT_EXCEEDED")
      const header = bytes.subarray(offset, offset + 512)
      const field = (start: number, length: number) => header.toString("utf8", start, start + length).split("\0")[0]
      const name = [field(345, 155), field(0, 100)].filter(Boolean).join("/").replace(/\/$/, "")
      validateRelativePath(name, limits.maxDepth)
      if (seen.has(name.toLowerCase())) throw new InstallationError("DUPLICATE_PACKAGE_PATH")
      seen.add(name.toLowerCase())
      const checksum = parseInt(field(148, 8).trim(), 8)
      if (header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0) !== checksum) throw new InstallationError("INVALID_ARCHIVE")
      const size = parseInt(field(124, 12).trim() || "0", 8)
      if (!Number.isFinite(size) || size < 0 || size > limits.maxExpandedBytes || offset + 512 + size > bytes.length) throw new InstallationError("PACKAGE_LIMIT_EXCEEDED")
      const type = field(156, 1)
      if (!["", "0", "5"].includes(type) || field(157, 100)) throw new InstallationError("UNSUPPORTED_ARCHIVE_ENTRY")
      if (type !== "5") addFile(files, name, bytes.subarray(offset + 512, offset + 512 + size), limits)
      offset += 512 + Math.ceil(size / 512) * 512
    }
  }
  if (!files.size) throw new InstallationError("EMPTY_OR_UNSUPPORTED_ARCHIVE")
  return files
}
export function selectSkill(files: PackageFiles, subdir?: string): { targetId: string; files: PackageFiles; candidates: string[] } {
  const candidates = [...files.keys()].filter(file => path.posix.basename(file) === "SKILL.md").map(file => path.posix.dirname(file))
  const chosen = subdir === undefined ? (candidates.length === 1 ? candidates[0] : undefined) : subdir || "."
  if (!chosen || !candidates.includes(chosen)) return { targetId: "", files: new Map(), candidates }
  const source = files.get(chosen === "." ? "SKILL.md" : `${chosen}/SKILL.md`)!
  const parsed = parseSkillMarkdown(source.toString("utf8"))
  if (!parsed.validation.ok) throw new InstallationError("INVALID_SKILL_MANIFEST")
  const prefix = chosen === "." ? "" : `${chosen}/`
  return { targetId: validateTargetId(parsed.metadata.name), files: new Map([...files].filter(([file]) => file.startsWith(prefix)).map(([file, bytes]) => [file.slice(prefix.length), bytes])), candidates }
}
export async function fileManifest(dir: string, limits = packageDefaults): Promise<Array<{ path: string; bytes: number; digest: string }>> {
  const files: PackageFiles = new Map()
  async function walk(folder: string, prefix = ""): Promise<void> {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name
      validateRelativePath(name, limits.maxDepth)
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), `${name}/`)
      else if (entry.isFile()) addFile(files, name, Buffer.from(await fs.readFile(path.join(folder, entry.name))), limits)
      else throw new InstallationError("UNSUPPORTED_ARCHIVE_ENTRY")
    }
  }
  await walk(dir)
  return [...files].map(([file, bytes]) => ({ path: file, bytes: bytes.length, digest: digest(bytes) })).sort((a, b) => a.path.localeCompare(b.path))
}
