import { commandObserver } from "../knowledge/command-observer.js"
import { renderKindCatalog } from "../core/rendering/render-service.js"
import type { UnknownRecord } from "../core/message/types.js"
import { pluginCommand } from "../core/message/command-prefixes.js"

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function enabledLabel(value: unknown): string {
  return value === false ? "关闭" : "开启"
}

export function buildNextHelpMenu(config: unknown = {}): UnknownRecord {
  const stats = commandObserver.stats()
  const rendererCount = renderKindCatalog.length
  const tools = record(record(config).tools)
  return {
    title: "Yui Chat 帮助菜单",
    subtitle: `指令知识库 ${stats.commands || 0} 条 / 渲染模板 ${rendererCount} 类 / 工具调用 ${enabledLabel(tools.enabled)}`,
    groups: [
      {
        title: "聊天入口",
        commands: [
          { command: `${pluginCommand("chat")} 你好`, description: "使用默认模型任务对话" },
          { command: `${pluginCommand("help")} 怎么查体力`, description: "检索 Yunzai 指令知识库并推荐命令" },
          { command: pluginCommand("结束对话"), description: "结束当前用户对话上下文" },
          { command: pluginCommand("定时任务"), description: "查看自己的待执行提醒" },
          { command: `${pluginCommand("文本模式")} / ${pluginCommand("图片模式")} / ${pluginCommand("语音模式")}`, description: "切换当前用户输出模式" },
        ],
      },
      {
        title: "管理入口",
        commands: [
          { command: pluginCommand("面板"), description: "获取一次性 Web 管理端快捷登录链接", permission: "master" },
          { command: pluginCommand("诊断"), description: "查看模型、工具、缓存和安全开关", permission: "master" },
          { command: pluginCommand("对话列表"), description: "查看当前活跃会话", permission: "master" },
          { command: pluginCommand("全部定时任务"), description: "查看所有用户的待执行提醒", permission: "master" },
          { command: `${pluginCommand("清理缓存")} / ${pluginCommand("清理全部缓存")}`, description: "清理插件内媒体与渲染缓存", permission: "master" },
        ],
      },
      {
        title: "统一渲染",
        commands: [
          { command: "render_image({ template, data })", description: "模型工具统一入口，模板按需选择", permission: "tool" },
          { command: pluginCommand("图片模式"), description: "聊天输出自动使用统一渲染服务", permission: "all" },
          { command: pluginCommand("渲染帮助菜单"), description: "发送默认帮助菜单图", permission: "master" },
        ],
      },
      {
        title: "第一人称",
        commands: [
          { command: pluginCommand("第一人称"), description: "查看第一人称、别名和触发状态", permission: "master" },
          { command: pluginCommand("设置AI第一人称埋埋"), description: "设置 AI 自称和别名", permission: "master" },
          { command: `${pluginCommand("第一人称随机开启")} / ${pluginCommand("第一人称随机关闭")}`, description: "开关群聊普通消息旁路参与", permission: "master" },
        ],
      },
    ],
  }
}

export default buildNextHelpMenu
