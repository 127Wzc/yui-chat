import { reactive, computed, watch } from "vue"
import { store, toast, saveConfigPatch } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import {
  BOOL_OPTIONS,
  BUILTIN_CATEGORY_META,
  integerValue,
  isFoldedRenderTool,
  toolCommon,
  toolSource,
  type ToolConfigRoot,
  type ToolGroupMeta,
  type ToolRecord,
  type ToolsSlice,
} from "./shared.js"

interface CategorySummary extends ToolGroupMeta {
  name: string
  enabled: number
  total: number
}

// 内置分类设置：只展示 tools.builtin 下真正属于当前分类的字段；无独立字段的分类不再复制其他页面配置。
export const BuiltinCategorySettingsPanel = {
  name: "BuiltinCategorySettingsPanel",
  props: { selectedCategory: { type: String, default: "all" } },
  emits: ["select-category"],
  setup(props: { selectedCategory: string }, { emit }: { emit: (event: string, payload?: unknown) => void }) {
    const draft = reactive({
      websiteMaxChars: 6000,
      websiteTimeoutMs: 15000,
      commandAllowSend: "true",
      commandRequireMasterForPrivateTarget: "true",
      scheduleMaxPerUser: 1,
      scheduleCronMaxPerUser: 1,
      scheduleMaxDelayMinutes: 43200,
      scheduleCronMinIntervalMinutes: 60,
      groupAdminRequireMaster: "false",
      blockDefaultMinutes: 30,
      blockMaxMinutes: 720,
    })
    const categories = computed<CategorySummary[]>(() => {
      const groups = new Map<string, CategorySummary>()
      for (const tool of asRecords<ToolRecord>(asRecord<ToolsSlice>(store.tools).tools)) {
        if (toolSource(tool) !== "builtin" || isFoldedRenderTool(tool)) continue
        const common = toolCommon(tool)
        const name = String(common.category || "unknown")
        const meta = BUILTIN_CATEGORY_META[name] || { title: common.categoryLabel || name, description: "该分类下的内置能力。", icon: "wrench", order: 99 }
        if (!groups.has(name)) groups.set(name, { name, ...meta, enabled: 0, total: 0 })
        const group = groups.get(name)
        if (!group) continue
        group.total++
        if (tool.enabled) group.enabled++
      }
      return [...groups.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "zh-Hans-CN"))
    })
    const categoryMeta = computed(() => {
      const name = props.selectedCategory
      return name === "all" ? { title: "全部内置能力", description: "先从左侧列表选择一个分类，再在这里调整该分类的专属参数。", icon: "wrench" } : (BUILTIN_CATEGORY_META[name] || categories.value.find(item => item.name === name) || { title: name || "分类设置", description: "该分类下的内置能力。", icon: "wrench" })
    })
    const hasSettings = computed(() => ["network", "command", "schedule", "admin"].includes(props.selectedCategory))

    function syncDraft() {
      const builtin = asRecord<ToolConfigRoot>(store.config).tools?.builtin || {}
      const website = asRecord(builtin.websiteFetch)
      const command = asRecord(builtin.commandHandoff)
      const schedule = asRecord(builtin.scheduleTask)
      const groupAdmin = asRecord(builtin.groupAdmin)
      const blockUser = asRecord(builtin.blockUser)
      Object.assign(draft, {
        websiteMaxChars: Number(website.maxChars ?? 6000),
        websiteTimeoutMs: Number(website.timeoutMs ?? 15000),
        commandAllowSend: String(command.allowSend !== false),
        commandRequireMasterForPrivateTarget: String(command.requireMasterForPrivateTarget !== false),
        scheduleMaxPerUser: Number(schedule.maxPerUser ?? 1),
        scheduleCronMaxPerUser: Number(schedule.cronMaxPerUser ?? 1),
        scheduleMaxDelayMinutes: Number(schedule.maxDelayMinutes ?? 43200),
        scheduleCronMinIntervalMinutes: Number(schedule.cronMinIntervalMinutes ?? 60),
        groupAdminRequireMaster: String(Boolean(groupAdmin.requireMaster)),
        blockDefaultMinutes: Number(blockUser.defaultMinutes ?? 30),
        blockMaxMinutes: Number(blockUser.maxMinutes ?? 720),
      })
    }
    syncDraft()
    watch(() => store.config, syncDraft, { deep: true })

    async function save() {
      try {
        const category = props.selectedCategory
        let patch: UnknownRecord | null = null
        if (category === "network") {
          patch = {
            "tools.builtin.websiteFetch.maxChars": integerValue(draft.websiteMaxChars, 6000, 500, 20000),
            "tools.builtin.websiteFetch.timeoutMs": integerValue(draft.websiteTimeoutMs, 15000, 1000, 120000),
          }
        } else if (category === "command") {
          patch = {
            "tools.builtin.commandHandoff.allowSend": draft.commandAllowSend === "true",
            "tools.builtin.commandHandoff.requireMasterForPrivateTarget": draft.commandRequireMasterForPrivateTarget === "true",
          }
        } else if (category === "schedule") {
          patch = {
            "tools.builtin.scheduleTask.maxPerUser": integerValue(draft.scheduleMaxPerUser, 1, 1, 20),
            "tools.builtin.scheduleTask.cronMaxPerUser": integerValue(draft.scheduleCronMaxPerUser, 1, 1, 20),
            "tools.builtin.scheduleTask.maxDelayMinutes": integerValue(draft.scheduleMaxDelayMinutes, 43200, 1, 43200),
            "tools.builtin.scheduleTask.cronMinIntervalMinutes": integerValue(draft.scheduleCronMinIntervalMinutes, 60, 1, 1440),
          }
        } else if (category === "admin") {
          patch = {
            "tools.builtin.groupAdmin.requireMaster": draft.groupAdminRequireMaster === "true",
            "tools.builtin.blockUser.defaultMinutes": integerValue(draft.blockDefaultMinutes, 30, 1, 720),
            "tools.builtin.blockUser.maxMinutes": integerValue(draft.blockMaxMinutes, 720, 1, 720),
          }
        }
        if (!patch) return
        await saveConfigPatch(patch)
        syncDraft()
      } catch (err) { toast(errorMessage(err)) }
    }
    function selectCategory(value: string) { emit("select-category", value) }
    return { draft, categories, categoryMeta, hasSettings, save, selectCategory, BOOL_OPTIONS }
  },
  template: `
    <Panel title="分类设置" icon="sliders">
      <template #actions>
        <button v-if="hasSettings" class="btn primary small" type="button" @click="save"><Icon name="save" :size="14" />保存分类设置</button>
      </template>
      <div class="capability-settings-category-list">
        <button type="button" :class="{ active: selectedCategory === 'all' }" @click="selectCategory('all')"><Icon name="layers" :size="13" /><span>全部</span></button>
        <button v-for="item in categories" :key="item.name" type="button" :class="{ active: selectedCategory === item.name }" @click="selectCategory(item.name)"><Icon :name="item.icon" :size="13" /><span>{{ item.title }}</span><b>{{ item.enabled }}/{{ item.total }}</b></button>
      </div>
      <div class="capability-settings-heading"><span class="scenario-icon"><Icon :name="categoryMeta.icon" :size="17" /></span><div><strong>{{ categoryMeta.title }}</strong><p>{{ categoryMeta.description }}</p></div></div>
      <template v-if="selectedCategory === 'network'">
        <div class="capability-settings-section"><div class="capability-settings-section-head"><Icon name="globe" :size="15" /><strong>网页读取</strong><span>联网检索专属</span></div><div class="form-grid"><Field label="最大读取字符" type="number" v-model="draft.websiteMaxChars" /><Field label="读取超时（毫秒）" type="number" v-model="draft.websiteTimeoutMs" /></div><p class="muted small">私网与可信 DNS 授权统一在“系统与诊断 → 链接安全”管理。</p></div>
        <div class="capability-settings-inline-note"><Icon name="info" :size="15" /><div><strong>搜索渠道已移到对应能力详情</strong><p>在能力列表打开 <code>image_media</code> 或 <code>web_search</code>，即可集中管理渠道开关、默认来源、失败换源和密钥。</p></div></div>
      </template>
      <template v-else-if="selectedCategory === 'command'">
        <div class="capability-settings-section"><div class="capability-settings-section-head"><Icon name="terminal" :size="15" /><strong>指令转交</strong><span>仅影响 command_handoff</span></div><div class="form-grid"><Field label="允许发送宿主指令" type="select" :options="BOOL_OPTIONS" v-model="draft.commandAllowSend" /><Field label="私聊目标需要主人" type="select" :options="BOOL_OPTIONS" v-model="draft.commandRequireMasterForPrivateTarget" /></div></div>
      </template>
      <template v-else-if="selectedCategory === 'schedule'">
        <div class="capability-settings-section"><div class="capability-settings-section-head"><Icon name="clock" :size="15" /><strong>定时任务限制</strong><span>按用户和周期收敛</span></div><div class="form-grid"><Field label="每人一次性任务上限" type="number" v-model="draft.scheduleMaxPerUser" /><Field label="每人循环任务上限" type="number" v-model="draft.scheduleCronMaxPerUser" /><Field label="一次性任务最长延迟（分钟）" type="number" v-model="draft.scheduleMaxDelayMinutes" /><Field label="循环任务最小间隔（分钟）" type="number" v-model="draft.scheduleCronMinIntervalMinutes" /></div></div>
      </template>
      <template v-else-if="selectedCategory === 'admin'">
        <div class="capability-settings-section"><div class="capability-settings-section-head"><Icon name="shield" :size="15" /><strong>群管理限制</strong><span>高风险能力</span></div><div class="form-grid"><Field label="群管动作额外需要主人" type="select" :options="BOOL_OPTIONS" v-model="draft.groupAdminRequireMaster" /><Field label="拉黑默认时长（分钟）" type="number" v-model="draft.blockDefaultMinutes" /><Field label="拉黑最长时长（分钟）" type="number" v-model="draft.blockMaxMinutes" /></div></div>
      </template>
      <div v-else class="capability-settings-empty"><Icon name="info" :size="17" /><strong>{{ selectedCategory === 'all' ? '选择一个分类查看专属设置' : '此分类没有独立的全局参数' }}</strong><p>{{ selectedCategory === 'all' ? '列表和这里的分类按钮共用选择状态；工具密钥、超时等单工具变量请直接点列表中的“配置”。' : '该分类的行为由工具自身参数、运行变量或“使用权限”控制，不在这里重复一份配置。' }}</p></div>
    </Panel>
  `,
}
