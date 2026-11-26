import { inject } from "vue"
import type { BehaviorTarget } from "./behavior-drawer.js"

/** 各来源的行入口共用同一个配置弹窗，不持有保存状态。 */
export const BehaviorConfigButton = {
  name: "BehaviorConfigButton",
  props: { target: { type: Object, default: null }, disabled: Boolean, hint: String, label: { type: String, default: "配置" } },
  setup() { return { configure: inject<(target: BehaviorTarget | null) => void>("configureToolBehavior") } },
  template: `<button class="btn small outline" type="button" :disabled="disabled" :title="hint" @click="configure?.(target)"><Icon name="sliders" :size="13" />{{ label }}</button>`,
}
