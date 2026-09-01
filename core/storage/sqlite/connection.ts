import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"

/** SQLite 连接层只接收基础连接参数，不承担迁移、查询或业务表结构。 */
export interface SqliteConnectionOptions {
  busyTimeoutMs?: unknown
  synchronous?: unknown
}

function busyTimeout(options: SqliteConnectionOptions): number {
  const value = Number(options.busyTimeoutMs)
  return Number.isFinite(value) ? Math.max(100, value) : 5000
}

/** 创建带有统一 WAL、外键和超时策略的 SQLite 连接。 */
export function openSqliteDatabase(file: string, options: SqliteConnectionOptions = {}): Database {
  const timeout = busyTimeout(options)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new Database(file, { timeout })
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.pragma(`busy_timeout = ${timeout}`)
  db.pragma(`synchronous = ${String(options.synchronous || "FULL").toUpperCase() === "NORMAL" ? "NORMAL" : "FULL"}`)
  db.pragma("journal_size_limit = 67108864")
  db.pragma("temp_store = MEMORY")
  return db
}

/** 关闭连接；已关闭的连接视为幂等操作。 */
export function closeSqliteDatabase(db: Database | null | undefined): void {
  if (db?.open) db.close()
}
