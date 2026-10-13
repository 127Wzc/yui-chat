import crypto from "node:crypto"
import { configStore } from "../../config/store.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import type { InstallationActor, SourceInput } from "./types.js"
import { InstallationError } from "./types.js"

const actors = new WeakSet<object>()
export function issueWebInstallationActor(id: string, requestId: string): InstallationActor {
  const actor: InstallationActor = Object.freeze({ entry: "web", id, requestId, expiresAt: Date.now() + 86400000 })
  actors.add(actor)
  return actor
}
export async function issueOwnerInstallationActor(event: Record<string, unknown>, entry: "model" | "owner_command", context: Record<string, unknown> = {}): Promise<InstallationActor> {
  const original = hostRuntime.inboundMessage(event)
  if (!original || !await hostRuntime.isMasterUser(original.botId, original.userId) || context.agent || context.actionId || context.allowDisabledTool) throw new InstallationError("TRUSTED_OWNER_REQUIRED")
  if (entry === "model" && (!modelInstallationEnabled() || !["chat", "firstPerson", "firstPersonContinuation"].includes(String((context.observability as Record<string, unknown>)?.source)))) throw new InstallationError("MODEL_INSTALL_DISABLED")
  const actor: InstallationActor = Object.freeze({ entry, id: original.userId, botId: original.botId, groupId: original.groupId, requestId: original.messageId, expiresAt: Date.now() + 86400000 })
  actors.add(actor)
  return actor
}
export function assertInstallationActor(actor: InstallationActor): void {
  if (!actors.has(actor)) throw new InstallationError("TRUSTED_ENTRY_REQUIRED")
}
export function modelInstallationEnabled(): boolean {
  const tools = configStore.get().tools || {}
  return tools.enabled === true && Array.isArray(tools.enabledTools) && tools.enabledTools.includes("extension_install")
}
export async function checkContinuedAuthorization(actor: InstallationActor): Promise<void> {
  if (actor.expiresAt && actor.expiresAt <= Date.now()) throw new InstallationError("OWNER_AUTHORIZATION_EXPIRED")
  if (actor.entry === "model" && !modelInstallationEnabled()) throw new InstallationError("MODEL_INSTALL_DISABLED")
  if (actor.entry !== "web" && !await hostRuntime.isMasterUser(actor.botId || "", actor.id)) throw new InstallationError("OWNER_AUTHORIZATION_REVOKED")
}
export function assertModelSourceIntent(event: Record<string, unknown>, input: SourceInput, intent: string): void {
  const message = hostRuntime.inboundMessage(event)?.text || ""
  // Only current, original sender text grants a bounded source scope. Quoted messages and model arguments do not.
  if (input.ref && !message.includes(input.ref) || input.subdir && !message.includes(input.subdir)) throw new InstallationError("EXPLICIT_SOURCE_SCOPE_REQUIRED")
  if (input.kind === "mcp" && input.mcp?.url !== input.source) throw new InstallationError("EXPLICIT_SOURCE_SCOPE_REQUIRED")
  if (!message.includes(input.source) || !(/安装|install/i.test(message) && intent === "install" || /检查|看看|inspect/i.test(message) && intent === "inspect")) throw new InstallationError("EXPLICIT_SOURCE_INTENT_REQUIRED")
}
export function installationRequestKey(actor: InstallationActor, input: SourceInput, intent: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([actor.entry, actor.id, actor.botId, actor.requestId, input.source, input.kind, input.ref, input.subdir, intent])).digest("hex")
}
