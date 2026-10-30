import type { UnknownRecord } from "../core/message/types.js"
import { groupKey, userKey } from "./scopes.js"

export interface MemoryImageSelection {
  scope: "self" | "user" | "group" | "all"
  userId?: string
}

export interface MemoryImageRead {
  items: UnknownRecord[]
  complete: boolean
  warning?: string
}

/** 只依据本轮真实请求开启记忆附件，不让模型生成的绘图描述扩大读取范围。 */
export function isMemoryImageRequest(value: unknown): boolean {
  const text = String(value || "").trim()
  if (!/记忆/u.test(text) || !/(?:作图|画图|绘画|绘制|生图|画(?:一|张|个|幅)|生成.{0,12}(?:图|插画)|创作.{0,12}(?:图|画))/u.test(text)) return false
  // “不用提炼，直接带记忆全文作图”是否定压缩步骤，不能误判为禁止使用记忆。
  const usage = text.replace(/(?:不要|别|无需|不用|不必|不需要)\s*(?:再)?(?:提炼|总结|概括|压缩|截断)(?:记忆)?/gu, "")
  if (/(?:不要|别(?!人)|无需|不用|不必|禁止|不想|不愿|不需要|不希望).{0,24}(?:记忆|作图|画|生图)/u.test(usage)) return false
  if (/(?:举例|示例|假设|转发|引用|这句话|这句命令|解释|是否支持)/u.test(text)) return false
  if (/(?:能否|是否|可以|能不能|你能).{0,40}(?:吗|么|？|\?)\s*$/u.test(text) && !/(?:请|帮我|替我|给我)/u.test(text)) return false
  return true
}

export const MEMORY_IMAGE_HINT = "本轮要求依据记忆作图。直接调用 generate_image，prompt 只写绘图要求，不要先总结或复制记忆。工具会按真实请求者身份，将本人、主人指定成员、本群成员或全部用户范围内的全部有效个人记忆按来源附上全文；不用 memory_manage 分页，不提炼、不静默截断。无权限、对象不明或读取不完整时会明确失败，不能声称已使用全部记忆或已画好。"

/** 主人身份只取宿主事件；群管不因此获得他人的全量记忆读取权限。 */
export function assertMemoryImageSelection(event: UnknownRecord, selection: MemoryImageSelection): void {
  const caller = userKey(event)
  if (!caller || caller === "unknown") throw new Error("无法识别当前用户，未读取绘图参考记忆。")
  if (!["self", "user", "group", "all"].includes(selection.scope)) throw new Error("绘图记忆范围无效。")
  if (selection.scope !== "user" && selection.userId !== undefined) throw new Error("指定用户时请使用 user 范围，不能覆盖本人或群体身份。")
  if (selection.scope === "user" && !/^[a-zA-Z0-9_.:-]{1,100}$/u.test(String(selection.userId || ""))) throw new Error("请指定一位有效的记忆所属用户。")
  if (selection.scope !== "self" && !(selection.scope === "user" && selection.userId === caller) && event.isMaster !== true) throw new Error("只有主人可以使用他人、本群成员或全部用户的全量记忆作图。")
  if (selection.scope === "group" && !groupKey(event)) throw new Error("使用本群成员记忆作图，请在对应群聊中提出请求。")
}
