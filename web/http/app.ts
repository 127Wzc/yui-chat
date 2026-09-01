import express from "express"
import crypto from "node:crypto"
import { registerConfigRoutes } from "./routes/configuration.js"
import { registerExtensionRoutes } from "./routes/capabilities/extensions.js"
import { registerExtensionAuthoringRoutes } from "./routes/capabilities/authoring.js"
import { registerKnowledgeRoutes } from "./routes/knowledge.js"
import { registerRuntimeRoutes } from "./routes/runtime.js"
import { registerMessageFilterRoutes } from "./routes/filters/message-processing.js"
import { registerFilterRoutes } from "./routes/filters/filters.js"
import { registerObservabilityRoutes } from "./routes/observability.js"
import { renderWebShell, staticRoot } from "./shell.js"
import type { RouteApp, RouteRequest, RouteResponse } from "./route-handler.js"

export { applyConfigPatch, deleteModelConfig, deleteProviderConfig, setDefaultModelConfig, updateModelConfig, updateProviderConfig } from "../../models/configuration/editor.js"
export { registerWebSocket, unregisterWebSocket } from "./websocket.js"

interface WebApp extends RouteApp {
  use(...handlers: unknown[]): unknown
}

function applySecurityHeaders(req: RouteRequest, res: RouteResponse, next: () => void): void {
  res.set({
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  })
  if (String(req.path || "").startsWith("/api/")) res.set("Cache-Control", "no-store")
  next()
}

function webContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' ws: wss:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ")
}

export function createWebApp(): WebApp {
  const app = express.Router() as unknown as WebApp
  app.use(applySecurityHeaders)
  app.use(express.json({ limit: "1mb" }))
  // 子模块使用原生 ESM 相对导入，无法继承入口文件的版本查询参数；要求浏览器每次重验，避免升级后一小时仍加载旧页面。
  app.use("/assets", express.static(staticRoot, { dotfiles: "deny", index: false, maxAge: 0, etag: true }))
  app.get("/", (_req: RouteRequest, res: RouteResponse) => {
    const nonce = crypto.randomBytes(18).toString("base64url")
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": webContentSecurityPolicy(nonce),
    }).type("html").send(renderWebShell({ nonce }))
  })
  registerRuntimeRoutes(app)
  registerConfigRoutes(app)
  registerExtensionRoutes(app)
  registerExtensionAuthoringRoutes(app)
  registerKnowledgeRoutes(app)
  registerMessageFilterRoutes(app)
  registerFilterRoutes(app)
  registerObservabilityRoutes(app)
  return app
}
