import { assertMemberOperation, assertSelfRestrictionRequest, memberTarget } from "../access/member-policy.js"
import { configStore } from "../../config/store.js"
import { blockUser, listBlockedUsers, unblockUser } from "../../core/chat/access-control.js"
import { groupIdFromEvent, isGroupEvent } from "../../core/message/event-scope.js"
import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"
import { requireMethod } from "./shared.js"

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

interface SocialEvent extends UnknownRecord {
  isGroup?: boolean
  isMaster?: boolean
  user_id?: unknown
  group_id?: unknown
  sender?: UnknownRecord
  bot?: UnknownRecord
  reply?: (payload: unknown, quote?: boolean) => Promise<unknown> | unknown
}

interface SocialToolContext extends ToolExecutionContext {
  e?: SocialEvent
  config?: UnknownRecord
}

type ToolArgs = UnknownRecord

export class QueryUserinfoTool {
  name = "query_userinfo"
  source = "builtin"
  description = "Return basic QQ user or group member metadata visible in the current event."
  parameters = {
    type: "object",
    properties: {
      qq: { type: "string", description: "QQ number. Defaults to current sender." },
    },
  }

  async execute(args: ToolArgs = {}, context: SocialToolContext = {}): Promise<string> {
    const e = context.e || {}
    const qq = text(args.qq || e.user_id || e.sender?.user_id).trim()
    const isGroup = isGroupEvent(e)
    const groupId = groupIdFromEvent(e)
    let member: unknown = null
    if (isGroup && qq) {
      member = await requireMethod(e.bot, "pickMember", "获取群成员")(groupId, Number(qq), true)
        || await requireMethod(e.bot, "getGroupMemberInfo", "获取群成员信息")(groupId, Number(qq), true)
        || null
    }
    const sender = record(member || e.sender)
    return JSON.stringify({
      user_id: sender.user_id || qq,
      nickname: sender.nickname,
      card: sender.card,
      sex: sender.sex,
      age: sender.age,
      area: sender.area,
      role: sender.role,
      title: sender.title,
      group_id: isGroup ? groupId : undefined,
      is_group: isGroup,
      is_master: Boolean(e.isMaster),
    }, null, 2)
  }
}

export class BlockUserTool {
  name = "block_user"
  source = "builtin"
  risk = "high"
  execution = { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe", maxAttempts: 2 }
  executionByAction = {
    block: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["userId", "scope"], operationFields: ["userId", "scope", "durationMinutes", "reason"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
    unblock: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["userId", "scope"], operationFields: ["userId", "scope"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
  }
  policy = { highRisk: true, memberOperation: "block" }
  description = "临时屏蔽：用户明确请求‘屏蔽我’‘别回复我’时设置自助屏蔽，人物处罚不能借用此工具。Temporarily block a user from triggering Yui Chat replies. Admin/master may manage others; normal users may check or block themselves; only admins/master may unblock restrictions."
  parameters = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["block", "unblock", "check", "list"], description: "Operation to perform." },
      scope: { type: "string", enum: ["current", "global"], description: "Defaults to current group/private scope. Global management requires master." },
      userId: { type: "string", description: "Target QQ user id. Defaults to current sender." },
      durationMinutes: { type: "number", description: "Block duration in minutes. Defaults to 30." },
      reason: { type: "string", description: "Short reason." },
    },
    required: ["action"],
  }

  async execute(args: ToolArgs = {}, context: SocialToolContext = {}): Promise<string> {
    const e = context.e || {}
    const action = text(args.action || "check").trim()
    const current = text(e.user_id || e.sender?.user_id).trim()
    assertMemberOperation("block", args, e)
    const target = action === "list" ? current : memberTarget(args, e, "userId")
    const groupId = args.scope === "global" || !isGroupEvent(e) ? "" : groupIdFromEvent(e)
    const origin = target === current ? "self" : "management"
    const scopeOptions = { groupId, global: args.scope === "global", origin }
    const scope = args.scope === "global" ? "global" : groupId ? "group" : "private"
    if (action === "list") {
      const rows = listBlockedUsers().filter(row => row.groupId === groupId && row.scope === scope)
      return rows.length
        ? rows.map((row, index) => `${index + 1}. ${row.userId} 剩余 ${row.remaining}${row.reason ? `，原因：${row.reason}` : ""}`).join("\n")
        : "当前没有临时屏蔽用户。"
    }
    if (action === "check") {
      const row = listBlockedUsers().find(row => row.userId === target && ((row.groupId === groupId && row.scope === scope) || (target === current && row.scope === "global")))
      return row ? `${target} 已被临时屏蔽，剩余 ${row.remaining}${row.reason ? `，原因：${row.reason}` : ""}` : `${target} 未被屏蔽。`
    }
    if (action === "unblock") {
      const selfRemoved = unblockUser(e, { userId: target, ...scopeOptions, origin: "self" })
      const managementRemoved = unblockUser(e, { userId: target, ...scopeOptions, origin: "management" })
      const removed = selfRemoved || managementRemoved
      const remaining = listBlockedUsers().some(row => row.userId === target && ((target === current && row.scope === "global") || (row.scope === scope && row.groupId === groupId)))
      return `${removed ? `已解除 ${target} 在当前管理范围内的屏蔽。` : "没有可解除的对应屏蔽记录。"}${remaining ? "仍有其他屏蔽记录生效。" : ""}`
    }
    if (action !== "block") return "未知 action，可用：block / unblock / check / list。"

    if (target === current) assertSelfRestrictionRequest("block", e, context.config || configStore.get())
    const config = record(context.config || configStore.get())
    const tools = record(config.tools)
    const builtin = record(tools.builtin)
    const cfg = record(builtin.blockUser)
    const defaultMinutes = Math.max(1, Math.min(Number(cfg.defaultMinutes || 30), 10080))
    const maxMinutes = Math.max(1, Math.min(Number(cfg.maxMinutes || 720), 10080))
    if (args.durationMinutes !== undefined && (!Number.isFinite(Number(args.durationMinutes)) || Number(args.durationMinutes) <= 0)) return "屏蔽时长必须为正数。"
    const minutes = Math.max(1, Math.min(Number(args.durationMinutes || defaultMinutes), maxMinutes))
    const row = blockUser(e, {
      userId: target,
      ...scopeOptions,
      durationMs: minutes * 60 * 1000,
      reason: String(args.reason || "").trim().slice(0, 120),
      operatorId: current,
    })
    return `已临时屏蔽 ${row.userId} ${minutes} 分钟${row.reason ? `，原因：${row.reason}` : ""}。`
  }
}

export function createSocialTools(): unknown[] {
  return [
    new QueryUserinfoTool(),
    new BlockUserTool(),
  ]
}
