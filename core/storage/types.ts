/** SQLite 向量索引的可用状态；向量库不可用时业务可降级到 FTS。 */
export interface VectorStatus {
  available: boolean
  error: string
  version?: string
}

/** 已应用迁移的可观测记录；Worker 返回的 applied_at 保留给诊断页。 */
export interface SqliteMigration {
  id: string
  applied_at?: number
}

/** 状态库和派生向量库的统一启动结果。 */
export interface SqliteStatus {
  available: boolean
  vector: VectorStatus
  error: string
  migrations?: SqliteMigration[]
  integrity?: string | Record<string, unknown>
}

/** Worker 中的数据库目标；名称必须与运行时文件和 worker 分支保持一致。 */
export type SqliteTarget = "state" | "vectors"

/** 单条 SQLite 操作，参数始终以 unknown 进入 Worker 边界。 */
export interface SqliteOperation {
  sql: string
  params?: unknown[]
  target?: SqliteTarget
  mode?: "all" | "get" | "run"
}

/** Worker 支持的请求种类；status 用于只读诊断，不修改数据库。 */
export type SqliteRequestKind = "all" | "get" | "run" | "exec" | "transaction" | "status" | "close"

/** 发往 SQLite Worker 的可序列化请求。 */
export interface SqliteWorkerRequest {
  id: number
  kind: SqliteRequestKind
  sql?: string
  params?: unknown[]
  target?: SqliteTarget
  operations?: SqliteOperation[]
}

/** SQLite Worker 返回的通用响应；具体 result 由请求 kind 决定。 */
export interface SqliteWorkerResponse {
  id?: number
  type?: "ready"
  result?: unknown
  error?: string
}
