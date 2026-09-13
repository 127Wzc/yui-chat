import { configStore, yunzaiRoot } from "../config/store.js"
import { actionCommand, actionRule, matchAction, parseActions, type ActionDefinition } from "../core/actions/contract.js"
import { actionAccess, runAction } from "../core/actions/execution.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import type { HostCommandEntry } from "../core/runtime/host-command-registry.js"
import { isGroupEvent } from "../core/message/event-scope.js"
import { pluginCommand, stripPluginCommand } from "../core/message/command-prefixes.js"
import type { RuntimeConfigObject } from "../config/types.js"

const consumed = new WeakSet<object>()
const messageIds = new Map<string, number>()
function claim(event: Record<string, unknown>): boolean {
  if (consumed.has(event)) return false
  const now = Date.now()
  for (const [key, time] of messageIds) if (now - time > 120000) messageIds.delete(key)
  const id = event.message_id ? `${event.self_id}:${event.group_id || "private"}:${event.user_id}:${event.message_id}` : ""
  if (id && messageIds.has(id)) return false
  consumed.add(event)
  if (id) messageIds.set(id, now)
  if (messageIds.size > 5000) messageIds.delete(messageIds.keys().next().value as string)
  return true
}

export function createActionEntries(config: RuntimeConfigObject): HostCommandEntry[] {
  const actions = parseActions(config.actions)
  if (!actions.enabled) return []
  return Object.values(actions.items).filter(item => item.enabled).map(definition => {
    class ActionCommand extends hostRuntime.Plugin {
      constructor() {
        super({ name: `Yui Chat · ${definition.name}`, dsc: definition.description, event: "message", priority: definition.priority,
          rule: definition.stage === "rule" ? [{ reg: new RegExp(actionRule(definition)), fnc: "run", log: false }] : [],
        })
      }
      async run() {
        const config = configStore.get()
        const current = parseActions(config.actions).items[definition.id]
        if (!current || !current.enabled || !parseActions(config.actions).enabled) return false
        if ((current.scope === "group" && !isGroupEvent(this.e)) || (current.scope === "private" && isGroupEvent(this.e))) return false
        const input = matchAction(current, this.e.msg)
        if (input === null) return false
        if (!claim(this.e)) return true
        this.e.__yuiChatReplied = true
        try {
          const result = await runAction(current, input, this.e)
          if (!result.delivery && result.message) await this.reply(result.message, true)
          else if (result.delivery && ["failed", "denied", "ambiguous"].includes(String((result.delivery as Record<string, unknown>).status))) await this.reply("动作已执行，但结果投递失败。", true)
        } catch (error) {
          if (error && typeof error === "object" && "silent" in error && error.silent === true) return true
          await this.reply(`动作未完成：${error instanceof Error ? error.message : String(error)}`, true)
        }
        return true
      }
    }
    if (definition.stage === "accept") Object.assign(ActionCommand.prototype, {
      async accept(this: ActionCommand) { return await this.run() ? "return" : false },
    })
    const plugin = new ActionCommand() as unknown as Record<string, unknown>
    return { plugin, class: ActionCommand, key: "yui-chat", name: String(plugin.name), priority: definition.priority }
  })
}

export async function applyActionCommands(config: RuntimeConfigObject) {
  return hostRuntime.applyActionEntries(yunzaiRoot, createActionEntries(config))
}

export function actionHelp(event: Record<string, unknown>): string {
  const config = configStore.get()
  const actions = parseActions(config.actions)
  const detail = String(event.msg || "").startsWith(pluginCommand("指令说明"))
  const query = stripPluginCommand(event.msg, detail ? "指令说明" : "快捷指令").trim().toLowerCase()
  const categoryName = (item: ActionDefinition) => actions.categories.find(category => category.id === item.categoryId)?.name || "未分类"
  const available = Object.values(actions.items).filter(item => actionAccess(item, event, config).allowed)
  const items = available.filter(item => !query || [item.name, item.command, ...item.aliases, ...item.tags, item.description, categoryName(item)].join(" ").toLowerCase().includes(query))
  if (!items.length) return "没有找到当前可用的动作。"
  if (detail && items.length === 1) {
    const item = items[0]
    return `${item.name}\n${item.description}\n指令：${actionCommand(item)}${item.input.mode === "text" ? " [补充要求]" : " [参数=值]"}\n${item.input.requireImage ? "需要发送或引用图片。\n" : ""}${item.overridable.length ? `可填写：${item.overridable.join("、")}\n` : ""}分类：${categoryName(item)}`
  }
  return `动作中心（${items.length}）\n${items.slice(0, 40).map(item => `${actionCommand(item)} · ${item.name}［${categoryName(item)}］`).join("\n")}\n用 ${pluginCommand("指令说明")} <名称> 查看用法。`
}

/** 每次宿主重新加载插件时重建动作条目；自身不注册消息规则。 */
export class YuiActionBootstrap extends hostRuntime.Plugin {
  constructor() { super({ name: "Yui Chat Actions", event: "message", priority: 1137, rule: [] }) }
  async init() {
    await applyActionCommands(configStore.get())
    return "return"
  }
}
