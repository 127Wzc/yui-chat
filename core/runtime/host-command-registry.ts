import path from "node:path"
import { pathToFileURL } from "node:url"

export interface HostCommandEntry {
  plugin: Record<string, unknown>
  class: new (...args: unknown[]) => unknown
  key: string
  name: string
  priority: number
  actionOwner?: string
}
interface Loader { priority: HostCommandEntry[] }
const owner = "yui-chat:actions"
export const actionCommandStatus = { active: 0, applied: false, error: "", appliedAt: 0 }

/** 唯一的动态宿主条目适配边界；保留第三方对象和同优先级相对顺序。 */
export function replaceActionEntries(loader: Loader, entries: HostCommandEntry[]): void {
  if (!Array.isArray(loader.priority)) throw new Error("当前宿主不支持动态动作注册")
  const next = loader.priority.filter(entry => entry.actionOwner !== owner)
  next.push(...entries.map(entry => ({ ...entry, actionOwner: owner })))
  next.sort((left, right) => Number(left.priority) - Number(right.priority))
  loader.priority = next
  Object.assign(actionCommandStatus, { active: entries.length, applied: true, error: "", appliedAt: Date.now() })
}

export async function applyHostActionEntries(root: string, entries: HostCommandEntry[]): Promise<typeof actionCommandStatus> {
  try {
    const loader = (await import(pathToFileURL(path.join(root, "lib/plugins/loader.js")).href)).default as Loader
    replaceActionEntries(loader, entries)
  } catch (error) {
    actionCommandStatus.error = error instanceof Error ? error.message : String(error)
    actionCommandStatus.applied = false
  }
  return { ...actionCommandStatus }
}
