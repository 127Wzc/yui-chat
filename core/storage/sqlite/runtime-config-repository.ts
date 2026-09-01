import type { RuntimeConfigObject, RuntimeConfigRepository, RuntimeConfigStorageState } from "../../../config/types.js"
import type { SqliteClientContract } from "../contracts.js"
import { isJsonValue } from "../../message-chain/types.js"

type RuntimeConfigRow = {
  schema_version?: unknown
  revision?: unknown
  overrides_json?: unknown
  updated_at?: unknown
}

function objectValue(value: unknown): RuntimeConfigObject {
  if (!isJsonValue(value) || !value || Array.isArray(value)) return {}
  return value as RuntimeConfigObject
}

function numberValue(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * SQLite 运行配置仓库。
 *
 * 这个类只维护 `runtime_config` 的单行稀疏覆盖项和版本信息，不参与默认值合并、
 * 配置校验、启动项拆分或 Web 权限判断。实例生命周期由配置 Store 管理，底层客户端
 * 只需要提供异步 `get`/`run`，因此可以使用 Worker 客户端或测试替身。
 */
export class SqliteRuntimeConfigRepository implements RuntimeConfigRepository {
  private readonly client: Pick<SqliteClientContract, "get" | "run">

  /** 创建仓库；传入的客户端必须已经完成 SQLite 初始化。 */
  constructor(client: Pick<SqliteClientContract, "get" | "run">) {
    if (!client || typeof client.get !== "function" || typeof client.run !== "function") {
      throw new TypeError("SQLite runtime config repository requires a client")
    }
    this.client = client
  }

  /** 读取配置覆盖；数据库没有单行记录时返回空的初始状态。 */
  async load(): Promise<RuntimeConfigStorageState> {
    const row = await this.client.get<RuntimeConfigRow>(
      "SELECT schema_version, revision, overrides_json, updated_at FROM runtime_config WHERE id = 1",
    )
    if (!row) return { exists: false, schemaVersion: 1, revision: 0, overrides: {}, updatedAt: 0 }

    let overrides: RuntimeConfigObject
    try {
      overrides = objectValue(JSON.parse(String(row.overrides_json || "{}")))
    } catch {
      throw new Error("SQLite 主配置 JSON 损坏，已停止加载。")
    }
    return {
      exists: true,
      schemaVersion: numberValue(row.schema_version, 1),
      revision: numberValue(row.revision),
      overrides,
      updatedAt: numberValue(row.updated_at),
    }
  }

  /** 原子更新覆盖项；revision 由 SQLite 负责递增，保存后重新读取权威状态。 */
  async save(overrides: RuntimeConfigObject = {}): Promise<RuntimeConfigStorageState> {
    const updatedAt = Date.now()
    await this.client.run(
      `INSERT INTO runtime_config(id, schema_version, revision, overrides_json, updated_at)
       VALUES(1, 1, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         schema_version=excluded.schema_version,
         revision=runtime_config.revision + 1,
         overrides_json=excluded.overrides_json,
         updated_at=excluded.updated_at`,
      [JSON.stringify(objectValue(overrides)), updatedAt],
    )
    return this.load()
  }
}
