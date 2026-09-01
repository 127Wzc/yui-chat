import { logLevelPermits, type LogLevel } from "../../config/logging.js"
import { hostRuntime } from "../runtime/host-runtime.js"

type UnknownRecord = Record<string, unknown>
export interface ScopedLog {
  error(config: unknown, message: string, ...args: unknown[]): void
  warn(config: unknown, message: string, ...args: unknown[]): void
  info(config: unknown, message: string, ...args: unknown[]): void
  debug(config: unknown, message: string, ...args: unknown[]): void
}

function configLevel(config: unknown): unknown {
  const root = config && typeof config === "object" && !Array.isArray(config) ? config as UnknownRecord : {}
  const logging = root.logging && typeof root.logging === "object" && !Array.isArray(root.logging) ? root.logging as UnknownRecord : {}
  return logging.level
}

/** 统一运行日志前缀和级别筛选；不负责持久化，也不把敏感字段写入日志。 */
export function createScopedLog(scope: string): ScopedLog {
  const prefix = `[Yui-Chat][${scope}]`
  const write = (level: LogLevel, config: unknown, message: string, ...args: unknown[]): void => {
    if (!logLevelPermits(configLevel(config), level)) return
    hostRuntime.logger?.[level]?.(`${prefix} ${message}`, ...args)
  }
  const scoped: ScopedLog = {
    error: (config: unknown, message: string, ...args: unknown[]) => write("error", config, message, ...args),
    warn: (config: unknown, message: string, ...args: unknown[]) => write("warn", config, message, ...args),
    info: (config: unknown, message: string, ...args: unknown[]) => write("info", config, message, ...args),
    debug: (config: unknown, message: string, ...args: unknown[]) => write("debug", config, message, ...args),
  }
  return Object.freeze(scoped)
}
