export type InstallationKind = "skill" | "mcp"
export type InstallationStatus = "inspecting" | "awaiting_input" | "awaiting_confirmation" | "queued" | "installing" | "recovering" | "succeeded" | "failed" | "needs_attention" | "canceled" | "expired"
export type InstallationEntry = "model" | "owner_command" | "web"
export interface InstallationActor {
  entry: InstallationEntry
  id: string
  requestId: string
  expiresAt?: number
  botId?: string
  groupId?: string
}
export interface SourceInput {
  source: string
  kind: InstallationKind
  ref?: string
  subdir?: string
  provider?: "github" | "gitlab" | "gitee" | "archive" | "upload"
  credentialId?: string
  upload?: string
  mcp?: Record<string, unknown>
}
export interface InstallationPlan {
  id: string
  version: number
  hash: string
  targetId: string
  digest: string
  resolvedCommit?: string
  files: Array<{ path: string; bytes: number; digest: string }>
  createdAt: number
  expiresAt: number
  credentialVersion?: number
}
export interface InstallationTask {
  id: string
  operationKind?: "install" | "discover" | "activate" | "disable" | "update" | "uninstall"
  relatedInstallId?: string
  version: number
  intent: "install" | "inspect"
  origin: InstallationActor
  actor: InstallationActor
  requestKey: string
  kind: InstallationKind
  sourceIdentity: string
  sourceInputId: string
  credentialId?: string
  status: InstallationStatus
  currentStep: string
  plan?: InstallationPlan
  candidates?: string[]
  subdir?: string
  phase?: "intent" | "protected" | "published" | "configured"
  cancelRequested?: boolean
  attempt: number
  retryOf?: string
  createdAt: number
  updatedAt: number
  finishedAt?: number
  reasonCode?: string
  result?: Record<string, unknown>
  notification?: "pending" | "sending" | "sent" | "failed" | "uncertain"
  event: Record<string, unknown>
}
export const terminalStatuses = new Set<InstallationStatus>(["succeeded", "failed", "needs_attention", "canceled", "expired"])
export class InstallationError extends Error {
  constructor(public code: string, public retryable = false) { super(code) }
}
