import { capabilityStore } from "../../../../tools/access/capability-store.js"
import { requireWebAuth as auth } from "../../auth.js"
import { handleRoute } from "../../route-handler.js"
import type { RouteApp, RouteRequest, RouteResponse } from "../../route-handler.js"

export function registerKnowledgeAccessRoutes(app: RouteApp): void {
  app.get("/api/capabilities/overrides", auth, (_req: RouteRequest, res: RouteResponse) => res.json({ ok: true, rules: capabilityStore.rules }))
  app.post("/api/capabilities/overrides", auth, handleRoute(async (req, res) => {
    const effect = req.body?.effect
    if (!["allow", "deny", "default"].includes(String(effect))) throw new Error("规则必须是 allow、deny 或 default")
    const input = {
      subjectType: "user",
      subjectId: String(req.body?.subjectId || ""),
      groupId: String(req.body?.groupId || ""),
      resourceType: String(req.body?.resourceType || "tool"),
      resourceId: String(req.body?.resourceId || ""),
      effect: effect === "allow" ? "allow" as const : "deny" as const,
    }
    if (effect === "default") await capabilityStore.removeRule(input)
    else await capabilityStore.setRule(input)
    res.json({ ok: true, rules: capabilityStore.rules })
  }, { errorStatus: 400 }))
}
