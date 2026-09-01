import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"

// 子代理工具：让主 AI 在对话中派生独立子代理去完成明确的子任务（agentic 子任务外包）。
// 支持单个 task，也支持 tasks 数组一次并行派发多个子代理；通过递归深度 + 工具白名单防止失控。
const absoluteMaxTasksPerDispatch = 8
const maxTaskChars = 4000
const maxContextChars = 8000

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function errorMessage(error: unknown): string {
  const source = record(error)
  return text(source.message || error || "执行失败")
}

interface SubagentToolContext extends ToolExecutionContext {
  config?: UnknownRecord
  e?: unknown
}

/** 子代理派发工具；参数校验和并发上限在本工具内完成，执行生命周期由 ChatService 负责。 */
export class DispatchSubagentTool {
  name = "dispatch_subagent"
  source = "builtin"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["task", "tasks", "context"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  description = "派生独立子代理完成明确的子任务（检索资料、整理信息、分步分析等）。可用 task 交付单个子任务，或用 tasks 一次并行派发多个独立子任务；子代理会自主使用工具收集信息后返回结论。适合把复杂工作拆解外包。"
  parameters = {
    type: "object",
    properties: {
      task: { type: "string", maxLength: maxTaskChars, description: "单个子任务描述（写清目标与期望产出）。" },
      tasks: { type: "array", maxItems: absoluteMaxTasksPerDispatch, items: { type: "string", maxLength: maxTaskChars }, description: "（可选）一次并行派发多个独立子任务，每项交给一个子代理；与 task 二选一。" },
      context: { type: "string", maxLength: maxContextChars, description: "（可选）完成子任务所需的背景或约束，会附加到每个子任务。" },
    },
  }

  async execute(args: UnknownRecord = {}, context: SubagentToolContext = {}): Promise<string> {
    const config = record(context.config)
    const sub = record(config.subAgent)
    if (sub.enabled !== true) return "子代理功能未启用：请在「对话流程 · 子代理」中开启后再使用。"
    const depth = number(context.agent?.depth)
    const maxDepth = Math.max(1, number(sub.maxDepth, 1))
    if (depth >= maxDepth) {
      return `已达子代理最大递归深度（${maxDepth}），本层不再派生子代理，请直接处理或汇总现有信息。`
    }
    const rawTasks = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : (args.task ? [args.task] : [])
    const tasks = rawTasks.map(item => text(item).trim()).filter(Boolean)
    if (!tasks.length) return "请提供要交给子代理的子任务（task 或 tasks）。"
    const maxTasks = Math.max(1, Math.min(number(sub.maxTasksPerDispatch, 3), absoluteMaxTasksPerDispatch))
    if (tasks.length > maxTasks) return `单次最多派发 ${maxTasks} 个子任务，请拆分后再执行。`
    if (tasks.some(task => task.length > maxTaskChars)) return `单个子任务不能超过 ${maxTaskChars} 个字符。`
    const bg = text(args.context).trim()
    if (bg.length > maxContextChars) return `子代理背景不能超过 ${maxContextChars} 个字符。`
    const brief = (task: string): string => (bg ? `${task}\n\n背景：${bg}` : task)
    try {
      const { chatService } = await import("../../core/chat/chat-service.js")
      if (tasks.length === 1) {
        const result = await chatService.runSubAgent({ task: brief(tasks[0]), e: context.e, config, depth, trace: context.observability?.trace || null, parentToolId: context.observability?.toolCallId || "" })
        const resultText = text(result?.text).trim()
        if (!resultText) return "子代理没有产出有效结论。"
        const used = result?.toolRounds ? `（子代理用了 ${result.toolRounds} 轮工具）` : ""
        return `子代理结论${used}：\n${resultText}`
      }
      // 并行多子任务：按 maxConcurrency 分批，互不阻塞
      const concurrency = Math.max(1, number(sub.maxConcurrency, 3))
      const results: UnknownRecord[] = []
      for (let i = 0; i < tasks.length; i += concurrency) {
        const batch = tasks.slice(i, i + concurrency)
        const batchResults = await Promise.all(batch.map(task =>
          chatService.runSubAgent({ task: brief(task), e: context.e, config, depth, trace: context.observability?.trace || null, parentToolId: context.observability?.toolCallId || "" })
            .catch(error => ({ text: `执行失败：${errorMessage(error)}` })),
        ))
        results.push(...batchResults)
      }
      return results.map((result, index) => {
        const resultText = text(result?.text || "无结论").trim()
        const used = result?.toolRounds ? `（${result.toolRounds} 轮工具）` : ""
        return `【子代理 ${index + 1}】${tasks[index]}${used}\n${resultText}`
      }).join("\n\n")
    } catch (error) {
      return `子代理执行失败：${errorMessage(error)}`
    }
  }
}

export function createAgentTools(): unknown[] {
  return [new DispatchSubagentTool()]
}
