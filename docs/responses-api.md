# Responses API 协议

Yui Chat 将 Responses 作为新的模型协议能力接入，不复制 Agent Core。对话历史、工具权限、参数校验、执行器、循环保护、副作用账本、超时和日志继续与 Chat Completions 共用。

## 落地目录

```text
core/chat/
├── model-step-executor.ts          # 协议无关的 Agent Loop
├── tool-round-executor.ts          # 统一 Function Tool 执行与结果回填
└── agent-turn-state.ts             # 工具轮次和终态保护

tools/
├── support/{tool-contract,contract,registry}.ts
├── access/                          # 权限、角色与边界
└── builtins/                        # 本地 Builtin Functions

models/
├── protocol/                        # 统一消息、工具调用、响应与用量
├── configuration/tool-policy.ts     # 能力名单与实现路由策略
└── adapters/openai/
    ├── chat/
    │   ├── adapter.ts
    │   ├── request-adapter.ts
    │   ├── response-adapter.ts
    │   └── stream-adapter.ts
    └── responses/
        ├── adapter.ts
        ├── request-adapter.ts
        ├── response-adapter.ts
        ├── state-machine.ts
        └── tool-adapter.ts
```

这个目录借鉴“runtime / tools / providers”的分层，但保留本项目已经稳定的职责：Agent 运行时在 `core/chat`，工具在 `tools`，供应商协议只在 `models/adapters`。不得在 Responses 目录重新实现工具执行器或权限系统。

## 配置

在管理台的模型编辑器把“对话协议”设为 `Responses API`。对应模型配置形态：

```json
{
  "adapter": "openai-responses",
  "toolPolicy": {
    "mode": "inherit",
    "allow": [],
    "deny": [],
    "routes": {
      "web_search": {
        "source": "auto",
        "strategy": "preferred"
      },
      "tool_search": {
        "source": "auto"
      }
    }
  },
  "responses": {
    "stateMode": "auto",
    "store": false,
    "parallelToolCalls": true,
    "webSearch": { "params": {} },
    "fileSearch": {
      "enabled": false,
      "vectorStoreIds": [],
      "maxNumResults": 8,
      "params": {}
    }
  }
}
```

- `web_search` 与 `tool_search` 的启停和来源只由工具管理上限、模型名单及 `toolPolicy.routes` 决定；`responses` 不再保存第二套开关。
- `fileSearch` 只有在管理员提供至少一个 OpenAI Vector Store ID 后才能开启。
- `stateMode=auto`（默认）优先使用 `previous_response_id`，只发送新增输入；已知的上游链或 Function Call 关联失效时，最多自动执行一次本地无状态恢复并建立新链。
- `stateMode=previous_response_id` 是严格上游模式：保存 Response ID、强制 `store: true`。普通 Response ID 断链时直接失败并交给既有模型渠道 fallback；如果代理只丢失当前轮 `function_call_output` 对应的 Function Call，则有界重放当前请求中已经匹配的调用/结果对一次，以完成工具状态机要求的最终回复。恢复只重放结果，不会重新执行工具。
- `stateMode=local` 每次发送有界本地历史；`store` 由模型配置决定，关闭上游存储时会请求可重放的加密 reasoning item。
- 无论采用哪种上游上下文模式，本地仍保存可见消息、工具链与协议状态，用于审计、清理、TTL 和故障回退。
- `store` 在本地回放模式默认关闭；Response ID 链模式会忽略该开关并强制开启上游响应存储。
- 工具管理的 `tools.hosted.openai` 是所有模型共享的 OpenAI 托管工具安全上限；模型页只能进一步收窄。
- `toolPolicy.mode` 支持 `inherit`、`allowlist`、`denylist`。名单只接受稳定能力或工具 ID，例如 `web_search`、`file_search`、`tool_search`、`message_send`；`openai:*` 与 `local:*` 只用于运行日志标识具体实现，不能写入配置。
- 模型编辑器使用可搜索的多选工具目录维护白名单/黑名单，只展示工具管理处当前启用的本地、Custom、MCP 与 OpenAI 托管工具；已保存但当前目录不存在的未知工具 ID 会保留为可移除项，已知但全局停用的工具不出现在选择框中。
- `routes.web_search.source` 与 `routes.tool_search.source` 支持 `auto`、`hosted`、`local`、`disabled`。`auto` 在 Responses 模式优先使用原生实现，托管实现被工具管理策略关闭或协议不支持时使用本地实现。
- `routes.web_search.strategy` 支持 `preferred`、`fallback`、`parallel`，默认 `preferred`。当 OpenAI 是唯一可用渠道时，无论继承何种聚合策略都直接走原生 Responses：同一响应中的 `web_search_call` 负责检索，最终 assistant `message` 直接作为回答，不再额外总结。只要百度、Tavily 等本地渠道参与，`fallback` 与 `parallel` 就会经过本地 `web_search` 门面，并产生一条独立 Responses 托管搜索子请求；各渠道证据归一化后由主模型只做一次最终综合。`parallel` 按渠道轮询取结果后再按 URL 去重与截断，避免靠前渠道耗尽结果额度。托管子请求的 assistant 摘要只保存一份 `hostedDigest`，不会复制到每条来源。子请求不推进主会话的 `previous_response_id`，但模型用量、原始托管 output item 和工具事件均进入统一日志。
- 原生工具只有在工具总开关、角色边界、托管工具全局开关和模型名单全部允许时才加入请求；缺少运行时权限上下文时默认关闭。
- 工具库中的单工具启停是配置策略热更新：保存后下一次模型选取工具时立即生效，不重建工具目录，也不重连 Custom/MCP；只有扩展安装、更新或显式刷新目录才重新初始化 Registry。

## 工具转换与多轮调用

统一 Tool 在 Chat Completions 中转换为嵌套 `function`；在 Responses 中转换为顶层 Function Tool。`ToolCommon.deferLoading` 会映射为 `defer_loading`，原生 `tool_search` 开启时不会再暴露同名本地发现函数；OpenAI 是唯一 Web Search 渠道或作为直接首选时，也不会重复暴露同名本地搜索函数。`fallback` 与 `parallel` 在本地渠道可用时调用 `web_search` 聚合门面，其中 `parallel` 并发调度托管与本地实现。

Responses 返回本地 `function_call` 后，调用仍进入 `toolRegistry → execution-runtime → Tool Executor`。结果以 `function_call_output` 回传。`stateMode=local` 时，适配器保存并按原顺序回放 Responses output items；`store: false` 时同时请求加密 reasoning item。使用上游链时，以“本地会话 + 实际渠道 + Provider + 模型”隔离保存滚动 Response ID，后续只发送新增输入。

## 会话状态恢复流转

Responses 会话状态由独立的协议状态机管理，与 `AgentTurnState`/`execution-runtime` 的工具执行状态机分开：前者只决定请求是否携带上游 ID、是否重放本地检查点；后者继续负责工具权限、参数校验、执行、重试、循环保护和副作用账本。协议恢复不会重新执行工具。

```text
本地会话历史 + 当前轮完整 Responses output / function_call_output
                          │
                          ├─ local ───────────────→ 有界无状态请求
                          │
                          └─ auto / strict ───────→ previous_response_id + 本轮增量输入
                                                        │
                                  成功 ─────────────────┤→ 保存新 Response ID
                                                        │
                                  已知断链错误 ──────────┘
                                          │
                         ┌────────────────┴────────────────┐
                         │ auto                            │ strict
                         ↓                                 ├─ Response ID 丢失 → 当前渠道失败 / fallback
             构造一次有界本地恢复检查点                   │
             清除 previous_response_id                    └─ 当前轮 Function Call 关联丢失
             保留匹配的 function_call/output 对                         │
             丢弃孤立、未完成或重复的工具协议项                         ↓
                         │                              有界重放已匹配工具对一次
                         └──────────────┬──────────────────┘
                                        ↓
                              成功后保存新的 Response ID
```

自动模式识别两类可安全恢复的错误：上游 `previous_response_id` 不存在，以及代理未保留 `function_call_output` 对应的 Function Call。严格上游模式只允许修复后一种当前轮工具关联错误，不恢复普通断链。恢复输入采用和普通上下文相同的 Token 预算；旧的已完成工具内部日志、失败项和重复/孤立协议项仍保留在本地审计中，但不会为了恢复而重新执行。当前轮已成功执行且调用与输出匹配的工具对会完整重放，保证模型可以继续总结其结果。第二次无状态请求仍失败时立即退出，不循环重建新链。

正常链接请求不会发送本地恢复检查点，因此不增加常态请求 Token；自动模式会额外请求可重放的加密 reasoning 数据。发生恢复时，模型日志记录恢复原因、重放消息数和丢弃的无效工具项数，并在运行链路中标记“上下文已恢复”。

`web_search_call`、`file_search_call`、`tool_search_call` 和 `tool_search_output` 由 OpenAI 执行，不进入本地 Function Executor。运行时会把真实调用转换成名称为 `openai:web_search`、`openai:file_search`、`openai:tool_search`，来源为 `openai-hosted` 的只读远程工具记录，写入统一工具调用链、模型日志和本地会话轮次。工具事件会保存上游实际返回的对应 output item，沿用日志凭证脱敏并最多保留 16000 字符；模型调用元数据仍只保存类型、状态、查询、结果数量、来源 URL 和加载工具名，避免重复保存正文。加密 reasoning 不进入工具日志。

日志中的计数表示“工具事件”，不是互不相关的搜索次数。聚合模式下会同时显示本地 `web_search` 门面和带 `parent_tool_id` 的 `openai:web_search` 派生事件；后者是前者内部唯一一次托管搜索。管理台会把派生事件标记为“派生调用”，不会为了简化数字而丢失真实的计费与排障记录。

原生 Web Search 请求会自动包含 `web_search_call.action.sources`，File Search 会请求 `file_search_call.results`。返回来源会去重并在最终正文后以“OpenAI 远程搜索来源”合并转发，和本地 `web_search` 的来源投递方式保持一致。发送到 QQ 的正文会把与结构化来源匹配的 Markdown URL 引用替换为 `¹`、`²` 这类 Unicode 小角标，URL 只保留在来源转发与审计日志中；普通非搜索链接不受影响。代理没有转发的字段无法在本地补造，日志会如实显示实际收到的 output item。

图片或表情包请求使用专用 `image_media` 能力，并关闭该轮原生通用 Web Search，避免模型为同一媒体意图重复搜索。`image_media.searchMode=deep` 或工具管理处的 `parallel` 策略会并行查询全部已启用图片渠道；图片默认把原始 URL 交给 `message_send`，只有管理员开启“本地缓存已选图片”后才下载到插件缓存。成功投递仍保留 `continueConversation`，Responses 必须完成一次最终自然回复。当前 OpenAI `web_search` 不被伪装成图片搜索实现，未来上游提供真正的图片搜索能力时可作为新的实现接入同一门面。

## 当前边界

- Chat Completions 行为、流式解析和现有工具选择保持不变。
- Responses 当前使用非流式 HTTP；Streaming 稳定后再补。
- 当前支持模型级 `auto`、严格 `previous_response_id` 和 `local` 三种状态模式；Responses Conversations 尚未接入，且不能与 `previous_response_id` 同时使用。
- OpenAI 执行的 Built-in Tools 不进入本地 Function Executor；本地 Function Calling 仍完整受权限与副作用控制。
- 本版本不迁移旧 `toolPolicy.sources`、`toolPolicy.strategies`、模型级 `responses.webSearch.enabled/toolSearch`、`fallbackEnabled` 或名单中的实现前缀。配置载入时会直接丢弃这些字段并按新版默认值处理；不会猜测旧值对应的新路由语义。
