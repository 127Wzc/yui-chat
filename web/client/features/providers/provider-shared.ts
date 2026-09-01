import { request } from "../../app/store/store.js"

type UnknownRecord = Record<string, unknown>

export interface SelectOption {
  value: string
  label: string
}

export const BOOL_OPTIONS = [{ value: "true", label: "开启" }, { value: "false", label: "关闭" }]
export const BOOL_OFF_OPTIONS = [{ value: "false", label: "关闭" }, { value: "true", label: "开启" }]
export const INHERIT_BOOL_OPTIONS = [
  { value: "", label: "继承全局设置" },
  { value: "true", label: "开启" },
  { value: "false", label: "关闭" },
]
export const STRATEGY_OPTIONS = [
  { value: "sequential", label: "顺序尝试" },
  { value: "random", label: "随机选择" },
  { value: "fallback", label: "失败回退" },
]
export const REASONING_TARGET_OPTIONS = [
  { value: "auto", label: "自动识别" },
  { value: "openai", label: "按 OpenAI 推理参数发送" },
  { value: "deepseek", label: "按 DeepSeek 推理参数发送" },
  { value: "claude", label: "按 Claude 思考参数发送" },
]
export const REASONING_EFFORT_OPTIONS = [
  { value: "", label: "默认 / 不额外指定" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
]

export function strategyLabel(value: unknown = ""): string {
  const normalized = String(value || "")
  return STRATEGY_OPTIONS.find(item => item.value === normalized)?.label || normalized || "顺序尝试"
}

export async function requestProviderModels(payload: UnknownRecord = {}): Promise<UnknownRecord> {
  return request("/api/providers/models", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export function uniqueModelIds(items: unknown[] = []): string[] {
  return [...new Set(items.map(item => String(item || "").trim()).filter(Boolean))]
}

export interface MutableBooleanRef {
  value: boolean
}

export async function runLocked<T>(flagRef: MutableBooleanRef, task: () => Promise<T>): Promise<T | null> {
  if (flagRef.value) return null
  flagRef.value = true
  try {
    return await task()
  } finally {
    flagRef.value = false
  }
}

// 供应商页统一的搜索框（.list-filter 内的 filter-search 片段，原样重复 3 次后沉淀）。
export const ProviderFilterSearch = {
  name: "ProviderFilterSearch",
  props: { modelValue: { type: String, default: "" }, placeholder: { type: String, default: "" } },
  emits: ["update:modelValue"],
  template: `
    <label class="filter-search">
      <Icon name="search" :size="14" />
      <input :value="modelValue" type="text" :placeholder="placeholder" @input="$emit('update:modelValue', $event.target.value)" />
    </label>
  `,
}
