import { commandObserver } from "../../knowledge/command-observer.js"
import { configStore } from "../../config/store.js"
import { knowledgeStore, BUILTIN_COMMANDS_ID } from "../../knowledge/store.js"
import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"

interface CommandToolContext extends ToolExecutionContext {
  e?: UnknownRecord
  config?: UnknownRecord
  delivery?: UnknownRecord
}

type ToolArgs = UnknownRecord

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => Boolean(item) && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item ?? "").trim()).filter(Boolean) : []
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

/** 指令搜索工具：查询观察/人工整理的指令知识，不直接执行外部指令。 */
export class CommandSearchTool {
  name = "command_search"
  source = "builtin"
  description = "Search Yunzai plugin commands and recommend suitable instructions to the user."
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "User intent or command question." },
      limit: { type: "number", description: "Maximum result count." },
    },
    required: ["query"],
  }

  async execute(args: ToolArgs = {}, _context: CommandToolContext = {}): Promise<string> {
    const recommendation = await commandObserver.recommendCommandsHybrid(args.query || "", { limit: args.limit || 5 })
    const results = records(recommendation.results)
    if (!results.length) return "没有找到匹配的指令。可以换一种说法，或先发送 #yuihelp 查看已索引能力。"
    return results.map((item, index) => {
      const guide = record(item.usageGuide)
      const commandHint = item.regexp ? `/${text(item.regexp)}/` : text(item.fnc)
      const heads = strings(item.commandHeads || guide.heads).slice(0, 6).join(" / ") || "未知"
      const intents = strings(item.intentHints || guide.intents).slice(0, 6).join(" / ") || "未知"
      const parameters = records(item.parameterHints || guide.parameters)
        .slice(0, 6)
        .map(hint => `${text(hint.name)}${hint.description ? `：${text(hint.description)}` : ""}`)
        .join("；") || "无明显参数"
      const recommendationGuide = record(item.recommendation)
      const examples = strings(item.examples || [item.example])
      const matchedTokens = strings(item.matchedTokens)
      const matched = matchedTokens.length ? matchedTokens : strings(item.keywords)
      return `${index + 1}. ${text(item.pluginName)}：${text(item.description || item.summary) || "无描述"}\n   建议指令：${text(item.suggestedCommand || item.example) || "未知"}\n   推荐理由：${text(item.reason) || "匹配指令知识库"}\n   指令匹配：${commandHint}\n   示例形态：${examples.slice(0, 4).join(" / ") || "未知"}\n   权限：${text(item.permission)}  事件：${text(item.event)}  使用次数：${item.usageCount || 0}  匹配分：${item.score || 0}\n   关键词：${matched.slice(0, 8).join(", ")}`
        + `\n   触发头：${heads}\n   意图：${intents}\n   参数：${parameters}`
        + `\n   推荐置信度：${text(recommendationGuide.confidence) || "unknown"}`
        + `\n   下一步：${strings(recommendationGuide.nextSteps).join("；") || "直接尝试建议指令"}`
    }).join("\n")
  }
}

/** 指令推荐工具：输出结构化推荐，供模型规划下一步而非直接投递。 */
export class CommandRecommendTool {
  name = "command_recommend"
  source = "builtin"
  description = "Return structured command recommendations from the command knowledge base for AI planning."
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "User intent or command question." },
      limit: { type: "number", description: "Maximum result count." },
      includeAudit: { type: "boolean", description: "Whether to include knowledge quality hints." },
    },
    required: ["query"],
  }

  async execute(args: ToolArgs = {}, _context: CommandToolContext = {}): Promise<string> {
    const limit = Math.max(1, Math.min(10, Number(args.limit) || 5))
    const recommendation = await commandObserver.recommendCommandsHybrid(args.query || "", { limit })
    const result: UnknownRecord = {
      query: recommendation.query,
      generatedAt: recommendation.generatedAt,
      count: recommendation.count,
      summary: recommendation.summary,
      recommendations: records(recommendation.results).map(item => ({
        id: item.id,
        pluginName: item.pluginName,
        description: text(item.description || item.summary),
        command: text(record(item.recommendation).command || item.suggestedCommand || item.example),
        examples: strings(item.examples),
        reason: text(record(item.recommendation).reason || item.reason),
        confidence: text(record(item.recommendation).confidence) || "unknown",
        score: item.score || 0,
        matchedSignals: strings(record(item.recommendation).matchedSignals),
        parameterHints: records(record(item.recommendation).parameterHints),
        nextSteps: strings(record(item.recommendation).nextSteps),
        permission: item.permission,
        event: item.event,
        usageCount: item.usageCount || 0,
        dynamic: Boolean(item.dynamic),
        manual: Boolean(item.manual),
      })),
    }
    if (args.includeAudit) {
      const quality = record(commandObserver.qualityReport({ limit: 5 }))
      result.audit = {
        summary: quality.summary,
        recommendations: strings(quality.recommendations),
        weakCommands: records(quality.weakCommands).slice(0, 5).map(item => ({
          id: item.id,
          pluginName: item.pluginName,
          command: text(item.suggestedCommand || item.example),
          issues: strings(item.issues),
          qualityScore: item.qualityScore,
        })),
      }
    }
    return JSON.stringify(result, null, 2)
  }
}

/** 指令转交工具：只在允许当前会话发送时投递已确认的宿主指令。 */
export class CommandHandoffTool {
  name = "command_handoff"
  source = "builtin"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["command", "reason", "send"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  description = "Send or suggest a Yunzai command discovered from the command knowledge base. Use when another plugin command should handle the task."
  parameters = {
    type: "object",
    properties: {
      command: { type: "string", description: "Command text to send, for example #体力" },
      reason: { type: "string", description: "Why this command is recommended." },
      send: { type: "boolean", description: "Whether to send the command immediately." },
    },
    required: ["command"],
  }

  async execute(args: ToolArgs = {}, context: CommandToolContext = {}): Promise<string> {
    const config = record(configStore.get())
    const tools = record(config.tools)
    const builtin = record(tools.builtin)
    const handoff = record(builtin.commandHandoff)
    const response = record(config.response)
    const command = text(args.command).trim()
    if (!command) return "缺少要转交的指令。"
    const shouldSend = args.send ?? handoff.allowSend
    if (shouldSend && context.delivery?.allowCurrentChat !== false && context.e) {
      const reply = context.e.reply
      if (typeof reply !== "function") return `建议使用指令：${command}`
      await reply.call(context.e, command, response.quoteReply === true)
      return `已转交执行指令：${command}`
    }
    const note = shouldSend && context.delivery?.allowCurrentChat === false
      ? "（当前对话会在最终回复中给出建议，不直接发送指令。）"
      : ""
    return `建议使用指令：${command}${args.reason ? `\n原因：${args.reason}` : ""}${note}`
  }
}

/** 指令知识审计工具：报告扫描知识的完整度，不修改知识库。 */
export class CommandKnowledgeAuditTool {
  source = "builtin"
  description = "Audit command knowledge quality and report missing examples, trigger heads, parameter hints, and dynamically observed commands."
  parameters = {
    type: "object",
    properties: {
      limit: { type: "number", description: "Maximum weak command count." },
    },
  }

  async execute(args: ToolArgs = {}, _context: CommandToolContext = {}): Promise<string> {
    const report = record(commandObserver.qualityReport({ limit: Number(args.limit) || 10 }))
    const summary = record(report.summary)
    const issueSummary = Object.entries(record(summary.issues))
      .map(([name, count]) => `${name}:${count}`)
      .join(" / ")
    const rows = records(report.weakCommands).slice(0, Number(args.limit) || 10).map((item, index) =>
      `${index + 1}. ${text(item.pluginName || item.pluginKey)}：${text(item.description || item.fnc) || "无描述"}\n`
      + `   质量分：${item.qualityScore}  问题：${strings(item.issues).join(", ")}\n`
      + `   建议指令：${text(item.suggestedCommand || item.example) || "缺失"}  触发头：${strings(item.commandHeads).join(" / ") || "缺失"}`,
    )
    return [
      `指令知识库质量：${summary.okCommands}/${summary.commands} 条无明显问题，平均 ${summary.averageQualityScore} 分。`,
      `问题分布：${issueSummary || "无"}`,
      ...(strings(report.recommendations).length ? ["建议：", ...strings(report.recommendations).map(item => `- ${item}`)] : []),
      ...(rows.length ? ["薄弱指令：", ...rows] : []),
    ].join("\n")
  }
}

// 模型侧只保留一个入口；内部仍复用原有实现，避免改变已有的指令知识库行为。
/** 知识管理聚合工具：先校验授权知识库，再分派搜索、推荐、转交或审计。 */
export class KnowledgeManageTool {
  name = "knowledge_manage"
  deferLoading = false
  source = "builtin"
  execution = { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe", maxAttempts: 2 }
  executionByAction = {
    handoff: { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["knowledgeBaseIds", "command", "reason", "send"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
  }
  description = "Query only knowledge bases authorized for the current user. Use search for documents, and recommend/handoff/audit only for one authorized command knowledge base."
  parameters = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "search", "recommend", "handoff", "audit"], description: "Operation to perform." },
      knowledgeBaseIds: { type: "array", items: { type: "string" }, description: "Optional authorized knowledge base IDs. Unauthorized IDs reject the request." },
      query: { type: "string", description: "User intent or command question, required by search and recommend." },
      command: { type: "string", description: "Command text for handoff." },
      reason: { type: "string", description: "Reason for a handoff suggestion." },
      send: { type: "boolean", description: "Whether handoff should send the command immediately." },
      limit: { type: "number", description: "Maximum result count." },
      includeAudit: { type: "boolean", description: "Include quality hints with recommend results." },
    },
    required: ["action"],
  }

  async execute(args: ToolArgs = {}, context: CommandToolContext = {}): Promise<string> {
    const event = context.e || {}
    const ids = strings(args.knowledgeBaseIds)
    const action = text(args.action)
    if (action === "list") {
      const bases = await knowledgeStore.list(event)
      return JSON.stringify(bases.map(base => ({ id: base.id, name: base.name, type: base.type, description: base.description, autoRetrieve: Boolean(base.auto_retrieve) })), null, 2)
    }
    const commandIds = ids.length ? ids : [BUILTIN_COMMANDS_ID]
    const commandAction = ["recommend", "handoff", "audit"].includes(action)
    if (commandAction) {
      const bases = await knowledgeStore.list(event)
      const wanted = bases.filter(base => commandIds.includes(text(base.id)))
      if (wanted.length !== 1 || wanted[0].type !== "command") return "recommend / handoff / audit 仅支持一个已授权的 command 类型知识库。"
    }
    switch (action) {
      case "search": {
        const bases = await knowledgeStore.list(event)
        const allowed = new Map(bases.map(base => [base.id, base]))
        const selectedIds = ids.length ? ids : bases.map(base => base.id)
        const forbidden = selectedIds.filter(baseId => !allowed.has(baseId))
        if (forbidden.length) return `没有访问知识库的权限：${forbidden.join(", ")}`
        const ordinaryIds = selectedIds.filter(baseId => baseId !== BUILTIN_COMMANDS_ID)
        const sections = []
        if (ordinaryIds.length) {
          const results = await knowledgeStore.search(event, args.query || "", { knowledgeBaseIds: ordinaryIds, limit: args.limit || 4, useVector: true })
          if (results.length) sections.push(results.map((item, index) => `${index + 1}. ${item.knowledgeBaseName} / ${item.title}\n${item.content}`).join("\n\n"))
        }
        // 内置指令库继续复用成熟的扫描、权限过滤和推荐说明查询。
        if (selectedIds.includes(BUILTIN_COMMANDS_ID)) sections.push(await new CommandSearchTool().execute(args, context))
        return sections.filter(Boolean).join("\n\n") || "没有找到匹配的已授权知识。"
      }
      case "recommend": return new CommandRecommendTool().execute(args, context)
      case "handoff": return new CommandHandoffTool().execute(args, context)
      case "audit": return new CommandKnowledgeAuditTool().execute(args, context)
      default: return "未知 action，可用：list / search / recommend / handoff / audit。"
    }
  }
}

export function createCommandTools(): unknown[] {
  return [new KnowledgeManageTool()]
}
