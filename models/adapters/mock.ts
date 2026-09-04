import crypto from "node:crypto"
import { ModelAdapter, contentToText } from "./base.js"
import type { JsonValue } from "../../core/message-chain/types.js"
import type { ModelListRequest, ModelRequest, ModelResponse } from "../protocol/types.js"

function usage() {
  return {
    input: 0,
    output: 0,
    total: 0,
    cached: 0,
    reasoning: 0,
    source: "reported" as const,
    inputKnown: true,
    outputKnown: true,
  }
}

function params(request: ModelRequest): Record<string, unknown> {
  const value = request.channel.params
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * 本地 mock 适配器，用于启动烟测和无外部供应商时的演示。
 *
 * 它不模拟真实模型能力，也不负责工具执行；只根据最后一条消息生成确定性结果。
 */
export class MockAdapter extends ModelAdapter {
  override readonly id = "mock"
  override readonly protocol = "mock"
  override readonly supportsTools = true

  override async sendMessage({ channel, messages, tools = [], signal }: ModelRequest): Promise<ModelResponse> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("模型请求已终止")
    const channelParams = params({ channel, messages })
    if (channelParams.fail === true) throw new Error(String(channelParams.failMessage || "mock adapter configured to fail"))
    const lastTool = [...messages].reverse().find(item => item.role === "tool")
    if (lastTool) {
      return {
        id: crypto.randomUUID(),
        text: `我查到这些可用信息：\n${contentToText(lastTool.content)}`,
        usage: usage(),
        stopReason: "end_turn",
        toolCalls: [],
      }
    }
    const last = [...messages].reverse().find(item => item.role === "user")
    const text = contentToText(last?.content || "")
    const commandTool = tools.find(tool => tool.name === "knowledge_manage")
    if (commandTool && /指令|命令|怎么|如何|帮助|help/i.test(text)) {
      return {
        id: crypto.randomUUID(),
        text: "",
        usage: usage(),
        stopReason: "tool_calls",
        toolCalls: [{
          id: crypto.randomUUID(),
          name: "knowledge_manage",
          arguments: { action: "search", query: text, limit: 5 } as Record<string, JsonValue>,
        }],
      }
    }
    return {
      id: crypto.randomUUID(),
      text: `Yui Chat mock 已收到：${text || "空消息"}\n\n配置真实渠道后，可在这里切换到 OpenAI-compatible、Gemini、Qwen、Claude 或 ChatGLM。`,
      usage: usage(),
      stopReason: "end_turn",
      toolCalls: [],
    }
  }

  override async listModels(_request?: ModelListRequest): Promise<unknown[]> {
    return [
      { id: "mock", label: "mock", description: "内置 mock 渠道" },
      { id: "mock-vision", label: "mock-vision", description: "内置 mock 视觉模型" },
      { id: "mock-tools", label: "mock-tools", description: "内置 mock 工具模型" },
    ]
  }
}
