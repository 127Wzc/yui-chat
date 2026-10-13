import { sqliteClient } from "../../core/storage/sqlite/client.js"
import type { InstallationTask } from "./types.js"

export class InstallationStore {
  async get(id: string): Promise<InstallationTask> {
    const row = await sqliteClient.get<{ payload: string }>("SELECT payload FROM extension_installations WHERE id=?", [id])
    if (!row) throw new Error("安装任务不存在")
    return JSON.parse(row.payload) as InstallationTask
  }
  async byRequest(key: string): Promise<InstallationTask | undefined> {
    const row = await sqliteClient.get<{ payload: string }>("SELECT payload FROM extension_installations WHERE request_key=?", [key])
    return row ? JSON.parse(row.payload) as InstallationTask : undefined
  }
  async list(limit = 100, before = Number.MAX_SAFE_INTEGER, beforeId = ""): Promise<InstallationTask[]> {
    const rows = await sqliteClient.all<{ payload: string }>("SELECT payload FROM extension_installations WHERE updated_at<? OR (updated_at=? AND id>?) ORDER BY updated_at DESC, id LIMIT ?", [before, before, beforeId, Math.max(1, Math.min(100, limit))])
    return rows.map(row => JSON.parse(row.payload) as InstallationTask)
  }
  async active(): Promise<InstallationTask[]> {
    const rows = await sqliteClient.all<{ payload: string }>("SELECT payload FROM extension_installations WHERE status NOT IN ('succeeded','failed','canceled','expired') ORDER BY updated_at")
    return rows.map(row => JSON.parse(row.payload) as InstallationTask)
  }
  async create(task: InstallationTask): Promise<InstallationTask> {
    await sqliteClient.run("INSERT INTO extension_installations VALUES(?,?,?,?,?,?)", [task.id, task.requestKey, task.version, task.status, task.updatedAt, JSON.stringify(task)])
    return task
  }
  async change(task: InstallationTask, patch: Partial<InstallationTask>, event: Record<string, unknown>): Promise<InstallationTask> {
    const next = { ...task, ...patch, version: task.version + 1, updatedAt: Date.now(), event: { ...event, actor: patch.actor || task.actor, attempt: task.attempt } }
    const result = await sqliteClient.run("UPDATE extension_installations SET version=?,status=?,updated_at=?,payload=? WHERE id=? AND version=?", [next.version, next.status, next.updatedAt, JSON.stringify(next), task.id, task.version])
    if (result.changes !== 1) throw new Error("任务已改变，请刷新后重试")
    return next
  }
  async events(id: string, after = 0) {
    return (await sqliteClient.all<{ sequence: number; timestamp: number; payload: string }>("SELECT sequence,timestamp,payload FROM extension_installation_events WHERE operation_id=? AND sequence>? ORDER BY sequence LIMIT 100", [id, Math.max(0, after)])).map(row => ({ sequence: row.sequence, timestamp: row.timestamp, ...JSON.parse(row.payload) }))
  }
  async pendingNotifications(): Promise<InstallationTask[]> {
    return (await sqliteClient.all<{ payload: string }>("SELECT payload FROM extension_installations WHERE status IN ('succeeded','failed','canceled','expired') AND json_extract(payload,'$.notification') IN ('pending','sending') ORDER BY updated_at LIMIT 50")).map(row => JSON.parse(row.payload) as InstallationTask)
  }
  async cleanupExpiredRecords(): Promise<void> {
    const before = Date.now() - 90 * 86400000
    // Receipts have no cascading relation to task retention; in-use provenance survives log cleanup.
    await sqliteClient.transaction([
      { sql: "DELETE FROM extension_credentials WHERE json_extract(payload,'$.purpose')='installation-input' AND json_extract(payload,'$.scope') IN (SELECT id FROM extension_installations WHERE status IN ('succeeded','failed','canceled','expired') AND updated_at<?)", params: [before] },
      { sql: "DELETE FROM extension_installations WHERE status IN ('succeeded','failed','canceled','expired') AND updated_at<?", params: [before] },
    ])
  }
  async receipt(kind: string, target: string): Promise<Record<string, unknown> | undefined> {
    const row = await sqliteClient.get<{ payload: string }>("SELECT payload FROM extension_installation_receipts WHERE kind=? AND target_id=? AND retired_at IS NULL", [kind, target])
    return row ? JSON.parse(row.payload) as Record<string, unknown> : undefined
  }
  async retireReceipt(kind: string, target: string): Promise<void> {
    await sqliteClient.run("UPDATE extension_installation_receipts SET retired_at=? WHERE kind=? AND target_id=? AND retired_at IS NULL", [Date.now(), kind, target])
  }
  async saveReceipt(task: InstallationTask, connection?: Record<string, unknown>): Promise<void> {
    const plan = task.plan!
    const receipt = { origin: task.origin, committedBy: task.actor, staticValidation: "passed", connection, id: task.id, installationId: task.id, kind: task.kind, targetId: plan.targetId, sourceIdentity: task.sourceIdentity, sourceVisibility: task.credentialId ? "private" : "unknown", resolvedCommit: plan.resolvedCommit, sourceDigest: plan.digest, installedDigest: plan.digest, files: plan.files, installedAt: Date.now(), installerVersion: 1, activationAtInstall: "disabled", runtimeCheck: "not_run" }
    await sqliteClient.run("INSERT INTO extension_installation_receipts(id,kind,target_id,installation_id,payload) VALUES(?,?,?,?,?) ON CONFLICT(installation_id) DO NOTHING", [task.id, task.kind, plan.targetId, task.id, JSON.stringify(receipt)])
  }
}
export const installationStore = new InstallationStore()
