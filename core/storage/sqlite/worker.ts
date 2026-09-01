import { parentPort, workerData } from "node:worker_threads"
import fs from "node:fs"
import Database from "better-sqlite3"
import { closeSqliteDatabase, openSqliteDatabase } from "./connection.js"
import { preflightStateMigrations, preflightVectorMigrations, runStateMigrations, runVectorMigrations } from "./migration-runner.js"
import type { SqliteConnectionOptions } from "./connection.js"
import type { SqliteMigration, SqliteRequestKind, SqliteTarget, SqliteWorkerRequest, VectorStatus } from "../types.js"

type RecordValue = Record<string, unknown>
type SqliteDatabase = Database

let stateDb: SqliteDatabase | null = null
let vectorDb: SqliteDatabase | null = null
let vectorStatus: VectorStatus = { available: false, error: "not initialized" }

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function database(target: SqliteTarget = "state"): SqliteDatabase {
  if (target === "vectors") {
    if (!vectorDb) throw new Error("向量数据库不可用")
    return vectorDb
  }
  if (!stateDb) throw new Error("状态数据库不可用")
  return stateDb
}

function normalizeParams(params: unknown): unknown[] {
  return Array.isArray(params) ? params : isRecord(params) ? Object.values(params) : []
}

function workerContext(): { stateFile: string; vectorFile: string; options: SqliteConnectionOptions } {
  const data = isRecord(workerData) ? workerData : {}
  return {
    stateFile: text(data.stateFile),
    vectorFile: text(data.vectorFile),
    options: isRecord(data.options) ? data.options : {},
  }
}

/** 在建立可写连接前用只读连接检查旧库，避免 WAL 或迁移表污染管理员现场。 */
function preflightExistingDatabase(file: string, inspect: (db: SqliteDatabase) => void): void {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return
  const probe = new Database(file, { readonly: true, fileMustExist: true })
  try {
    inspect(probe)
  } finally {
    closeSqliteDatabase(probe)
  }
}

/** 初始化状态库和可选向量库；向量库失败时只降级检索，不阻断普通对话。 */
async function initialize(): Promise<{ migrations: SqliteMigration[]; integrity: string; vector: VectorStatus }> {
  const context = workerContext()
  preflightExistingDatabase(context.stateFile, preflightStateMigrations)
  stateDb = openSqliteDatabase(context.stateFile, context.options)
  const integrity = text(stateDb.prepare("PRAGMA quick_check").pluck().get()) || "unknown"
  if (integrity !== "ok") throw new Error(`state.sqlite3 完整性检查失败：${integrity}`)
  const migrations = runStateMigrations(stateDb)
  try {
    preflightExistingDatabase(context.vectorFile, preflightVectorMigrations)
    vectorDb = openSqliteDatabase(context.vectorFile, context.options)
    const vectorIntegrity = text(vectorDb.prepare("PRAGMA quick_check").pluck().get()) || "unknown"
    if (vectorIntegrity !== "ok") throw new Error(`vectors.sqlite3 完整性检查失败：${vectorIntegrity}`)
    runVectorMigrations(vectorDb)
    const sqliteVec = await import("sqlite-vec")
    sqliteVec.load(vectorDb)
    vectorStatus = { available: true, error: "", version: text(vectorDb.prepare("SELECT vec_version()").pluck().get()) }
  } catch (error) {
    closeSqliteDatabase(vectorDb)
    vectorDb = null
    // 向量库只是派生索引：数据损坏时保留现场改名，由后续索引任务重建，不影响 FTS 聊天。
    const message = errorText(error)
    const code = isRecord(error) ? text(error.code) : ""
    // 只有数据本身损坏才允许改名重建；环境问题不能擅自改名管理员留存的数据。
    const dataCorrupted = message.includes("完整性检查失败") || code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB"
    if (dataCorrupted && fs.existsSync(context.vectorFile)) {
      try {
        fs.renameSync(context.vectorFile, `${context.vectorFile}.corrupt.${Date.now()}`)
      } catch {
        // 只读文件系统时保持 FTS 降级，不影响状态库和普通对话。
      }
    }
    vectorStatus = { available: false, error: message }
  }
  return { migrations, integrity, vector: vectorStatus }
}

function requestKind(value: unknown): SqliteRequestKind {
  const kind = text(value)
  if (["all", "get", "run", "exec", "transaction", "status", "close"].includes(kind)) return kind as SqliteRequestKind
  throw new Error(`未知 SQLite worker 请求：${kind}`)
}

function requestMessage(value: unknown): SqliteWorkerRequest & RecordValue {
  return isRecord(value) ? value as SqliteWorkerRequest & RecordValue : { id: 0, kind: "status" }
}

/** 执行单个 Worker 请求；SQL 业务含义仍由上层仓库负责。 */
async function handle(rawMessage: unknown): Promise<unknown> {
  const message = requestMessage(rawMessage)
  const kind = requestKind(message.kind)
  const db = database(message.target)
  switch (kind) {
    case "all": return db.prepare(text(message.sql)).all(...normalizeParams(message.params))
    case "get": return db.prepare(text(message.sql)).get(...normalizeParams(message.params))
    case "run": return db.prepare(text(message.sql)).run(...normalizeParams(message.params))
    case "exec":
      db.exec(text(message.sql))
      return { ok: true }
    case "transaction": {
      const operations = Array.isArray(message.operations) ? message.operations : []
      return db.transaction(() => operations.map(operation => {
        const statement = db.prepare(text(operation.sql))
        const params = normalizeParams(operation.params)
        if (operation.mode === "all") return statement.all(...params)
        if (operation.mode === "get") return statement.get(...params)
        return statement.run(...params)
      }))()
    }
    case "status": return { vector: vectorStatus, integrity: db.prepare("PRAGMA quick_check").pluck().get() }
    case "close":
      closeSqliteDatabase(vectorDb)
      closeSqliteDatabase(stateDb)
      vectorDb = null
      stateDb = null
      return { ok: true }
  }
}

let initialized = false
try {
  const result = await initialize()
  parentPort?.postMessage({ type: "ready", result })
  initialized = true
} catch (error) {
  closeSqliteDatabase(vectorDb)
  closeSqliteDatabase(stateDb)
  vectorDb = null
  stateDb = null
  parentPort?.postMessage({ type: "ready", error: errorText(error) })
}

if (initialized) {
  parentPort?.on("message", async message => {
    const request = requestMessage(message)
    try {
      const result = await handle(request)
      parentPort?.postMessage({ id: request.id, result })
    } catch (error) {
      parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.stack || error.message : String(error) })
    }
  })
} else {
  parentPort?.close()
}
