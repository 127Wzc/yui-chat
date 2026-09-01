import { resolveBoundaryRole } from "../tools/access/roles.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"

type UnknownRecord = Record<string, unknown>

interface KnowledgeEvent extends UnknownRecord {
  isGroup?: boolean
  user_id?: unknown
  group_id?: unknown
}

interface GrantSubject {
  type: string
  id: string
}

function id(value: unknown): string { return String(value || "") }

export function grantSubjects(e: KnowledgeEvent = {}): GrantSubject[] {
  const boundaryRole = resolveBoundaryRole(e)
  if (boundaryRole === "master") return [{ type: "role", id: "master" }]
  const subjects = [
    { type: "role", id: "user" },
    { type: "role", id: boundaryRole },
    { type: "user", id: id(e.user_id) },
  ]
  if (e.isGroup) {
    subjects.push({ type: "group", id: id(e.group_id) })
    subjects.push({ type: "user_group", id: `${id(e.user_id)}:${id(e.group_id)}` })
  }
  return subjects.filter(subject => subject.id)
}

export async function authorizedKnowledgeBaseIds(e: KnowledgeEvent = {}): Promise<string[]> {
  if (!sqliteClient.status.available) return []
  const subjects = grantSubjects(e)
  if (!subjects.length) return []
  const conditions = subjects.map(() => "(subject_type = ? AND subject_id = ?)").join(" OR ")
  const params = subjects.flatMap(subject => [subject.type, subject.id])
  const groupId = e.isGroup ? id(e.group_id) : ""
  const rows = await sqliteClient.all(
    `SELECT knowledge_base_id, effect
     FROM knowledge_grants
     WHERE (${conditions}) AND (group_id = '' OR group_id = ?)`,
    [...params, groupId],
  )
  const decisions = new Map<string, { allow: boolean; deny: boolean }>()
  for (const row of rows) {
    const baseId = String(row.knowledge_base_id || "")
    if (!baseId) continue
    const current = decisions.get(baseId) || { allow: false, deny: false }
    if (row.effect === "deny") current.deny = true
    else if (row.effect === "allow") current.allow = true
    decisions.set(baseId, current)
  }
  return [...decisions.entries()].filter(([, decision]) => decision.allow && !decision.deny).map(([baseId]) => baseId)
}

export async function assertKnowledgeAccess(e: KnowledgeEvent, ids: unknown[] = []): Promise<string[]> {
  const unique = [...new Set((ids || []).map(String).filter(Boolean))]
  if (!unique.length) return []
  const allowed = new Set(await authorizedKnowledgeBaseIds(e))
  const forbidden = unique.filter(value => !allowed.has(value))
  if (forbidden.length) throw new Error(`没有访问知识库的权限：${forbidden.join(", ")}`)
  return unique
}
