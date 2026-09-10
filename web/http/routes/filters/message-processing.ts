import { listMessageFilterTemplates } from "../../../../filters/message/message-filter-templates.js"
import { getMessageFilterStage, listMessageFilterStages, sortMessageFilters } from "../../../../filters/message/message-filter-contract.js"
import { applyInputFilters, applyOutputFilters } from "../../../../filters/message/message-filter-service.js"
import { configStore, redactConfigSecrets } from "../../../../config/store.js"
import { filterRegistry } from "../../../../filters/core/registry.js"
import { requireWebAuth as auth } from "../../auth.js"
import { handleRoute } from "../../route-handler.js"
import { updateConfigAndApply } from "../../runtime-config.js"
import type { RouteApp, RouteRequest, RouteResponse, UnknownRecord } from "../../route-handler.js"
import type { RuntimeConfigObject } from "../../../../config/types.js"

const defaultPriority = 100

function isObject(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function filterSourceMeta(implementation: UnknownRecord = {}): { id: string; label: string; detail: string } {
  if (implementation.source === "builtin") return { id: "builtin", label: "内置", detail: "内置代码过滤器" }
  return {
    id: "custom",
    label: "Custom",
    detail: implementation.packageId ? `Custom · ${implementation.packageId}` : "Custom 代码过滤器",
  }
}

function serializeImplementation(implementation: UnknownRecord = {}): UnknownRecord {
  const source = filterSourceMeta(implementation)
  return {
    id: implementation.id,
    displayName: implementation.displayName || implementation.displayNameZh || implementation.id,
    displayNameZh: implementation.displayNameZh || implementation.displayName || "",
    description: implementation.descriptionZh || implementation.description || "",
    descriptionZh: implementation.descriptionZh || implementation.description || "",
    enabled: implementation.enabled !== false,
    parameters: implementation.parameters || { type: "object", properties: {} },
    configSchema: implementation.configSchema || { type: "object", properties: {} },
    stages: implementation.stages || [],
    effects: implementation.effects || ["pure"],
    resultKinds: implementation.resultKinds || [],
    source: source.id,
    sourceLabel: source.label,
    sourceDetail: source.detail,
    packageId: implementation.packageId || "",
    tags: implementation.tags || [],
  }
}

function normalizePriority(value: unknown): number {
  const priority = value === undefined || value === "" ? defaultPriority : Number(value)
  if (!Number.isInteger(priority) || priority < -10000 || priority > 10000) {
    throw new Error("过滤器优先级必须是 -10000 到 10000 之间的整数")
  }
  return priority
}

function normalizeArguments(value: unknown): UnknownRecord {
  return isObject(value) ? { ...value } : {}
}

function normalizeFilters(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) throw new Error("filters 必须是数组")
  const ids = new Set()
  const filters = value.map(filter => {
    if (!isObject(filter)) throw new Error("过滤器必须是对象")
    const implementation = isObject(filter.implementation) ? filter.implementation : null
    if (!implementation || implementation.type !== "filter") throw new Error("过滤器 implementation.type 只支持 filter")
    const implementationId = String(implementation.id || "").trim()
    if (!implementationId) throw new Error("过滤器必须引用一个代码实现")
    const id = String(filter.id || "").trim()
    if (!id) throw new Error("过滤器 ID 不能为空")
    if (ids.has(id)) throw new Error(`过滤器 ID 不能重复：${id}`)
    ids.add(id)
    const condition = isObject(filter.condition) ? filter.condition : {}
    return {
      id,
      name: String(filter.name || "").trim(),
      enabled: filter.enabled === true,
      stage: String(filter.stage || "output"),
      priority: normalizePriority(filter.priority),
      condition: { minTextLength: Math.max(0, Number(condition.minTextLength || 0)) },
      implementation: { type: "filter", id: implementationId, arguments: normalizeArguments(implementation.arguments) },
      onFailure: "continue",
    }
  })
  return sortMessageFilters(filters)
}

function assertCallableFilters(filters: UnknownRecord[], implementations: UnknownRecord[]): void {
  const availableFilters = new Map(implementations.map(item => [item.id, item]))
  for (const filter of filters) {
    const filterImplementation = isObject(filter.implementation) ? filter.implementation : {}
    const implementationId = String(filterImplementation.id || "")
    const implementation = availableFilters.get(implementationId)
    if (!implementation) throw new Error(`过滤器「${filter.name || filter.id}」引用的代码实现不存在或未启用：${implementationId}`)
    const stages = Array.isArray(implementation.stages) ? implementation.stages.map(item => String(item)) : []
    if (!stages.includes(String(filter.stage))) {
      throw new Error(`代码过滤器 ${implementation.displayNameZh || implementation.displayName || implementation.id} 不支持 ${getMessageFilterStage(filter.stage)?.label || filter.stage} 阶段`)
    }
  }
}

function currentFiltering(config: UnknownRecord = {}): UnknownRecord {
  const response = isObject(config.response) ? config.response : {}
  const filtering = isObject(response.messageFilters) ? response.messageFilters : { enabled: true, runtimeVariables: {}, filters: [] }
  return { ...filtering, filters: sortMessageFilters(Array.isArray(filtering.filters) ? filtering.filters : []) }
}

function templates(): UnknownRecord[] {
  return listMessageFilterTemplates().map(template => ({
    ...template,
    filter: normalizeFilters([template.filter])[0],
  }))
}

async function availableImplementations(): Promise<UnknownRecord[]> {
  return (await filterRegistry.list()).map(serializeImplementation)
}

function responsePayload(config: UnknownRecord, implementations: UnknownRecord[], extra: UnknownRecord = {}): UnknownRecord {
  return {
    ok: true,
    filtering: currentFiltering(redactConfigSecrets(config) as UnknownRecord),
    templates: templates(),
    stages: listMessageFilterStages(),
    implementations,
    ...extra,
  }
}

function summarizeDelivery(delivery: UnknownRecord = {}): UnknownRecord {
  const data = delivery.data
  return {
    kind: delivery.kind || "unknown",
    continueText: delivery.continueText !== false,
    bytes: Buffer.isBuffer(data) ? data.length : Number(isObject(data) ? data.byteLength : 0) || 0,
  }
}

async function listFilters(_req: RouteRequest, res: RouteResponse): Promise<void> {
  const config = configStore.get()
  res.json(responsePayload(config, await availableImplementations()))
}

const saveFilters = handleRoute(async (req, res) => {
  const filters = normalizeFilters(req.body?.filters)
  const implementations = await availableImplementations()
  assertCallableFilters(filters, implementations)
  const { saved, runtime } = await updateConfigAndApply(config => {
    const response = isObject(config.response) ? config.response : {}
    const existingFilters = isObject(response.messageFilters) ? response.messageFilters : {}
    delete response.messageProcessing
    return {
      ...config,
      response: {
        ...response,
        messageFilters: {
          enabled: req.body?.enabled !== false,
          runtimeVariables: existingFilters.runtimeVariables || {},
          filters,
        },
      },
      } as typeof config
  }, {}, { reinitTools: false, reinitFilters: true })
  res.json(responsePayload(saved, await availableImplementations(), { config: redactConfigSecrets(saved), runtime }))
}, { errorStatus: 400, includeValidation: true })

const testFilter = handleRoute(async (req, res) => {
  const [draft] = normalizeFilters([req.body?.filter])
  if (!draft) throw new Error("请提供要测试的过滤器")
  const implementations = await availableImplementations()
  assertCallableFilters([draft], implementations)
  const text = String(req.body?.text || "")
  if (text.length > 20000) throw new Error("测试文本最多 20,000 个字符")
  const config = structuredClone(configStore.get()) as RuntimeConfigObject
  const existingResponse = isObject(config.response) ? config.response : {}
  const existingFilters = isObject(existingResponse.messageFilters) ? existingResponse.messageFilters : {}
  config.response = {
    ...existingResponse,
    messageFilters: {
      enabled: true,
      runtimeVariables: existingFilters.runtimeVariables || {},
      filters: [{ ...draft, enabled: true }],
    },
  }
  delete config.response.messageProcessing
  const context = {
    e: { isMaster: true, isGroup: false, user_id: "web-message-filter-test" },
    config,
    source: "message-filter-test",
  }
  const filtered = draft.stage === "input"
    ? await applyInputFilters(text, context)
    : await applyOutputFilters(text, context)
  res.json({
    ok: true,
    result: {
      stage: draft.stage,
      priority: draft.priority,
      input: text,
      output: filtered.text,
      blocked: filtered.blocked === true,
      reason: filtered.reason || "",
      deliveries: filtered.deliveries.map(summarizeDelivery),
      traces: filtered.traces,
      note: "这是本地试运行：不会直接调用当前会话的回复方法；network 或 delivery 类型实现仍可能产生真实外部副作用。",
    },
  })
}, { errorStatus: 400, includeValidation: true })

/** 注册消息过滤器配置、模板和本地试跑接口。 */
export function registerMessageFilterRoutes(app: RouteApp): void {
  app.get("/api/message-filters", auth, listFilters)
  app.put("/api/message-filters", auth, saveFilters)
  app.post("/api/message-filters/test", auth, testFilter)
}
