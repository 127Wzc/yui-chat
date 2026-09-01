/**
 * Custom 扩展示例：安全复用 Yunzai 框架中的已有函数。
 *
 * 这个包在 tool.json 中声明了 system-status 资源，运行时只能通过
 * framework.use("system-status") 访问它，不能读取任何未声明的本地文件。
 */
export async function createTools({ framework }) {
  // 第 1 步：加载已在 tool.json 声明的框架模块。
  const { status: StatusPlugin } = await framework.use("system-status")

  // 第 2 步：直接调用 status.js 原有的 otherHelp() 方法。
  // 此方法不依赖消息事件；通过原型调用可避免构造完整机器人插件实例。
  const getStatusCommandHelp = () => StatusPlugin.prototype.otherHelp()

  // 第 3 步：向模型注册一个低风险、无需入参的工具。
  return [{
    name: "status_command_help",
    displayNameZh: "测试状态指令帮助",
    description: "调用 Yunzai plugins/system/status.js 中 status.otherHelp()，返回 #状态 指令关联的帮助文本。",
    risk: "low",
    tags: ["status", "command", "framework-resource", "example"],
    parameters: {
      type: "object",
      properties: {},
      description: "无需参数；直接测试框架状态插件中的原有帮助函数。",
    },
    async execute() {
      // 第 4 步：执行框架源代码里的真实函数，并将结果返回给调用方。
      return getStatusCommandHelp()
    },
  }]
}
