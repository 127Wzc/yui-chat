import { toolRegistry, type RegistryExecutionContext } from "./registry.js"
import { createExecutionRuntime } from "./execution-runtime.js"

/** 无模型入口也复用工具 guard、超时、参数检查和 Registry 后台队列。 */
export async function executeDirectTool(name: string, args: Record<string, unknown>, context: RegistryExecutionContext, registry = toolRegistry) {
  const tool = registry.get(name)
  if (!tool) throw new Error(`工具 ${name} 不存在`)
  const runtime = createExecutionRuntime({ config: context.config, event: context.e as Record<string, unknown>, maxToolCalls: 1, maxSideEffectCalls: 1, maxTurns: 1 })
  const call = { name, arguments: args }
  const guard = runtime.guardToolCall({ tool, call, context, round: 1 })
  const startedAt = Date.now()
  const result = await runtime.executeTool({
    guard, signal: context.signal,
    invoke: (parameters, _attempt, execution) => registry.execute(name, parameters, {
      ...context, signal: execution.signal, execution: { ...context.execution, ...execution },
    }),
  })
  runtime.recordExecution({ guard, call, result: { ...result }, startedAt, endedAt: Date.now() })
  return result
}
