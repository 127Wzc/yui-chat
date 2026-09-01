import type { RuntimeConfigRepository } from "../../config/types.js"
import type { SqliteOperation, SqliteStatus, SqliteTarget } from "./types.js"

/**
 * SQLite 客户端的业务边界。
 *
 * 上层只关心异步查询和目标库，不接触 better-sqlite3、Worker 或连接生命周期。
 */
export interface SqliteClientContract {
  init(config?: Record<string, unknown>): Promise<SqliteStatus>
  all<T = Record<string, unknown>>(sql: string, params?: unknown[], target?: SqliteTarget): Promise<T[]>
  get<T = Record<string, unknown>>(sql: string, params?: unknown[], target?: SqliteTarget): Promise<T | undefined>
  run(sql: string, params?: unknown[], target?: SqliteTarget): Promise<Record<string, unknown>>
  exec(sql: string, target?: SqliteTarget): Promise<unknown>
  transaction(operations: SqliteOperation[], target?: SqliteTarget): Promise<unknown[]>
  close(): Promise<void>
}

/** 运行配置仓库同时满足配置 Store 的抽象，便于 SQLite/文件实现替换和测试。 */
export type RuntimeConfigRepositoryContract = RuntimeConfigRepository
