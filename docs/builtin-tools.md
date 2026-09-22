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

## 日常定格渠道

日常定格不再注册一个重复的 `sticker_search` AI 工具。它只从统一 Tool Registry 中读取真实的内置、MCP 或 Custom 工具，并在内部套用声明式适配器：把 `keyword`、`tags`、`count` 映射到渠道入参，把返回结果映射为图片候选。表达意图、概率、冷却、去重、候选选择和投递仍由人格协调器统一处理。

项目默认带有一个名为 `imagTag-mcp` 的 Streamable HTTP MCP 模板，地址为 `https://imag-tag.559558.xyz/api/v1/mcp`，只允许 `search_images`，服务和全局 MCP 开关都默认关闭。启用服务后，它会以真实的 `mcp_imagTag-mcp_search_images` 工具出现在统一工具列表和日常定格渠道选择中；默认适配器固定传入 `match: "semantic"`、`sort: "relevance"`，从 `structuredContent.images` 读取候选。

其它图库只需注册一个只读工具，并在公共工具声明或 MCP 工具策略中加入 `stickerExpressionChannel`。除了契约版本外，还可以声明 `inputMapping`、`fixedArguments` 和 `outputMapping`，无需修改日常定格协调层即可切换主渠道和回退渠道。例如：

```json
{
  "version": 1,
  "input": "keyword-tags-count",
  "output": "images",
  "readOnly": true,
  "inputMapping": { "keyword": "query", "tags": "labels", "count": "limit" },
  "outputMapping": { "candidatesPath": "data.items", "urlField": "image_url" }
}
```

这个能力默认关闭。启用后，在日常定格页面选择符合统一渠道契约的主渠道和可选回退渠道，必要时调整候选数量、选择方式和去重窗口。日常定格页面中的所有时长输入统一使用秒；允许时段仍使用 `HH:mm` 时钟格式。普通用户使用时，还需要在工具边界中给绑定的图库工具配置相应的 `minRole`；适配器不会绕过原始工具权限。

如果不希望模型直接调用原始 MCP 搜图工具，可在 MCP 服务的“工具策略 JSON”中隐藏它：

```json
{
  "search_images": {
    "hiddenFromModel": true
  }
}
```

`hiddenFromModel` 只影响模型工具列表，不影响日常定格通过 Registry 选择已绑定渠道。保留 `sticker_pick` 不受影响；将来切换图库时，只需在日常定格页面选择符合契约的主/回退渠道，意图、去重和投递逻辑不变。

## 使用边界

- 群管、网络读取、截图和子代理分别受权限及功能开关约束；启用工具不会绕过这些检查。
- 动作新建时继承工具权限，保存后独立控制启停与最低角色；模型会话专用工具不能绑定动作。
- 语音输出由回复模式控制，Skill 提供提示词；两者不作为独立内置工具列出。

开发或扩展工具见 [工具开发指南](tool-authoring-guide.md)。
