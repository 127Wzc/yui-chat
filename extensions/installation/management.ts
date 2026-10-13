import crypto from "node:crypto"
import { installationStore } from "./store.js"
import { assertInstallationActor } from "./authorization.js"
import type { InstallationActor, InstallationKind, InstallationTask } from "./types.js"

/** Separate durable lifecycle operations do not rewrite the installation's terminal result. */
export async function recordExtensionManagement<T>(kind: InstallationKind, targetId: string, operationKind: "discover" | "activate" | "disable" | "update" | "uninstall", actor: InstallationActor, work: () => Promise<T>): Promise<T> {
  assertInstallationActor(actor)
  const receipt = await installationStore.receipt(kind, targetId)
  if (!receipt) return work()
  const id = `op_${crypto.randomUUID()}`
  let task: InstallationTask = { id, version: 1, intent: "inspect", operationKind, relatedInstallId: String(receipt.installationId), kind, origin: actor, actor, sourceIdentity: String(receipt.sourceIdentity), sourceInputId: "", requestKey: id, status: "installing", currentStep: operationKind, attempt: 1, createdAt: Date.now(), updatedAt: Date.now(), event: { type: "management_intent", actor, targetId } }
  await installationStore.create(task)
  try {
    const result = await work()
    task = await installationStore.change(task, { status: "succeeded", finishedAt: Date.now(), result: { targetId, operationKind } }, { type: "management_succeeded" })
    return result
  } catch (error) {
    await installationStore.change(task, { status: "failed", reasonCode: "MANAGEMENT_FAILED", finishedAt: Date.now() }, { type: "management_failed" })
    throw error
  }
}
