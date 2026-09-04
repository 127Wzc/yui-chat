import { pluginCommandRule } from "../core/message/command-prefixes.js"
import { YuiChatCommandHandlers } from "./chat.js"

function masterCommand(reg: string, fnc: string) {
  return { reg: pluginCommandRule(reg), fnc, permission: "master" as const }
}

/**
 * 主人管理入口。
 * 所有 Master 指令必须只在这里注册，并经 masterCommand() 强制附加宿主权限。
 */
export class YuiChatMaster extends YuiChatCommandHandlers {
  constructor() {
    super({
      name: "Yui Chat Master",
      dsc: "Yui Chat 主人管理指令",
      event: "message",
      priority: 1138,
      rule: [
        masterCommand("(?:全部|所有)定时任务(?:列表)?", "allScheduleTaskList"),
        masterCommand("对话列表", "conversationList"),
        masterCommand("(结束|新开|摧毁|毁灭|完结)全部(模式|模型)?对话", "endAllConversations"),
        masterCommand("(面板|登录|登陆)", "webLogin"),
        masterCommand("诊断", "diagnostics"),
        masterCommand("测试工具(?:\\s+[a-zA-Z0-9_.-]+)?(?:\\s+[\\s\\S]*)?", "testToolCommand"),
        masterCommand("工具参数(?:\\s+[a-zA-Z0-9_.-]+)?", "toolParameterCommand"),
        masterCommand("测试过滤器(?:\\s+[a-zA-Z0-9_.-]+)?(?:\\s+[\\s\\S]*)?", "testFilterCommand"),
        masterCommand("过滤器参数(?:\\s+[a-zA-Z0-9_.-]+)?", "filterParameterCommand"),
        masterCommand("渲染(帮助菜单|菜单|帮助|能力|工具|MarkdownHTML|markdownhtml|Markdown|markdown|思维导图HTML|思维导图html|MarkmapHTML|markmaphtml|思维导图|词云|动态|面板)([\\s\\S]*)", "renderImageCommand"),
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
