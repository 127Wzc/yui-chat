import { toJson, paginate } from "../shared/format.js"
import { confirmState, settleConfirm, toastState } from "../app/store/store.js"
import { defineComponent, nextTick, watch } from "vue"
import { icons } from "../shared/icons.js"

const openDrawerStack: unknown[] = []
let drawerSequence = 0

// 内联 SVG 图标。name 取自 lib/icons.js。
export const Icon = defineComponent({
  name: "Icon",
  props: { name: String, size: { type: [Number, String], default: 16 } },
  computed: {
    inner() { return (icons as Record<string, string>)[String(this.name || "")] || "" },
  },
  template: `<svg class="icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="inner"></svg>`,
})

// 纯图标按钮 + 悬浮说明（表格行内操作、顶栏动作）。
export const IconButton = defineComponent({
  name: "IconButton",
  props: {
    icon: String,
    tip: String,
    tone: String,                 // accent / good / warn / danger
    tipDir: String,               // tip-left / tip-right
    size: { type: [Number, String], default: 16 },
    disabled: Boolean,
    busy: Boolean,
  },
  emits: ["click"],
  template: `
    <button type="button" class="icon-btn" :class="[tone, tipDir, { 'is-busy': busy }]" :data-tip="tip" :disabled="disabled || busy" @click="$emit('click', $event)">
      <Icon :name="icon" :size="size" :class="{ 'icon-spin': busy }" />
    </button>
  `,
})

// 状态点 + 文本 + 可选悬浮说明。state: on/off/warn/bad
export const StatusDot = defineComponent({
  name: "StatusDot",
  props: { state: { type: String, default: "off" }, label: String, tip: String },
  template: `<span class="status-cell" :data-tip="tip"><span class="dot" :class="state"></span><span v-if="label">{{ label }}</span></span>`,
})

// 开关。
export const Switch = defineComponent({
  name: "Switch",
  props: { modelValue: Boolean, tip: String },
  emits: ["update:modelValue"],
  template: `
    <label class="switch" :data-tip="tip">
      <input type="checkbox" :checked="modelValue" @change="$emit('update:modelValue', $event.target.checked)" />
      <span class="track"></span>
    </label>
  `,
})

// 字段说明专用浮层：挂到 body 顶层，避免被抽屉滚动容器裁切。
export const HelpTip = defineComponent({
  name: "HelpTip",
  props: { tip: String },
  data() {
    return {
      open: false,
      left: 12,
      top: 12,
      placement: "top",
      maxWidth: 300,
    }
  },
  methods: {
    hide() {
      this.open = false
    },
    show(event: Event) {
      const target = event.currentTarget instanceof Element ? event.currentTarget : null
      const rect = target?.getBoundingClientRect?.()
      if (!rect) return
      const viewportWidth = Math.max(window.innerWidth || 0, 320)
      const maxWidth = Math.min(320, viewportWidth - 24)
      const left = Math.max(12, Math.min(rect.left - 6, viewportWidth - maxWidth - 12))
      const preferTop = rect.top > 84
      this.maxWidth = maxWidth
      this.left = left
      this.top = preferTop ? Math.max(12, rect.top - 12) : Math.min((window.innerHeight || 0) - 12, rect.bottom + 12)
      this.placement = preferTop ? "top" : "bottom"
      this.open = true
    },
  },
  mounted() {
    window.addEventListener("scroll", this.hide, true)
    window.addEventListener("resize", this.hide)
  },
  beforeUnmount() {
    window.removeEventListener("scroll", this.hide, true)
    window.removeEventListener("resize", this.hide)
  },
  template: `
    <span class="help-tip-anchor">
      <span
        class="field-help"
        tabindex="0"
        role="button"
        :aria-label="tip"
        @mouseenter="show"
        @mouseleave="hide"
        @focus="show"
        @blur="hide"
      ><Icon name="info" :size="13" /></span>
      <Teleport to="body">
        <div
          v-if="open && tip"
          class="floating-tip"
          :class="'side-' + placement"
          :style="{ left: left + 'px', top: top + 'px', maxWidth: maxWidth + 'px' }"
        >{{ tip }}</div>
      </Teleport>
    </span>
  `,
})

// 面板容器：可选图标标题 + 右上动作槽（actions）+ 主体。
// 兼容旧用法 <Panel title="x">内容</Panel>。
export const Panel = defineComponent({
  name: "Panel",
  props: { title: String, subtitle: String, icon: String, flush: Boolean },
  template: `
    <section class="panel">
      <div v-if="title || $slots.actions" class="panel-head">
        <h2 v-if="title"><Icon v-if="icon" :name="icon" :size="15" />{{ title }}</h2>
        <div v-if="$slots.actions" class="panel-actions"><slot name="actions" /></div>
      </div>
      <div class="panel-body" :class="{ flush }">
        <p v-if="subtitle" class="muted small">{{ subtitle }}</p>
        <slot />
      </div>
    </section>
  `,
})

// 统一表单字段；支持 v-model；type=number 自动转数字；可选 tip 悬浮说明。
export const Field = defineComponent({
  name: "Field",
  props: {
    label: String,
    modelValue: { type: [String, Number, Boolean], default: "" },
    type: { type: String, default: "text" },
    options: { type: Array, default: () => [] },
    placeholder: String,
    hint: String,
    tip: String,
    rows: Number,
    disabled: Boolean,
  },
  emits: ["update:modelValue", "enter"],
  computed: {
    normOptions() {
      return this.options.map((o: unknown) => (typeof o === "object" && o !== null ? o : { value: o, label: o }))
    },
  },
  methods: {
    onInput(event: Event) {
      const raw = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement ? event.target.value : ""
      const value = this.type === "number" ? (raw === "" ? "" : Number(raw)) : raw
      this.$emit("update:modelValue", value)
    },
  },
  template: `
    <label class="field">
      <span class="field-label" v-if="label">{{ label }}
        <small v-if="hint" class="field-hint">{{ hint }}</small>
        <HelpTip v-if="tip" :tip="tip" />
      </span>
      <select v-if="type === 'select'" :value="modelValue" :disabled="disabled" @change="onInput">
        <option v-for="o in normOptions" :key="String(o.value)" :value="o.value">{{ o.label }}</option>
      </select>
      <textarea
        v-else-if="type === 'textarea'"
        class="compact-textarea"
        :value="modelValue"
        :placeholder="placeholder"
        :rows="rows"
        :disabled="disabled"
        @input="onInput"
      ></textarea>
      <input
        v-else
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        autocomplete="off"
        :disabled="disabled"
        @input="onInput"
        @keydown.enter="$emit('enter', $event)"
      />
    </label>
  `,
})

// 单个状态药丸（可选图标）。
export const Pill = defineComponent({
  name: "Pill",
  props: { label: [String, Number], active: Boolean, tone: String, icon: String },
  template: `<span class="pill" :class="[{ on: active }, tone]"><Icon v-if="icon" :name="icon" :size="12" />{{ label }}</span>`,
})

// 药丸列表：items 可为字符串或 { label, active, tone, icon }。
export const PillList = defineComponent({
  name: "PillList",
  props: { items: { type: Array, default: () => [] }, listClass: String },
  computed: {
    norm() {
      return this.items
        .filter((item: unknown) => item !== null && item !== undefined && item !== false)
        .map((item: unknown) => (typeof item === "object" && item !== null ? item : { label: item }))
    },
  },
  template: `
    <div class="pill-list" :class="listClass">
      <span class="pill" v-for="(p, i) in norm" :key="i" :class="[{ on: p.active }, p.tone || p.className]">
        <Icon v-if="p.icon" :name="p.icon" :size="12" />{{ p.label }}
      </span>
    </div>
  `,
})

// 指标网格：item = { label, value, max?, icon, tone, tip }。有 max 时显示「value / max」+ 渐变进度条。
export const MetricGrid = defineComponent({
  name: "MetricGrid",
  props: { items: { type: Array, default: () => [] }, compact: Boolean },
  methods: {
    pct(m: Record<string, unknown>) {
      const v = Number(m.value), max = Number(m.max)
      if (!Number.isFinite(v) || !Number.isFinite(max) || max <= 0) return 0
      return Math.max(0, Math.min(100, Math.round((v / max) * 100)))
    },
    hasBar(m: Record<string, unknown>) {
      return m.max != null && Number(m.max) > 0 && Number.isFinite(Number(m.value))
    },
  },
  template: `
    <div class="metric-grid" :class="{ compact }">
      <div class="metric" v-for="(m, i) in items" :key="i" :data-tip="m.tip">
        <div class="metric-top">
          <span class="metric-label">{{ m.label }}</span>
          <span v-if="m.icon" class="metric-badge" :class="m.tone || 'blue'"><Icon :name="m.icon" :size="16" /></span>
        </div>
        <div class="metric-value"><b>{{ m.value }}</b><span v-if="m.max != null" class="metric-sub">/ {{ m.max }}</span></div>
        <div v-if="hasBar(m)" class="metric-bar" :class="m.tone || 'blue'"><span :style="{ width: pct(m) + '%' }"></span></div>
      </div>
    </div>
  `,
})

// 折叠区块：封装 details/summary，进阶项默认收起。
export const Collapse = defineComponent({
  name: "Collapse",
  props: { title: String, hint: String, open: Boolean, nested: Boolean },
  template: `
    <details class="config-details" :class="{ 'nested-details': nested }" :open="open">
      <summary><span>{{ title }}</span><small v-if="hint">{{ hint }}</small></summary>
      <slot />
    </details>
  `,
})

// 页面内二级导航：把同一配置域拆成可理解的小任务，避免所有面板同时铺开。
export const SectionNav = defineComponent({
  name: "SectionNav",
  props: {
    modelValue: { type: String, default: "" },
    items: { type: Array, default: () => [] },
    label: { type: String, default: "页面分区" },
    variant: { type: String, default: "cards" },
  },
  emits: ["update:modelValue"],
  template: `
    <nav class="section-nav" :class="{ 'section-nav-tabs': variant === 'tabs' }" :aria-label="label" :role="variant === 'tabs' ? 'tablist' : undefined">
      <button
        v-for="item in items"
        :key="item.value"
        type="button"
        class="section-nav-item"
        :class="{ active: modelValue === item.value }"
        :role="variant === 'tabs' ? 'tab' : undefined"
        :aria-selected="variant === 'tabs' ? modelValue === item.value : undefined"
        :aria-current="variant === 'tabs' ? undefined : (modelValue === item.value ? 'page' : undefined)"
        @click="$emit('update:modelValue', item.value)"
      >
        <span class="section-nav-icon"><Icon :name="item.icon || 'chevron-right'" :size="16" /></span>
        <span class="section-nav-copy"><strong>{{ item.label }}</strong><small v-if="item.description">{{ item.description }}</small></span>
        <span v-if="item.badge !== undefined && item.badge !== ''" class="section-nav-badge" :class="item.tone">{{ item.badge }}</span>
        <Icon name="chevron-right" :size="14" class="section-nav-arrow" />
      </button>
    </nav>
  `,
})

// 分页列表：scoped slot 提供 { item, index }；内置图标分页条与空态。
export const PagedList = defineComponent({
  name: "PagedList",
  props: {
    rows: { type: Array, default: () => [] },
    pageSize: { type: Number, default: 8 },
    label: { type: String, default: "条目" },
    listClass: { type: String, default: "list" },
    empty: { type: String, default: "暂无条目。" },
  },
  data() {
    return { page: 1 }
  },
  computed: {
    info() {
      return paginate(this.rows.length, this.page, this.pageSize)
    },
    visible() {
      return this.rows.slice(this.info.start, this.info.end)
    },
  },
  watch: {
    "rows.length"() {
      if ((this.page - 1) * this.pageSize >= this.rows.length) this.page = 1
    },
  },
  methods: {
    go(target: unknown) {
      this.page = Math.min(Math.max(1, Number(target) || 1), this.info.pages)
    },
  },
  template: `
    <div>
      <div v-if="rows.length > pageSize" class="pager">
        <span class="pager-info">{{ label }} {{ info.start + 1 }}-{{ info.end }} / {{ rows.length }}</span>
        <div class="pager-controls">
          <button type="button" class="icon-btn sm" :disabled="info.current <= 1" @click="go(info.current - 1)"><Icon name="chevron-left" :size="15" /></button>
          <span class="pager-page">{{ info.current }}/{{ info.pages }}</span>
          <button type="button" class="icon-btn sm" :disabled="info.current >= info.pages" @click="go(info.current + 1)"><Icon name="chevron-right" :size="15" /></button>
        </div>
      </div>
      <p v-if="!rows.length" class="muted small">{{ empty }}</p>
      <div v-else :class="listClass">
        <slot v-for="(item, i) in visible" :item="item" :index="info.start + i" :key="info.start + i" />
      </div>
    </div>
  `,
})

// 折叠 JSON 调试块。
export const JsonBlock = defineComponent({
  name: "JsonBlock",
  props: { title: String, value: {}, open: Boolean },
  computed: {
    text() {
      return toJson(this.value)
    },
  },
  template: `
    <details class="debug-json" :open="open">
      <summary><Icon name="info" :size="13" />{{ title }}</summary>
      <pre>{{ text }}</pre>
    </details>
  `,
})

// 右侧抽屉：用于新增/编辑这类较重表单，避免挤在列表页里。
export const SideDrawer = defineComponent({
  name: "SideDrawer",
  props: {
    open: Boolean,
    title: String,
    subtitle: String,
    icon: { type: String, default: "plus" },
    width: { type: String, default: "520px" },
    modal: Boolean,
  },
  emits: ["close"],
  data() {
    drawerSequence += 1
    return { drawerUid: `yui-chat-drawer-${drawerSequence}`, lastFocused: null as HTMLElement | null, layerZIndex: 90 }
  },
  watch: {
    open(value: unknown, previous: unknown) {
      if (value) this.activateDrawer()
      else if (previous) this.deactivateDrawer()
    },
  },
  methods: {
    focusableElements() {
      const panel = this.$refs.panel as HTMLElement | undefined
      if (!panel) return []
      return Array.from(panel.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .map(element => element as HTMLElement)
        .filter(element => !element.hidden && element.getClientRects().length)
    },
    activateDrawer() {
      this.lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const index = openDrawerStack.indexOf(this)
      if (index >= 0) openDrawerStack.splice(index, 1)
      openDrawerStack.push(this)
      this.layerZIndex = 90 + openDrawerStack.length
      this.$nextTick(() => {
        const first = this.focusableElements()[0] as HTMLElement | undefined
        ;(first || (this.$refs.panel as HTMLElement | undefined))?.focus?.()
      })
    },
    deactivateDrawer({ restoreFocus = true } = {}) {
      const index = openDrawerStack.indexOf(this)
      const wasTop = index === openDrawerStack.length - 1
      if (index >= 0) openDrawerStack.splice(index, 1)
      if (restoreFocus && wasTop && this.lastFocused?.isConnected) this.lastFocused.focus?.()
      this.lastFocused = null
    },
    onKeydown(event: KeyboardEvent) {
      if (!this.open || openDrawerStack.at(-1) !== this) return
      if (event.key === "Escape") {
        event.preventDefault()
        this.$emit("close")
        return
      }
      if (event.key !== "Tab") return
      const focusable = this.focusableElements()
      if (!focusable.length) {
        event.preventDefault()
        const panel = this.$refs.panel as HTMLElement | undefined
        panel?.focus?.()
        return
      }
      const first = focusable[0] as HTMLElement
      const last = focusable.at(-1) as HTMLElement | undefined
      if (!last) return
      const panel = this.$refs.panel as HTMLElement | undefined
      if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    },
  },
  mounted() {
    window.addEventListener("keydown", this.onKeydown)
    if (this.open) this.activateDrawer()
  },
  beforeUnmount() {
    window.removeEventListener("keydown", this.onKeydown)
    this.deactivateDrawer({ restoreFocus: false })
  },
  template: `
    <Teleport to="body">
      <div v-if="open" class="drawer-layer" :class="{ 'drawer-modal': modal }" :style="{ zIndex: layerZIndex }" role="dialog" aria-modal="true" :aria-labelledby="drawerUid + '-title'">
        <button class="drawer-scrim" type="button" aria-label="关闭抽屉" @click="$emit('close')"></button>
        <aside ref="panel" class="side-drawer" :class="{ 'modal-dialog': modal }" :style="{ width }" tabindex="-1">
          <header class="drawer-head">
            <div class="drawer-title">
              <span class="drawer-icon"><Icon :name="icon" :size="16" /></span>
              <div><h2 :id="drawerUid + '-title'">{{ title }}</h2><p v-if="subtitle">{{ subtitle }}</p></div>
            </div>
            <button class="icon-btn" type="button" data-tip="关闭" @click="$emit('close')"><Icon name="x" :size="16" /></button>
          </header>
          <div class="drawer-body"><slot /></div>
          <footer v-if="$slots.actions" class="drawer-actions"><slot name="actions" /></footer>
        </aside>
      </div>
    </Teleport>
  `,
})

// 全局唯一 Toast。
export const Toast = defineComponent({
  name: "Toast",
  setup() {
    return { toastState }
  },
  template: `<aside class="toast" :class="[toastState.tone, { show: toastState.show }]" role="status" :aria-live="toastState.tone === 'danger' ? 'assertive' : 'polite'"><span class="toast-icon"><Icon :name="toastState.icon" :size="16" /></span><span>{{ toastState.message }}</span></aside>`,
})

// 全站危险操作统一二次确认弹框。
export const ConfirmDialog = defineComponent({
  name: "ConfirmDialog",
  setup() {
    const focusDialog = () => nextTick(() => {
      const dialog = document.querySelector(".confirm-dialog")
      if (dialog instanceof HTMLElement) dialog.focus()
    })
    watch(() => confirmState.open, (open: boolean) => { if (open) focusDialog() })
    function onKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") return settleConfirm(false)
      if (event.key !== "Tab") return
      const host = event.currentTarget instanceof Element ? event.currentTarget : null
      const dialog = host?.querySelector?.(".confirm-dialog")
      const focusable = Array.from(dialog?.querySelectorAll?.('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])
      if (!dialog || !focusable.length) return
      const first = focusable[0] as HTMLElement | undefined
      const last = focusable.at(-1) as HTMLElement | undefined
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    return { confirmState, settleConfirm, onKeydown }
  },
  template: `
    <Teleport to="body">
      <div v-if="confirmState.open" class="confirm-layer" role="dialog" aria-modal="true" aria-labelledby="global-confirm-title" @keydown="onKeydown">
        <button class="confirm-scrim" type="button" aria-label="取消操作" @click="settleConfirm(false)"></button>
        <section class="confirm-dialog" :class="confirmState.tone" tabindex="-1">
          <span class="confirm-icon"><Icon :name="confirmState.icon" :size="22" /></span>
          <div class="confirm-copy">
            <h2 id="global-confirm-title">{{ confirmState.title }}</h2>
            <p>{{ confirmState.message }}</p>
            <div v-if="confirmState.detail" class="confirm-detail">{{ confirmState.detail }}</div>
          </div>
          <div class="confirm-actions">
            <button class="btn outline" type="button" @click="settleConfirm(false)">{{ confirmState.cancelText }}</button>
            <button class="btn" :class="confirmState.tone === 'warn' ? 'warn' : 'danger'" type="button" @click="settleConfirm(true)">{{ confirmState.confirmText }}</button>
          </div>
        </section>
      </div>
    </Teleport>
  `,
})

// 空态短句。
export const EmptyHint = defineComponent({
  name: "EmptyHint",
  props: { text: { type: String, default: "暂无条目。" } },
  template: `<p class="muted small">{{ text }}</p>`,
})

export const components = {
  Icon,
  IconButton,
  StatusDot,
  Switch,
  HelpTip,
  Panel,
  Field,
  Pill,
  PillList,
  MetricGrid,
  Collapse,
  SectionNav,
  PagedList,
  JsonBlock,
  SideDrawer,
  Toast,
  ConfirmDialog,
  EmptyHint,
}
