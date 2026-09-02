import { chatService } from "../core/chat/chat-service.js"
import { commandObserver } from "../knowledge/command-observer.js"
import { configStore } from "../config/store.js"
import { preflight, releasePreflight, sendConfirm } from "../core/chat/response-pipeline.js"
import { sendChatOutput } from "../core/chat/output-service.js"
import { userSettingsStore } from "../user/settings.js"
import { handleFirstPersonMessage } from "../core/persona/first-person-service.js"
import { recentContextStore } from "../core/chat/recent-context.js"
import { endAllConversationsRuntime } from "../core/runtime/lifecycle.js"
import { cleanupMediaCache } from "../core/media/media-cache.js"
import { buildDiagnostics } from "../core/runtime/diagnostics.js"
import { buildWebAddresses, issueQuickLogin } from "../web/http/auth.js"
import {
  cleanupRenderCache,
  renderCommandHelp,
  renderConversationList,
  renderHelpMenu,
} from "../core/rendering/render-service.js"
import { buildNextHelpMenu } from "./help-menu.js"
import { deliverRenderedImage } from "../core/rendering/render-delivery.js"
import { listMutedScopes, muteScope, parseDuration, unmuteScope } from "../core/chat/access-control.js"
import { sendInitiativeGreeting } from "../core/persona/initiative-greeting.js"
import { formatScheduleTaskList, scheduleTaskService } from "../core/scheduling/schedule-task-service.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import type { HostEvent } from "../core/runtime/host-runtime.js"
import type { UnknownRecord } from "../core/message/types.js"
import { runHtmlScreenshotCommand, runRenderImageCommand, runUrlScreenshotCommand } from "./commands/render.js"
import { runToolParameterCommand, runToolTestCommand } from "./commands/tool-test.js"
import { runFilterParameterCommand, runFilterTestCommand } from "./commands/filter-test.js"
import {
  matchPluginCommand,
  pluginCommand,
  pluginCommandRule,
  stripPluginCommand,
} from "../core/message/command-prefixes.js"

interface PersonaTriggerConfig extends UnknownRecord {
  ambient?: UnknownRecord
  poke?: UnknownRecord
  probabilityPercent?: number
  cooldownMs?: number
  groupCooldownMs?: number
  disabledGroupIds?: string[]
}

interface PersonaConfig extends UnknownRecord {
  firstPerson?: string
  assistantLabel?: string
  aliases?: string[]
  enabled?: boolean
  respondToFirstPersonCall?: boolean
  respondToAt?: boolean
  trigger?: PersonaTriggerConfig
}

interface AppConfig extends UnknownRecord {
  persona: PersonaConfig
  response: UnknownRecord
  web: UnknownRecord
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.filter(item => Boolean(item) && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[]
    : []
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : text(error)
}

function appConfig(value: unknown): AppConfig {
  const root = record(value)
  return {
    ...root,
    persona: record(root.persona) as PersonaConfig,
    response: record(root.response),
    web: record(root.web),
  }
}

function renderConfig(config: AppConfig): UnknownRecord {
  return record(config.response.render)
}

async function updateConfig(mutator: (config: AppConfig) => void): Promise<AppConfig> {
  const saved = await configStore.update(current => {
    const draft = appConfig(current)
    mutator(draft)
    return draft as unknown as import("../config/types.js").RuntimeConfigObject
  })
  return appConfig(saved)
}

function targetUserIds(e: HostEvent = {}) {
  const ids = new Set<string>()
  if (Array.isArray(e.at)) for (const id of e.at) ids.add(String(id))
  if (e.at && !Array.isArray(e.at) && typeof e.at !== "boolean") ids.add(String(e.at))
  for (const segment of Array.isArray(e.message) ? e.message : []) {
    const value = record(segment)
    const data = record(value.data || segment)
    if ((text(value.type || data.type) === "at") && data.qq && String(data.qq) !== "all") ids.add(String(data.qq))
  }
  return [...ids].filter(Boolean)
}

export class YuiChat extends hostRuntime.Plugin {
  constructor() {
    super({
      name: "Yui Chat",
      dsc: "隔离版 AI 聊天、指令检索与新 Web 面板",
      event: "message",
      priority: 1139,
      rule: [
        { reg: pluginCommandRule("chat([\\s\\S]*)"), fnc: "chat" },
        { reg: pluginCommandRule("help([\\s\\S]*)"), fnc: "help" },
        { reg: pluginCommandRule("(?:全部|所有)定时任务(?:列表)?"), fnc: "allScheduleTaskList", permission: "master" },
        { reg: pluginCommandRule("(?:我的)?定时任务(?:列表)?"), fnc: "scheduleTaskList" },
        { reg: pluginCommandRule("对话列表"), fnc: "conversationList", permission: "master" },
        { reg: pluginCommandRule("(结束|新开|摧毁|毁灭|完结)对话([\\s\\S]*)"), fnc: "clear" },
        { reg: pluginCommandRule("(结束|新开|摧毁|毁灭|完结)全部(模式|模型)?对话"), fnc: "endAllConversations", permission: "master" },
        { reg: pluginCommandRule("(面板|登录|登陆)"), fnc: "webLogin", permission: "master" },
        { reg: pluginCommandRule("诊断"), fnc: "diagnostics", permission: "master" },
        { reg: pluginCommandRule("测试工具(?:\\s+[a-zA-Z0-9_.-]+)?(?:\\s+[\\s\\S]*)?"), fnc: "testToolCommand", permission: "master" },
        { reg: pluginCommandRule("工具参数(?:\\s+[a-zA-Z0-9_.-]+)?"), fnc: "toolParameterCommand", permission: "master" },
        { reg: pluginCommandRule("测试过滤器(?:\\s+[a-zA-Z0-9_.-]+)?(?:\\s+[\\s\\S]*)?"), fnc: "testFilterCommand", permission: "master" },
        { reg: pluginCommandRule("过滤器参数(?:\\s+[a-zA-Z0-9_.-]+)?"), fnc: "filterParameterCommand", permission: "master" },
        { reg: pluginCommandRule("渲染(帮助菜单|菜单|帮助|能力|工具|MarkdownHTML|markdownhtml|Markdown|markdown|思维导图HTML|思维导图html|MarkmapHTML|markmaphtml|思维导图|词云|动态|面板)([\\s\\S]*)"), fnc: "renderImageCommand", permission: "master" },
        { reg: pluginCommandRule("截图URL\\s+([\\s\\S]+)"), fnc: "screenshotUrl", permission: "master" },
        { reg: pluginCommandRule("截图HTML\\s+([\\s\\S]+)"), fnc: "screenshotHtml", permission: "master" },
        { reg: pluginCommandRule("(本群|全局)?(群\\d+)?(闭嘴|关机|休眠|下班)([\\s\\S]*)"), fnc: "muteChat", permission: "master" },
        { reg: pluginCommandRule("(本群|全局)?(群\\d+)?(张嘴|开口|说话|上班)"), fnc: "unmuteChat", permission: "master" },
        { reg: pluginCommandRule("查看?(闭嘴|关机|休眠|下班)列表?"), fnc: "muteList", permission: "master" },
        { reg: pluginCommandRule("清理(全部)?缓存"), fnc: "cleanupCache", permission: "master" },
        { reg: pluginCommandRule("工具权限(开启|关闭)?"), fnc: "toolPermissionGroups", permission: "master" },
        { reg: pluginCommandRule("第一人称(概率|冷却|禁用本群|启用本群|随机开启|随机关闭|旁路开启|旁路关闭|戳一戳开启|戳一戳关闭)([\\s\\S]*)"), fnc: "firstPersonTriggerSettings", permission: "master" },
        { reg: pluginCommandRule("第一人称(开启|关闭)?"), fnc: "firstPersonSettings", permission: "master" },
        { reg: pluginCommandRule("打招呼(\\d+)?"), fnc: "initiativeGreeting", permission: "master" },
        { reg: pluginCommandRule("设置(AI|ai)?第一人称(称谓)?([\\s\\S]*)"), fnc: "setFirstPerson", permission: "master" },
        { reg: pluginCommandRule("(文本|图片|语音)模式"), fnc: "switchMode" },
        { reg: "^[\\s\\S]*$", fnc: "firstPersonCall", log: false },
      ],
    })
  }

  async chat() {
    const prompt = stripPluginCommand(this.e.msg, "chat")
    if (!prompt) return this.reply(`请输入要发送给 AI 的内容，例如：${pluginCommand("chat")} 帮我介绍一下当前可用指令`, true)
    const config = appConfig(await configStore.load())
    const gate = await preflight(this.e, prompt, config)
    if (!gate.ok) return gate.silent ? false : this.reply(gate.message, true)
    try {
      recentContextStore.record(this.e)
      await sendConfirm(this.e, config)
      const result = await chatService.send(this.e, prompt)
      this.e.__yuiChatReplied = true
      return this.sendResult(result, config)
    } catch (err) {
      hostRuntime.logger?.error?.("[yui-chat] 对话失败", err)
      return this.reply(`Yui Chat 对话失败：${errorMessage(err)}`, true)
    } finally {
      releasePreflight(gate)
    }
  }

  async sendResult(result: unknown, config: AppConfig) {
    return sendChatOutput(this.e, result, config)
  }

  async testToolCommand() {
    return runToolTestCommand({ e: this.e, reply: (...args: unknown[]) => this.reply(...args) })
  }

  async toolParameterCommand() {
    return runToolParameterCommand({ e: this.e, reply: (...args: unknown[]) => this.reply(...args) })
  }

  async testFilterCommand() {
    return runFilterTestCommand({ e: this.e, reply: (...args: unknown[]) => this.reply(...args) })
  }

  async filterParameterCommand() {
    return runFilterParameterCommand({ e: this.e, reply: (...args: unknown[]) => this.reply(...args) })
  }

  async help() {
    const query = stripPluginCommand(this.e.msg, "help")
    const config = appConfig(await configStore.load())
    if (!query) {
      const stats = commandObserver.stats()
      if (renderConfig(config).helpAsImage !== false) {
        try {
          const image = await renderHelpMenu(buildNextHelpMenu(config), config)
          return deliverRenderedImage(image, { e: this.e, config }, { label: "帮助菜单图片" })
        } catch (err) {
          hostRuntime.logger?.warn?.("[yui-chat] 指令帮助图片渲染失败，回退文本", err)
        }
      }
      return this.reply(
        `Yui Chat 可用命令：\n${pluginCommand("chat")} + 内容\n${pluginCommand("help")} + 你想做的事\n${pluginCommand("定时任务")}\n${pluginCommand("结束对话")}\n${pluginCommand("面板")}\n\n指令知识库：${stats.commands} 条指令，${stats.events} 条触发记录`,
        true,
      )
    }
    const recommendation = record(commandObserver.recommendCommands(query, { limit: 8 }))
    const matches = records(recommendation.results)
    if (!matches.length) return this.reply("没有找到匹配指令。可以换一种说法，或稍后等知识库完成扫描。", true)
    if (renderConfig(config).helpAsImage !== false) {
      try {
        const image = await renderCommandHelp({ query, matches, stats: commandObserver.stats(), config })
        return deliverRenderedImage(image, { e: this.e, config }, { label: "指令帮助图片" })
      } catch (err) {
        hostRuntime.logger?.warn?.("[yui-chat] 指令推荐图片渲染失败，回退文本", err)
      }
    }
    const msg = matches.map((item, index) => {
      const suggested = record(item.recommendation)
      const nextSteps = Array.isArray(suggested.nextSteps) ? suggested.nextSteps.map(text) : []
      return `${index + 1}. ${text(item.pluginName)}：${text(item.description) || "无描述"}\n   建议：${text(suggested.command || item.suggestedCommand || item.example || item.fnc)}\n   理由：${text(suggested.reason || item.reason) || "匹配指令知识库"}\n   下一步：${nextSteps.join("；") || "直接尝试建议指令"}\n   权限：${text(item.permission)}；使用：${Number(item.usageCount) || 0} 次；置信度：${text(suggested.confidence) || "unknown"}`
    }).join("\n")
    return this.reply(msg, true)
  }

  async clear() {
    const targets = targetUserIds(this.e)
    const count = await chatService.clear(this.e, { userIds: targets })
    const label = targets.length ? `已结束 ${targets.join("、")} 的对话` : "已结束当前对话"
    return this.reply(`${label}，清理会话 ${count} 个。请重新 ${pluginCommand("chat")} 开启新的对话。`, true)
  }

  async conversationList() {
    const config = appConfig(await configStore.load())
    const rows = chatService.listConversations({ limit: 20 })
    if (!rows.length) return this.reply("当前没有 Yui Chat 活跃对话。", true)
    if (renderConfig(config).conversationListAsImage !== false) {
      try {
        const image = await renderConversationList(rows, config)
        return deliverRenderedImage(image, { e: this.e, config }, { label: "会话列表图" })
      } catch (err) {
        hostRuntime.logger?.warn?.("[yui-chat] 对话列表图片渲染失败，回退文本", err)
      }
    }
    const lines = rows.map((row, index) => {
      const scope = row.type === "group" ? `群 ${row.groupId} / 用户 ${row.userId}` : `私聊 ${row.userId}`
      return `${index + 1}. ${row.channel}｜${scope}｜${row.turns} 轮｜${row.lastSeenAt || "未知时间"}`
    })
    return this.reply([
      `当前活跃对话 ${rows.length} 个（最多显示 20 个）：`,
      ...lines,
      "",
      `可用 ${pluginCommand("结束对话")} 结束当前对话，群聊中可用 ${pluginCommand("结束对话")} @用户。`,
    ].join("\n"), true)
  }

  async scheduleTaskList() {
    const rows = await scheduleTaskService.list(this.e, "all")
    return this.reply(formatScheduleTaskList(rows), true)
  }

  async allScheduleTaskList() {
    const rows = await scheduleTaskService.listAll("all")
    return this.reply(formatScheduleTaskList(rows, {
      title: "全部定时任务",
      emptyText: "当前没有任何定时任务。",
      showOwner: true,
      footer: "任务编号可用于核对；任务仍由创建者取消。",
    }), true)
  }

  async endAllConversations() {
    const result = record(await endAllConversationsRuntime({ clearRecentContext: true }))
    const cleared = record(result.cleared)
    const response = record(cleared.response)
    return this.reply(
      `已结束全部 Yui Chat 对话。\n会话：${Number(cleared.conversations) || 0} 个\n闭嘴记录：${Number(cleared.mutedScopes) || 0} 个\n限流桶：${Number(response.rateLimitBuckets) || 0} 个\n锁：${Number(response.locks) || 0} 个`,
      true,
    )
  }

  async switchMode() {
    const modeText = matchPluginCommand(this.e.msg, "(文本|图片|语音)模式")?.[1] || "文本"
    const modeMap: Record<string, string> = { 文本: "text", 图片: "picture", 语音: "voice" }
    const mode = modeMap[modeText] || "text"
    await userSettingsStore.set(this.e, { mode })
    return this.reply(`Yui Chat 已切换为${modeText}模式。`, true)
  }

  async cleanupCache() {
    const all = Boolean(matchPluginCommand(this.e.msg, "清理全部缓存"))
    const [media, render] = await Promise.all([
      cleanupMediaCache({ mode: all ? "all" : "expired" }),
      cleanupRenderCache({ mode: all ? "all" : "expired" }),
    ])
    return this.reply(
      `Yui Chat 缓存清理完成。\n模式：${all ? "全部" : "过期"}\n媒体：${media.files} 个，${media.bytes} bytes\n渲染：${render.files} 个，${render.bytes} bytes`,
      true,
    )
  }

  async diagnostics() {
    const result = record(await buildDiagnostics())
    const summary = record(result.summary)
    const providers = record(result.providers)
    const routingPreview = record(providers.routingPreview)
    const runtime = record(result.runtime)
    const access = record(runtime.access)
    const paths = record(result.paths)
    const issues = records(result.issues).slice(0, 8).map(item =>
      `- [${text(item.level)}] ${text(item.area) || "runtime"}：${text(item.message)}`,
    )
    return this.reply([
      `Yui Chat 诊断：${result.ok === true ? "通过" : "存在错误"}`,
      `问题：${Number(summary.errorCount) || 0} error / ${Number(summary.warnCount) || 0} warn`,
      `模型渠道：${Number(summary.providers) || 0} 个；工具：${Number(summary.enabledTools) || 0}/${Number(summary.tools) || 0} 个已启用`,
      `模型路由：${text(providers.defaultTask)} / ${Number(routingPreview.candidateCount) || 0} 个候选 / ${routingPreview.ok === false ? "存在错误" : "可用"}`,
      `扩展：Custom 工具 ${Number(summary.customTools) || 0} 个 / Markdown Skill ${Number(summary.markdownSkills) || 0} 个`,
      `MCP：${Number(summary.mcpClients) || 0} 个客户端 / ${Number(summary.mcpTools) || 0} 个工具`,
      `缓存：${Number(summary.mediaCacheFiles) || 0} 个文件，${Number(summary.mediaCacheBytes) || 0} bytes`,
      `渲染缓存：${Number(summary.renderCacheFiles) || 0} 个文件，${Number(summary.renderCacheBytes) || 0} bytes`,
      `渲染能力：${Number(summary.renderKinds) || 0} 类图片`,
      `闭嘴记录：${records(access.mutedScopes).length} 个`,
      `临时目录：${text(paths.tempDir)}`,
      ...(issues.length ? ["", ...issues] : ["", "未发现需要处理的问题。"]),
    ].join("\n"), true)
  }

  async renderImageCommand() {
    return runRenderImageCommand({ e: this.e, reply: (...args: unknown[]) => this.reply(...args) })
  }

  async screenshotUrl() {
    return runUrlScreenshotCommand({ e: this.e, reply: (...args: unknown[]) => this.reply(...args) })
  }

  async screenshotHtml() {
    return runHtmlScreenshotCommand({ e: this.e, reply: (...args: unknown[]) => this.reply(...args) })
  }

  muteTargetFromMessage() {
    const message = text(this.e.msg)
    const groupMatch = matchPluginCommand(message, "(?:本群|全局)?群(\\d+)?(?:闭嘴|关机|休眠|下班|张嘴|开口|说话|上班)([\\s\\S]*)")
    const localGroup = Boolean(matchPluginCommand(message, "本群[\\s\\S]*"))
    const groupId = groupMatch?.[1] || (localGroup ? text(this.e.group_id) : "")
    return {
      global: Boolean(matchPluginCommand(message, "全局[\\s\\S]*")) || (!groupId && !localGroup),
      groupId,
    }
  }

  async muteChat() {
    const config = appConfig(await configStore.load())
    const target = this.muteTargetFromMessage()
    const tail = String(matchPluginCommand(this.e.msg, "(本群|全局)?(群\\d+)?(闭嘴|关机|休眠|下班)([\\s\\S]*)")?.[4] || "").trim()
    const row = record(muteScope(this.e, {
      ...target,
      durationMs: parseDuration(tail),
      reason: tail,
      operatorId: this.e.user_id,
    }))
    const scope = row.type === "global" ? "全局" : `群 ${text(row.groupId)}`
    return this.reply(`${text(config.persona.firstPerson)}已进入${scope}闭嘴状态，剩余 ${row.until === Infinity ? "长期" : listMutedScopes().find(item => item.key === row.key)?.remaining || ""}。`, true)
  }

  async unmuteChat() {
    const target = this.muteTargetFromMessage()
    const ok = unmuteScope(this.e, target)
    const scope = target.global ? "全局" : `群 ${target.groupId || this.e.group_id}`
    return this.reply(ok ? `${scope}已恢复回复。` : `${scope}当前没有闭嘴记录。`, true)
  }

  async muteList() {
    const rows = listMutedScopes()
    if (!rows.length) return this.reply("当前没有 Yui Chat 闭嘴记录。", true)
    return this.reply([
      `当前闭嘴记录 ${rows.length} 条：`,
      ...rows.map((row, index) => `${index + 1}. ${row.type === "global" ? "全局" : `群 ${row.groupId}`}｜剩余 ${row.remaining}｜操作者 ${row.operatorId || "未知"}`),
    ].join("\n"), true)
  }

  async firstPersonSettings() {
    const action = matchPluginCommand(this.e.msg, "第一人称(开启|关闭)?")?.[1]
    if (action) {
      const enabled = action === "开启"
      const saved = await updateConfig(config => {
        config.persona = {
          ...(config.persona || {}),
          respondToFirstPersonCall: enabled,
        }
      })
      return this.reply(`第一人称呼叫回应已${enabled ? "开启" : "关闭"}。\n当前第一人称：${text(saved.persona.firstPerson)}`, true)
    }
    const config = appConfig(await configStore.load())
    const persona = config.persona
    const trigger = persona.trigger || {}
    const ambient = trigger.ambient || {}
    const poke = trigger.poke || {}
    return this.reply([
      `当前 AI 第一人称：${text(persona.firstPerson)}`,
      `AI 名称：${text(persona.assistantLabel)}`,
      `别名：${(persona.aliases || []).join("、") || "无"}`,
      `人格链：${persona.enabled ? "已开启" : "未开启"}`,
      `回应第一人称呼叫：${persona.respondToFirstPersonCall ? "已开启" : "未开启"}`,
      `回应 @ 机器人：${persona.respondToAt !== false ? "已开启" : "未开启"}`,
      `随机旁路：${ambient.enabled ? "已开启" : "未开启"}${ambient.groupOnly !== false ? "（仅群聊）" : ""}`,
      `戳一戳回应：${poke.enabled === true ? "已开启" : "未开启"}；冷却：${Number(poke.cooldownMs) || 0}ms`,
      `触发概率：${Number(trigger.probabilityPercent) || 100}%`,
      `冷却：${Number(trigger.cooldownMs) || 0}ms；群冷却：${Number(trigger.groupCooldownMs) || 0}ms`,
      `禁用群：${(trigger.disabledGroupIds || []).join("、") || "无"}`,
      "",
      `可用：${pluginCommand("设置AI第一人称埋埋")} / ${pluginCommand("第一人称开启")} / ${pluginCommand("第一人称随机开启")} / ${pluginCommand("第一人称戳一戳关闭")} / ${pluginCommand("第一人称概率20")} / ${pluginCommand("第一人称冷却30秒")} / ${pluginCommand("第一人称禁用本群")}`,
    ].join("\n"), true)
  }

  async initiativeGreeting() {
    const groupId = String(matchPluginCommand(this.e.msg, "打招呼(\\d+)?")?.[1] || "").trim()
    if (!groupId && !this.e.isGroup) return this.reply(`请在群里使用 ${pluginCommand("打招呼")}，或指定群号：${pluginCommand("打招呼123456789")}。`, true)
    try {
      const result = record(await sendInitiativeGreeting(this.e, { groupId }))
      if (groupId) return this.reply(`已向${text(result.target)}打招呼：${text(result.text)}`, true)
      return true
    } catch (err) {
      hostRuntime.logger?.warn?.("[yui-chat] 主动打招呼失败", err)
      return this.reply(`主动打招呼失败：${errorMessage(err)}`, true)
    }
  }

  async firstPersonTriggerSettings() {
    const match = matchPluginCommand(this.e.msg, "第一人称(概率|冷却|禁用本群|启用本群|随机开启|随机关闭|旁路开启|旁路关闭|戳一戳开启|戳一戳关闭)([\\s\\S]*)")
    const action = match?.[1]
    const tail = String(match?.[2] || "").trim()
    let percent = 0
    let durationMs = 0
    if (action === "概率") {
      percent = Number(tail.match(/\d+(?:\.\d+)?/)?.[0])
      if (!Number.isFinite(percent)) return this.reply(`请输入 0-100 的概率，例如：${pluginCommand("第一人称概率20")}`, true)
    } else if (action === "冷却") {
      durationMs = parseDuration(tail)
      if (durationMs === Infinity) return this.reply(`请输入冷却时长，例如：${pluginCommand("第一人称冷却30秒")} / ${pluginCommand("第一人称冷却5分钟")}`, true)
    }
    if ((action === "禁用本群" || action === "启用本群") && !this.e.isGroup) {
      return this.reply("该命令只能在群聊中使用。", true)
    }
    const saved = await updateConfig(config => {
      const trigger: PersonaTriggerConfig = { ...(config.persona.trigger || {}) }
      if (action === "概率") {
        trigger.probabilityPercent = Math.max(0, Math.min(100, percent))
      } else if (action === "冷却") {
        trigger.cooldownMs = durationMs
        trigger.groupCooldownMs = durationMs
      } else if (action === "禁用本群") {
        trigger.disabledGroupIds = [...new Set([...(trigger.disabledGroupIds || []).map(String), text(this.e.group_id)])]
      } else if (action === "启用本群") {
        trigger.disabledGroupIds = (trigger.disabledGroupIds || []).map(String).filter(id => id !== text(this.e.group_id))
      } else if (action === "随机开启" || action === "旁路开启") {
        trigger.ambient = {
          ...(trigger.ambient || {}),
          enabled: true,
          groupOnly: trigger.ambient?.groupOnly !== false,
          minMessageChars: Number(trigger.ambient?.minMessageChars ?? 2),
        }
      } else if (action === "随机关闭" || action === "旁路关闭") {
        trigger.ambient = { ...(trigger.ambient || {}), enabled: false }
      } else if (action === "戳一戳开启" || action === "戳一戳关闭") {
        trigger.poke = {
          ...(trigger.poke || {}),
          enabled: action === "戳一戳开启",
          respondToBotPoke: trigger.poke?.respondToBotPoke !== false,
          probabilityPercent: Number(trigger.poke?.probabilityPercent ?? 100),
          cooldownMs: Number(trigger.poke?.cooldownMs ?? 30000),
          groupCooldownMs: Number(trigger.poke?.groupCooldownMs ?? 30000),
        }
      }
      config.persona = { ...config.persona, trigger }
    })
    return this.reply([
      "第一人称触发策略已更新：",
      `随机旁路：${saved.persona.trigger?.ambient?.enabled ? "已开启" : "未开启"}${saved.persona.trigger?.ambient?.groupOnly !== false ? "（仅群聊）" : ""}`,
      `戳一戳：${saved.persona.trigger?.poke?.enabled === true ? "已开启" : "未开启"}；冷却：${Number(saved.persona.trigger?.poke?.cooldownMs) || 0}ms`,
      `概率：${Number(saved.persona.trigger?.probabilityPercent) || 100}%`,
      `冷却：${Number(saved.persona.trigger?.cooldownMs) || 0}ms；群冷却：${Number(saved.persona.trigger?.groupCooldownMs) || 0}ms`,
      `禁用群：${(saved.persona.trigger?.disabledGroupIds || []).join("、") || "无"}`,
    ].join("\n"), true)
  }

  async setFirstPerson() {
    const input = String(matchPluginCommand(this.e.msg, "设置(?:AI|ai)?第一人称(?:称谓)?([\\s\\S]*)")?.[1] || "").trim()
    if (!input || input === "帮助") {
      return this.reply([
        "第一人称设置帮助：",
        "用于第一人称呼叫、人格链和语音/图片等输出文案。",
        `示例：${pluginCommand("设置AI第一人称埋埋")}`,
        "保存后会立即生效，不需要重启。",
      ].join("\n"), true)
    }
    const firstPerson = input.replace(/\s+/g, " ").slice(0, 32)
    const saved = await updateConfig(config => {
      const aliases = new Set(config.persona.aliases || [])
      if (config.persona.firstPerson && config.persona.firstPerson !== firstPerson) aliases.add(config.persona.firstPerson)
      config.persona = {
        ...config.persona,
        firstPerson,
        assistantLabel: firstPerson,
        aliases: [...aliases].filter(Boolean).slice(0, 12),
      }
    })
    return this.reply(`AI 的第一人称已设置为“${saved.persona.firstPerson}”，原称谓已保留为别名以便平滑触发。`, true)
  }

  async toolPermissionGroups() {
    return this.reply(`旧版“工具权限组”已移除，请改用 ${pluginCommand("面板")} -> 工具 -> 边界权限 进行角色与工具授权。`, true)
  }

  async webLogin() {
    const config = appConfig(await configStore.load())
    const userId = this.e.user_id
    if (userId === undefined) return this.reply("无法确定当前用户身份，请稍后再试。", true)
    const quick = issueQuickLogin(userId)
    const addresses = await buildWebAddresses({ quickCode: quick.code })
    const message = [
      "Yui Chat 管理面板登录地址：",
      ...(addresses.custom.length ? [`自定义/公开地址：\n${addresses.custom.join("\n")}`] : []),
      `本地地址：\n${addresses.local.join("\n")}`,
      "快捷链接 3 分钟内有效且只能使用一次；打开后会换成浏览器 HttpOnly 短会话。",
    ].join("\n\n")

    if (this.e.isGroup && config.web.loginInGroup !== true) {
      try {
        const privateTarget = hostRuntime.bot?.pickUser?.(userId)
        if (!privateTarget?.sendMsg) throw new Error("当前宿主不支持私聊发送")
        await privateTarget.sendMsg(message)
        return this.reply("Yui Chat 面板地址已发送至主人私信。", true)
      } catch (err) {
        hostRuntime.logger?.warn?.("[yui-chat] 私发面板地址失败", err)
        return this.reply(`私信发送失败，请私聊发送 ${pluginCommand("面板")} 获取登录地址。`, true)
      }
    }
    return this.reply(message, true)
  }

  async firstPersonCall() {
    return handleFirstPersonMessage(this.e, { logPrefix: "[yui-chat] 第一人称回应失败" })
  }

}
