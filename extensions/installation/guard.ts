const locks = new Map<string, Promise<unknown>>()
const isolated = new Set<string>()

/** All managed writes, including existing editors, share this process-local lock. */
export async function withExtensionLock<T>(kind: string, id: string, work: () => Promise<T>): Promise<T> {
  const key = `${kind}:${id}`
  const previous = locks.get(key) || Promise.resolve()
  const next = previous.catch(() => { /* A failed prior operation does not poison the lock. */ }).then(work)
  locks.set(key, next)
  try { return await next } finally { if (locks.get(key) === next) locks.delete(key) }
}

export function resetExtensionIsolation(): void { isolated.clear() }

export function isolateExtension(kind: string, id: string, value = true): void {
  if (value) isolated.add(`${kind}:${id}`)
  else isolated.delete(`${kind}:${id}`)
}

export function extensionIsolated(kind: string, id: string): boolean { return isolated.has(`${kind}:${id}`) }

export function assertExtensionWritable(kind: string, id: string): void {
  if (extensionIsolated(kind, id)) throw new Error("扩展正在提交或等待恢复，请先处理安装记录。")
}
