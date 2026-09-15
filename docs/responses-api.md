# Responses 与上下文压缩

在管理台模型编辑器将“对话协议”设为 `Responses API`。对话、权限、工具执行和输出流程与其他协议共用，供应商转换位于 `models/adapters/openai/responses/`。

## 会话模式

| `responses.stateMode` | 行为 |
| --- | --- |
| `auto`（默认） | 私聊优先续接 Response ID；已知断链时最多一次本地重放 |
| `previous_response_id` | 严格续接；普通断链交给渠道 fallback，仅当前轮工具关联丢失允许一次配对重放 |
| `local` | 每次发送有界本地上下文 |

群聊每个新回合从本地个人历史和当前窗口资料重建，不链接上轮 ID；同轮工具回传仍可续接。私聊完整本地历史超预算时也重建输入。所有模式保留本地可见历史和审计，结束对话清除对应会话及协议状态。

ID 续接模式强制 `store: true`；本地模式由 `responses.store` 控制，默认关闭。恢复只重放已执行且配对的工具结果，不重复执行工具；再次失败即退出。Responses Conversations 尚未接入。

## Compact 与本地裁剪

超过输入预算时，优先调用当前渠道的 `POST /responses/compact`：

- 只压缩本轮发言之前的完整历史，保留本轮身份、群资料及工具链。
- 返回的全部 `output` 项原样用于后续请求，不转成文本摘要。
- 每个模型步骤最多尝试一次，超时不超过 30 秒；调用和用量进入统一日志。
- 接口不支持、失败、返回无效或结果仍超预算时，回到原始输入执行本地工具结果截短和旧历史裁剪；其他协议直接走本地处理。

压缩结果仅用于本次模型步骤及工具续接，不写入个人聊天正文、不跨轮保存。个人历史仍按原有条数上限保留。预算优先采用模型上下文窗口，未配置时使用全局输入预算，并预留输出空间。

## 工具来源

本地工具执行方式见 [内置工具](builtin-tools.md)。Responses 还支持供应商托管的搜索能力：

| 能力 | 配置 |
| --- | --- |
| `web_search` | `toolPolicy.routes.web_search` 选择来源和策略 |
| `tool_search` | `toolPolicy.routes.tool_search` 选择来源 |
| `file_search` | `responses.fileSearch` 配置启用状态及 Vector Store ID |

`tools.hosted.openai` 是全局上限，模型名单只能进一步收窄。`toolPolicy.mode` 支持 `inherit`、`allowlist`、`denylist`，名单保存稳定工具 ID；`openai:*`、`local:*` 仅为日志标识。

搜索来源支持 `auto`、`hosted`、`local`、`disabled`；Web Search 策略支持 `preferred`、`fallback`、`parallel`。图片搜索由本地 `image_media` 提供，不以网页搜索替代。

托管工具由供应商执行，记录到统一调用链；本地 Function Tool 仍经 Registry。流式响应在适配器内聚合为完整结果，工具循环与投递方式不变。

## 排查

模型日志可查看实际请求、用量、工具事件和断链恢复原因。网络错误摘要保留状态码、超时与连接错误，隐藏凭证、查询参数和请求体。先核对具体调用记录，再检查渠道地址、模型能力及供应商服务状态。
