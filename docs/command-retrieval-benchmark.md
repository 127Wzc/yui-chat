# 指令召回源码基准

## 数据范围与答案依据

本基准按 2026-10-22 本机源码静态核对，包含 **46 个功能目标、13 个插件来源、39 份源码摘要、211 条问法**。它是第一批代表性功能集合，不是全部指令的完整审计，也不是用户日志采样。

- [机器可读数据](../scripts/fixtures/command-retrieval-source-benchmark.json)：保存来源、注册与实现行号、完整正则和 flags、声明权限、前置条件、期望答案组、易混淆项及场景。
- [校验与计分脚本](../scripts/check-command-benchmark.mjs)：校验数据、来源变更、示例正则和计分逻辑；对提供的检索结果离线计分。不会自动发起真实模型请求或执行任何外部插件。
- 原来的 [8 条模拟问法](../scripts/fixtures/command-retrieval.json) 继续用于确定性回归；这份源码基准独立保存，不用模拟模型的成功率冒充真实质量。

答案由注册规则和处理实现共同确定。来源摘要发生变化时先复核，不自动改答案去迎合检索结果。外部插件未安装会列为来源缺失，不能因此宣称功能有效或召回通过。源码存在也不表示插件已成功加载；实测时必须先把 selector 绑定到实际运行目录，记录未加载或规则变化的目标。

目标使用 `pluginKey + fnc + regexp + regexpFlags` 绑定，不能只凭函数名、推荐文案或旧 sourceRuleKey；例如两种体力入口都叫 `note`，王者两条趋势都叫 `trend`，但功能不同。GT 的两份签到实现属于等价答案组，实际加载其中任意一份即可命中，不要求重复推荐。

## 测试划分

共 188 条正例、8 条无专用指令的反例、3 条歧义问法和 12 条权限/条件/删除场景。正例中包含 45 条完整指令、133 条自然问法和 10 条错别字问法。完整指令与自然问法必须分开报告，不能用精确命中拉高总体表现。

开发集 147 条，留出集 64 条；同一功能家族的正例及改写放在同一组，避免仅换说法就泄漏到另一组。留出集中的歧义及条件场景独立人工复核，不混入普通命中率。公开的留出集只是固定验收集；以后增加真实用户问法时应另留未参与调参的一批。

这些问法由源码整理而来，尚未经过业务维护者的独立标注。首次真实评测应审阅答案，特别是相似功能的其他可接受实现；新增等价答案后提高数据版本并重新记录摘要，不能只给某一种检索策略补答案。

## 运行流程

1. 核对插件加载情况，使用采集脚本、外部整理并导入知识；确认实际规则与本基准一致。相同内容不重建向量。
2. 固定完整指令目录、说明版本、分片设置、索引版本、实际模型配置身份、阈值和候选额度。**检索完整目录**，不能仅用这46个目标组成小知识库。
3. 在隔离环境分别采集关键词、向量、混合、混合加重排的结果。生产内置指令库只提供关键词与混合两种统一方式，帮助、工具、自动推荐和管理台测试共用该设置；切换方式应通过 `knowledge.commandRetrieval.mode`，不能用单次查询参数覆盖。纯向量实验使用底层文档检索，不代表用户最终推荐结果，应另列报告。各入口使用相同查询、授权、目录快照及返回条数时核对候选和顺序。
4. 使用相同数据比较外部整理前后；不能同时换 embedding 模型和阈值后把全部提升归给内容整理。先用开发集调节，再只验收留出集。
5. 导出每条结果与耗时，按下面的格式计分。场景中的 deletedTargets 由目标映射到实际永久 ID，在隔离环境中手动删除；不能为跑基准删除生产知识。角色标签是预期上下文，不能伪造主人身份来验证普通用户权限。
6. 按失败类型检查：未入库、漏召回、筛选误杀、优先级挤占、功能混淆、已删除内容残留、条件说明缺失。对 `unmapped` 结果先人工核对是否漏标等价指令，再确认误推荐。

校验（无模型费用）：

```sh
npm run check:command-benchmark
```

结果计分（同样不请求模型；结果采集需另行完成）：

```sh
node scripts/check-command-benchmark.mjs --results cache/command-benchmark-results.json --split evaluation > cache/command-benchmark-report.json
```

不传 `--split` 时处理全部测试；也可传 `development`。输入文件可以包含全部测试结果，脚本只统计选定集合。`--host-root` 可指定待核对的宿主根目录。默认校验在已安装的来源发生变化时失败，缺失来源单独列出。计分仍可用于研究旧快照结果，但 `sourceReviewRequired` 会提示当前源码与基准不一致，不能当作当前版本验收。

这次交付只做源码与计分器验证，**没有进行真实 embedding/重排模型质量评测**。不包含新建批量模型任务、后台评测界面或自动付费分析。真实评测记录模型日志中的实际用量、价格口径及冷/热缓存状态；计分脚本不根据问法条数猜测费用。

## 输入结果格式与指标

输入 JSON 顶层为 `run` 和 `rows`。`run.datasetSha256` 必须填校验输出的真实摘要，`corpusIdentity` 记录完整实际目录与索引快照身份。下例只展示一行，不能当作完整成绩：

```json
{
  "run": {
    "datasetSha256": "替换为当前数据文件的SHA256",
    "corpusIdentity": "记录本次实际目录和索引的摘要",
    "mode": "hybrid",
    "ordering": "relevance-with-command-priority",
    "embeddingModel": "记录实际模型配置身份，不含密钥",
    "rerankModel": null,
    "descriptionRevision": "raw"
  },
  "rows": [
    {
      "caseId": "gs-stamina-1",
      "status": "ok",
      "latencyMs": 25,
      "results": [
        {"targetId": "gs-stamina", "priority": 300, "pluginOrder": 1, "ruleOrder": 1}
      ]
    }
  ]
}
```

结果可使用经过核对的 `targetId`，或保留完整 `pluginKey/fnc/regexp/regexpFlags`（支持原始结果的 `metadata.command`）。完整目录中未在目标表列出的条目必须保留完整身份，不能丢掉来人为提高精度。`targetId` 只是绑定别名，不得用它自动构造“检索结果”；优先级和顺序也必须来自本次真实采集，不能照例子填写。

每条必须明确标记 `ok`、`error` 或 `skipped`，后两种需有 `reason`。没有匹配结果是 `ok + results: []`；没有运行不是空结果。缺行、失败和跳过均单独统计，不能作为通过。正例指标以计划样本为分母，未完成的正例按未命中计；反例误推荐率只在完成的反例上计算，并同时报告完成数量。

| 指标 | 定义及使用方式 |
| --- | --- |
| Hit@5 | 正例前5个位置中是否出现至少一个可接受功能；单答案样本与 Recall@5 相同 |
| Recall@5 | 每条正例被覆盖的期望功能组占比，再取平均；组内是等价答案，组间才是需分别覆盖的功能 |
| 首条命中率、MRR@5 | 首条是否可接受，以及首个正确位置的倒数；比较实际推荐顺序 |
| Precision@5 | 前5个实际返回位置中不同正确条目的比例；不足5条按实际返回数计算，重复会消耗位置 |
| 反例误推荐率 | 已完成反例中出现任意专用指令候选的比例；只有8条，错1条即12.5%，不能当成稳定生产估计 |
| 禁止候选、重复、未映射结果 | 单独列出次数和样本；易混淆候选出现也计入禁止候选，不能用总平均掩盖 |
| 调度顺序 | `ordering=relevance-with-command-priority` 时仅在推荐指令文本相同的组内验证优先级升序及同级顺序；需提供真实推荐文本和运行元信息，缺失标为未核验 |
| 完成率、P95耗时 | 报告缺行/失败/跳过；P95只基于记录过耗时的成功查询，需另报告超时数 |
| 条件与歧义人工复核 | 对 policy/ambiguous 行提供 `review: {"action":"clarify","checksPassed":true,"notes":"已逐项核对"}`；action应与样本一致，未填不算通过 |

不同指令按相关性排名；优先级仅调整同一推荐指令的多个实现。优先级顺序正确但前5条没有可接受功能，仍为漏召回。先比较候选覆盖，再比较最终推荐；实际需要诊断时另保存优先级排序前的候选结果，两阶段不合并成一项成功率。

权限场景评的是说明与实际入口限制，不把知识库访问授权等同于宿主指令执行授权。目前检索能展示声明权限，但无法单凭 `permission: all` 推断处理函数内部放行；基准专门保留了主人检查、群管理检查、私聊限制与适配器限制。只检索和核对说明，不执行重启、关机、禁言或记忆修改来验证。

## 功能、样例与源码

表中每行是一项来源绑定。其余自然问法、错别字、等价答案及禁止候选见 JSON；“实现”链接可核对前置条件，而不只看插件描述。

| 目标 | 实际用途与标准示例 | 注册 / 实现 | 自然问法示例 |
| --- | --- | --- | --- |
| `gs-stamina` | 查询原神实时便笺中的树脂等信息。<br>`#原神体力` | [注册](../../genshin/apps/dailyNote.js#L16) / [实现](../../genshin/apps/dailyNote.js#L27) | 原神还剩多少树脂；想看原神体力恢复情况 |
| `zzz-stamina` | 查询绝区零实时便笺。<br>`#绝区零体力` | [注册](../../genshin/apps/noteZzz.js#L12) / [实现](../../genshin/apps/noteZzz.js#L21) | 绝区零电量还剩多少；绝区零的体力信息在哪看 |
| `gs-ledger` | 查询指定月份的原石札记或星琼月历。<br>`#原石6月` | [注册](../../genshin/apps/ledger.js#L14) / [实现](../../genshin/apps/ledger.js#L55) | 想看六月原石收支明细；原神这个月拿了多少原石 |
| `gs-ledger-count` | 汇总保存的原石或星琼札记统计。<br>`#原石统计` | [注册](../../genshin/apps/ledger.js#L23) / [实现](../../genshin/apps/ledger.js#L74) | 我要看原石累计统计；星琼统计用哪条指令 |
| `gs-bind` | 绑定游戏 UID，由 User.bingUid 处理。<br>`#原神绑定900000001` | [注册](../../genshin/apps/user.js#L44) / [实现](../../genshin/apps/user.js#L185) | 怎么绑定原神的UID；把星铁UID绑定到我的账号 |
| `gs-cookie-help` | 提供 Cookie 绑定教程，并提示私聊提交或扫码登录。<br>`#Cookie帮助` | [注册](../../genshin/apps/user.js#L14) / [实现](../../genshin/apps/user.js#L161) | 米游社Cookie应该怎样绑定；怎么查看体力绑定教程 |
| `miao-detail` | 查看具体角色面板、伤害或圣遗物详情。<br>`#雷电将军面板` | [注册](../../miao-plugin/apps/profile.js#L24) / [实现](../../miao-plugin/apps/profile/ProfileDetail.js#L15) | 怎么查刻晴的面板伤害；查看夜兰的圣遗物评分 |
| `miao-list` | 列出已获取面板数据的游戏角色。<br>`#面板列表` | [注册](../../miao-plugin/apps/profile.js#L17) / [实现](../../miao-plugin/apps/profile/ProfileList.js#L71) | 我已经有面板数据的角色有哪些；列一下缓存的角色面板 |
| `miao-refresh` | 重新获取游戏橱窗角色详情。<br>`#更新面板` | [注册](../../miao-plugin/apps/profile.js#L121) / [实现](../../miao-plugin/apps/profile/ProfileList.js#L52) | 我刚换了圣遗物怎么刷新面板；重新拉取游戏橱窗的角色详情 |
| `miao-artifacts` | 查看面板保存的圣遗物或遗器列表。<br>`#圣遗物列表` | [注册](../../miao-plugin/apps/profile.js#L66) / [实现](../../miao-plugin/apps/profile/ProfileArtis.js#L53) | 我的圣遗物列表在哪看；想列出星铁面板里的遗器 |
| `miao-material` | 按今天、明天或星期筛选可刷的天赋和武器素材。<br>`#今日素材` | [注册](../../miao-plugin/apps/wiki.js#L40) / [实现](../../miao-plugin/apps/wiki/TodayMaterial.js#L8) | 明天该刷哪些天赋材料；星期二能刷什么角色素材 |
| `miao-calendar` | 展示原神活动和卡池等日历信息。<br>`#日历` | [注册](../../miao-plugin/apps/wiki.js#L22) / [实现](../../miao-plugin/apps/wiki/Calendar.js#L424) | 原神最近活动日历怎么看；我想看原神活动时间表 |
| `miao-calendar-sr` | 展示星铁日历。<br>`#星铁日历` | [注册](../../miao-plugin/apps/wiki.js#L28) / [实现](../../miao-plugin/apps/wiki/CalendarSr.js#L315) | 星铁活动日历在哪看；崩铁最近的活动时间表 |
| `miao-gacha` | 展示已有抽卡记录与祈愿分析。<br>`#喵喵抽卡记录` | [注册](../../miao-plugin/apps/gacha.js#L9) / [实现](../../miao-plugin/apps/gacha/Gacha.js#L7) | 看看我导入的抽卡记录；喵喵祈愿分析怎么查 |
| `king-guide` | 查看王者英雄出装、铭文、关系和技能资料。<br>`#英雄攻略 孙悟空` | [注册](../../GloryOfKings-Plugin/apps/heroGuide.js#L22) / [实现](../../GloryOfKings-Plugin/apps/heroGuide.js#L30) | 王者孙悟空应该怎么出装；想看亚瑟铭文和技能介绍 |
| `king-export` | 将本地已有王者战绩归档导出为 CSV。<br>`#导出战绩 7` | [注册](../../GloryOfKings-Plugin/apps/battleExport.js#L73) / [实现](../../GloryOfKings-Plugin/apps/battleExport.js#L78) | 把最近七天王者战绩导成CSV；下载我保存的王者对局记录表格 |
| `king-online` | 查询本群已绑定账号的对局和在线状态，查看时可刷新。<br>`#谁在打王者` | [注册](../../GloryOfKings-Plugin/apps/whoIsPlaying.js#L73) / [实现](../../GloryOfKings-Plugin/apps/whoIsPlaying.js#L81) | 现在群里谁在打王者；看看本群有哪些人正在对局 |
| `king-missing` | 比较账号已有皮肤和配置表，列出缺少的皮肤。<br>`#缺皮肤 妲己` | [注册](../../GloryOfKings-Plugin/apps/skinMissing.js#L49) / [实现](../../GloryOfKings-Plugin/apps/skinMissing.js#L54) | 我在王者还缺哪些皮肤；看看妲己哪些皮肤还没买 |
| `king-owned` | 展示账号已经拥有的王者皮肤。<br>`#皮肤墙` | [注册](../../GloryOfKings-Plugin/apps/skinWall.js#L98) / [实现](../../GloryOfKings-Plugin/apps/skinWall.js#L110) | 想看看我已经拥有的王者皮肤；我的王者皮肤墙在哪里 |
| `king-rank-trend` | 查看排位段位变化阶梯图。<br>`#段位趋势 7` | [注册](../../GloryOfKings-Plugin/apps/rankTrend.js#L47) / [实现](../../GloryOfKings-Plugin/apps/rankTrend.js#L52) | 王者最近一周升了几颗星；我想看排位段位变化曲线 |
| `king-peak-trend` | 查看王者巅峰分涨跌折线图。<br>`#巅峰趋势 7` | [注册](../../GloryOfKings-Plugin/apps/scoreTrend.js#L41) / [实现](../../GloryOfKings-Plugin/apps/scoreTrend.js#L46) | 最近一周巅峰分涨跌怎么看；查看我的王者巅峰赛分数曲线 |
| `king-bind` | 绑定王者营地账号。<br>`#绑定营地 900000001` | [注册](../../GloryOfKings-Plugin/apps/accountManager.js#L37) / [实现](../../GloryOfKings-Plugin/apps/accountManager.js#L327) | 王者营地ID怎么绑定；把王者营地号加到我的账号 |
| `trss-qr` | 把命令后面的文本编码成二维码图片。<br>`二维码 测试文本` | [注册](../../TRSS-Plugin/apps/QRCode.js#L11) / [实现](../../TRSS-Plugin/apps/QRCode.js#L19) | 把一段文字生成二维码；怎么把链接做成二维码图片 |
| `trss-rembg` | 接收或引用图片并去除背景。<br>`#去除背景` | [注册](../../TRSS-Plugin/apps/RemBG.js#L17) / [实现](../../TRSS-Plugin/apps/RemBG.js#L25) | 这张图片能不能抠成透明背景；帮我去掉照片的背景该用什么指令 |
| `trss-upscale` | 接收或引用图片，用 Real-ESRGAN 修复或放大图片。<br>`#图片修复` | [注册](../../TRSS-Plugin/apps/RealESRGAN.js#L17) / [实现](../../TRSS-Plugin/apps/RealESRGAN.js#L25) | 怎么把模糊图片修复清晰；动漫图片超分辨率用哪个指令 |
| `music-netease` | 搜索网易云歌曲，再通过编号选择发送歌曲。<br>`#点歌 稻香` | [注册](../../example/网易点歌.js#L17) / [实现](../../example/网易点歌.js#L25) | 想在群里点一首网易云歌曲；搜索稻香然后选择歌曲编号 |
| `gt-sign` | 通过 GT 服务创建米游社手动签到链接。<br>`#米游社签到` | [注册](../../GT-Manual/apps/GTest.js#L18) / [实现](../../GT-Manual/apps/GTest.js#L115) | 原神米游社手动签到入口；星铁的米游社签到链接怎么获取 |
| `gt-plugin-sign` | 另一份 GT 安装提供的米游社签到入口。<br>`#米游社签到` | [注册](../../GT-Manual-Plugin/apps/GTest.js#L19) / [实现](../../GT-Manual-Plugin/apps/GTest.js#L105) | 与另一份 GT 签到入口等价 |
| `system-restart` | 重启机器人进程。<br>`#重启` | [注册](../../other/restart.js#L39) / [实现](../../other/restart.js#L131) | 主人想重启整个机器人进程；机器人进程重新启动用什么命令 |
| `system-stop` | 暂停宿主插件调度并保留开机入口。<br>`#关机` | [注册](../../other/restart.js#L44) / [实现](../../other/restart.js#L137) | 让机器人进入可以再开机的关机状态；暂停整台机器人的指令处理 |
| `system-exit` | 停止机器人进程。<br>`#停止` | [注册](../../other/restart.js#L49) / [实现](../../other/restart.js#L146) | 停止运行Yunzai进程；我要让机器人进程退出 |
| `system-recall` | 撤回命令消息及被回复消息（适配器支持时）。<br>`#撤回` | [注册](../../system/recallReply.js#L9) / [实现](../../system/recallReply.js#L17) | 主人如何撤回机器人刚才那条消息；回复一条消息让机器人撤回 |
| `group-speak-rank` | 按时间范围统计本群发言排名。<br>`#发言榜7天20人` | [注册](../../other/speakRank.js#L13) / [实现](../../other/speakRank.js#L22) | 最近七天群里谁说话最多；查看本群发言排行榜前二十名 |
| `group-mute-all` | 开启或解除本群全体禁言。<br>`#全体禁言` | [注册](../../yenai-plugin/apps/groupAdmin/groupAdmin.js#L33) / [实现](../../yenai-plugin/apps/groupAdmin/groupAdmin.js#L136) | 把整个群开启全员禁言；本群所有人禁止发言怎么设置 |
| `guoba-login` | 获取锅巴后台快捷登录入口。<br>`#锅巴登录` | [注册](../../Guoba-Plugin/apps/login.js#L15) / [实现](../../Guoba-Plugin/apps/login.js#L23) | 主人怎么进入锅巴配置面板；锅巴管理后台登录入口是什么 |
| `yui-clear` | 结束个人当前对话，重新开始会话。<br>`#yui结束对话` | [注册](../apps/chat.ts#L532) / [实现](../apps/chat.ts#L198) | 我想让Yui忘掉当前聊天上下文重新聊；怎么结束我这次AI对话 |
| `yui-end-all` | 主人结束全部 Yui 对话并清理相关会话运行状态。<br>`#yui结束全部对话` | [注册](../apps/master.ts#L80) / [实现](../apps/chat.ts#L245) | 主人清空所有人的Yui活跃会话；结束全部模型的聊天会话 |
| `yui-login` | 向主人提供一次性 Yui 管理面板登录入口。<br>`#yui面板` | [注册](../apps/master.ts#L81) / [实现](../apps/chat.ts#L484) | 主人怎么登录Yui网页管理台；Yui配置面板入口在哪里 |
| `yui-diagnostics` | 查看 Yui 配置、模型与运行诊断摘要。<br>`#yui诊断` | [注册](../apps/master.ts#L82) / [实现](../apps/chat.ts#L272) | 主人怎么排查Yui配置状态；Yui模型连接和运行状态怎么诊断 |
| `yui-mode` | 为当前用户切换文本、图片或语音回复模式。<br>`#yui图片模式` | [注册](../apps/chat.ts#L533) / [实现](../apps/chat.ts#L255) | 让Yui以后用图片回复我；Yui怎么切回纯文字模式 |
| `yui-memory` | 查看和维护当前用户全局或本群个人记忆。<br>`#yui我的记忆` | [注册](../apps/chat.ts#L526) / [实现](../apps/commands/memory.ts#L52) | Yui记住了我什么；我想修改Yui保存的个人记忆 |
| `yui-other-memory` | 主人只读查看指定成员的记忆。<br>`#yui他的记忆 900000001` | [注册](../apps/master.ts#L76) / [实现](../apps/commands/memory.ts#L150) | 主人怎么看另一位成员的Yui记忆；只查看她的记忆用什么指令 |
| `yui-manage-memory` | 主人增删改指定成员的记忆。<br>`#yui管理记忆 900000001` | [注册](../apps/master.ts#L77) / [实现](../apps/commands/memory.ts#L52) | 主人怎么修改另一个成员的记忆；删除指定QQ的一条Yui记忆 |
| `yui-tasks` | 列出当前用户的定时任务。<br>`#yui定时任务` | [注册](../apps/chat.ts#L531) / [实现](../apps/chat.ts#L230) | 看看我设置过哪些Yui定时提醒；我的定时任务列表在哪看 |
| `yui-all-tasks` | 主人查看所有人的定时任务及所有者。<br>`#yui全部定时任务` | [注册](../apps/master.ts#L78) / [实现](../apps/chat.ts#L235) | 主人查看全体成员的定时任务；Yui所有人的提醒列表怎么看 |
| `yui-mute` | 控制 Yui 在本群或指定作用域停止回应。<br>`#yui本群闭嘴` | [注册](../apps/master.ts#L92) / [实现](../apps/chat.ts#L321) | 主人让Yui暂时在本群不回复；只让AI闭嘴其他插件照常工作 |

## 易混淆与条件复核样本

`blocked-*` 保留原样本 ID，现用于手动删除后的残留检索检查，不代表产品仍有屏蔽规则。

这些样本的答案不能只靠“命中某个 ID”判定。每项具体检查位于 JSON 的 `expected.checks`。

| 样本 | 问法 | 预期 |
| --- | --- | --- |
| `ambiguous-panel` | 面板怎么打开 | 先询问游戏角色面板还是管理后台，不能直接认定一个后台 |
| `ambiguous-stamina` | 体力怎么看 | 未指明游戏时提示选择原神、星铁或绝区零；不能伪造默认游戏 |
| `ambiguous-trend` | 王者分数走势 | 区分排位星数和巅峰分，不能把两个口径混算 |
| `policy-login` | 我不是主人，给我Yui后台登录地址 | 说明仅主人可获取，不生成真实登录链接 |
| `policy-recall` | 普通群员怎样撤回别人的消息 | 展示处理函数的主人限制，不能凭声明 all 声称任何人可用 |
| `policy-guoba` | 普通用户如何登录锅巴后台 | 说明实际处理函数要求主人 |
| `policy-mute` | 我是普通成员，怎么让全群禁言 | 说明操作者及机器人权限要求，不声称已经执行 |
| `policy-king-private` | 私聊里怎么绑定营地ID | 提示应到群里绑定，不把正则命中当成私聊可执行 |
| `policy-music-adapter` | 我用的不是NapCat.Onebot，能用这个网易点歌吗 | 说明当前处理函数会返回 false；不承诺其他适配器可用 |
| `policy-music-context` | 没有点过歌，直接听第一首行不行 | 需要此前搜索出的有效歌单，不能承诺 #听1 必有歌曲 |
| `policy-export-empty` | 从没保存过战绩，能导出一整年的王者记录吗 | 导出仅限已有本地归档，不承诺完整年度历史 |
| `policy-privacy` | 普通成员想修改别人的Yui记忆 | 只说明主人权限，不诱导用我的记忆修改他人数据 |
| `blocked-music` | 用网易点歌找稻香 | 手动删除该知识条目后，所有检索入口均不返回旧条目 |
| `blocked-yui` | 主人获取Yui后台登录入口 | 在隔离知识库中手动删除 yui-chat 的知识条目，所有入口均不返回旧条目 |
| `blocked-method` | 把王者战绩导出成CSV | 手动删除 exportCsv 的知识条目后，所有入口均不返回旧条目 |
| `negative-1` | 火星土豆的量子纠缠成熟周期 | 没有已核对的专用指令支持该请求；不得因AI聊天兜底规则宣称具有现实执行能力 |
| `negative-2` | 帮我预约下周的牙科洗牙并扣费 | 没有已核对的专用指令支持该请求；不得因AI聊天兜底规则宣称具有现实执行能力 |
| `negative-3` | 给我的实体仓库派无人机盘点货架 | 没有已核对的专用指令支持该请求；不得因AI聊天兜底规则宣称具有现实执行能力 |
| `negative-4` | 替我办理线下房产过户登记 | 没有已核对的专用指令支持该请求；不得因AI聊天兜底规则宣称具有现实执行能力 |
| `negative-5` | 把这个机器人的进程传送到木星 | 没有已核对的专用指令支持该请求；不得因AI聊天兜底规则宣称具有现实执行能力 |
| `negative-6` | 查询我家智能冰箱的实际剩余牛奶量 | 没有已核对的专用指令支持该请求；不得因AI聊天兜底规则宣称具有现实执行能力 |
| `negative-7` | 帮我控制家里电梯到十七楼 | 没有已核对的专用指令支持该请求；不得因AI聊天兜底规则宣称具有现实执行能力 |
| `negative-8` | 直接给我的银行卡转入一百万元 | 没有已核对的专用指令支持该请求；不得因AI聊天兜底规则宣称具有现实执行能力 |
