/** 宿主事件的最小静态边界；具体 Yunzai 字段仍必须在业务边界自行收窄。 */
export interface HostEvent extends Record<string, unknown> {
  msg?: string
  raw_message?: string
  message?: unknown
  at?: unknown
  group_id?: string | number
  user_id?: string | number
  isGroup?: boolean
  reply?: (...args: unknown[]) => unknown | Promise<unknown>
}

/** Yunzai 插件构造参数的最小公共形状。 */
export interface HostPluginOptions extends Record<string, unknown> {
  name?: string
  dsc?: string
  event?: string
  priority?: number
  rule?: Array<Record<string, unknown>>
}

/** 宿主插件实例；业务入口只依赖事件和回复，不依赖 Yunzai 内部实现。 */
export interface HostPluginInstance {
  e: HostEvent
  reply: (...args: unknown[]) => unknown | Promise<unknown>
}

/** Yunzai 插件构造器的最小公共形状。 */
export interface HostPluginConstructor {
  new (options: HostPluginOptions): HostPluginInstance
}

export interface HostQuotedMessageSelection<T> {
  value: T | null
  diagnostics?: string[]
}

export interface HostQuotedMessageResult<T> {
  value: T | null
  diagnostics: string[]
}

export type HostQuotedMessageSelector<T> = (value: unknown) => HostQuotedMessageSelection<T>

export interface HostRuntime {
  readonly bot?: YuiChatHostBot
  readonly logger?: YuiChatHostLogger
  readonly segment?: YuiChatHostSegmentFactory
  readonly Plugin: HostPluginConstructor
  readQuotedMessage<T>(event: unknown, sequence: unknown, select: HostQuotedMessageSelector<T>): Promise<HostQuotedMessageResult<T>>
}

type HostRecord = Record<string, unknown>

function record(value: unknown): HostRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as HostRecord : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 将不同 Yunzai 适配器的引用读取入口收敛为单一宿主契约。
 * 业务模块只负责校验、归一化候选消息，不感知宿主方法名与参数差异。
 */
async function readQuotedMessage<T>(event: unknown, sequence: unknown, select: HostQuotedMessageSelector<T>): Promise<HostQuotedMessageResult<T>> {
  const e = record(event)
  const diagnostics: string[] = []
  const accept = (value: unknown): T | null => {
    const selected = select(value)
    if (selected.diagnostics?.length) diagnostics.push(...selected.diagnostics)
    return selected.value
  }
  const readers: Array<{ owner: HostRecord; name: string; fn: (...args: unknown[]) => unknown }> = []
  const addReader = (ownerValue: unknown, name: string): void => {
    const owner = record(ownerValue)
    const fn = owner[name]
    if (typeof fn !== "function") return
    if (readers.some(reader => reader.owner === owner && reader.name === name && reader.fn === fn)) return
    readers.push({ owner, name, fn: fn as (...args: unknown[]) => unknown })
  }

  addReader(e, "getMessage")
  addReader(e, "getMsg")
  if (e.isGroup) addReader(e.group, "getMessage")
  if (e.isGroup) addReader(e.group, "getMsg")
  if (!e.isGroup) addReader(e.friend, "getMessage")
  if (!e.isGroup) addReader(e.friend, "getMsg")
  addReader(e.bot, "getMessage")
  addReader(e.bot, "getMsg")
  addReader(record(e.bot).adapter, "getMessage")
  addReader(record(e.bot).adapter, "getMsg")

  for (const reader of readers) {
    try {
      // 已绑定到群/好友对象的方法通常只接收消息 ID；未绑定的适配器方法
      // 可能要求目标群号作为第一个参数，按函数形态兼容这两种调用。
      const args = reader.fn.length >= 2 && e.group_id
        ? [e.group_id, sequence]
        : [sequence]
      const value = accept(await reader.fn.apply(reader.owner, args))
      if (value) return { value, diagnostics }
    } catch (error) {
      diagnostics.push(`读取最新引用消息失败（${reader.name}）：${errorMessage(error)}`)
    }
  }

  try {
    const getReply = e.getReply
    if (typeof getReply === "function") {
      const value = accept(await (getReply as () => Promise<unknown>).call(event))
      if (value) return { value, diagnostics }
    }
  } catch (error) {
    diagnostics.push(`读取引用消息失败：${errorMessage(error)}`)
  }

  try {
    const owner = e.isGroup ? record(e.group) : record(e.friend)
    const getHistory = owner.getChatHistory
    if (typeof getHistory === "function") {
      const value = accept(await (getHistory as (seq: unknown, count: number) => Promise<unknown>).call(owner, sequence, 1))
      if (value) return { value, diagnostics }
    }
  } catch (error) {
    diagnostics.push(`读取历史消息失败：${errorMessage(error)}`)
  }

  return { value: null, diagnostics }
}

/** 宿主适配层：领域模块通过这里读取 Yunzai 全局对象，避免新增直接全局引用。 */
export const hostRuntime: HostRuntime = Object.freeze({
  get bot() {
    return globalThis.Bot
  },
  get logger() {
    return globalThis.logger
  },
  get segment() {
    return globalThis.segment
  },
  get Plugin(): HostPluginConstructor {
    return globalThis.plugin as HostPluginConstructor
  },
  readQuotedMessage,
})
