import { configStore } from "../../config/store.js"
import {
  formatExecutionParameterGuide,
  parseExecutionTestPayload,
  runExecutionTest,
} from "../../extensions/testing/execution-runtime.js"
import { filterRegistry } from "../../filters/core/registry.js"
import type { UnknownRecord } from "../../core/message/types.js"
import { pluginCommand, stripPluginCommand } from "../../core/message/command-prefixes.js"

interface CommandOptions {
  e: UnknownRecord
  reply: (...args: unknown[]) => unknown
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : text(error)
}

function filterParameterSchema(filter: UnknownRecord = {}): UnknownRecord {
  const parameters = record(filter.parameters)
  const properties = { ...record(parameters.properties) }
  delete properties.text
  return {
    ...parameters,
    properties,
    required: (Array.isArray(parameters.required) ? parameters.required : []).map(String).filter(name => name !== "text"),
  }
}

function parseFilterPayload(message: unknown = "") {
  return parseExecutionTestPayload(text(message), pluginCommand("测试过滤器"))
}

function filterGuide(filter: UnknownRecord = {}): string {
  const stages = Array.isArray(filter.stages) ? filter.stages.map(text) : []
  const effects = Array.isArray(filter.effects) ? filter.effects.map(text) : []
  const guide = formatExecutionParameterGuide({
    kind: "过滤器",
    name: filter.displayNameZh || filter.displayName || filter.id,
    schema: filterParameterSchema(filter),
    testCommand: `${pluginCommand("测试过滤器")} ${filter.id} text="测试正文"`,
  })
  return `${guide}\n正文会自动作为 text 上下文传入。可用 stage=${stages.includes("output") ? "output" : stages[0] || "input"} 选择测试阶段。\n支持阶段：${stages.join("、") || "无"}；副作用：${effects.join("、") || "pure"}`
}

function extractFilterTestInput(args: UnknownRecord = {}, filter: UnknownRecord = {}): { text: string; stage: string; params: UnknownRecord } {
  const input: UnknownRecord = { ...args }
  const bodyText = String(input.text ?? "")
  delete input.text
  const stages = Array.isArray(filter.stages) ? filter.stages.map(item => text(item)) : []
  const fallbackStage = stages.includes("output") ? "output" : stages[0] || "input"
  const stage = String(input.stage || fallbackStage)
  delete input.stage
  if (!stages.includes(stage)) throw new Error(`过滤器 ${text(filter.id)} 不支持 ${stage} 阶段`)
  return { text: bodyText, stage, params: input }
}

export async function runFilterTestCommand({ e, reply }: CommandOptions): Promise<unknown> {
  let payload
  try {
    payload = parseFilterPayload(e?.msg)
  } catch (err) {
    return reply(`过滤器测试参数错误：${errorMessage(err)}`, true)
  }
  if (!payload.name) {
    const filters = await filterRegistry.list() as UnknownRecord[]
    const names = filters.filter(item => item.enabled !== false).slice(0, 30).map(item => text(item.id))
    return reply(
      names.length
        ? `可测试的代码过滤器：${names.join("、")}\n参数说明：${pluginCommand("过滤器参数")} <过滤器名>\n测试：${pluginCommand("测试过滤器")} <过滤器名> text="测试正文"`
        : "当前没有可测试的代码过滤器。请先在代码过滤器中创建或启用一个实现。",
      true,
    )
  }
  try {
    const foundFilter = filterRegistry.get(payload.name)
    if (!foundFilter) return reply(`未找到代码过滤器 ${payload.name}。AI Tool 请使用 ${pluginCommand("测试工具")}。`, true)
    const filter = record(foundFilter)
    const { text: bodyText, stage, params } = extractFilterTestInput(payload.args, filter)
    const config = await configStore.load()
    const response = record(record(config).response)
    const messageFilters = record(response.messageFilters)
    const filterConfig = record(record(messageFilters.runtimeVariables)[text(filter.id)])
    const tested = await runExecutionTest({
      schema: filterParameterSchema(filter),
      args: params,
      context: {
        e,
        config,
        source: "command-filter-test",
        stage,
        filterId: filter.id,
        filterConfig,
        dryRun: true,
      },
      execute: context => filterRegistry.execute(text(filter.id), { text: bodyText, params }, context),
    })
    return reply(`过滤器 ${filter.id} 试跑结果（${stage}，${tested.durationMs}ms）：\n${tested.serialized}`, true)
  } catch (err) {
    return reply(`过滤器 ${payload.name} 测试失败：${errorMessage(err)}`, true)
  }
}

export async function runFilterParameterCommand({ e, reply }: CommandOptions): Promise<unknown> {
  const name = stripPluginCommand(e?.msg, "过滤器参数")
  if (!name) return reply(`用法：${pluginCommand("过滤器参数")} <过滤器名>\n例如：${pluginCommand("过滤器参数")} text_transform`, true)
  const foundFilter = filterRegistry.get(name)
  if (!foundFilter) return reply(`未找到代码过滤器 ${name}。AI Tool 请使用 ${pluginCommand("工具参数")}。`, true)
  return reply(filterGuide(record(foundFilter)), true)
}
