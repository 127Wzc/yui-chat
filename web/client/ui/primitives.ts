import { defineComponent } from "vue"

// shadcn 风格的基础表单与展示组件。样式见 styles/primitives.css，类名统一 ui- 前缀；
// 新页面优先使用这些组件，旧页面后续逐步迁移。

let radioSequence = 0

interface ChoiceOption {
  value: string | number | boolean
  label: string
  description?: string
  icon?: string
  disabled?: boolean
}

function normalizeOptions(options: unknown[]): ChoiceOption[] {
  return options.map(option => typeof option === "object" && option !== null
    ? option as ChoiceOption
    : { value: option as string, label: String(option) })
}

// 复选框：v-model 为布尔值；可带标题和说明。
export const Checkbox = defineComponent({
  name: "Checkbox",
  props: { modelValue: Boolean, label: String, description: String, disabled: Boolean },
  emits: ["update:modelValue"],
  template: `
    <label class="ui-check" :class="{ 'is-disabled': disabled }">
      <input type="checkbox" class="ui-check-box" :checked="modelValue" :disabled="disabled" @change="$emit('update:modelValue', $event.target.checked)" />
      <span v-if="label || description || $slots.default" class="ui-check-text">
        <span v-if="label" class="ui-check-label">{{ label }}</span>
        <span v-if="description" class="ui-check-desc">{{ description }}</span>
        <slot />
      </span>
    </label>
  `,
})

// 单选组：segmented 为紧凑分段按钮；cards 为带说明的选项卡片。
export const RadioGroup = defineComponent({
  name: "RadioGroup",
  props: {
    modelValue: { type: [String, Number, Boolean], default: "" },
    options: { type: Array, default: () => [] },
    variant: { type: String, default: "segmented" },
    disabled: Boolean,
    label: String,
  },
  emits: ["update:modelValue"],
  data() {
    radioSequence += 1
    return { groupName: `yui-radio-${radioSequence}` }
  },
  computed: {
    normOptions(): ChoiceOption[] {
      return normalizeOptions(this.options as unknown[])
    },
  },
  methods: {
    active(option: ChoiceOption): boolean {
      return String(option.value) === String(this.modelValue)
    },
  },
  template: `
    <div class="ui-radio-group" :class="'is-' + variant" role="radiogroup" :aria-label="label">
      <label v-for="o in normOptions" :key="String(o.value)" class="ui-radio" :class="{ 'is-active': active(o), 'is-disabled': disabled || o.disabled }">
        <input type="radio" class="ui-radio-input" :name="groupName" :value="o.value" :checked="active(o)" :disabled="disabled || o.disabled" @change="$emit('update:modelValue', o.value)" />
        <Icon v-if="o.icon" :name="o.icon" :size="variant === 'cards' ? 16 : 14" class="ui-radio-icon" />
        <span class="ui-radio-text">
          <span class="ui-radio-label">{{ o.label }}</span>
          <span v-if="o.description && variant === 'cards'" class="ui-radio-desc">{{ o.description }}</span>
        </span>
      </label>
    </div>
  `,
})

// 带图标和清空按钮的搜索框。
export const SearchInput = defineComponent({
  name: "SearchInput",
  props: { modelValue: { type: String, default: "" }, placeholder: { type: String, default: "搜索" } },
  emits: ["update:modelValue"],
  template: `
    <label class="ui-search">
      <Icon name="search" :size="14" />
      <input type="search" :value="modelValue" :placeholder="placeholder" :aria-label="placeholder" autocomplete="off" @input="$emit('update:modelValue', $event.target.value)" />
      <button v-if="modelValue" type="button" class="ui-search-clear" aria-label="清空搜索" @click="$emit('update:modelValue', '')"><Icon name="x" :size="12" /></button>
    </label>
  `,
})

// 徽标：default / secondary / outline / success / warning / destructive。
export const Badge = defineComponent({
  name: "Badge",
  props: { variant: { type: String, default: "secondary" }, icon: String },
  template: `<span class="ui-badge" :class="'is-' + variant"><Icon v-if="icon" :name="icon" :size="11" /><slot /></span>`,
})

const DIALOG_WIDTHS: Record<string, string> = { sm: "420px", md: "560px", lg: "760px", xl: "960px" }

// 居中对话框：复用 SideDrawer 的焦点管理与层级栈，footer 插槽固定在底部。
export const Dialog = defineComponent({
  name: "Dialog",
  props: { open: Boolean, title: String, description: String, size: { type: String, default: "md" } },
  emits: ["close"],
  computed: {
    width(): string {
      return DIALOG_WIDTHS[String(this.size)] || DIALOG_WIDTHS.md
    },
  },
  template: `
    <SideDrawer :open="open" :title="title" :subtitle="description" variant="dialog" :width="width" @close="$emit('close')">
      <slot />
      <template v-if="$slots.footer" #actions><slot name="footer" /></template>
    </SideDrawer>
  `,
})

export const primitives = { Checkbox, RadioGroup, SearchInput, Badge, Dialog }
