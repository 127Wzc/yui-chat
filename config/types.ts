import type { JsonValue } from "../core/message-chain/types.js"

/** 运行配置的 JSON 结构；尚未迁移的配置分支通过 JSON 值保留扩展性。 */
export interface RuntimeConfigObject {
  version?: string
  web?: Record<string, JsonValue>
  storage?: Record<string, JsonValue>
  chat?: Record<string, JsonValue>
  persona?: Record<string, JsonValue>
  response?: Record<string, JsonValue>
  tools?: Record<string, JsonValue>
  mcp?: Record<string, JsonValue>
  memory?: Record<string, JsonValue>
  knowledge?: Record<string, JsonValue>
  apiProviders?: Array<Record<string, JsonValue>>
  models?: Array<Record<string, JsonValue>>
  modelTasks?: Record<string, JsonValue>
  [key: string]: JsonValue | undefined
}

/** 配置存储层的只读快照，业务模块不能直接修改。 */
export type RuntimeConfigSnapshot = Readonly<RuntimeConfigObject>

/** 配置更新器只接收最新快照，避免并发请求覆盖较新的配置。 */
/** 更新器可以原地修改草稿，也可以返回新的配置；两种形式都由 Store 统一保存。 */
export type RuntimeConfigUpdater = (current: RuntimeConfigObject) => RuntimeConfigObject | void | Promise<RuntimeConfigObject | void>

/** SQLite 或文件配置仓库保存的稀疏覆盖项。 */
export interface RuntimeConfigStorageState {
  exists: boolean
  schemaVersion: number
  revision: number
  overrides: RuntimeConfigObject
  updatedAt: number
}

/** 配置仓库的最小协议，配置 Store 不依赖具体 SQLite 实现。 */
export interface RuntimeConfigRepository {
  load(): Promise<RuntimeConfigStorageState>
  save(overrides: RuntimeConfigObject): Promise<RuntimeConfigStorageState>
}

/** 配置发布后的观察钩子；钩子不能反向修改快照。 */
export type ConfigPublishHook = (snapshot: RuntimeConfigSnapshot) => void

/** 配置 Store 对外暴露的只读和事务更新能力。 */
export interface ConfigStoreContract {
  get(): RuntimeConfigSnapshot
  getPublic(): RuntimeConfigObject
  load(): Promise<RuntimeConfigObject>
  update(updater: RuntimeConfigUpdater, options?: ConfigSaveOptions): Promise<RuntimeConfigSnapshot>
  save(nextConfig?: RuntimeConfigObject, options?: ConfigSaveOptions): Promise<RuntimeConfigSnapshot>
  validate(nextConfig?: RuntimeConfigObject): { ok: boolean; issues?: unknown[]; errors?: unknown[]; warnings?: unknown[] }
  meta(): ConfigStoreMeta
  attachRuntimeConfigRepository(repository: RuntimeConfigRepository): Promise<RuntimeConfigSnapshot>
}

/** 保存选项；不包含任何隐式备份行为。 */
export interface ConfigSaveOptions {
  lastLoadError?: Record<string, JsonValue>
}

/** 配置 Store 的诊断元数据。 */
export interface ConfigStoreMeta {
  loaded: boolean
  runtimeRoot: string
  configFile: string
  configBackupDir: string
  configFileMtimeMs: number
  lastReloadedAt: string
  lastLoadError: Record<string, JsonValue> | null
  revision: number
  runtimeConfigBackend: "json" | "sqlite"
  runtimeConfigAttached: boolean
}
