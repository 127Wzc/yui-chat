# Yui Chat 维护指南

适用范围：`plugins/yui-chat/`。先读 [README.md](README.md) 和 [docs/architecture.md](docs/architecture.md)；不得改动插件外部，也不得导入或执行旧 `chatgpt-plugin` 的业务代码。

## 工作方式

- 回答、解释、审查、诊断或规划：检查相关材料并报告有证据的结论；未要求修改时不要实现。
- 修改、构建或修复：直接完成范围内的本地编辑和相称的非破坏性验证；读取、编辑目标代码和运行测试无需确认。
- 仅在外部写入、破坏性或付费操作、扩大范围，或关键歧义会改变实现时确认；能从仓库确定的内容不要反问。
- 先明确目标、硬约束和完成条件，再定位现有实现、调用方与测试，做最小完整改动。不得覆盖用户改动；无关问题只报告。
- 交付时先说结果，再列验证、重要风险或下一步；不得声称运行过未实际运行的检查。

## 事实与边界

- 插件唯一身份为 `yui-chat`：源码目录、包名、数据目录、Web 路由、请求头、Cookie、环境变量、日志前缀和 UI 品牌不得恢复 `chatgpt-next`。不保留旧名称、旧路径或旧命令兼容。
- 除第一人称自然呼叫外，插件命令前缀只在 `core/message/command-prefixes.ts` 的 `PLUGIN_COMMAND_PREFIX_PATTERN` 定义；命令注册与服务端解析必须使用该模块的派生函数，不得在 `apps/` 另写前缀正则。默认前缀为 `#yui`，默认第一人称为“埋埋”。
- 当前模型配置为 `apiProviders → models → modelTasks`。`workflows` 会在配置归一化时删除，禁止恢复旧 workflow 说明或入口。
- `config/config.json` 是忽略提交的极简启动文件，只保留 SQLite 启动参数和 Web Token；其余用户配置位于 `state.sqlite3/runtime_config`，完整默认值只在 `config/defaults.ts`。长期数据在 `data/yui-chat/`，缓存仅在插件 `cache/`。路径统一从 `config/store.ts` 导入。
- Web 挂载到 `/yui-chat`（可配置），宿主会跳过其鉴权；敏感 API 和 WebSocket 必须自行鉴权。管理 Token 只从请求头读取，浏览器使用 HttpOnly 短会话；凭证不得进入日志、浏览器存储或 URL。
- 私网 URL 与 URL 截图域名策略统一由 `security.linkSafety` 配置，默认允许私网、可信资源私网 DNS 与全部截图域名；管理员可收紧为精确域名或 `*.example.com`。HTML/URL 截图功能本身、主动问候和子代理仍是独立功能开关；本机只签发一次性登录码，不得恢复整站免鉴权。
- 业务源码以 TypeScript 为唯一实现；根目录 `index.js` 只接入 Yunzai，Custom 扩展和第三方静态资源是受控动态边界。不得新增同名 JS/TS 业务实现或迁移阶段兼容桥，运行产物统一由 `npm run build:runtime` 生成到 `output/runtime/`。

## 模块职责

| 改动 | 唯一/主要落点 |
| --- | --- |
| 命令、poke | `apps/`；只做解析、权限、可见回复 |
| 对话、人格、媒体、输出、渲染 | `core/{chat,persona,media,rendering}/`；消息、网络、运行时与基础能力各在对应子域 |
| 供应商协议与工具格式 | `models/adapters/registry.ts` |
| 任务选模与 fallback | `models/routing/provider-resolver.ts` |
| 配置 | `config/{defaults,validator,schema,store}.ts`；同步 Web、diagnostics、smoke |
| 工具 | `tools/support/{contract,registry}.ts`、`tools/access/{policy,matrix,roles}.ts` 与 builtin/Custom/MCP、`extensions/` 共用能力 |
| Markdown Skill | `skills/index.ts`；仅注入指令，不注册为可执行工具 |
| 指令知识 | `knowledge/command-scanner.ts` 按需采集已加载规则与离线静态采集，`knowledge/command-import.ts` 导入/历史/审计，`knowledge/command-query-service.ts` 查询/推荐/报告，`knowledge/command-observer.ts` 加载目录与消息后置回调 |
| Web 后端 | `web/http/app.ts` 只组装 `web/http/routes/`；鉴权、WebSocket、错误分别在 `web/http/{auth,websocket,route-handler}.ts` |
| Web 工具页 | `web/client/features/tools/tools-tab.ts` 组合；扩展、MCP、权限、共享规则位于同目录的领域模块 |
| Web 模型页 | `web/client/features/providers/providers-tab.ts` 组合；编辑器、路由、共享逻辑位于同目录的领域模块 |

## 必须保持的约束

### 配置与持久化

- `configStore.get()` 返回冻结快照，禁止修改；`await configStore.load()` 返回可编辑副本。读改写用 `configStore.update(updater)`，仅完整替换用 `save()`；Web 通过 `updateConfigAndApply()` 热应用。
- 配置提交顺序必须是“读取启动项并连接 SQLite → 合并主配置与默认值 → 旧字段迁移 → 候选值归一化与校验 → 拆分启动项和运行覆盖 → 原子替换启动 JSON并写入 SQLite → 发布完整只读快照”。SQLite 写入失败必须回滚 JSON；已经标记 SQLite 主配置时不得无声降级到默认配置。正常提交和恢复不得自动备份；只有管理员显式操作才创建配置包。配置包除逻辑运行配置覆盖外只允许导出 SQLite 配置白名单，严禁包含日志、用量流水、聊天、记忆和知识正文。不得直接写 `config/config.json`，也不得在仓库队列之外拼接旧快照后保存。
- 小型整文件 JSON 复用 `core/storage/atomic-json-repository.ts`，保持一域一文件和现有 Store，不再叠加 Repository/Service；大文件、JSONL、二进制数据各用原有读写模型。
- 一次性定时任务仅在投递成功后删除；失败任务保留有限重试状态，最终失败必须可列出和取消。创建、取消和投递结果都通过仓库 `update()`，不得用旧内存快照整份覆盖。
- 文件记忆后端的事实和 episode 保持分文件 JSONL 与有界读取，episode 按 `maxEpisodesPerScope` 收敛。命中元数据和追加内容共用批量 flush；写失败不得清除脏标记或缓冲。
- 新临时文件放在 `cacheDir`/`tempDir`，并接入现有清理和 diagnostics。

### 安全与网络

- `configStore.getPublic()` 返回前必须递归脱敏；新增 token、key、secret、password、credential、Authorization 或 Cookie 字段时补回归。凭证不得进入启动日志、错误上下文或诊断。
- Web Cookie 会话保持 HttpOnly、SameSite=Strict 和受控 Path；修改请求保留同源校验。WebSocket 复用请求头或 Cookie 鉴权，不得恢复 URL Token。页面内联脚本使用逐请求 nonce。
- 用户 URL 读取经 `core/network/safe-http-client.ts`，保留逐跳校验、连接期 DNS 限制、总超时与大小上限；媒体经 `core/media/media-cache.ts`。DNS、私网、协议/凭证、域名及可信目标统一由 `core/network/link-safety-policy.ts` 判断；供应商显式配置地址使用普通超时客户端。
- URL 截图保留 `security.linkSafety.screenshotAllowedHosts` 和 Chromium 全请求拦截，支持全域 `*`、精确域名与 `*.example.com`；私网访问由同一配置控制。不得自建应用代理模拟连接固定，强隔离交给容器或系统出口策略。

### 工具、运行时与输出

- 子代理默认关闭；不得绕过派发数、深度、全局并发、总时长、每轮工具调用和任务 token 上限。新增网络工具接收 `context.agent.signal` 或设置更短超时。
- 新工具必须经 `toolRegistry`，声明 `category`、`risk`、`tags`、`policy`；不得直接调用工具实例。高风险动作保持最小权限。
- Custom 跨插件资源只能经已声明的 `frameworkResources`，不得拼绝对路径。
- 业务模块通过 `core/runtime/host-runtime.ts` 访问 `Bot`、`logger`、`segment` 和宿主 `plugin`，不得新增直接全局引用。
- 持久化用量日志只覆盖真正进入模型适配器的对话、生成和 embedding 调用；普通启动扫描、无模型运行和工具执行不得创建运行详情，embedding 预算同时使用独立日账本。
- JSON 兼容深拷贝复用 `core/shared/json-values.ts`；空 `catch` 必须记录错误或写明允许降级的原因。
- 图片渲染与投递分别经 `core/rendering/render-service.ts` 和 `core/rendering/render-delivery.ts`；引擎选择与渲染器注册由同目录的 `render-engine.ts`、`image-renderer-registry.ts` 负责，既有兼容导出保留在 `render-service.ts`。
- `#yuichat` 与第一人称都必须经过 `response-pipeline` 的访问控制。保留 `<EMPTY>` 静默语义，不得写入历史或记忆。
- Web 危险操作用全局 `confirmAction()`；复杂表单登记 dirty state，不得使用 `window.confirm()` 或第二套状态。

### 动作入口

- 动作独立控制启停与最低角色；创建时继承工具当前权限，之后不联动工具页。工具执行和回传必须经 Registry，按保存的动作重新检查授权，不得伪造调用者身份或跳过工具内部、网络及宿主检查。
- `requiresModelContext` 工具不允许绑定动作。示例复用已有工具或真实业务入口，默认停用，不自动写入用户配置，不新增专用示例业务函数。
- 普通用户命令在 `apps/chat.ts`，主人管理命令在 `apps/master.ts` 注册。
- 记忆快捷查看使用统一前缀“#yui他的记忆/她的记忆 @成员或QQ号”，仅主人入口注册，使用真实消息提及或明确 QQ 号解析目标并再次验证权限；个人入口为“#yui我的记忆”。

## 重构尺度

- 优先删除死状态、重复分支和失效兼容逻辑，再考虑抽象。
- 文件长度不是拆分理由；仅在职责可独立复用/测试、频繁冲突或依赖不清时拆分。
- 复用现有 Adapter/Strategy、Registry/Policy 和轻量 Store，不再叠加同义 Service、Manager、Repository 或事件总线。
- 保持公开导出、配置格式和用户行为兼容；结构改动采用小批次，每批补充与风险对应的回归。
- 兼容转发文件只用于既有外部导入；新模块、测试和文档一律引用规范目录中的实现文件。

## 文档维护

- `README.md` 只保留项目能力、安装、快速上手、常用指令、技术栈与架构概览、文档入口；详细模块边界和数据流集中在 `docs/architecture.md`。所有运行截图放在一个默认折叠的 `<details>` 中，按侧栏功能顺序排列，避免挤占正文；截图入库前遮挡凭证、服务地址和用户/群标识。
- `docs/` 描述当前有效行为。一项规则只在对应专题详细说明，其他位置用链接引用；功能变更直接改写原章节并删除过时内容，不在文末追加“补充说明”、修复经过或重复段落。源码路径写 `.ts`，ESM 代码示例的导入后缀仍遵循项目约定。
- `CHANGELOG.md` 是唯一历史更新记录，按日期倒序归纳用户可见的新增、变化、修复及必要迁移事项；同一批工作合并条目，不复制完整规格、对话过程或测试日志。未提交/未发布变更放在“未发布”，不得虚构版本、日期或验收结果。
- 功能或行为变更同时更新原有用法和历史记录；纯排版、措辞、链接修正不逐项记流水账。历史记录不能替代当前文档，也不能被当作现行规范。
- `TODOLIST.md` 只保留未完成或明确暂缓事项；完成后删除待办，将有价值的结果归入历史记录。未完成的部署验收不得因文档整理标为完成。
- `AGENTS.md` 只保留工作方式、模块职责和长期约束。新约束合并进现有主题，不追加功能介绍、完成报告或临时任务背景；精简时不得删除仍有效的安全与数据一致性约束。
- 第三方资源的说明、许可证与来源信息按原样保留。文档改动不得顺带修改业务逻辑或用户配置。

## 完成与验证

完成条件：目标已实现，相关调用方和配置展示已同步，安全默认值与兼容边界未退化，并有相称的验证证据。

```bash
cd plugins/yui-chat
npm run check
```

- `check:structure` 检查导入环、Web 路由、宿主全局和持久化写入；`smoke` 验证行为。
- 修改命令、配置、协议、权限、Web API 或运行路径时补测试；优先小型单元或 HTTP 测试，避免仅断言源码字符串。
- 纯文档改动至少检查链接、命令和路径是否真实，并审阅最终 diff。无法运行必要验证时，说明未运行项、原因和剩余风险。
