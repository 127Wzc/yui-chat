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
| `render_image` | 自动识别 Markdown、HTML、数学公式，或选择文本卡片、Mermaid、思维导图，使用统一主题生成图片 |
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

项目默认带有一个名为 `imagTag-mcp` 的 Streamable HTTP MCP 模板，地址为 `https://imag-tag.559558.xyz//api/v1/mcp/public`，只允许 `search_images`，服务和全局 MCP 开关都默认关闭；启用后该服务的最低角色默认为普通用户，所有用户均可使用已开放的只读搜图工具。启用服务后，它会以真实的 `mcp_imagTag-mcp_search_images` 工具出现在统一工具列表和日常定格渠道选择中；默认适配器固定传入 `match: "semantic"`、`sort: "relevance"`，从 `structuredContent.images` 读取候选。

意图任务把完整语境放在 `keyword`，`tags` 只保留最多两个确认存在且必须匹配的硬标签。带标签检索没有候选时，适配器会记录一次 `TAG_FILTER_NO_MATCH` 诊断，并用相同关键词省略标签重试一次；工具错误不会重复请求，而是按主渠道、回退渠道继续处理。

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

日常定格默认：对话后与旁观候选分组全部选中；旁观判断最短间隔 60 分钟（群聊停顿 20 秒后触发检查）；冷场冒泡在 09:00–23:00 每 60 分钟检查一次，要求群内安静至少 60 分钟；图片在同一会话 6 小时内不重复。各入口仍需显式启用，群聊仍受白名单、概率和每日配额限制。

### 统一图片渲染

默认 `send:true`，一次调用完成渲染和发送；只有用户明确要求预览或不发送时才使用 `send:false`（仅返回完成状态，不向模型返回预览图），不要例行先预览再重新渲染发送。输出为静态 PNG，不支持动画输出。HTML 内容样式与统一外框隔离，使用窄边框和紧凑顶部标题，副标题置于页脚；按完整内容自动适配尺寸，固定宽度画布收拢外框，普通内容渲染不使用 `viewport` 或 `fullPage` 裁切参数。

统一使用 `render_image({ format, data, send })`，内容放在 `data.content`，可选 `data.title`、`data.subtitle`。不再使用 `template`、`data.html`、`data.markdown` 或独立 HTML 工具。

| format | 内容 |
| --- | --- |
| `auto`（默认） | 明确的 HTML 标签按 HTML 渲染，其他内容按 Markdown；有 sections 时使用文本卡片 |
| `html` | HTML/CSS 片段或完整文档，使用统一主题；自定义 CSS 可覆盖 |
| `markdown` | Markdown、`$...$` / `$$...$$` / `\(...\)` / `\[...\]` 数学公式及 Mermaid 代码块 |
| `mindmap` | Markdown 层级结构生成思维导图 |
| `text` | 普通文本，或 `data.sections` 中的 title / lines 分段卡片 |

例如：`render_image({"format":"markdown","data":{"title":"公式说明","content":"面积：$S=\\pi r^2$"}})`；HTML 示例：`render_image({"format":"html","data":{"title":"状态","content":"<h1>服务正常</h1><p>当前运行稳定。</p>"}})`。

HTML、Markdown、思维导图和文本卡片共用 `render_image` 的启停、角色和模型权限，不设置额外 HTML 权限或开关。HTML 固定使用 HTML 渲染，无 SVG 回退；Markdown 中的 HTML 示例不作为页面执行。数学公式与 Mermaid 统一使用 Markdown，无独立格式。图片按内容标注 HTML、Markdown 或 Mindmap。

URL 截图仍使用 `render_url_screenshot`，保留独立工具权限及 `response.render.url.enabled` 开关（默认关闭），网络策略仍由 `security.linkSafety` 控制。

### AI 绘画与内容排版的区别

- `generate_image`：用户要求画一个人物、创作插画或风景、生成新图片、修改参考图时使用，调用实际图片模型。
- `render_image`：用户要求把已有 Markdown、HTML、公式、表格或文字排版成图片时使用。

“用画图工具画一个角色”应搜索并调用 `generate_image`，不能把角色的文字描述做成卡片后声称已经画好。绘画工具不可用、未配置或失败时，应说明原因，不用排版工具冒充绘画结果；后台绘画只有图片实际返回后才可声称完成。
