import { computed, reactive, ref, watch } from "vue"
import { request, saveConfigPatch, setDirtyScope, setTab, store, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { Collapse, Field, HelpTip, Icon, Panel, StatusDot, Switch } from "../../ui/components.js"

interface MoodDraft {
  name: string
  tags: string
  description: string
  keywords: string
  hours: string
  idleOnly: boolean
}

interface DailyStillDraft {
  enabled: boolean
  privateEnabled: boolean
  allowlist: string
  blocklist: string
  conversationEnabled: boolean
  conversationProbability: number
  ambientEnabled: boolean
  ambientProbability: number
  ambientWindowSeconds: number
  ambientMaxMessages: number
  idleEnabled: boolean
  idleProbability: number
  idleGroups: string
  idleIntervalMinutes: number
  idleMinIdleMinutes: number
  idleStart: string
  idleEnd: string
  idleMoods: string[]
  decisionModel: string
  sendThreshold: number
  moodConfidence: number
  decisionTimeoutSeconds: number
  cooldownMinutes: number
  attemptIntervalSeconds: number
  dailyQuota: number
  recentWindowHours: number
  contextTtlSeconds: number
  primaryTool: string
  fallbackTool: string
  candidateCount: number
  topK: number
  adapterConfigs: UnknownRecord
  adapterConfigJson: string
  moods: MoodDraft[]
}

const DEFAULT_TOOL = "mcp_imagTag-mcp_search_images"
const DEFAULT_IDLE_MOODS = ["冒泡", "摸鱼", "吃瓜", "卖萌", "晚安"]

function text(value: unknown): string { return typeof value === "string" ? value : String(value ?? "") }
function number(value: unknown, fallback: number): number { const n = Number(value); return value !== "" && Number.isFinite(n) ? n : fallback }
function seconds(value: unknown, fallback: number, legacyMs?: unknown, legacyMinutes?: unknown): number {
  if (value !== undefined && Number.isFinite(Number(value))) return Math.max(0, Number(value))
  if (legacyMs !== undefined && Number.isFinite(Number(legacyMs))) return Math.max(0, Number(legacyMs) / 1000)
  if (legacyMinutes !== undefined && Number.isFinite(Number(legacyMinutes))) return Math.max(0, Number(legacyMinutes) * 60)
  return fallback
}
function round(value: number, digits = 2): number { const scale = 10 ** digits; return Math.round(value * scale) / scale }
function bool(value: unknown, fallback = false): boolean { return typeof value === "boolean" ? value : fallback }
function list(value: unknown): string[] { return (Array.isArray(value) ? value : text(value).split(/[\s\n,，、|]+/)).map(text).map(item => item.trim()).filter(Boolean) }
function join(value: unknown, separator = ", "): string { return list(value).join(separator) }
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

function moodDraft(value: unknown): MoodDraft {
  const item = asRecord(value)
  return {
    name: text(item.name),
    tags: join(item.tags, " "),
    description: text(item.description),
    keywords: join(item.keywords, " "),
    hours: text(item.hours),
    idleOnly: item.idleOnly === true,
  }
}

function moodValue(item: MoodDraft): UnknownRecord {
  return {
    name: item.name.trim(),
    description: item.description.trim(),
    tags: list(item.tags),
    keywords: list(item.keywords),
    idleOnly: item.idleOnly,
    hours: item.hours.trim(),
  }
}

function initDraft(config: UnknownRecord, moods: unknown[]): DailyStillDraft {
  const cfg = asRecord(asRecord(config.persona).stickerExpression)
  const binding = asRecord(cfg.binding)
  const conversation = asRecord(cfg.conversation)
  const ambient = asRecord(cfg.ambient)
  const idle = asRecord(cfg.idle)
  const hours = asRecord(idle.allowedHours)
  const scope = asRecord(cfg.groupScope)
  const decision = asRecord(cfg.decision)
  const primaryTool = text(binding.primaryTool || binding.tool || DEFAULT_TOOL)
  const adapterConfigs = asRecord(binding.adapterConfigs)
  return {
    enabled: bool(cfg.enabled),
    privateEnabled: bool(cfg.privateEnabled),
    allowlist: join(scope.allowlist, "\n"),
    blocklist: join(scope.blocklist, "\n"),
    conversationEnabled: bool(conversation.enabled),
    conversationProbability: number(conversation.probabilityPercent, 50),
    ambientEnabled: bool(ambient.enabled),
    ambientProbability: number(ambient.probabilityPercent, 30),
    ambientWindowSeconds: seconds(ambient.windowSeconds, 20, ambient.windowMs),
    ambientMaxMessages: number(ambient.maxMessages, 6),
    idleEnabled: bool(idle.enabled),
    idleProbability: number(idle.probabilityPercent, 30),
    idleGroups: join(idle.groups, "\n"),
    idleIntervalMinutes: round(seconds(idle.intervalSeconds, 1800, undefined, idle.intervalMinutes) / 60),
    idleMinIdleMinutes: round(seconds(idle.minIdleSeconds, 3600, undefined, idle.minIdleMinutes) / 60),
    idleStart: text(hours.start || "09:00"),
    idleEnd: text(hours.end || "23:30"),
    idleMoods: Array.isArray(idle.moods) ? list(idle.moods) : [...DEFAULT_IDLE_MOODS],
    decisionModel: text(decision.model),
    sendThreshold: number(decision.sendThreshold, 0.6),
    moodConfidence: number(decision.moodConfidence, 0.3),
    decisionTimeoutSeconds: number(decision.timeoutSeconds, 10),
    cooldownMinutes: round(seconds(cfg.cooldownSeconds, 1200, cfg.cooldownMs) / 60),
    attemptIntervalSeconds: seconds(cfg.attemptIntervalSeconds, 120, cfg.attemptIntervalMs),
    dailyQuota: number(cfg.dailyQuota, 8),
    recentWindowHours: round(seconds(cfg.recentWindowSeconds, 259200, undefined, cfg.recentWindowMinutes) / 3600),
    contextTtlSeconds: seconds(cfg.contextTtlSeconds, 900, cfg.contextTtlMs),
    primaryTool,
    fallbackTool: text(binding.fallbackTool),
    candidateCount: number(binding.candidateCount, 30),
    topK: number(binding.topK, 8),
    adapterConfigs,
    adapterConfigJson: objectJson(adapterConfigs[primaryTool]),
    moods: moods.map(moodDraft),
  }
}

function buildConfig(draft: DailyStillDraft, defaultMoods: unknown[]): UnknownRecord {
  const adapterConfigs = { ...draft.adapterConfigs }
  const adapterConfig = parseObjectJson(draft.adapterConfigJson)
  const primaryTool = draft.primaryTool.trim() || DEFAULT_TOOL
  if (adapterConfig) adapterConfigs[primaryTool] = adapterConfig
  const moods = draft.moods.map(moodValue).filter(item => item.name)
  // 与内置分组一致时不写入配置，后续版本调整默认分组可以直接生效。
  const moodsChanged = JSON.stringify(moods) !== JSON.stringify(defaultMoods.map(item => moodValue(moodDraft(item))))
  return {
    enabled: draft.enabled,
    privateEnabled: draft.privateEnabled,
    groupScope: { allowlist: list(draft.allowlist), blocklist: list(draft.blocklist) },
    conversation: { enabled: draft.conversationEnabled, probabilityPercent: draft.conversationProbability },
    ambient: { enabled: draft.ambientEnabled, probabilityPercent: draft.ambientProbability, windowSeconds: draft.ambientWindowSeconds, maxMessages: draft.ambientMaxMessages },
    idle: {
      enabled: draft.idleEnabled,
      probabilityPercent: draft.idleProbability,
      groups: list(draft.idleGroups),
      intervalSeconds: Math.round(number(draft.idleIntervalMinutes, 30) * 60),
      minIdleSeconds: Math.round(number(draft.idleMinIdleMinutes, 60) * 60),
      allowedHours: { start: draft.idleStart, end: draft.idleEnd },
      moods: [...draft.idleMoods],
    },
    decision: {
      model: draft.decisionModel,
      sendThreshold: draft.sendThreshold,
      moodConfidence: draft.moodConfidence,
      timeoutSeconds: draft.decisionTimeoutSeconds,
    },
    ...(moodsChanged ? { moods } : {}),
    cooldownSeconds: Math.round(number(draft.cooldownMinutes, 20) * 60),
    attemptIntervalSeconds: draft.attemptIntervalSeconds,
    dailyQuota: draft.dailyQuota,
    recentWindowSeconds: Math.round(number(draft.recentWindowHours, 72) * 3600),
    contextTtlSeconds: draft.contextTtlSeconds,
    binding: {
      primaryTool,
      fallbackTool: draft.fallbackTool.trim(),
      tool: primaryTool,
      candidateCount: draft.candidateCount,
      topK: draft.topK,
      adapterConfigs,
    },
  }
}

const REASON_LABELS: Record<string, string> = {
  "model-selected": "决策模型认为适合发送",
  "not-a-moment": "此刻不适合发表情包",
  "no-mood": "没有匹配的情绪",
  "mood-uncertain": "情绪不够明确",
  "keywords-matched": "关键词命中",
  "keywords-no-match": "没有命中任何关键词",
  "no-moods": "没有可用的情绪分组",
  "no-idle-mood": "当前时段没有可用的空闲分组",
  "canceled-after-decision": "判断期间已有新消息或回复",
  sent: "已发送",
}

export const DailyStillTab = {
  name: "DailyStillTab",
  components: { Collapse, Field, HelpTip, Icon, Panel, StatusDot, Switch },
  setup() {
    const status = computed(() => asRecord(store.dailyStill))
    const defaultMoods = computed(() => Array.isArray(status.value.defaultMoods) ? status.value.defaultMoods as unknown[] : [])
    const effectiveMoods = computed(() => Array.isArray(status.value.moods) ? status.value.moods as unknown[] : defaultMoods.value)
    const draft = reactive(initDraft(asRecord(store.config), effectiveMoods.value))
    const saved = ref(JSON.stringify(buildConfig(draft, defaultMoods.value)))
    const busy = ref(false)
    const isDirty = computed(() => JSON.stringify(buildConfig(draft, defaultMoods.value)) !== saved.value)
    watch(isDirty, value => setDirtyScope("daily-still", value))
    // 状态接口晚于配置到达时，用服务端给出的分组补齐草稿，不覆盖已编辑内容。
    watch(effectiveMoods, moods => {
      if (draft.moods.length || !moods.length) return
      draft.moods = moods.map(moodDraft)
      saved.value = JSON.stringify(buildConfig(draft, defaultMoods.value))
    })

    const scheduler = computed(() => asRecord(asRecord(status.value.status).scheduler))
    const lastOutcome = computed(() => asRecord(scheduler.value.lastOutcome))
    const channels = computed(() => asRecords(status.value.channels))
    const channelOptions = computed(() => {
      const options = channels.value.map(item => ({ value: text(item.name), label: `${text(item.displayNameZh || item.name)}${item.enabled === false ? "（未启用）" : ""}` }))
      for (const name of [draft.primaryTool, draft.fallbackTool].filter(Boolean)) {
        if (!options.some(item => item.value === name)) options.push({ value: name, label: `${name}（未发现）` })
      }
      return options.length ? options : [{ value: DEFAULT_TOOL, label: DEFAULT_TOOL }]
    })
    const fallbackOptions = computed(() => [{ value: "", label: "不设置" }, ...channelOptions.value.filter(item => item.value !== draft.primaryTool)])
    const primaryChannel = computed(() => channels.value.find(item => text(item.name) === draft.primaryTool) || null)
    watch(() => draft.primaryTool, (next, previous) => {
      const previousConfig = parseObjectJson(draft.adapterConfigJson)
      if (previous && previousConfig) draft.adapterConfigs[previous] = previousConfig
      draft.adapterConfigJson = objectJson(draft.adapterConfigs[next])
    })

    // 决策模型来自“渠道与模型”里用途为决策的模型；这里只引用，不另存密钥。
    const models = computed(() => asRecords(asRecord(store.config).models))
    const providers = computed(() => asRecords(asRecord(store.config).apiProviders))
    const decisionModels = computed(() => models.value.filter(item => text(item.purpose) === "decision"))
    const decisionOptions = computed(() => [
      { value: "", label: "不使用（本地关键词判断）" },
      ...decisionModels.value.map(item => ({ value: text(item.name), label: `${text(item.name)} · ${text(item.modelIdentifier)}` })),
    ])
    const selectedDecisionModel = computed(() => decisionModels.value.find(item => text(item.name) === draft.decisionModel) || null)
    const decisionProvider = computed(() => {
      const name = text(selectedDecisionModel.value?.apiProvider)
      return providers.value.find(item => text(item.name) === name)
        || providers.value.find(item => text(item.type) === "typesafe")
        || null
    })
    const keyInput = ref("")
    const keyEditing = ref(false)
    const keyBusy = ref(false)
    const decisionTest = ref("")

    async function connectDecisionModel() {
      keyBusy.value = true
      try {
        const apiKey = keyInput.value.trim()
        let provider = decisionProvider.value
        if (!provider) {
          if (!apiKey) throw new Error("请填写 TypeSafe API Key")
          const created = asRecord(await request("/api/providers", { method: "POST", body: JSON.stringify({ templateId: "typesafe", providerName: "typesafe", apiKey }) }))
          store.config = asRecord(created.config)
          provider = asRecord(created.provider)
        } else if (apiKey) {
          const updated = asRecord(await request(`/api/providers/${encodeURIComponent(text(provider.name))}`, { method: "PATCH", body: JSON.stringify({ apiKey }) }))
          store.config = asRecord(updated.config)
        }
        const providerName = text(provider.name)
        let model = decisionModels.value.find(item => text(item.apiProvider) === providerName)
        if (!model) {
          const imported = asRecord(await request(`/api/providers/${encodeURIComponent(providerName)}/models`, { method: "POST", body: JSON.stringify({ modelIdentifiers: ["jev-latest"], purpose: "decision" }) }))
          store.config = asRecord(imported.config)
          model = decisionModels.value.find(item => text(item.apiProvider) === providerName)
        }
        if (model && !draft.decisionModel) draft.decisionModel = text(model.name)
        keyInput.value = ""
        keyEditing.value = false
        toast(apiKey ? "决策模型已连接，记得保存配置" : "决策模型已添加", "success")
      } catch (error) {
        toast(errorMessage(error))
      } finally {
        keyBusy.value = false
      }
    }

    async function testDecisionModel() {
      if (!draft.decisionModel) return
      decisionTest.value = "测试中…"
      try {
        const result = asRecord(asRecord(await request("/api/channels/test", { method: "POST", body: JSON.stringify({ channelId: draft.decisionModel }) })).result)
        decisionTest.value = text(result.text || "测试通过")
      } catch (error) {
        decisionTest.value = errorMessage(error)
      }
    }

    const moodNames = computed(() => draft.moods.map(item => item.name.trim()).filter(Boolean))
    const conversationMoodCount = computed(() => draft.moods.filter(item => item.name.trim() && !item.idleOnly).length)
    function toggleIdleMood(name: string) {
      draft.idleMoods = draft.idleMoods.includes(name) ? draft.idleMoods.filter(item => item !== name) : [...draft.idleMoods, name]
    }
    function addMood() { draft.moods.push({ name: "", tags: "", description: "", keywords: "", hours: "", idleOnly: false }) }
    function removeMood(index: number) { draft.moods.splice(index, 1) }
    function resetMoods() {
      draft.moods = defaultMoods.value.map(moodDraft)
      draft.idleMoods = [...DEFAULT_IDLE_MOODS]
    }

    async function save() {
      busy.value = true
      try {
        if (!parseObjectJson(draft.adapterConfigJson)) throw new Error("渠道适配规则不是有效的 JSON 对象")
        const invalid = draft.moods.find(item => item.name.trim() && !list(item.tags).length)
        if (invalid) throw new Error(`情绪“${invalid.name}”至少需要一个检索标签`)
        await saveConfigPatch({ "persona.stickerExpression": buildConfig(draft, defaultMoods.value) }, "daily-still")
        saved.value = JSON.stringify(buildConfig(draft, defaultMoods.value))
        setDirtyScope("daily-still", false)
      } catch (error) {
        toast(errorMessage(error))
      } finally {
        busy.value = false
      }
    }

    const test = reactive({ mode: "conversation", text: "今天又加班到十点，好累啊", reply: "辛苦啦，早点休息", groupId: "", busy: false })
    const testResult = ref<UnknownRecord | null>(null)
    const testDecision = computed(() => asRecord(testResult.value?.decision))
    const testSelection = computed(() => asRecord(testResult.value?.selection))
    const testImage = computed(() => text(asRecord(testSelection.value.selected).url))
    const testProbabilities = computed(() => Object.entries(asRecord(testDecision.value.probabilities))
      .map(([name, value]) => ({ name, value: Number(value) || 0 }))
      .sort((left, right) => right.value - left.value)
      .slice(0, 5))
    async function runTest() {
      test.busy = true
      try {
        const response = asRecord(await request("/api/daily-still/test", {
          method: "POST",
          body: JSON.stringify({ mode: test.mode, text: test.text, reply: test.mode === "conversation" ? test.reply : "", groupId: test.groupId, draft: buildConfig(draft, defaultMoods.value) }),
        }))
        testResult.value = asRecord(response.result)
      } catch (error) {
        testResult.value = { ok: false, reason: errorMessage(error) }
      } finally {
        test.busy = false
      }
    }
    async function runIdleCheck() {
      try {
        const response = asRecord(await request("/api/daily-still/run", { method: "POST", body: JSON.stringify({ dryRun: true }) }))
        const results = asRecords(asRecord(response.result).results)
        toast(results.length ? results.map(item => `${text(item.groupId) || "群"}：${reasonLabel(item.reason) || (item.dryRun ? "可以发送" : "已处理")}`).join("；") : "没有配置空闲检查群", "info")
      } catch (error) {
        toast(errorMessage(error))
      }
    }
    function refresh() { void request("/api/daily-still").then(value => { store.dailyStill = value }).catch(error => toast(errorMessage(error))) }

    function reasonLabel(value: unknown): string {
      const key = text(value)
      if (REASON_LABELS[key]) return REASON_LABELS[key]
      if (key === "cooldown") return "冷却中"
      if (key === "attempt-interval") return "距离上次尝试太近"
      if (key === "daily-quota") return "今日次数已用完"
      if (key === "probability") return "未命中触发概率"
      return key
    }
    function percent(value: unknown): string {
      const n = Number(value)
      return value === null || value === undefined || !Number.isFinite(n) ? "-" : `${Math.round(n * 100)}%`
    }
    function time(value: unknown): string {
      const date = new Date(text(value))
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    }
    const modeLabels: Record<string, string> = { conversation: "对话", ambient: "旁观", idle: "空闲" }
    const sourceLabels: Record<string, string> = { model: "决策模型", keywords: "本地关键词", idle: "空闲分组" }

    return {
      draft, busy, isDirty, save, refresh, scheduler, lastOutcome,
      channelOptions, fallbackOptions, primaryChannel,
      decisionModels, decisionOptions, selectedDecisionModel, decisionProvider, keyInput, keyEditing, keyBusy, decisionTest, connectDecisionModel, testDecisionModel,
      moodNames, conversationMoodCount, toggleIdleMood, addMood, removeMood, resetMoods,
      test, testResult, testDecision, testSelection, testImage, testProbabilities, runTest, runIdleCheck,
      reasonLabel, percent, time, modeLabels, sourceLabels, openProviders: () => setTab("providers"),
    }
  },
  template: `
    <div class="section-stage ds-page">
      <div class="section-intro">
        <div>
          <h2>日常定格</h2>
          <p>判断聊天里的情绪，在合适的时候发一张对应的表情包。</p>
        </div>
        <div class="row">
          <span v-if="isDirty" class="muted small">有未保存的修改</span>
          <button class="btn primary small" type="button" :disabled="busy || !isDirty" @click="save"><Icon name="save" :size="14" />{{ busy ? '保存中' : '保存' }}</button>
        </div>
      </div>

      <Panel title="启用范围">
        <div class="ds-row">
          <div class="ds-row-text"><strong>启用日常定格</strong><span>关闭后所有入口都不会发送。</span></div>
          <Switch :model-value="draft.enabled" @update:model-value="draft.enabled = $event" />
        </div>
        <Field v-model="draft.allowlist" label="群聊白名单" type="textarea" :rows="2" placeholder="每行一个群号" tip="只有列在这里的群会触发；留空表示所有群都不触发。" />
        <Collapse title="黑名单与私聊" nested>
          <div class="form-grid two">
            <Field v-model="draft.blocklist" label="群聊黑名单" type="textarea" :rows="2" placeholder="每行一个群号" tip="优先于白名单，适合临时停用某个群。" />
            <div class="ds-row ds-row-inline">
              <div class="ds-row-text"><strong>允许私聊</strong><span>私聊不受群名单限制。</span></div>
              <Switch :model-value="draft.privateEnabled" @update:model-value="draft.privateEnabled = $event" />
            </div>
          </div>
        </Collapse>
      </Panel>

      <Panel title="触发时机">
        <div class="ds-trigger">
          <div class="ds-row">
            <div class="ds-row-text"><strong>对话后</strong><span>机器人回复完，按回复内容判断要不要补一张图。</span></div>
            <label v-if="draft.conversationEnabled" class="ds-inline-number"><input type="number" min="0" max="100" v-model.number="draft.conversationProbability" /><span>%</span></label>
            <Switch :model-value="draft.conversationEnabled" @update:model-value="draft.conversationEnabled = $event" />
          </div>
        </div>
        <div class="ds-trigger">
          <div class="ds-row">
            <div class="ds-row-text"><strong>群聊旁观</strong><span>群里连续聊了一阵、机器人没参与时，看最近几条消息判断一次。</span></div>
            <label v-if="draft.ambientEnabled" class="ds-inline-number"><input type="number" min="0" max="100" v-model.number="draft.ambientProbability" /><span>%</span></label>
            <Switch :model-value="draft.ambientEnabled" @update:model-value="draft.ambientEnabled = $event" />
          </div>
          <Collapse v-if="draft.ambientEnabled" title="旁观设置" :hint="draft.ambientWindowSeconds + ' 秒无新消息后判断 · 参考 ' + draft.ambientMaxMessages + ' 条'" nested>
            <div class="form-grid dense">
              <Field v-model="draft.ambientWindowSeconds" label="等待秒数" type="number" tip="最后一条消息之后安静多久再判断；期间有新消息会重新计时。" />
              <Field v-model="draft.ambientMaxMessages" label="参考消息条数" type="number" tip="只把最近几条消息的截断内容交给决策模型。" />
            </div>
          </Collapse>
        </div>
        <div class="ds-trigger">
          <div class="ds-row">
            <div class="ds-row-text"><strong>冷场冒泡</strong><span>指定的群安静一段时间后发一张，不调用任何模型。</span></div>
            <label v-if="draft.idleEnabled" class="ds-inline-number"><input type="number" min="0" max="100" v-model.number="draft.idleProbability" /><span>%</span></label>
            <Switch :model-value="draft.idleEnabled" @update:model-value="draft.idleEnabled = $event" />
          </div>
          <Collapse v-if="draft.idleEnabled" title="冒泡设置" :hint="'安静 ' + draft.idleMinIdleMinutes + ' 分钟后 · ' + draft.idleStart + '–' + draft.idleEnd" nested>
            <div class="form-grid dense">
              <Field v-model="draft.idleGroups" label="检查的群" type="textarea" :rows="2" placeholder="每行一个群号" tip="这些群也必须在白名单里。" />
              <Field v-model="draft.idleMinIdleMinutes" label="安静多久（分钟）" type="number" />
              <Field v-model="draft.idleIntervalMinutes" label="检查间隔（分钟）" type="number" />
              <Field v-model="draft.idleStart" label="开始时间" placeholder="09:00" />
              <Field v-model="draft.idleEnd" label="结束时间" placeholder="23:30" tip="支持跨午夜，例如 22:00 到 02:00。" />
            </div>
            <div class="ds-field-label">随机使用的情绪</div>
            <div class="ds-chips">
              <button v-for="name in moodNames" :key="name" type="button" class="ds-chip" :class="{ active: draft.idleMoods.includes(name) }" @click="toggleIdleMood(name)">{{ name }}</button>
            </div>
          </Collapse>
        </div>
      </Panel>

      <Panel title="判断方式">
        <p class="muted small">决策模型一次请求同时判断“现在适不适合发”和“用哪种情绪”，只传截断后的几句话。没有配置时，按情绪分组的关键词在本地匹配。</p>
        <template v-if="decisionModels.length">
          <div class="form-grid two">
            <Field v-model="draft.decisionModel" label="决策模型" type="select" :options="decisionOptions" />
            <div class="ds-key">
              <div class="ds-field-label">渠道密钥</div>
              <div v-if="!keyEditing" class="row">
                <StatusDot :state="decisionProvider?.apiKey ? 'on' : 'warn'" :label="decisionProvider ? (decisionProvider.name + (decisionProvider.apiKey ? ' · 已配置' : ' · 未配置')) : '未找到渠道'" />
                <button class="btn ghost small" type="button" @click="keyEditing = true">{{ decisionProvider?.apiKey ? '更换' : '填写' }}</button>
                <button v-if="draft.decisionModel" class="btn ghost small" type="button" @click="testDecisionModel">测试</button>
              </div>
              <div v-else class="row">
                <input class="grow" type="password" v-model="keyInput" placeholder="TypeSafe API Key" autocomplete="off" />
                <button class="btn small" type="button" :disabled="keyBusy || !keyInput.trim()" @click="connectDecisionModel">保存密钥</button>
                <button class="btn ghost small" type="button" @click="keyEditing = false; keyInput = ''">取消</button>
              </div>
              <span v-if="decisionTest" class="muted tiny">{{ decisionTest }}</span>
            </div>
          </div>
        </template>
        <div v-else class="ds-connect">
          <div class="ds-row-text"><strong>连接 TypeSafe 决策模型</strong><span>填写 API Key 后会在“渠道与模型”里创建 typesafe 渠道和 jev-latest 模型。</span></div>
          <div class="row">
            <input class="grow" type="password" v-model="keyInput" placeholder="TypeSafe API Key" autocomplete="off" />
            <button class="btn small" type="button" :disabled="keyBusy || (!keyInput.trim() && !decisionProvider)" @click="connectDecisionModel">{{ keyBusy ? '连接中' : '连接' }}</button>
          </div>
          <button class="btn ghost small ds-link" type="button" @click="openProviders">在渠道与模型中手动配置</button>
        </div>
        <Collapse title="判断阈值" :hint="'发送意愿 ≥ ' + percent(draft.sendThreshold) + ' · 情绪置信度 ≥ ' + percent(draft.moodConfidence)" nested>
          <div class="form-grid dense">
            <Field v-model="draft.sendThreshold" label="发送意愿下限" type="number" tip="0–1。决策模型认为“此刻适合发表情包”的概率低于它就不发。调高会更克制。" />
            <Field v-model="draft.moodConfidence" label="情绪置信度下限" type="number" tip="0–1。情绪判断分散在几种之间时置信度会变低，低于它就不发。" />
            <Field v-model="draft.decisionTimeoutSeconds" label="超时（秒）" type="number" tip="超时后改用本地关键词判断。" />
          </div>
        </Collapse>
      </Panel>

      <Panel title="情绪分组">
        <p class="muted small">每个分组是决策模型的一个选项；选中后按“检索标签”顺序在图库里精确查找，取最新的几张随机发一张。当前 {{ conversationMoodCount }} 个用于对话判断。</p>
        <Collapse title="编辑分组" :hint="draft.moods.length + ' 个'" nested>
          <div class="ds-table-wrap">
            <table class="ds-table">
              <thead><tr><th>名称</th><th>检索标签 <HelpTip tip="空格分隔，按顺序查询；靠前的标签图片不够时才查下一个。" /></th><th>说明 <HelpTip tip="交给决策模型区分各个选项，写清楚适用的场景。" /></th><th>本地关键词</th><th>时段</th><th>仅冒泡</th><th></th></tr></thead>
              <tbody>
                <tr v-for="(mood, index) in draft.moods" :key="index">
                  <td><input v-model="mood.name" placeholder="安慰" /></td>
                  <td><input v-model="mood.tags" placeholder="安慰 摸摸头" /></td>
                  <td><input v-model="mood.description" placeholder="对方难过、需要安抚" /></td>
                  <td><input v-model="mood.keywords" placeholder="难受 伤心" /></td>
                  <td><input v-model="mood.hours" placeholder="全天" class="ds-hours" /></td>
                  <td class="ds-center"><input type="checkbox" v-model="mood.idleOnly" /></td>
                  <td><button class="icon-btn danger" type="button" data-tip="删除" @click="removeMood(index)"><Icon name="trash" :size="14" /></button></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="row">
            <button class="btn outline small" type="button" @click="addMood"><Icon name="plus" :size="14" />添加分组</button>
            <button class="btn ghost small" type="button" @click="resetMoods">恢复默认</button>
          </div>
        </Collapse>
      </Panel>

      <Panel title="试运行">
        <div class="segmented ds-mode" role="group">
          <button v-for="mode in ['conversation', 'ambient', 'idle']" :key="mode" type="button" :class="{ active: test.mode === mode }" @click="test.mode = mode">{{ modeLabels[mode] }}</button>
        </div>
        <div v-if="test.mode !== 'idle'" class="form-grid two">
          <Field v-model="test.text" :label="test.mode === 'ambient' ? '群聊内容（每行一条）' : '对方说'" type="textarea" :rows="3" />
          <Field v-if="test.mode === 'conversation'" v-model="test.reply" label="机器人回复（可选）" type="textarea" :rows="3" />
        </div>
        <div class="row">
          <button class="btn small" type="button" :disabled="test.busy" @click="runTest"><Icon name="play" :size="14" />{{ test.busy ? '运行中' : '试运行' }}</button>
          <span class="muted tiny">使用当前未保存的设置，只判断和选图，不发送。</span>
        </div>
        <div v-if="testResult" class="ds-result">
          <div class="ds-result-body">
            <div class="ds-result-line">
              <strong>{{ testResult.ok ? '会发送' : '不发送' }}</strong>
              <span class="muted">{{ reasonLabel(testDecision.reason || testResult.reason) }}</span>
            </div>
            <dl class="ds-facts">
              <template v-if="testDecision.source"><dt>判断来源</dt><dd>{{ sourceLabels[testDecision.source] || testDecision.source }}<span v-if="testDecision.model" class="muted"> · {{ testDecision.model }}</span></dd></template>
              <template v-if="testDecision.sendScore !== null && testDecision.sendScore !== undefined"><dt>发送意愿</dt><dd>{{ percent(testDecision.sendScore) }}</dd></template>
              <template v-if="testResult.mood"><dt>情绪</dt><dd>{{ testResult.mood }}<span v-if="testDecision.confidence !== null && testDecision.confidence !== undefined" class="muted"> · 置信度 {{ percent(testDecision.confidence) }}</span></dd></template>
              <template v-if="testResult.tags"><dt>检索标签</dt><dd>{{ testResult.tags.join('、') }}</dd></template>
              <template v-if="testSelection.candidateCount !== undefined"><dt>候选图片</dt><dd>{{ testSelection.candidateCount }} 张</dd></template>
              <template v-if="testDecision.error"><dt>提示</dt><dd class="ds-error">{{ testDecision.error }}</dd></template>
            </dl>
            <div v-if="testProbabilities.length" class="ds-bars">
              <div v-for="item in testProbabilities" :key="item.name" class="ds-bar"><span>{{ item.name === 'none' ? '无' : item.name }}</span><i><b :style="{ width: Math.round(item.value * 100) + '%' }"></b></i><em>{{ percent(item.value) }}</em></div>
            </div>
          </div>
          <img v-if="testImage" :src="testImage" alt="选中的图片" />
        </div>
      </Panel>

      <Collapse title="频率限制" :hint="'冷却 ' + draft.cooldownMinutes + ' 分钟 · 每天最多 ' + (draft.dailyQuota || '不限') + ' 次'">
        <div class="form-grid dense">
          <Field v-model="draft.cooldownMinutes" label="发送后冷却（分钟）" type="number" tip="同一个群或私聊发送成功后，这段时间内不再发送。" />
          <Field v-model="draft.attemptIntervalSeconds" label="判断间隔（秒）" type="number" tip="即使没有发送，两次判断之间也至少间隔这么久，避免频繁调用决策模型。" />
          <Field v-model="draft.dailyQuota" label="每天最多" type="number" tip="按群或私聊统计成功发送次数；0 表示不限。" />
          <Field v-model="draft.recentWindowHours" label="不重复发送（小时）" type="number" tip="这段时间内发过的图片不会再选中。" />
        </div>
      </Collapse>

      <Collapse title="图库渠道" :hint="primaryChannel ? (primaryChannel.displayNameZh || primaryChannel.name) : draft.primaryTool">
        <div class="form-grid two">
          <Field v-model="draft.primaryTool" label="主渠道" type="select" :options="channelOptions" tip="来自统一工具列表中符合图片候选约定的只读工具。" />
          <Field v-model="draft.fallbackTool" label="备用渠道" type="select" :options="fallbackOptions" tip="主渠道出错或没有图片时才使用。" />
          <Field v-model="draft.candidateCount" label="每个标签取几张" type="number" tip="按最新排序，每个标签单次最多 50 张。" />
          <Field v-model="draft.topK" label="从最新几张里随机" type="number" tip="越大越不容易重复，越小越偏向最新的图片。" />
        </div>
        <p v-if="primaryChannel" class="muted tiny">{{ primaryChannel.reason }}</p>
        <Field v-model="draft.adapterConfigJson" label="渠道适配规则（JSON）" type="textarea" :rows="6" tip="映射字段名和固定参数；inputMapping 支持 keyword、tags、count、sort、match。通常不需要修改。" />
      </Collapse>

      <div class="ds-status">
        <StatusDot :state="scheduler.lastError ? 'bad' : draft.enabled ? 'on' : 'off'" :label="draft.enabled ? '运行中' : '未启用'" />
        <span>已判断 {{ scheduler.attempts || 0 }} 次 · 已发送 {{ scheduler.sent || 0 }} 张</span>
        <span v-if="lastOutcome.at">最近 {{ time(lastOutcome.at) }} {{ modeLabels[lastOutcome.mode] || '' }}：{{ lastOutcome.sent ? '已发送' : reasonLabel(lastOutcome.reason) }}<template v-if="lastOutcome.mood">（{{ lastOutcome.mood }}）</template></span>
        <span v-if="scheduler.lastError" class="ds-error">{{ scheduler.lastError }}</span>
        <span class="grow"></span>
        <button class="btn ghost small" type="button" @click="runIdleCheck">检查冒泡</button>
        <button class="btn ghost small" type="button" @click="refresh"><Icon name="refresh" :size="13" />刷新</button>
      </div>
    </div>
  `,
}
