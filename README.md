# Yui Chat

面向 TRSS-Yunzai 的 AI 插件，支持多供应商模型、群聊上下文、长期记忆、媒体处理和工具扩展。

## 功能

- **对话与模型**：多渠道接入、任务选模、失败回退、流式响应和上下文压缩。
- **人格与互动**：自定义人设、文字/图片/语音回复、日常定格。
- **记忆与知识**：个人及群记忆、独立模型混合召回、按需全量查看、按日增量提炼、[AI 整理与逐项审核](docs/architecture.md#ai-记忆整理)、月度聊天画像、知识检索和机器人指令推荐。
- **工具与扩展**：内置工具、Custom、Markdown Skill、MCP，以及动作快捷指令。
- **Web 管理台**：配置、角色与用户权限、对话测试、调用日志和用量统计。

<details>
<summary>运行预览（点击展开）</summary>

### 首页

![首页](docs/screenshots/runtime-overview.jpg)

### 模型与回复

![模型与回复](docs/screenshots/runtime-models.jpg)

### 日常定格

![日常定格](docs/screenshots/runtime-daily-still.png)

### 知识库与 RAG 召回

![知识库与 RAG 召回](docs/screenshots/runtime-rag.png)

### 记忆管理

![记忆管理](docs/screenshots/runtime-memory.png)

### AI 能力

![AI 能力](docs/screenshots/runtime-tools.jpg)

</details>

## 安装与更新

在 Yunzai 根目录执行：

```sh
git clone -b main --depth=1 https://github.com/127Wzc/yui-chat.git ./plugins/yui-chat
pnpm i
```

安装后重启 Yunzai。插件目录名必须为 `yui-chat`。安装脚本会自动构建运行文件；若跳过脚本或构建失败，在插件目录执行 `pnpm run build:runtime`。

更新时在插件目录执行 `git pull`，回到 Yunzai 根目录运行 `pnpm i`，然后重启。

## 开始使用

1. 主人发送 `#yui面板`，通过一次性链接登录管理台。
2. 在「模型与回复」添加渠道和模型，选择默认回复模型。
3. 在「助手人设」调整人格；在「AI 能力」启用所需工具并设置角色权限。
4. 发送 `埋埋 你好` 或 `#yuichat 你好` 开始对话。

如需固定 Web 登录令牌，在管理台「系统设置 → 运行与登录 → Web 访问与登录」设置；留空时可继续使用主人一次性链接。

默认命令前缀为 `#yui`，自然呼叫为“埋埋”，均可配置。工具启用与授权分别控制；「使用权限」可设置用户例外，群管理操作仍受实际身份和机器人权限限制。

## 常用指令

| 指令 | 用途 |
| --- | --- |
| `#yui帮助` | 查看完整指令帮助 |
| `#yuihelp 怎么查体力` | 推荐机器人指令 |
| `#yui结束对话` | 清空个人会话，保留群窗口、长期记忆和知识库 |
| `#yui我的记忆` | 查看自己的记忆及管理用法 |
| `#yui他的记忆 @成员或QQ号` | 主人查看指定成员记忆，也支持“她的记忆” |
| `#yui管理记忆 @成员或QQ号` | 主人管理指定成员记忆 |
| `#yui我的画像 [类型] [发言条数]` | 采集群内生成画像，默认正画像、200 条，可指定 50–2000 条；每种类型每人每群每月一次，已有副本直接返回 |
| `#yui画像` / `#yui正画像` / `#yui负画像` / `#yui找对象` / `#yui克隆人格` | 为自己生成对应类型的画像；克隆人格提供可复制模板 |
| `#yui查看画像 [类型]` | 查看自己的本群对应类型副本，不调用模型 |
| `#yui查看画像 @成员或QQ号 [类型]` / `#yui重提炼画像 @成员或QQ号 [类型] [发言条数]` | 主人查看或重提炼指定成员的本群画像 |
| `#yui文本模式` / `#yui图片模式` / `#yui语音模式` | 切换个人回复模式 |
| `#yui定时任务` | 查看自己的提醒 |
| `#yui诊断` | 主人查看运行状态 |

指令知识支持页面即时采集已加载指令，再通过[外部整理与导入流程](docs/command-knowledge.md)在外部整理后增量维护。

配置通过管理台维护。长期数据位于 Yunzai 的 `data/yui-chat/`，临时文件位于插件 `cache/`；配置包不包含聊天、记忆和日志正文。

## 技术栈

| 层次 | 技术与用途 |
| --- | --- |
| 运行与构建 | Node.js ESM、TypeScript；编译到 `output/runtime/`，由 TRSS-Yunzai 加载 |
| 管理台 | Vue 3、TypeScript；Express 路由与宿主 WebSocket 提供接口 |
| 数据存储 | SQLite（better-sqlite3），Worker 执行数据库操作；sqlite-vec 支持向量检索 |
| 模型与扩展 | 多供应商协议适配、MCP SDK、Custom 工具和 Markdown Skill |
| 图片处理 | Puppeteer 渲染 HTML，Sharp 处理图片与 SVG |

## 架构概览

```mermaid
flowchart LR
    Chat["Yunzai 消息 / 命令"] --> Pipeline["对话流程<br/>访问控制 · 上下文 · 工具循环"]
    Web["Vue 管理台"] --> API["鉴权 API / WebSocket"]
    API -->|对话测试| Pipeline
    API -->|配置与管理| Services["配置 / 记忆 / 知识 / 扩展"]
    Services -->|上下文与能力| Pipeline
    Pipeline --> Models["任务选模 / 协议适配"]
    Pipeline --> Tools["工具 Registry<br/>内置 / Custom / MCP"]
    Pipeline --> Delivery["文本 / 图片 / 语音投递"]
    Services --> Storage["SQLite / 文件存储"]
```

入口共用对话与权限逻辑，模型协议、工具执行和数据存储各自独立。详见 [模块边界与对话流程](docs/architecture.md)。

## 文档

- [内置工具与权限](docs/builtin-tools.md) · [指令知识与 RAG](docs/command-knowledge.md)
- [扩展安装](docs/extension-installation.md)
- [架构与数据流](docs/architecture.md) · [Responses 与上下文压缩](docs/responses-api.md)
- [工具开发](docs/tool-authoring-guide.md) · [Custom 框架资源](docs/custom-framework-resources.md)
- [SQLite 表结构](docs/sqlite-baseline-er.md)
- [更新记录](CHANGELOG.md) · [待办](TODOLIST.md) · [维护约束](AGENTS.md)

开发检查：在插件目录运行 `npm run check`。
