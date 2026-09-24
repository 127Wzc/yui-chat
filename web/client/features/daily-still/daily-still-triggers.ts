import { computed } from "vue"
import { DailyStillMoodSelect } from "./daily-still-mood-select.js"
import type { DailyStillDraft } from "./daily-still-draft.js"

// 三个触发入口各自一张卡片：开关、概率、选图方式和入口专属参数。
export const DailyStillTriggers = {
  name: "DailyStillTriggers",
  components: { DailyStillMoodSelect },
  props: {
    draft: { type: Object, required: true },
    moodNames: { type: Array, default: () => [] },
    // 是否已选择决策模型；未选择时“精选”不可用，“按情绪”退回关键词匹配。
    decisionReady: Boolean,
  },
  setup(props: { draft: DailyStillDraft; decisionReady: boolean }) {
    const chatPickOptions = computed(() => [
      { value: "mood", label: "按情绪", description: props.decisionReady ? "判断情绪，再从对应分组取图" : "按分组关键词匹配情绪（未配置决策模型）" },
      { value: "image", label: "精选", description: "决策模型在语义相近的图里挑一张", disabled: !props.decisionReady },
      { value: "latest", label: "最新上传", description: "不判断，发最近上传的一张" },
    ])
    const idlePickOptions = [
      { value: "latest", label: "最新上传", description: "发最近上传且没发过的一张" },
      { value: "mood", label: "字典随机", description: "从选定分组里随机一组标签取图" },
    ]
    return { chatPickOptions, idlePickOptions }
  },
  template: `
    <div class="ds-triggers">
      <section class="ds-trigger-card" :class="{ 'is-off': !draft.conversationEnabled }">
        <header>
          <span class="ds-trigger-icon"><Icon name="message" :size="15" /></span>
          <div class="ds-trigger-title"><strong>对话后</strong><span>回复完顺手补一张</span></div>
          <Switch :model-value="draft.conversationEnabled" @update:model-value="draft.conversationEnabled = $event" />
        </header>
        <div class="ds-trigger-body">
          <label class="ds-prob">触发概率<input type="number" min="0" max="100" v-model.number="draft.conversationProbability" /><span>%</span></label>
          <RadioGroup v-model="draft.conversationPick" :options="chatPickOptions" variant="list" label="对话后选图方式" />
          <div v-if="draft.conversationPick === 'mood'" class="ds-trigger-field"><span>候选分组</span><DailyStillMoodSelect v-model="draft.conversationMoods" :options="moodNames" title="对话后可用的情绪分组" /></div>
        </div>
      </section>

      <section class="ds-trigger-card" :class="{ 'is-off': !draft.ambientEnabled }">
        <header>
          <span class="ds-trigger-icon"><Icon name="eye" :size="15" /></span>
          <div class="ds-trigger-title"><strong>群聊旁观</strong><span>群友聊了一阵后插一张</span></div>
          <Switch :model-value="draft.ambientEnabled" @update:model-value="draft.ambientEnabled = $event" />
        </header>
        <div class="ds-trigger-body">
          <label class="ds-prob">触发概率<input type="number" min="0" max="100" v-model.number="draft.ambientProbability" /><span>%</span></label>
          <RadioGroup v-model="draft.ambientPick" :options="chatPickOptions" variant="list" label="旁观选图方式" />
          <div v-if="draft.ambientPick === 'mood'" class="ds-trigger-field"><span>候选分组</span><DailyStillMoodSelect v-model="draft.ambientMoods" :options="moodNames" title="旁观可用的情绪分组" /></div>
          <div class="form-grid two ds-trigger-params">
            <Field v-model="draft.ambientWindowSeconds" label="安静几秒后判断" type="number" tip="期间有新消息会重新计时。" />
            <Field v-model="draft.ambientMaxMessages" label="参考几条消息" type="number" />
          </div>
        </div>
      </section>

      <section class="ds-trigger-card" :class="{ 'is-off': !draft.idleEnabled }">
        <header>
          <span class="ds-trigger-icon"><Icon name="clock" :size="15" /></span>
          <div class="ds-trigger-title"><strong>冷场冒泡</strong><span>群里安静太久时发一张，不调用模型</span></div>
          <Switch :model-value="draft.idleEnabled" @update:model-value="draft.idleEnabled = $event" />
        </header>
        <div class="ds-trigger-body">
          <label class="ds-prob">触发概率<input type="number" min="0" max="100" v-model.number="draft.idleProbability" /><span>%</span></label>
          <RadioGroup v-model="draft.idlePick" :options="idlePickOptions" variant="list" label="冒泡选图方式" />
          <div v-if="draft.idlePick === 'mood'" class="ds-trigger-field"><span>随机分组</span><DailyStillMoodSelect v-model="draft.idleMoods" :options="moodNames" title="冒泡时随机的情绪分组" empty-label="仅冒泡分组" /></div>
          <div class="form-grid two ds-trigger-params">
            <Field v-model="draft.idleGroups" label="检查的群" type="textarea" :rows="2" placeholder="每行一个群号" tip="也必须在白名单里。" />
            <Field v-model="draft.idleMinIdleMinutes" label="安静多久（分钟）" type="number" />
            <Field v-model="draft.idleIntervalMinutes" label="检查间隔（分钟）" type="number" />
            <div class="field">
              <span class="field-label">时段<HelpTip tip="支持跨午夜，例如 22:00 到 02:00。" /></span>
              <div class="ds-time-range"><input v-model="draft.idleStart" placeholder="09:00" /><span>–</span><input v-model="draft.idleEnd" placeholder="23:30" /></div>
            </div>
          </div>
        </div>
      </section>
    </div>
  `,
}
