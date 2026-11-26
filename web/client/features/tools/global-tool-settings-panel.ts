import { reactive, computed, onBeforeUnmount, ref, watch } from "vue"
import { confirmAction, store, toast, saveConfigPatch, setDirtyScope } from "../../app/store/store.js"
import { asRecord, changedConfigPatch, errorMessage, sameJsonValue } from "../../shared/data.js"
import { BOOL_OPTIONS, integerValue, type ToolConfigRoot } from "./shared.js"

// 真正跨工具生效的设置：执行预算、工具总开关和安全兜底只在这里出现一次。
export const GlobalToolSettingsPanel = {
  name: "GlobalToolSettingsPanel",
  props: { open: Boolean },
  emits: ["close"],
  setup(props: { open: boolean }, { emit }: { emit: (event: string) => void }) {
    const saving = ref(false)
    const draft = reactive({
      toolsEnabled: "true",
      allowExternalNetwork: "true",
      allowCustomTools: "true",
      allowMcpTools: "true",
      openaiHostedTools: "true",
      openaiFileSearch: "true",
      maxToolRounds: 3,
      maxToolCalls: 20,
      maxSideEffectCalls: 20,
      maxConsecutiveGuardBlocks: 2,
      maxNoProgress: 3,
      defaultMaxAttempts: 2,
      backgroundEnabled: "true",
      backgroundConcurrent: 4,
      backgroundQueue: 50,
      backgroundRetentionHours: 24,
      promptSelectionEnabled: "true",
      promptSelectionMaxTools: 12,
      promptSelectionMaxDefinitionTokens: 1200,
    })

    let baseline: Record<string, unknown> = {}
    function syncDraft(force = true) {
      const config = asRecord<ToolConfigRoot>(store.config)
      const policy = config.tools?.policy || {}
      const promptSelection = config.tools?.promptSelection || {}
      const openaiHosted = config.tools?.hosted?.openai || {}
      const execution = asRecord(config.chat?.execution)
      const next = {
        toolsEnabled: String(config.tools?.enabled !== false),
        allowExternalNetwork: String(policy.allowExternalNetwork !== false),
        allowCustomTools: String(policy.allowCustomTools !== false),
        allowMcpTools: String(policy.allowMcpTools !== false),
        openaiHostedTools: String(openaiHosted.enabled !== false),
        openaiFileSearch: String(openaiHosted.fileSearch?.enabled !== false),
        maxToolRounds: config.chat?.maxToolRounds ?? 3,
        maxToolCalls: Number(execution.maxToolCalls ?? 20),
        maxSideEffectCalls: Number(execution.maxSideEffectCalls ?? 20),
        maxConsecutiveGuardBlocks: Number(execution.maxConsecutiveGuardBlocks ?? 2),
        maxNoProgress: Number(execution.maxNoProgress ?? 3),
        defaultMaxAttempts: Number(execution.defaultMaxAttempts ?? 2),
        backgroundEnabled: String(asRecord(execution.background).enabled !== false),
        backgroundConcurrent: Number(asRecord(execution.background).maxConcurrent ?? 4),
        backgroundQueue: Number(asRecord(execution.background).maxQueue ?? 50),
        backgroundRetentionHours: Number(asRecord(execution.background).retentionMs ?? 86400000) / 3600000,
        promptSelectionEnabled: String(promptSelection.enabled !== false),
        promptSelectionMaxTools: promptSelection.maxTools ?? 12,
        promptSelectionMaxDefinitionTokens: promptSelection.maxDefinitionTokens ?? 1200,
      }
      for (const [key, value] of Object.entries(next)) if (force || sameJsonValue(asRecord(draft)[key], baseline[key])) Object.assign(draft, { [key]: value })
      baseline = next
    }
    syncDraft()
    watch(() => store.config, () => syncDraft(false))

    const isDirty = () => Object.keys(draft).some(key => !sameJsonValue(asRecord(draft)[key], baseline[key]))
    watch(() => [props.open, JSON.stringify(draft)], () => setDirtyScope("global-tool-settings", props.open && isDirty()))
    onBeforeUnmount(() => setDirtyScope("global-tool-settings", false))
    async function close() {
      if (saving.value) return
      if (isDirty() && !await confirmAction({ title: "放弃全局工具设置修改？", message: "这些修改尚未保存。", confirmText: "放弃修改", tone: "warn" })) return
      syncDraft(); setDirtyScope("global-tool-settings", false); emit("close")
    }

    const pills = computed(() => [
      { label: draft.toolsEnabled === "true" ? "工具调用开" : "工具调用关", active: draft.toolsEnabled === "true" },
      { label: draft.allowExternalNetwork === "true" ? "外网允许" : "外网拦截", active: draft.allowExternalNetwork === "true" },
      { label: draft.allowMcpTools === "true" ? "MCP 来源允许" : "MCP 来源拦截", active: draft.allowMcpTools === "true" },
      { label: draft.openaiHostedTools === "true" ? "OpenAI 托管工具开" : "OpenAI 托管工具关", active: draft.openaiHostedTools === "true" },
      { label: `最多 ${draft.maxToolRounds} 轮`, tone: "accent" },
    ])

    async function save() {
      if (saving.value || !isDirty()) return
      saving.value = true
      try {
        const patch = changedConfigPatch({
          "tools.enabled": draft.toolsEnabled === "true",
          "tools.policy.allowExternalNetwork": draft.allowExternalNetwork === "true",
          "tools.policy.allowCustomTools": draft.allowCustomTools === "true",
          "tools.policy.allowMcpTools": draft.allowMcpTools === "true",
          "tools.hosted.openai.enabled": draft.openaiHostedTools === "true",
          "tools.hosted.openai.fileSearch.enabled": draft.openaiFileSearch === "true",
          "chat.maxToolRounds": integerValue(draft.maxToolRounds, 3, 0, 100),
          "chat.execution.maxToolCalls": integerValue(draft.maxToolCalls, 20, 1, 1000),
          "chat.execution.maxSideEffectCalls": integerValue(draft.maxSideEffectCalls, 20, 1, 1000),
          "chat.execution.maxConsecutiveGuardBlocks": integerValue(draft.maxConsecutiveGuardBlocks, 2, 1, 20),
          "chat.execution.maxNoProgress": integerValue(draft.maxNoProgress, 3, 1, 20),
          "chat.execution.background.enabled": draft.backgroundEnabled === "true",
          "chat.execution.background.maxConcurrent": integerValue(draft.backgroundConcurrent, 4, 1, 32),
          "chat.execution.background.maxQueue": integerValue(draft.backgroundQueue, 50, 1, 1000),
          "chat.execution.background.retentionMs": integerValue(Number(draft.backgroundRetentionHours) * 3600000, 86400000, 60000, 604800000),
          "chat.execution.defaultMaxAttempts": integerValue(draft.defaultMaxAttempts, 2, 1, 5),
          "tools.promptSelection.enabled": draft.promptSelectionEnabled === "true",
          "tools.promptSelection.maxTools": integerValue(draft.promptSelectionMaxTools, 12, 1, 100),
          "tools.promptSelection.maxDefinitionTokens": integerValue(draft.promptSelectionMaxDefinitionTokens, 1200, 100, 100000),
        }, store.config)
        const visibilityChanges = Object.entries(patch).filter(([path]) => path === "tools.enabled" || path.startsWith("tools.policy.") || path.startsWith("tools.hosted."))
        if (visibilityChanges.some(([, value]) => value === false)) {
          const accepted = await confirmAction({ title: "保存全局工具限制？", message: "关闭总开关或来源开关后，相关工具会立即从模型可用工具中移除。", confirmText: "确认保存限制", tone: "warn", icon: "sliders" })
          if (!accepted) return
        }
        await saveConfigPatch(patch, "global-tools", visibilityChanges.length ? ["tools"] : [])
        syncDraft()
        setDirtyScope("global-tool-settings", false)
        emit("close")
      } catch (err) { toast(errorMessage(err)) }
      finally { saving.value = false }
    }
    return { saving, isDirty, draft, pills, save, close, BOOL_OPTIONS }
  },
  template: `
    <SideDrawer :open="open" title="全局工具设置" subtitle="所有工具共享的总开关、执行预算和安全边界。" icon="gear" width="900px" :modal="true" @close="close">
      <fieldset :disabled="saving" class="behavior-form">
      <PillList :items="pills" />
      <p class="muted small">这里只放所有工具共享的执行边界和安全总开关。网页读取、定时任务等具体参数请在内置能力对应分类旁设置；密钥和超时等工具运行变量请在列表行内配置。</p>
      <div class="capability-settings-section">
        <div class="capability-settings-section-head"><Icon name="power" :size="15" /><strong>工具系统与来源开关</strong><span>全局安全底线</span></div>
        <div class="form-grid">
          <Field label="启用工具调用" type="select" :options="BOOL_OPTIONS" v-model="draft.toolsEnabled" tip="关闭后所有工具都会从模型请求中移除。" />
          <Field label="允许外部网络工具" type="select" :options="BOOL_OPTIONS" v-model="draft.allowExternalNetwork" tip="关闭后联网工具不可用；具体工具仍需通过权限检查。" />
          <Field label="允许自定义工具" type="select" :options="BOOL_OPTIONS" v-model="draft.allowCustomTools" />
          <Field label="允许 MCP 来源（安全底线）" type="select" :options="BOOL_OPTIONS" v-model="draft.allowMcpTools" tip="这是全局安全底线；MCP 分类页的总开关另负责连接和加载服务。" />
        </div>
      </div>
      <div class="capability-settings-section">
        <div class="capability-settings-section-head"><Icon name="sparkles" :size="15" /><strong>OpenAI 托管工具</strong><span>Responses API 全局上限</span></div>
        <div class="form-grid">
          <Field label="允许 OpenAI 托管工具" type="select" :options="BOOL_OPTIONS" v-model="draft.openaiHostedTools" tip="关闭后所有 Responses 模型都不会收到 OpenAI 内置工具。" />
          <Field v-if="draft.openaiHostedTools === 'true'" label="允许 File Search" type="select" :options="BOOL_OPTIONS" v-model="draft.openaiFileSearch" tip="模型仍需配置有效的 Vector Store IDs。" />
          <p class="muted small">Web Search 与 Tool Search 的托管实现已合并到对应能力的“配置”抽屉中，和本地渠道一起管理。</p>
        </div>
      </div>
      <details class="capability-settings-section">
        <summary><strong>后台队列默认设置</strong><span class="muted small">按需展开 · 各队列共享的默认值</span></summary>
        <Field label="允许后台工具执行" type="select" :options="BOOL_OPTIONS" v-model="draft.backgroundEnabled" />
        <div v-if="draft.backgroundEnabled === 'true'" class="form-grid">
          <Field label="每个队列最多同时执行" type="number" v-model="draft.backgroundConcurrent" tip="默认 4。是每个队列的默认值，不是整个插件的总并发上限；生图等专属队列使用自身设置。" />
          <Field label="每个队列最多等待" type="number" v-model="draft.backgroundQueue" tip="默认 50。队列满时不接受新的任务。" />
          <Field label="完成状态保留时长（小时）" type="number" v-model="draft.backgroundRetentionHours" tip="默认 24 小时；不控制聊天历史的保留时长。" />
        </div>
      </details>
      <details class="capability-settings-section">
        <summary><strong>执行链路预算</strong><span class="muted small">按需展开 · 所有工具共同遵守</span></summary>
        <div class="form-grid">
          <Field label="最大工具轮次" type="number" v-model="draft.maxToolRounds" tip="一次对话最多进行多少轮“模型 → 工具 → 模型”。设为 0 表示不进入工具轮次。" />
          <Field label="单次最多工具调用" type="number" v-model="draft.maxToolCalls" />
          <Field label="单次最多副作用调用" type="number" v-model="draft.maxSideEffectCalls" tip="戳一戳、发消息、群管理等有外部副作用的调用总预算。" />
          <Field label="连续保护拦截上限" type="number" v-model="draft.maxConsecutiveGuardBlocks" />
          <Field label="无进展轮次上限" type="number" v-model="draft.maxNoProgress" />
          <Field label="执行器回退尝试次数" type="number" v-model="draft.defaultMaxAttempts" tip="包含首次执行；仅作为执行器回退值，工具本身声明的尝试次数优先。" />
        </div>
      </details>
      <details class="capability-settings-section">
        <summary><strong>工具提示词装载</strong><span class="muted small">按需展开</span></summary>
        <div class="form-grid">
          <Field label="启用渐进式装载" type="select" :options="BOOL_OPTIONS" v-model="draft.promptSelectionEnabled" tip="开启后会按提示词和预算筛选工具，工具仍会经过权限校验。" />
          <Field v-if="draft.promptSelectionEnabled === 'true'" label="最多装载工具数" type="number" v-model="draft.promptSelectionMaxTools" />
          <Field v-if="draft.promptSelectionEnabled === 'true'" label="工具定义 Token 预算" type="number" v-model="draft.promptSelectionMaxDefinitionTokens" />
        </div>
      </details>
      </fieldset>
      <template #actions>
        <button class="btn outline" type="button" :disabled="saving" @click="close"><Icon name="x" :size="14" />关闭</button>
        <button class="btn primary small" type="button" :disabled="saving || !isDirty()" @click="save"><Icon name="save" :size="14" />保存全局设置</button>
      </template>
    </SideDrawer>
  `,
}
