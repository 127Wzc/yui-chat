import { randomUUID } from "node:crypto"
import { sqliteClient } from "../../core/storage/sqlite/client.js"
import { groupIdFromEvent, isGroupEvent } from "../../core/message/event-scope.js"

type UnknownRecord = Record<string, unknown>
type CapabilityEffect = "allow" | "deny"

export interface CapabilityRule {
  id?: string
  subject_type: string
  subject_id: string
  group_id: string
  resource_type: string
  resource_id: string
  effect: CapabilityEffect
  created_at?: number
  updated_at?: number
}

export interface CapabilityRuleInput {
  subjectType: string
  subjectId: string
  groupId?: string
  resourceType?: string
  resourceId: string
  effect: CapabilityEffect
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function eventSubjects(event: unknown = {}): Array<{ type: string; id: string }> {
  const value = record(event)
  const userId = text(value.user_id)
  const groupId = groupIdFromEvent(value)
  const subjects = [{ type: "user", id: userId }]
  if (isGroupEvent(value)) {
    subjects.push(
      { type: "group", id: groupId },
      { type: "user_group", id: `${userId}:${groupId}` },
    )
  }
  return subjects.filter(subject => subject.id)
}

function normalizeRule(row: CapabilityRule): CapabilityRule {
  return {
    ...row,
    subject_type: text(row.subject_type),
    subject_id: text(row.subject_id),
    group_id: text(row.group_id),
    resource_type: text(row.resource_type),
    resource_id: text(row.resource_id),
    effect: row.effect === "allow" ? "allow" : "deny",
  }
}

/** 个人能力规则的 SQLite 读写边界；不把 SQL 细节泄漏到权限判断层。 */
export class CapabilityStore {
  rules: CapabilityRule[] = []

  async load(): Promise<void> {
    if (!sqliteClient.status.available) return
    const rows = await sqliteClient.all<CapabilityRule>(
      "SELECT subject_type, subject_id, group_id, resource_type, resource_id, effect FROM capability_rules",
    )
    this.rules = rows.map(normalizeRule)
  }

  /** 返回最严格的命中结果；deny 优先于 allow，未命中返回空字符串。 */
  decision(event: unknown = {}, toolName = ""): "allow" | "deny" | "" {
    const value = record(event)
    const groupId = groupIdFromEvent(value)
    const subjects = eventSubjects(value)
    const matched = this.rules.filter(rule => (
      rule.resource_type === "tool"
      && rule.resource_id === toolName
      && subjects.some(subject => (
        subject.type === rule.subject_type
        && subject.id === rule.subject_id
        && (!rule.group_id || rule.group_id === groupId)
      ))
    ))
    if (matched.some(rule => rule.effect === "deny")) return "deny"
    return matched.some(rule => rule.effect === "allow") ? "allow" : ""
  }

  async setRule(input: CapabilityRuleInput): Promise<void> {
    if (!["allow", "deny"].includes(input.effect)) {
      throw new Error("个人能力规则 effect 只支持 allow 或 deny")
    }
    const now = Date.now()
    await sqliteClient.run(
      "INSERT INTO capability_rules(id, subject_type, subject_id, group_id, resource_type, resource_id, effect, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(subject_type, subject_id, group_id, resource_type, resource_id) DO UPDATE SET effect=excluded.effect, updated_at=excluded.updated_at",
      [
        randomUUID(), input.subjectType, input.subjectId, input.groupId || "", input.resourceType || "tool",
        input.resourceId, input.effect, now, now,
      ],
    )
    await this.load()
  }
}

export const capabilityStore = new CapabilityStore()
