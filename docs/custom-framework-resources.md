# Custom 扩展复用框架与其他插件功能块

Custom 工具和 Custom Filter 可以通过各自 Manifest 的 `frameworkResources` 声明允许访问的 Yunzai 文件。运行时只向 `createTools()` 或 `createFilters()` 提供已经声明过的别名，路径必须位于声明的插件目录或 Yunzai 根目录内。

## 声明一个 Yunzai 框架模块

```json
{
  "frameworkResources": {
    "system-status": "yunzai:plugins/system/status.js"
  }
}
```

在 `index.js` 中通过别名加载，不需要拼接绝对路径：

```js
export async function createTools({ framework }) {
  // 只可加载 tool.json 已声明的资源。
  const { status: StatusPlugin } = await framework.use("system-status")

  return [{
    name: "status_command_help",
    description: "测试状态指令的帮助文本",
    async execute() {
      // 直接执行 status.js 中原有的 otherHelp() 方法。
      // 该方法不依赖消息事件，因此不用构造机器人插件实例。
      return StatusPlugin.prototype.otherHelp()
    }
  }]
}
```

完整可运行示例源位于 `examples/extensions/tools/framework-block-example/`，首次加载时会复制到用户数据目录 `data/yui-chat/extensions/tools/`，默认停用。它直接调用 `plugins/system/status.js` 既有的 `status.otherHelp()`，可在扩展管理页直接测试，不会发送机器人消息。

## 支持的资源类型

- `framework.use(alias)`：推荐的简单入口，自动根据扩展名返回模块、JSON 或文本。
- `module`：也可使用 `framework.importModule(alias)` 或 `framework.pickExport(alias, exportName)`。
- `text`：使用 `framework.readText(alias)`，默认最多读取 1 MiB。
- `json`：使用 `framework.readJson(alias)`。

短写法支持 `plugin:插件名/相对路径` 和 `yunzai:相对路径`。需要补 description 或显式 type 时仍可使用完整对象写法。绝对路径、`../` 越界和未声明别名都会被拒绝。

跨插件模块属于运行时依赖。被引用插件升级、删除或修改导出名时，Custom 包会进入加载错误状态，因此建议优先引用对方明确公开、稳定的模块。

## 管理台选取与项目 AI

Custom Filter 编辑器提供项目文件浏览器，可以逐层打开 Yunzai 和插件目录，并把选中的单个文件填入 `frameworkResources`。浏览器不会授权整个文件夹，会隐藏 `.git`、`node_modules`、运行数据、缓存、点文件和常见密钥配置；服务端仍会校验真实路径，拒绝软链接和越界路径。

编辑器也可以调用当前项目配置的 AI 模型生成过滤器代码草稿。这个请求与正常聊天隔离，不带入会话历史、人设、Skill、记忆或 Tool，只会发送当前过滤器、需求文字和管理员明确声明的资源正文。生成结果会先校验 Manifest 与 JavaScript 语法，再显示为待确认草稿；不会自动保存、启用或执行。选择了资源时，发送前会再次提示管理员确认。
