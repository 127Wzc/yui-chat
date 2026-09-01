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

export interface HostRuntime {
  readonly bot?: YuiChatHostBot
  readonly logger?: YuiChatHostLogger
  readonly segment?: YuiChatHostSegmentFactory
  readonly Plugin: HostPluginConstructor
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
})
