import crypto from "node:crypto"
import { generateCustomFilterDraft } from "../../../../filters/authoring/generator.js"
import { browseFrameworkResourceDirectory } from "../../../../extensions/framework-resources.js"
import { requireWebAuth as auth } from "../../auth.js"
import { createWebTestEvent } from "../../request-context.js"
import { handleRoute, type RouteApp } from "../../route-handler.js"

/** 注册扩展作者工具的资源浏览和过滤器草稿接口。 */
export function registerExtensionAuthoringRoutes(app: RouteApp): void {
  app.get("/api/extension-authoring/resources", auth, handleRoute(async (req, res) => {
    const result = await browseFrameworkResourceDirectory(String(req.query.path || "plugins"))
    res.json({ ok: true, result })
  }, { errorStatus: 400 }))

  app.post("/api/extension-authoring/filter-draft", auth, handleRoute(async (req, res) => {
    const requestId = crypto.randomUUID()
    const result = await generateCustomFilterDraft(req.body || {}, {
      event: createWebTestEvent(`filter-authoring-${requestId}`, String(req.body?.requirement || "")),
    })
    res.json({ ok: true, requestId, result })
  }, { errorStatus: 400 }))
}
