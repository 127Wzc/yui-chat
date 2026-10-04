import { ref, computed, nextTick, onMounted, provide, watch } from "vue"
import { store, request, toast } from "../../app/store/store.js"
import { asRecord, asRecords } from "../../shared/data.js"
import { ExtensionPanel } from "./extension-panel.js"
import { McpPanel } from "./mcp-panel.js"
import { ToolDetailModal } from "./tool-detail-modal.js"
import { BoundaryAccessPanel } from "./permission-panel.js"
import { ToolListPanel } from "./tools-list-panel.js"
import { GlobalToolSettingsPanel } from "./global-tool-settings-panel.js"
import { isFoldedRenderTool, toolSource, type ToolConfigRoot, type ToolRecord, type ToolsSlice } from "./shared.js"

export const ToolsTab = {
  name: "ToolsTab",
  components: { ToolListPanel, ExtensionPanel, ToolDetailModal, BoundaryAccessPanel, GlobalToolSettingsPanel, McpPanel },
  setup() {
    const accessMatrix = ref<Record<string, unknown> | null>(null)
    const accessSaving = ref(false)
    let matrixGeneration = 0
    async function reloadAccess() {
      const generation = ++matrixGeneration
      try {
        const result = await request("/api/tools/access-matrix")
        if (generation === matrixGeneration) accessMatrix.value = asRecord(result.matrix)
      } catch { if (generation === matrixGeneration) { accessMatrix.value = null; toast("权限验证加载失败，请刷新重试") } }
    }
    provide("capabilityAccessMatrix", accessMatrix)
    provide("capabilityAccessSaving", accessSaving)
    provide("reloadCapabilityAccess", reloadAccess)
    watch([() => store.config, () => store.tools], () => { if (!accessSaving.value) void reloadAccess() }, { immediate: true })
    const activeCapabilityView = ref("discover")
    const showGlobalSettings = ref(false)
    const showToolDetail = ref(false)
    const selectedTool = ref<ToolRecord | null>(null)
    const selectedToolTab = ref("overview")
    const isPermissionPage = computed(() => store.activeTab === "tool-permissions")
    const globalToolsEnabled = computed(() => asRecord<ToolConfigRoot>(store.config).tools?.enabled !== false)
    const allTools = computed<ToolRecord[]>(() => asRecords<ToolRecord>(asRecord<ToolsSlice>(store.tools).tools).filter(item => toolSource(item) === "builtin" && !isFoldedRenderTool(item)))
    const enabledToolCount = computed(() => allTools.value.filter(item => item.enabled).length)
    const customCount = computed(() => asRecord<ToolsSlice>(store.tools).custom?.catalog?.length || 0)
    const skillCount = computed(() => asRecord<ToolsSlice>(store.tools).skills?.catalog?.length || 0)
    const mcpCount = computed(() => asRecord<ToolsSlice>(store.tools).mcp?.servers?.length || Object.keys(asRecord<ToolsSlice>(store.tools).mcp?.config?.servers || {}).length)
    const capabilityViewItems = computed(() => [
      { value: "discover", label: "内置能力", description: "系统内置工具的启用与配置", icon: "sparkles", badge: `${enabledToolCount.value}/${allTools.value.length}` },
      { value: "extensions", label: "扩展能力", description: "Custom 与 Markdown Skill", icon: "cpu", badge: customCount.value + skillCount.value },
      { value: "mcp", label: "MCP 服务", description: "第三方服务与本地命令", icon: "link", badge: mcpCount.value },
    ])
    // 内置能力的查看与运行配置留在内置页；只有 Custom 编辑才进入扩展工作区。
    async function openToolDetail(payload: { name?: string; action?: string }) {
      const tool = asRecords<ToolRecord>(asRecord<ToolsSlice>(store.tools).tools).find(item => item.name === payload?.name)
      if (!tool) return
      if (payload?.action === "edit" && toolSource(tool) === "custom") {
        activeCapabilityView.value = "extensions"
        await nextTick()
        window.dispatchEvent(new CustomEvent("yui-chat:open-tool-detail", { detail: payload }))
        return
      }
      if (toolSource(tool) === "builtin") {
        selectedTool.value = tool
        selectedToolTab.value = payload?.action === "config" ? (tool.name === "render_image" ? "render" : "configuration") : (tool.name === "render_image" ? "render" : "overview")
        showToolDetail.value = true
        return
      }
      window.dispatchEvent(new CustomEvent("yui-chat:open-tool-detail", { detail: payload }))
    }
    onMounted(() => {
      const target = store.toolDetailSeed
      if (target) { store.toolDetailSeed = null; void openToolDetail(target) }
    })
    return {
      isPermissionPage,
      activeCapabilityView,
      showGlobalSettings,
      showToolDetail,
      selectedTool,
      selectedToolTab,
      globalToolsEnabled,
      capabilityViewItems,
      openToolDetail,
    }
  },
  template: `
    <div class="stack capability-page">
      <nav v-if="!isPermissionPage" class="capability-mode-tabs" role="tablist" aria-label="能力类型">
        <button
          v-for="item in capabilityViewItems"
          :key="item.value"
          type="button"
          role="tab"
          :aria-selected="activeCapabilityView === item.value"
          :class="{ active: activeCapabilityView === item.value }"
          @click="activeCapabilityView = item.value"
        ><Icon :name="item.icon" :size="15" /><span>{{ item.label }}</span><b>{{ item.badge }}</b></button>
        <span class="capability-mode-spacer" aria-hidden="true"></span>
        <button class="capability-global-settings" type="button" :aria-label="globalToolsEnabled ? '打开全局工具设置' : '打开全局工具设置，当前已关闭'" @click="showGlobalSettings = true"><Icon name="gear" :size="15" /><span>全局配置</span><b>{{ globalToolsEnabled ? '已启用' : '已关闭' }}</b></button>
      </nav>
      <p v-if="!isPermissionPage" class="muted small">点击角色圆点切换权限；实心表示允许，空心表示禁止，半实心表示部分可用，虚线表示仍有限制。悬停查看角色和原因，↺ 恢复默认。</p>
      <div v-if="!isPermissionPage" class="section-stage capability-workspace">
        <div v-if="activeCapabilityView === 'discover'" class="section-stage capability-source-stage">
          <ToolListPanel @open-tool-detail="openToolDetail" />
        </div>
        <div v-else-if="activeCapabilityView === 'extensions'" class="section-stage capability-source-stage">
          <ExtensionPanel />
        </div>
        <div v-else-if="activeCapabilityView === 'mcp'" class="section-stage capability-source-stage">
          <McpPanel />
        </div>
      </div>
      <GlobalToolSettingsPanel v-if="!isPermissionPage" :open="showGlobalSettings" @close="showGlobalSettings = false" />
      <ToolDetailModal v-if="!isPermissionPage" :open="showToolDetail" :tool="selectedTool" :initial-tab="selectedToolTab" @updated="selectedTool = $event" @close="showToolDetail = false" />

      <div v-else class="section-stage capability-permission-workspace">
        <BoundaryAccessPanel />
      </div>
    </div>
  `,
}
