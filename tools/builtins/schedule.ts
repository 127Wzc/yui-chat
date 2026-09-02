import { formatScheduleTaskList, scheduleTaskService } from "../../core/scheduling/schedule-task-service.js"
import type { UnknownRecord } from "../../core/message/types.js"

interface ScheduleContext {
  e?: UnknownRecord
  config?: unknown
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
  description = "Create, list, or cancel lightweight reminder tasks for the current user. Store only what to remind them about; delivery identifies the recipient automatically. Everyone may use it; per-user limits are enforced by config."
  parameters = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["schedule", "list", "cancel", "cron_add", "cron_list", "cron_remove"], description: "Task operation." },
      content: { type: "string", description: "Only the reminder body, max 300 chars. Do not include the recipient name, QQ number, phrases like '提醒某人', or a '定时提醒' prefix." },
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
    if (action === "list") return formatScheduleTaskList(await scheduleTaskService.list(context.e || {}, "all"))
    if (action === "cron_list") return formatScheduleTaskList(await scheduleTaskService.list(context.e || {}, "cron"))
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
