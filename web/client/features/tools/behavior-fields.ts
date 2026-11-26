import { computed } from "vue"
import { type UnknownRecord } from "../../shared/data.js"

interface BehaviorField {
  key: string; label: string; group: string; tip?: string; choices?: string[][]; min?: number; max?: number; unit?: string
}
const fields: BehaviorField[] = [
  { key: "mode", label: "执行方式", group: "常用设置", choices: [["foreground", "前台等待"], ["background", "后台执行"], ["silent", "后台静默"]], tip: "后台执行不阻塞主对话；后台静默不发送开始或失败提示，完成结果仍保留在工具记录中。" },
  { key: "requiresFinalReply", label: "执行后需要回复", group: "常用设置", tip: "是否要求模型继续说明结果；工具自身发送消息另由其投递能力控制。" },
  { key: "timeoutMs", label: "执行超时", group: "常用设置", min: 1, max: 600, unit: "秒", tip: "前台为每次尝试的超时，静默后台包含排队时间；工具内部请求可能有更短的限制。" },
  { key: "repeatPolicy", label: "重复调用", group: "重复与失败处理", choices: [["bounded", "允许有限重复"], ["dedupe", "相同请求去重"], ["explicit_only", "仅按用户明确次数"], ["allow", "允许重复"]], tip: "控制模型再次调用同一工具的方式；始终受本轮工具预算与执行次数限制。" },
  { key: "retryPolicy", label: "失败处理", group: "重复与失败处理", choices: [["none", "禁止自动重试"], ["no_ambiguous_retry", "结果不确定时禁止重试"], ["safe", "瞬时失败时有限重试"], ["executor", "由执行器有限重试"]], tip: "重试只针对符合条件的失败；已经派发或结果不确定的动作不会重做，后台任务失败不自动重跑。" },
  { key: "maxAttempts", label: "最多尝试次数", group: "重复与失败处理", min: 1, max: 5, tip: "包含第一次执行，2 表示最多再试一次。" },
  { key: "parallelSafe", label: "允许与其他查询并行", group: "执行限制", tip: "仅适用于只读工具；同轮工具都满足并行条件时才会并行。" },
  { key: "maxCount", label: "一次最多执行数量", group: "执行限制", min: 1, max: 100, tip: "仅对声明支持次数参数的工具生效，不赋予额外操作权限。" },
  { key: "maxPolls", label: "最多状态查询次数", group: "执行限制", min: 1, max: 20 },
  { key: "minPollIntervalMs", label: "状态查询最小间隔", group: "执行限制", min: 0, max: 60, unit: "秒" },
  { key: "continueConversation", label: "发送结果后继续回复", group: "高级设置", tip: "仅对已接入自动投递的前台工具生效；同批次统一续答一次。" },
  { key: "deferLoading", label: "按需加载工具定义", group: "高级设置", tip: "仅支持该能力的模型协议使用；不改变工具的启停与权限。" },
  { key: "hiddenFromModel", label: "对模型隐藏", group: "高级设置", tip: "隐藏后不进入模型工具列表；不会关闭动作入口或修改角色权限。" },
]
export const BEHAVIOR_SECTIONS = [
  { id: "common", label: "执行与回复", groups: ["常用设置"] },
  { id: "limits", label: "调用控制", groups: ["重复与失败处理", "执行限制"] },
  { id: "advanced", label: "高级设置", groups: ["高级设置"] },
]

export const BehaviorFields = {
  name: "BehaviorFields",
  props: { values: { type: Object, required: true }, inherited: { type: Object, required: true }, capabilities: { type: Array, default: () => [] }, action: Boolean, batch: Boolean, section: { type: String, default: "common" } },
  emits: ["change"],
  setup(props: { values: UnknownRecord; inherited: UnknownRecord; capabilities: UnknownRecord[]; action: boolean; batch: boolean; section?: string }, { emit }: { emit: (event: string, key: string, value: unknown) => void }) {
    const effective = computed(() => {
      const values = { ...props.inherited, ...Object.fromEntries(Object.entries(props.values).filter(([, value]) => value !== null)) }
      // 前置条件以该工具允许修改的执行方式为准。
      if (props.capabilities.length && props.capabilities.every(cap => cap.backgroundAvailable === false)) values.mode = props.inherited.mode
      return values
    })
    function supported(field: BehaviorField): boolean {
      const caps = props.capabilities
      if (props.action && ["requiresFinalReply", "continueConversation", "deferLoading", "hiddenFromModel"].includes(field.key)) return false
      if (field.key === "mode") return caps.some(cap => cap.backgroundAvailable !== false)
      if (field.key === "requiresFinalReply") return effective.value.mode === "foreground" || effective.value.mode === undefined
      if (["retryPolicy", "maxAttempts"].includes(field.key) && ["background", "silent"].includes(String(effective.value.mode))) return false
      if (field.key === "maxAttempts") return ["safe", "executor"].includes(String(effective.value.retryPolicy))
      if (field.key === "parallelSafe") return caps.some(cap => cap.effect === "read")
      if (field.key === "maxCount") return caps.some(cap => cap.supportsCount === true)
      if (["maxPolls", "minPollIntervalMs"].includes(field.key)) return caps.some(cap => cap.polling === true)
      if (field.key === "continueConversation") return caps.some(cap => cap.autoDelivery === true) && (effective.value.mode === "foreground" || effective.value.mode === undefined)
      return true
    }
    const groups = computed(() => ["常用设置", "重复与失败处理", "执行限制", "高级设置"].map(label => ({ label, fields: fields.filter(field => field.group === label && supported(field)) })).filter(group => group.fields.length))
    const visibleGroups = computed(() => {
      const selected = BEHAVIOR_SECTIONS.find(section => section.id === props.section)
      return selected ? groups.value.filter(group => selected.groups.includes(group.label)) : groups.value
    })
    function labelValue(field: BehaviorField, value: unknown): string {
      if (value === undefined) return "各工具原有设置"
      if (field.choices) return field.choices.find(choice => choice[0] === value)?.[1] || String(value)
      if (field.min !== undefined) return `${Number(value) / (field.unit ? 1000 : 1)}${field.unit || ""}`
      return value ? "开启" : "关闭"
    }
    function options(field: BehaviorField) {
      return [...(props.batch ? [{ value: "__keep", label: "不修改，保持各自设置" }, { value: "__reset", label: "恢复各自默认" }] : [{ value: "__inherit", label: `使用默认（${labelValue(field, props.inherited[field.key])}）` }]), ...(field.choices || [["true", "开启"], ["false", "关闭"]]).map(([value, label]) => ({ value, label }))]
    }
    function controlValue(field: BehaviorField): string { return props.values[field.key] === undefined ? props.batch ? "__keep" : "__inherit" : props.values[field.key] === null ? "__reset" : String(props.values[field.key]) }
    function change(field: BehaviorField, value: unknown) {
      const next = value === "__keep" || props.batch && value === "" ? undefined : ["__inherit", "__reset", ""].includes(String(value)) ? null : field.min !== undefined ? Number(value) * (field.unit ? 1000 : 1) : field.choices ? value : value === "true"
      emit("change", field.key, next)
    }
    function numberValue(field: BehaviorField) { const value = effective.value[field.key]; return value === undefined ? "" : Number(value) / (field.unit ? 1000 : 1) }
    return { groups, visibleGroups, options, controlValue, change, numberValue, labelValue }
  },
  template: `
    <div class="stack behavior-fields">
      <section v-for="group in visibleGroups" :key="group.label" class="tool-config-card">
        <h3>{{ group.label }}</h3>
        <div class="behavior-field-grid">
          <div v-for="field in group.fields" :key="field.key" class="behavior-field">
            <Field v-if="field.min === undefined" :label="field.label" type="select" :options="options(field)" :model-value="controlValue(field)" @update:model-value="change(field, $event)" :tip="field.tip" />
            <template v-else>
              <Field :label="field.label + (field.unit ? '（' + field.unit + '）' : '')" type="number" :description="'范围：' + field.min + '–' + field.max + (field.unit || '')" :placeholder="'各工具原有设置'" :model-value="numberValue(field)" @update:model-value="change(field, $event)" :tip="field.tip" />
              <div class="row"><span class="muted tiny">{{ values[field.key] === undefined ? batch ? '保持各自设置' : '继承默认：' + labelValue(field, inherited[field.key]) : values[field.key] === null ? '将恢复各自默认' : '已单独设置' }}</span><button v-if="batch" class="btn small outline" type="button" @click="$emit('change', field.key, null)">恢复各自默认</button><button v-if="values[field.key] !== undefined" class="btn small outline" type="button" @click="$emit('change', field.key, batch ? undefined : null)">{{ batch ? '不修改' : '恢复默认' }}</button></div>
            </template>
          </div>
        </div>
      </section>
      <p v-if="!visibleGroups.length" class="muted small">当前工具或动作没有此类可配置项。</p>
    </div>
  `,
}
