import { configStore } from "../../config/store.js"
import { blockUser, getBlockedUser, listBlockedUsers, unblockUser } from "../../core/chat/access-control.js"
import { groupIdFromEvent, isGroupEvent } from "../../core/message/event-scope.js"
import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"
import { isGroupAdmin, requireMethod } from "./shared.js"

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
    block: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["userId"], operationFields: ["userId", "durationMinutes", "reason"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
    unblock: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["userId"], operationFields: ["userId"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
  }
  policy = { highRisk: true }
  description = "Temporarily block a user from triggering Yui Chat replies. Admin/master may manage others; normal users can only check or block themselves."
  parameters = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["block", "unblock", "check", "list"], description: "Operation to perform." },
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
    const target = text(args.userId || current).trim()
    if (!target && action !== "list") return "缺少要处理的用户 ID。"
    const canManageOthers = Boolean(e.isMaster || isGroupAdmin(e))
    if (target && target !== current && !canManageOthers) return "权限不足：普通用户只能查看或屏蔽自己。"
    if (action === "list") {
      if (!canManageOthers) return "权限不足：只有主人或群管理员可以查看屏蔽列表。"
      const rows = listBlockedUsers()
      return rows.length
        ? rows.map((row, index) => `${index + 1}. ${row.userId} 剩余 ${row.remaining}${row.reason ? `，原因：${row.reason}` : ""}`).join("\n")
        : "当前没有临时屏蔽用户。"
    }
    if (action === "check") {
      const row = getBlockedUser(target)
      return row ? `${target} 已被临时屏蔽，剩余 ${row.remaining}${row.reason ? `，原因：${row.reason}` : ""}` : `${target} 未被屏蔽。`
    }
    if (action === "unblock") {
      if (target !== current && !canManageOthers) return "权限不足：普通用户只能解除自己的屏蔽。"
      return unblockUser(e, { userId: target }) ? `已解除 ${target} 的临时屏蔽。` : `${target} 当前未被屏蔽。`
    }
    if (action !== "block") return "未知 action，可用：block / unblock / check / list。"

    const config = record(context.config || configStore.get())
    const tools = record(config.tools)
    const builtin = record(tools.builtin)
    const cfg = record(builtin.blockUser)
    const defaultMinutes = Math.max(1, Math.min(Number(cfg.defaultMinutes || 30), 10080))
    const maxMinutes = Math.max(1, Math.min(Number(cfg.maxMinutes || 720), 10080))
    const minutes = Math.max(1, Math.min(Number(args.durationMinutes || defaultMinutes), maxMinutes))
    const row = blockUser(e, {
      userId: target,
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
