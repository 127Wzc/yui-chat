interface ModelDisplayRef {
  model_display_name?: unknown
  model_identifier?: unknown
  modelIdentifier?: unknown
  model?: unknown
  name?: unknown
  id?: unknown
}

/** 展示优先使用保存的上游模型名；内部键只作为缺失资料时的最后回退。 */
export function modelDisplayName(model?: ModelDisplayRef | null): string {
  return String(model?.model_display_name || model?.model_identifier || model?.modelIdentifier || model?.model || model?.name || model?.id || "").trim()
}

/** 面向用户的渠道/模型名称；筛选值及配置引用仍保留原内部键。 */
export function modelDisplayLabel(model: ModelDisplayRef, provider: unknown = ""): string {
  return [String(provider || "").trim(), modelDisplayName(model)].filter(Boolean).join(" · ")
}
