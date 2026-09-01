import path from "node:path"
import { dataDir } from "../config/store.js"
import { AtomicJsonRepository } from "../core/storage/atomic-json-repository.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import type { UnknownRecord } from "../core/message/types.js"

type UserSettingsData = Record<string, UnknownRecord>

const settingsFile = path.join(dataDir, "users", "settings.json")

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function keyFor(event: unknown): string {
  return String(record(event).user_id || "unknown")
}

const settingsRepository = new AtomicJsonRepository<UserSettingsData>({
  file: settingsFile,
  defaultValue: {},
  normalize(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("用户设置文件必须是 JSON 对象")
    return value
  },
  onReadError(error) {
    hostRuntime.logger?.warn?.("[yui-chat] 用户设置读取失败，损坏文件已隔离并使用默认设置", error)
  },
})

class UserSettingsStore {
  private data: UserSettingsData = {}
  private loaded = false

  async load(): Promise<UserSettingsData> {
    if (this.loaded) return this.data
    this.data = await settingsRepository.load()
    this.loaded = true
    return this.data
  }

  async save(): Promise<UserSettingsData> {
    this.data = await settingsRepository.replace(this.data)
    this.loaded = true
    return this.data
  }

  async get(event: unknown, defaults: unknown = {}): Promise<UnknownRecord> {
    await this.load()
    const response = record(record(defaults).response)
    return {
      mode: response.defaultMode || "text",
      ...this.data[keyFor(event)],
    }
  }

  async set(event: unknown, patch: unknown = {}): Promise<UnknownRecord> {
    const key = keyFor(event)
    const update = record(patch)
    this.data = await settingsRepository.update(data => {
      data[key] = { ...(data[key] || {}), ...update }
    })
    this.loaded = true
    return this.data[key]
  }

  /** 管理端只需要数量摘要，不暴露用户设置正文。 */
  count(): number {
    return Object.keys(this.data).length
  }
}

export const userSettingsStore = new UserSettingsStore()
