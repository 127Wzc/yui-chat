/** 筛选状态由页面持有；共用控件不参与业务匹配或保存。 */
export const CapabilityFilterBar = {
  name: "CapabilityFilterBar",
  props: {
    category: { type: String, default: "all" },
    categoryOptions: { type: Array, default: () => [] },
    categoryLabel: { type: String, default: "能力分类" },
    query: { type: String, default: "" },
    status: { type: String, default: "all" },
    placeholder: { type: String, default: "搜索名称、ID 或说明" },
    statusOptions: { type: Array, default: () => [["all", "全部"], ["enabled", "已启用"], ["disabled", "未启用"]] },
    count: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  emits: ["update:category", "update:query", "update:status", "reset"],
  template: `
    <div class="list-filter capability-filter-bar">
      <label v-if="categoryOptions.length" class="capability-category-select">
        <Icon name="list" :size="14" />
        <select :value="category" :aria-label="categoryLabel" @change="$emit('update:category', $event.target.value)">
          <option v-for="[value, label] in categoryOptions" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <slot name="leading" />
      <div class="filter-search"><Icon name="search" :size="14" /><input :value="query" :placeholder="placeholder" :aria-label="placeholder" @input="$emit('update:query', $event.target.value)" /></div>
      <slot name="extra" />
      <div class="segmented" role="group" aria-label="能力状态筛选">
        <button v-for="[value, label] in statusOptions" :key="value" type="button" :class="{ active: status === value }" :aria-pressed="status === value" @click="$emit('update:status', value)">{{ label }}</button>
      </div>
      <button class="icon-btn" type="button" title="清空筛选" aria-label="清空筛选" @click="$emit('reset')"><Icon name="x" :size="15" /></button>
      <slot name="summary" />
      <span class="filter-count" aria-live="polite">{{ count }}/{{ total }}</span>
    </div>
  `,
}
