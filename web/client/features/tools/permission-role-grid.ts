// 角色列表：四张角色摘要卡，行操作（配置/验证）上浮给父组件。
export const PermissionRoleGrid = {
  name: "PermissionRoleGrid",
  props: {
    summaries: { type: Array, default: () => [] },
    previewedRole: { type: String, default: "" },
  },
  emits: ["open-role", "preview-role"],
  setup() {
    // 权限/风险徽标统一走 Pill 语义 tone。
    function metaPills(role: { deniedCount?: number; external?: boolean; highRisk?: boolean }) {
      const items = []
      if (role.deniedCount) items.push({ label: `单独禁止 ${role.deniedCount}`, tone: "risk-high" })
      items.push(role.external ? { label: "可访问外网", tone: "risk-external" } : { label: "不访问外网" })
      items.push(role.highRisk ? { label: "含高风险操作", tone: "risk-high" } : { label: "拦截高风险" })
      return items
    }
    return { metaPills }
  },
  template: `
    <div class="permission-role-grid">
      <article v-for="role in summaries" :key="role.value" class="permission-role-card" :class="{ 'has-denies': role.deniedCount, 'is-previewed': previewedRole === role.value }">
        <span class="permission-role-head"><strong>{{ role.label }}</strong><small v-if="previewedRole === role.value">已验证</small></span>
        <span class="permission-role-summary">{{ role.summary }}</span>
        <PillList :items="metaPills(role)" />
        <span class="permission-role-actions">
          <button class="btn small outline" type="button" @click="$emit('open-role', role.value)"><Icon name="sliders" :size="13" />配置权限</button>
          <button class="btn small outline" type="button" @click="$emit('preview-role', role.value)"><Icon name="eye" :size="13" />验证此角色</button>
        </span>
      </article>
    </div>
  `,
}
