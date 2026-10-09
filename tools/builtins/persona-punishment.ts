import { assertPersonaPunishmentAvailable, personaPunishmentConfig, personaPunishmentConfigSchema } from "../access/persona-punishment-policy.js"
import { configStore } from "../../config/store.js"
import { isGroupEvent } from "../../core/message/event-scope.js"
import { listPersonaPunishments, punishmentScope, reservePersonaPunishment, setPersonaPunishmentStatus } from "../../core/chat/persona-punishments.js"
import { resolveBoundaryRole } from "../access/roles.js"
import { getMemberMap, pickGroup, requireMethod } from "./shared.js"
import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"

function record(value: unknown): UnknownRecord { return value && typeof value === "object" ? value as UnknownRecord : {} }

export class PersonaPunishTool {
  name = "persona_punish"
  configSchema = personaPunishmentConfigSchema
  source = "builtin"
  category = "admin"
  risk = "high"
  tags = ["persona", "punishment"]
  policy = { requiresGroup: false, requiresModelContext: true, personaPunishment: true }
  description = "人物自主处罚：仅针对当前发言者的真实冒犯，暂停回复或禁言，AI根据行为严重程度自主选择实际时长，不得机械地取上限。禁言最多30天且受主人配置上限限制。必须先警告；不得因拒绝、不同观点或引用内容处罚。不接受任何目标参数，不得踢人。启用并授权当前角色后可用；工具会检查保护对象、时长。用户主动要求自我屏蔽/禁言使用普通工具。"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", retryPolicy: "no_ambiguous_retry", maxAttempts: 1, parallelSafe: false }
  parameters = { type: "object", additionalProperties: false, properties: {
    kind: { type: "string", enum: ["ignore", "mute"] },
    seconds: { type: "integer", minimum: 1, maximum: 2592000, description: "AI自主选择的实际处罚秒数，不能超过对应类型的配置上限；不回复和禁言均最多2592000秒（30天），上限不是固定处罚时长。" },
    reason: { type: "string", minLength: 1, maxLength: 120, description: "当前发言中的具体行为；不引用旁人的行为作为处罚依据。" },
  }, required: ["kind", "seconds", "reason"] }
  async execute(args: UnknownRecord, context: ToolExecutionContext = {}): Promise<string> {
    const e = record(context.e)
    const config = context.config || configStore.get()
    assertPersonaPunishmentAvailable(config, e, true)
    const cfg = personaPunishmentConfig(config)
    if (context.actionId || context.agent) throw new Error("人物处罚仅允许主对话执行，不能由动作或子代理发起。")
    if (Object.keys(args).some(key => !["kind", "seconds", "reason"].includes(key))) throw new Error("人物处罚不能指定其他目标或范围。")
    const kind = args.kind
    if (kind !== "ignore" && kind !== "mute") throw new Error("只允许不回复或禁言，不允许踢人。")
    if (cfg[kind === "ignore" ? "allowIgnore" : "allowMute"] !== true) throw new Error("主人未允许此类人物处罚。")
    const seconds = Number(args.seconds)
    const max = Math.min(2592000, Number(cfg[kind === "ignore" ? "maxIgnoreSeconds" : "maxMuteSeconds"]) || (2592000))
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > max) throw new Error(`此类处罚最多 ${max} 秒。`)
    const reason = String(args.reason || "").trim()
    if (!reason || reason.length > 120) throw new Error("需要 1–120 字的具体处罚原因。")
    const scope = punishmentScope(e)
    let mute: ((...args: unknown[]) => unknown) | undefined
    if (isGroupEvent(e)) {
      const group = await pickGroup(e)
      const members = await getMemberMap(group)
      if (members?.get(Number(scope.userId))?.role !== "member") throw new Error("无法确认目标为普通成员，拒绝处罚。")
      if (kind === "mute") {
        if (!["admin", "owner"].includes(String(members?.get(Number(scope.botId))?.role))) throw new Error("机器人没有可确认的群管理权限。")
        const until = Number(members?.get(Number(scope.userId))?.shutup_time || 0)
        if (until * 1000 > Date.now()) throw new Error("目标已有禁言，不能覆盖管理处罚。")
        mute = requireMethod(group, "muteMember", "禁言成员")
      }
    } else if (kind === "mute") throw new Error("QQ 禁言只能在当前群使用。")
    const row = await reservePersonaPunishment(e, kind, seconds, reason)
    if (mute) {
      // 抛错或未知回执时保留 uncertain，防止超时后重复处罚。
      const result = await mute(Number(scope.userId), seconds)
      if (result === false) throw new Error("禁言未确认成功；记录保留为待核实，禁止重复处罚。")
      await setPersonaPunishmentStatus(row.id, "active")
    }
    return `人物处罚已执行：${kind === "ignore" ? "暂停回复" : "禁言"} ${seconds} 秒，到期恢复。原因：${reason}。`
  }
}

export class PersonaPunishmentReleaseTool {
  name = "persona_punishment_release"
  source = "builtin"
  category = "admin"
  risk = "high"
  tags = ["persona", "punishment"]
  policy = { requiresGroup: false, personaPunishmentRelease: true }
  description = "管理员或主人按记录编号或成员QQ提前解除人物处罚。按QQ时只查当前会话。管理员只能解除当前群记录；QQ 禁言无法核实归属时请在群管理中人工解除。"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  parameters = { type: "object", additionalProperties: false, properties: { id: { type: "string", description: "处罚记录编号；与userId二选一。" }, userId: { type: "string", description: "当前群或私聊中的目标QQ；无需知道记录编号。" } } }
  async execute(args: UnknownRecord, context: ToolExecutionContext = {}): Promise<string> {
    const e = record(context.e)
    const role = resolveBoundaryRole(e)
    if (role === "user") throw new Error("解除人物处罚需要管理员或主人权限。")
    const scope = punishmentScope(e)
    if (Boolean(args.id) === Boolean(args.userId) || (args.userId && !/^[1-9]\d*$/.test(String(args.userId)))) throw new Error("请提供记录编号或有效的目标QQ，二选一。")
    const row = (await listPersonaPunishments()).find(item => args.id ? item.id === args.id : item.userId === args.userId && item.groupId === scope.groupId && item.botId === scope.botId)
    if (!row) return "该处罚已到期、解除或不存在。"
    if (role !== "master" && (!scope.groupId || scope.groupId !== row.groupId)) throw new Error("只能解除当前群的人物处罚。")
    if (scope.botId !== row.botId) throw new Error("请使用执行处罚的机器人解除。")
    if (row.kind === "mute") {
      const group = await pickGroup(e, Number(row.groupId))
      const members = await getMemberMap(group)
      const until = Number(members?.get(Number(row.userId))?.shutup_time)
      if (!Number.isFinite(until)) throw new Error("无法核实当前禁言，请在群管理中人工解除或等待到期。")
      if (until * 1000 > Date.now()) {
        if (Math.abs(until * 1000 - row.until) > 5000) throw new Error("当前禁言时长已变化，可能属于管理处罚，请人工核实。")
        if (!["owner", "admin"].includes(String(members?.get(Number(row.botId))?.role))) throw new Error("机器人没有群管理权限。")
        if (await requireMethod(group, "muteMember", "解除禁言")(Number(row.userId), 0) === false) throw new Error("宿主未确认解除成功。")
      }
    }
    await setPersonaPunishmentStatus(row.id, "released")
    return "已解除该人物处罚；其他管理限制仍独立生效。"
  }
}
