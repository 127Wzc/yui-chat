import { defineComponent, nextTick, onMounted, onUnmounted, ref } from "vue"

// 管理与提炼共用群选择器，选择和权限仍由父工作区处理。
export const MemoryGroupPicker = defineComponent({
  name: "MemoryGroupPicker",
  props: { view: { type: Object, required: true } },
  setup(props) {
    const root = ref<HTMLElement | null>(null)
    const trigger = ref<HTMLButtonElement | null>(null)
    const search = ref<HTMLInputElement | null>(null)
    async function toggle() {
      props.view.showGroupPicker = !props.view.showGroupPicker
      if (props.view.showGroupPicker) {
        await nextTick()
        search.value?.focus()
      }
    }
    function close(event: KeyboardEvent) {
      if (!props.view.showGroupPicker) return
      event.preventDefault()
      event.stopPropagation()
      props.view.showGroupPicker = false
      trigger.value?.focus()
    }
    function dismiss(event: PointerEvent) {
      if (props.view.showGroupPicker && event.target instanceof Node && !root.value?.contains(event.target)) props.view.showGroupPicker = false
    }
    onMounted(() => document.addEventListener("pointerdown", dismiss))
    onUnmounted(() => document.removeEventListener("pointerdown", dismiss))
    return { root, trigger, search, toggle, close }
  },
  template: `
    <div ref="root" class="group-picker" @keydown.esc="close">
      <span class="group-picker-label">群聊</span>
      <button ref="trigger" class="group-picker-trigger" type="button" aria-label="选择群聊" :aria-expanded="view.showGroupPicker" @click="toggle">
        <span v-if="view.selectedPolicy" class="status-dot" :class="{ paused: !view.selectedPolicy.enabled }"></span>
        <span class="truncate">{{ view.selectedPolicy ? view.policyTitle(view.selectedPolicy) : '选择已采集的群' }}</span>
        <Icon name="chevron-down" :size="14" />
      </button>
      <Transition name="picker">
        <div v-if="view.showGroupPicker" class="group-picker-menu" role="group" aria-label="已采集群聊">
          <label class="memory-search"><Icon name="search" :size="14" /><input ref="search" v-model="view.groupPickerQuery" type="search" aria-label="搜索群号" placeholder="搜索群号" /></label>
          <div v-for="policy in view.filteredPolicies" :key="policy.scopeId" class="group-picker-item" :class="[{ active: policy.scopeId === view.selectedGroupId }, policy.enabled ? 'is-running' : 'is-paused']">
            <button class="group-picker-option" type="button" :aria-current="policy.scopeId === view.selectedGroupId ? 'true' : undefined" @click="view.selectGroup(policy)"><span class="status-dot" :class="{ paused: !policy.enabled }"></span><span class="truncate">{{ view.policyTitle(policy) }}</span><small class="group-picker-state">{{ policy.enabled ? '采集中' : '已暂停' }}</small></button>
            <IconButton icon="pencil" :size="14" :tip="'编辑' + view.policyTitle(policy) + '的采集设置'" @click="view.openCaptureSettings(policy)" />
          </div>
          <p v-if="!view.filteredPolicies.length" class="muted small group-picker-empty">没有匹配的采集群</p>
          <button class="btn ghost small group-picker-add" type="button" @click="view.openCaptureSettings()"><Icon name="plus" :size="14" />添加采集群</button>
        </div>
      </Transition>
    </div>
  `,
})
