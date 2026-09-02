# Yui Chat

Yui Chat 是面向 TRSS-Yunzai 的独立 AI 插件，源码目录为 `plugins/yui-chat/`。默认聊天命令是 `#yuichat`，第一人称触发词是“埋埋”，管理台挂载在 `/yui-chat/`。

模型配置采用 **供应商 → 模型 → 任务** 三层结构：`apiProviders → models → modelTasks`。插件支持 OpenAI-compatible、Gemini、Qwen、Claude、ChatGLM 和 mock，包含工具调用、图片上下文、人格互动、记忆与知识库、文本/图片/语音输出、定时提醒和管理台。

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

## 指令

除第一人称自然呼叫外，插件指令统一使用 `#yui` 前缀。前缀的唯一正则定义位于 `core/message/command-prefixes.ts`；修改该定义即可统一调整命令注册和服务端解析。

| 命令 | 作用 |
| --- | --- |
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
| `#yui清理缓存` | 清理过期媒体和渲染缓存（主人） |

第一人称自然呼叫不经过指令前缀正则。默认称谓“埋埋”可在管理台或主人命令中修改；直呼、@、戳一戳和可选群聊旁路复用同一人格与访问控制链路。

## 配置与数据

| 内容 | 位置 |
| --- | --- |
| 源码默认值 | `config/defaults.ts` |
| 极简启动配置 | `config/config.json`，只保存 SQLite 启动项和可选 Web Token |
| 运行配置与状态库 | `data/yui-chat/storage/state.sqlite3` |
| 可重建向量库 | `data/yui-chat/storage/vectors.sqlite3` |
| Custom Tool、Filter、Skill | `data/yui-chat/extensions/` |
| 手动配置包 | `data/yui-chat/backups/` |
| 临时媒体和渲染缓存 | `plugins/yui-chat/cache/` |

用户配置保存在 SQLite 的 `runtime_config` 中，未覆盖字段继承 `config/defaults.ts`。`configStore.get()` 返回冻结快照，配置修改通过管理台或 `configStore.update()` 原子提交。手动配置包不包含日志、用量、聊天、记忆和知识正文。

Web 静态 Token 留空时静态登录关闭，主人仍可通过 `#yui面板` 签发快捷码。浏览器使用短期 HttpOnly、SameSite=Strict 会话；脚本客户端仅在配置了静态 Token 后，才能通过 `yui-chat-token` 或 Bearer 请求头访问受保护接口。

## 主要行为

- 对话：任务路由支持顺序、随机和 fallback；每轮提示词注入北京时间简写，系统运行规则可编辑并恢复默认。
- 图片：只有出现明确视觉意图时才回看图片；优先取当前说话人最近图片，没有时才回退同群其他成员，普通对话不下载历史图片。
- 工具：Builtin、Custom 和 MCP 工具统一经过 Registry、权限和执行策略；Markdown Skill 只注入指令。`message_send` 支持普通消息链和合并转发，网络搜索来源以转发节点追加在正文之后。
- 记忆：长期事实默认只在明确“记住”等意图或管理台操作时写入；指定群消息采集与提炼需要管理员显式开启。
- 安全：用户 URL 统一经 `safe-http-client` 和 `link-safety-policy`；URL 截图仍有独立功能开关、主人权限、域名策略和 Chromium 请求拦截。
- 输出：支持文本、图片卡片和语音；`<EMPTY>` 仅表示第一人称场景的静默回复，不写入历史或记忆。

## 开发与文档

源码以 TypeScript 为唯一业务实现，根目录只保留 `index.js` 作为 Yunzai 宿主加载器；Custom 扩展和第三方静态资源属于受控动态边界。`pnpm run build:runtime` 会生成被忽略的 `output/runtime/`，构建会拒绝同名 JS/TS 业务实现。

```bash
cd plugins/yui-chat
pnpm run check
```

`pnpm run check` 覆盖 TypeScript、浏览器端类型、运行产物、结构边界、SQLite、记忆、知识库和完整 smoke。测试默认使用隔离临时目录；需要保留现场时使用 `YUI_CHAT_SMOKE_RUNTIME_ROOT`，需要指定隔离运行根时使用 `YUI_CHAT_RUNTIME_ROOT`。

当前文档按职责保留：

- [架构与数据流](docs/architecture.md)：模块职责、运行链路、存储、管理台和安全边界。
- [AI Tool 创建与集成](docs/tool-authoring-guide.md)：工具契约、执行策略、自动投递和 Custom 包。
- [Custom 框架资源](docs/custom-framework-resources.md)：受控复用宿主或其他插件资源。
- [SQLite 基线 ER](docs/sqlite-baseline-er.md)：状态库表结构和关系。
- [维护规则](AGENTS.md)：AI 和维护者必须遵守的代码、配置、安全与验证约束。
