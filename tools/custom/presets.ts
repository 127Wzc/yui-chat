import { cloneJsonValue } from "../../core/shared/json-values.js"

type AnyRecord = Record<string, any>

export const toolPresets = {
  core: {
    label: "核心",
    enabledTools: ["knowledge_manage", "memory_manage", "bilibili_media", "message_send", "generate_image", "query_userinfo", "render_image", "schedule_task", "image_media", "web_search"],
  },
  media: {
    label: "媒体",
    enabledTools: ["bilibili_media", "message_send", "generate_image"],
  },
  search: {
    label: "检索",
    enabledTools: ["knowledge_manage", "weather", "website_fetch", "web_search", "github_api", "bilibili_media", "message_send", "image_media"],
  },
  entertainment: {
    label: "娱乐",
    enabledTools: ["send_dice", "send_rps", "emoji_like", "group_poke"],
  },
  admin_safe: {
    label: "群管安全",
    enabledTools: ["query_userinfo", "mute_user", "kick_out", "edit_card", "set_title", "message_manage", "block_user"],
  },
  memory: {
    label: "记忆画像",
    enabledTools: ["memory_manage"],
  },
  render: {
    label: "渲染",
    enabledTools: ["render_image"],
  },
}

export function applyToolPreset(config: AnyRecord, presetNames: unknown[] = []): AnyRecord {
  const next = cloneJsonValue(config) as AnyRecord
  const tools = next.tools && typeof next.tools === "object" && !Array.isArray(next.tools) ? next.tools as AnyRecord : {}
  next.tools = tools
  const enabled = new Set(Array.isArray(tools.enabledTools) ? tools.enabledTools.map(String) : [])
  for (const name of presetNames) {
    const preset = toolPresets[String(name) as keyof typeof toolPresets]
    if (!preset) continue
    for (const tool of preset.enabledTools || []) enabled.add(tool)
  }
  next.tools.enabledTools = [...enabled]
  return next
}
