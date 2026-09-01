import { createCommandTools } from "./command.js"
import { createEntertainmentTools } from "./entertainment.js"
import { createGroupAdminTools } from "./group-admin.js"
import { createMediaTools } from "./media.js"
import { createMemoryTools } from "./memory.js"
import { createNetworkTools } from "./network.js"
import { createRenderTools } from "./render.js"
import { createScheduleTools } from "./schedule.js"
import { createSocialTools } from "./social.js"
import { createAgentTools } from "./subagent.js"
import { createDiscoveryTools } from "./discovery.js"
import { annotateTools } from "../support/contract.js"
import type { NormalizedTool } from "../support/contract.js"

type BuiltinToolFactory = () => unknown[]

interface BuiltinToolGroup {
  id: string
  label: string
  risk: string
  tags: string[]
  policy?: Record<string, unknown>
  factory: BuiltinToolFactory
}

/** 内置工具分组目录；分组元数据只负责公共属性，具体工具仍由各模块自行声明。 */
export const builtinToolGroups: BuiltinToolGroup[] = [
  { id: "command", label: "指令", risk: "low", tags: ["knowledge"], factory: createCommandTools },
  { id: "discovery", label: "工具发现", risk: "low", tags: ["tool-discovery"], factory: createDiscoveryTools },
  { id: "memory", label: "记忆", risk: "low", tags: ["memory"], factory: createMemoryTools },
  { id: "network", label: "网络检索", risk: "external", tags: ["web", "search"], policy: { externalNetwork: true }, factory: createNetworkTools },
  { id: "media", label: "媒体", risk: "medium", tags: ["message", "media"], factory: createMediaTools },
  { id: "render", label: "渲染", risk: "low", tags: ["image", "help"], factory: createRenderTools },
  { id: "social", label: "社交", risk: "medium", tags: ["message"], factory: createSocialTools },
  { id: "schedule", label: "定时任务", risk: "medium", tags: ["schedule", "message"], factory: createScheduleTools },
  { id: "admin", label: "群管", risk: "high", tags: ["group", "permission"], policy: { highRisk: true, requiresGroup: true }, factory: createGroupAdminTools },
  { id: "entertainment", label: "娱乐", risk: "medium", tags: ["message", "fun"], factory: createEntertainmentTools },
  { id: "agent", label: "子代理", risk: "high", tags: ["agent", "orchestration"], policy: { highRisk: true, requiresMaster: true }, factory: createAgentTools },
]

/** 创建并统一归一化所有内置工具，供 ToolRegistry 注册。 */
export function createBuiltinTools(): NormalizedTool[] {
  return builtinToolGroups.flatMap(group => annotateTools(group.factory(), {
    source: "builtin",
    category: group.id,
    categoryLabel: group.label,
    risk: group.risk,
    tags: group.tags,
    policy: group.policy,
  }))
}
