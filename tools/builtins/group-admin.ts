import { configStore } from "../../config/store.js"
import { isGroupEvent } from "../../core/message/event-scope.js"
import { arrayFrom, currentGroup, currentUser, getMemberMap, isGroupAdmin, numberOrDefault, pickGroup, requireMethod } from "./shared.js"
import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"

interface GroupAdminEvent extends UnknownRecord {
  isGroup?: boolean
  isMaster?: boolean
  self_id?: unknown
  user_id?: unknown
  message_id?: unknown
  source_message_id?: unknown
  reply_id?: unknown
  group?: UnknownRecord
  bot?: UnknownRecord
}

interface GroupAdminContext extends ToolExecutionContext {
  e?: GroupAdminEvent
}

type ToolArgs = UnknownRecord

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function errorMessage(error: unknown): string {
  return text(record(error).message || error || "执行失败")
}

const emotionMapping = {
  happy: [2, 74, 109, 272, 295, 305, 318, 319, 324, 339],
  proud: [4, 16, 28, 29, 99, 101, 178, 269, 270, 277, 283, 299, 307, 336, 426],
  shy: [6, 20, 21],
  sad: [5, 34, 35, 36, 37, 173, 264, 265, 267, 425],
  angry: [11, 26, 31, 105],
  surprised: [3, 325],
  confused: [32, 268],
  pleading: [111, 353],
  awkward: [100, 306, 342, 344, 347],
  like: [76],
  love: [66],
}

function requireAdmin(e: GroupAdminEvent = {}, action = "执行群管操作"): void {
  const config = record(configStore.get())
  const tools = record(config.tools)
  const builtin = record(tools.builtin)
  const cfg = record(builtin.groupAdmin)
  const boundaryAccess = record(tools.boundaryAccess)
  if (boundaryAccess.enabled !== true && cfg.requireMaster === true && !e.isMaster) {
    throw new Error(`${action} 需要主人权限。`)
  }
  if (!isGroupAdmin(e)) throw new Error(`${action} 需要主人或群管理员权限。`)
}

async function ensureBotCanManage(e: GroupAdminEvent, group: unknown): Promise<void> {
  const members = await getMemberMap(group)
  const bot = record(e.bot)
  const botId = Number(e.self_id || bot.uin || 0)
  const botRole = record(members?.get(botId)).role
  if (botRole === "member") throw new Error("机器人不是群管理员，无法执行群管操作。")
}

/** 禁言工具：在权限和机器人群管角色校验后执行单个成员禁言。 */
export class MuteUserTool {
  name = "mute_user"
  source = "builtin"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["qq", "groupId"], operationFields: ["qq", "groupId", "seconds"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  policy = { highRisk: true, requiresGroup: true, requiresGroupAdmin: true }
  description = "Mute a group member for a number of seconds. Requires master or group admin permission."
  parameters = {
    type: "object",
    properties: {
      qq: { type: "string", description: "Target QQ. Defaults to current sender." },
      groupId: { type: "string", description: "Group id. Defaults to current group." },
      seconds: { type: "number", description: "Mute duration in seconds. Use 0 to unmute." },
    },
    required: ["seconds"],
  }

  async execute(args: ToolArgs = {}, context: GroupAdminContext = {}): Promise<string> {
    const e = context.e || {}
    requireAdmin(e, "禁言")
    const groupId = numberOrDefault(args.groupId, currentGroup(e))
    const qq = text(args.qq || currentUser(e)).trim()
    const seconds = Math.max(0, Math.min(Number(args.seconds ?? 600), 86400 * 30))
    const group = await pickGroup(e, groupId)
    await ensureBotCanManage(e, group)
    if (qq === "all") return "已拒绝全员禁言：该操作风险过高。"
    await requireMethod(group, "muteMember", "禁言成员")(Number(qq), seconds)
    return seconds === 0 ? `已解除 ${qq} 的禁言。` : `已禁言 ${qq} ${seconds} 秒。`
  }
}

/** 踢人工具：只允许主人或群管理员操作，并统一校验机器人权限。 */
export class KickOutTool {
  name = "kick_out"
  source = "builtin"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["qq", "groupId"], operationFields: ["qq", "groupId", "rejectAddRequest"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  policy = { highRisk: true, requiresGroup: true, requiresGroupAdmin: true }
  description = "Kick a group member out. Requires master or group admin permission."
  parameters = {
    type: "object",
    properties: {
      qq: { type: "string", description: "Target QQ. Defaults to current sender." },
      groupId: { type: "string", description: "Group id. Defaults to current group." },
      rejectAddRequest: { type: "boolean", description: "Whether to reject future join request if supported." },
    },
  }

  async execute(args: ToolArgs = {}, context: GroupAdminContext = {}): Promise<string> {
    const e = context.e || {}
    requireAdmin(e, "踢出成员")
    const groupId = numberOrDefault(args.groupId, currentGroup(e))
    const qq = Number(args.qq || currentUser(e))
    const group = await pickGroup(e, groupId)
    await ensureBotCanManage(e, group)
    await requireMethod(group, "kickMember", "踢出成员")(qq, Boolean(args.rejectAddRequest))
    return `已将 ${qq} 移出群 ${groupId}。`
  }
}

/** 群名片工具：普通用户只可修改自己的名片，管理员可修改他人。 */
export class EditCardTool {
  name = "edit_card"
  source = "builtin"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["qq", "groupId"], operationFields: ["qq", "groupId", "card"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  policy = { highRisk: true, requiresGroup: true }
  description = "Edit a group member card. Admin can edit others; normal user can only request self card edit if adapter permits."
  parameters = {
    type: "object",
    properties: {
      qq: { type: "string", description: "Target QQ. Defaults to current sender." },
      card: { type: "string", description: "New group card." },
      groupId: { type: "string", description: "Group id. Defaults to current group." },
    },
    required: ["card"],
  }

  async execute(args: ToolArgs = {}, context: GroupAdminContext = {}): Promise<string> {
    const e = context.e || {}
    const qq = Number(args.qq || currentUser(e))
    if (qq !== currentUser(e)) requireAdmin(e, "修改他人群名片")
    const card = text(args.card).trim().slice(0, 60)
    if (!card) return "缺少新的群名片。"
    const groupId = numberOrDefault(args.groupId, currentGroup(e))
    const group = await pickGroup(e, groupId)
    await ensureBotCanManage(e, group)
    await requireMethod(group, "setCard", "修改群名片")(qq, card)
    return `已将 ${qq} 的群名片改为 ${card}。`
  }
}

/** 群头衔工具：执行群头衔设置并返回适配器结果。 */
export class SetTitleTool {
  name = "set_title"
  source = "builtin"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["qq", "groupId"], operationFields: ["qq", "groupId", "title"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  policy = { highRisk: true, requiresGroup: true, requiresGroupAdmin: true }
  description = "Set a group special title. Usually requires bot owner role and master/admin permission."
  parameters = {
    type: "object",
    properties: {
      qq: { type: "string", description: "Target QQ. Defaults to current sender." },
      title: { type: "string", description: "Special title." },
      groupId: { type: "string", description: "Group id. Defaults to current group." },
    },
    required: ["title"],
  }

  async execute(args: ToolArgs = {}, context: GroupAdminContext = {}): Promise<string> {
    const e = context.e || {}
    requireAdmin(e, "设置群头衔")
    const title = text(args.title).trim().slice(0, 30)
    if (!title) return "缺少群头衔。"
    const groupId = numberOrDefault(args.groupId, currentGroup(e))
    const qq = Number(args.qq || currentUser(e))
    const group = await pickGroup(e, groupId)
    const ok = await requireMethod(group, "setTitle", "设置群头衔")(qq, title)
    return ok === false ? "设置群头衔失败。" : `已将 ${qq} 的群头衔设为 ${title}。`
  }
}

/** 表情回应工具：从情绪映射中选择一个平台表情并回应目标消息。 */
export class EmojiLikeTool {
  name = "emoji_like"
  source = "builtin"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["messageId"], operationFields: ["emotion", "messageId"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  policy = { requiresGroup: true }
  description = "React to current or referenced message with an emoji by emotion type."
  parameters = {
    type: "object",
    properties: {
      emotion: { type: "string", enum: Object.keys(emotionMapping), description: "Emotion to express." },
      messageId: { type: "string", description: "Target message id. Defaults to current/referenced message." },
    },
    required: ["emotion"],
  }

  async execute(args: ToolArgs = {}, context: GroupAdminContext = {}): Promise<string> {
    const e = context.e || {}
    const emotion = text(args.emotion) as keyof typeof emotionMapping
    const pool = emotionMapping[emotion] || emotionMapping.like
    const emojiId = pool[Math.floor(Math.random() * pool.length)]
    const messageId = args.messageId || e.source_message_id || e.message_id
    if (!messageId) return "缺少可贴表情的消息 ID。"
    const group = record(e.group)
    const bot = record(e.bot)
    const adapter = record(bot.adapter)
    if (typeof group.setEmojiLike === "function") await (group.setEmojiLike as (...args: unknown[]) => unknown).call(e.group, messageId, emojiId)
    else if (typeof adapter.setEmojiLike === "function") await (adapter.setEmojiLike as (...args: unknown[]) => unknown).call(bot.adapter, e, messageId, emojiId)
    else return "当前适配器不支持贴表情。"
    return `已贴表情 ${emojiId}。`
  }
}

/** 戳一戳工具：显式 count 才会重复执行，每个目标按轮次执行并返回逐目标统计。 */
export class GroupPokeTool {
  name = "group_poke"
  source = "builtin"
  execution = {
    effect: "non_idempotent",
    repeatPolicy: "explicit_only",
    supportsCount: true,
    countField: "count",
    maxCount: 10,
    targetFields: ["qqs"],
    operationFields: ["qqs"],
    promptCount: { keywords: ["戳", "poke"], units: ["次", "下"], maxClauses: 4 },
    retryPolicy: "no_ambiguous_retry",
    maxAttempts: 1,
    operationFamily: "group_poke",
  }
  requiresFinalReply = false
  policy = { requiresGroup: true }
  description = "Poke one or more group members once. Repeating the same target in one request is ignored. Only works in group chat."
  parameters = {
    type: "object",
    properties: {
      qqs: { type: "array", items: { type: "string" }, description: "Target QQ numbers." },
      count: { type: "integer", minimum: 1, maximum: 10, description: "How many times to poke each target. Defaults to 1; use this for an explicit repeated action." },
    },
    required: ["qqs"],
  }

  async execute(args: ToolArgs = {}, context: GroupAdminContext = {}): Promise<string | UnknownRecord> {
    const e = context.e || {}
    if (!isGroupEvent(e)) return "戳一戳只能在群聊中使用。"
    const group = await pickGroup(e)
    const qqs = [...new Set(arrayFrom(args.qqs || args.qq))].slice(0, 5)
    if (!qqs.length) return "缺少要戳的 QQ。"
    const count = Math.max(1, Math.min(10, Number.isFinite(Number(args.count)) ? Math.trunc(Number(args.count)) : 1))
    let successCount = 0
    const failed: string[] = []
    const successByTarget: Record<string, number> = Object.fromEntries(qqs.map(qq => [qq, 0]))
    for (let index = 0; index < count; index++) {
      for (const qq of qqs) {
        try {
          await requireMethod(group, "pokeMember", "戳一戳")(Number(qq))
          successCount++
          successByTarget[qq]++
        } catch (error) {
          failed.push(`${qq}:${errorMessage(error)}`)
        }
      }
    }
    const targetCounts = Object.fromEntries(qqs.map(qq => [`qqs:${qq}`, successByTarget[qq]]))
    return {
      status: successCount === count * qqs.length ? "success" : successCount ? "partial" : "failed",
      content: [`已戳 ${successCount} 次：${qqs.join(", ") || "无"}`, failed.length ? `失败：${failed.join("; ")}` : ""].filter(Boolean).join("\n"),
      executedCount: successCount,
      targetCounts,
      retryAllowed: false,
    }
  }
}

/** 群消息管理工具：只负责撤回和精华状态，不查询历史、不发送消息。 */
export class MessageManageTool {
  name = "message_manage"
  source = "builtin"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["messageId"], operationFields: ["action", "messageId"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  policy = { highRisk: true, requiresGroup: true, requiresGroupAdmin: true }
  description = "Manage one group message: recall it, mark it as essence, or remove its essence mark. Uses the replied/current message unless messageId is provided. Group admins only."
  parameters = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["recall", "essence", "unessence"], description: "recall=撤回；essence=设为精华；unessence=移除精华。" },
      messageId: { type: "string", description: "目标消息 ID。通常省略，默认使用被引用的消息，其次使用当前消息。" },
    },
    required: ["action"],
  }

  async execute(args: ToolArgs = {}, context: GroupAdminContext = {}): Promise<string> {
    const e = context.e || {}
    requireAdmin(e, "处理消息")
    if (!isGroupEvent(e)) return "消息管理只能在群聊中使用。"
    const groupTarget = await pickGroup(e)
    const messageId = text(args.messageId || e.source_message_id || e.reply_id || e.message_id).trim()
    if (!messageId) return "缺少可处理的消息 ID。"
    const action = text(args.action).trim()
    if (action === "recall") {
      await requireMethod(groupTarget, "recallMsg", "撤回消息")(messageId)
      return `已撤回消息 ${messageId}。`
    }
    const botOrGroup = e.bot || groupTarget
    const bot = record(e.bot)
    const group = record(groupTarget)
    if (action === "essence") {
      const fn = bot.setEssenceMessage || group.setEssenceMessage
      if (typeof fn !== "function") return "当前适配器不支持设置精华消息。"
      await fn.call(botOrGroup, messageId)
      return `已设置精华消息 ${messageId}。`
    }
    if (action === "unessence") {
      const fn = bot.removeEssenceMessage || group.removeEssenceMessage
      if (typeof fn !== "function") return "当前适配器不支持移除精华消息。"
      await fn.call(botOrGroup, messageId)
      return `已移除精华消息 ${messageId}。`
    }
    return "未知 action，可用：recall / essence / unessence。"
  }
}

export function createGroupAdminTools(): unknown[] {
  return [
    new MuteUserTool(),
    new KickOutTool(),
    new EditCardTool(),
    new SetTitleTool(),
    new EmojiLikeTool(),
    new GroupPokeTool(),
    new MessageManageTool(),
  ]
}
