# 扩展安装

支持 Markdown Skill 和远程 Streamable HTTP / SSE MCP。安装成功代表固定内容已通过静态检查并提交，安装时停用、默认仅主人；运行验证和启用独立进行。不支持 Custom 自动安装、stdio MCP、执行包脚本、覆盖升级或自动启用。

## 三个入口

- 主人命令：`#yui扩展安装 <来源> [ref=版本] [subdir=目录]`、`#yui扩展进度 <安装编号>`、`#yui扩展取消 <安装编号>`。
- MCP 命令：`#yui扩展安装 https://example.com/mcp type=mcp id=example [transport=sse]`，默认传输为 `streamableHttp`。
- 已登录管理台：「AI 能力 → 安装记录」。可提交安装或只检查、上传 `SKILL.md` / ZIP / tar.gz、选择候选目录、绑定凭据并继续同一任务。
- 模型工具：管理员启用 `extension_install` 后，主人在当前真实对话中明确要求安装或检查具体来源。工具操作为 `install / inspect / apply / status / cancel`；确认提交需当前消息明确包含计划编号。

模型工具默认关闭；关闭不影响主人命令和 Web。主人身份来自宿主配置与原始入站消息，网页、引用、动作、子代理和合成事件不能授予安装权限。模型入口只返回任务编号、阶段与结果摘要，群通知不返回私有来源明细。Web 接手保留原发起者，原主人会话仍可查询同一编号。

`install` 在无阻断时独立完成；`inspect` 永不自动提交。计划包含固定 commit、文件 SHA-256 清单与有效期，`apply` 不能更换来源、目标或内容。默认计划有效期 30 分钟，等待输入任务 24 小时过期；提交临界区不因计划到期中断。目标冲突等待处理，不覆盖已有目录。旧远程更新入口明确拒绝覆盖；请先检查新版本，再自行决定是否显式卸载和重新安装。

## 来源与私有凭据

GitHub、GitLab、Gitee 通过各自 HTTP API 解析固定 commit、检查文件树类型，再读取固定 blob。不使用宿主 Git、SSH agent、credential helper，也不执行安装脚本。自托管提供者在 `installation.providers` 配置精确 `origin / apiBase / provider`；不匹配平台的 URL 可作为通用认证归档来源。仓库网页中的 tree/blob 路径不作为仓库根，改用仓库 URL 加 `ref / subdir`。

在「凭据 / 来源管理」创建只读凭据，绑定用途、精确 API origin 和完整仓库身份。例如 GitHub 的 origin 为 `https://api.github.com`，来源身份为 `https://github.com/owner/repo`。GitLab 使用 PRIVATE-TOKEN，GitHub/Gitee 使用 Bearer Token；通用归档与 MCP 使用 Header JSON，例如 `{"Authorization":"Bearer …"}`。同域不同仓库不共享授权。只有一个精确绑定时可自动使用，多项绑定时等待明确选择。

凭据只在后端解密，不回显、不进入模型、浏览器存储或配置包。支持管理员显式指定环境变量名，不自动读取包内占位符。SQLite 保存 AES-256-GCM 密文；本地主密钥为 `data/yui-chat/installation-secrets/key`，可用 32 字节 base64 的 `YUI_CHAT_INSTALLATION_KEY` 替代。密钥丢失或不匹配时停止读取，不重新生成替代密钥去掩盖原记录。主密钥只保护静态存储；操作系统管理员仍能控制进程与文件。

401/403 表示认证失败，404 同时可能表示不存在或无权访问；这两类结果等待补充凭据，不切换同名公开源。429/5xx 保留失败事件并有限重试。携带凭据的来源请求不自动跟随重定向；需要其他 origin 时由管理员独立绑定。

Skill 正文在启用前不注入模型。来自凭据读取的私有 Skill 启用时必须明确确认内容披露；该确认不能代替工具、模型或网络权限。

### 首轮真实验收：GitHub

首个真实私有仓库验收平台暂定 GitHub，具体仓库与认证方式尚未提供。建议创建有到期时间的 fine-grained personal access token，Resource owner 选仓库所属账号或组织，Repository access 仅选择目标仓库，Repository permissions 中 Contents 设为 Read-only，保留自动附带的 Metadata 只读权限。当前读取 commit、tree 和 blob 的 API 需要 Contents 读取权限。组织如要求审批，需等待批准后才能读取私有仓库。依据：[GitHub Token 配置说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、[API 权限表](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)。

在管理台创建来源凭据，用途选「仓库读取」（`repository-read`），origin 填 `https://api.github.com`，来源身份（scope）填完整仓库 URL，例如 `https://github.com/owner/repo`；Token 只填写在管理台凭据表单中，由后端生成 Bearer 请求头。之后用仓库 URL 与明确的 `ref / subdir` 执行「只检查」，核对固定 commit、文件摘要与目标，再确认提交。聊天中只提供仓库 URL、版本、子目录和凭据绑定编号。若目标账号不支持细粒度 Token，先核对该仓库的访问方式，再决定替代认证，不自动扩大 Token 权限。

## 内网 MCP

导入只保存停用配置与 `allowedTools: []`，不健康探测、不初始化协议、不发现工具、不启动进程。服务端口和传输固定，变更需要新安装计划。

在安装记录中明确授权服务 origin、端口、路径、可连接的真实 IP 和可选服务级 CA，再绑定到停用服务。localhost 是 Yunzai 服务端或容器；IPv6 地址使用标准 URL 写法。SSE 的 POST endpoint 路径须另列。明文 HTTP 携带静态凭据另需勾选该服务的授权。

连接、发现、SSE GET/POST 与重连都进入真实 SDK 的受控 fetch：逐请求重读授权与凭据、解析并核对全部 DNS 结果，通过固定 IP 的直连 socket 连接，不继承代理，不跟随重定向。元数据、链路本地、多播和其他保留目标不可授权。CA 只用于该服务，证书链与主机名校验保持开启；DNS 地址变化停止连接，需重新授权。请求头握手默认 30 秒，流空闲超时 60 秒，单连接响应上限 8 MiB；活跃 SSE 不使用来源下载总超时。

在 MCP 服务页执行「测试连接 / 发现工具」后，明确选择工具，再启用服务和 MCP 总开关。发现失败不改变原安装结果，临时连接会关闭；发现不会自动开放工具。受管理服务不允许 `null` 全开放，新增工具默认关闭，定义改变后旧 schema 授权失效。绑定变更先停用并清空开放名单，撤销凭据或网络授权会关闭相应连接。原有手动服务保留既有配置方式和启用状态。

## 恢复、审计和限额

任务、单调事件与收据分别持久化。CAS 更新和事件触发器在 SQLite 同一语句内原子完成；消息与 HTTP 幂等键避免重复发布。提交前记录意图并设置停用保护，文件在同一文件系统 rename 发布；目标锁覆盖创建、编辑、启停、删除、配置变量和 MCP 测试。

启动恢复隔离先于 Skill/Registry/MCP 加载。可核对材料的中断提交按原计划恢复为停用；不能核对时进入 `needs_attention`，保留材料和隔离。Web 可请求「核验并恢复停用提交」，不会覆盖无法证明属于原任务的目录。管理操作中断的结果只标记待核实，不猜测外部副作用是否完成。

取消在准备或等待阶段终止并清理；进入提交临界区后先保留取消请求，完成可证明安全的停用提交并记录结果。已发布目标不随意删除。通知有独立 intent/sent/failed/uncertain 状态；不确定通知不自动重发，也不把通知失败改成安装失败。

默认一个安装 worker、10 个排队任务，单次准备最长 180 秒、最多 2 次自动尝试；来源下载合计 20 MiB、展开 80 MiB、1000 个文件、深度 12。拒绝路径穿越、链接、子模块、设备、重复路径、LFS 指针、敏感文件及超量归档。不支持加密 ZIP、ZIP64 或 tar PAX 扩展；不会降级为外部解压执行。

终态任务与事件默认保留 90 天，活动收据不随任务清理删除；显式卸载退休旧收据，之后可以重装同一 ID。待恢复材料放在 `extensions/.install-work/`，加载器跳过隐藏目录，不按普通缓存回收。配置包不导出安装表、凭据密文或主密钥，也不能绕过受管理目标的独立配置入口。

## 验证与发布边界

实施基线：`4b3e976bc1a9de3c1994bd3f66f05fbd38099663`；本机宿主依赖实际解析的 MCP SDK 为 `1.29.0`，包依赖声明为 `^1.24.0`。未修改宿主依赖锁或插件外部代码。初始用户工作区中 `pelican-bicycle.html` 的删除与 `TODOLIST.md` 保持原样。

`npm run check:extension-installation` 使用隔离 SQLite 和临时 HTTP/TLS 服务验证持久化、停用提交、不可变计划、幂等、取消、分阶段故障恢复、可信入站身份、主人命令、Web 接手、三平台认证适配模拟、补凭据原任务恢复、安全归档、私网固定地址、服务 CA、证书主机名、实际 SDK HTTP/SSE、Vue 页面渲染与来源转义、终态通知去重。此测试需要本机监听权限与 OpenSSL；完整检查为 `npm run check`。

本地 fixture 不等于计划规定的真实私有仓库与实际 LAN 部署验收。目前没有使用真实私有仓库凭据，也没有实际部署 LAN/容器/IPv6 MCP；这些发布门槛仍需在目标环境完成。需记录三平台真实私有固定内容获取、长连接与断线重连、真实代理/fake-IP 环境、密钥丢失重启、部署崩溃点与并发调用的结果。未满足这些门槛前，不宣称整份 v2 发布验收完成。
