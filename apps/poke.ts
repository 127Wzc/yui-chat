import { handleFirstPersonPokeEvent } from "../core/persona/first-person-service.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import type { HostEvent } from "../core/runtime/host-runtime.js"

/** 第一人称戳一戳的宿主适配基类；只负责把 notice 事件交给人格触发服务。 */
class YuiChatPokeBase extends hostRuntime.Plugin {
  declare e: HostEvent

  constructor(event: string, name: string) {
    super({
      name,
      dsc: "Yui Chat 第一人称戳一戳回应",
      event,
      priority: 1139,
    })
  }

  async accept(): Promise<boolean> {
    return handleFirstPersonPokeEvent(this.e, { logPrefix: "[yui-chat] 第一人称戳一戳回应失败" })
  }
}

export class YuiChatGroupPoke extends YuiChatPokeBase {
  constructor() {
    super("notice.group.poke", "Yui Chat 群戳一戳")
  }
}

export class YuiChatFriendPoke extends YuiChatPokeBase {
  constructor() {
    super("notice.friend.poke", "Yui Chat 好友戳一戳")
  }
}

export class YuiChatNotifyPoke extends YuiChatPokeBase {
  constructor() {
    super("notice.notify.poke", "Yui Chat notify 戳一戳")
  }
}
