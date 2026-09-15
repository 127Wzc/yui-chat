import { configStore } from "../config/store.js"
import { deliverRenderedImage } from "../core/rendering/render-delivery.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import { checkAccess } from "../core/chat/access-control.js"
import { renderHelpMenu, withRenderScope } from "../core/rendering/render-service.js"
import type { UnknownRecord } from "../core/message/types.js"
import { pluginCommand } from "../core/message/command-prefixes.js"

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

export function buildNextHelpMenu(config: unknown = {}, event: UnknownRecord = {}): UnknownRecord {
  const command = (suffix: string, description: string, permission = "all") => ({command:pluginCommand(suffix),description,permission})
  return {
    title: "Yui Chat 指令帮助",
    subtitle: "方括号内为参数或当前值，使用时无需输入方括号",
    groups: [
      {title:"普通用户",permission:"all",commands:[
        command("chat [你好]", "与默认模型对话"),
        command("help [怎么查体力]", "按需求推荐机器人指令"),
        command("帮助", "查看指令菜单"),
        command("结束对话", "清空当前对话上下文"),
        command("快捷指令", "查看可用动作"),
        command("指令说明 [动作名]", "查看动作输入要求"),
        command("我的记忆", "转发查看本群个人及全局记忆"),
        command("我的记忆 修改 [序号] [新内容]", "也可使用 添加 [内容]、删除 [序号]"),
        command("定时任务", "查看自己的提醒"),
        {command:["文本模式","图片模式","语音模式"].map(value=>pluginCommand(value)).join(" / "),description:"切换回复形式",permission:"all"},
      ]},
      {title:"主人专用",permission:"master",commands:[
        command("管理记忆 [@成员或QQ号]", "查看他人的本群及全局记忆", "master"),
        command("他的记忆 [@成员或QQ号]", "查看指定成员记忆，也支持她的记忆、TA的记忆", "master"),
        command("管理记忆 [@成员] 修改 [序号] [新内容]", "按最近列表维护他人记忆", "master"),
        command("面板", "打开管理台", "master"),
        command("诊断", "查看运行与配置状态", "master"),
        command("工具参数 [工具名]", "查看工具参数及示例", "master"),
        command("测试工具 [工具名] [参数=值]", "直接试跑工具", "master"),
        command("对话列表", "查看活跃会话", "master"),
        command("全部定时任务", "查看所有人的提醒", "master"),
        command("清理缓存", "清理过期媒体缓存", "master"),
        command("清理全部缓存", "清理全部媒体缓存", "master"),
        command("第一人称", "查看称谓与触发设置", "master"),
        command(`设置AI第一人称[${String(record(record(config).persona).firstPerson || "埋埋")}]`, "修改 AI 称谓", "master"),
        command("第一人称随机开启", "开启群聊随机参与", "master"),
        command("第一人称随机关闭", "关闭群聊随机参与", "master"),
        command("渲染帮助菜单", "生成帮助菜单图片", "master"),
      ]},
    ].filter(group => group.permission !== "master" || event.isMaster === true),
  }
}

export default buildNextHelpMenu

/** 普通帮助命令与源码动作共用的真实入口；不调用模型。 */
export async function sendPluginHelp(args: UnknownRecord = {}, context: UnknownRecord = {}): Promise<unknown> {
  const e = record(context.e)
  const config = withRenderScope(configStore.get(), "system")
  if (!checkAccess(e, config).ok) return {kind:"delivery",receipt:{status:"sent"}}
  const menu = buildNextHelpMenu(config, e)
  if (typeof args.title === "string" && args.title.trim()) menu.title = args.title.trim().slice(0,80)
  try {
    const image = await renderHelpMenu(menu, config)
    return await deliverRenderedImage(image, {e,config}, {label:"项目帮助"})
  } catch (error) {
    hostRuntime.logger?.warn?.("[yui-chat] 帮助图片不可用，回复文字菜单", error)
    const groups = Array.isArray(menu.groups) ? menu.groups : []
    const message = [menu.title,...groups.map(value=>{const group=record(value);return `${group.title}\n${(Array.isArray(group.commands)?group.commands:[]).map(value=>{const item=record(value);return `${item.command} · ${item.description}${item.permission==='master' && group.permission!=='master'?'（主人）':''}`}).join('\n')}`})].join('\n\n')
    if (typeof e.reply === "function") await e.reply(message)
    return message
  }
}
