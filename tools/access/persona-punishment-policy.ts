import { defaultPersonaPunishmentConfig } from "../../config/defaults.js"
import { resolveToolRuntimeConfig } from "../../extensions/runtime-config.js"
import { isGroupEvent } from "../../core/message/event-scope.js"
import { punishmentScope } from "../../core/chat/persona-punishments.js"
import { resolveBoundaryRole } from "./roles.js"
import type { UnknownRecord } from "../../core/message/types.js"
function record(value: unknown): UnknownRecord { return value && typeof value === "object" ? value as UnknownRecord : {} }
export const personaPunishmentConfigSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean", title: "启用人物自主处罚", default: defaultPersonaPunishmentConfig.enabled, description: "还需启用工具并授权普通用户角色或指定用户。" },
    allowIgnore: { type: "boolean", title: "允许不回复", default: defaultPersonaPunishmentConfig.allowIgnore },
    allowMute: { type: "boolean", title: "允许禁言", default: defaultPersonaPunishmentConfig.allowMute, description: "机器人必须具有群管理权限。" },
    maxIgnoreSeconds: { type: "integer", title: "不回复最长秒数（最多30天）", minimum: 1, maximum: 2592000, default: defaultPersonaPunishmentConfig.maxIgnoreSeconds },
    maxMuteSeconds: { type: "integer", title: "禁言最长秒数（最多30天）", minimum: 1, maximum: 2592000, description: "默认2592000秒（30天）；AI在此上限内根据实际行为自主决定每次时长。", default: defaultPersonaPunishmentConfig.maxMuteSeconds },
  },
}
export function personaPunishmentConfig(config: unknown): Readonly<UnknownRecord> {
  return resolveToolRuntimeConfig({ name: "persona_punish", common: { configSchema: personaPunishmentConfigSchema } }, config)
}
export function assertPersonaPunishmentAvailable(config: unknown, event: unknown, requireIdentity = false): void {
  if (personaPunishmentConfig(config).enabled !== true) throw new Error("人物自主处罚未开启。")
  const e = record(event)
  if (resolveBoundaryRole(e) !== "user") throw new Error("主人、群主和管理员受保护，不能被人物处罚。")
  const cfg = personaPunishmentConfig(config)
  if (cfg.allowIgnore !== true && (cfg.allowMute !== true || !isGroupEvent(e))) throw new Error("当前会话没有启用的人物处罚类型。")
  if (!requireIdentity) return
  const scope = punishmentScope(e)
  if (scope.userId === scope.botId) throw new Error("不能处罚机器人自身。")
  if (!/^[1-9]\d*$/.test(scope.userId) || !/^[1-9]\d*$/.test(scope.botId) || (isGroupEvent(e) && !/^[1-9]\d*$/.test(scope.groupId))) throw new Error("缺少可信的当前用户、机器人或群身份。")
}

