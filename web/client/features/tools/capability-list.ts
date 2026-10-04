import { PagedList } from "../../ui/components.js"
import { asRecord } from "../../shared/data.js"
import { toolCommon, riskLabel, riskBadgeClass } from "./shared.js"

/** 只负责布局和分页；筛选、权限及保存由领域组件提供。 */
export const CapabilityList = {
  name: "CapabilityList",
  components: { PagedList },
  props: {
    rows: { type: Array, default: () => [] },
    label: { type: String, default: "能力" },
    empty: { type: String, default: "没有匹配的能力。" },
  },
  template: `
    <div class="capability-list">
      <slot name="filters" />
      <div v-if="rows.length" class="capability-list-head" aria-hidden="true">
        <span>{{ label }}</span><span>风险等级</span><span>状态与标记</span><span>操作</span><span>使用角色</span>
      </div>
      <PagedList :rows="rows" :page-size="10" :label="label" :empty="empty" list-class="capability-list-items">
        <template #default="{ item }">
          <div class="capability-list-entry">
            <div class="capability-list-row">
              <div class="capability-list-copy"><slot name="identity" :item="item" /></div>
              <div class="capability-list-risk" data-label="风险等级"><slot name="risk" :item="item" /></div>
              <div class="capability-list-status"><slot name="status" :item="item" /></div>
              <div class="capability-list-actions"><slot name="actions" :item="item" /></div>
              <div class="capability-list-roles" data-label="使用角色"><slot name="roles" :item="item" /></div>
            </div>
            <slot name="details" :item="item" />
          </div>
        </template>
      </PagedList>
      <slot v-if="!rows.length" name="empty-actions" />
    </div>
  `,
}

/** 缺少工具元数据时不将未知风险误标为低风险。 */
export function capabilityRisk(tool: unknown) {
  const common = toolCommon(tool)
  const policy = asRecord(common.policy)
  if (!common.risk && !policy.highRisk && !policy.externalNetwork) return { label: "待确认", tone: "" }
  const label = riskLabel(tool)
  return { label, tone: riskBadgeClass(label === "高风险" ? "high" : label === "外网访问" ? "external" : common.risk) }
}
export const CapabilityRisk = {
  props: { tool: { type: Object, default: () => ({}) } },
  setup() { return { capabilityRisk } },
  template: `<span class="badge" :class="capabilityRisk(tool).tone">{{ capabilityRisk(tool).label }}</span>`,
}
