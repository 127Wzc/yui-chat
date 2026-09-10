import { configStore, mergeRedactedConfigSecrets, redactConfigSecrets } from "../../../config/store.js"
import { getSchemaManifest, schema } from "../../../config/schema.js"
import { adapterRegistry } from "../../../models/adapters/registry.js"
import { addModelsToProvider, applyConfigPatch, deleteModelConfig, deleteProviderConfig, resolveProviderDraft, setDefaultModelConfig, updateModelConfig, updateProviderConfig } from "../../../models/configuration/editor.js"
import { providerResolver } from "../../../models/routing/provider-resolver.js"
import { applyProviderConfig, buildProviderConfig, listProviderTemplates } from "../../../models/configuration/provider-templates.js"
import { issueWebAccessToken, requireWebAuth as auth, setWebSessionCookie } from "../auth.js"
import { applySavedConfig, updateConfigAndApply } from "../runtime-config.js"
import { handleRoute } from "../route-handler.js"
import type { RouteApp, RouteRequest, RouteResponse, UnknownRecord } from "../route-handler.js"
import { createConfigBackup, restoreConfigBackup } from "../../../core/storage/config-backup-service.js"
import type { RuntimeConfigObject } from "../../../config/types.js"
import type { ModelChannel } from "../../../models/protocol/types.js"

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function configValue(value: unknown): RuntimeConfigObject {
  return record(value) as RuntimeConfigObject
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function bodyOf(req: RouteRequest): UnknownRecord {
  return record(req.body)
}

function publicConfig(value: unknown): unknown {
  return redactConfigSecrets(value)
}

/** 注册主配置、供应商和模型编辑接口；保存统一经过 runtime-config 热应用边界。 */
export function registerConfigRoutes(app: RouteApp): void {
  app.get("/api/config/auth-token", auth, handleRoute(async (_req, res) => {
    res.json({ ok: true, authToken: String(configStore.get().web?.authToken || "") })
  }))
  app.put("/api/config/auth-token", auth, handleRoute(async (req, res) => {
    const authToken = String(bodyOf(req).authToken || "").trim()
    if (authToken && (authToken.length < 16 || authToken.length > 512)) throw new Error("Web 访问令牌留空表示禁用静态登录；启用时长度必须为 16–512 个字符。")
    const { saved, runtime } = await updateConfigAndApply(config => {
      config.web = { ...record(config.web), authToken }
      return config
    })
    const session = issueWebAccessToken("web-token-rotated")
    setWebSessionCookie(req, res, session)
    res.json({ ok: true, authToken: String(saved.web?.authToken || ""), runtime, meta: configStore.meta() })
  }, { errorStatus: 400 }))
  app.get("/api/config", auth, async (_req: RouteRequest, res: RouteResponse) => {
    res.json({ ok: true, config: configStore.getPublic(), schema, schemaManifest: getSchemaManifest(), meta: configStore.meta(), backups: await configStore.listBackups({ limit: 0 }) })
  })
  app.get("/api/config/schema", auth, (_req: RouteRequest, res: RouteResponse) => {
    res.json({ ok: true, schema, schemaManifest: getSchemaManifest() })
  })
  app.get("/api/config/backups", auth, handleRoute(async (req, res) => {
    const limit = req.query.limit === undefined ? 0 : Number(req.query.limit)
    res.json({ ok: true, directory: configStore.meta().configBackupDir, retention: configStore.backupRetention(), backups: await configStore.listBackups({ limit, inspect: true }) })
  }))
  app.post("/api/config/backups", auth, handleRoute(async (_req, res) => {
    const backup = await createConfigBackup()
    res.json({ ok: true, fileName: backup.fileName, sqliteAvailable: backup.sqliteAvailable, counts: backup.counts, backups: await configStore.listBackups({ limit: 0, inspect: true }) })
  }, { errorStatus: 500 }))
  app.delete("/api/config/backups/:fileName", auth, handleRoute(async (req, res) => {
    const fileName = String(req.params.fileName || "")
    const deleted = await configStore.deleteBackup(fileName)
    if (!deleted) throw Object.assign(new Error("配置备份不存在或已经删除。"), { statusCode: 404 })
    res.json({ ok: true, deleted: fileName, backups: await configStore.listBackups({ limit: 0, inspect: true }) })
  }, { errorStatus: 400 }))
  app.post("/api/config/restore", auth, handleRoute(async (req, res) => {
    const body = bodyOf(req)
    const saved = await restoreConfigBackup(body.fileName || body.backup)
    const runtime = await applySavedConfig(saved)
    res.json({ ok: true, config: publicConfig(saved), runtime, meta: configStore.meta(), backups: await configStore.listBackups({ limit: 0, inspect: true }) })
  }, { errorStatus: 400, includeValidation: true }))
  app.post("/api/config", auth, handleRoute(async (req, res) => {
    const next = bodyOf(req)
    const incoming = configValue(next.config || next)
    const { saved, runtime } = await updateConfigAndApply(current => configValue(mergeRedactedConfigSecrets(incoming, current)))
    res.json({ ok: true, config: publicConfig(saved), runtime, meta: configStore.meta(), backups: await configStore.listBackups({ limit: 0 }) })
  }, { errorStatus: 400 }))
  app.patch("/api/config", auth, handleRoute(async (req, res) => {
    const body = bodyOf(req)
    const patch = record(body.patch || body)
    let changedPaths: string[] = []
    const { saved, runtime } = await updateConfigAndApply(current => {
      const result = applyConfigPatch(current, patch)
      changedPaths = result.changedPaths
      return configValue(result.next)
    })
    res.json({
      ok: true,
      config: publicConfig(saved),
      runtime,
      changedPaths,
      meta: configStore.meta(),
      backups: await configStore.listBackups({ limit: 0 }),
    })
  }, { errorStatus: 400, includeValidation: true }))
  app.post("/api/channels/test", auth, handleRoute(async (req, res) => {
    const channelId = String(bodyOf(req).channelId || "").trim() || undefined
    const channel = await providerResolver.resolve({ channelId })
    if (!channel) throw new Error("未找到可用模型渠道")
    res.json({ ok: true, result: await adapterRegistry.testChannel(channel), channel: publicConfig(channel) })
  }, { errorStatus: 400 }))
  app.post("/api/providers", auth, handleRoute(async (req, res) => {
    const bundle = buildProviderConfig(bodyOf(req))
    const { saved, runtime } = await updateConfigAndApply(config => configValue(applyProviderConfig(config, bundle)))
    const provider = records(saved.apiProviders).find(item => String(item.name || "") === String(bundle.provider.name || ""))
    res.json({
      ok: true,
      provider: provider ? publicConfig(provider) : null,
      template: bundle.template.id,
      config: publicConfig(saved),
      runtime,
      diagnostics: await providerResolver.diagnostics(adapterRegistry.listAdapters().map(item => item.id)),
    })
  }, { errorStatus: 400, includeValidation: true }))
  app.post("/api/providers/models", auth, handleRoute(async (req, res) => {
    const config = await configStore.load()
    const resolved = record(resolveProviderDraft(bodyOf(req), config))
    const channel = record(resolved.channel) as unknown as ModelChannel
    const provider = record(resolved.provider)
    const template = record(resolved.template)
    const result = await adapterRegistry.listModels(channel)
    res.json({
      ok: true,
      provider: {
        name: provider.name,
        type: provider.type,
        baseURL: provider.baseURL,
        hasApiKey: Boolean(provider.apiKey),
        template: template.id,
      },
      ...result,
    })
  }, { errorStatus: 400 }))
  app.post("/api/providers/:name/models", auth, handleRoute(async (req, res) => {
    const providerName = String(req.params.name || "").trim()
    const body = bodyOf(req)
    const modelEntries = arrayValue(body.modelEntries)
    const modelIdentifiers = arrayValue(body.modelIdentifiers).length
      ? arrayValue(body.modelIdentifiers)
      : modelEntries.map(item => record(item).modelIdentifier || record(item).id).filter(Boolean)
    const { saved, runtime } = await updateConfigAndApply(config => configValue(addModelsToProvider(config, providerName, modelIdentifiers, {
      purpose: typeof (body.purpose || body.modelPurpose) === "string" ? String(body.purpose || body.modelPurpose) : undefined,
      adapter: typeof (body.adapter || body.modelAdapter) === "string" ? String(body.adapter || body.modelAdapter) : undefined,
      image: record(body.image),
      taskName: typeof body.taskName === "string" ? body.taskName : undefined,
      stream: typeof body.stream === "boolean"
        ? body.stream
        : typeof body.stream === "string" && ["true", "false"].includes(body.stream)
          ? body.stream === "true"
          : undefined,
    })))
    res.json({
      ok: true,
      provider: providerName,
      added: modelIdentifiers,
      config: publicConfig(saved),
      runtime,
      diagnostics: await providerResolver.diagnostics(adapterRegistry.listAdapters().map(item => item.id)),
    })
  }, { errorStatus: 400, includeValidation: true }))
  app.patch("/api/providers/:name", auth, handleRoute(async (req, res) => {
    const providerName = String(req.params.name || "").trim()
    const { saved, runtime } = await updateConfigAndApply(config => configValue(updateProviderConfig(config, providerName, bodyOf(req))))
    const provider = records(saved.apiProviders).find(item => String(item.name || "") === providerName)
    res.json({
      ok: true,
      provider: provider ? publicConfig(provider) : null,
      config: publicConfig(saved),
      runtime,
      diagnostics: await providerResolver.diagnostics(adapterRegistry.listAdapters().map(item => item.id)),
    })
  }, { errorStatus: 400, includeValidation: true }))
  app.delete("/api/providers/:name", auth, handleRoute(async (req, res) => {
    const providerName = String(req.params.name || "").trim()
    const holder: { value?: ReturnType<typeof deleteProviderConfig> } = {}
    const { saved, runtime } = await updateConfigAndApply(config => {
      const deletion = deleteProviderConfig(config, providerName)
      holder.value = deletion
      return configValue(deletion.next)
    })
    const deletion = holder.value
    if (!deletion) throw new Error("供应商删除结果为空")
    res.json({
      ok: true,
      deleted: deletion.deleted,
      removedModels: deletion.removedModels,
      fallbackModel: deletion.fallbackModel,
      config: publicConfig(saved),
      runtime,
      diagnostics: await providerResolver.diagnostics(adapterRegistry.listAdapters().map(item => item.id)),
    })
  }, { errorStatus: 400, includeValidation: true }))
  app.patch("/api/models/:name", auth, handleRoute(async (req, res) => {
    const modelName = String(req.params.name || "").trim()
    const { saved, runtime } = await updateConfigAndApply(config => configValue(updateModelConfig(config, modelName, bodyOf(req))))
    const model = records(saved.models).find(item => String(item.name || "") === modelName)
    res.json({
      ok: true,
      model: publicConfig(model),
      config: publicConfig(saved),
      runtime,
      diagnostics: await providerResolver.diagnostics(adapterRegistry.listAdapters().map(item => item.id)),
    })
  }, { errorStatus: 400, includeValidation: true }))
  app.post("/api/models/:name/default", auth, handleRoute(async (req, res) => {
    const modelName = String(req.params.name || "").trim()
    const requestedTask = String(bodyOf(req).taskName || "replyer").trim()
    const taskName = requestedTask || "replyer"
    const { saved, runtime } = await updateConfigAndApply(config => configValue(setDefaultModelConfig(config, modelName, taskName)))
    res.json({ ok: true, model: modelName, taskName, config: publicConfig(saved), runtime, diagnostics: await providerResolver.diagnostics(adapterRegistry.listAdapters().map(item => item.id)) })
  }, { errorStatus: 400, includeValidation: true }))
  app.delete("/api/models/:name", auth, handleRoute(async (req, res) => {
    const modelName = String(req.params.name || "").trim()
    const holder: { value?: ReturnType<typeof deleteModelConfig> } = {}
    const { saved, runtime } = await updateConfigAndApply(config => {
      const deletion = deleteModelConfig(config, modelName)
      holder.value = deletion
      return configValue(deletion.next)
    })
    const deletion = holder.value
    if (!deletion) throw new Error("模型删除结果为空")
    res.json({ ok: true, deleted: deletion.deleted, fallbackModel: deletion.fallbackModel, config: publicConfig(saved), runtime, diagnostics: await providerResolver.diagnostics(adapterRegistry.listAdapters().map(item => item.id)) })
  }, { errorStatus: 400, includeValidation: true }))
  app.get("/api/providers", auth, async (_req: RouteRequest, res: RouteResponse) => {
    const config = await configStore.load()
    const adapters = adapterRegistry.listAdapters()
    const diagnostics = await providerResolver.diagnostics(adapters.map(item => item.id))
    res.json({
      ok: true,
      adapters,
      templates: listProviderTemplates(),
      channels: diagnostics.channels,
      diagnostics,
      modelTasks: config.modelTasks,
      defaultTask: record(config.chat).defaultTask,
      routing: diagnostics.routingDigest,
      routingPreview: diagnostics.routingPreview,
    })
  })
}
