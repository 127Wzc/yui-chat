import { configStore } from "../../config/store.js"
import { checkAccess } from "../../core/chat/access-control.js"
import { isGroupEvent } from "../../core/message/event-scope.js"
import { extractMessageContext } from "../../core/message/message-context.js"
import { matchPluginCommand, pluginCommand } from "../../core/message/command-prefixes.js"
import { renderPortraitReport, withRenderScope } from "../../core/rendering/render-service.js"
import { deliverRenderedImage } from "../../core/rendering/render-delivery.js"
import { findPortraitType } from "../../memory/portrait-types.js"
import { portraitStore } from "../../memory/portrait.js"
import type { PortraitReport } from "../../memory/portrait.js"
import type { UnknownRecord } from "../../core/message/types.js"

/** 普通成员固定绑定本人；主人入口单独注册，目标只接受真实提及或 QQ 号。 */
export async function runPortraitCommand(e: UnknownRecord, master = false): Promise<string> {
  if (master && e.isMaster !== true) return "只有主人可以操作他人的画像或重提炼。"
  if (!checkAccess(e, configStore.get()).ok) return ""
  if (!isGroupEvent(e)) return "请在已开启采集的群中使用画像功能。"
  const segments = Array.isArray(e.message) ? e.message : []
  const context = extractMessageContext(segments.length ? { ...e, msg: "", raw_message: "" } : e)
  const match = matchPluginCommand(context.text.trim(), "(我的画像|查看画像|重提炼画像|画像|正画像|负画像|找对象|克隆人格)(?:\\s+([\\s\\S]*))?")
  if (!match) return `用法：${pluginCommand(master ? "重提炼画像 @成员或QQ号 [类型] [50–2000]" : "我的画像 [类型] [50–2000]")}`
  let userId = String(e.user_id || "")
  const words = (match[2] || "").trim().split(/\s+/).filter(Boolean)
  let typeId = findPortraitType(match[1])?.id
  for (let i = words.length - 1; i >= 0; i--) {
    const type = findPortraitType(words[i])
    if (!type) continue
    if (typeId) return "请只指定一种画像类型。"
    typeId = type.id; words.splice(i, 1)
  }
  const targets = [...new Set(context.mentions.map(m => String(m.qq)))]
  const managing = master && ["查看画像", "重提炼画像"].includes(match[1])
  if (targets.length) {
    if (!managing) return "普通成员只能查看或生成自己的画像。"
    if (targets.length !== 1 || targets[0] === "all" || targets[0] === String(e.self_id)) return "请只 @ 一位要操作画像的成员。"
    userId = targets[0]
  } else if (managing && /^\d{5,20}$/.test(words[0] || "")) userId = words.shift()!
  if (!master && match[1] === "重提炼画像") return "重提炼仅允许主人或 Web 管理员。"
  const body = words[0] || ""
  if (words.length > 1 || body && (!/^\d{2,4}$/.test(body) || Number(body) < 50 || Number(body) > 2000)) return "类型可选：综合画像、正画像、负画像、找对象、克隆人格；发言数量为 50–2000。"
  const actor = { userId: String(e.user_id || ""), admin: master && e.isMaster === true }
  try {
    let report: PortraitReport
    if (match[1] === "查看画像") {
      const view = await portraitStore.view(e.group_id, userId, actor, typeId)
      if (!view.report) return "当前没有有效的本群画像，可使用“我的画像”生成，或由主人重提炼。"
      report = view.report as PortraitReport
    } else report = (await portraitStore.generate(e.group_id, userId, { actor, typeId, force: match[1] === "重提炼画像", historyCount: body ? Number(body) : undefined })).report
    const config = withRenderScope(configStore.get(), "system")
    const image = await renderPortraitReport(report, config)
    await portraitStore.getReport(e.group_id, userId, report.id, actor)
    await deliverRenderedImage(image, { e, config }, { label: "聊天画像" })
    return report.personaPrompt || ""
  } catch (error) {
    const status = Number((error as { statusCode?: unknown })?.statusCode)
    if ([400, 403, 409, 429, 503].includes(status)) return error instanceof Error ? error.message : "画像暂不可用。"
    // 供应商异常可能带请求正文或鉴权信息，不回传原始错误。
    return "画像处理未完成。已生成的副本会保留，可稍后查看或重试；请管理员检查模型与渲染状态。"
  }
}
