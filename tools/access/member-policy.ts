import { stripPluginCommand } from "../../core/message/command-prefixes.js"
import { groupIdFromEvent, isGroupEvent } from "../../core/message/event-scope.js"
import { resolveBoundaryRole } from "./roles.js"

type RecordValue = Record<string, unknown>
export function memberTarget(args: RecordValue, event: RecordValue, field = "qq"): string {
  const sender = event.sender as RecordValue | undefined
  const current = String(event.user_id || sender?.user_id || "").trim()
  const target = String(args[field] ?? current).trim()
  if (!/^[1-9]\d*$/.test(current) || !/^[1-9]\d*$/.test(target)) throw new Error("缺少有效的调用者或目标用户 ID。")
  return target
}

/** 身份与操作对象的硬边界：动作或个人授权都不能把普通用户提升为群管。 */
export function assertMemberOperation(operation: string, args: RecordValue, event: RecordValue): void {
  const role = resolveBoundaryRole(event)
  const master = role === "master"
  const admin = master || role === "groupAdmin" || role === "groupOwner"
  const currentGroup = groupIdFromEvent(event)
  const group = String(args.groupId ?? currentGroup).trim()
  const sender = event.sender as RecordValue | undefined
  const current = String(event.user_id || sender?.user_id || "").trim()
  if (operation === "block") {
    if (isGroupEvent(event) && !/^[1-9]\d*$/.test(currentGroup)) throw new Error("缺少有效的当前群号。")
    if (args.scope === "global" && !master) throw new Error("全局管理屏蔽需要主人权限。")
    if (args.action === "unblock" && !admin) throw new Error("解除屏蔽需要管理员或主人权限，请联系管理处理。")
    if (args.action === "list") {
      if (!admin) throw new Error("查看屏蔽列表需要群管理员或主人权限。")
      return
    }
    const target = memberTarget(args, event, "userId")
    if (target !== current && !admin) throw new Error("普通用户只能查看或屏蔽自己。")
    return
  }
  if (!isGroupEvent(event)) throw new Error("此操作只能在群聊中使用。")
  if (!/^[1-9]\d*$/.test(group)) throw new Error("缺少有效的目标群号。")
  if (!master && group !== currentGroup) throw new Error("只能操作当前群，不能借用当前群权限管理其他群。")
  if (operation === "manage") {
    if (!admin) throw new Error("操作他人需要目标群管理员、群主或主人权限。")
    return
  }
  const target = memberTarget(args, event)
  if (operation === "mute" && (!Number.isSafeInteger(Number(args.seconds)) || Number(args.seconds) < 0)) throw new Error("禁言时长必须是非负整数秒。")
  if ((target !== current || (operation === "mute" && Number(args.seconds) === 0)) && !admin) {
    throw new Error("管理他人或解除禁言需要目标群管理员、群主或主人权限。")
  }
}

/** 只认当前消息中直接、肯定的自助请求；不让模型用“目标是自己”冒充用户同意。 */
export function assertSelfRestrictionRequest(operation: "mute" | "block", event: RecordValue, config: unknown = {}): void {
  let message = stripPluginCommand(event.raw_message || event.msg || "").replace(/^chat\s+/, "").trim()
  const persona = (config as RecordValue)?.persona as RecordValue | undefined
  const names = [persona?.firstPerson, ...(Array.isArray(persona?.aliases) ? persona.aliases : [])].filter(value => typeof value === "string" && value.length).map(String).sort((a, b) => b.length - a.length)
  const name = names.find(value => message.startsWith(value))
  if (name) message = message.slice(name.length).replace(/^[，,\s]+/, "")
  const request = operation === "mute" ? /^(?:请|麻烦|帮我)?(?:把我禁言|禁言我|我要禁言|给我禁言)/ : /^(?:请|麻烦|帮我)?(?:屏蔽我|把我屏蔽|拉黑我|把我拉黑|暂时别回复我|别回复我|不要回复我)/
  const duration = message.replace(request, "")
  const validTail = /^(?:\s*(?:\d+(?:\.\d+)?|[一二两三四五六七八九十百半]+)\s*(?:秒钟?|分钟?|小时|天))?[吧呀啊。！!~～\s]*$/.test(duration)
  if (!request.test(message) || !validTail || /(?:不要禁言|别禁言|不要屏蔽|别屏蔽|不想|取消)/.test(message)) throw new Error("需要用户在当前消息中明确提出自助请求；人物自主处罚必须使用独立的人物处罚工具。")
}
