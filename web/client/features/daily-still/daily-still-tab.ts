import { computed, reactive, ref, watch } from "vue"
import { request, saveConfigPatch, setDirtyScope, setTab, store, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { DEFAULT_TOOL, buildConfig, initDraft, list, moodDraft, objectJson, parseObjectJson, text } from "./daily-still-draft.js"
import { DailyStillMoodsPanel } from "./daily-still-moods-panel.js"
import { DailyStillTriggers } from "./daily-still-triggers.js"

const REASON_LABELS: Record<string, string> = {
  "model-selected": "适合发送",
  "model-picked": "已选中图片",
  "not-a-moment": "此刻不适合",
  "no-mood": "没有匹配的情绪",
  "mood-uncertain": "情绪不明确",
  "no-image-fit": "没有合适的图",
  "image-uncertain": "选图不确定",
  "decision-error": "决策请求失败",
  "keywords-matched": "关键词命中",
  "keywords-no-match": "没有命中关键词",
  "no-moods": "没有可用分组",
  "no-idle-mood": "当前时段没有冒泡分组",
  "no-candidate": "图库没有候选",
  "canceled-after-decision": "期间有新消息",
  cooldown: "冷却中",
  "attempt-interval": "判断太频繁",
  "daily-quota": "今日次数已满",
  probability: "未命中概率",
  sent: "已发送",
}

const PICK_LABELS: Record<string, string> = { mood: "情绪", image: "精选", latest: "最新" }
const TEST_MODE_OPTIONS = [
  { value: "conversation", label: "对话" },
  { value: "ambient", label: "旁观" },
  { value: "idle", label: "冒泡" },
]
const MODE_LABELS: Record<string, string> = { conversation: "对话", ambient: "旁观", idle: "冒泡" }

export const DailyStillTab = {
  name: "DailyStillTab",
  components: { DailyStillMoodsPanel, DailyStillTriggers },
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
    watch(() => draft.primaryTool, (next, previous) => {
      const previousConfig = parseObjectJson(draft.adapterConfigJson)
      if (previous && previousConfig) draft.adapterConfigs[previous] = previousConfig
      draft.adapterConfigJson = objectJson(draft.adapterConfigs[next])
    })

    // 决策模型只引用“渠道与模型”里用途为决策的模型，密钥在那里维护。
    const decisionModels = computed(() => asRecords(asRecord(store.config).models).filter(item => text(item.purpose) === "decision"))
    const decisionOptions = computed(() => [
      { value: "", label: "不使用（本地关键词）" },
      ...decisionModels.value.map(item => ({ value: text(item.name), label: text(item.name) })),
    ])
    // 已有决策模型却没启用时给一个一键启用入口，不自动改草稿。
    const suggestedModel = computed(() => !draft.decisionModel && decisionModels.value.length === 1 ? text(decisionModels.value[0].name) : "")
    const decisionTest = ref("")
    async function testDecisionModel() {
      decisionTest.value = "测试中…"
      try {
        const result = asRecord(asRecord(await request("/api/channels/test", { method: "POST", body: JSON.stringify({ channelId: draft.decisionModel }) })).result)
        decisionTest.value = text(result.text || "测试通过")
      } catch (error) {
        decisionTest.value = errorMessage(error)
      }
    }
    // 只有用到决策的入口才需要这张卡片的阈值与模型。
    const usesDecision = computed(() => (draft.conversationEnabled && draft.conversationPick !== "latest") || (draft.ambientEnabled && draft.ambientPick !== "latest"))
    const usesImagePick = computed(() => draft.conversationPick === "image" || draft.ambientPick === "image")
    const moodNames = computed(() => draft.moods.map(item => item.name.trim()).filter(Boolean))

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

    const test = reactive({ mode: "conversation", text: "今天又加班到十点，好累啊", reply: "辛苦啦，早点休息", busy: false })
    const testResult = ref<UnknownRecord | null>(null)
    const testDecision = computed(() => asRecord(testResult.value?.decision))
    const testSelection = computed(() => asRecord(testResult.value?.selection))
    const testImage = computed(() => text(asRecord(testSelection.value.selected).url))
    const testProbabilities = computed(() => Object.entries(asRecord(testDecision.value.probabilities))
      .map(([name, value]) => ({ name, value: Number(value) || 0 }))
      .sort((left, right) => right.value - left.value)
      .slice(0, 5))
    // 试运行结果里的附加说明：情绪改选、精选退回等。
    const testNotes = computed(() => {
      const result = testResult.value || {}
      return [
        testDecision.value.repeatAvoided ? `最近发过“${text(testDecision.value.repeatAvoided)}”，改用次选` : "",
        result.pickFallback ? `语义召回不足（${text(result.pickFallback).replace(/^semantic-pool-/, "") || 0} 张），已按情绪选图` : "",
        text(testDecision.value.error),
      ].filter(Boolean)
    })
    async function runTest() {
      test.busy = true
      try {
        const response = asRecord(await request("/api/daily-still/test", {
          method: "POST",
          body: JSON.stringify({ mode: test.mode, text: test.text, reply: test.mode === "conversation" ? test.reply : "", draft: buildConfig(draft, defaultMoods.value) }),
        }))
        testResult.value = asRecord(response.result)
      } catch (error) {
        testResult.value = { ok: false, reason: errorMessage(error) }
      } finally {
        test.busy = false
      }
    }
    function refresh() { void request("/api/daily-still").then(value => { store.dailyStill = value }).catch(error => toast(errorMessage(error))) }

    const reasonLabel = (value: unknown) => REASON_LABELS[text(value)] || text(value)
    function percent(value: unknown): string {
      const n = Number(value)
      return value === null || value === undefined || !Number.isFinite(n) ? "-" : `${Math.round(n * 100)}%`
    }
    function time(value: unknown): string {
      const date = new Date(text(value))
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    }

    return {
      draft, busy, isDirty, save, refresh, scheduler, lastOutcome, defaultMoods, moodNames,
      channelOptions, fallbackOptions, decisionModels, decisionOptions, suggestedModel, decisionTest, testDecisionModel, usesDecision, usesImagePick,
      test, testResult, testDecision, testSelection, testImage, testProbabilities, testNotes, runTest,
      reasonLabel, percent, time, PICK_LABELS, TEST_MODE_OPTIONS, MODE_LABELS, openProviders: () => setTab("providers"),
    }
  },
  template: `
    <div class="ds-page">
      <header class="ds-header">
        <div class="ds-header-title">
          <h2>日常定格</h2>
          <Switch :model-value="draft.enabled" tip="总开关" @update:model-value="draft.enabled = $event" />
        </div>
        <div class="ds-header-actions">
          <span v-if="isDirty" class="muted tiny">未保存</span>
          <button class="btn primary small" type="button" :disabled="busy || !isDirty" @click="save"><Icon name="save" :size="14" />{{ busy ? '保存中' : '保存' }}</button>
        </div>
      </header>

      <DailyStillTriggers :draft="draft" :mood-names="moodNames" :decision-ready="!!draft.decisionModel" />

      <section class="ds-card" :class="{ 'is-muted': !usesDecision }">
        <h3>决策<HelpTip tip="按情绪和精选选图时使用：一次请求同时判断是否发送和发哪种情绪。只用最新上传的入口不会调用。" /></h3>
        <div class="ds-decision">
          <div class="field">
            <span class="field-label">决策模型</span>
            <div class="ds-inline">
              <select v-model="draft.decisionModel"><option v-for="o in decisionOptions" :key="o.value" :value="o.value">{{ o.label }}</option></select>
              <button v-if="suggestedModel" class="btn outline small" type="button" @click="draft.decisionModel = suggestedModel">启用 {{ suggestedModel }}</button>
              <button v-else-if="draft.decisionModel" class="btn ghost small" type="button" @click="testDecisionModel">测试</button>
              <button v-else-if="!decisionModels.length" class="btn ghost small" type="button" @click="openProviders">去添加</button>
            </div>
            <span v-if="decisionTest" class="field-description">{{ decisionTest }}</span>
          </div>
          <Field v-model="draft.sendThreshold" label="发送意愿下限" type="number" tip="0–1，调高更克制。" />
          <Field v-model="draft.moodConfidence" label="置信度下限" type="number" tip="0–1，情绪或选图分散时置信度会变低。" />
          <Field v-model="draft.moodRepeatMinutes" label="同一情绪间隔（分钟）" type="number" tip="窗口内再次选中同一情绪时改用次选；0 不限制。" />
          <Field v-if="usesImagePick" v-model="draft.imagePoolSize" label="精选候选数" type="number" tip="语义召回少于 3 张时按情绪选图。" />
          <Field v-model="draft.decisionTimeoutSeconds" label="超时（秒）" type="number" tip="超时后改用关键词判断。" />
        </div>
      </section>

      <DailyStillMoodsPanel :draft="draft" :default-moods="defaultMoods" />

      <section class="ds-card">
        <div class="ds-card-head">
          <h3>试运行</h3>
          <RadioGroup v-model="test.mode" :options="TEST_MODE_OPTIONS" label="试运行入口" />
        </div>
        <div v-if="test.mode !== 'idle'" class="form-grid two">
          <Field v-model="test.text" :label="test.mode === 'ambient' ? '群聊（每行一条）' : '对方说'" type="textarea" :rows="3" />
          <Field v-if="test.mode === 'conversation'" v-model="test.reply" label="机器人回复" type="textarea" :rows="3" />
        </div>
        <div class="row">
          <button class="btn small" type="button" :disabled="test.busy" @click="runTest"><Icon name="play" :size="13" />{{ test.busy ? '运行中' : '运行' }}</button>
          <span class="muted tiny">用未保存的设置，不发送</span>
        </div>
        <div v-if="testResult" class="ds-result">
          <div class="ds-result-body">
            <div class="ds-result-line">
              <Badge :variant="testResult.ok ? 'success' : 'secondary'">{{ testResult.ok ? '会发送' : '不发送' }}</Badge>
              <span class="muted">{{ reasonLabel(testDecision.reason || testResult.reason) }}</span>
            </div>
            <dl class="ds-facts">
              <template v-if="testResult.pickMode"><dt>方式</dt><dd>{{ PICK_LABELS[testResult.pickMode] || testResult.pickMode }}<span v-if="testDecision.model" class="muted"> · {{ testDecision.model }}</span><span v-else-if="testDecision.source === 'keywords'" class="muted"> · 关键词</span></dd></template>
              <template v-if="testDecision.sendScore !== null && testDecision.sendScore !== undefined"><dt>发送意愿</dt><dd>{{ percent(testDecision.sendScore) }}</dd></template>
              <template v-if="testResult.mood"><dt>情绪</dt><dd>{{ testResult.mood }}<span v-if="testDecision.confidence !== null && testDecision.confidence !== undefined" class="muted"> · {{ percent(testDecision.confidence) }}</span></dd></template>
              <template v-if="testResult.tags"><dt>标签</dt><dd>{{ testResult.tags.join('、') }}</dd></template>
              <template v-if="testSelection.candidateCount !== undefined"><dt>候选</dt><dd>{{ testSelection.candidateCount }} 张</dd></template>
            </dl>
            <ul v-if="testNotes.length" class="ds-notes"><li v-for="note in testNotes" :key="note">{{ note }}</li></ul>
            <div v-if="testProbabilities.length" class="ds-bars">
              <div v-for="item in testProbabilities" :key="item.name" class="ds-bar"><span class="truncate">{{ item.name === 'none' ? '无' : item.name }}</span><i><b :style="{ width: Math.round(item.value * 100) + '%' }"></b></i><em>{{ percent(item.value) }}</em></div>
            </div>
          </div>
          <img v-if="testImage" :src="testImage" alt="选中的图片" />
        </div>
      </section>

      <div class="ds-extras">
        <Collapse title="范围" :hint="(draft.allowlist ? draft.allowlist.split('\\n').filter(Boolean).length : 0) + ' 个群' + (draft.privateEnabled ? ' · 含私聊' : '')">
          <div class="form-grid two">
            <Field v-model="draft.allowlist" label="白名单" type="textarea" :rows="2" placeholder="每行一个群号" tip="留空表示所有群都不触发。" />
            <Field v-model="draft.blocklist" label="黑名单" type="textarea" :rows="2" placeholder="每行一个群号" tip="优先于白名单。" />
          </div>
          <Field v-model="draft.privateEnabled" type="switch" label="允许私聊" />
        </Collapse>
        <Collapse title="频率" :hint="'冷却 ' + draft.cooldownMinutes + ' 分钟 · 每天 ' + (draft.dailyQuota || '不限') + ' 次'">
          <div class="form-grid dense">
            <Field v-model="draft.cooldownMinutes" label="发送后冷却（分钟）" type="number" />
            <Field v-model="draft.attemptIntervalSeconds" label="判断间隔（秒）" type="number" tip="没发送也要间隔，避免频繁调用决策模型。" />
            <Field v-model="draft.dailyQuota" label="每天最多" type="number" tip="0 不限。" />
            <Field v-model="draft.recentWindowHours" label="图片不重复（小时）" type="number" />
          </div>
        </Collapse>
        <Collapse title="图库渠道" :hint="draft.primaryTool">
          <div class="form-grid two">
            <Field v-model="draft.primaryTool" label="主渠道" type="select" :options="channelOptions" />
            <Field v-model="draft.fallbackTool" label="备用渠道" type="select" :options="fallbackOptions" tip="主渠道出错或没有图时使用。" />
            <Field v-model="draft.candidateCount" label="每个标签取几张" type="number" tip="最多 50。" />
            <Field v-model="draft.topK" label="从最新几张随机" type="number" />
          </div>
          <Field v-model="draft.adapterConfigJson" label="适配规则（JSON）" type="textarea" :rows="5" tip="inputMapping 支持 keyword、tags、count、sort、match、page。通常不用改。" />
        </Collapse>
      </div>

      <footer class="ds-status">
        <StatusDot :state="scheduler.lastError ? 'bad' : draft.enabled ? 'on' : 'off'" :label="draft.enabled ? '运行中' : '未启用'" />
        <span>判断 {{ scheduler.attempts || 0 }} 次 · 发送 {{ scheduler.sent || 0 }} 张</span>
        <span v-if="lastOutcome.at">{{ time(lastOutcome.at) }} {{ MODE_LABELS[lastOutcome.mode] || '' }}：{{ lastOutcome.sent ? '已发送' : reasonLabel(lastOutcome.reason) }}<template v-if="lastOutcome.mood">（{{ lastOutcome.mood }}）</template></span>
        <span v-if="scheduler.lastError" class="ds-error truncate" :data-tip="scheduler.lastError">{{ scheduler.lastError }}</span>
        <span class="grow"></span>
        <IconButton icon="refresh" tip="刷新状态" tip-dir="tip-left" @click="refresh" />
      </footer>
    </div>
  `,
}
