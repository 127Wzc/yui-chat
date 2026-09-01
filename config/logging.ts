/** 日志级别的固定顺序；off 只用于关闭持久化与运行时日志筛选。 */
export const logLevels = Object.freeze(["off", "error", "warn", "info", "debug"] as const)

export type LogLevel = (typeof logLevels)[number]

/** 判断外部配置是否是受支持的日志级别。 */
export function isLogLevel(value: unknown): value is LogLevel {
  return logLevels.includes(String(value || "") as LogLevel)
}

/** 判断配置级别是否允许记录指定级别；off 和未知级别始终不放行。 */
export function logLevelPermits(configuredLevel: unknown, messageLevel: unknown): boolean {
  const configuredRank = logLevels.indexOf(String(configuredLevel || "info") as LogLevel)
  const messageRank = logLevels.indexOf(String(messageLevel || "") as LogLevel)
  return configuredRank >= messageRank && messageRank > 0
}
