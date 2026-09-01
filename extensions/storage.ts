import fs from "node:fs/promises"
import path from "node:path"
import { dataDir } from "../config/store.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"

type UnknownRecord = Record<string, unknown>

export interface UserExtensionStorageOptions {
  domain?: unknown
  manifestFile?: unknown
  rootDir?: unknown
  seedDirs?: unknown
}

export interface UserExtensionStorage {
  domain: string
  dir: string
  manifestFile: string
  ensure(): Promise<string>
  packageDir(packageId: string): string
}

export const userExtensionsDir = path.join(dataDir, "extensions")

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && !Array.isArray(error) ? text((error as UnknownRecord).code) : ""
}

function validateDomain(domain: unknown): string {
  const value = text(domain).trim()
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error(`用户扩展数据域不合法：${text(domain)}`)
  return value
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

async function packageDirectories(sourceDir: string, manifestFile: string): Promise<Array<{ id: string; source: string }>> {
  let entries
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === "ENOENT") return []
    throw error
  }
  const packages: Array<{ id: string; source: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const source = path.join(sourceDir, entry.name)
    if (await pathExists(path.join(source, manifestFile))) packages.push({ id: entry.name, source })
  }
  return packages
}

async function copyPackage(source: string, target: string): Promise<void> {
  await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false })
}

/** 为可编辑用户扩展提供统一数据目录；seedDirs 只复制缺失的示例包。 */
export function createUserExtensionStorage(options: UserExtensionStorageOptions = {}): UserExtensionStorage {
  const domain = validateDomain(options.domain)
  const manifestFile = text(options.manifestFile).trim()
  if (!manifestFile || path.basename(manifestFile) !== manifestFile) throw new Error("manifestFile 必须是文件名")
  const rootDir = path.resolve(text(options.rootDir) || userExtensionsDir)
  const dir = path.join(rootDir, domain)
  const seedDirs = Array.isArray(options.seedDirs) ? options.seedDirs.map(value => path.resolve(text(value))) : []
  let preparation: Promise<string> | null = null

  async function transfer(sourceDir: string): Promise<void> {
    for (const item of await packageDirectories(sourceDir, manifestFile)) {
      const target = path.join(dir, item.id)
      if (await pathExists(target)) continue
      try {
        await copyPackage(item.source, target)
        hostRuntime.logger?.info?.(`[yui-chat] 已初始化用户扩展 ${domain}/${item.id}`)
      } catch (error) {
        hostRuntime.logger?.warn?.(`[yui-chat] 用户扩展处理失败 ${domain}/${item.id}`, error)
      }
    }
  }

  async function prepare(): Promise<string> {
    await fs.mkdir(dir, { recursive: true })
    for (const seedDir of seedDirs) if (seedDir !== dir) await transfer(seedDir)
    return dir
  }

  return Object.freeze({
    domain,
    dir,
    manifestFile,
    ensure(): Promise<string> {
      preparation ||= prepare().catch(error => {
        preparation = null
        throw error
      })
      return preparation
    },
    packageDir(packageId: string): string {
      return path.join(dir, packageId)
    },
  })
}
