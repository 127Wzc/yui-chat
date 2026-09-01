import { configStore } from "../../../../config/store.js"
import { customFilterManager } from "../../../../filters/custom/manager.js"
import { filterRegistry } from "../../../../filters/core/registry.js"
import { maskToolRuntimeConfig } from "../../../../extensions/runtime-config.js"
import { requireWebAuth as auth } from "../../auth.js"
import { handleRoute } from "../../route-handler.js"
import { updateConfigAndApply } from "../../runtime-config.js"
import type { RouteApp, UnknownRecord } from "../../route-handler.js"

function isObject(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function filterSummary(filter: UnknownRecord = {}): UnknownRecord {
  return {
    id: filter.id,
    displayName: filter.displayName || filter.displayNameZh || filter.id,
    displayNameZh: filter.displayNameZh || "",
    description: filter.descriptionZh || filter.description || "",
    descriptionZh: filter.descriptionZh || "",
    source: filter.source || "custom",
    packageId: filter.packageId || "",
    stages: filter.stages || [],
    parameters: filter.parameters || { type: "object", properties: {} },
    configSchema: filter.configSchema || { type: "object", properties: {} },
    effects: filter.effects || ["pure"],
    tags: filter.tags || [],
  }
}

async function customFilterPayload(extra: UnknownRecord = {}): Promise<UnknownRecord> {
  const implementations = filterRegistry.list().map(filterSummary)
  return {
    custom: filterRegistry.customStatus(),
    implementations,
    ...extra,
  }
}

function packageFilterHint(details: UnknownRecord, requestedId: unknown = ""): { id: string; hint: UnknownRecord } {
  const manifest = isObject(details.manifest) ? details.manifest : {}
  const filters = Array.isArray(manifest.filters) ? manifest.filters.filter(isObject) : []
  const id = String(requestedId || filters[0]?.id || "").trim()
  const hint = filters.find(item => String(item.id || "").trim() === id)
  if (!id || !hint) throw new Error("请选择该 Custom 包中的过滤器实现")
  return { id, hint }
}

/** 注册 Custom 过滤器包与运行配置管理接口。 */
export function registerFilterRoutes(app: RouteApp): void {
  app.get("/api/custom-filters", auth, handleRoute(async (_req, res) => {
    await customFilterManager.listPackages()
    res.json({ ok: true, ...(await customFilterPayload()) })
  }, { errorStatus: 400 }))
  // 与 AI Tool 的重载分开：只重新读取代码过滤器包，不触发 MCP、Skill 或模型工具重连。
  app.post("/api/custom-filters/reload", auth, handleRoute(async (_req, res) => {
    await filterRegistry.init()
    res.json({ ok: true, ...(await customFilterPayload()) })
  }, { errorStatus: 400 }))
  app.post("/api/custom-filters/template", auth, handleRoute(async (req, res) => {
    const result = await customFilterManager.createTemplate(String(req.body?.filterId || req.body?.id || "text-filter"))
    await filterRegistry.init()
    res.json({ ok: true, result, ...(await customFilterPayload()) })
  }, { errorStatus: 400 }))
  app.post("/api/custom-filters/:id/enabled", auth, handleRoute(async (req, res) => {
    const result = await customFilterManager.setPackageEnabled(req.params.id, req.body?.enabled)
    await filterRegistry.init()
    res.json({ ok: true, result, ...(await customFilterPayload()) })
  }, { errorStatus: 400 }))
  app.get("/api/custom-filters/:id", auth, handleRoute(async (req, res) => {
    const result = await customFilterManager.getPackage(req.params.id)
    const config = configStore.get()
    const responseValue = config.response
    const response = isObject(responseValue) ? responseValue : {}
    const messageFilters = isObject(response.messageFilters) ? response.messageFilters : {}
    const runtimeVariables = isObject(messageFilters.runtimeVariables) ? messageFilters.runtimeVariables : {}
    const manifest = isObject(result.manifest) ? result.manifest : {}
    const runtimeConfig = Object.fromEntries((Array.isArray(manifest.filters) ? manifest.filters.filter(isObject) : []).map(hint => {
      const id = String(hint?.id || "").trim()
      return [id, maskToolRuntimeConfig({ name: id, configSchema: hint.configSchema || manifest.configSchema }, runtimeVariables[id])]
    }).filter(([id]) => id))
    res.json({ ok: true, result: { ...result, runtimeConfig } })
  }, { errorStatus: 400 }))
  app.put("/api/custom-filters/:id", auth, handleRoute(async (req, res) => {
    const result = await customFilterManager.updatePackage(req.params.id, req.body || {})
    await filterRegistry.init()
    res.json({ ok: true, result, ...(await customFilterPayload()) })
  }, { errorStatus: 400 }))
  app.put("/api/custom-filters/:id/runtime-config", auth, handleRoute(async (req, res) => {
    const details = await customFilterManager.getPackage(req.params.id)
    const { id, hint } = packageFilterHint(details, req.body?.filter || req.body?.filterId)
    const config = configStore.get()
    const responseValue = config.response
    const response = isObject(responseValue) ? responseValue : {}
    const messageFilters = isObject(response.messageFilters) ? response.messageFilters : {}
    const runtimeVariables = isObject(messageFilters.runtimeVariables) ? messageFilters.runtimeVariables : {}
    const current = runtimeVariables[id] || {}
    const detailsManifest = isObject(details.manifest) ? details.manifest : {}
    const value = customFilterManager.applyRuntimeConfigUpdate({
      id,
      configSchema: hint.configSchema || detailsManifest.configSchema,
    }, req.body?.value, current)
    const { saved, runtime } = await updateConfigAndApply(config => {
      const response = isObject(config.response) ? config.response : {}
      const filtering = isObject(response.messageFilters) ? response.messageFilters : {}
      const runtimeVariables: UnknownRecord = isObject(filtering.runtimeVariables) ? { ...filtering.runtimeVariables } : {}
      if (Object.keys(value).length) runtimeVariables[id] = value
      else delete runtimeVariables[id]
      return {
        ...config,
        response: {
          ...response,
          messageFilters: {
            ...filtering,
            runtimeVariables,
          },
        },
      } as typeof config
    }, {}, { reinitTools: false, reinitFilters: false })
    res.json({ ok: true, filterId: id, config: saved, runtime, ...(await customFilterPayload()) })
  }, { errorStatus: 400, includeValidation: true }))
  app.post("/api/custom-filters/:id/test", auth, handleRoute(async (req, res) => {
    const details = await customFilterManager.getPackage(req.params.id)
    const { id, hint } = packageFilterHint(details, req.body?.filter || req.body?.filterId)
    const stages = Array.isArray(hint.stages) ? hint.stages.map(item => String(item)) : []
    const params = req.body?.params === undefined ? (req.body?.args === undefined ? {} : req.body.args) : req.body.params
    const runtimeConfig = req.body?.runtimeConfig === undefined ? {} : req.body.runtimeConfig
    if (!isObject(params)) throw new Error("测试参数必须是 JSON 对象")
    if (!isObject(runtimeConfig)) throw new Error("测试运行变量必须是 JSON 对象")
    const text = String(req.body?.text || "")
    if (text.length > 20000) throw new Error("测试文本最多 20,000 个字符")
    const stage = String(req.body?.stage || stages[0] || "").trim()
    if (!stages.includes(stage)) throw new Error(`过滤器 ${id} 不支持 ${stage || "未选择"} 阶段`)
    const result = await customFilterManager.testFilter(req.params.id, id, { text, params }, {
      e: { isMaster: true, isGroup: false, user_id: "web-custom-filter-test" },
      config: await configStore.load(),
      runtimeConfig,
      stage,
      timeoutMs: req.body?.timeoutMs,
    })
    res.json({
      ok: true,
      result: {
        ...result,
        note: result.effects.some(effect => effect === "network" || effect === "delivery")
          ? "该过滤器声明了外部副作用；试跑不会调用当前会话的回复方法，但仍可能发起网络请求或其它真实操作。"
          : "这是本地代码试跑，不会直接调用当前会话的回复方法。",
      },
    })
  }, { errorStatus: 400 }))
  app.delete("/api/custom-filters/:id", auth, handleRoute(async (req, res) => {
    const result = await customFilterManager.deletePackage(req.params.id, configStore.get())
    await filterRegistry.init()
    res.json({ ok: true, result, ...(await customFilterPayload()) })
  }, { errorStatus: 400 }))
}
