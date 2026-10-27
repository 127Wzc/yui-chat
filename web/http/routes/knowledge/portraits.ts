import { configStore } from "../../../../config/store.js"
import { PORTRAIT_SYSTEM_PROMPT, portraitConfig, portraitStore } from "../../../../memory/portrait.js"
import { PORTRAIT_TYPES } from "../../../../memory/portrait-types.js"
import { renderPortraitReport, withRenderScope } from "../../../../core/rendering/render-service.js"
import { buildPortraitPreviewDocument } from "../../../../core/rendering/portrait-template.js"
import { updateConfigAndApply } from "../../runtime-config.js"
import { requireWebAuth as auth } from "../../auth.js"
import { handleRoute } from "../../route-handler.js"
import type { RouteApp } from "../../route-handler.js"
import type { JsonValue } from "../../../../core/message-chain/types.js"

const admin = { userId: "web-admin", admin: true }
const fields = ["defaultType", "historyCount", "inputTokenLimit", "maxTokens", "modelName"]
export function registerPortraitRoutes(app: RouteApp): void {
  app.get("/api/memory/portraits/settings", auth, handleRoute(async (_req, res) => {
    res.json({ ok: true, settings: portraitConfig(), types: PORTRAIT_TYPES, fixedPrompt: PORTRAIT_SYSTEM_PROMPT })
  }))
  app.put("/api/memory/portraits/settings", auth, handleRoute(async (req, res) => {
    const incoming = req.body.settings
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || Object.keys(incoming).some(key => !fields.includes(key))) throw new Error("画像设置仅接受默认类型、模型和生成预算。")
    const { saved } = await updateConfigAndApply(current => {
      current.memory ||= {}
      current.memory.portrait = incoming as JsonValue
    })
    res.json({ ok: true, settings: (saved.memory as Record<string, unknown>).portrait, config: configStore.getPublic() })
  }, { errorStatus: 400 }))
  app.get("/api/memory/portraits/groups/:groupId/default-type", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, ...await portraitStore.typeSettings(req.params.groupId, req.query.userId) })
  }, { errorStatus: 400 }))
  app.put("/api/memory/portraits/groups/:groupId/default-type", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, ...await portraitStore.setDefaultType(req.params.groupId, req.body.userId, req.body.typeId) })
  }, { errorStatus: 400 }))
  const base = "/api/memory/portraits/groups/:groupId/members/:userId"
  app.get(base, auth, handleRoute(async (req, res) => {
    res.set("Cache-Control", "no-store")
    res.json({ ok: true, ...await portraitStore.view(req.params.groupId, req.params.userId, admin, req.query.typeId) })
  }, { errorStatus: 400 }))
  app.post(base, auth, handleRoute(async (req, res) => {
    const result = await portraitStore.generate(req.params.groupId, req.params.userId, { actor: admin, typeId: req.body.typeId, force: req.body.force === true, historyCount: req.body.historyCount, supplement: req.body.supplement !== false })
    res.json({ ok: true, ...result })
  }, { errorStatus: 400 }))
  app.get(base + "/:reportId/evidence", auth, handleRoute(async (req, res) => {
    res.set("Cache-Control", "no-store")
    res.json({ ok: true, items: await portraitStore.evidence(req.params.groupId, req.params.userId, req.params.reportId, admin) })
  }, { errorStatus: 400 }))
  app.get(base + "/:reportId/preview", auth, handleRoute(async (req, res) => {
    const report = await portraitStore.getReport(req.params.groupId, req.params.userId, req.params.reportId, admin)
    res.set("Cache-Control", "no-store")
    res.json({ ok: true, html: buildPortraitPreviewDocument(report) })
  }, { errorStatus: 400 }))
  app.get(base + "/:reportId/image", auth, handleRoute(async (req, res) => {
    const report = await portraitStore.getReport(req.params.groupId, req.params.userId, req.params.reportId, admin)
    const image = await renderPortraitReport(report, withRenderScope(configStore.get(), "system"))
    await portraitStore.getReport(req.params.groupId, req.params.userId, req.params.reportId, admin)
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).type("image/png").send(image.buffer)
  }, { errorStatus: 400 }))
}
