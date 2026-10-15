# Responses 与上下文压缩

在管理台模型编辑器将“对话协议”设为 `Responses API`。对话、权限、工具执行和输出流程与其他协议共用，供应商转换位于 `models/adapters/openai/responses/`。

## 会话模式

| `responses.stateMode` | 行为 |
| --- | --- |
| `auto`（默认） | 私聊优先续接 Response ID；已知断链时最多一次本地重放 |
| `previous_response_id` | 严格续接；普通断链交给渠道 fallback，仅当前轮工具关联丢失允许一次配对重放 |
| `local` | 每次发送有界本地上下文 |

群聊每个新回合从本地个人历史和当前窗口资料重建，不链接上轮 ID；同轮工具回传仍可续接。私聊保留上游链，不因本地明文历史超预算断链；实际断链恢复时才重放有界本地输入。所有模式保留本地可见历史和审计，结束对话清除对应会话及协议状态。

ID 续接模式强制 `store: true`；本地模式由 `responses.store` 控制，默认关闭。恢复只重放已执行且配对的工具结果，不重复执行工具；再次失败即退出。Responses Conversations 尚未接入。

工具调用必须带有上游的非空且不重复 `call_id`，执行和回放使用同一个值。缺失或重复时在执行前报错，不使用输出项 `id` 或随机 UUID 冒充调用 ID。

本地会话归属键（渠道、群、用户）保持稳定；每段会话另有独立 UUID `session_id`，随会话状态持久化。结束或过期后新建 ID，日志的完整会话按该 ID 关联；`run_id` 标记其中一次运行。旧日志没有可靠会话边界，仅保留单次运行视图，不再按归属键混合。

## 服务端压缩与本地裁剪

Responses 对话统一使用 `POST /responses`，携带 `context_management: [{ type: "compaction", compact_threshold: ... }]`。阈值取可用输入预算的 80%，预算优先采用模型上下文窗口，未配置时使用全局输入预算，并预留输出空间。服务端根据真实 token 数决定是否在推理过程中压缩。

返回的加密 `compaction` 项与其他输出项一起原样回放，不转成摘要、不截断加密正文；Response ID 续接仍只发送增量。本地安全预算仍对超出窗口的工具结果和旧历史裁剪。日志分别标记“自动压缩已开启”和“对话含上下文压缩”，后者只在实际收到 compaction 项时展示。压缩与对话共享一次上游调用及 usage，不伪造独立压缩用量。

压缩状态用于当前步骤与工具续接，不写入聊天正文。个人可见历史仍按原有条数上限保留。Chat、Claude、Gemini 等协议共用本地预算裁剪：超预算时先缩短工具出入参，再整组删除较旧历史；系统提示和当前问题始终保留。这是确定性的裁剪，不额外调用模型生成摘要，日志在实际裁剪时标记“本地压缩”。

Responses 遇到明确的服务端压缩错误（含压缩参数不受支持）或上下文超限时，最多一次使用本地有界上下文重试同一个 `/responses` 接口，移除 `context_management`、旧 Response ID 和加密协议状态，保留当前问题及配对的已执行工具结果；上下文超限时进一步缩小本地预算。日志标记“本地压缩兜底”，记录原因、裁剪前后预算和实际重试请求。本轮后续请求暂停服务端压缩；鉴权、限流、取消、网络失败和无关错误不触发此重试，兜底再次失败才交给原有渠道 fallback。依据 [OpenAI 压缩文档](https://developers.openai.com/api/docs/guides/compaction)。

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
