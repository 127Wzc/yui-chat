import { commandObserver } from "../../knowledge/command-observer.js"
import { recentContextStore } from "../chat/recent-context.js"
import { normalizeEventScope } from "../message/event-scope.js"
import { handleFirstPersonMessage } from "./first-person-service.js"
import type { UnknownRecord } from "../message/types.js"

/** 将消息记录和第一人称旁路处理注册到指令观察器的统一钩子。 */
export function registerFirstPersonListener(): void {
  commandObserver.registerAfterHandler(async (event: unknown) => {
    const context = normalizeEventScope(event as UnknownRecord)
    recentContextStore.record(context)
    await handleFirstPersonMessage(context, { logPrefix: "[yui-chat] 第一人称旁路回应失败" })
  })
}
