# 内置工具

在管理台启用工具并设置权限，由模型按对话需要调用；也可在动作中心绑定快捷指令。工具的可用性同时受模型能力、配置和宿主权限限制。

主人可用 `#yui工具参数 <工具名>` 查看当前参数，用 `#yui测试工具 <工具名> 参数=值` 实际试跑。

## 工具目录

| 工具 | 功能 |
| --- | --- |
| `knowledge_manage` | 检索、管理知识库，推荐和转交机器人指令 |
| `memory_manage` | 检索、维护长期记忆与用户画像 |
| `tool_search` | 按需求发现可用工具 |
| `web_search` | 联网搜索 |
| `website_fetch` | 读取网页内容 |
| `github_api` | 查询 GitHub 信息 |
| `weather` | 查询天气 |
| `bilibili_media` | 查询与获取 B 站媒体 |
| `image_media` | 搜索、获取图片 |
| `music_play` | 搜索歌曲并发送音乐卡片和音频 |
| `generate_image` | 图片生成与编辑 |
| `message_send` | 发送文本、图片、音频等消息 |
| `render_image` | 将文本、图表等内容渲染为图片 |
| `render_html_screenshot` | 渲染 HTML 截图 |
| `render_url_screenshot` | 网页截图 |
| `query_userinfo` | 查询用户信息 |
| `block_user` | 管理插件用户黑名单 |
| `schedule_task` | 创建、查看和取消定时提醒 |
| `mute_user` / `kick_out` | 禁言、移出群成员 |
| `edit_card` / `set_title` | 修改群名片、专属头衔 |
| `emoji_like` / `group_poke` | 表情回应、戳一戳 |
| `message_manage` | 群消息管理 |
| `send_dice` / `send_rps` | 掷骰子、猜拳 |
| `dispatch_subagent` | 派发子代理任务，默认关闭 |

Responses 的 `file_search` 是供应商托管能力，需配置 Vector Store；托管搜索与本地搜索的选择见 [Responses 协议](responses-api.md)。

## 音乐播放

对话示例：`埋埋，播放晴天 周杰伦`。`music_play` 接收 `keyword`（歌曲名或歌曲名加歌手），发送搜索命中的第一首。当前来源为 QQ 音乐。

先发音乐卡片，再单独发音频；卡片失败则停止，音频失败保留已发卡片并报告，不自动重发。普通对话需同时启用“音乐播放”和“消息发送”。播放受歌曲版权、接口和宿主音频能力限制。

## 使用边界

- 群管、网络读取、截图和子代理分别受权限及功能开关约束；启用工具不会绕过这些检查。
- 动作新建时继承工具权限，保存后独立控制启停与最低角色；模型会话专用工具不能绑定动作。
- 语音输出由回复模式控制，Skill 提供提示词；两者不作为独立内置工具列出。

开发或扩展工具见 [工具开发指南](tool-authoring-guide.md)。
