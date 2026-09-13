# Yui Chat

Yui Chat 是面向 TRSS-Yunzai 的独立 AI 插件，源码目录为 `plugins/yui-chat/`。默认聊天命令是 `#yuichat`，第一人称触发词是“埋埋”，管理台挂载在 `/yui-chat/`。

模型配置采用 **供应商 → 模型 → 任务** 三层结构：`apiProviders → models → modelTasks`。插件支持 OpenAI Chat Completions、OpenAI Responses、其他 OpenAI-compatible、Gemini、Qwen、Claude、ChatGLM 和 mock。Responses 模式可使用原生 Function Calling、`web_search`、`file_search` 与 `tool_search`，同时复用现有工具权限、执行器和循环保护。每个 Responses 模型可选择自动上游链（默认）、严格 `previous_response_id` 链或本地历史回放；自动模式仅在上游断链时执行一次有界本地恢复，且不会重新执行工具。本地始终保留可见历史和工具审计。模型名单只使用 `web_search` 等稳定能力 ID，`toolPolicy.routes` 再决定使用 OpenAI 托管、本地、自动或禁用，以及 Web Search 是只用首选、失败换源还是多渠道并行；实现级开关和凭据位于工具管理页。

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

普通用户指令由 `apps/chat.ts` 注册；所有主人管理指令统一从 `apps/master.ts` 注册，新增 Master 指令不得放回普通聊天入口。

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
| `#yui清理缓存` | 清理过期媒体缓存（主人） |

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
| 临时媒体与 HTML 渲染文件 | `plugins/yui-chat/cache/` |

用户配置保存在 SQLite 的 `runtime_config` 中，未覆盖字段继承 `config/defaults.ts`。`configStore.get()` 返回冻结快照，配置修改通过管理台或 `configStore.update()` 原子提交。手动配置包不包含日志、用量、聊天、记忆和知识正文。

Web 静态 Token 留空时静态登录关闭，主人仍可通过 `#yui面板` 签发快捷码。浏览器使用短期 HttpOnly、SameSite=Strict 会话；脚本客户端仅在配置了静态 Token 后，才能通过 `yui-chat-token` 或 Bearer 请求头访问受保护接口。

## 主要行为

- 对话：任务路由支持顺序、随机和 fallback；每轮提示词注入北京时间简写，系统运行规则可编辑并恢复默认。
- 图文引用：第一人称与 `#yuichat` 将引用正文作为本轮讨论对象，引用触发时按消息 ID 即时读取最新图片地址并在本轮下载/组装，不读取或写入图片缓存，避免短时签名地址过期；新图、引用图和近期图片保留来源，比较时同时提供。明确引用不会混入无关历史图片或头像；“第二张、再仔细看看”等追问只回看上一轮仍受管的普通图片。没有引用时，近期图片按明确点名、人称或消息顺序选择，普通聊天不下载历史图片。群聊短期上下文按发送者保留一层“回复谁”的关系和完整正文；不另设单条消息字符上限，总量仍由最近消息条数和模型输入预算控制。被动引用媒体只记关系，不提前下载，用户后续直接引用该消息时再按消息 ID 读取。语音、视频和文件暂不解析内容。
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
- [Responses API 协议](docs/responses-api.md)：适配目录、配置、原生工具和无状态回放边界。
- [Custom 框架资源](docs/custom-framework-resources.md)：受控复用宿主或其他插件资源。
- [SQLite 基线 ER](docs/sqlite-baseline-er.md)：状态库表结构和关系。
- [维护规则](AGENTS.md)：AI 和维护者必须遵守的代码、配置、安全与验证约束。

## 动作中心

管理台「动作中心」（`#actions`）按“指令 → 执行方式 → 配置参数 → 回复 → 测试”分步配置。既能绑定已注册的 Builtin、Custom 或 MCP 工具，也能选择项目资源文件，调用导出函数、Yunzai 插件方法，或读取 JSON / 文本。每个动作独立保存提示词、默认参数、分类、别名、输入要求、最低角色和优先级；复制动作只复制预设，共享原工具实现。列表上方提供“工具示例 · 手办化”和“源码示例 · 源码问候”两个预填入口，保存后默认停用，也可从工具详情、Custom 工具测试参数创建动作草稿。源码示例调用 `core/actions/example.ts` 编译后的 `greet` 函数，传入问候前缀和文字，返回 JSON 并提取 `data.text`；只在显式启用并触发后执行。

编辑器在下一步、保存和预览前检查输入，提示指令格式、优先级、源码引用、占位符、默认参数类型、必填项和回复字段路径等问题；点击错误可定位到对应步骤。服务端仍负责最终校验与权限判断。执行方式中的调用流程示例分别展示工具、函数、插件方法和文件读取的输入、参数、执行及回复；演示内容不会运行当前动作。

执行参数直接展示工具声明的字段、必填标记、默认值和说明；数组与对象可填写 JSON。渠道和密钥通过「渠道与变量」进入工具配置，不保存在动作预设中。直接绑定 `web_search` 时需要启用百度 AI 搜索或 Tavily 并配置密钥；`source=auto` 只选择已启用渠道，不能使用模型对话专属的 OpenAI 原生搜索。列表、编辑器与参数预览会提示缺少的搜索配置，预览不会发起请求。

“默认要求”支持 `{{text}}`（指令后的补充文字）、`{{userName}}`（群名片优先，其次昵称、用户 ID）、`{{userId}}`（用户 ID）和 `{{groupId}}`（群 ID，私聊为空）。普通文字模式下，未写 `{{text}}` 时补充文字自动追加；参数名=值模式下 `{{text}}` 为空。其他默认参数不替换占位符。回复文字模板仅支持 `{{value}}`，表示提取后的结果，未指定字段时使用完整结果。

保存并启用后，发送图片或引用图片，再使用 `#yui手办化`。`#yui快捷指令` 按当前用户权限列出动作，`#yui指令说明 手办化` 查看输入要求。默认触发角色是所有用户，仍须通过工具启停、角色边界及项目访问控制。新增和修改动作不自动启用关联工具。

优先级数字越小越先执行。普通规则是默认阶段；高级设置中的前置触发参与 Yunzai `accept` 阶段，该阶段先于所有普通规则。配置保存后动态更新本插件条目，无需重启；同阶段、同优先级的重复指令不能同时启用，固定管理命令不能被覆盖。当前只支持统一 `#yui` 前缀。

预览只模拟输入和权限，不读取图片或执行工具。实际试跑使用已保存动作，会真实执行；生图等后台任务可以继续查看状态，浏览器没有机器人会话投递目标。导入动作默认停用，配置包不包含工具代码或运行凭据。Skill 与自然语言触发保留为后续扩展，本版提供确定性的工具与源码动作。

结果默认自动回复：文本直接显示，明确带图片扩展名的 URL 作为图片，普通 URL 保留为链接，JSON 整理为可读文本。需要自定义时，可填写 `data.text` 或 `data.images[0].url` 提取字段，使用 `{{value}}` 组合回复文字，或选择图片、标准消息体（`parts` / `chain`）回传。粘贴返回值样例即可预览并点击字段，不必实际执行。源码已经自行回复时不会重复追加消息。

源码函数接收 `(args, context)`，默认将指令后的文字放入 `args.text`；插件方法以新建实例为 `this`，设置 `this.e`，接收 `(e, args, context)`。需要让既有插件方法解析另一段消息时，可以勾选“用默认要求和补充文字作为方法收到的消息”，只替换消息文字，保留调用者与会话身份。源码只在触发时导入，继续经过 Custom 工具策略与执行保护；复制动作共享资源文件，不复制源码。仅修改预设不改变源文件。不同插件的方法参数和初始化要求可能不同，复杂初始化仍适合用 Custom Tool 包装。
