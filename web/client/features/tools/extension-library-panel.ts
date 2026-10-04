import { CapabilityFilterBar } from "./capability-filter-bar.js"
import { CapabilityList, CapabilityRisk, capabilityRisk } from "./capability-list.js"
import { CapabilityRoleButtons } from "./capability-role-buttons.js"
import { asRecord, type UnknownRecord } from "../../shared/data.js"
import { toolCommon } from "./shared.js"

interface ExtensionRow extends UnknownRecord {
  id: string
  name?: string
  displayNameZh?: string
  description?: string
  descriptionZh?: string
  enabled?: boolean
  extensionType?: string
  bodyChars?: number
  validation?: { issues?: Array<{ level?: string }> }
  loadedTools?: unknown[]
  tools?: unknown[]
  resources?: UnknownRecord
  frameworkResources?: Array<{ alias?: string }>
  remote?: { repo?: string }
}

function packageToolSummary(item: ExtensionRow = { id: "" }) {
  const loaded = Array.isArray(item.loadedTools) ? item.loadedTools : []
  const hinted = Array.isArray(item.tools) ? item.tools : []
  const rows = loaded.length ? loaded : hinted
  if (!rows.length) return "未声明工具或尚未加载"
  return rows.map(tool => {
    const source = asRecord(tool)
    return String(toolCommon(source).displayNameZh || source.name || "")
  }).filter(Boolean).join("、")
}

function skillSourceText(item: ExtensionRow = { id: "" }) {
  const resources = asRecord(item.resources)
  const extras = Number(resources.scripts || 0) + Number(resources.references || 0) + Number(resources.assets || 0)
  return `${item.descriptionZh || item.description || item.id}${extras ? ` · 附带资源 ${extras} 个` : ""}`
}

function frameworkResourceSummary(item: ExtensionRow = { id: "" }) {
  const rows = Array.isArray(item.frameworkResources) ? item.frameworkResources : []
  return rows.length ? rows.map(resource => resource.alias || "").filter(Boolean).join("、") : "未引用外部功能块"
}

function catalogStatus(item: ExtensionRow) {
  const issues = item.validation?.issues || []
  const errorCount = issues.filter(i => i.level === "error").length
  const warnCount = issues.filter(i => i.level === "warn").length
  if (errorCount) return { label: `校验错误 ${errorCount}`, tone: "risk-high" }
  if (warnCount) return { label: `校验提示 ${warnCount}`, tone: "risk-medium" }
  return { label: item.enabled ? "已启用" : "未启用", active: item.enabled }
}

function packageRisk(item: ExtensionRow) {
  const tools = item.loadedTools?.length ? item.loadedTools : (item.tools || [])
  const risks = tools.map(capabilityRisk)
  const order = ["高风险", "外网访问", "中风险", "待确认", "低风险"]
  return risks.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label))[0] || { label: "待确认", tone: "" }
}

// 扩展列表：筛选条 + 目录表格 + 空态；行操作全部上浮给父组件。
export const ExtensionLibraryPanel = {
  components: { CapabilityFilterBar, CapabilityRoleButtons, CapabilityList, CapabilityRisk },
  name: "ExtensionLibraryPanel",
  props: {
    rows: { type: Array, default: () => [] },
    customCount: { type: Number, default: 0 },
    skillCount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    filter: { type: Object, required: true },
    hasFilter: Boolean,
  },
  emits: ["reload", "reset-filter", "open-create", "edit", "toggle", "update-remote", "remove"],
  setup() {
    return { packageRisk, toolCommon, catalogStatus, packageToolSummary, skillSourceText, frameworkResourceSummary }
  },
  template: `
    <div class="section-heading-row compact">
        <div class="section-title"><Icon name="cpu" :size="13" />当前自定义扩展</div>
        <button class="icon-btn" title="重新扫描扩展目录" @click="$emit('reload')"><Icon name="refresh" :size="14" /></button>
      </div>
      <CapabilityList :rows="rows" label="扩展" empty="没有匹配的扩展。">
        <template #filters>
          <CapabilityFilterBar v-model:category="filter.type" :category-options="[['all','全部类型'],['custom','Custom'],['skill','Skill']]" category-label="扩展类型筛选" v-model:query="filter.query" v-model:status="filter.status" :status-options="[['all','全部'],['enabled','已启用'],['disabled','未启用'],['issues','有问题']]" :count="rows.length" :total="total" placeholder="搜索扩展名称、ID 或能力" @reset="$emit('reset-filter')">
            <template #summary><span class="filter-count">Custom {{ customCount }} · Skill {{ skillCount }}</span></template>
          </CapabilityFilterBar>
        </template>
        <template #identity="{ item }">
          <strong>{{ item.displayNameZh || item.name || item.id }}</strong>
          <div class="cell-sub">{{ item.id }}</div>
          <div class="cell-sub">{{ item.extensionType === 'skill' ? skillSourceText(item) : (item.descriptionZh || item.description || '暂未填写说明') }}</div>
          <div class="cell-sub" v-if="item.extensionType === 'skill'">$调用：{{ item.name || item.id }} · SKILL.md {{ item.bodyChars || 0 }} 字符</div>
          <div class="cell-sub" v-else>资源：{{ frameworkResourceSummary(item) }}</div>
        </template>
        <template #risk="{ item }"><span class="badge" :class="item.extensionType === 'skill' ? '' : packageRisk(item).tone" :title="item.extensionType === 'skill' ? 'Skill 提供指令，工具调用仍按工具风险和权限检查' : '按已知工具的最高风险显示，展开查看各项风险'">{{ item.extensionType === 'skill' ? '指令扩展' : packageRisk(item).label }}</span></template>
        <template #status="{ item }"><span class="badge">{{ item.extensionType === 'skill' ? 'Skill' : 'Custom' }}</span><Pill v-bind="catalogStatus(item)" /></template>
        <template #actions="{ item }">
          <button class="btn small outline" @click="$emit('edit', item)">编辑</button>
          <button v-if="item.extensionType === 'skill' && item.remote?.repo" class="btn small outline" @click="$emit('update-remote', item)">更新</button>
          <button class="icon-btn danger" title="删除扩展" @click="$emit('remove', item)"><Icon name="trash" :size="14" /></button>
          <Switch :model-value="item.enabled" @update:model-value="$emit('toggle', item)" />
        </template>
        <template #roles="{ item }"><CapabilityRoleButtons :scope="item.extensionType === 'skill' ? 'skillPackages' : 'customPackages'" :id="item.id" /></template>
        <template #details="{ item }">
          <details v-if="item.extensionType !== 'skill'" class="capability-list-details"><summary>包含工具 · {{ packageToolSummary(item) }}</summary>
            <CapabilityList :rows="item.loadedTools?.length ? item.loadedTools : (item.tools || [])" label="工具" empty="未声明工具或尚未加载。">
              <template #identity="{ item: tool }"><strong>{{ toolCommon(tool).displayNameZh || tool.name }}</strong><div class="cell-sub">{{ tool.name }}</div><div class="cell-sub">{{ toolCommon(tool).descriptionZh || toolCommon(tool).description }}</div></template>
              <template #risk="{ item: tool }"><CapabilityRisk :tool="tool" /></template>
              <template #roles="{ item: tool }"><CapabilityRoleButtons v-if="tool.name" :id="tool.name" /></template>
            </CapabilityList>
          </details>
        </template>
      </CapabilityList>
      <div v-if="!rows.length" class="extension-empty-state">
        <Icon name="package" :size="22" />
        <strong>{{ total ? '没有匹配的扩展' : '当前还没有 Custom 或 Skill 扩展' }}</strong>
        <p>{{ total ? '当前筛选隐藏了已有扩展，可以清空筛选后查看全部。' : '点击右上角“新建扩展”，选择一种创建路线开始。' }}</p>
        <div class="toolbar">
          <button v-if="hasFilter" class="btn small outline" type="button" @click="$emit('reset-filter')"><Icon name="x" :size="14" />清空筛选</button>
          <button v-else class="btn primary small" type="button" @click="$emit('open-create')"><Icon name="plus" :size="14" />新建第一个扩展</button>
      </div>
    </div>
  `,
}
