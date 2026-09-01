import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type Database from "better-sqlite3"
import type { SqliteMigration } from "../types.js"

type SqliteDatabase = Database
type RecordValue = Record<string, unknown>

const sqliteDir = path.dirname(fileURLToPath(import.meta.url))
const stateMigrationDir = path.join(sqliteDir, "migrations")
const vectorMigrationDir = path.join(sqliteDir, "vector-migrations")

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function migrationFiles(directory: string): string[] {
  return fs.readdirSync(directory)
    .filter(file => /^\d{3}-[\w-]+\.sql$/.test(file))
    .sort()
}

function userTables(db: SqliteDatabase): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(row => isRecord(row) ? text(row.name) : "")
    .filter(Boolean)
}

function baselineError(kind: string, details = ""): Error {
  return new Error(`${kind} 检测到旧版 Schema，当前版本只支持全新数据库。请保留旧数据库并使用新的运行目录启动。${details ? ` ${details}` : ""}`)
}

interface MigrationOptions {
  table: string
  directory: string
  kind: string
}

interface MigrationInspection {
  files: string[]
  applied: Set<string>
  hasMigrationTable: boolean
}

function inspectMigrations(db: SqliteDatabase, options: MigrationOptions): MigrationInspection {
  const files = migrationFiles(options.directory)
  const tables = userTables(db)
  const hasMigrationTable = tables.includes(options.table)
  if (!hasMigrationTable) {
    if (tables.length) throw baselineError(options.kind, `发现已有表：${tables.join(", ")}`)
    return { files, applied: new Set(), hasMigrationTable: false }
  }
  const appliedRows = db.prepare(`SELECT id FROM ${options.table} ORDER BY id`).all()
  const applied = new Set(appliedRows.map(row => isRecord(row) ? text(row.id) : "").filter(Boolean))
  const fileSet = new Set(files)
  const unknown = [...applied].filter(id => !fileSet.has(id))
  if (unknown.length) throw baselineError(options.kind, `发现迁移记录：${unknown.join(", ")}`)
  if (!applied.size) {
    const existing = tables.filter(name => name !== options.table)
    if (existing.length) throw baselineError(options.kind, `发现已有表：${existing.join(", ")}`)
  }
  return { files, applied, hasMigrationTable: true }
}

function migrationRecord(value: unknown): SqliteMigration {
  if (!isRecord(value)) return { id: text(value) }
  const appliedAt = Number(value.applied_at)
  return {
    id: text(value.id),
    ...(Number.isFinite(appliedAt) ? { applied_at: appliedAt } : {}),
  }
}

/** 按文件名顺序执行单个数据库的全新 Schema 迁移，并返回可观测记录。 */
function runMigrations(db: SqliteDatabase, options: MigrationOptions): SqliteMigration[] {
  const inspection = inspectMigrations(db, options)
  if (!inspection.hasMigrationTable) {
    db.exec(`CREATE TABLE ${options.table} (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;`)
  }
  const insert = db.prepare(`INSERT INTO ${options.table} (id, applied_at) VALUES (?, ?)`)
  const timestamp = Date.now()
  db.transaction(() => {
    for (const id of inspection.files) {
      if (inspection.applied.has(id)) continue
      db.exec(fs.readFileSync(path.join(options.directory, id), "utf8"))
      insert.run(id, timestamp)
    }
  })()
  return db.prepare(`SELECT id, applied_at FROM ${options.table} ORDER BY id`).all().map(migrationRecord)
}

/** 执行状态库迁移；旧版或不匹配的数据库会在任何写入前被拒绝。 */
export function runStateMigrations(db: SqliteDatabase): SqliteMigration[] {
  return runMigrations(db, { table: "schema_migrations", directory: stateMigrationDir, kind: "state.sqlite3" })
}

/** 执行向量库迁移；向量库仍然是可重建的派生索引。 */
export function runVectorMigrations(db: SqliteDatabase): SqliteMigration[] {
  return runMigrations(db, { table: "vector_schema_migrations", directory: vectorMigrationDir, kind: "vectors.sqlite3" })
}

/** 对状态库做只读基线检查，确保旧库不会被静默套用新配置。 */
export function preflightStateMigrations(db: SqliteDatabase): void {
  inspectMigrations(db, { table: "schema_migrations", directory: stateMigrationDir, kind: "state.sqlite3" })
}

/** 对向量库做只读基线检查。 */
export function preflightVectorMigrations(db: SqliteDatabase): void {
  inspectMigrations(db, { table: "vector_schema_migrations", directory: vectorMigrationDir, kind: "vectors.sqlite3" })
}
