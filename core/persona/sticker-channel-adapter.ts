import { getToolCommon } from "../../tools/support/contract.js"
import { isJsonValue } from "../message-chain/types.js"
import type { JsonValue } from "../message-chain/types.js"
import type { ToolExecutionContext } from "../../tools/support/tool-contract.js"

type UnknownRecord = Record<string, unknown>

/** 日常定格内部使用的渠道适配规则；它不会注册成模型工具。 */
export interface StickerChannelAdapterConfig {
  inputMapping?: {
    keyword?: string
    tags?: string
    count?: string
    sort?: string
    match?: string
    page?: string
  }
  fixedArguments?: Record<string, JsonValue>
  outputMapping?: {
    candidatesPath?: string
    idField?: string
    urlField?: string
    descriptionField?: string
    tagsField?: string
    scoreField?: string
  }
}

export interface StickerChannelInput {
  keyword: string
  tags: string[]
  count: number
  /** 可选排序、匹配方式与页码；只发给声明或已知支持这些参数的渠道。 */
  sort?: string
  match?: string
  page?: number
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function sourceName(tool: unknown): string {
  const source = record(tool)
  const mcp = record(source.mcp)
  const common = getToolCommon(tool)
  const provenance = record(common.provenance)
  return text(mcp.originalName || source.originalName || provenance.originalName || source.name).trim()
}

function isSemanticImageSearch(tool: unknown): boolean {
  const source = record(tool)
  const common = getToolCommon(tool)
  const sourceKind = text(common.source || source.source)
  return sourceKind === "mcp" && /(?:^|[_-])search[_-]?images?(?:$|[_-])/i.test(sourceName(tool))
}

function safePath(value: unknown): string[] {
  const path = text(value).trim()
  if (!path || path.length > 160) return []
  return path.split(".").map(item => item.trim()).filter(item => item && item !== "__proto__" && item !== "prototype" && item !== "constructor")
}

function readPath(value: unknown, path: string): unknown {
  const parts = safePath(path)
  let current: unknown = value
  for (const part of parts) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined
    current = (current as UnknownRecord)[part]
  }
  return current
}

function writePath(target: UnknownRecord, path: string, value: unknown): void {
  const parts = safePath(path)
  if (!parts.length) return
  let current = target
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current[part])) current[part] = {}
    current = current[part] as UnknownRecord
  }
  current[parts[parts.length - 1]] = value
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  const source = record(value)
  const output: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(source)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue
    if (isJsonValue(item)) output[key] = item
  }
  return output
}

function mergeConfig(base: StickerChannelAdapterConfig, override: unknown): StickerChannelAdapterConfig {
  const source = record(override)
  const baseInput = record(base.inputMapping)
  const input = record(source.inputMapping)
  const baseOutput = record(base.outputMapping)
  const output = record(source.outputMapping)
  return {
    inputMapping: {
      keyword: text(input.keyword || baseInput.keyword || "keyword").trim() || "keyword",
      tags: text(input.tags || baseInput.tags || "tags").trim() || "tags",
      count: text(input.count || baseInput.count || "count").trim() || "count",
      sort: text(input.sort || baseInput.sort).trim(),
      match: text(input.match || baseInput.match).trim(),
      page: text(input.page || baseInput.page).trim(),
    },
    fixedArguments: { ...jsonRecord(base.fixedArguments), ...jsonRecord(source.fixedArguments) },
    outputMapping: {
      candidatesPath: text(output.candidatesPath || baseOutput.candidatesPath).trim(),
      idField: text(output.idField || baseOutput.idField).trim(),
      urlField: text(output.urlField || baseOutput.urlField).trim(),
      descriptionField: text(output.descriptionField || baseOutput.descriptionField).trim(),
      tagsField: text(output.tagsField || baseOutput.tagsField).trim(),
      scoreField: text(output.scoreField || baseOutput.scoreField).trim(),
    },
  }
}

function declaredConfig(tool: unknown): StickerChannelAdapterConfig {
  const declaration = record(getToolCommon(tool).stickerExpressionChannel || record(tool).stickerExpressionChannel)
  return {
    inputMapping: record(declaration.inputMapping) as StickerChannelAdapterConfig["inputMapping"],
    fixedArguments: jsonRecord(declaration.fixedArguments),
    outputMapping: record(declaration.outputMapping) as StickerChannelAdapterConfig["outputMapping"],
  }
}

/** 从日常定格 binding.adapterConfigs 读取当前渠道的覆盖规则。 */
export function resolveStickerChannelAdapter(tool: unknown, toolConfig: UnknownRecord = {}): StickerChannelAdapterConfig {
  const name = text(record(tool).name).trim()
  const configured = record(record(toolConfig.adapterConfigs)[name])
  const semanticDefaults: StickerChannelAdapterConfig = isSemanticImageSearch(tool)
    ? {
        fixedArguments: { match: "semantic", sort: "relevance" },
        outputMapping: { candidatesPath: "structuredContent.images" },
      }
    : {}
  return mergeConfig(mergeConfig(semanticDefaults, declaredConfig(tool)), configured)
}

function declaredProperties(tool: unknown): UnknownRecord {
  const common = getToolCommon(tool)
  return record(record(common.parameters || record(tool).parameters).properties)
}

/** sort/match/page 属于可选能力：显式映射、入参声明或已知的语义搜图工具才发送。 */
function acceptsOptionalArgument(tool: unknown, key: "sort" | "match" | "page", mapping: UnknownRecord): boolean {
  return Boolean(text(mapping[key]).trim()) || Object.hasOwn(declaredProperties(tool), key) || isSemanticImageSearch(tool)
}

/** 把定格的稳定入参映射为具体渠道的参数；只支持声明式字段映射和固定 JSON 参数。 */
export function buildStickerChannelArguments(tool: unknown, input: StickerChannelInput, toolConfig: UnknownRecord = {}): UnknownRecord {
  const adapter = resolveStickerChannelAdapter(tool, toolConfig)
  const mapping = record(adapter.inputMapping)
  const result: UnknownRecord = { ...record(adapter.fixedArguments) }
  const values: Record<string, unknown> = { keyword: input.keyword, tags: input.tags, count: input.count, sort: input.sort, match: input.match, page: input.page }
  for (const key of ["keyword", "tags", "count", "sort", "match", "page"] as const) {
    const path = text(mapping[key] || key).trim()
    if (!path) continue
    if (key === "keyword" && !text(input.keyword).trim()) continue
    if (key === "tags" && !input.tags.length) continue
    if ((key === "sort" || key === "match" || key === "page") && (!text(values[key] ?? "").trim() || !acceptsOptionalArgument(tool, key, mapping))) continue
    writePath(result, path, values[key])
  }
  return result
}

function mappedCandidate(value: unknown, mapping: UnknownRecord): unknown {
  if (!isRecord(value)) return value
  const idField = text(mapping.idField).trim()
  const urlField = text(mapping.urlField).trim()
  const descriptionField = text(mapping.descriptionField).trim()
  const tagsField = text(mapping.tagsField).trim()
  const scoreField = text(mapping.scoreField).trim()
  if (![idField, urlField, descriptionField, tagsField, scoreField].some(Boolean)) return value
  return {
    ...(idField ? { id: readPath(value, idField) } : {}),
    ...(urlField ? { url: readPath(value, urlField) } : {}),
    ...(descriptionField ? { description: readPath(value, descriptionField) } : {}),
    ...(tagsField ? { tags: readPath(value, tagsField) } : {}),
    ...(scoreField ? { score: readPath(value, scoreField) } : {}),
  }
}

/** 将声明的输出路径和字段映射投影为现有候选归一化器可读取的形状。 */
export function projectStickerChannelOutput(value: unknown, tool: unknown, toolConfig: UnknownRecord = {}): unknown {
  const mapping = record(resolveStickerChannelAdapter(tool, toolConfig).outputMapping)
  const path = text(mapping.candidatesPath).trim()
  if (!path) return value
  const selected = readPath(value, path)
  if (selected === undefined) return value
  return Array.isArray(selected) ? selected.map(item => mappedCandidate(item, mapping)) : mappedCandidate(selected, mapping)
}

/** 仅用于类型提示；适配器执行仍由 ToolRegistry 负责。 */
export type StickerChannelExecutionContext = ToolExecutionContext
