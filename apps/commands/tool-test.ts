import { configStore } from "../../config/store.js"
import {
  formatExecutionParameterGuide,
  parseExecutionTestPayload,
  runExecutionTest,
} from "../../extensions/testing/execution-runtime.js"
import { toolRegistry } from "../../tools/support/registry.js"
import { getToolCommon } from "../../tools/support/contract.js"
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

export function parseToolTestPayload(message: unknown = "") {
  return parseExecutionTestPayload(text(message), pluginCommand("测试工具"))
}

function formatToolParameterGuide(tool: UnknownRecord = {}): string {
  const common = getToolCommon(tool)
  return formatExecutionParameterGuide({
    kind: "工具",
    name: tool.name,
    schema: record(common).parameters,
    testCommand: `${pluginCommand("测试工具")} ${text(tool.name)}`,
  })
}

export async function runToolTestCommand({ e, reply }: CommandOptions): Promise<unknown> {
  let payload
  try {
    payload = parseToolTestPayload(e?.msg)
  } catch (err) {
    return reply(`工具测试参数错误：${errorMessage(err)}`, true)
  }
  if (!payload.name) {
    const tools = await toolRegistry.getAllowedTools({ e }) as UnknownRecord[]
    const names = tools.slice(0, 30).map(tool => text(tool.name))
    return reply(
      names.length
        ? `可测试的已启用工具：${names.join("、")}\n参数说明：${pluginCommand("工具参数")} <工具名>\n测试：${pluginCommand("测试工具")} <工具名> 参数=值`
        : "当前没有可测试的已启用工具。请先在 AI 能力中启用一个工具。",
      true,
    )
  }
  try {
    const config = await configStore.load()
    const tool = (await toolRegistry.getAllowedTools({ e }) as UnknownRecord[]).find(item => text(item.name) === payload.name)
    if (!tool) return reply(`工具 ${payload.name} 当前未启用、不可见或没有权限。可先发送 ${pluginCommand("测试工具")} 查看可测试工具。`, true)
    const tested = await runExecutionTest({
      schema: record(getToolCommon(tool)).parameters,
      args: payload.args,
      context: { e, config, source: "command-test" },
      execute: context => toolRegistry.execute(text(tool.name), payload.args, context),
    })
    return reply(`工具 ${payload.name} 测试结果（${tested.durationMs}ms）：\n${tested.serialized}`, true)
  } catch (err) {
    return reply(`工具 ${payload.name} 测试失败：${errorMessage(err)}`, true)
  }
}

export async function runToolParameterCommand({ e, reply }: CommandOptions): Promise<unknown> {
  const name = stripPluginCommand(e?.msg, "工具参数")
  if (!name) return reply(`用法：${pluginCommand("工具参数")} <工具名>\n例如：${pluginCommand("工具参数")} weather`, true)
  const tool = (await toolRegistry.getAllowedTools({ e }) as UnknownRecord[]).find(item => text(item.name) === name)
  if (!tool) return reply(`未找到可测试工具 ${name}。可先发送 ${pluginCommand("测试工具")} 查看已启用工具。`, true)
  return reply(formatToolParameterGuide(tool), true)
}
