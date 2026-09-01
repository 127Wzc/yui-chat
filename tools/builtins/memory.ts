import { memoryStore, profileLines } from "../../memory/store.js"
import { isExplicitMemoryIntent } from "../../memory/write-policy.js"
import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

interface MemoryToolContext extends ToolExecutionContext {
  e?: unknown
  prompt?: unknown
}

type ToolArgs = UnknownRecord

/** 记忆检索工具：只负责把查询交给记忆门面，不改变召回排序和向量策略。 */
export class MemorySearchTool {
  name = "memory_search"
  source = "builtin"
  description = "Search long-term memory and recent remembered episodes for the current user or chat scope."
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search in memory." },
      limit: { type: "number", description: "Maximum result count." },
    },
    required: ["query"],
  }

  async execute(args: ToolArgs = {}, context: MemoryToolContext = {}): Promise<string> {
    const results = await memoryStore.search(context.e, args.query || "", args.limit || 5)
    if (!results.length) return "没有找到相关记忆。"
    return results.map((item, index) => {
      const idLine = item.type === "memory" && item.id ? `\n   id: ${item.id}` : ""
      return `${index + 1}. [${item.type}] ${item.text}${idLine}`
    }).join("\n")
  }
}

/** 长期记忆列表工具：展示当前用户或会话范围内已保存的事实。 */
export class MemoryListTool {
  name = "memory_list"
  source = "builtin"
  description = "List remembered facts for the current user and chat scope. Use when the user asks what you remember about them."
  parameters = {
    type: "object",
    properties: {
      limit: { type: "number", description: "Maximum result count." },
      includeCold: { type: "boolean", description: "Whether to include low-priority cold memories. Defaults to false." },
    },
  }

  async execute(args: ToolArgs = {}, context: MemoryToolContext = {}): Promise<string> {
    const results = await memoryStore.listMemories(context.e, {
      limit: args.limit || 12,
      includeCold: args.includeCold === true,
    })
    if (!results.length) return "当前没有可展示的长期记忆。"
    return results.map((item, index) => `${index + 1}. [${item.status || "active"}] ${item.text}\n   id: ${item.id}`).join("\n")
  }
}

/** 记忆写入工具：只写入用户明确确认的稳定事实。 */
export class MemoryWriteTool {
  name = "memory_write"
  source = "builtin"
  description = "Write one concise, stable long-term memory fact for the current user. Do not save one-off chat, guesses, or tool commands."
  parameters = {
    type: "object",
    properties: {
      fact: { type: "string", description: "A short stable fact to remember." },
    },
    required: ["fact"],
  }

  async execute(args: ToolArgs = {}, context: MemoryToolContext = {}): Promise<string> {
    const fact = text(args.fact).trim()
    if (!fact) return "没有可写入的记忆。"
    await memoryStore.addFact(context.e, fact.slice(0, 160), { source: "explicit-user" })
    return `已写入记忆：${fact.slice(0, 160)}`
  }
}

/** 记忆删除工具：按记忆 ID 删除，不负责推断或批量清理。 */
export class MemoryForgetTool {
  name = "memory_forget"
  source = "builtin"
  description = "Forget one memory by id for the current user or chat scope. Use only when the user asks to delete a remembered fact."
  parameters = {
    type: "object",
    properties: {
      id: { type: "string", description: "Memory id returned by memory_list or memory_search." },
    },
    required: ["id"],
  }

  async execute(args: ToolArgs = {}, context: MemoryToolContext = {}): Promise<string> {
    const result = await memoryStore.forgetMemory(context.e, args.id)
    if (!result.ok) return `没有找到可删除的记忆：${text(args.id)}`
    return `已删除记忆：${result.text}`
  }
}

/** 用户画像读取工具：组合结构化画像和少量稳定事实供模型使用。 */
export class UserProfileReadTool {
  name = "user_profile_read"
  source = "builtin"
  description = "Read the structured user profile and stable memory facts for the current user. Use this to personalize first-person replies."
  parameters = {
    type: "object",
    properties: {
      includeFacts: { type: "boolean", description: "Whether to include recent stable facts. Defaults to true." },
    },
  }

  async execute(args: ToolArgs = {}, context: MemoryToolContext = {}): Promise<string> {
    const result = await memoryStore.getProfile(context.e)
    const lines = profileLines(result.profile)
    const facts = args.includeFacts === false ? [] : (result.facts || []).slice(0, 8).map(item => item.text)
    if (!lines.length && !facts.length) return "当前用户还没有画像或长期记忆。"
    return [
      `用户 ${result.userId} 画像：`,
      ...(lines.length ? lines.map(item => `- ${item}`) : ["- 暂无结构化画像"]),
      facts.length ? "长期事实：" : "",
      ...facts.map(item => `- ${item}`),
      result.updatedAt ? `更新时间：${result.updatedAt}` : "",
    ].filter(Boolean).join("\n")
  }
}

/** 用户画像写入工具：更新确认过的稳定偏好，不承担自然语言事实抽取。 */
export class UserProfileWriteTool {
  name = "user_profile_write"
  source = "builtin"
  description = "Update structured user profile fields for the current user, such as name, interests, preferences, dislikes, communication style, or notes. Only save stable, confirmed information."
  parameters = {
    type: "object",
    properties: {
      name: { type: "string", description: "Preferred name or nickname." },
      pronouns: { type: "string", description: "Preferred pronouns or address style." },
      interests: { type: "array", items: { type: "string" }, description: "Stable interests." },
      preferences: { type: "array", items: { type: "string" }, description: "Stable preferences or habits." },
      dislikes: { type: "array", items: { type: "string" }, description: "Stable dislikes." },
      communicationStyle: { type: "string", description: "Preferred communication style." },
      notes: { type: "string", description: "Other concise long-term profile notes." },
    },
  }

  async execute(args: ToolArgs = {}, context: MemoryToolContext = {}): Promise<string> {
    const patch: UnknownRecord = {
      name: args.name,
      pronouns: args.pronouns,
      interests: args.interests,
      preferences: args.preferences,
      dislikes: args.dislikes,
      communicationStyle: args.communicationStyle,
      notes: args.notes,
    }
    if (!Object.values(patch).some(value => Array.isArray(value) ? value.length : String(value || "").trim())) {
      return "没有可写入的用户画像字段。"
    }
    const result = await memoryStore.updateProfile(context.e, patch)
    const lines = profileLines(result.profile)
    return [`已更新用户 ${result.userId} 的画像：`, ...lines.map(item => `- ${item}`)].join("\n")
  }
}

// 记忆读写共用同一数据边界，用 action 合并模型可见定义，避免将同一份 CRUD 语义重复注入上下文。
/** 记忆聚合工具：用 action 合并 CRUD 语义，避免重复注入多份工具定义。 */
export class MemoryManageTool {
  name = "memory_manage"
  source = "builtin"
  execution = { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe", maxAttempts: 2 }
  executionByAction = {
    write: { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["fact"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
    forget: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["id"], operationFields: ["id"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
    profile_write: { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["profile", "name", "pronouns", "interests", "preferences", "dislikes", "communicationStyle", "notes"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
  }
  description = "Manage long-term memory and the current user's profile. Actions: search, list, write, forget, profile_read, profile_write. Only write stable, confirmed information; use forget only when the user asks to delete it."
  parameters = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search", "list", "write", "forget", "profile_read", "profile_write"], description: "Memory or profile operation." },
      query: { type: "string", description: "Memory search query." },
      fact: { type: "string", description: "Concise stable fact to remember." },
      id: { type: "string", description: "Memory id to forget." },
      limit: { type: "number", description: "Maximum result count." },
      includeCold: { type: "boolean", description: "Include low-priority memories when listing." },
      includeFacts: { type: "boolean", description: "Include stable facts with profile_read." },
      profile: { type: "object", description: "Fields to update with profile_write: name, pronouns, interests, preferences, dislikes, communicationStyle, notes." },
    },
    required: ["action"],
  }

  async execute(args: ToolArgs = {}, context: MemoryToolContext = {}): Promise<string> {
    const profileArgs = args.profile && typeof args.profile === "object" ? { ...args, ...args.profile as UnknownRecord } : args
    if (["write", "profile_write"].includes(text(args.action)) && !isExplicitMemoryIntent(text(context.prompt))) {
      return "没有检测到用户明确的“记住/记下”意图，未写入长期记忆。"
    }
    switch (args.action) {
      case "search": return new MemorySearchTool().execute(args, context)
      case "list": return new MemoryListTool().execute(args, context)
      case "write": return new MemoryWriteTool().execute(args, context)
      case "forget": return new MemoryForgetTool().execute(args, context)
      case "profile_read": return new UserProfileReadTool().execute(args, context)
      case "profile_write": return new UserProfileWriteTool().execute(profileArgs, context)
      default: return "未知 action，可用：search / list / write / forget / profile_read / profile_write。"
    }
  }
}

export function createMemoryTools(): unknown[] {
  return [new MemoryManageTool()]
}
