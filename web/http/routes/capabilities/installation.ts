import { mcpManager } from "../../../../mcp/index.js"
import crypto from "node:crypto"
import { requireWebAuth } from "../../auth.js"
import { handleRoute, type RouteApp, type RouteRequest } from "../../route-handler.js"
import { installationInstaller } from "../../../../extensions/installation/installer.js"
import { installationStore } from "../../../../extensions/installation/store.js"
import { issueWebInstallationActor } from "../../../../extensions/installation/authorization.js"
import { credentialStore } from "../../../../extensions/credentials.js"
import { createNetworkGrant, listNetworkGrants, revokeNetworkGrant } from "../../../../extensions/installation/network.js"
import { configStore } from "../../../../config/store.js"
import type { SourceInput } from "../../../../extensions/installation/types.js"
import { withExtensionLock, assertExtensionWritable } from "../../../../extensions/installation/guard.js"

export function installationWebActor(req: RouteRequest) {
  const principal = req.webPrincipal as { id?: string } | undefined
  if (!principal?.id) throw new Error("管理身份无效")
  const requestKey = req.headers?.["idempotency-key"]
  if (requestKey !== undefined && (typeof requestKey !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey))) throw new Error("请求编号无效")
  return issueWebInstallationActor(principal.id, typeof requestKey === "string" ? requestKey : crypto.randomUUID())
}
function normalizeInput(body: Record<string, unknown>): SourceInput {
  if (Object.keys(body).some(key => !["source", "kind", "ref", "subdir", "provider", "credentialId", "upload", "mcp"].includes(key))) throw new Error("无效安装字段；凭据请通过专用接口保存")
  if (body.kind !== "skill" && body.kind !== "mcp") throw new Error("安装类型无效")
  return body as unknown as SourceInput
}
export function registerInstallationRoutes(app: RouteApp): void {
  for (const intent of ["install", "inspect"] as const) {
    app.post(`/api/extensions/installations${intent === "inspect" ? "/inspect" : ""}`, requireWebAuth, handleRoute(async (req, res) => {
      const task = await installationInstaller.submit(normalizeInput(req.body), installationWebActor(req), intent)
      res.status(202).json({ ok: true, accepted: true, task })
    }, { errorStatus: 400 }))
  }
  app.get("/api/extensions/installations", requireWebAuth, handleRoute(async (req, res) => {
    installationWebActor(req)
    res.json({ ok: true, tasks: await installationStore.list(Number(req.query.limit) || 50, Number(req.query.before) || Number.MAX_SAFE_INTEGER, String(req.query.beforeId || "")) })
  }))
  app.get("/api/extensions/installations/:id", requireWebAuth, handleRoute(async (req, res) => res.json({ ok: true, task: await installationInstaller.get(req.params.id, installationWebActor(req)) }), { errorStatus: 404 }))
  app.get("/api/extensions/installations/:id/events", requireWebAuth, handleRoute(async (req, res) => {
    await installationInstaller.get(req.params.id, installationWebActor(req))
    res.json({ ok: true, events: await installationStore.events(req.params.id, Number(req.query.afterSequence) || 0) })
  }))
  app.post("/api/extensions/installations/:id/inputs", requireWebAuth, handleRoute(async (req, res) => res.json({ ok: true, task: await installationInstaller.inputs(req.params.id, req.body, installationWebActor(req)) }), { errorStatus: 400 }))
  app.post("/api/extensions/installations/:id/apply", requireWebAuth, handleRoute(async (req, res) => {
    const task = await installationInstaller.get(req.params.id, installationWebActor(req))
    if (Object.keys(req.body).some(key => key !== "planId") || req.body.planId !== task.plan?.id) throw new Error("计划已改变，请刷新后确认")
    res.json({ ok: true, task: await installationInstaller.apply(String(req.body.planId), installationWebActor(req)) })
  }, { errorStatus: 400 }))
  for (const action of ["cancel", "retry", "recover"] as const) app.post(`/api/extensions/installations/:id/${action}`, requireWebAuth, handleRoute(async (req, res) => res.json({ ok: true, task: await installationInstaller[action](req.params.id, installationWebActor(req)) }), { errorStatus: 400 }))
  app.get("/api/extensions/credentials", requireWebAuth, handleRoute(async (req, res) => { installationWebActor(req); res.json({ ok: true, credentials: await credentialStore.list(), networkGrants: listNetworkGrants() }) }))
  app.post("/api/extensions/credentials", requireWebAuth, handleRoute(async (req, res) => {
    installationWebActor(req)
    if (Object.keys(req.body).some(key => !["alias", "purpose", "origin", "scope", "value", "envRef"].includes(key)) || !["repository-read", "mcp-auth"].includes(String(req.body.purpose))) throw new Error("凭据字段无效")
    const id = await credentialStore.put(req.body as unknown as Parameters<typeof credentialStore.put>[0])
    res.json({ ok: true, credentialId: id })
  }, { errorStatus: 400 }))
  app.post("/api/extensions/credentials/:id/revoke", requireWebAuth, handleRoute(async (req, res) => { installationWebActor(req); await credentialStore.revoke(req.params.id);
    for (const [id, server] of Object.entries(configStore.get().mcp?.servers || {})) if ((server as Record<string, unknown>).credentialId === req.params.id) await mcpManager.disconnectServer(id)
    res.json({ ok: true }) }, { errorStatus: 400 }))
  app.post("/api/extensions/network-grants", requireWebAuth, handleRoute(async (req, res) => {
    installationWebActor(req)
    const grant = await createNetworkGrant(req.body)
    res.json({ ok: true, grant })
  }, { errorStatus: 400 }))
  app.post("/api/extensions/network-grants/:id/revoke", requireWebAuth, handleRoute(async (req, res) => { installationWebActor(req); await revokeNetworkGrant(req.params.id);
    for (const [id, server] of Object.entries(configStore.get().mcp?.servers || {})) if ((server as Record<string, unknown>).networkGrantId === req.params.id) await mcpManager.disconnectServer(id)
    res.json({ ok: true }) }, { errorStatus: 400 }))
  app.post("/api/extensions/network-grants/:id/bind", requireWebAuth, handleRoute(async (req, res) => {
    installationWebActor(req)
    const grant = listNetworkGrants().find(item => item.id === req.params.id && !item.revoked)
    if (!grant || grant.targetId !== req.body.targetId) throw new Error("网络授权目标不匹配")
    if (grant.purpose === "repository-fetch") {
      await configStore.update(config => { (config.installation as Record<string, any>).sourceGrants[grant.targetId] = grant.id })
    } else await withExtensionLock("mcp", grant.targetId, async () => {
      assertExtensionWritable("mcp", grant.targetId)
      await configStore.update(config => {
        const server = (config.mcp!.servers as Record<string, Record<string, any>>)[grant.targetId]
        if (!server?.installationId || server.enabled || new URL(String(server.url)).origin !== grant.origin || !grant.paths.includes(new URL(String(server.url)).pathname)) throw new Error("请先停用匹配的受管理服务")
        server.networkGrantId = grant.id
        server.allowedTools = []
        delete server.reviewedToolSchemas
      })
    })
    res.json({ ok: true })
  }, { errorStatus: 400 }))
  app.post("/api/extensions/credentials/:id/bind", requireWebAuth, handleRoute(async (req, res) => {
    const actor = installationWebActor(req)
    if (req.body.installId) {
      res.json({ ok: true, task: await installationInstaller.inputs(String(req.body.installId), { expectedVersion: req.body.expectedVersion, credentialId: req.params.id }, actor) })
      return
    }
    const id = String(req.body.serviceId || "")
    await withExtensionLock("mcp", id, async () => {
      assertExtensionWritable("mcp", id)
      const server = (configStore.get().mcp?.servers as Record<string, Record<string, unknown>>)?.[id]
      if (!server?.installationId || server.enabled) throw new Error("请先停用受管理服务，再绑定凭据")
      await credentialStore.resolve(req.params.id, "mcp-auth", new URL(String(server.url)).origin, id)
      await configStore.update(config => {
        const current = (config.mcp!.servers as Record<string, Record<string, any>>)[id]
        current.credentialId = req.params.id
        current.allowedTools = []
        delete current.reviewedToolSchemas
      })
      res.json({ ok: true })
    })
  }, { errorStatus: 400 }))
}
