import { boundaryRoles, type BoundaryRole } from "./roles.js"

type Choice = "allow" | "optional" | "deny" | "protected"
interface Recommendation { group: string; description: string; roles: Record<BoundaryRole, Choice> }
const all: Record<BoundaryRole, Choice> = { user: "allow", groupAdmin: "allow", groupOwner: "allow", master: "allow" }
const optional: Record<BoundaryRole, Choice> = { user: "optional", groupAdmin: "optional", groupOwner: "optional", master: "allow" }
const management: Record<BoundaryRole, Choice> = { user: "deny", groupAdmin: "allow", groupOwner: "allow", master: "allow" }
/** 内置工具的默认角色范围，也是面板推荐方案的唯一来源；不自动启用工具。 */
export const builtinRoleRecommendations: Record<string, Recommendation> = {
  tool_search: { group: "基础能力", description: "只发现已有权限的工具。", roles: all },
  knowledge_manage: { group: "基础能力", description: "只查询、推荐已授权知识库内容。", roles: all },
  command_handoff: { group: "高级能力", description: "向当前会话投递宿主指令，独立授权。", roles: optional },
  command_knowledge_audit: { group: "高级能力", description: "查看指令库质量报告。", roles: optional },
  memory_manage: { group: "个人能力", description: "限当前用户自己的记忆与资料。", roles: all },
  schedule_task: { group: "个人能力", description: "限自己的提醒与定时任务。", roles: all },
  query_userinfo: { group: "信息查询", description: "仅宿主可见的基本资料，不授权他人记忆。", roles: all },
  weather: { group: "信息查询", description: "使用已配置的天气服务。", roles: all },
  web_search: { group: "信息查询", description: "使用已启用搜索渠道。", roles: all },
  website_fetch: { group: "信息查询", description: "涉及用户 URL、私网与网络策略，按需授权。", roles: optional },
  github_api: { group: "信息查询", description: "可能使用配置的 Token 访问私有资源。", roles: optional },
  bilibili_media: { group: "媒体娱乐", description: "搜索和投递媒体，保留大小与频率限制。", roles: all },
  image_media: { group: "媒体娱乐", description: "使用已启用图片渠道和内容规则。", roles: all },
  music_play: { group: "媒体娱乐", description: "在当前会话播放音乐。", roles: all },
  message_send: { group: "消息输出", description: "只向当前会话投递。", roles: all },
  generate_image: { group: "内容生成", description: "涉及模型费用、额度和并发，按需开放。", roles: optional },
  render_image: { group: "内容生成", description: "内容排版与图片渲染。", roles: all },
  render_url_screenshot: { group: "内容生成", description: "需截图开关、网络及域名策略允许。", roles: optional },
  send_dice: { group: "日常互动", description: "当前会话互动。", roles: all },
  send_rps: { group: "日常互动", description: "当前会话互动。", roles: all },
  emoji_like: { group: "日常互动", description: "群消息表情回应，不属于群管理。", roles: all },
  group_poke: { group: "日常互动", description: "群内戳一戳，保留次数限制。", roles: all },
  edit_card: { group: "自助与群管理", description: "普通用户仅本人；管理员以上可管理本群成员。", roles: all },
  mute_user: { group: "自助与群管理", description: "普通用户明确请求禁言本人；解禁、管理他人需群管理身份。", roles: all },
  block_user: { group: "自助与群管理", description: "普通用户仅屏蔽或查询本人；解除需管理身份，全局操作仅主人。", roles: all },
  kick_out: { group: "群管理", description: "仅本群管理，不纳入人物自主处罚。", roles: management },
  message_manage: { group: "群管理", description: "管理本群消息。", roles: management },
  set_title: { group: "群管理", description: "普通用户仅本人；管理他人需管理员以上，机器人通常需为群主。", roles: all },
  persona_punish: { group: "人物行为", description: "授权表示允许人物处罚当前普通发言者，不赋予用户处罚他人的能力。", roles: { user: "optional", groupAdmin: "protected", groupOwner: "protected", master: "protected" } },
  persona_punishment_release: { group: "人物行为", description: "管理员与群主仅本群，主人可按记录解除。", roles: management },
  dispatch_subagent: { group: "高级能力", description: "保留功能开关、并发、深度与 token 限额。", roles: optional },
}

export const builtinPublicTools = new Set(Object.entries(builtinRoleRecommendations)
  .filter(([, item]) => boundaryRoles.every(role => item.roles[role] === "allow"))
  .map(([name]) => name))

export function builtinDefaultAllowed(name: string, role: BoundaryRole): boolean | undefined {
  const item = Object.hasOwn(builtinRoleRecommendations, name) ? builtinRoleRecommendations[name] : undefined
  if (!item) return undefined
  // 三项本人自助在执行策略中按参数收窄，不能默认授予普通用户管理操作。
  if (role === "user" && ["mute_user", "edit_card", "set_title"].includes(name)) return false
  return item.roles[role] === "allow"
}

/** 只覆盖已展示的内置项，保留扩展工具、包授权和用户例外。 */
export function applyBuiltinRolePreset(profile: { allowedTools?: unknown; deniedTools?: unknown }, role: BoundaryRole, names: string[]) {
  if (!boundaryRoles.includes(role)) throw new Error("无效角色")
  const selected = new Set(names.filter(name => Object.hasOwn(builtinRoleRecommendations, name)))
  const keep = (value: unknown) => (Array.isArray(value) ? value.map(String) : []).filter(name => !selected.has(name))
  return {
    ...profile,
    allowedTools: [...keep(profile.allowedTools), ...[...selected].filter(name => builtinRoleRecommendations[name].roles[role] === "allow")],
    deniedTools: [...keep(profile.deniedTools), ...[...selected].filter(name => builtinRoleRecommendations[name].roles[role] !== "allow")],
  }
}
