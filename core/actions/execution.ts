import { configStore } from "../../config/store.js"
import type { RuntimeConfigObject } from "../../config/types.js"
import { actionRecord, parseActions, type ActionDefinition, type ActionRecord } from "./contract.js"
import { cloneJsonValue } from "../shared/json-values.js"
import { boundaryRoles, resolveBoundaryRole, roleAtLeast } from "../../tools/access/roles.js"
import { previewToolEvent } from "../../tools/access/matrix.js"
import { explainToolPolicy } from "../../tools/access/policy.js"
import { ToolRegistry, toolRegistry } from "../../tools/support/registry.js"
import { validateToolArguments } from "../../tools/support/contract.js"
import { executeDirectTool } from "../../tools/support/direct-execution.js"
import { normalizeToolResult, type ToolExecutionResult } from "../../tools/support/execution-runtime.js"
import { parseTestArguments } from "../../extensions/testing/execution-runtime.js"
import { resolveMediaContext } from "../message/media-context.js"
import { preflight, releasePreflight } from "../chat/response-pipeline.js"
import { isGroupEvent } from "../message/event-scope.js"
import { actionSourceTool } from "./source-tool.js"
import { formatActionReply } from "./reply.js"
import { checkAccess } from "../chat/access-control.js"

export function resolveActionTool(action: ActionDefinition) { return action.kind === "source" ? actionSourceTool(action) : toolRegistry.get(action.tool) }

export function defaultActionRole(tool: unknown, config = configStore.get()) {
  const enabledConfig = { ...config, tools: { ...actionRecord(config.tools), enabled: true } }
  return boundaryRoles.find(role => explainToolPolicy(tool, { e: previewToolEvent(role), config: enabledConfig, allowDisabledTool: true }).allowed) || "master"
}

export function actionAccess(action: ActionDefinition, e: ActionRecord, config: RuntimeConfigObject): { allowed: boolean; reason: string } {
  if (!action.enabled || actionRecord(config.actions).enabled === false) return { allowed: false, reason: "动作已停用" }
  if ((action.scope === "group" && !isGroupEvent(e)) || (action.scope === "private" && isGroupEvent(e))) return { allowed: false, reason: "动作不适用于当前会话" }
  if (!roleAtLeast(resolveBoundaryRole(e), action.minRole)) return { allowed: false, reason: "当前角色没有此动作的使用权限" }
  const tool = resolveActionTool(action)
  if (!tool) return { allowed: false, reason: "关联工具不存在，请检查扩展是否已加载" }
  return explainToolPolicy(tool, { e, config, actionId: action.id })
}

export function bindActionArguments(action: ActionDefinition, text: string, e: ActionRecord, images?: string[]): ActionRecord {
  if (text.length > 8000) throw new Error("动作输入最多 8,000 个字符")
  const args = cloneJsonValue(action.defaults)
  if (action.input.mode === "parameters" && text) {
    const supplied = parseTestArguments(text)
    for (const [key, value] of Object.entries(supplied)) {
      if (!action.overridable.includes(key)) throw new Error(`参数 ${key} 不允许覆盖`)
      args[key] = value
    }
  }
  if (action.textParam && (action.input.mode === "text" || action.textTemplate)) {
    const variables: Record<string, string> = { text: action.input.mode === "text" ? text : "", userId: String(e.user_id || ""), groupId: String(e.group_id || ""), userName: String(actionRecord(e.sender).card || actionRecord(e.sender).nickname || e.user_id || "") }
    args[action.textParam] = action.textTemplate
      ? action.textTemplate.replace(/\{\{\s*(text|userName|userId|groupId)\s*\}\}/g, (_match, key: string) => variables[key]).trim()
      : text || args[action.textParam] || ""
  }
  if (action.textParam && action.textTemplate && action.input.mode === "text" && text && !/\{\{\s*text\s*\}\}/.test(action.textTemplate)) args[action.textParam] += `\n${text}`
  if (action.input.images !== "none" && images !== undefined) args[action.input.imageParam] = images
  return args
}

async function actionImages(action: ActionDefinition, e: ActionRecord, config: RuntimeConfigObject): Promise<string[]> {
  if (action.input.images === "none") return []
  // 固定媒体选择语义，不让附加提示词中的“头像”等字样扩大输入来源。
  const media = await resolveMediaContext(e, "参考图片", config, { quoteAsCurrent: true })
  const quoted = media.attachments.filter(item => item.kind === "image" && item.source === "quote")
  const quoteUrls = new Set((media.quote?.attachments || []).filter(item => item.kind === "image").map(item => String(item.url || "")))
  const current = media.attachments.filter(item => item.kind === "image" && item.source !== "quote" && !String(item.source).includes("avatar") && !quoteUrls.has(String(item.url || "")) && !(item.source === "yunzai-img" && media.quote?.status === "unavailable"))
  const chosen = action.input.images === "quote" ? quoted : action.input.images === "current" ? current : current.length ? current : quoted
  const images = [...new Set(chosen.map(item => String(item.url || "")).filter(Boolean))].slice(0, 3)
  if (action.input.requireImage && !images.length) throw new Error("请发送一张图片，或引用图片后再使用这个动作。")
  return images
}

export function validateActionArguments(action: ActionDefinition, args: ActionRecord): void {
  const tool = resolveActionTool(action)
  if (!tool) throw new Error("关联工具不存在")
  const result = validateToolArguments(tool, args)
  if (!result.ok) throw new Error(`参数校验失败：${result.issues.join("；")}`)
}

async function actionOutput(action: ActionDefinition, result: Pick<ToolExecutionResult, "value" | "content" | "metadata" | "status">, e: ActionRecord, web = false, alreadyReplied = false) {
  let preview
  try { preview = formatActionReply(result, action.reply, alreadyReplied) }
  catch (error) { return { message: `动作已执行，但回复设置需要调整：${error instanceof Error ? error.message : String(error)}`, parts: [], note: "结果转换失败", delivery: null } }
  let delivery: unknown = null
  if (!web && preview.parts.length && !preview.parts.every(part => actionRecord(part).type === "text")) {
    delivery = await executeDirectTool("message_send", { parts: preview.parts }, { e, config: configStore.get(), source: "action-delivery", actionId: action.id, actionDelivery: true })
  }
  return { ...preview, delivery }
}

export async function runAction(action: ActionDefinition, text: string, e: ActionRecord, options: { web?: boolean; images?: string[] } = {}) {
  const config = configStore.get()
  const gate = await preflight(e, text, config)
  if (!gate.ok) throw Object.assign(new Error(gate.message || "当前会话不可使用此动作"), { silent: !options.web && gate.silent === true })
  try {
    const decision = actionAccess(action, e, config)
    if (!decision.allowed) throw new Error(decision.reason)
    const images = options.web ? options.images || [] : await actionImages(action, e, config)
    if (action.input.requireImage && !images.length) throw new Error("请提供参考图片后再试跑")
    const args = bindActionArguments(action, text, e, action.input.images === "none" ? undefined : images)
    validateActionArguments(action, args)
    let toolReplied = false
    const executionEvent = typeof e.reply === "function" ? { ...e, reply: async (...parts: unknown[]) => {
      const value = await (e.reply as (...parts: unknown[]) => unknown).apply(e, parts)
      toolReplied = true
      return value
    } } : e
    const registry = action.kind === "source" ? new ToolRegistry() : toolRegistry
    if (action.kind === "source") registry.register(actionSourceTool(action))
    const result = await executeDirectTool(action.tool, args, {
      e: executionEvent, config, actionId: action.id, observability: { toolCallId: `action:${action.id}` }, source: options.web ? "action-web-test" : "action-command",
      execution: {
        onBackgroundComplete: options.web ? undefined : async task => {
          if (typeof e.reply !== "function") return
          if (!checkAccess(e, configStore.get()).ok) return
          if (task.status !== "ok") {
            if (!toolReplied) await e.reply(`动作未完成：${task.error || "任务已取消"}`)
            return
          }
          const output = await actionOutput(action, { ...normalizeToolResult(task.result), value: task.result }, e, false, toolReplied)
          if (!output.delivery && output.message) await e.reply(output.message)
          else if (output.delivery && !["success", "accepted"].includes(String(actionRecord(output.delivery).status))) await e.reply("动作已执行，但结果投递失败。")
        },
        beforeInvoke: () => {
          const latest = configStore.get()
          const current = parseActions(latest.actions).items[action.id]
          if (!current || current.tool !== action.tool || JSON.stringify(current.source) !== JSON.stringify(action.source) || !checkAccess(e, latest).ok || !actionAccess(current, e, latest).allowed) throw Object.assign(new Error("动作或工具权限已变化，任务已停止"), { permissionDenied: true })
        },
      },
    }, registry)
    const metadata = actionRecord(result.metadata)
    const { message, delivery, parts, note } = await actionOutput(action, result, e, options.web, toolReplied)
    return { status: result.status, result: result.value ?? result.content, message, delivery, reply: { message, parts, note }, taskId: metadata.taskId || "" }
  } finally { releasePreflight(gate) }
}
