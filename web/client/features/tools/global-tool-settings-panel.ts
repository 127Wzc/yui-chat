import { reactive, computed, watch } from "vue"
import { confirmAction, store, toast, saveConfigPatch } from "../../app/store/store.js"
import { asRecord, errorMessage } from "../../shared/data.js"
import { BOOL_OPTIONS, integerValue, type ToolConfigRoot } from "./shared.js"

// 真正跨工具生效的设置：执行预算、工具总开关和安全兜底只在这里出现一次。
export const GlobalToolSettingsPanel = {
  name: "GlobalToolSettingsPanel",
  props: { open: Boolean },
  emits: ["close"],
  setup(_: { open: boolean }, { emit }: { emit: (event: string) => void }) {
    const draft = reactive({
      toolsEnabled: "true",
      allowExternalNetwork: "true",
      allowCustomTools: "true",
      allowMcpTools: "true",
      maxToolRounds: 3,
      maxToolCalls: 20,
      maxSideEffectCalls: 20,
      maxConsecutiveGuardBlocks: 2,
      maxNoProgress: 3,
      defaultMaxAttempts: 2,
      promptSelectionEnabled: "true",
      promptSelectionMaxTools: 12,
      promptSelectionMaxDefinitionTokens: 1200,
    })

    function syncDraft() {
      const config = asRecord<ToolConfigRoot>(store.config)
      const policy = config.tools?.policy || {}
      const promptSelection = config.tools?.promptSelection || {}
      const execution = asRecord(config.chat?.execution)
      Object.assign(draft, {
        toolsEnabled: String(config.tools?.enabled !== false),
        allowExternalNetwork: String(policy.allowExternalNetwork !== false),
        allowCustomTools: String(policy.allowCustomTools !== false),
        allowMcpTools: String(policy.allowMcpTools !== false),
        maxToolRounds: config.chat?.maxToolRounds ?? 3,
        maxToolCalls: Number(execution.maxToolCalls ?? 20),
        maxSideEffectCalls: Number(execution.maxSideEffectCalls ?? 20),
        maxConsecutiveGuardBlocks: Number(execution.maxConsecutiveGuardBlocks ?? 2),
        maxNoProgress: Number(execution.maxNoProgress ?? 3),
        defaultMaxAttempts: Number(execution.defaultMaxAttempts ?? 2),
        promptSelectionEnabled: String(promptSelection.enabled !== false),
        promptSelectionMaxTools: promptSelection.maxTools ?? 12,
        promptSelectionMaxDefinitionTokens: promptSelection.maxDefinitionTokens ?? 1200,
      })
    }
    syncDraft()
    watch(() => store.config, syncDraft, { deep: true })

    const pills = computed(() => [
      { label: draft.toolsEnabled === "true" ? "工具调用开" : "工具调用关", active: draft.toolsEnabled === "true" },
      { label: draft.allowExternalNetwork === "true" ? "外网允许" : "外网拦截", active: draft.allowExternalNetwork === "true" },
      { label: draft.allowMcpTools === "true" ? "MCP 来源允许" : "MCP 来源拦截", active: draft.allowMcpTools === "true" },
      { label: `最多 ${draft.maxToolRounds} 轮`, tone: "accent" },
    ])

    async function save() {
      try {
        const disabling = [draft.toolsEnabled, draft.allowExternalNetwork, draft.allowCustomTools, draft.allowMcpTools].includes("false")
        if (disabling) {
          const accepted = await confirmAction({ title: "保存全局工具限制？", message: "关闭总开关或来源开关后，相关工具会立即从模型可用工具中移除。", confirmText: "确认保存限制", tone: "warn", icon: "sliders" })
          if (!accepted) return
        }
        await saveConfigPatch({
          "tools.enabled": draft.toolsEnabled === "true",
          "tools.policy.allowExternalNetwork": draft.allowExternalNetwork === "true",
          "tools.policy.allowCustomTools": draft.allowCustomTools === "true",
          "tools.policy.allowMcpTools": draft.allowMcpTools === "true",
          "chat.maxToolRounds": integerValue(draft.maxToolRounds, 3, 0, 100),
          "chat.execution.maxToolCalls": integerValue(draft.maxToolCalls, 20, 1, 1000),
          "chat.execution.maxSideEffectCalls": integerValue(draft.maxSideEffectCalls, 20, 1, 1000),
          "chat.execution.maxConsecutiveGuardBlocks": integerValue(draft.maxConsecutiveGuardBlocks, 2, 1, 20),
          "chat.execution.maxNoProgress": integerValue(draft.maxNoProgress, 3, 1, 20),
          "chat.execution.defaultMaxAttempts": integerValue(draft.defaultMaxAttempts, 2, 1, 5),
          "tools.promptSelection.enabled": draft.promptSelectionEnabled === "true",
          "tools.promptSelection.maxTools": integerValue(draft.promptSelectionMaxTools, 12, 1, 100),
          "tools.promptSelection.maxDefinitionTokens": integerValue(draft.promptSelectionMaxDefinitionTokens, 1200, 100, 100000),
        })
        syncDraft()
        emit("close")
      } catch (err) { toast(errorMessage(err)) }
    }
    return { draft, pills, save, BOOL_OPTIONS }
  },
  template: `
    <SideDrawer :open="open" title="全局工具设置" subtitle="所有工具共享的总开关、执行预算和安全边界。" icon="gear" width="720px" @close="$emit('close')">
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
        <div class="capability-settings-section-head"><Icon name="activity" :size="15" /><strong>执行链路预算</strong><span>防止循环和无界重试</span></div>
        <div class="form-grid">
          <Field label="最大工具轮次" type="number" v-model="draft.maxToolRounds" tip="一次对话最多进行多少轮“模型 → 工具 → 模型”。设为 0 表示不进入工具轮次。" />
          <Field label="单次最多工具调用" type="number" v-model="draft.maxToolCalls" />
          <Field label="单次最多副作用调用" type="number" v-model="draft.maxSideEffectCalls" tip="戳一戳、发消息、群管理等有外部副作用的调用总预算。" />
          <Field label="连续保护拦截上限" type="number" v-model="draft.maxConsecutiveGuardBlocks" />
          <Field label="无进展轮次上限" type="number" v-model="draft.maxNoProgress" />
          <Field label="只读工具默认重试次数" type="number" v-model="draft.defaultMaxAttempts" />
        </div>
      </div>
      <div class="capability-settings-section">
        <div class="capability-settings-section-head"><Icon name="list" :size="15" /><strong>工具提示词装载</strong><span>控制模型每次看到多少工具定义</span></div>
        <div class="form-grid">
          <Field label="启用渐进式装载" type="select" :options="BOOL_OPTIONS" v-model="draft.promptSelectionEnabled" tip="开启后会按提示词和预算筛选工具，工具仍会经过权限校验。" />
          <Field label="最多装载工具数" type="number" v-model="draft.promptSelectionMaxTools" />
          <Field label="工具定义 Token 预算" type="number" v-model="draft.promptSelectionMaxDefinitionTokens" />
        </div>
      </div>
      <template #actions>
        <button class="btn outline" type="button" @click="$emit('close')"><Icon name="x" :size="14" />关闭</button>
        <button class="btn primary small" type="button" @click="save"><Icon name="save" :size="14" />保存全局设置</button>
      </template>
    </SideDrawer>
  `,
}
