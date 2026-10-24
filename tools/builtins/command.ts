import { commandObserver } from "../../knowledge/command-observer.js"
import { configStore } from "../../config/store.js"
import { knowledgeStore, BUILTIN_COMMANDS_ID } from "../../knowledge/store.js"
import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"
import { buildKnowledgePrompt } from "../../knowledge/retrieval.js"
import { truncateTextToTokens } from "../../core/chat/token-budget.js"
import { COMMAND_COMPLETENESS_ISSUE_LABELS } from "../../knowledge/command-query-service.js"

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

  async execute(args: ToolArgs = {}, context: CommandToolContext = {}): Promise<string> {
    if (!(await knowledgeStore.list(context.e || {})).some(base => base.id === BUILTIN_COMMANDS_ID)) return "没有访问内置指令库的权限。"
    const recommendation = await commandObserver.recommendCommandsHybrid(args.query || "", { limit: args.limit, event: context.e })
    const results = records(recommendation.results)
    if (!results.length) return "没有找到匹配的指令。可以换一种说法，或先发送 #yuihelp 查看已索引能力。"
    const base = record(recommendation.knowledgeBase)
    return buildKnowledgePrompt(results.map(item => ({
      knowledgeBaseId: BUILTIN_COMMANDS_ID, knowledgeBaseName: base.name,
      fieldDescription: base.fieldDescription, title: item.suggestedCommand || item.example || item.fnc,
      content: `${text(item.retrievalText || item.description || item.summary)}\n推荐理由：${text(item.reason) || "匹配指令知识库"}`,
    })), Number(record(record(record(configStore.get()).knowledge).retrieval).resultTokenBudget) || 800)
  }
}

/** 指令推荐工具：输出结构化推荐，供模型规划下一步而非直接投递。 */
export class CommandRecommendTool {
  name = "command_recommend"
  source = "builtin"
  description = "Return command candidates ranked by relevance; implementations of the same recommended command use host priority (smaller first)."
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "User intent or command question." },
      limit: { type: "number", description: "Maximum result count." },
      includeAudit: { type: "boolean", description: "Whether to include knowledge quality hints." },
    },
    required: ["query"],
  }

  async execute(args: ToolArgs = {}, context: CommandToolContext = {}): Promise<string> {
    if (!(await knowledgeStore.list(context.e || {})).some(base => base.id === BUILTIN_COMMANDS_ID)) return "没有访问内置指令库的权限。"
    const recommendation = await commandObserver.recommendCommandsHybrid(args.query || "", { limit: args.limit, event: context.e })
    const result: UnknownRecord = {
      query: recommendation.query,
      generatedAt: recommendation.generatedAt,
      count: recommendation.count,
      summary: recommendation.summary,
      knowledgeBase: recommendation.knowledgeBase,
      ordering: record(recommendation.retrieval).commandOrdering || "relevance-with-command-priority",
      recommendations: records(recommendation.results).map(item => ({
        id: item.id,
        pluginName: item.pluginName,
        retrievalText: truncateTextToTokens(item.retrievalText, 600),
        description: text(item.description || item.summary),
        command: text(record(item.recommendation).command || item.suggestedCommand || item.example),
        examples: strings(item.examples),
        reason: text(record(item.recommendation).reason || item.reason),
        confidence: text(record(item.recommendation).confidence) || "unknown",
        score: item.score || 0,
        priority: item.priority ?? null,
        priorityLabel: item.priorityLabel || "未知",
        pluginOrder: item.pluginOrder,
        ruleOrder: item.ruleOrder,
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
  risk = "high"
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
    if (!(await knowledgeStore.list(context.e || {})).some(base => base.id === BUILTIN_COMMANDS_ID)) return "没有访问内置指令库的权限。"
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

/** 指令知识审计工具：检查检索正文的资料完整度，不修改知识库。 */
export class CommandKnowledgeAuditTool {
  name = "command_knowledge_audit"
  source = "builtin"
  description = "Check completeness of command retrieval text: instructions, purpose, parameters, concrete examples, and items requiring verification. This is not an accuracy or execution-success score."
  parameters = {
    type: "object",
    properties: {
      limit: { type: "number", description: "Maximum weak command count." },
    },
  }

  async execute(args: ToolArgs = {}, context: CommandToolContext = {}): Promise<string> {
    if (!(await knowledgeStore.list(context.e || {})).some(base => base.id === BUILTIN_COMMANDS_ID)) return "没有访问内置指令库的权限。"
    const report = record(commandObserver.qualityReport({ limit: Number(args.limit) || 10 }))
    const summary = record(report.summary)
    const issueSummary = Object.entries(record(summary.issues))
      .map(([name, count]) => `${COMMAND_COMPLETENESS_ISSUE_LABELS[name] || (name === "ok" ? "未发现缺项" : name)}:${count}`)
      .join(" / ")
    const rows = records(report.weakCommands).slice(0, Number(args.limit) || 10).map((item, index) =>
      `${index + 1}. ${text(item.pluginName || item.pluginKey)}：${text(item.description || item.fnc) || "无描述"}\n`
      + `   资料完整度：${item.qualityScore}%  问题：${strings(item.issues).map(issue => COMMAND_COMPLETENESS_ISSUE_LABELS[issue] || issue).join("；")}\n`
      + `   建议指令：${text(item.suggestedCommand || item.example) || "缺失"}  触发头：${strings(item.commandHeads).join(" / ") || "缺失"}`,
    )
    return [
      `指令资料完整度：${summary.okCommands}/${summary.commands} 条正文未发现缺项，平均 ${summary.averageQualityScore}%。仅为资料格式检查，不代表召回准确率或执行成功。`,
      `问题分布：${issueSummary || "无"}`,
      ...(strings(report.recommendations).length ? ["建议：", ...strings(report.recommendations).map(item => `- ${item}`)] : []),
      ...(rows.length ? ["薄弱指令：", ...rows] : []),
    ].join("\n")
  }
}

// 知识查询、宿主指令投递和知识审计分别授权。
/** 知识管理聚合工具：先校验授权知识库，再分派搜索或推荐。 */
export class KnowledgeManageTool {
  name = "knowledge_manage"
  deferLoading = false
  source = "builtin"
  execution = { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe", maxAttempts: 2 }
  description = "Query only knowledge bases authorized for the current user. Use search for documents, and recommend only for one authorized command knowledge base."
  parameters = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "search", "recommend"], description: "Operation to perform." },
      knowledgeBaseIds: { type: "array", items: { type: "string" }, description: "Optional authorized knowledge base IDs. Unauthorized IDs reject the request." },
      query: { type: "string", description: "User intent or command question, required by search and recommend." },
      limit: { type: "number", description: "Maximum result count." },
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
    const commandAction = action === "recommend"
    if (commandAction) {
      const bases = await knowledgeStore.list(event)
      const wanted = bases.filter(base => commandIds.includes(text(base.id)))
      if (wanted.length !== 1 || wanted[0].type !== "command") return "recommend 仅支持一个已授权的 command 类型知识库。"
    }
    switch (action) {
      case "search": {
        const bases = await knowledgeStore.list(event)
        const allowed = new Map(bases.map(base => [base.id, base]))
        const selectedIds = ids.length ? ids : bases.map(base => base.id)
        const forbidden = selectedIds.filter(baseId => !allowed.has(baseId))
        if (forbidden.length) return `没有访问知识库的权限：${forbidden.join(", ")}`
        const results = await knowledgeStore.search(event, args.query || "", { knowledgeBaseIds: selectedIds, limit: args.limit, useVector: true })
        return results.length ? buildKnowledgePrompt(results, Number(record(record(record(configStore.get()).knowledge).retrieval).resultTokenBudget) || 800) : "没有找到匹配的已授权知识。"
      }
      case "recommend": return new CommandRecommendTool().execute({ ...args, includeAudit: false }, context)
      default: return "未知 action，可用：list / search / recommend。"
    }
  }
}

export function createCommandTools(): unknown[] {
  return [new KnowledgeManageTool(), new CommandHandoffTool(), new CommandKnowledgeAuditTool()]
}
