import { actionExamples, parseAction, type ActionDefinition } from "./contract.js"

export interface ActionTemplateGroup { id: string; name: string; description: string; items: ActionDefinition[] }

/** 模板只生成可编辑草稿，不写入用户配置或注册指令。 */
export function actionTemplateGroups(): ActionTemplateGroup[] {
  const drawing = parseAction({
    id: "template-drawing", name: "AI 绘画", description: "输入画面描述，也可以附带参考图片", command: "画图",
    categoryId: "images", enabled: false, tool: "generate_image", textParam: "prompt",
    input: { mode: "text", images: "current-and-quote", requireImage: false, avatarFallback: false },
    reply: { image: { start: "🎨「{{actionName}}」{{status}}，当前任务 {{queueTotal}} 个（执行中 {{queueActive}}/{{queueLimit}}），请稍候。", running: "🎨「{{actionName}}」已开始生成，请稍候。", success: "{{image}}\n✅ 图片生成完成（{{elapsed}} 秒）\n🤖 模型：{{model}}\n📷 共 {{count}} 张", failure: "❌ 图片生成失败（{{elapsed}} 秒）\n错误：{{reason}}" } },
  })
  const search = parseAction({
    id: "template-search", name: "联网搜索", description: "搜索指定关键词", command: "搜索", categoryId: "lookup",
    enabled: false, tool: "web_search", textParam: "query",
  })
  const dice = parseAction({
    id: "template-dice", name: "掷骰子", description: "发送一个随机骰子", command: "掷骰子",
    enabled: false, tool: "send_dice", defaults: { count: 1 },
  })
  return [
    { id: "drawing", name: "图片创作", description: "根据描述和参考图创作", items: [drawing] },
    { id: "lookup", name: "信息查询", description: "把查询工具变成快捷指令", items: [search] },
    { id: "entertainment", name: "趣味互动", description: "轻量群聊互动", items: [dice] },
    { id: "project", name: "项目工具", description: "复用本插件已有入口", items: actionExamples().filter(item => item.kind === "source") },
  ]
}
