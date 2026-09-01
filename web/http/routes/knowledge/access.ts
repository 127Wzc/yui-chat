import { capabilityStore } from "../../../../tools/access/capability-store.js"
import { requireWebAuth as auth } from "../../auth.js"
import { handleRoute } from "../../route-handler.js"
import type { RouteApp, RouteRequest, RouteResponse } from "../../route-handler.js"

export function registerKnowledgeAccessRoutes(app: RouteApp): void {
  app.get("/api/capabilities/overrides", auth, (_req: RouteRequest, res: RouteResponse) => res.json({ ok: true, rules: capabilityStore.rules }))
  app.post("/api/capabilities/overrides", auth, handleRoute(async (req, res) => {
    await capabilityStore.setRule({
      subjectType: String(req.body?.subjectType || "user"),
      subjectId: String(req.body?.subjectId || ""),
      groupId: String(req.body?.groupId || ""),
      resourceType: "tool",
      resourceId: String(req.body?.toolName || ""),
      effect: req.body?.effect === "allow" ? "allow" : "deny",
    })
    res.json({ ok: true, rules: capabilityStore.rules })
  }, { errorStatus: 400 }))
}
