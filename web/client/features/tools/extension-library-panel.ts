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

// 扩展列表：筛选条 + 目录表格 + 空态；行操作全部上浮给父组件。
export const ExtensionLibraryPanel = {
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
    return { catalogStatus, packageToolSummary, skillSourceText, frameworkResourceSummary }
  },
  template: `
    <div class="section-heading-row compact">
        <div class="section-title"><Icon name="cpu" :size="13" />当前自定义扩展</div>
        <IconButton icon="refresh" tip="重新扫描扩展目录" @click="$emit('reload')" />
      </div>
      <div class="list-filter extension-library-filter">
        <div class="filter-search"><Icon name="search" :size="14" /><input :value="filter.query" placeholder="搜索扩展名称、ID 或能力" @input="filter.query = $event.target.value" /></div>
        <div class="segmented" role="group" aria-label="扩展类型筛选">
          <button v-for="item in [['all','全部'],['custom','Custom'],['skill','Skill']]" :key="item[0]" :class="{ active: filter.type === item[0] }" type="button" @click="filter.type = item[0]">{{ item[1] }}</button>
        </div>
        <select v-model="filter.status" aria-label="扩展状态筛选"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">未启用</option><option value="issues">有问题</option></select>
        <span class="filter-count">Custom {{ customCount }} · Skill {{ skillCount }} · {{ rows.length }}/{{ total }}</span>
      </div>
      <div v-if="rows.length" class="table-wrap capability-table-wrap">
        <table class="data-table extension-tool-table">
          <thead><tr><th>扩展</th><th>类型</th><th>状态</th><th>包含能力</th><th class="col-actions">操作</th></tr></thead>
          <tbody>
            <tr v-for="item in rows" :key="item.extensionType + ':' + item.id">
              <td class="cell-title">
                {{ item.displayNameZh || item.name || item.id }}
                <div class="cell-sub truncate" style="max-width:300px">{{ item.extensionType === 'skill' ? skillSourceText(item) : (item.descriptionZh || item.description || '暂未填写说明') }}</div>
                <div class="cell-sub">ID：{{ item.id }}</div>
              </td>
              <td><span class="badge">{{ item.extensionType === 'skill' ? 'Skill' : 'Custom' }}</span></td>
              <td><Pill v-bind="catalogStatus(item)" /></td>
              <td class="cell-sub">
                <template v-if="item.extensionType === 'skill'">$调用：{{ item.name || item.id }} · SKILL.md {{ item.bodyChars || 0 }} 字符</template>
                <template v-else>{{ packageToolSummary(item) }}<div class="cell-sub">资源：{{ frameworkResourceSummary(item) }}</div></template>
              </td>
              <td class="col-actions">
                <div class="row-actions">
                  <button class="btn small outline" type="button" @click="$emit('edit', item)"><Icon name="pencil" :size="13" />编辑</button>
                  <button class="btn small outline" type="button" @click="$emit('toggle', item)"><Icon :name="item.enabled ? 'power' : 'check'" :size="13" />{{ item.enabled ? '停用' : '启用' }}</button>
                  <button v-if="item.extensionType === 'skill' && item.remote?.repo" class="btn small outline" type="button" @click="$emit('update-remote', item)"><Icon name="download" :size="13" />更新</button>
                  <button class="btn small warn" type="button" @click="$emit('remove', item)"><Icon name="trash" :size="13" />删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="extension-empty-state">
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
