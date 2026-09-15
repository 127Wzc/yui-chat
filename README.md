# Yui Chat

面向 TRSS-Yunzai 的 AI 插件，支持多供应商模型、群聊上下文、长期记忆、媒体与工具扩展。默认命令前缀为 `#yui`，自然呼叫为“埋埋”。

## 安装与更新

在 Yunzai 根目录执行：

```sh
git clone -b main --depth=1 https://github.com/127Wzc/yui-chat.git ./plugins/yui-chat
pnpm i
```

安装脚本自动构建运行文件，完成后重启 Yunzai。插件目录名必须为 `yui-chat`。若跳过安装脚本，手动构建：

```sh
cd plugins/yui-chat
pnpm run build:runtime
```

更新时在插件目录执行 `git pull`，回到 Yunzai 根目录运行 `pnpm i`，然后重启。

## 开始使用

主人发送 `#yui面板` 获取一次性管理链接（3 分钟有效），在「模型与回复」添加供应商和模型，设置默认回复任务。工具启停、权限和动作快捷指令也在管理台配置。

| 指令 | 用途 |
| --- | --- |
| `#yuichat 你好` / `埋埋 你好` | 开始聊天 |
| `#yui帮助` | 查看完整指令帮助 |
| `#yuihelp 怎么查体力` | 推荐机器人指令 |
| `#yui结束对话` | 清空当前个人会话，下一次重新开始 |
| `#yui我的记忆` | 查看自己的长期记忆及管理用法 |
| `#yui他的记忆 @成员或QQ号` | 查看指定成员记忆（主人，也支持“她的记忆”） |
| `#yui管理记忆 @成员或QQ号` | 管理指定成员记忆（主人） |
| `#yui文本模式` / `#yui图片模式` / `#yui语音模式` | 切换个人输出模式 |
| `#yui定时任务` | 查看自己的提醒 |
| `#yui诊断` | 查看运行状态（主人） |

群聊以当前发言人为主对话对象，群窗口只提供参考。结束对话清空个人主线，保留群窗口、长期记忆和知识库。

配置通过管理台维护，长期数据位于 Yunzai 的 `data/yui-chat/`；插件 `cache/` 仅存临时文件。配置包不包含聊天、记忆和日志正文。

## 文档

- [内置工具](docs/builtin-tools.md)
- [架构与数据流](docs/architecture.md)
- [Responses 与上下文压缩](docs/responses-api.md)
- [工具开发](docs/tool-authoring-guide.md) · [Custom 框架资源](docs/custom-framework-resources.md)
- [SQLite 表结构](docs/sqlite-baseline-er.md) · [维护约束](AGENTS.md)

开发检查：在插件目录运行 `npm run check`。
