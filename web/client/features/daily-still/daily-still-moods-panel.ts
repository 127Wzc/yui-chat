import { computed, ref } from "vue"
import { request, store, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { DEFAULT_IDLE_MOODS, list, moodDraft, moodValue, type DailyStillDraft } from "./daily-still-draft.js"

interface TermStat { term: string; count: number; coveredBy: string[] }
interface MoodStat { name: string; images: number; tags: Array<{ tag: string; count: number }> }

// 少于这么多张图的分组在字典里标黄，提示补标签。
const THIN_IMAGES = 20

// 情绪字典：紧凑的分组墙，点击分组在对话框里编辑；图库扫描结果直接标在分组上。
export const DailyStillMoodsPanel = {
  name: "DailyStillMoodsPanel",
  props: {
    draft: { type: Object, required: true },
    defaultMoods: { type: Array, default: () => [] },
  },
  setup(props: { draft: DailyStillDraft; defaultMoods: unknown[] }) {
    const editing = ref(-1)
    const scanning = ref(false)
    const localStats = ref<UnknownRecord | null>(null)
    const stats = computed(() => localStats.value || asRecord(asRecord(asRecord(store.dailyStill).status).scheduler).galleryStats as UnknownRecord | null)
    const moodStats = computed(() => new Map((asRecords(stats.value?.moods) as unknown as MoodStat[]).map(item => [item.name, item])))
    const uncovered = computed(() => (asRecords(stats.value?.terms) as unknown as TermStat[]).filter(item => !item.coveredBy.length).slice(0, 20))
    const current = computed(() => props.draft.moods[editing.value] || null)
    const currentTags = computed(() => {
      const mood = current.value
      if (!mood) return []
      const counts = new Map((moodStats.value.get(mood.name.trim())?.tags || []).map(item => [item.tag, item.count]))
      return list(mood.tags).map(tag => ({ tag, count: counts.has(tag) ? counts.get(tag) : null }))
    })

    function imagesOf(name: string): number | null {
      const stat = moodStats.value.get(name.trim())
      return stat ? stat.images : null
    }
    function open(index: number) { editing.value = index }
    function close() {
      // 新建后什么都没填就关闭时，直接丢弃这一行。
      const mood = current.value
      if (mood && !mood.name.trim() && !list(mood.tags).length) props.draft.moods.splice(editing.value, 1)
      editing.value = -1
    }
    function add(name = "") {
      props.draft.moods.push({ name, tags: name, description: "", keywords: "", hours: "", idleOnly: false })
      editing.value = props.draft.moods.length - 1
    }
    function remove() {
      props.draft.moods.splice(editing.value, 1)
      editing.value = -1
    }
    function reset() {
      props.draft.moods = props.defaultMoods.map(moodDraft)
      props.draft.idleMoods = [...DEFAULT_IDLE_MOODS]
    }
    async function scan() {
      scanning.value = true
      try {
        const moods = props.draft.moods.map(moodValue).filter(item => item.name)
        const response = asRecord(await request("/api/daily-still/gallery-stats", { method: "POST", body: JSON.stringify({ moods }) }))
        const result = asRecord(response.result)
        if (result.ok !== true) throw new Error(String(result.reason || "图库扫描失败"))
        localStats.value = asRecord(result.stats)
      } catch (error) {
        toast(errorMessage(error))
      } finally {
        scanning.value = false
      }
    }
    return { THIN_IMAGES, editing, scanning, stats, uncovered, current, currentTags, imagesOf, open, close, add, remove, reset, scan }
  },
  template: `
    <section class="ds-card">
      <div class="ds-card-head">
        <h3>情绪字典 <span class="muted">{{ draft.moods.length }}</span><HelpTip tip="每个分组是决策模型的一个选项；选中后按检索标签在图库里取图。数字是该分组能命中的图片数，需要先扫描图库。" /></h3>
        <div class="row">
          <button class="btn ghost small" type="button" :disabled="scanning" @click="scan"><Icon name="chart" :size="13" :class="{ 'icon-spin': scanning }" />{{ scanning ? '扫描中' : '扫描图库' }}</button>
          <button class="btn ghost small" type="button" @click="reset">恢复默认</button>
          <button class="btn outline small" type="button" @click="add()"><Icon name="plus" :size="13" />添加</button>
        </div>
      </div>

      <div class="ds-dict">
        <button
          v-for="(mood, index) in draft.moods"
          :key="index"
          type="button"
          class="ds-dict-item"
          :class="{ 'is-thin': imagesOf(mood.name) !== null && imagesOf(mood.name) < THIN_IMAGES }"
          :title="mood.description || mood.tags"
          @click="open(index)"
        >
          <span class="ds-dict-name">{{ mood.name || '未命名' }}</span>
          <span v-if="mood.idleOnly" class="ds-dict-flag">冒泡</span>
          <span v-else-if="mood.hours" class="ds-dict-flag">{{ mood.hours }}</span>
          <span class="ds-dict-count">{{ imagesOf(mood.name) ?? mood.tags.split(/\\s+/).filter(Boolean).length + ' 标签' }}</span>
        </button>
      </div>

      <div v-if="uncovered.length" class="ds-dict-terms">
        <span class="muted tiny">未分组的高频心情词</span>
        <button v-for="item in uncovered" :key="item.term" type="button" class="ds-term" :title="'出现 ' + item.count + ' 次，点击新建分组'" @click="add(item.term)">{{ item.term }}<small>{{ item.count }}</small></button>
      </div>
      <p v-if="stats" class="muted tiny">已扫描 {{ stats.scanned }} 张图</p>

      <Dialog :open="!!current" size="md" :title="current?.name ? '编辑分组 · ' + current.name : '新建分组'" @close="close">
        <div v-if="current" class="ds-mood-form">
          <div class="form-grid two">
            <Field v-model="current.name" label="名称" placeholder="安慰" />
            <Field v-model="current.hours" label="时段" placeholder="全天，例如 21:00-03:00" />
          </div>
          <Field v-model="current.tags" label="检索标签" placeholder="安慰 摸摸头 抱抱" tip="空格分隔，按顺序查询；标签图片不够时再按分组名模糊检索补齐。" />
          <div v-if="currentTags.length" class="ds-tag-counts">
            <span v-for="item in currentTags" :key="item.tag" :class="{ 'is-empty': item.count === 0 }">{{ item.tag }}<small v-if="item.count !== null">{{ item.count }}</small></span>
          </div>
          <Field v-model="current.description" label="说明" placeholder="对方难过、需要被安抚" tip="决策模型据此区分各个分组，写清适用场景。" />
          <Field v-model="current.keywords" label="关键词" placeholder="难受 心疼" tip="没有决策模型时用于本地匹配。" />
          <Field v-model="current.idleOnly" type="switch" label="仅用于冒泡" description="不参与对话和旁观的情绪判断" />
        </div>
        <template #footer>
          <button class="btn ghost small ds-danger" type="button" @click="remove"><Icon name="trash" :size="13" />删除</button>
          <button class="btn small" type="button" @click="close">完成</button>
        </template>
      </Dialog>
    </section>
  `,
}
