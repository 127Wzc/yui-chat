import { sqliteMemoryStore } from "./sqlite-store.js"
import type { UnknownRecord } from "../core/message/types.js"
import type { MemoryImageRead, MemoryImageSelection } from "./image-request.js"

type MemoryBackend = Record<string, unknown>

export interface MemoryStoreContract extends MemoryBackend {
  load(): Promise<unknown>
  listProfiles(options?: UnknownRecord): Promise<UnknownRecord[]>
  listManagedScopes(options?: UnknownRecord): Promise<UnknownRecord[]>
  getManagedScope(scopeType: unknown, ownerId: unknown): Promise<UnknownRecord>
  getMemoryDetail(input: UnknownRecord): Promise<UnknownRecord>
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
  listOwnMemories(event: unknown): Promise<{ items: UnknownRecord[]; complete: boolean; warning?: string }>
  listImageMemories(event: unknown, selection: MemoryImageSelection): Promise<MemoryImageRead>
  listMemories(event: unknown, options?: UnknownRecord): Promise<UnknownRecord[]>
  getProfile(event: unknown): Promise<{ userId: string; profile: UnknownRecord; facts: UnknownRecord[]; updatedAt?: unknown }>
  updateProfile(event: unknown, patch: UnknownRecord): Promise<{ userId: string; profile: UnknownRecord; facts?: UnknownRecord[]; updatedAt?: unknown }>
  forgetMemory(event: unknown, memoryId: unknown): Promise<UnknownRecord>
  buildPrompt(event: unknown, prompt: unknown): Promise<string>
  appendInteraction(event: unknown, prompt: unknown, response: unknown): Promise<unknown>
  flush(): Promise<unknown>
  stats(): UnknownRecord
}

/** 记忆统一使用 SQLite；数据库不可用时由存储操作报告错误。 */
export const memoryStore = sqliteMemoryStore as unknown as MemoryStoreContract
export { profileLines } from "./prompt.js"
export { scopeKey, userKey } from "./scopes.js"
