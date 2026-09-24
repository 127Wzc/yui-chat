import { computed, ref } from "vue"

// 情绪分组多选：平时只显示一行摘要，点击后在对话框里勾选。
// 值为空时显示 emptyLabel，由调用方决定空值的含义（全部分组或默认分组）。
export const DailyStillMoodSelect = {
  name: "DailyStillMoodSelect",
  props: {
    modelValue: { type: Array, default: () => [] },
    options: { type: Array, default: () => [] },
    title: { type: String, default: "选择分组" },
    emptyLabel: { type: String, default: "全部分组" },
  },
  emits: ["update:modelValue"],
  setup(props: { modelValue: string[]; options: string[] }, { emit }: { emit: (event: "update:modelValue", value: string[]) => void }) {
    const open = ref(false)
    const draft = ref<string[]>([])
    // 字典里已删除的分组不再计入摘要。
    const selected = computed(() => props.modelValue.filter(name => props.options.includes(name)))
    const summary = computed(() => selected.value.length > 3
      ? `${selected.value.slice(0, 3).join("、")} 等 ${selected.value.length} 组`
      : selected.value.join("、"))

    function start() {
      draft.value = [...selected.value]
      open.value = true
    }
    function toggle(name: string) {
      draft.value = draft.value.includes(name) ? draft.value.filter(item => item !== name) : [...draft.value, name]
    }
    function confirm() {
      // 按字典顺序保存，方便对比配置差异。
      emit("update:modelValue", props.options.filter(name => draft.value.includes(name)))
      open.value = false
    }
    return { open, draft, selected, summary, start, toggle, confirm }
  },
  template: `
    <div class="ds-mood-select">
      <span class="ds-mood-select-value" :class="{ 'is-empty': !selected.length }">{{ selected.length ? summary : emptyLabel }}</span>
      <button class="btn ghost small" type="button" @click="start">选择</button>
      <Dialog :open="open" size="md" :title="title" @close="open = false">
        <div class="ds-chips">
          <button v-for="name in options" :key="name" type="button" class="ds-chip" :class="{ active: draft.includes(name) }" @click="toggle(name)">{{ name }}</button>
        </div>
        <template #footer>
          <button class="btn ghost small ds-mood-select-clear" type="button" :disabled="!draft.length" @click="draft = []">清空（{{ emptyLabel }}）</button>
          <button class="btn outline small" type="button" @click="open = false">取消</button>
          <button class="btn small" type="button" @click="confirm">确定{{ draft.length ? '（' + draft.length + '）' : '' }}</button>
        </template>
      </Dialog>
    </div>
  `,
}
