/** 既有公开导入的兼容入口；实现统一位于 OpenAI Chat 协议目录。 */
export {
  ChatGLMAdapter,
  OpenAICompatibleAdapter,
  QwenAdapter,
  parseOpenAIStreamResponse,
} from "./openai/chat/adapter.js"
export type { JsonValue } from "./openai/chat/adapter.js"
