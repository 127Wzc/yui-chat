import { createFrameworkResourceAccess } from "../../extensions/framework-resources.js"
import { normalizeTool, type NormalizedTool } from "../../tools/support/contract.js"
import type { ActionDefinition } from "./contract.js"
import type { ToolExecutionContext } from "../../tools/support/tool-contract.js"

/** 显式源码绑定仍作为 Custom 工具进入 Registry；预览和保存不会导入模块。 */
export function actionSourceTool(action: ActionDefinition): NormalizedTool {
  const source = action.source
  if (!source) throw new Error("未配置源码执行方式")
  const framework = createFrameworkResourceAccess(source.frameworkResources, { packageId: `action-${action.id}` })
  const tool = normalizeTool({
    name: action.tool, actionSourceId: action.id, source: "custom", category: "custom", risk: source.risk,
    description: action.description || action.name, tags: ["action", "source"], policy: {},
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execution: { effect: "unknown", maxAttempts: 1, retryPolicy: "none" },
    async execute(args: Record<string, unknown>, context: ToolExecutionContext = {}) {
      if (source.callStyle === "resource") {
        if (framework.list()[0]?.type === "module") throw new Error("源码模块请选择函数或插件方法执行方式")
        return framework.use("target")
      }
      const exported = await framework.pickExport("target", source.exportName)
      if (context.signal?.aborted) throw new Error("动作已取消")
      if (source.callStyle === "plugin") {
        if (typeof exported !== "function") throw new Error(`导出 ${source.exportName} 不是插件类`)
        const instance = new (exported as new () => Record<string, unknown>)()
        const event = source.useInputAsMessage && action.textParam
          ? { ...(context.e as Record<string, unknown>), msg: String(args[action.textParam] ?? ""), raw_message: String(args[action.textParam] ?? "") }
          : context.e
        instance.e = event
        const method = instance[source.method]
        if (typeof method !== "function") throw new Error(`插件没有方法 ${source.method}`)
        return method.call(instance, event, args, context)
      }
      const owner = source.method ? exported : undefined
      const method = source.method && exported && (typeof exported === "object" || typeof exported === "function") ? (exported as Record<string, unknown>)[source.method] : exported
      if (typeof method !== "function") throw new Error("找不到可执行函数，请核对导出名称和方法名")
      return method.call(owner, args, context)
    },
  })
  if (!tool) throw new Error("源码工具定义无效")
  return tool
}
