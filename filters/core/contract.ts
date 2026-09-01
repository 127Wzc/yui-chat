import type { UnknownRecord } from "../../core/message/types.js"

export type FilterStage = "input" | "output"
export type FilterEffect = "pure" | "network" | "delivery"

export interface FilterApplyInput {
  text: string
  params: UnknownRecord
}

export interface FilterApplyContext extends UnknownRecord {
  config?: unknown
  filterConfig?: UnknownRecord
  stage?: FilterStage | string
}

export type FilterApplyHandler = (input: FilterApplyInput, context: FilterApplyContext) => Promise<unknown> | unknown

export interface NormalizedFilter extends UnknownRecord {
  id: string
  displayName: string
  displayNameZh: string
  description: string
  descriptionZh: string
  source: string
  packageId: string
  stages: FilterStage[]
  parameters: UnknownRecord
  configSchema: UnknownRecord
  effects: FilterEffect[]
  resultKinds: string[]
  enabled: boolean
  apply: FilterApplyHandler
}

const supportedStages = new Set<FilterStage>(["input", "output"])
const supportedEffects = new Set<FilterEffect>(["pure", "network", "delivery"])

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return String(value || "").trim()
}

export function normalizeFilterParameters(parameters: unknown = {}): UnknownRecord {
  const value = record(parameters)
  return {
    ...value,
    type: "object",
    properties: record(value.properties),
  }
}

export function normalizeFilterStages(value: unknown): FilterStage[] {
  const source = Array.isArray(value) ? value : [value]
  return [...new Set(source.map(stage => String(stage || "")).filter((stage): stage is FilterStage => supportedStages.has(stage as FilterStage)))]
}

export function normalizeFilterEffects(value: unknown): FilterEffect[] {
  const source = Array.isArray(value) ? value : [value]
  const effects = source.map(effect => String(effect || "")).filter((effect): effect is FilterEffect => supportedEffects.has(effect as FilterEffect))
  return effects.length ? [...new Set(effects)] : ["pure"]
}

/**
 * 归一化确定性过滤器定义。
 *
 * 过滤器只处理消息正文和显式参数，不承担模型调用、工具权限或消息投递；
 * 动态 Custom Filter 进入这里后必须先拥有可执行函数和合法阶段。
 */
export function normalizeFilter(filter: unknown = {}, defaults: unknown = {}): NormalizedFilter | null {
  const source = record(filter)
  const definition = { ...record(defaults), ...source }
  const candidate = typeof source.apply === "function"
    ? source.apply
    : typeof source.execute === "function" ? source.execute : null
  const apply = typeof candidate === "function" ? candidate as FilterApplyHandler : null
  const id = text(definition.id || definition.name)
  const stages = normalizeFilterStages(definition.stages || definition.stage)
  if (!id || !apply || !stages.length) return null

  const displayName = text(definition.displayName || definition.displayNameZh || id)
  const displayNameZh = text(definition.displayNameZh || definition.displayName || "")
  return {
    ...definition,
    id,
    displayName,
    displayNameZh,
    description: String(definition.description || ""),
    descriptionZh: String(definition.descriptionZh || ""),
    source: text(definition.source || "custom") || "custom",
    packageId: text(definition.packageId),
    stages,
    parameters: normalizeFilterParameters(definition.parameters),
    configSchema: normalizeFilterParameters(definition.configSchema),
    effects: normalizeFilterEffects(definition.effects),
    resultKinds: Array.isArray(definition.resultKinds)
      ? [...new Set(definition.resultKinds.map(kind => text(kind)).filter(Boolean))]
      : [],
    enabled: definition.enabled !== false,
    apply: apply.bind(source),
  }
}

export function filterSummary(filter: unknown = {}): UnknownRecord {
  const value = record(filter)
  return {
    id: value.id,
    displayName: value.displayName,
    displayNameZh: value.displayNameZh,
    description: value.description,
    descriptionZh: value.descriptionZh,
    source: value.source,
    packageId: value.packageId || "",
    stages: Array.isArray(value.stages) ? [...value.stages] : [],
    parameters: value.parameters,
    configSchema: value.configSchema,
    effects: Array.isArray(value.effects) ? [...value.effects] : [],
    resultKinds: Array.isArray(value.resultKinds) ? [...value.resultKinds] : [],
    enabled: value.enabled !== false,
  }
}
