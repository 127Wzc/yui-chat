import { sqliteClient } from "../core/storage/sqlite/client.js"
import type { UnknownRecord } from "../core/message/types.js"

type MemoryMethod = (...args: unknown[]) => unknown
type MemoryBackend = Record<string, unknown>

export interface MemoryStoreContract extends MemoryBackend {
  rootDir?: string
  load(): Promise<unknown>
  listProfiles(options?: UnknownRecord): Promise<UnknownRecord[]>
  listManagedScopes(options?: UnknownRecord): Promise<UnknownRecord[]>
  getManagedScope(scopeType: unknown, ownerId: unknown): Promise<UnknownRecord>
  saveManagedMemory(input: UnknownRecord): Promise<UnknownRecord>
  deleteManagedMemory(scopeType: unknown, ownerId: unknown, memoryId: unknown): Promise<UnknownRecord>
  getGroupWorkspace(groupId: unknown, options?: UnknownRecord): Promise<UnknownRecord>
  getGroupMemberWorkspace(groupId: unknown, userId: unknown, options?: UnknownRecord): Promise<UnknownRecord>
  saveScopedMemory(input: UnknownRecord): Promise<UnknownRecord>
  deleteScopedMemory(input: UnknownRecord): Promise<UnknownRecord>
  setProfile(userId: unknown, profile: unknown, options?: UnknownRecord): Promise<UnknownRecord>
  updateMemory(userId: unknown, memoryId: unknown, patch: UnknownRecord): Promise<UnknownRecord>
  addFact(event: unknown, text: unknown, options?: UnknownRecord): Promise<UnknownRecord>
  search(event: unknown, query: unknown, limit?: unknown): Promise<UnknownRecord[]>
  listMemories(event: unknown, options?: UnknownRecord): Promise<UnknownRecord[]>
  getProfile(event: unknown): Promise<{ userId: string; profile: UnknownRecord; facts: UnknownRecord[]; updatedAt?: unknown }>
  updateProfile(event: unknown, patch: UnknownRecord): Promise<{ userId: string; profile: UnknownRecord; facts?: UnknownRecord[]; updatedAt?: unknown }>
  forgetMemory(event: unknown, memoryId: unknown): Promise<UnknownRecord>
  buildPrompt(event: unknown, prompt: unknown): Promise<string>
  appendInteraction(event: unknown, prompt: unknown, response: unknown): Promise<unknown>
  flush(): Promise<unknown>
  stats(): UnknownRecord
}

type PromptModule = {
  profileLines(profile?: unknown): string[]
}

type ScopeModule = {
  scopeKey(event?: unknown): string
  userKey(event?: unknown): string
}

function loadModule<T>(specifier: string): Promise<T> {
  return import(specifier) as unknown as Promise<T>
}

// 文件和 SQLite 后端仍保留各自的存储生命周期；总入口只在这里选择当前可用后端。
const [{ fileMemoryStore }, { sqliteMemoryStore }, promptModule, scopeModule] = await Promise.all([
  loadModule<{ fileMemoryStore: MemoryBackend }>("./file-store.js"),
  loadModule<{ sqliteMemoryStore: MemoryBackend }>("./sqlite-store.js"),
  loadModule<PromptModule>("./prompt.js"),
  loadModule<ScopeModule>("./scopes.js"),
])

function active(): MemoryBackend {
  return sqliteClient.status.available ? sqliteMemoryStore : fileMemoryStore
}

function bind(value: unknown, target: MemoryBackend): unknown {
  return typeof value === "function" ? (value as MemoryMethod).bind(target) : value
}

/**
 * 记忆后端门面：根据 SQLite 状态选择持久化实现，并保持既有方法调用形状。
 * 不负责事实抽取、向量检索或文件写入；这些职责分别属于两个后端和检索模块。
 */
export const memoryStore: MemoryStoreContract = new Proxy({} as MemoryStoreContract, {
  get(_target, property: string | symbol): unknown {
    const backend = active()
    return bind(backend[property as string], backend)
  },
  set(_target, property: string | symbol, value: unknown): boolean {
    active()[property as string] = value
    return true
  },
})

export const profileLines = promptModule.profileLines
export const scopeKey = scopeModule.scopeKey
export const userKey = scopeModule.userKey
