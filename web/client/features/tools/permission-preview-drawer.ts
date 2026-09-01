// 权限验证抽屉：单角色验证结果 + 全部角色对比矩阵，纯展示，事件上浮。
import { PermissionMatrixTable, PermissionPreviewResult } from "./permission-preview.js"

export const PermissionPreviewDrawer = {
  name: "PermissionPreviewDrawer",
  components: { PermissionPreviewResult, PermissionMatrixTable },
  props: {
    open: { type: Boolean, default: false },
    roleName: { type: String, default: "" },
    previewResult: { type: Object, default: null },
    allowedRows: { type: Array, default: () => [] },
    blockedRows: { type: Array, default: () => [] },
    matrixResult: { type: Object, default: null },
    matrixRows: { type: Array, default: () => [] },
    developerMode: { type: Boolean, default: false },
  },
  emits: ["close", "preview-matrix"],
  template: `
    <SideDrawer
      :open="open"
      :title="previewResult ? roleName + '的权限验证' : '角色权限对比'"
      subtitle="独立查看验证结果，不会改变角色卡片布局。"
      icon="eye"
      width="760px"
      @close="$emit('close')"
    >
      <PermissionPreviewResult
        v-if="previewResult"
        :role-name="roleName"
        :allowed-rows="allowedRows"
        :blocked-rows="blockedRows"
        :raw-value="previewResult"
        :developer-mode="developerMode"
        @close="$emit('close')"
      />
      <div v-else class="permission-preview-empty"><Icon name="eye" :size="20" /><strong>选择角色后查看验证结果</strong><p>会按当前已保存的权限配置计算可用与被拦截的能力。</p></div>
      <Collapse title="全部角色对比" hint="仅显示存在权限差异的已启用能力" :open="!!matrixResult">
        <div class="action-bar"><button class="btn small outline" type="button" @click="$emit('preview-matrix')"><Icon name="filter" :size="14" />生成角色对比</button></div>
        <PermissionMatrixTable v-if="matrixResult" :matrix="matrixResult" :rows="matrixRows" />
      </Collapse>
      <template #actions><button class="btn outline" type="button" @click="$emit('close')"><Icon name="x" :size="14" />关闭</button></template>
    </SideDrawer>
  `,
}
