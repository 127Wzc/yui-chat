import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { writeFileAtomic } from "./atomic-file.js"
import { cloneJsonValue as clone, deepFreezeJsonValue as deepFreeze } from "../shared/json-values.js"

type RecordValue = Record<string, unknown>

export interface AtomicJsonRepositoryOptions<T> {
  file: string
  defaultValue: T | (() => T)
  normalize?: (value: T) => T
  validate?: (value: T) => void
  serialize?: (value: T) => string
  onReadError?: (error: unknown, details: RecordValue) => void
  mode?: number
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code || "") : ""
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultSerializer<T>(value: T): string {
  return `${JSON.stringify(value, null, 2) ?? "null"}\n`
}

/**
 * 小型 JSON 域的统一原子仓库。
 *
 * 仓库只负责加载、校验、串行更新和原子替换，不理解具体业务字段；业务归一化
 * 与权限判断必须留在调用方，避免存储层逐渐变成第二套领域服务。
 */
export class AtomicJsonRepository<T = unknown> {
  readonly file: string
  private readonly defaultValue: T | (() => T)
  private readonly normalize: (value: T) => T
  private readonly validate: (value: T) => void
  private readonly serialize: (value: T) => string
  private readonly onReadError: (error: unknown, details: RecordValue) => void
  private readonly mode: number
  private loaded = false
  private value: T
  private writeBlocked = false
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(options: AtomicJsonRepositoryOptions<T>) {
    if (!options.file) throw new Error("AtomicJsonRepository requires a file path")
    this.file = options.file
    this.defaultValue = options.defaultValue
    this.normalize = options.normalize || (value => value)
    this.validate = options.validate || (() => undefined)
    this.serialize = options.serialize || defaultSerializer
    this.onReadError = options.onReadError || (() => undefined)
    this.mode = options.mode ?? 0o600
    this.value = this.createDefault()
  }

  private createDefault(): T {
    const value = typeof this.defaultValue === "function" ? (this.defaultValue as () => T)() : this.defaultValue
    return clone(value)
  }

  private prepare(value: T): T {
    const candidate = this.normalize(clone(value))
    this.validate(candidate)
    return candidate
  }

  private publish(candidate: T): T {
    this.value = deepFreeze(candidate) as T
    this.loaded = true
    return clone(this.value)
  }

  private enqueueMutation<TResult>(operation: () => Promise<TResult> | TResult): Promise<TResult> {
    const pending = this.mutationQueue.then(operation, operation)
    this.mutationQueue = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async quarantineInvalidFile(): Promise<string> {
    const extension = path.extname(this.file)
    const base = path.basename(this.file, extension)
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const suffix = crypto.randomBytes(4).toString("hex")
    const quarantineFile = path.join(path.dirname(this.file), `${base}.invalid.${stamp}-${suffix}${extension}`)
    await fs.rename(this.file, quarantineFile)
    return quarantineFile
  }

  private async loadInternal(): Promise<T> {
    if (this.loaded) return clone(this.value)
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as T
      return this.publish(this.prepare(parsed))
    } catch (error) {
      if (errorCode(error) === "ENOENT") return this.publish(this.prepare(this.createDefault()))
      const readError: RecordValue = { message: errorMessage(error), time: new Date().toISOString(), quarantinedFile: "" }
      try {
        readError.quarantinedFile = await this.quarantineInvalidFile()
      } catch (quarantineError) {
        if (errorCode(quarantineError) !== "ENOENT") {
          readError.quarantineError = errorMessage(quarantineError)
          this.writeBlocked = true
        }
      }
      this.onReadError(error, { file: this.file, ...readError })
      return this.publish(this.prepare(this.createDefault()))
    }
  }

  /** 加载一次并缓存冻结快照。 */
  load(): Promise<T> {
    return this.enqueueMutation(() => this.loadInternal())
  }

  private async write(candidate: T): Promise<T> {
    const prepared = this.prepare(candidate)
    if (this.writeBlocked) throw new Error(`原数据文件读取失败且未能隔离，拒绝覆盖：${this.file}`)
    await writeFileAtomic(this.file, this.serialize(prepared), { mode: this.mode })
    this.writeBlocked = false
    return this.publish(prepared)
  }

  /** 完整替换仓库内容。 */
  replace(value: T): Promise<T> {
    const snapshot = clone(value)
    return this.enqueueMutation(async () => {
      await this.loadInternal()
      return this.write(snapshot)
    })
  }

  /** 在最新快照上串行更新，避免并发写覆盖。 */
  update(mutator: (current: T) => T | void | Promise<T | void>): Promise<T> {
    if (typeof mutator !== "function") throw new TypeError("repository updater must be a function")
    return this.enqueueMutation(async () => {
      await this.loadInternal()
      const draft = clone(this.value)
      const result = await mutator(draft)
      return this.write(result === undefined ? draft : result)
    })
  }
}
