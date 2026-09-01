import { stripForSpeech, synthesizeSpeech } from "../../core/media/tts-service.js"
import { replaceWithSafeRegex } from "../../core/shared/safe-regex.js"
import type { FilterApplyContext, FilterApplyInput } from "../core/contract.js"
import type { UnknownRecord } from "../../core/message/types.js"

const textParameter: UnknownRecord = {
  type: "string",
  title: "要处理的文字",
  description: "由过滤器按当前阶段自动传入，无需手动配置。",
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

/** 创建内置消息处理过滤器；这些实现不注册为模型 Tool。 */
export function createOutputFilters(): UnknownRecord[] {
  return [
    {
      id: "voice_output",
      displayName: "语音输出",
      displayNameZh: "语音输出",
      description: "Convert prepared reply text to a voice record for delivery.",
      descriptionZh: "将已生成的回复文本转成语音发送。",
      stages: ["output"],
      effects: ["network", "delivery"],
      resultKinds: ["record"],
      parameters: {
        type: "object",
        properties: {
          text: textParameter,
          voiceModel: { type: "string", title: "语音模型", description: "留空则使用 TTS 默认模型。" },
          alsoSendText: { type: "boolean", title: "同时发送文字", default: false },
        },
        required: ["text"],
      },
      async apply({ text, params = {} }: FilterApplyInput, context: FilterApplyContext = {}) {
        const prepared = stripForSpeech(text)
        if (!prepared) throw new Error("语音输出需要非空文字")
        const audio = await synthesizeSpeech(prepared, context.config || {}, params.voiceModel ? { voice: String(params.voiceModel) } : {})
        if (!audio) throw new Error("语音输出尚未配置：请先在回复设置中启用并填写 TTS 服务。")
        return {
          kind: "record",
          data: audio,
          continueText: params.alsoSendText === undefined
            ? record(record(record(context.config).response).tts).alsoSendText === true
            : params.alsoSendText === true,
        }
      },
    },
    {
      id: "text_transform",
      displayName: "文本整理",
      displayNameZh: "文本整理",
      description: "Trim, replace, remove, prepend, or append text in a message processing rule.",
      descriptionZh: "对消息做去空白、替换、删除、前缀或后缀处理。",
      stages: ["input", "output"],
      effects: ["pure"],
      resultKinds: ["text"],
      parameters: {
        type: "object",
        properties: {
          text: textParameter,
          operation: { type: "string", title: "处理方式", enum: ["trim", "replace", "remove", "prepend", "append"], enumLabels: { trim: "去除首尾空白", replace: "替换文字", remove: "删除文字", prepend: "添加前缀", append: "添加后缀" }, default: "trim" },
          find: { type: "string", title: "查找内容", description: "替换或删除时使用；按普通文字匹配，不执行正则表达式。" },
          replace: { type: "string", title: "替换为", description: "替换时使用；删除时留空即可。" },
          prefix: { type: "string", title: "前缀", description: "前缀处理时使用。" },
          suffix: { type: "string", title: "后缀", description: "后缀处理时使用。" },
        },
        required: ["text"],
      },
      async apply({ text, params = {} }: FilterApplyInput) {
        const current = String(text ?? "")
        const operation = String(params.operation || "trim")
        if (operation === "replace") {
          const find = String(params.find || "")
          return { kind: "text", text: find ? current.split(find).join(String(params.replace || "")) : current }
        }
        if (operation === "remove") {
          const find = String(params.find || "")
          return { kind: "text", text: find ? current.split(find).join("") : current }
        }
        if (operation === "prepend") return { kind: "text", text: `${String(params.prefix || "")}${current}` }
        if (operation === "append") return { kind: "text", text: `${current}${String(params.suffix || "")}` }
        return { kind: "text", text: current.trim() }
      },
    },
    {
      id: "keyword_filter",
      displayName: "关键词过滤",
      displayNameZh: "关键词过滤",
      description: "Remove configured keywords or stop a message processing rule when they are found.",
      descriptionZh: "命中指定关键词时删除关键词，或直接拦截该输入/回复。",
      stages: ["input", "output"],
      effects: ["pure"],
      resultKinds: ["text", "block"],
      parameters: {
        type: "object",
        properties: {
          text: textParameter,
          keywords: { type: "string", title: "关键词", description: "多个关键词用逗号、空格或换行分隔。" },
          action: { type: "string", title: "命中后处理", enum: ["remove", "block"], enumLabels: { remove: "删除关键词", block: "拦截整条消息" }, default: "remove" },
          replacement: { type: "string", title: "替代文字", description: "删除关键词时使用；留空表示直接删除。" },
        },
        required: ["text", "keywords"],
      },
      async apply({ text, params = {} }: FilterApplyInput) {
        const current = String(text ?? "")
        const keywords = String(params.keywords || "").split(/[\n,，\s]+/).map(item => item.trim()).filter(Boolean)
        if (!keywords.length) return { kind: "text", text: current }
        const matched = keywords.filter(word => current.includes(word))
        if (!matched.length) return { kind: "text", text: current }
        if (params.action === "block") return { kind: "block", reason: `命中关键词：${matched.join("、")}` }
        return { kind: "text", text: matched.reduce((value, word) => value.split(word).join(String(params.replacement || "")), current) }
      },
    },
    {
      id: "regex_replace",
      displayName: "正则替换",
      displayNameZh: "正则替换",
      description: "Replace text using a regular expression with a bounded execution time.",
      descriptionZh: "用正则表达式匹配并替换文字；执行在独立 Worker 中限时完成。",
      stages: ["input", "output"],
      effects: ["pure"],
      resultKinds: ["text"],
      parameters: {
        type: "object",
        properties: {
          text: textParameter,
          pattern: { type: "string", title: "正则表达式", description: "例如：\\s+ 或 [0-9]+。最长 256 个字符。" },
          replacement: { type: "string", title: "替换为", description: "支持 $1、$2 等捕获组引用。" },
          flags: { type: "string", title: "匹配标志", default: "g", description: "可填 g、i、m、s、u；例如 gi 表示全局且忽略大小写。" },
        },
        required: ["text", "pattern"],
      },
      async apply({ text, params = {} }: FilterApplyInput) {
        const replaced = await replaceWithSafeRegex(text, params.pattern, params.replacement, params.flags)
        return { kind: "text", text: replaced }
      },
    },
  ]
}
