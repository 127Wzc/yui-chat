import { ref, computed, nextTick } from "vue"
import { store } from "../../app/store/store.js"
import { asRecord, asRecords } from "../../shared/data.js"
import { ExtensionPanel } from "./extension-panel.js"
import { McpPanel } from "./mcp-panel.js"
import { ToolDetailModal } from "./tool-detail-modal.js"
import { BoundaryAccessPanel } from "./permission-panel.js"
import { ToolListPanel } from "./tools-list-panel.js"
import { BuiltinCategorySettingsPanel } from "./builtin-category-panel.js"
import { GlobalToolSettingsPanel } from "./global-tool-settings-panel.js"
import { isFoldedRenderTool, toolSource, type ToolConfigRoot, type ToolRecord, type ToolsSlice } from "./shared.js"

export const ToolsTab = {
  name: "ToolsTab",
  components: { ToolListPanel, ExtensionPanel, ToolDetailModal, BoundaryAccessPanel, GlobalToolSettingsPanel, BuiltinCategorySettingsPanel, McpPanel },
  setup() {
    const activeCapabilityView = ref("discover")
    const activeBuiltinCategory = ref("all")
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
    function selectBuiltinCategory(value: string) { activeBuiltinCategory.value = String(value || "all") }
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
    return {
      isPermissionPage,
      activeCapabilityView,
      activeBuiltinCategory,
      showGlobalSettings,
      showToolDetail,
      selectedTool,
      selectedToolTab,
      globalToolsEnabled,
      capabilityViewItems,
      openToolDetail,
      selectBuiltinCategory,
    }
  },
  template: `
    <div class="stack">
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
      <div v-if="!isPermissionPage" class="section-stage capability-workspace">
        <div v-if="activeCapabilityView === 'discover'" class="section-stage capability-source-stage capability-builtin-layout">
          <ToolListPanel :selected-category="activeBuiltinCategory" @category-change="selectBuiltinCategory" @open-tool-detail="openToolDetail" />
          <BuiltinCategorySettingsPanel :selected-category="activeBuiltinCategory" @select-category="selectBuiltinCategory" />
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
