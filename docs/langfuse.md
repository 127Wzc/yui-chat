# Langfuse 观测（Cloud / 私有化部署）

插件可将统一模型入口的调用发送到 Langfuse Cloud 或私有化部署的 Langfuse，默认关闭。使用 Cloud 无需自行部署；自建服务填写自己的地址和项目密钥。远端观测独立于本地日志开关；本地日志仍按原有保留周期工作。

## 开通与配置

1. 使用 [Langfuse Cloud](https://langfuse.com/cloud) 或已部署的 Langfuse，在对应服务创建项目，在项目的 **Settings → API Keys** 创建一对项目密钥。不要把密钥发到聊天中。
2. 通过 `#yui面板` 登录管理台，在左侧二级导航打开「系统设置 → Langfuse 观测 → 连接与凭证」，填写服务地址、Public Key、Secret Key，启用并保存。服务地址默认日本 JP（`https://jp.cloud.langfuse.com`），可直接改为其他地区或私有部署地址，环境标识收在「高级连接设置」中；已有地址会保留。设置热应用，无需重启。
3. 默认主对话采样为 `1`，独立后台调用采样为 `0.1`，本地月度上限为 `45000` Units，输入输出正文上传关闭。密钥输入框保存后清空，留空再次保存会保留已存密钥。
4. 发起一次普通对话，等待约 5 秒，在 Langfuse 查看 Observations/Tracing 与 Sessions。执行一次结束对话，再发送消息，核对新 Trace 与新 Session。

「采样与额度」单独维护采样、月度上限和正文采集；「上报状态」查看预留额度、待发及重试情况。切换设置分区会保留当前未保存草稿。

配置保存在 SQLite 主配置的 `logging.langfuse` 中。Cloud 同一地区共用服务地址，项目由密钥区分；填写服务根地址，不要填写项目页面或完整的 OTLP 接口地址。例如日本 Cloud 为 `https://jp.cloud.langfuse.com`，私有化部署可以是 `https://langfuse.example.com`、`http://localhost:3000` 或 `http://192.168.1.8:3000`。

管理员配置的地址支持 HTTP/HTTPS、自定义域名、IPv4/IPv6、端口和已配置的反向代理路径前缀。例如 `https://obs.example.com/langfuse` 会发送到 `https://obs.example.com/langfuse/api/public/otel/v1/traces`。地址中不接受账号密码、查询参数或片段；密钥通过请求头发送，不跟随重定向，HTTPS 使用正常证书校验。自建服务与 Cloud 使用同一上报协议，需部署支持 OTLP HTTP/JSON 的 Langfuse。浏览器回读配置递归脱敏；密钥不写入上报队列或诊断。

| 配置字段 | 用途 |
| --- | --- |
| `enabled` | 是否生成并发送远端记录；关闭时已入队数据保留 |
| `baseUrl` | Cloud 地区或私有部署的服务根地址，必须与项目密钥属于同一服务 |
| `publicKey` / `secretKey` | 项目 API 密钥 |
| `environment` | 环境标识，如 `production`、`test` |
| `sampleRate` | `0–1`，按整段对话身份稳定采样，避免随机丢掉某一轮 |
| `backgroundSampleRate` | `0–1`，无活动对话上下文的独立模型调用采样 |
| `monthlyUnitLimit` | `0–50000`，本实例按 UTC 自然月预留的额度；`0` 暂停新增记录 |
| `captureContent` | 上传脱敏、限长的模型输入输出；默认关闭 |

## 会话与模型记录

同一机器人账号、同一群或私聊、同一发言成员、同一环境共用一个 Trace 和 Session。会话身份单独持久化，不由历史 TTL 或模型渠道决定：多轮消息、切换模型、历史过期和进程重启均继续关联。显式结束对话、按归属删除或结束全部对话后，下一次模型调用创建新身份。清理某个渠道的对话也会结束该成员当前的远端会话；正在执行的旧调用完成后仍属于旧身份。

这采用本项目约定的“整段会话一个 Trace”。[官方常规建议](https://langfuse.com/docs/observability/best-practices)是每轮一个 Trace、整段对话一个 Session。本项目为节省 Trace Units 使用较长的 Trace，不额外创建会话或轮次包装 observation；第一个完成的真实模型调用充当根节点，其余调用关联到该节点。根节点只描述那一次模型调用，不代表整段会话的最终输入输出，也不延长其运行时间。

| 入口 | Observation 名称 | 类型 | 采集内容 |
| --- | --- | --- | --- |
| `AdapterRegistry.sendMessage` | `yui-chat.chat` | `generation` | 模型、上游用量、耗时、终止原因、工具调用数；可选消息、工具定义与模型输出 |
| `AdapterRegistry.generateImages` | `yui-chat.image-generation` | `generation` | 模型、耗时、上游用量、图片数；可选提示词与参考图数量 |
| `AdapterRegistry.embedTexts` | `yui-chat.embedding` | `embedding` | 模型、上游用量、耗时、输入块数和维度；可选输入文本 |
| `AdapterRegistry.rerank` | `yui-chat.rerank` | `retriever` | 模型、耗时、候选数、排序索引与分数；可选查询与候选正文 |
| `AdapterRegistry.decide` | `yui-chat.decision` | `generation` | 模型、上游用量、耗时；可选状态、问题与答案 |

每次适配器调用只生成一条 observation，失败也记录；模型测试和渠道测试不上传。适配器内部的协议恢复或 HTTP 重试归于本次模型调用，不额外生成网络 span。Embedding 数组与 Rerank 候选数组沿用现有批量接口，不拆成逐条调用。普通工具、SQLite 检索、启动扫描、消息投递和评分均不新增远端记录。

活动对话上下文通过异步调用链传递，因此工具触发的生图、检索模型及子任务模型可以关联到当前会话；异步工作继承了该上下文时也按对话采样。没有活动上下文的后台调用按后台比例独立采样，采样命中后使用独立 Trace。没有为子任务额外增加 agent 或 dispatch 包装层。

每条记录都带有 `sessionId`、散列后的 `userId`、环境、模型、来源、用途、任务及 `metadata.run_id`。有本地运行 ID 时使用它，否则生成当轮 ID，可用于关联同一轮的多次调用。只上报明确已知的上游 Token 数，估算值不会冒充实际值；来源记录在 `metadata.usage_source`。缓存与思考 Token 另存 metadata，不作为额外 Token 再次相加。插件本地人民币估算费用不直接写入 Cloud 美元费用；Cloud 自动计价取决于模型名与其价格表是否匹配。

## 额度与可靠性

[Cloud 计费单位](https://langfuse.com/docs/administration/billable-units)包括 Trace、Observation 和 Score。若一段会话有 `N` 次模型调用、没有评分，本项目结构按 `1 + N` Units 预留。例如同一会话里发生 20 次模型调用，预留 21 Units；并不会因为“一个会话一个 Trace”而只花 1 Unit。HTTP 批量发送减少网络请求，不减少这些记录的 Units。

本地默认每月预留 45000 Units，私有化部署同样沿用本地采样和额度设置。预算与脱敏后的待发记录事务写入 SQLite，达到预算或队列上限后跳过新增记录并在诊断显示；不会影响模型执行。该预算以规范化后的服务地址（含路径前缀）和项目 Public Key 隔离，切换环境或进程重启不重置。更换部署地址或项目会使用独立会话与预算，旧目标的待发记录保留，切回相同目标后续发。每条首次记录保守计入 Trace 与 Observation；后续记录计入 Observation。失败投递不返还预留额度；跨月积压还需在投递月预留额度，防止借上月预算绕过上限。

每约 5 秒发送至多 20 条完成的 observation，发送有 5 秒总超时。成功才删除待发记录；失败按退避重试并复用原 ID，不用重新上报来修改已经完成的 observation。持久队列最多 1000 条、8 MiB；数据库暂时写入失败时保留最多 100 条内存缓冲并显示故障，进程在成功落盘前崩溃仍可能丢失这部分数据。停机时尝试发送一次，其余已落盘记录在下次启用相同目标后续发。

这是本实例的保守预算，不等于组织账单硬限制。其他实例、其他项目、手动评分和 Cloud 评测会额外消耗额度；更换 Public Key 会使用新的本地预算目标。实际用量以 Cloud 的 Usage 为准。当前 [Hobby 计划](https://langfuse.com/pricing)提供每月 50000 Units、30 天数据访问窗口；长会话仍保留同一 Trace ID，但早期调用可能超出可访问窗口，不会为此自动切 Trace。

## 观测与后续评测

在管理台检查当月预留、待发、重试、待写及本进程跳过数。持续有待发/重试时先核对地区、密钥与网络；错误提示不包含凭证或原始模型异常，调用失败的详细原因在本地日志排查。

在 Cloud 按环境、模型、observation 名称、`metadata.source`、`metadata.purpose` 筛选。按 `sessionId` 查看整段会话，按 `metadata.run_id` 关联一轮；耗时分析使用 observation 耗时，长会话的 Trace 跨度含用户等待时间，不适合作为响应延迟。根 observation 的输出也不能代替整个会话的最终答复。

后续评测应定位到具体 observation：

- 对话回答质量：选择 `yui-chat.chat`，结合 `metadata.stop_reason` 和 `metadata.tool_call_count` 排除仍在请求工具的中间调用，再人工核对最终回答。模型输出不是最终平台投递回执。
- 检索与重排：选择 `yui-chat.rerank` 的查询、候选与分数，结合人工标注评估相关性。Embedding 只记录维度与调用用量，不上传向量。
- 结构化判断：选择 `yui-chat.decision` 的问题与答案，核对预期标签。
- 图片质量：当前只上传图片数量与可选提示词，需要在本地查看实际图片，无法仅凭远端摘要进行视觉评测。

正文默认关闭时可观测调用、耗时、错误和用量，无法进行需要原文的回答质量评测。需要此类评测时，在测试项目中启用正文上传并选择小规模样本。文本按深度、条数与字符数截断，鉴权字段、已知上报密钥、URL、Base64、向量和媒体二进制不导出；这不保证任意自然语言中的个人信息都被识别，开启前需自行审阅测试语料。

当前不自动创建评分、数据集或 LLM Judge，不产生额外评测模型费用。以后添加评分时将其计入额度，并按 observation 输入输出评测，避免用长 Trace 的根节点代表所有轮次。

## 实现与验收边界

上报实现位于 `core/observability/langfuse.ts`，会话结束接入 `core/chat/conversation-state.ts`，配置在 `config/defaults.ts`，面板在 `web/client/features/advanced/langfuse-panel.ts`。使用官方支持的 [OTLP HTTP/JSON 协议](https://langfuse.com/integrations/native/opentelemetry)，携带 v4 ingestion 标记；为支持 SQLite 待发队列、精确本地预算和宿主隔离，直接生成有界 OTLP，不安装全局 OpenTelemetry instrumentation，也不更换供应商网关。

`npm run check:langfuse` 使用隔离数据库、拦截 Cloud 网络与本机 HTTP 服务验证真实 Registry 入口、端口、代理路径、重定向拒绝、部署隔离、会话生命周期、并发、采样、额度、重试、脱敏及面板渲染，不消耗 Cloud 额度。尚需在配置实际服务及密钥后进行验收：连续两轮共用 Trace，显式结束后更换 Trace，四类模型能关联、用量正确、内容与凭证符合预期；Cloud 项目另核对 Usage。未完成真实验收前不能宣称已在实际服务查到记录。
