import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { configStore, dataDir, cacheDir } from "../../config/store.js"
import { userExtensionsDir } from "../storage.js"
import { credentialStore } from "../credentials.js"
import { backgroundTaskService } from "../../core/scheduling/background-task-service.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import { skillManager } from "../../skills/index.js"
import { installationStore } from "./store.js"
import { acquireInstallationWriterLease } from "./writer-lease.js"
import { assertInstallationActor, checkContinuedAuthorization, installationRequestKey } from "./authorization.js"
import { withExtensionLock, isolateExtension, resetExtensionIsolation } from "./guard.js"
import { fetchSource, sourceIdentity } from "./sources/index.js"
import { digest, fileManifest, packageDefaults, selectSkill, validateRelativePath, validateTargetId } from "./validation.js"
import { InstallationError, terminalStatuses, type InstallationActor, type InstallationTask, type SourceInput, type InstallationPlan } from "./types.js"

const workRoot = path.join(userExtensionsDir, ".install-work")
const leaseFile = path.join(dataDir, "installation-writer.json")
const safeErrors = /^(?:SOURCE_|NETWORK_|CREDENTIAL_|HTTP_CREDENTIAL_|MODEL_INSTALL_|OWNER_AUTHORIZATION_|TARGET_|ARTIFACT_|PLAN_|INVALID_|UNSAFE_|SENSITIVE_|PACKAGE_|DUPLICATE_|UNSUPPORTED_|EMPTY_|UPLOAD_|USE_REPOSITORY_)[A-Z_]+$/
function limits(): typeof packageDefaults & Record<string, number> { return { ...packageDefaults, ...configStore.get().installation as Record<string, number> } }
async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
}
function targetPath(task: InstallationTask): string { return path.join(userExtensionsDir, "skills", validateTargetId(task.plan!.targetId)) }
export function installationSummary(task: InstallationTask) {
  return { installId: task.id, kind: task.kind, status: task.status, currentStep: task.currentStep, reasonCode: task.reasonCode, activation: "disabled", runtimeCheck: "not_run", planId: task.plan?.id, targetId: task.plan?.targetId, result: task.result }
}
export class InstallationInstaller {
  private initialized = false
  private stopped = true
  private readonly dispatched = new Set<string>()
  private readonly scheduled = new Map<string, string>()
  private readonly controllers = new Map<string, AbortController>()
  private initializing: Promise<void> | null = null
  private releaseLease: (() => Promise<void>) | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  init(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    this.initializing ||= this.initialize().finally(() => { this.initializing = null })
    return this.initializing
  }
  private async initialize(): Promise<void> {
    if (this.releaseLease) throw new InstallationError("INSTALLATION_WRITER_ALREADY_ACTIVE")
    this.releaseLease = await acquireInstallationWriterLease(leaseFile)
    try {
      await this.recoverStartup()
      this.initialized = true
    } catch (error) {
      try {
        await this.releaseLease()
        this.releaseLease = null
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], "INSTALLATION_INITIALIZATION_CLEANUP_FAILED")
      }
      throw error
    }
  }
  private async recoverStartup(): Promise<void> {
    resetExtensionIsolation()
    await fs.mkdir(workRoot, { recursive: true })
    for (let task of await installationStore.active()) {
      if (task.operationKind && task.operationKind !== "install") {
        if (!terminalStatuses.has(task.status)) await installationStore.change(task, { status: "needs_attention", reasonCode: "MANAGEMENT_RESULT_UNCERTAIN" }, { type: "management_interrupted" })
        continue
      }
      if (task.phase && task.plan) {
        isolateExtension(task.kind, task.plan.targetId)
        if (task.status === "needs_attention") await installationStore.change(task, { status: "recovering" }, { type: "recovery_started" })
      }
    }
    for (const task of await installationStore.pendingNotifications()) if (task.notification === "sending") await installationStore.change(task, { notification: "uncertain" }, { type: "notification_result_uncertain" })
    await installationStore.cleanupExpiredRecords()
  }
  start(): void {
    if (!this.initialized || !this.stopped) return
    this.stopped = false
    this.poll = setInterval(() => { void this.dispatchPending().catch(() => hostRuntime.logger?.warn?.("[yui-chat] 安装调度失败；任务保留在数据库")) }, 2000)
    this.poll.unref?.()
    void this.dispatchPending()
  }
  async stop(): Promise<void> {
    // A shutdown during startup must wait until recovery or its rollback completes.
    await this.initializing?.catch(() => { /* initialize() already attempts owned-lease cleanup. */ })
    this.stopped = true
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    for (const controller of this.controllers.values()) controller.abort()
    for (const [id, backgroundId] of this.scheduled) if (!this.controllers.has(id)) { backgroundTaskService.cancel(backgroundId); this.scheduled.delete(id); this.dispatched.delete(id) }
    // Wait for safe commit boundaries before giving up the single writer lease.
    await withExtensionLock("installation", "worker", async () => {})
    await this.releaseLease?.()
    this.releaseLease = null
    this.initialized = false
  }
  async submit(input: SourceInput, actor: InstallationActor, intent: "install" | "inspect" = "install", retryOf?: string): Promise<InstallationTask> {
    assertInstallationActor(actor)
    await checkContinuedAuthorization(actor)
    if (!this.initialized) throw new InstallationError("INSTALLER_NOT_READY")
    if (!input || typeof input.source !== "string" || input.source.length > 2048 || !["skill", "mcp"].includes(input.kind)) throw new Error("来源或类型无效")
    if (input.ref && (input.ref.length > 200 || /[\x00-\x1f]/.test(input.ref))) throw new Error("ref 无效")
    if (input.subdir && input.subdir !== ".") validateRelativePath(input.subdir)
    const identity = input.kind === "mcp" ? `mcp:${validateTargetId(input.mcp?.id)}` : sourceIdentity(input).identity
    return withExtensionLock("installation", "submit", async () => {
      const requestKey = installationRequestKey(actor, input, intent)
      const previous = await installationStore.byRequest(requestKey)
      if (previous) return previous
      const active = await installationStore.active()
      if (active.filter(task => !terminalStatuses.has(task.status)).length >= (limits().maxQueue || 10)) throw new InstallationError("INSTALLATION_QUEUE_FULL")
      const id = `ins_${crypto.randomUUID()}`
      const sourceInputId = await credentialStore.put({ purpose: "installation-input", origin: "", scope: id, value: JSON.stringify(input), alias: "安装输入" })
      const task: InstallationTask = { id, version: 1, intent, kind: input.kind, origin: actor, actor, requestKey, sourceIdentity: identity, sourceInputId, credentialId: input.credentialId, status: "inspecting", currentStep: "resolve_source", attempt: 0, createdAt: Date.now(), updatedAt: Date.now(), retryOf, event: { type: "accepted", actor } }
      await installationStore.create(task)
      await this.dispatchPending()
      return task
    })
  }
  async get(id: string, actor: InstallationActor): Promise<InstallationTask> {
    assertInstallationActor(actor)
    const task = await installationStore.get(id)
    if (actor.entry !== "web" && (actor.id !== task.origin.id || actor.botId !== task.origin.botId || actor.groupId !== task.origin.groupId)) throw new InstallationError("INSTALLATION_ACCESS_DENIED")
    return task
  }
  async cancel(id: string, actor: InstallationActor): Promise<InstallationTask> {
    const task = await this.get(id, actor)
    if (terminalStatuses.has(task.status)) return task
    const result = await withExtensionLock("task", id, async () => {
      const current = await this.get(id, actor)
      return installationStore.change(current, { cancelRequested: true, ...(!current.phase && !this.controllers.has(id) ? { status: "canceled" as const, finishedAt: Date.now(), currentStep: "canceled", notification: current.origin.entry === "web" ? undefined : "pending" as const } : {}) }, { type: "cancel_requested", actor })
    })
    this.controllers.get(id)?.abort()
    if (result.status === "canceled") {
      const scheduled = this.scheduled.get(id)
      if (scheduled) backgroundTaskService.cancel(scheduled)
      this.scheduled.delete(id); this.dispatched.delete(id)
      await this.cleanup(result); await this.notify(result)
    }
    await this.dispatchPending()
    return result
  }
  async inputs(id: string, input: Record<string, unknown>, actor: InstallationActor): Promise<InstallationTask> {
    if (actor.entry !== "web") throw new InstallationError("WEB_INPUT_REQUIRED")
    await this.get(id, actor)
    if (Object.keys(input).some(key => !["expectedVersion", "subdir", "credentialId"].includes(key))) throw new Error("只允许选择目录和凭据绑定")
    return withExtensionLock("task", id, async () => {
      const task = await this.get(id, actor)
      if (task.version !== input.expectedVersion || !["awaiting_input", "awaiting_confirmation"].includes(task.status) || task.phase) throw new Error("任务已改变或不允许补充输入")
      const original = await this.input(task)
      if (input.subdir !== undefined) {
        if (typeof input.subdir !== "string" || !task.candidates?.includes(input.subdir)) throw new Error("候选目录无效")
        original.subdir = input.subdir
      }
      if (input.credentialId !== undefined) {
        if (typeof input.credentialId !== "string") throw new Error("凭据引用无效")
        const identity = sourceIdentity(original)
        await credentialStore.resolve(input.credentialId, "repository-read", identity.origin, identity.identity)
        original.credentialId = input.credentialId
      }
      const sourceInputId = await credentialStore.put({ purpose: "installation-input", origin: "", scope: id, value: JSON.stringify(original) })
      const next = await installationStore.change(task, { actor, sourceInputId, credentialId: original.credentialId, status: "inspecting", plan: undefined, reasonCode: undefined }, { type: "inputs_updated", actor })
      await this.dispatchPending()
      return next
    })
  }
  async apply(planId: string, actor: InstallationActor): Promise<InstallationTask> {
    assertInstallationActor(actor)
    const task = (await installationStore.active()).find(item => item.plan?.id === planId)
    if (!task) throw new InstallationError("PLAN_NOT_FOUND")
    await this.get(task.id, actor)
    return withExtensionLock("task", task.id, async () => {
      const current = await this.get(task.id, actor)
      if (current.plan?.id !== planId || current.status !== "awaiting_confirmation") throw new InstallationError("PLAN_CHANGED")
      const next = await installationStore.change(current, { status: "queued", actor }, { type: "plan_authorized", actor, planId })
      await this.dispatchPending()
      return next
    })
  }
  async recover(id: string, actor: InstallationActor): Promise<InstallationTask> {
    if (actor.entry !== "web") throw new InstallationError("WEB_INPUT_REQUIRED")
    return withExtensionLock("task", id, async () => {
      const task = await this.get(id, actor)
      if (task.status !== "needs_attention" || !task.phase || !task.plan || task.operationKind) throw new InstallationError("UNSAFE_RECOVERY")
      const next = await installationStore.change(task, { status: "recovering", actor }, { type: "recovery_authorized", actor })
      await this.dispatchPending()
      return next
    })
  }
  async retry(id: string, actor: InstallationActor): Promise<InstallationTask> {
    const previous = await this.get(id, actor)
    if (!["failed", "expired"].includes(previous.status) || previous.phase) throw new InstallationError("UNSAFE_RETRY")
    return this.submit(await this.input(previous), actor, previous.intent, id)
  }
  private async input(task: InstallationTask): Promise<SourceInput> {
    const result = await credentialStore.resolve(task.sourceInputId, "installation-input", "", task.id)
    return JSON.parse(result.value) as SourceInput
  }
  private async dispatchPending(): Promise<void> {
    if (this.stopped) return
    for (const task of await installationStore.pendingNotifications()) if (task.notification === "pending") await this.notify(task)
    for (let task of await installationStore.active()) {
      if (!task.phase && !this.dispatched.has(task.id) && !terminalStatuses.has(task.status) && (task.plan && task.plan.expiresAt < Date.now() || !task.plan && Date.now() - task.updatedAt > 86400000)) {
        task = await this.finish(task, "expired")
        await this.cleanup(task)
        await this.notify(task)
        continue
      }
      if (task.operationKind && task.operationKind !== "install" || task.status === "needs_attention" || this.dispatched.has(task.id)) continue
      if (!task.cancelRequested && ["awaiting_input", "awaiting_confirmation"].includes(task.status)) continue
      this.dispatched.add(task.id)
      try {
        const background = backgroundTaskService.submit({ name: task.id, queueKey: "extension-installation", limitsProvider: () => ({ enabled: true, maxConcurrent: 1, maxQueue: 10, timeoutMs: 180000, retentionMs: 60000 }), execute: () => withExtensionLock("installation", "worker", () => this.process(task.id)), onComplete: () => { this.dispatched.delete(task.id); this.scheduled.delete(task.id) } })
        this.scheduled.set(task.id, background.id)
      } catch { this.dispatched.delete(task.id) /* Persistent inspecting/queued records will be retried by the next tick. */ }
    }
  }
  private async process(id: string): Promise<void> {
    if (this.stopped) return
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const timeout = setTimeout(() => controller.abort(), 180000)
    try {
      let task = await installationStore.get(id)
      if (terminalStatuses.has(task.status)) return
      if (task.cancelRequested && !task.phase) { await this.finish(task, "canceled"); return }
      if (task.phase) { await this.commit(task, true); return }
      await checkContinuedAuthorization(task.actor)
      if (task.status === "queued" && task.plan) { await this.commit(task); return }
      task = await installationStore.change(task, { attempt: task.attempt + 1, status: "inspecting", currentStep: "fetch_and_validate" }, { type: "prepare_started" })
      const input = await this.input(task)
      input.credentialId ||= task.credentialId
      const workspace = path.join(workRoot, id)
      await fs.rm(workspace, { recursive: true, force: true })
      await fs.mkdir(workspace, { recursive: true })
      let resolvedCommit: string | undefined, credentialVersion: number | undefined, targetId: string
      if (task.kind === "skill") {
        const source = await fetchSource(input, limits(), controller.signal)
        const selected = selectSkill(source.files, input.subdir)
        if (!selected.targetId) { await installationStore.change(await installationStore.get(id), { status: "awaiting_input", candidates: selected.candidates, reasonCode: "MULTIPLE_CANDIDATES" }, { type: "candidate_selection_required" }); return }
        targetId = selected.targetId
        resolvedCommit = source.resolvedCommit
        credentialVersion = source.credentialVersion
        if (source.credentialId) task = await installationStore.change(await installationStore.get(id), { credentialId: source.credentialId }, { type: "bound_credential_selected" })
        for (const [file, bytes] of selected.files) {
          await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true })
          await fs.writeFile(path.join(workspace, file), bytes)
        }
      } else {
        const config = input.mcp || {}
        if (!config.url || !["sse", "streamableHttp"].includes(String(config.transport)) || config.command || config.env || config.headers || String(config.url).includes("${env:")) throw new InstallationError("UNSUPPORTED_MCP_CONFIG_USE_WEB_BINDINGS")
        const url = new URL(String(config.url))
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new InstallationError("SOURCE_URL_INVALID")
        targetId = validateTargetId(config.id)
        await fs.writeFile(path.join(workspace, "mcp.json"), JSON.stringify({ url: url.toString(), transport: config.transport, enabled: false, allowedTools: [], installationId: id }))
      }
      const files = await fileManifest(workspace, limits())
      const plan: InstallationPlan = { id: `plan_${crypto.randomUUID()}`, version: task.version, hash: "", targetId, digest: digest(JSON.stringify(files)), files, resolvedCommit, credentialVersion, createdAt: Date.now(), expiresAt: Date.now() + (limits().planTtlMs || 1800000) }
      plan.hash = digest(JSON.stringify(plan))
      task = await installationStore.get(id)
      if (task.cancelRequested) { await this.finish(task, "canceled"); return }
      if (controller.signal.aborted) throw new InstallationError("SOURCE_PREPARATION_INTERRUPTED", true)
      task = await installationStore.change(task, { plan, status: task.intent === "inspect" ? "awaiting_confirmation" : "queued", currentStep: "plan_ready" }, { type: "plan_created", planId: plan.id })
      if (task.intent === "install") await this.commit(task)
    } catch (error) {
      const task = await installationStore.get(id)
      if (terminalStatuses.has(task.status)) return
      const raw = error instanceof InstallationError ? error.code : error instanceof Error ? error.message : ""
      const code = safeErrors.test(raw) ? raw : "INSTALLATION_FAILED"
      if (!task.phase && !task.cancelRequested && error instanceof InstallationError && error.retryable && task.attempt < 2 && !this.stopped) {
        await installationStore.change(task, { status: "inspecting", reasonCode: code }, { type: "attempt_failed", errorCode: code, retryable: true })
        return
      }
      const waiting = /CREDENTIAL|GRANT|MODEL_INSTALL_DISABLED|OWNER_AUTHORIZATION|TARGET_EXISTS|SOURCE_AUTH_FAILED|SOURCE_NOT_FOUND_OR_NOT_AUTHORIZED/.test(code)
      if (this.stopped && !task.phase && !task.cancelRequested) { await installationStore.change(task, { status: "inspecting" }, { type: "preparation_interrupted" }); return }
      await installationStore.change(task, { status: task.phase ? "needs_attention" : task.cancelRequested ? "canceled" : waiting ? "awaiting_input" : "failed", reasonCode: code, finishedAt: waiting || task.phase ? undefined : Date.now() }, { type: "operation_stopped", errorCode: code, sideEffectStage: task.phase || "none" })
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(id)
      const task = await installationStore.get(id)
      if (terminalStatuses.has(task.status) && task.status !== "needs_attention") {
        await this.cleanup(task)
        await this.notify(task)
      }
    }
  }
  private async commit(initial: InstallationTask, recovering = false): Promise<void> {
    const plan = initial.plan!
    await withExtensionLock(initial.kind, plan.targetId, async () => {
      let task = await installationStore.get(initial.id)
      const workspace = path.join(workRoot, task.id)
      if (!task.phase) {
        await checkContinuedAuthorization(task.actor)
        if (task.cancelRequested) { await this.finish(task, "canceled"); return }
        if (Date.now() > plan.expiresAt) { await this.finish(task, "expired"); return }
        if (task.credentialId) {
          const input = await this.input(task)
          const source = sourceIdentity(input)
          const secret = await credentialStore.resolve(task.credentialId, "repository-read", source.origin, source.identity)
          if (secret.version !== plan.credentialVersion) throw new InstallationError("CREDENTIAL_CHANGED")
        }
        if (digest(JSON.stringify(await fileManifest(workspace, limits()))) !== plan.digest) throw new InstallationError("ARTIFACT_CHANGED")
        const mcpServers = configStore.get().mcp?.servers as Record<string, unknown> || {}
        if (task.kind === "skill" ? await exists(targetPath(task)) : Object.hasOwn(mcpServers, plan.targetId)) throw new InstallationError("TARGET_EXISTS")
        task = await installationStore.change(task, { status: "installing", phase: "intent", currentStep: "protect_target" }, { type: "commit_intent" })
      }
      isolateExtension(task.kind, plan.targetId)
      if (task.kind === "skill") {
        await configStore.update(config => {
          const skills = config.skills as Record<string, any>
          skills.disabled = [...new Set([...(skills.disabled || []), plan.targetId])]
          const boundary = (config.tools as Record<string, any>).boundaryAccess
          boundary.skillPackages ||= {}
          boundary.skillPackages[plan.targetId] = { roles: { user: false, groupAdmin: false, groupOwner: false, master: true } }
        })
        if (task.phase === "intent") task = await installationStore.change(task, { phase: "protected", currentStep: "publish_files" }, { type: "target_protected" })
        const target = targetPath(task)
        if (await exists(target)) {
          if (!recovering || digest(JSON.stringify(await fileManifest(target, limits()))) !== plan.digest) throw new InstallationError("TARGET_STATE_UNCERTAIN")
        } else {
          if (digest(JSON.stringify(await fileManifest(workspace, limits()))) !== plan.digest) throw new InstallationError("ARTIFACT_CHANGED")
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.rename(workspace, target)
        }
        task = await installationStore.change(task, { phase: "published", currentStep: "record_configuration" }, { type: "files_published" })
        await configStore.update(config => {
          const skills = config.skills as Record<string, any>
          skills.sources[plan.targetId] = { installationId: task.id, sourceIdentity: task.sourceIdentity, digest: plan.digest, private: Boolean(task.credentialId), resolvedCommit: plan.resolvedCommit || "" }
        })
      } else {
        if (digest(JSON.stringify(await fileManifest(workspace, limits()))) !== plan.digest) throw new InstallationError("ARTIFACT_CHANGED")
        const server = JSON.parse(await fs.readFile(path.join(workspace, "mcp.json"), "utf8"))
        await configStore.update(config => {
          const mcp = config.mcp as Record<string, any>
          const existing = mcp.servers[plan.targetId]
          if (existing && existing.installationId !== task.id) throw new InstallationError("TARGET_EXISTS")
          mcp.servers[plan.targetId] = { ...server, enabled: false, allowedTools: [] }
          const boundary = (config.tools as Record<string, any>).boundaryAccess
          boundary.mcpServers ||= {}
          boundary.mcpServers[plan.targetId] = { roles: { user: false, groupAdmin: false, groupOwner: false, master: true } }
        })
      }
      task = await installationStore.change(task, { phase: "configured", currentStep: "record_receipt" }, { type: "configuration_committed" })
      await installationStore.saveReceipt(task, task.kind === "mcp" ? JSON.parse(await fs.readFile(path.join(workspace, "mcp.json"), "utf8")) : undefined)
      if (task.kind === "skill") {
        if (digest(JSON.stringify(await fileManifest(targetPath(task), limits()))) !== plan.digest || !(configStore.get().skills as Record<string, any>).disabled.includes(plan.targetId)) throw new InstallationError("TARGET_STATE_UNCERTAIN")
        await skillManager.refresh()
      }
      task = await this.finish(task, "succeeded", { installed: true, targetId: plan.targetId, activation: "disabled", staticValidation: "passed", runtimeCheck: "not_run", cancelRequestedDuringCommit: task.cancelRequested === true })
      isolateExtension(task.kind, plan.targetId, false)
    })
  }
  private async finish(task: InstallationTask, status: InstallationTask["status"], result?: Record<string, unknown>): Promise<InstallationTask> {
    return installationStore.change(task, { status, result, currentStep: status, finishedAt: Date.now(), notification: task.origin.entry === "web" ? undefined : "pending" }, { type: status })
  }
  private async cleanup(task: InstallationTask): Promise<void> {
    try {
      await fs.rm(path.join(workRoot, task.id), { recursive: true, force: true })
      await fs.rm(path.join(cacheDir, "extension-install", task.id), { recursive: true, force: true })
    } catch { await installationStore.change(await installationStore.get(task.id), {}, { type: "cleanup_warning" }) }
  }
  private async notify(task: InstallationTask): Promise<void> {
    if (task.origin.entry === "web") return
    await withExtensionLock("notification", task.id, async () => {
    task = await installationStore.get(task.id)
    if (task.notification !== "pending") return
    task = await installationStore.change(task, { notification: "sending" }, { type: "notification_intent" })
    try {
      const bot = hostRuntime.bot?.[task.origin.botId || ""] as { pickGroup?: (id: number) => { sendMsg: (text: string) => Promise<unknown> }; pickUser?: (id: number) => { sendMsg: (text: string) => Promise<unknown> } } | undefined
      const destination = task.origin.groupId ? bot?.pickGroup?.(Number(task.origin.groupId)) : bot?.pickUser?.(Number(task.origin.id))
      if (!destination) throw new Error("notification target unavailable")
      await destination.sendMsg(`扩展安装任务：${task.id}\n状态：${task.status === "succeeded" ? "已安装，未启用" : task.status}\n运行验证：未执行\n请在 Web 安装记录中查看。`)
      await installationStore.change(await installationStore.get(task.id), { notification: "sent" }, { type: "notification_sent" })
    } catch { await installationStore.change(await installationStore.get(task.id), { notification: "failed" }, { type: "notification_failed" }) }
    })
  }
}
export const installationInstaller = new InstallationInstaller()
