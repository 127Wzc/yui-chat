import { scheduleTaskService } from "../../core/scheduling/schedule-task-service.js"
import type { UnknownRecord } from "../../core/message/types.js"

interface ScheduleContext {
  e?: UnknownRecord
  config?: unknown
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

function formatList(rows: UnknownRecord = {}): string {
  const lines: string[] = []
  for (const row of records(rows.oneTime)) {
    let delivery = ""
    if (row.status === "retrying") delivery = ` [重试 ${row.attempts}/${row.maxAttempts}，下次 ${row.nextAttemptAt}]`
    if (row.status === "failed") delivery = ` [发送失败 ${row.attempts}/${row.maxAttempts}，请取消后重建]`
    lines.push(`一次性 ${row.id}${delivery}：${row.runAt}，${row.content}`)
  }
  for (const row of records(rows.cron)) {
    lines.push(`循环 ${row.id}：${row.cron}，${row.content}`)
  }
  return lines.length ? lines.join("\n") : "你当前没有定时任务。"
}

export class ScheduleTaskTool {
  name = "schedule_task"
  source = "builtin"
  execution = { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe", maxAttempts: 2 }
  executionByAction = {
    schedule: { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["content", "delayMinutes"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
    cron_add: { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["content", "cron"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
    cancel: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["taskId", "id"], operationFields: ["taskId", "id"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
    cron_remove: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["taskId", "id"], operationFields: ["taskId", "id"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
  }
  description = "Create, list, or cancel lightweight reminder tasks. Everyone may use it; per-user limits are enforced by config."
  parameters = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["schedule", "list", "cancel", "cron_add", "cron_list", "cron_remove"], description: "Task operation." },
      content: { type: "string", description: "Reminder content, max 300 chars." },
      delayMinutes: { type: "number", description: "Delay for one-time reminders, in minutes." },
      cron: { type: "string", description: "5-field cron expression: minute hour day month weekday." },
      taskId: { type: "string", description: "Task id to cancel/remove." },
    },
    required: ["action"],
  }

  async execute(args: UnknownRecord = {}, context: ScheduleContext = {}): Promise<unknown> {
    const action = String(args.action || "").trim()
    const config = context.config || {}
    if (action === "schedule") return scheduleTaskService.addOneTime(context.e || {}, args, config)
    if (action === "cron_add") return scheduleTaskService.addCron(context.e || {}, args, config)
    if (action === "list") return formatList(await scheduleTaskService.list(context.e || {}, "all"))
    if (action === "cron_list") return formatList(await scheduleTaskService.list(context.e || {}, "cron"))
    if (action === "cancel" || action === "cron_remove") {
      const id = String(args.taskId || args.id || "").trim()
      if (!id) return "缺少 taskId。"
      const removed = await scheduleTaskService.cancel(context.e || {}, id)
      return removed ? `已取消定时任务 ${id}。` : `没有找到可取消的任务 ${id}。`
    }
    return "未知 action，可用：schedule / list / cancel / cron_add / cron_list / cron_remove。"
  }
}

export function createScheduleTools(): unknown[] {
  return [new ScheduleTaskTool()]
}
