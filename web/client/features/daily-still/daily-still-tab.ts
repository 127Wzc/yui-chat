import { computed, reactive, ref, watch } from "vue"
import { request, saveConfigPatch, setDirtyScope, store, toast } from "../../app/store/store.js"
import { asRecord, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { sourceLabel } from "../tools/shared.js"
import { HelpTip, Icon, Panel, Field, Switch, StatusDot } from "../../ui/components.js"

interface DailyStillDraft {
  enabled: boolean
  privateEnabled: boolean
  primaryTool: string
  fallbackTool: string
  adapterConfigs: UnknownRecord
  adapterConfigJson: string
  candidateCount: number
  selectionMode: string
  conversationEnabled: boolean
  conversationProbability: number
  ambientEnabled: boolean
  ambientProbability: number
  ambientWindowSeconds: number
  ambientMaxMessages: number
  idleEnabled: boolean
  idleGroups: string
  idleIntervalSeconds: number
  idleMinIdleSeconds: number
  idleProbability: number
  idleStart: string
  idleEnd: string
  allowlist: string
  blocklist: string
  cooldownSeconds: number
  attemptIntervalSeconds: number
  dailyQuota: number
  recentWindowSeconds: number
  contextTtlSeconds: number
  intentTask: string
  intentTimeoutSeconds: number
  moodEnabled: boolean
  moodDecaySeconds: number
  testKeyword: string
  testTags: string
  testGroupId: string
}

function text(value: unknown): string { return typeof value === "string" ? value : String(value ?? "") }
function number(value: unknown, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }
function seconds(value: unknown, fallback: number, legacyMs?: unknown, legacyMinutes?: unknown): number {
  if (value !== undefined && Number.isFinite(Number(value))) return Math.max(0, Number(value))
  if (legacyMs !== undefined && Number.isFinite(Number(legacyMs))) return Math.max(0, Number(legacyMs) / 1000)
  if (legacyMinutes !== undefined && Number.isFinite(Number(legacyMinutes))) return Math.max(0, Number(legacyMinutes) * 60)
  return fallback
}
function bool(value: unknown, fallback = false): boolean { return typeof value === "boolean" ? value : fallback }
function list(value: unknown): string[] { return (Array.isArray(value) ? value : text(value).split(/[\n,，、|]+/)).map(text).map(item => item.trim()).filter(Boolean) }
function join(value: unknown): string { return list(value).join(", ") }
function objectJson(value: unknown): string {
  const source = asRecord(value)
  return Object.keys(source).length ? JSON.stringify(source, null, 2) : ""
}
function parseObjectJson(value: string): UnknownRecord | null {
  const source = value.trim()
  if (!source) return {}
  try {
    const parsed = JSON.parse(source)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as UnknownRecord : null
  } catch {
    return null
  }
}

function initDraft(config: UnknownRecord): DailyStillDraft {
  const persona = asRecord(config.persona)
  const cfg = asRecord(persona.stickerExpression)
  const binding = asRecord(cfg.binding)
  const conversation = asRecord(cfg.conversation)
  const ambient = asRecord(cfg.ambient)
  const idle = asRecord(cfg.idle)
  const hours = asRecord(idle.allowedHours)
  const scope = asRecord(cfg.groupScope)
  const primaryTool = text(binding.primaryTool || binding.tool || "mcp_imagTag-mcp_search_images")
  const adapterConfigs = asRecord(binding.adapterConfigs)
  return {
    enabled: bool(cfg.enabled), privateEnabled: bool(cfg.privateEnabled),
    primaryTool, fallbackTool: text(binding.fallbackTool), adapterConfigs, adapterConfigJson: objectJson(adapterConfigs[primaryTool]),
    candidateCount: number(binding.candidateCount, 10), selectionMode: text(binding.selectionMode || "randomTop"),
    conversationEnabled: bool(conversation.enabled), conversationProbability: number(conversation.probabilityPercent, 20),
    ambientEnabled: bool(ambient.enabled), ambientProbability: number(ambient.probabilityPercent, 10), ambientWindowSeconds: seconds(ambient.windowSeconds, 15, ambient.windowMs), ambientMaxMessages: number(ambient.maxMessages, 8),
    idleEnabled: bool(idle.enabled), idleGroups: join(idle.groups), idleIntervalSeconds: seconds(idle.intervalSeconds, 1800, undefined, idle.intervalMinutes), idleMinIdleSeconds: seconds(idle.minIdleSeconds, 1800, undefined, idle.minIdleMinutes), idleProbability: number(idle.probabilityPercent, 10), idleStart: text(hours.start || "00:00"), idleEnd: text(hours.end || "23:59"),
    allowlist: join(scope.allowlist), blocklist: join(scope.blocklist),
    cooldownSeconds: seconds(cfg.cooldownSeconds, 1800, cfg.cooldownMs), attemptIntervalSeconds: seconds(cfg.attemptIntervalSeconds, 300, cfg.attemptIntervalMs), dailyQuota: number(cfg.dailyQuota, 5), recentWindowSeconds: seconds(cfg.recentWindowSeconds, 7200, undefined, cfg.recentWindowMinutes), contextTtlSeconds: seconds(cfg.contextTtlSeconds, 900, cfg.contextTtlMs), intentTask: text(cfg.intentTask || "replyer"), intentTimeoutSeconds: seconds(cfg.intentTimeoutSeconds, 30, cfg.intentTimeoutMs), moodEnabled: bool(cfg.moodEnabled, true), moodDecaySeconds: seconds(cfg.moodDecaySeconds, 14400, undefined, cfg.moodDecayMinutes),
    testKeyword: "安慰加班后疲惫的朋友，温柔心疼，可爱的抱抱或拍拍头表情包", testTags: "", testGroupId: "",
  }
}

function buildConfig(draft: DailyStillDraft): UnknownRecord {
  const adapterConfigs = { ...draft.adapterConfigs }
  const adapterConfig = parseObjectJson(draft.adapterConfigJson)
  if (adapterConfig && draft.primaryTool.trim()) adapterConfigs[draft.primaryTool.trim()] = adapterConfig
  return {
    enabled: draft.enabled, privateEnabled: draft.privateEnabled,
    binding: { primaryTool: draft.primaryTool.trim() || "mcp_imagTag-mcp_search_images", fallbackTool: draft.fallbackTool.trim(), tool: draft.primaryTool.trim() || "mcp_imagTag-mcp_search_images", candidateCount: draft.candidateCount, selectionMode: draft.selectionMode, adapterConfigs },
    conversation: { enabled: draft.conversationEnabled, probabilityPercent: draft.conversationProbability },
    ambient: { enabled: draft.ambientEnabled, probabilityPercent: draft.ambientProbability, windowSeconds: draft.ambientWindowSeconds, maxMessages: draft.ambientMaxMessages },
    idle: { enabled: draft.idleEnabled, groups: list(draft.idleGroups), intervalSeconds: draft.idleIntervalSeconds, minIdleSeconds: draft.idleMinIdleSeconds, probabilityPercent: draft.idleProbability, allowedHours: { start: draft.idleStart, end: draft.idleEnd } },
    groupScope: { allowlist: list(draft.allowlist), blocklist: list(draft.blocklist) },
    cooldownSeconds: draft.cooldownSeconds, attemptIntervalSeconds: draft.attemptIntervalSeconds, dailyQuota: draft.dailyQuota, recentWindowSeconds: draft.recentWindowSeconds, contextTtlSeconds: draft.contextTtlSeconds,
    intentTask: draft.intentTask.trim() || "replyer", intentTimeoutSeconds: draft.intentTimeoutSeconds, moodEnabled: draft.moodEnabled, moodDecaySeconds: draft.moodDecaySeconds,
  }
}

export const DailyStillTab = {
  name: "DailyStillTab",
  components: { HelpTip, Icon, Panel, Field, Switch, StatusDot },
  setup() {
    const draft = reactive(initDraft(asRecord(store.config)))
    const saved = ref(JSON.stringify(buildConfig(draft)))
    const busy = ref(false)
    const testBusy = ref(false)
    const testResult = ref<UnknownRecord | null>(null)
    const isDirty = computed(() => JSON.stringify(buildConfig(draft)) !== saved.value)
    const status = computed(() => asRecord(store.dailyStill))
    const statusConfig = computed(() => asRecord(asRecord(status.value).status))
    const scheduler = computed(() => asRecord(statusConfig.value.scheduler))
    const discoveredTools = computed(() => Array.isArray(status.value.channels) ? status.value.channels as UnknownRecord[] : Array.isArray(status.value.tools) ? status.value.tools as UnknownRecord[] : [])
    const channelOptions = computed(() => {
      const options = discoveredTools.value.map(item => ({ value: text(item.name), label: `${text(item.displayNameZh || item.name)}${item.enabled === false ? '（未启用）' : ''}` }))
      const selected = [draft.primaryTool, draft.fallbackTool].filter(Boolean)
      for (const name of selected) if (!options.some(item => item.value === name)) options.push({ value: name, label: `${name}（当前配置但未发现）` })
      return options.length ? options : [{ value: draft.primaryTool || "mcp_imagTag-mcp_search_images", label: draft.primaryTool || "mcp_imagTag-mcp_search_images" }]
    })
    const fallbackOptions = computed(() => [{ value: "", label: "不设置回退" }, ...channelOptions.value.filter(item => item.value !== draft.primaryTool)])
    const selectedChannel = computed(() => discoveredTools.value.find(item => text(item.name) === draft.primaryTool) || null)
    const selectedFallbackChannel = computed(() => discoveredTools.value.find(item => text(item.name) === draft.fallbackTool) || null)
    watch(() => draft.primaryTool, (next, previous) => {
      const previousConfig = parseObjectJson(draft.adapterConfigJson)
      if (previous && previousConfig) draft.adapterConfigs[previous] = previousConfig
      draft.adapterConfigJson = objectJson(draft.adapterConfigs[next])
    })
    function channelSourceLabel(channel: UnknownRecord | null): string { return channel ? sourceLabel(channel.source) : "未发现" }
    function channelSourceTone(channel: UnknownRecord | null): string {
      if (!channel) return "subtle"
      return text(channel.source) === "builtin" ? "on" : text(channel.source) === "mcp" ? "risk-medium" : text(channel.source) === "custom" ? "accent" : "subtle"
    }

    function markDirty() { setDirtyScope("daily-still", isDirty.value) }
    async function save() {
      busy.value = true
      try {
        if (draft.adapterConfigJson.trim() && !parseObjectJson(draft.adapterConfigJson)) throw new Error("当前渠道适配规则 JSON 格式无效。")
        await saveConfigPatch({ "persona.stickerExpression": buildConfig(draft) }, "daily-still")
        saved.value = JSON.stringify(buildConfig(draft))
        setDirtyScope("daily-still", false)
        toast("日常定格配置已保存", "success")
      } catch (error) { toast(errorMessage(error)) } finally { busy.value = false }
    }
    async function testBinding() {
      testBusy.value = true
      try {
        const response = await request("/api/daily-still/test", { method: "POST", body: JSON.stringify({ keyword: draft.testKeyword, tags: list(draft.testTags), groupId: draft.testGroupId, binding: buildConfig(draft).binding }) })
        testResult.value = asRecord(response.result)
        const result = asRecord(response.result)
        const selection = asRecord(result.selection)
        const diagnostics = Array.isArray(selection.errors) ? selection.errors.length : 0
        toast(result.ok ? "已找到候选图片" : diagnostics ? `渠道不可用，已生成 ${diagnostics} 条诊断` : "没有找到可用候选", result.ok ? "success" : "warn")
      } catch (error) { testResult.value = { ok: false, reason: errorMessage(error) }; toast(errorMessage(error)) } finally { testBusy.value = false }
    }
    async function runIdlePreview() {
      try {
        const response = await request("/api/daily-still/run", { method: "POST", body: JSON.stringify({ dryRun: true }) })
        testResult.value = asRecord(response.result)
        toast("已完成空闲触发检查", "success")
      } catch (error) { toast(errorMessage(error)) }
    }
    function refresh() { void request("/api/daily-still").then(value => { store.dailyStill = value }).catch(error => toast(errorMessage(error))) }

    return { store, draft, busy, testBusy, testResult, isDirty, statusConfig, scheduler, discoveredTools, channelOptions, fallbackOptions, selectedChannel, selectedFallbackChannel, channelSourceLabel, channelSourceTone, markDirty, save, testBinding, runIdlePreview, refresh }
  },
  template: `
    <div class="stack daily-still-page" @input="markDirty" @change="markDirty">
      <section class="panel daily-still-hero">
        <div><span class="eyebrow">CHAT EXPRESSION</span><h2>日常定格</h2><p>像人在聊天时顺手发一张自拍或表情包。它只负责判断语境、选图和投递，真正的发送仍走统一消息出口。</p></div>
        <div class="hero-actions"><StatusDot :state="draft.enabled ? 'on' : 'off'" :label="draft.enabled ? '总开关已开' : '总开关已关'" /><button class="btn primary" type="button" :disabled="busy" @click="save"><Icon name="save" :size="14" />{{ busy ? '保存中' : '保存配置' }}</button></div>
      </section>

      <Panel title="总开关与触发范围" icon="image" subtitle="群聊必须同时命中白名单；黑名单优先级更高。每次触发机会只抽样一次。">
        <div class="form-grid">
          <div class="setting-card"><div class="setting-title"><b>启用日常定格</b><HelpTip tip="关闭后，三种入口都不会判断或发送表情包。" /></div><Switch v-model="draft.enabled" /></div>
          <div class="setting-card"><div class="setting-title"><b>允许私聊触发</b><HelpTip tip="私聊不受群白名单影响；关闭时只处理群聊白名单。" /></div><Switch v-model="draft.privateEnabled" /></div>
        </div>
        <div class="form-grid two">
          <Field v-model="draft.allowlist" label="群聊白名单" type="textarea" :rows="3" placeholder="填写群号，逗号或换行分隔" tip="只有列在这里的群才会触发。留空表示不允许任何群聊触发。" />
          <Field v-model="draft.blocklist" label="群聊黑名单" type="textarea" :rows="3" placeholder="填写需要排除的群号" tip="黑名单优先于白名单；适合临时停用某个群。" />
        </div>
      </Panel>

      <Panel title="三个触发入口" icon="activity" subtitle="对话完成、群聊旁观窗口和空闲检查共享冷却、配额与去重状态。">
        <div class="form-grid three">
          <div class="setting-card"><div class="setting-title"><b>对话完成</b><HelpTip tip="机器人完成一次正常文字回复后，独立判断是否补发一张图。<EMPTY> 不会触发。" /></div><Switch v-model="draft.conversationEnabled" /><Field v-model="draft.conversationProbability" label="概率 %" type="number" /></div>
          <div class="setting-card"><div class="setting-title"><b>群聊旁观</b><HelpTip tip="群消息窗口结束后只判断一次；如果机器人已经回复或窗口被新消息取消，就不会发送。" /></div><Switch v-model="draft.ambientEnabled" /><Field v-model="draft.ambientProbability" label="概率 %" type="number" /><Field v-model="draft.ambientWindowSeconds" label="窗口 秒" type="number" tip="连续群消息合并后等待多久再判断一次。" /><Field v-model="draft.ambientMaxMessages" label="最多参考消息" type="number" /></div>
          <div class="setting-card"><div class="setting-title"><b>空闲检查</b><HelpTip tip="按定时器查看指定白名单群；只有超过最小空闲时长且在允许时段内才会判断。" /></div><Switch v-model="draft.idleEnabled" /><Field v-model="draft.idleProbability" label="概率 %" type="number" /><Field v-model="draft.idleIntervalSeconds" label="检查间隔 秒" type="number" /><Field v-model="draft.idleMinIdleSeconds" label="最小空闲 秒" type="number" /></div>
        </div>
        <div class="form-grid three"><Field v-model="draft.idleGroups" label="空闲检查群号" type="textarea" :rows="2" tip="这里只是空闲定时器的目标群，仍必须出现在群聊白名单。" /><Field v-model="draft.idleStart" label="允许开始时间" placeholder="00:00" tip="使用本机时区的 HH:mm。" /><Field v-model="draft.idleEnd" label="允许结束时间" placeholder="23:59" tip="支持跨午夜区间，例如 22:00 到 02:00。" /></div>
      </Panel>

      <Panel title="共享限制与短期心情" icon="clock">
        <div class="form-grid three"><Field v-model="draft.cooldownSeconds" label="成功冷却 秒" type="number" tip="同一会话成功发送后，在此时间内不再发送。" /><Field v-model="draft.attemptIntervalSeconds" label="尝试间隔 秒" type="number" tip="即使上次没有选到图，也会限制再次启动意图判断。" /><Field v-model="draft.dailyQuota" label="每日上限" type="number" tip="按会话统计成功投递次数；填 0 表示不设上限。" /><Field v-model="draft.recentWindowSeconds" label="去重窗口 秒" type="number" tip="近期成功发送的图片 ID 会从候选中排除。" /><Field v-model="draft.contextTtlSeconds" label="语境有效期 秒" type="number" tip="保留给协调层的短期语境期限。" /><Field v-model="draft.intentTask" label="意图模型任务" tip="使用独立结构化判断任务；该请求不会开放工具。" /><Field v-model="draft.intentTimeoutSeconds" label="意图超时 秒" type="number" /><Field v-model="draft.moodDecaySeconds" label="心情有效期 秒" type="number" tip="短期心情只用于后续表达提示，到期自动失效。" /></div>
        <div class="setting-card inline"><div class="setting-title"><b>记录短期心情</b><HelpTip tip="从意图判断中提炼情绪和强度，作为下一次独立判断的轻量参考，不写入长期记忆。" /></div><Switch v-model="draft.moodEnabled" /></div>
      </Panel>

      <Panel title="图库渠道与测试" icon="link" subtitle="只显示符合日常定格入参与图片候选出参约定的只读工具；保存后按主渠道失败再尝试回退渠道。">
        <div class="form-grid two daily-still-channel-pickers"><div class="daily-still-channel-picker"><div class="daily-still-channel-picker-head"><span>主渠道 <HelpTip tip="首选的搜图渠道。列表来自统一工具注册表，只显示符合图片候选契约的能力。" /></span><span class="badge daily-still-source-badge" :class="channelSourceTone(selectedChannel)">{{ channelSourceLabel(selectedChannel) }}</span></div><Field v-model="draft.primaryTool" type="select" :options="channelOptions" /></div><div v-if="channelOptions.length > 1" class="daily-still-channel-picker"><div class="daily-still-channel-picker-head"><span>回退渠道 <HelpTip tip="主渠道连接失败、返回空候选或被停用时才尝试；留空表示不回退。" /></span><span class="badge daily-still-source-badge" :class="channelSourceTone(selectedFallbackChannel)">{{ channelSourceLabel(selectedFallbackChannel) }}</span></div><Field v-model="draft.fallbackTool" type="select" :options="fallbackOptions" /></div></div>
        <p v-if="selectedChannel" class="muted small">{{ selectedChannel.reason }}<span v-if="selectedChannel.serverName"> · 服务：{{ selectedChannel.serverName }}</span></p>
        <p v-else-if="discoveredTools.length" class="muted small">当前配置的主渠道未发现；已发现 {{ discoveredTools.length }} 个可用渠道，请重新选择并保存。</p>
        <p v-else class="muted small">尚未发现符合约定的已注册渠道；先在 AI 能力中连接并开放 MCP，或刷新本页重新检查。</p>
        <details class="daily-still-advanced"><summary>高级渠道设置 <span>候选数量、选择方式与适配规则</span><Icon name="chevron-down" :size="13" /></summary>
          <div class="form-grid two"><Field v-model="draft.candidateCount" label="候选数量" type="number" tip="每次从图库召回的候选数，之后由本地按语境和去重选择一张。" /><Field v-model="draft.selectionMode" label="选择方式" type="select" :options="[{value:'randomTop',label:'相近候选随机'},{value:'best',label:'最高匹配'}]" /></div>
          <Field v-model="draft.adapterConfigJson" label="当前渠道适配规则 JSON" type="textarea" :rows="8" placeholder="可选，例如 {\n  &quot;inputMapping&quot;: { &quot;keyword&quot;: &quot;query&quot; },\n  &quot;outputMapping&quot;: { &quot;candidatesPath&quot;: &quot;data.items&quot; }\n}" tip="仅供日常定格内部使用，不会新增模型工具。inputMapping 映射 keyword/tags/count；fixedArguments 添加固定参数；outputMapping 指定候选路径和字段。" />
        </details>
        <div class="form-grid three"><Field v-model="draft.testKeyword" label="测试表达意图" type="textarea" :rows="3" tip="测试只执行搜图和候选归一化，不会发送消息，也不计入配额。" /><Field v-model="draft.testTags" label="必须标签" placeholder="可选，逗号分隔" /><Field v-model="draft.testGroupId" label="测试群号" placeholder="可选；仅用于模拟群聊权限" /></div>
        <div class="action-bar"><button class="btn" type="button" :disabled="testBusy" @click="testBinding"><Icon name="search" :size="14" />{{ testBusy ? '测试中' : '测试渠道选图' }}</button><button class="btn outline" type="button" @click="runIdlePreview"><Icon name="clock" :size="14" />检查空闲入口</button><button class="btn outline" type="button" @click="refresh"><Icon name="refresh" :size="14" />刷新绑定状态</button></div>
        <div v-if="testResult" class="result-box"><pre>{{ JSON.stringify(testResult, null, 2) }}</pre><img v-if="testResult.preview && testResult.selection?.selected?.url" :src="testResult.selection.selected.url" alt="候选表情包预览" /></div>
        <p v-if="discoveredTools.length" class="muted small">已发现 {{ discoveredTools.length }} 个符合约定的渠道；日常定格最多按主、回退顺序使用两个。</p>
      </Panel>

      <Panel title="运行状态" icon="activity"><div class="metric-grid"><div class="metric"><span>调度器</span><b>{{ scheduler.active ? '运行中' : '未运行' }}</b></div><div class="metric"><span>已尝试</span><b>{{ scheduler.attempts || 0 }}</b></div><div class="metric"><span>已发送</span><b>{{ scheduler.sent || 0 }}</b></div><div class="metric"><span>待处理窗口</span><b>{{ scheduler.pendingWindows || 0 }}</b></div></div><p v-if="scheduler.lastError" class="form-error">{{ scheduler.lastError }}</p><p v-else class="muted small">保存后立即热应用；发送成功才会更新冷却、配额和去重记录。</p></Panel>
    </div>
  `,
}
