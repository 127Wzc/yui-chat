import path from "node:path"
import { Worker } from "node:worker_threads"
import type { SqliteClientContract } from "../contracts.js"
import type { SqliteMigration, SqliteOperation, SqliteRequestKind, SqliteStatus, SqliteTarget, SqliteWorkerRequest } from "../types.js"
import { dataDir } from "../../../config/store.js"
import { hostRuntime } from "../../runtime/host-runtime.js"

type RecordValue = Record<string, unknown>

/** Worker 事件的最小接口；具体实现可以是 Node Worker 或测试替身。 */
export interface SqliteWorkerLike {
  once(event: "message", listener: (message: unknown) => void): void
  on(event: "message", listener: (message: unknown) => void): void
  on(event: "error", listener: (error: Error) => void): void
  on(event: "exit", listener: (code: number) => void): void
  postMessage(message: SqliteWorkerRequest): void
  terminate(): Promise<unknown>
}

/** 创建 Worker 的宿主适配函数；路径、execArgv 和 workerData 不进入存储领域逻辑。 */
export type SqliteWorkerFactory = (
  workerUrl: unknown,
  options: { type: "module"; execArgv: string[]; workerData: Record<string, unknown> },
) => SqliteWorkerLike

/** SQLite 客户端的外部依赖；通过注入方便在不启动真实数据库时验证状态机。 */
export interface SqliteClientOptions {
  dataDir: string
  workerUrl: unknown
  createWorker: SqliteWorkerFactory
  joinPath: (...parts: string[]) => string
  /** 兼容旧注入方；SQLite Worker 不接收宿主进程的 execArgv。 */
  execArgv?: string[]
  logger?: {
    error?: (message: string, error?: unknown) => void
    warn?: (message: string, error?: unknown) => void
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function vectorStatus(value: unknown, fallback = "not initialized") {
  const record = isRecord(value) ? value : {}
  return {
    available: record.available === true,
    error: text(record.error) || fallback,
  }
}

function statusFromReadyMessage(message: RecordValue): SqliteStatus {
  const error = text(message.error)
  if (error) return { available: false, vector: vectorStatus(null, error), error }
  const result = isRecord(message.result) ? message.result : {}
  return {
    available: true,
    vector: vectorStatus(result.vector),
    error: "",
    ...(Array.isArray(result.migrations) ? { migrations: result.migrations.map(migrationRecord) } : {}),
    ...(typeof result.integrity === "string" || isRecord(result.integrity) ? { integrity: result.integrity } : {}),
  }
}

function migrationRecord(value: unknown): SqliteMigration {
  if (isRecord(value)) {
    return {
      id: text(value.id),
      ...(Number.isFinite(Number(value.applied_at)) ? { applied_at: Number(value.applied_at) } : {}),
    }
  }
  return { id: text(value) }
}

/**
 * SQLite Worker 客户端。
 *
 * 它只负责 Worker 生命周期、请求序号、待处理请求和启动状态，不直接接触
 * better-sqlite3、SQL 业务含义或宿主全局对象。生产入口通过 `SqliteClientOptions`
 * 注入 Worker 适配器；关闭时会拒绝所有未完成请求，避免调用方永久等待。
 */
export class SqliteClient implements SqliteClientContract {
  private worker: SqliteWorkerLike | null = null
  private ready: Promise<SqliteStatus> | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private sequence = 0
  private state: SqliteStatus = {
    available: false,
    vector: { available: false, error: "not initialized" },
    error: "not initialized",
  }
  private readonly options: SqliteClientOptions

  /** 创建客户端；不在构造阶段启动 Worker，初始化由宿主显式调用。 */
  constructor(options: SqliteClientOptions) {
    this.options = options
  }

  /** 启动一次 Worker 并等待 ready 消息；重复调用复用同一个初始化 Promise。 */
  async init(config: Record<string, unknown> = {}): Promise<SqliteStatus> {
    if (this.ready) return this.ready
    const storage = isRecord(config.storage) ? config.storage : {}
    const sqlite = isRecord(storage.sqlite) ? storage.sqlite : {}
    if (sqlite.enabled === false) {
      this.state = { ...this.state, error: "disabled" }
      return this.state
    }

    const storageDir = this.options.joinPath(this.options.dataDir, "storage")
    const worker = this.options.createWorker(this.options.workerUrl, {
      type: "module",
      // Worker 不需要宿主启动参数；显式传空数组，避免 Node 默认继承不支持的 V8/进程级参数。
      execArgv: [],
      workerData: {
        stateFile: this.options.joinPath(storageDir, "state.sqlite3"),
        vectorFile: this.options.joinPath(storageDir, "vectors.sqlite3"),
        options: sqlite,
      },
    })
    this.worker = worker
    this.ready = new Promise(resolve => {
      let settled = false
      const finish = (status: SqliteStatus) => {
        if (settled) return
        settled = true
        resolve(status)
      }

      worker.once("message", message => {
        if (!isRecord(message) || message.type !== "ready") return
        this.state = statusFromReadyMessage(message)
        if (!this.state.available) {
          this.options.logger?.error?.(`[yui-chat] SQLite 初始化失败，已降级为文件存储：${this.state.error}`)
        } else if (!this.state.vector.available) {
          this.options.logger?.warn?.(`[yui-chat] 向量索引不可用，知识检索将降级 FTS5：${this.state.vector.error}`)
        }
        finish(this.state)
      })
      worker.on("message", message => {
        if (!isRecord(message) || !message.id) return
        const pending = this.pending.get(Number(message.id))
        if (!pending) return
        this.pending.delete(Number(message.id))
        if (message.error) pending.reject(new Error(text(message.error)))
        else pending.resolve(message.result)
      })
      worker.on("error", error => {
        this.state = { ...this.state, available: false, error: error.message }
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
        finish(this.state)
      })
      worker.on("exit", code => {
        if (this.worker === worker) this.worker = null
        if (code && this.state.available) this.state = { ...this.state, available: false, error: `worker exited: ${code}` }
        if (!settled) {
          this.state = { ...this.state, available: false, error: this.state.error || `worker exited: ${code}` }
          finish(this.state)
        }
      })
    })
    return this.ready
  }

  /** 返回当前只读状态快照；不会触发数据库请求。 */
  getStatus(): SqliteStatus {
    return {
      ...this.state,
      vector: { ...this.state.vector },
      ...(this.state.migrations ? { migrations: [...this.state.migrations] } : {}),
    }
  }

  /** 兼容业务侧的只读状态访问；返回副本，不允许调用方修改内部状态。 */
  get status(): SqliteStatus {
    return this.getStatus()
  }

  /** 仅供现有故障注入烟测替换状态；生产业务不应写入此属性。 */
  set status(value: SqliteStatus) {
    this.state = value
  }

  /** 将请求交给 Worker，并把响应或错误分发给对应的调用方。 */
  private async request(kind: SqliteRequestKind, payload: Omit<SqliteWorkerRequest, "id" | "kind"> = {}): Promise<unknown> {
    await this.ready
    if (!this.state.available || !this.worker) throw new Error(this.state.error || "SQLite 不可用")
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.worker?.postMessage({ id, kind, ...payload })
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** 查询多行记录。 */
  all<T = Record<string, unknown>>(sql: string, params: unknown[] = [], target: SqliteTarget = "state"): Promise<T[]> {
    return this.request("all", { sql, params, target }) as Promise<T[]>
  }

  /** 查询单行记录。 */
  get<T = Record<string, unknown>>(sql: string, params: unknown[] = [], target: SqliteTarget = "state"): Promise<T | undefined> {
    return this.request("get", { sql, params, target }) as Promise<T | undefined>
  }

  /** 执行写入并返回 Worker 的运行结果。 */
  run(sql: string, params: unknown[] = [], target: SqliteTarget = "state"): Promise<Record<string, unknown>> {
    return this.request("run", { sql, params, target }) as Promise<Record<string, unknown>>
  }

  /** 执行不返回行集的 SQL。 */
  exec(sql: string, target: SqliteTarget = "state"): Promise<unknown> {
    return this.request("exec", { sql, target })
  }

  /** 在同一 Worker 数据库连接中执行事务操作列表。 */
  transaction(operations: SqliteOperation[] = [], target: SqliteTarget = "state"): Promise<unknown[]> {
    return this.request("transaction", { operations, target }) as Promise<unknown[]>
  }

  /** 关闭 Worker，先尽力通知数据库，再拒绝所有尚未完成的调用。 */
  async close(): Promise<void> {
    const worker = this.worker
    if (!worker) {
      this.ready = null
      this.state = { available: false, vector: { available: false, error: "closed" }, error: "closed" }
      return
    }
    if (this.state.available) {
      try { await this.request("close") } catch { /* Worker 退出时由 SQLite 回收资源。 */ }
    }
    await worker.terminate().catch(() => {})
    const closedError = new Error("closed")
    for (const pending of this.pending.values()) pending.reject(closedError)
    this.pending.clear()
    this.worker = null
    this.ready = null
    this.state = { available: false, vector: { available: false, error: "closed" }, error: "closed" }
  }
}

function createProductionWorker(workerUrl: unknown, options: Parameters<SqliteWorkerFactory>[1]): SqliteWorkerLike {
  return new Worker(workerUrl as URL, {
    type: options.type,
    execArgv: options.execArgv,
    workerData: options.workerData,
  }) as unknown as SqliteWorkerLike
}

/**
 * 生产 SQLite 客户端。
 *
 * Worker 创建、插件数据目录和宿主日志是 Node/Yunzai 接入边界，集中在这里；
 * `SqliteClient` 本身仍保持可注入、可测试，不把 better-sqlite3 细节带进业务层。
 */
export const sqliteClient = new SqliteClient({
  dataDir,
  workerUrl: new URL("./worker.js", import.meta.url),
  createWorker: createProductionWorker,
  joinPath: path.join,
  logger: {
    error: (message, error) => hostRuntime.logger?.error?.(message, error),
    warn: (message, error) => hostRuntime.logger?.warn?.(message, error),
  },
})
