import { cloneJsonValue } from "../../core/shared/json-values.js"

type UnknownRecord = Record<string, unknown>

export const messageFilterTemplates: UnknownRecord[] = [{
  id: "long-reply-voice",
  name: "长回复转语音",
  description: "当一条回复较长时，将回复正文交给语音输出实现；默认关闭，避免没有配置 TTS 时影响日常回复。",
  filter: {
    id: "long-reply-voice",
    name: "长回复转语音",
    enabled: false,
    stage: "output",
    priority: 100,
    condition: { minTextLength: 200 },
    implementation: { type: "filter", id: "voice_output", arguments: { voiceModel: { value: "" }, alsoSendText: { value: false } } },
    onFailure: "continue",
  },
}]

/** 返回管理台可用的内置模板副本，避免调用方改写模块常量。 */
export function listMessageFilterTemplates(): UnknownRecord[] {
  return cloneJsonValue(messageFilterTemplates)
}
