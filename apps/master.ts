import { listPersonaPunishments } from "../core/chat/persona-punishments.js"
import { toolRegistry } from "../tools/support/registry.js"
import { stripPluginCommand, pluginCommand, pluginCommandRule } from "../core/message/command-prefixes.js"
import { YuiChatCommandHandlers } from "./chat.js"

function masterCommand(reg: string, fnc: string) {
  return { reg: pluginCommandRule(reg), fnc, permission: "master" as const }
}

/**
 * 主人管理入口。
 * 所有 Master 指令必须只在这里注册，并经 masterCommand() 强制附加宿主权限。
 */
export class YuiChatMaster extends YuiChatCommandHandlers {
  async personaPunishmentList() {
    if (this.e.isMaster !== true) return this.reply("仅主人可查看处罚列表。", true)
    const rows = await listPersonaPunishments()
    if (!rows.length) return this.reply("当前没有生效或待核实的人物处罚。", true)
    const page = Math.max(1, Math.min(Math.ceil(rows.length / 20), Number(stripPluginCommand(this.e.msg, "处罚列表")) || 1))
    return this.reply([
      `第 ${page}/${Math.ceil(rows.length / 20)} 页。人物处罚 ${rows.length} 条（QQ 禁言状态为执行记录，外部人工变更需在群管理中核实）：`,
      ...rows.slice((page - 1) * 20, page * 20).map(row => `${row.id}\n用户 ${row.userId}｜${row.groupId ? `群 ${row.groupId}` : "私聊"}｜机器人 ${row.botId}\n${row.kind === "ignore" ? "暂停回复" : "禁言"}｜${row.status === "uncertain" ? "结果待核实" : "生效中"}｜剩余 ${Math.max(1, Math.ceil((row.until - Date.now()) / 1000))} 秒\n原因：${row.reason}`),
      `提前解除：${pluginCommand("解除处罚 [记录编号]")}`,
    ].join("\n\n"), true)
  }

  async personaPunishmentRelease() {
    if (this.e.isMaster !== true) return this.reply("仅主人可使用此指令。", true)
    try {
      const result = await toolRegistry.execute("persona_punishment_release", { id: stripPluginCommand(this.e.msg, "解除处罚") }, { e: this.e, allowDisabledTool: true })
      return this.reply(String(result), true)
    } catch (error) { return this.reply(error instanceof Error ? error.message : "解除失败，请稍后重试。", true) }
  }

  constructor() {
    super({
      name: "Yui Chat Master",
      dsc: "Yui Chat 主人管理指令",
      event: "message",
      priority: 1138,
      rule: [
        masterCommand("(?:他的|她的|TA的|ta的)记忆(?:\\s+[\\s\\S]*)?", "mentionMemoryCommand"),
        masterCommand("管理记忆(?:\\s+[\\s\\S]*)?", "manageMemoryCommand"),
        masterCommand("(?:全部|所有)定时任务(?:列表)?", "allScheduleTaskList"),
        masterCommand("对话列表", "conversationList"),
        masterCommand("(结束|新开|摧毁|毁灭|完结)全部(模式|模型)?对话", "endAllConversations"),
        masterCommand("(面板|登录|登陆)", "webLogin"),
        masterCommand("诊断", "diagnostics"),
        masterCommand("处罚列表(?:\\s+\\d+)?", "personaPunishmentList"),
        masterCommand("解除处罚\\s+[a-f0-9-]+", "personaPunishmentRelease"),
        masterCommand("测试工具(?:\\s+[a-zA-Z0-9_.-]+)?(?:\\s+[\\s\\S]*)?", "testToolCommand"),
        masterCommand("工具参数(?:\\s+[a-zA-Z0-9_.-]+)?", "toolParameterCommand"),
        masterCommand("测试过滤器(?:\\s+[a-zA-Z0-9_.-]+)?(?:\\s+[\\s\\S]*)?", "testFilterCommand"),
        masterCommand("过滤器参数(?:\\s+[a-zA-Z0-9_.-]+)?", "filterParameterCommand"),
        masterCommand("渲染(帮助菜单|菜单|帮助|能力|工具|Markdown|markdown|思维导图|词云|动态|面板)([\\s\\S]*)", "renderImageCommand"),
        masterCommand("截图URL\\s+([\\s\\S]+)", "screenshotUrl"),
        masterCommand("截图HTML\\s+([\\s\\S]+)", "screenshotHtml"),
        masterCommand("(本群|全局)?(群\\d+)?(闭嘴|关机|休眠|下班)([\\s\\S]*)", "muteChat"),
        masterCommand("(本群|全局)?(群\\d+)?(张嘴|开口|说话|上班)", "unmuteChat"),
        masterCommand("查看?(闭嘴|关机|休眠|下班)列表?", "muteList"),
        masterCommand("清理(全部)?缓存", "cleanupCache"),
        masterCommand("工具权限(开启|关闭)?", "toolPermissionGroups"),
        masterCommand("第一人称(概率|冷却|禁用本群|启用本群|随机开启|随机关闭|旁路开启|旁路关闭|戳一戳开启|戳一戳关闭)([\\s\\S]*)", "firstPersonTriggerSettings"),
        masterCommand("第一人称(开启|关闭)?", "firstPersonSettings"),
        masterCommand("打招呼(\\d+)?", "initiativeGreeting"),
        masterCommand("设置(AI|ai)?第一人称(称谓)?([\\s\\S]*)", "setFirstPerson"),
      ],
    })
  }
}
