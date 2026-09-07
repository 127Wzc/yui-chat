# 后端架构

## 启动与运行边界

`index.js` 是唯一的源码 JS 宿主入口，只校验并加载 `output/runtime/runtime-entry.js`；构建后的运行入口再依次加载配置、SQLite Worker、内置知识库和个人能力规则、工具注册表、指令观察器、第一人称监听、主动问候/定时提醒和过期缓存。Web 启用时再挂载 Express 子应用与 WebSocket。构建入口通过 `YUI_CHAT_PLUGIN_ROOT` 保持源码资源根和宿主数据根稳定。

插件身份统一为 `yui-chat`。除第一人称自然呼叫外，命令注册和服务端解析都从 `core/message/command-prefixes.ts` 的唯一前缀正则派生；默认前缀是 `#yui`，默认第一人称是“埋埋”。旧插件名、目录、路由、数据路径和命令不设兼容层。

运行文件不混放：权威默认值和 Schema 在 `config/defaults.ts`、`config/schema.ts`，忽略提交的 `config/config.json` 只保存 SQLite 启动参数与 Web Token，其余用户配置保存在 `state.sqlite3/runtime_config`；手动配置包位于 `data/yui-chat/backups/`。长期数据在 `data/yui-chat/`，缓存只在插件 `cache/`。`config/store.ts` 是配置合并与读写的唯一入口。测试或显式隔离运行可在加载前设置 `YUI_CHAT_RUNTIME_ROOT`；`npm run smoke` 会自动创建并清理隔离根，也可用 `YUI_CHAT_SMOKE_RUNTIME_ROOT` 保留现场，生产默认路径不变。

`web.publicBaseUrl` 是 SQLite 中的运行配置，不进入极简启动 JSON。它表示外部服务器地址前缀，可包含自定义域名、端口和反向代理路径，但不包含查询参数或锚点。主人执行 `#yui面板` 时，Web 鉴权模块在该前缀后统一拼接 `web.mountPath` 与单次快捷码；显式前缀会替代自动发现的公开地址，留空才读取 Yunzai 已知服务地址，并始终生成 localhost 后备地址。管理台只预览拼接形态，不签发真实快捷码。

## 目录规范

源码按职责而非文件历史存放：`apps/chat.ts` 只注册普通用户入口，`apps/master.ts` 集中注册全部主人管理指令并统一附加宿主 Master 权限，`apps/commands/` 放命令辅助实现；`core/` 分为 `chat`、`message`、`message-chain`、`persona`、`media`、`rendering`、`runtime`、`storage`、`network`、`shared` 和 `scheduling`；`models/` 分为 `adapters`、`protocol`、`configuration`、`routing`；用户扩展共用能力在 `extensions/`，模型工具在 `tools/{access,builtins,custom,integrations,support}/`，过滤器在 `filters/{authoring,builtins,core,custom,message}/`。Web 后端在 `web/http/`，管理台源码在 `web/client/`，由 TypeScript 编译为不打包的浏览器 ESM。源码只保留根目录 `index.js` 作为 Yunzai 宿主加载器；兼容转发文件不再是代码落点。

OpenAI 的两套对话协议按协议而不是按 Agent 复制实现：

```text
core/chat/                         # 共用 Agent Loop、Conversation、工具执行与保护
tools/                             # 共用 Registry、契约、权限与具体工具
models/
├── protocol/                      # 供应商无关的请求/响应
└── adapters/openai/
    ├── chat/                      # Chat Completions 请求、响应、流式入口
    └── responses/                 # Responses 请求、响应、会话状态机与 Function/Built-in Tool 转换
```

`models/adapters/openai-compatible.ts` 是既有 Chat 适配器的兼容边界；新代码和文档使用 `models/adapters/openai/chat/` 或 `models/adapters/openai/responses/` 的规范入口。不要在两个协议目录复制 Agent Loop、工具执行器或权限判断。

新增的 TypeScript 领域模块遵循“类型 → 归一化 → 组合/序列化 → 宿主适配”的单向依赖：`core/message-chain` 不读取宿主和网络；`models/protocol` 不感知具体供应商；`core/storage/contracts.ts` 只描述 Worker RPC；`types/host-runtime.d.ts` 是唯一的宿主全局类型声明入口。迁移期间 JS 入口可以调用这些协议，但不得在 JS 中重新定义一套相同的消息链或模型结果结构。

配置仓库使用单写事务队列。启动分两段：先读取极简 JSON 打开 SQLite Worker，再挂载 `runtime_config` 单行仓库并发布完整配置。`load()` 返回合并后的可编辑副本，`get()` 提供深度冻结的完整运行快照，读改写通过 `update()` 基于队列中的最新版本执行。每次提交归一化并校验完整候选值，再拆分启动项和其余稀疏覆盖；前者原子写入 JSON，后者写入 SQLite，全部成功后才更新内存快照与 revision，SQLite 失败时回滚 JSON。源码更新只影响没有被用户覆盖的字段。外部文件已标记 SQLite 主配置但数据库不可用或主配置行缺失时停止加载，避免以默认值启动。正常提交和恢复都不自动备份，管理员只能显式创建手动配置包。配置包同时保存逻辑运行配置覆盖与 SQLite 配置白名单（能力权限、知识库设置/授权）；不导出日志、用量、预算流水、聊天、记忆、知识正文和索引数据。普通配置请求只读取备份文件名、时间和大小，进入备份管理页后才按需检查包内安全元数据。配置包仅在同时超过 `system.backups.maxFiles` 的保护数量与 `system.backups.maxAgeDays` 的保护时间时自动清理，默认至少保留 3 份且 30 天内不清理；管理员也可明确删除单个配置包，非法配置隔离文件不参与自动清理策略。

小型整文件 JSON 仍使用 `core/storage/atomic-json-repository.ts`。权威交互数据由 `core/storage/sqlite/` 的 Worker RPC 管理：`state.sqlite3` 保存会话、记忆、知识、授权、任务、审计、模型调用和工具链日志；`vectors.sqlite3` 保存可重建的 embedding/`sqlite-vec` 索引。两库从 `001-baseline.sql` 建立，状态库再通过 `002-tool-call-events.sql`、`003-model-call-snapshots.sql` 和 `004-conversation-state.sql` 补充工具事件、群记忆召回、工具链父子关系、模型请求详情与协议会话状态；检测到无法识别的历史迁移记录或旧表会拒绝启动，迁移只在 Worker 内事务执行，不为状态库生成整库自动备份。手动配置包通过显式字段查询导出 SQLite 配置，恢复也只对这些白名单表执行参数化事务，避免日志或正文混入。主库损坏时保留现场并回退，向量库损坏可隔离重建。模型日志只在对话、生成或 embedding 请求进入适配器时启动，`ai_runs` 作为一轮或多轮模型请求的内部归组；本地执行工具和 Responses 上游真正发生的 hosted 调用都写入 `tool_call_events` 并关联对应模型调用，后者以 `openai-hosted` 标记且不经过本地 Tool Executor；`model_call_snapshots` 保存脱敏且有大小上限的最终上下文、模型可见工具定义与请求元数据，`parent_run_id` 和 `parent_tool_id` 用于串起子代理、工具派生模型请求和后台完成事件，日志详情页将这些事件合并成按轮次排列的运行链路。工具运行时负责统一结果语义、参数校验、超时、重试和副作用保护；`tool_search` 提供权限过滤后的按需工具发现，下一轮才扩展工具定义。同轮仅并行纯读工具，后台副作用任务进入受限队列并保留任务状态。知识库重建共用一条 `knowledge-index-rebuild` 运行记录，每个实际 embedding 批次写入独立模型明细。普通启动扫描、无模型运行不采集详情。日志费用只接受 CNY，详情与汇总分别按当前配置的保留天数清理；策略变更会触发一次合并的异步范围清理。Embedding 预算在本地预检后预留，失败时按已完成批次结算，并通过独立日表持久化。指令扫描的原有分文件索引暂作为兼容投影，`builtin-commands` 是 SQLite 中受保护的授权知识库。全表关系见 [sqlite-baseline-er.md](sqlite-baseline-er.md)。

所有运行配置和长期数据都采用单实例单写者模型。进程内队列只防止同一 Node.js 进程的并发覆盖，不提供跨进程文件锁；不得让多个 Yunzai 实例或容器共享写入同一配置和数据目录。

宿主能力集中经过 `core/runtime/host-runtime.ts`。业务代码不直接读取 `Bot`、`logger`、`segment` 或宿主 `plugin`，从而把 Yunzai 运行时依赖限制在一个适配边界内。

## 对话链路

```text
#yuichat / 第一人称 / Web 测试
  → response-pipeline：访问控制、限流、锁、输出策略
  → chat-service：历史、上下文、工具循环、记忆写回
  → provider-resolver：任务模型列表、顺序/随机/fallback 选择
  → models/protocol + models/adapters/registry.ts：统一协议，分派 Chat Completions 或 Responses 适配器
  → output-service / render-delivery：发送文本、语音或图片
```

模型配置只认三层：

1. `apiProviders`：凭据、地址和公共请求参数。
2. `models`：模型标识、适配器、视觉/工具能力、推理设置，以及可覆盖全局值的请求超时和流式模式。`toolPolicy` 为每个模型统一提供继承、白名单或黑名单范围；名单只存 `web_search` 等稳定能力 ID，`toolPolicy.routes` 再选择 Web/Tool Search 使用 OpenAI 托管实现、本地实现、自动选择或禁用，并为 Web Search 选择首选、失败换源或并行聚合。`adapter: openai-responses` 时，`responses` 分支只保留 File Search 数据参数、原生工具高级参数、`auto`/`local`/`previous_response_id` 状态模式和上游存储设置，不再重复保存 Web/Tool Search 开关。三种模式都保留本地可见历史与审计；自动模式正常只发送增量输入，遇到已知断链错误时最多执行一次有界无状态重放并保存新 ID，严格上游模式则直接交给渠道 fallback。
3. `modelTasks`：业务任务到模型列表，支持 `sequential`、`random`、`fallback`。

`channels` 仅是显式覆盖兼容层。`workflows` 和 `chat.defaultWorkflow` 会被配置归一化移除，不应新增依赖。

## 关键子系统

| 子系统 | 入口 | 约束 |
| --- | --- | --- |
| 第一人称 | `first-person-service`、`persona-trigger`、`conversation-continuation`、`persona-chain`、`prompt-composer` | `persona.characterPrompt` 与 `persona.runtimePrompt` 分层注入，每轮再注入北京时间简写；系统运行规则可由主人编辑并恢复源码默认值，实际工具权限与网络安全仍由程序策略强制执行；直呼/@、旁路和 poke 复用同一服务。显式对话回复成功送达后为同一用户开启一次 5 秒续聊机会，仅在承接词、追问、关键词重合、回答机器人问题或按要求补发媒体时自动进入对话；命中立即消费，自动续答不再续开，避免无限接管。`<EMPTY>` 不发出也不入库 |
| AI 能力 | `toolRegistry`、`contract`、`agent-turn-state`、`execution-runtime`、`policy` | Builtin、Custom、MCP 才是本地执行工具；Skill 只被按需注入指令。一次用户请求由单个 `AgentTurnState` 在 `model_decision → tool_execution → completed/finalizing` 间循环，供应商结束原因归一为 `tool_calls`、`end_turn`、`max_tokens` 等结构化状态；正常最终文本直接复用，不为每轮工具生成总结。Chat Completions 使用嵌套 `function` 定义；Responses 使用顶层 Function Tool，并可组合 OpenAI 执行的 `web_search`、`file_search`、`tool_search`。配置名单只保存稳定能力 ID，`openai:*`、`local:*` 只标识运行实现；原生工具按“能力启停 → 角色权限 → 模型名单 → 实现路由 → 协议支持”求交集，工具管理处关闭能力时托管与本地实现都会被移除。`web_search` 门面支持首选、失败换源和多渠道并行；后两者可通过独立 Responses 工作请求组合托管搜索与本地渠道，工作请求不推进主会话 Response ID。Responses 的本地 function call 仍进入同一个 `execution-runtime`，继续受调用上限、重复保护、重试、副作用账本和权限控制；工具搜索只能从已授权候选池按需装载，缺少权限上下文时关闭。明确搜索图片或表情包且 `image_media` 可用时，Responses 首轮固定选择该专用工具并暂不暴露原生 Web Search，避免同一媒体意图被通用网页搜索重复消费。OpenAI 托管调用不进入本地 Tool Executor，但真实 `*_call` 会作为 `openai:*`、来源 `openai-hosted` 的只读远程事件进入统一工具链、模型日志和会话审计；工具事件保存上游实际返回的 output item，并按日志规则脱敏和限长，模型调用元数据只保留摘要；托管调用和本地 Function Call 同时出现时，本地结果必须回传模型生成最终说明。原生 Web Search 来源会在正文之后用合并转发回显。工具公共契约用 `deferLoading` 表示 Responses 的 `defer_loading`，高频核心工具直接加载，Custom、MCP 和低频 Builtin 默认延期。显式 `count` 等次数参数可跨模型轮次递进完成，副作用超时按不确定结果处理而不自动重试。通用搜索类工具保留原始文本/JSON 观察，由模型选择 `message_send`，以同一消息链维持文字说明与媒体的对应关系；统一投递边界保持连续图文合并，遇到视频时按原顺序拆成独立 OneBot 消息，有封面则封面继续作为前置图片参与图文消息；`forward` 片段转换成 Yunzai/OneBot 合并转发节点，`web_search` 的来源计划会追加到模型整理正文之后。公共契约的 `autoDelivery` 默认为空；同轮计划按原调用顺序合并，任一计划设置 `continueConversation: true` 时锁存 Turn 级最终回复需求而不提前结束工具循环，最终为空或 `<EMPTY>` 才进行最多一次无工具人格收束；全部关闭且其它工具允许静默时才静默。`message_send` 只负责投递。内置 `bilibili_media` 与 `image_media` 默认发送且开启续答；`image_media` 的发送计划仅包含图片资源，不附带标题或来源文字。B 站媒体先准备为受管本地缓存，旧工具名不兼容。|
| 代码过滤器 | `filterRegistry`、`message-filter-service` | Builtin、Custom Filter 在输入模型前或回复发送前确定性处理正文；不进入模型工具定义 |
| 子代理 | `dispatch_subagent`、`chatService.runSubAgent` | 默认关闭；限制派发数、深度、全局并发、总时长、工具调用和模型输出；取消信号向模型请求与安全 HTTP 读取传递 |
| 知识库 | `knowledge/{store,repository,access,chunking,index-jobs,vector-index,retrieval}` | 普通库与 `builtin-commands` 的 CRUD、deny-first 群域授权、FTS/单库隔离向量召回；新向量空间完整写入后才原子切换，失败时保留旧空间并降级 FTS |
| 记忆 | `memory/{store,repository,group-capture,vector-recall,scopes,write-policy,decay,retrieval,prompt}` | 门面保持旧接口；显式事实、群聊提炼记忆与指定群原文采集分开存储。群采集按群号和消息 ID 去重，系统设置维护各群继承的默认值；策略可按字段继承或覆盖保留期、单日子窗口 Token 上限、专用提炼模型（留空跟随默认对话模型）、提示词、输出 Token 上限和置信度阈值。主人可按单次上限调用宿主群历史接口补录原文：默认从最新消息向前，也可指定起始消息 ID 或从已存最旧一条继续向前分页递进，按群号＋消息 ID 去重；原文只可在采集详情中分页搜索和核对，不参与召回。提炼以自然日为审计与入队边界：每天仅自动处理前一天及更早的关闭日期，日内按 Token 上限顺序切分并在相邻子窗口回携上下文重叠，单条超限原文不截断而标记跳过；提示词携带回复与 @ 指向标注，模型返回不可解析 JSON 时计入失败并走既有重试；管理员可选择任意时间段，系统自动按日拆分重提炼队列，每轮扫描处理窗口数由 `consolidation.maxWindowsPerScan` 控制。补录改变已完成日时只标记需重提炼而不静默重复调用，失败日可直接定位重跑。每个日任务仍保存原文范围、进度、Token 预估、结果和证据；每个群日任务可一次提炼多名成员，模型输出原子事实键和值，SQLite 在本地判定新增、强化、修正、撤回（retract → superseded 归档，管理员维护的记忆不受影响）或忽略，置信度低于 `consolidation.minConfidence` 的候选服务端丢弃，避免额外模型去重调用；采集消息的 QQ 昵称与群名片以 platform-metadata 来源直接结构化写入 `identity.qq_nickname`（user 作用域）与 `identity.group_card`（user_group 作用域）单值槽位，改名自动 supersede，不经模型。模型日志仅为明确开启的群记忆提炼保存脱敏输入，普通对话不因此保存请求正文。SQLite 模式不再写入旧式“用户问题＋机器人回答”原文 episode 与短期消息（读路径已收敛，短期上下文由 recent-context 承担）；检索使用中文 unigram+bigram 词元化 FTS，普通群聊先检索当前发言人和本群，只有问题明确涉及个人偏好、身份、经历、关系或个性化建议时，才根据非机器人 @ 或群内唯一昵称、群名片、自述别名切换到目标成员作用域；询问他人时不混入提问者个人记忆，比较双方时才同时保留。配置 `memory.retrieval.embeddingModel` 后经 `vector-recall` 叠加语义向量召回（意图与 FTS 缺口双重门控、低相似度过滤、空作用域短路、查询缓存、每日预算熔断，embedding 调用以 memory-recall/memory-vector-index 计入统一模型日志），注入行按作用域标注来源 |
| 媒体与渲染 | `media-cache`、`image-channels`、`render-service`、`render-html-service`、`render-cache`、`image-renderer-registry`、`render-delivery` | `image_media` 在一个工具内按配置选择 Bing、百度、SERP 或 Pixiv，默认直接发送选中结果的原始 URL；管理员可为防盗链渠道开启已选图片本地缓存，并始终保留作品与页序号映射。R18 是管理员硬门禁。`render_image` 统一分流 SVG、插件自带且禁用原始 HTML 的 KaTeX/Mermaid 模板、受控 Markmap/HTML 和安全函数图；HTML 路径与旧插件一致复用 Yunzai renderer loader 提供的 Puppeteer 单例，但仍对每个页面执行 Yui Chat 请求拦截。任意 HTML 与 URL 截图后端默认关闭。渲染算法、缓存生命周期、注册和发送职责分离。 |
| 定时任务 | `schedule-task-service` | 仅发送提醒，不通过模型；按用户和 cron 限额控制；一次性任务失败有限重试，最终失败保留可查可取消 |

## 管理台

`web/http/app.ts` 只创建 Express Router、挂载静态文件并组合领域路由：

- `web/http/routes/runtime.ts`：健康、诊断、会话、渲染与安全聊天测试。
- `web/http/routes/configuration.ts`：配置、供应商、模型和任务路由。
- `web/http/routes/capabilities/extensions.ts`：Builtin、Custom、Skill 与 MCP。
- `web/http/routes/knowledge.ts` 与 `routes/knowledge/{bases,indexing,access}.ts`：指令兼容投影、多知识库、索引、知识授权、记忆、人设概览与主动问候。
- `web/http/routes/filters/message-processing.ts`：过滤规则链、试跑和 Custom Filter 包。
- `web/http/routes/capabilities/authoring.ts`：受限项目文件浏览与隔离的 Custom Filter AI 草稿生成。

`web/http/auth.ts` 管理三类凭证：可选的静态 `web.authToken`、仅由主人 `#yui面板` 命令签发且单次消费的一次性快捷码，以及登录后使用的短期 Web 会话。静态 Token 留空时静态入口禁用；非空 Token 只从 `yui-chat-token` 或标准 Bearer 请求头读取。快捷码默认 3 分钟有效，Web 页面和本机 HTTP 接口都不能主动签发，消费后换取 HttpOnly、SameSite=Strict 会话 Cookie 并立即从地址栏移除。管理台和 WebSocket 复用短会话，Cookie 修改请求需满足同源约束。普通公开配置输出继续递归遮蔽常见 token、key、secret、password、credential、Authorization 和 Cookie 字段；仅已鉴权的专用凭证接口允许管理员显式查看、修改或清空 `web.authToken`。

`web/http/websocket.ts` 独立管理 WebSocket，`web/http/route-handler.ts` 统一异步错误响应，`web/http/runtime-config.ts` 串行执行“事务更新/完整保存并热应用”，防止旧请求覆盖较新的运行态。供应商和模型的纯配置变换位于 `models/configuration/editor.ts`，不耦合 HTTP 或配置仓库。

前端是无打包 Vue 3 ESM：`web/client/app/store/` 负责 API、切片加载、草稿和确认状态，`web/client/ui/components.ts` 是公共组件，`web/client/features/` 按页面领域组织。工具页由 `features/tools/tools-tab.ts` 组合，扩展、MCP、角色权限和共享展示规则位于同一目录；模型页由 `features/providers/providers-tab.ts` 组合，供应商/模型编辑、回复路由和共享逻辑位于同一目录，并加载实时工具目录供可搜索多选白名单/黑名单使用。构建阶段会为生产 ESM 的相对导入统一追加版本号，避免只刷新入口而复用旧子模块。共享格式化、样式和第三方前端资产分别在 `shared/`、`styles/`、`vendor/`。

后端是权限、配置和缓存路径的可信边界。前端本地开发者模式只改变展示，不能提升权限。保存、恢复、导入和运行态配置变更必须经过配置校验并热应用工具、主动问候和定时服务。工具预设是显式执行的一次性批量启用操作，`activePresets` 只记录已应用项，不会在后续配置归一化时重新开启被管理员单独停用的工具。单工具启停只更新 `enabledTools` 策略，Registry 无需重建，下一次模型工具解析立即读取新快照；扩展安装、修改和显式目录刷新才重新初始化 Registry 与相关外部连接。

## 扩展选择

| 目标 | 采用方式 |
| --- | --- |
| 内置且供模型调用的能力 | `tools/builtins/<domain>.ts` |
| 本地可编辑执行能力 | `data/yui-chat/extensions/tools/<id>/tool.json` + `index.js` |
| 外部工具服务 | MCP |
| 可复用的提示/流程 | `data/yui-chat/extensions/skills/<id>/SKILL.md` |
| 确定性正文处理 | `filters/builtins/` 或 `data/yui-chat/extensions/filters/<id>/filter.json` + `index.js` |

Custom AI Tool 和 Custom Filter 都要声明 `frameworkResources` 后才能读取宿主或其他插件资源。普通复用逻辑应放在共享 JavaScript 模块中，再由各自的 Tool/Filter 包装器调用；不把 Filter 注册成隐藏 Tool。远程 Skill 安装只接受无内嵌凭证的 HTTPS 或 Git SSH 地址，并执行受控 `git clone`；仍应只安装可信仓库。

可编辑扩展统一通过 `extensions/storage.ts` 定位到 Yunzai 的长期数据目录，源码 `examples/` 中的示例包只在缺失时复制一次，插件源码更新不会覆盖用户代码；不再迁移旧源码目录中的扩展。源码中不再保留同名 `.js` 导入桥；用户扩展包自身的 `index.js` 仍属于动态代码边界。

## 日志详情与会话审计

模型日志只在请求真正进入适配器时记录；`model_call_events` 保留主链路和用量元数据，`model_call_snapshots` 通过 `003-model-call-snapshots.sql` 独立保存经过凭证脱敏和大小约束的最终上下文、模型可见工具定义与请求元数据。日志页先加载精简运行链路，切换到模型请求详情或会话工作台时再发起独立查询，避免列表和普通链路渲染被长上下文拖慢。会话工作台按 `ai_runs.conversation_key` 汇总全部保留的顶层对话轮次，列表使用作用域、来源和提问摘要定位，不默认暴露内部会话键；选中轮次后单独加载该轮模型请求和工具事件，并按模型请求、工具轮次、实际调用展开。模型详情的上下文同时保留消息顺序和来源分组（人格、Skill、记忆、知识库、历史、当前提问、工具返回等），使“模型实际看到了什么”和“这一轮实际执行了什么”可以分别核对。Responses 的 Response ID 仅在会话 `state_json` 中持久化，模型日志只记录是否已链接和缩略响应标识；远程内置工具则以 `openai-hosted` 事件显示。旧日志没有提问正文或上下文分组时会明确标记不可用或回退到消息级信息；子代理仍通过父运行关系展示，不混入顶层会话轮次。

## 安全默认值

- Web 管理接口和 WebSocket 始终鉴权；主人 `#yui面板` 可签发单次快捷登录码，页面不能主动获取；可选静态 Token 只通过请求头进入短期 HttpOnly 会话，留空时静态入口关闭。
- Cookie 修改请求检查同源信息；管理 API 返回 `no-store`，页面启用 CSP，并禁止跨站嵌入和 MIME 类型嗅探。
- 用户可控的网页文本和远程媒体由 `safe-http-client` 读取：URL 凭证始终禁止，每次重定向重新校验并限制总时长和响应体；私网、localhost 与保留地址是否放行由 `security.linkSafety` 配置。
- 第一人称与 `#yuichat` 共用引用处理：引用正文经过输入过滤与有界截取后进入最后一条 user message，保留原作者、消息 ID、正文换行及读取完整性；当前发言人的身份、权限和回复目标不变。读取引用时先按消息 ID/序号调用宿主 `getMessage`/`getMsg` 取得最新消息，再检查可比较的定位信息并合并元数据；失败时保留不可用状态，不以其他消息替代。引用图片在媒体识别和引用媒体开关开启、且不是消息管理操作时自动准备，不要求“看图”关键词；宿主重复展开的引用图片同样受开关约束。模型输入逐图标注引用、本次新图、近期消息或头像来源，用户要求置于最后；明确只看新图/引用图时缩小范围，比较时为两侧优先分配图片名额。文字引用、未能读取的引用均阻止无关近期图片和头像补入；头像只在明确询问头像时准备。语音、视频和文件仅保留存在性提示，不解析其内容。正常回复自然承接内容，不复述来源标记和内部处理过程。群聊短期上下文由 `recent-context` 按发送者顺序注入，并额外保留一层 `replyTo` 关系、引用者和完整正文；不另设单条消息字符上限，总量仍由最近消息条数和模型输入预算控制。被动消息不下载引用媒体，用户后续直接引用该消息时仍按消息 ID 读取，避免把引用图片误归为当前发送者的图片或扩大上下文。
- 本地会话历史保留实际用户输入的文字投影，包括引用正文、图片来源和提供状态；引用图片按请求级资源处理，使用最新地址即时下载/组装，不读取或写入媒体缓存，也不生成后续回看的图片引用键；普通图片正文留在现有媒体缓存，历史仅保留受管缓存键、原始编号和来源。明确“第二张、再仔细看看”等承接上一轮的视觉追问可从同一会话的上一轮普通图片缓存恢复；缓存失效时说明不可用，不回退到无关群图片。新引用和当前附件优先于会话回看。没有引用时，“刚发的图/上一张表情包”等按明确点名、人称或时间顺序选择近期图片；“这个呢/看看这个图”等省略式指代只绑定紧邻的上一条图片，中间出现其他消息时不猜测。普通对话不下载历史图片。撤回、精华管理等消息操作不读取媒体；视觉预处理失败不得把宿主原始 URL 回退为模型 `image_url`。具体渠道仍受视觉能力、模型 visual 与 preferNativeVision 限制，不能读取时只提供明确的未读取状态。
- DNS、私网 IP、URL 协议/凭证、域名模式与可信资源目标统一由 `link-safety-policy` 管理，运行授权只从 `security.linkSafety` 读取。QQ 入站媒体登记 `qq.com.cn` 及其子域名，Bilibili 页面与 CDN 资源也在此登记；默认放行私网和可信资源私网 DNS，管理员可统一关闭。
- URL 截图功能默认关闭且仅限主人。启用时读取 `security.linkSafety.screenshotAllowedHosts`；默认 `*` 允许全部 HTTP(S) 域名，也可收紧为精确域名或子域通配。初始页面、跳转和网络资源仍经过请求拦截，不与普通 HTTP 读取混用。
- HTML/URL 截图、子代理、MCP、定时主动问候默认关闭或不自动启用。
- 跨目标发图默认关闭；工具受全局策略、角色边界和工具级 policy 共同限制。

改动这些边界时同步 `validator`、Web、diagnostics 与测试，并运行 `npm run check`。`check:structure` 会检查静态导入环、Web 路由与鉴权、宿主全局引用、配置/小型 JSON 原子写、安全 HTTP 调用点、空异常处理和重复 JSON 克隆。

Chromium 请求拦截不能把 DNS 解析结果固定到实际连接。当前通过功能默认关闭、主人权限、可配置域名策略和逐请求拦截控制风险；使用默认全域策略处理不可信站点时，应在浏览器进程所在容器或系统层限制网络出口。
