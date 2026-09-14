# Yui Chat

面向 TRSS-Yunzai 的 AI 插件，支持多供应商模型、工具扩展、图像生成、记忆和消息回复。默认聊天命令为 `#yuichat`，自然呼叫为“埋埋”。

## 安装教程 💡

请将 Yui Chat 放置在 Yunzai-Bot 的 `plugins` 目录下，且目录名必须为 `yui-chat`。

1. 推荐使用 git 进行安装，以方便后续升级。在 Yunzai 目录打开终端，运行

```sh
git clone -b main --depth=1 https://github.com/127Wzc/yui-chat.git ./plugins/yui-chat
```

2. 在 Yunzai 根目录安装依赖。`plugins/**` 是 pnpm workspace 包，根目录一次安装即可覆盖本插件

```sh
pnpm i
```

安装会通过 `postinstall` 自动执行 `build:runtime` 生成 `output/runtime/`。若安装时跳过了脚本（如 `--ignore-scripts`）或构建告警失败，进入插件目录手动补一次：

```sh
cd plugins/yui-chat
pnpm run build:runtime
```

3. 重启 Yunzai-Bot 后即可使用

后续升级在 `plugins/yui-chat` 目录执行 `git pull`，然后回到 Yunzai 根目录重新运行 `pnpm i`（依赖未变时也可只跑 `pnpm run build:runtime`）。

## 快速开始

启动 Yunzai 后，主人发送 `#yui面板` 获取 3 分钟内有效、只能使用一次的管理台快捷链接。在「模型与回复」中添加供应商和模型，再将模型设置为默认回复任务即可开始使用。

## 常用指令

| 命令 | 作用 |
| --- | --- |
| `#yui记忆` | 查看个人长期记忆及增删改用法 |
| `#yui管理记忆 QQ号或@成员` | 管理指定用户的长期记忆（主人） |
| `#yui帮助` / `#yuihelp` | 查看分区帮助图片 |
| `#yuichat 你好` | 使用默认模型任务对话 |
| `#yuihelp 怎么查体力` | 从指令知识库推荐机器人命令 |
| `#yui面板` | 获取管理台一次性快捷链接（主人） |
| `#yui诊断` | 查看模型、扩展、缓存和安全状态（主人） |
| `#yui工具参数 <工具名>` | 查看工具参数与调用示例（主人） |
| `#yui测试工具 <工具名> 参数=值` | 直接试跑已启用工具（主人） |
| `#yui过滤器参数 <过滤器名>` | 查看代码过滤器参数（主人） |
| `#yui测试过滤器 <过滤器名> text="正文"` | 试跑代码过滤器，不调用模型（主人） |
| `#yui结束对话` / `#yui结束全部对话` | 清理当前或全部临时会话 |
| `#yui定时任务` / `#yui我的定时任务` | 查看自己的待执行提醒 |
| `#yui全部定时任务` | 查看所有用户的待执行提醒（主人） |
| `#yui第一人称` | 查看第一人称与触发状态（主人） |
| `#yui设置AI第一人称埋埋` | 修改第一人称称谓（主人） |
| `#yui打招呼` | 在当前群主动问候（主人） |
| `#yui文本模式` / `#yui图片模式` / `#yui语音模式` | 设置个人输出模式 |
| `#yui清理缓存` | 清理过期媒体缓存（主人） |

## 动作中心

将现有工具或项目资源绑定为快捷指令，按“指令 → 执行方式 → 参数 → 回复 → 测试”填写。支持分类、复制预设、独立权限及动态优先级，数字越小越先执行。内置手办化示例默认停用，配置后发送或引用图片并触发 `#yui手办化`。

动作独立控制启停；新建时继承工具当前权限，之后可单独修改。模型会话专用工具不提供此入口，扩展需已加载、MCP 需已连接。工具内部、渠道和宿主权限检查仍生效。

默认要求支持 `{{text}}`、`{{userName}}`、`{{userId}}`、`{{groupId}}`；回复模板用 `{{value}}`。结果可自动回复，也可提取 JSON 字段、发送图片或消息体。预览不执行工具，实际试跑会执行已保存动作。渠道和密钥仍在工具配置中管理。

源码示例“项目帮助”复用帮助指令实现，默认停用；保存并启用后用 `#yui功能菜单` 触发。可修改标题参数，无需修改源码。

## 配置与数据

| 内容 | 位置 |
| --- | --- |
| 源码默认值 | `config/defaults.ts` |
| 极简启动配置 | `config/config.json`，只保存 SQLite 启动项和可选 Web Token |
| 运行配置与状态库 | `data/yui-chat/storage/state.sqlite3` |
| 可重建向量库 | `data/yui-chat/storage/vectors.sqlite3` |
| Custom Tool、Filter、Skill | `data/yui-chat/extensions/` |
| 手动配置包 | `data/yui-chat/backups/` |
| 临时媒体与 HTML 渲染文件 | `plugins/yui-chat/cache/` |

通过管理台修改配置；运行配置保存在 SQLite，启动 JSON 仅保存连接项和可选 Web Token。静态 Token 留空时，主人仍可使用 `#yui面板` 登录。手动配置包不包含聊天、记忆和日志正文。

## 开发与文档

在插件目录运行 `npm run check` 完成类型、构建、结构和行为检查。维护约束见 [AGENTS.md](AGENTS.md)。

- [架构与数据流](docs/architecture.md)：模块职责、运行链路、存储、管理台和安全边界。
- [AI Tool 创建与集成](docs/tool-authoring-guide.md)：工具契约、执行策略、自动投递和 Custom 包。
- [Responses API 协议](docs/responses-api.md)：适配目录、配置、原生工具和无状态回放边界。
- [Custom 框架资源](docs/custom-framework-resources.md)：受控复用宿主或其他插件资源。
- [SQLite 基线 ER](docs/sqlite-baseline-er.md)：状态库表结构和关系。

主人也可直接发送“@成员 他的记忆”或“@成员 她的记忆”查看；必须使用真实 @，不通过昵称猜测用户。增删改仍使用 `#yui管理记忆 @成员 添加/修改/删除 ...`。
