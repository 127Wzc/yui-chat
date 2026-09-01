import { riskLabel, sourceLabel, sourceTechLabel, toolDisplayName, toolEnglishName, toolSource } from "./shared.js"
import { roleLabel, type MatrixResult, type MatrixRow } from "./permission-shared.js"

// 权限验证结果块：角色验证的统计、拦截原因与可用能力列表。
export const PermissionPreviewResult = {
  name: "PermissionPreviewResult",
  props: {
    roleName: { type: String, default: "" },
    allowedRows: { type: Array, default: () => [] },
    blockedRows: { type: Array, default: () => [] },
    rawValue: { type: Object, default: null },
    developerMode: { type: Boolean, default: false },
  },
  emits: ["close"],
  template: `
    <section class="permission-preview-result" aria-live="polite">
      <div class="permission-preview-heading">
        <span><Icon name="eye" :size="14" />{{ roleName }}</span>
        <strong>权限验证结果</strong>
        <small>基于当前已保存的权限配置</small>
        <button class="icon-btn permission-preview-close" type="button" :aria-label="'收起' + roleName + '验证结果'" data-tip="收起结果" @click="$emit('close')"><Icon name="x" :size="14" /></button>
      </div>
      <div class="permission-preview-stat allowed"><strong>{{ allowedRows.length }}</strong><span>项能力可用</span></div>
      <div class="permission-preview-stat blocked"><strong>{{ blockedRows.length }}</strong><span>项已启用能力被拦截</span></div>
      <Collapse title="查看拦截原因" :hint="blockedRows.length + ' 项'" :open="blockedRows.length > 0">
        <p v-if="!blockedRows.length" class="muted small">当前没有被拦截的已启用能力。</p>
        <div v-else class="permission-block-list">
          <div v-for="item in blockedRows" :key="item.name"><strong>{{ item.label }}</strong><span>{{ item.reason || '当前角色没有使用权限' }}</span></div>
        </div>
      </Collapse>
      <Collapse title="查看可用能力" :hint="allowedRows.length + ' 项'">
        <div class="toolbar wrap"><span v-for="item in allowedRows" :key="item.name" class="badge">{{ item.label }}</span></div>
      </Collapse>
      <JsonBlock v-if="developerMode" title="权限预览原始数据" :value="rawValue" />
    </section>
  `,
}

// 角色权限对比矩阵：编辑抽屉（详细）与预览抽屉（compact）共用同一表格。
export const PermissionMatrixTable = {
  name: "PermissionMatrixTable",
  props: {
    matrix: { type: Object, default: null },
    rows: { type: Array, default: () => [] },
    compact: { type: Boolean, default: false },
  },
  setup() {
    return { roleLabel, sourceLabel, sourceTechLabel, toolSource, riskLabel, toolDisplayName, toolEnglishName }
  },
  template: `
    <div v-if="matrix" class="matrix-table drawer-permission-matrix">
      <table>
        <thead><tr><th>工具</th><th>来源</th><th>风险</th><th v-for="role in matrix.roles" :key="role">{{ roleLabel(role) }}</th></tr></thead>
        <tbody>
          <tr v-for="row in rows" :key="row.tool.name">
            <td class="cell-title">{{ toolDisplayName(row.tool) }}<div v-if="!compact && toolEnglishName(row.tool)" class="cell-sub truncate" style="max-width:220px">{{ toolEnglishName(row.tool) }}</div></td>
            <td :class="{ 'cell-title': !compact }">{{ sourceLabel(toolSource(row.tool)) }}<div v-if="!compact && sourceTechLabel(toolSource(row.tool))" class="cell-sub truncate" style="max-width:120px">{{ sourceTechLabel(toolSource(row.tool)) }}</div></td>
            <td>{{ riskLabel(row.tool) }}</td>
            <td v-for="role in matrix.roles" :key="role" :class="row.decisions?.[role]?.allowed ? 'ok' : 'deny'">{{ row.decisions?.[role]?.allowed ? "允许" : "拦截" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `,
}

export type { MatrixResult, MatrixRow }
