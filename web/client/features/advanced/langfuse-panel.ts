import { computed, onBeforeUnmount, reactive, ref, watch } from "vue"
import { saveConfigPatch, setDirtyScope, store, toast } from "../../app/store/store.js"
import { asRecord, errorMessage, sameJsonValue, type UnknownRecord } from "../../shared/data.js"

export const LangfusePanel = {
  name: "LangfusePanel",
  props: { section: { type: String, default: "connection" } },
  setup(props: { section?: string } = {}) {
    const config = computed(() => asRecord(asRecord(store.config).logging).langfuse as UnknownRecord || {})
    const status = computed(() => asRecord(asRecord(asRecord(store.diagnostics).runtime).langfuse))
    const draft = reactive({ enabled: false, baseUrl: "", environment: "", sampleRate: 0, backgroundSampleRate: 0,
      monthlyUnitLimit: 0, captureContent: false, publicKey: "", secretKey: "" })
    const baseline = reactive({ ...draft })
    const saving = ref(false)
    const fields: Record<string, Array<keyof typeof draft>> = {
      connection: ["enabled", "baseUrl", "environment", "publicKey", "secretKey"],
      sampling: ["sampleRate", "backgroundSampleRate", "monthlyUnitLimit", "captureContent"], status: [],
    }
    const keys = () => fields[props.section || "connection"] || []
    const sectionDirty = (section: string): boolean => fields[section].some(key => !sameJsonValue(draft[key], baseline[key]))
    function sync(section: string): void {
      const current = config.value
      for (const key of fields[section]) {
        const value = key === "publicKey" || key === "secretKey" ? "" : current[key]
        Object.assign(draft, { [key]: value })
        Object.assign(baseline, { [key]: value })
      }
    }
    sync("connection"); sync("sampling")
    const dirty = computed(() => keys().some(key => !sameJsonValue(draft[key], baseline[key])))
    watch(() => sectionDirty("connection") || sectionDirty("sampling"), value => setDirtyScope("system:langfuse", value), { immediate: true })
    watch(config, () => { for (const section of ["connection", "sampling"]) if (!sectionDirty(section)) sync(section) })
    onBeforeUnmount(() => setDirtyScope("system:langfuse", false))
    async function save(): Promise<void> {
      if (saving.value || !dirty.value) return
      const section = props.section || "connection"
      saving.value = true
      try {
        const patch: UnknownRecord = {}
        for (const key of fields[section]) {
          const value = ["sampleRate", "backgroundSampleRate", "monthlyUnitLimit"].includes(key) ? Number(draft[key]) : typeof draft[key] === "string" ? String(draft[key]).trim() : draft[key]
          if ((key === "publicKey" || key === "secretKey") && !value) continue
          patch[`logging.langfuse.${key}`] = value
        }
        await saveConfigPatch(patch, "langfuse")
        sync(section)
        toast("Langfuse 设置已保存", "success")
      } catch (error) { toast(errorMessage(error)) }
      finally { saving.value = false }
    }
    const statusMetrics = computed(() => [
      { label: "本月已预留", value: Number(status.value.reservedUnits || 0).toLocaleString(), icon: "activity", tone: "blue" },
      { label: "等待发送", value: Number(status.value.pending || 0), icon: "clock", tone: "blue" },
      { label: "正在重试", value: Number(status.value.retrying || 0), icon: "refresh", tone: status.value.retrying ? "orange" : "green" },
    ])
    const budgetLimit = computed(() => Number(status.value.monthlyUnitLimit ?? config.value.monthlyUnitLimit) || 0)
    const budgetPercent = computed(() => budgetLimit.value > 0 ? Math.min(100, Math.round(Number(status.value.reservedUnits || 0) / budgetLimit.value * 100)) : 0)
    return { config, draft, status, dirty, saving, save, statusMetrics, budgetLimit, budgetPercent }
  },
  template: `
    <section class="langfuse-settings" aria-label="Langfuse 观测">
      <header class="settings-content-head">
        <div><div class="eyebrow">Langfuse 观测</div><h2>{{ section === 'sampling' ? '采样与额度' : section === 'status' ? '上报状态' : '连接与凭证' }}</h2><p>{{ section === 'sampling' ? '选择采集范围，控制本地上报额度。' : section === 'status' ? '查看本地预算与待发记录，确认上报是否正常。' : '填写服务地址与项目密钥，支持 Cloud 和私有化部署。' }}</p></div>
        <span class="badge" :class="draft.enabled ? 'on' : ''">{{ draft.enabled ? '已启用' : '未启用' }}</span>
      </header>

      <div v-if="section === 'connection'" class="langfuse-section-stack">
        <div class="settings-toggle-item"><div><strong>启用远端上报</strong><small>同一会话持续关联，结束对话后创建新的 Trace。</small></div><Switch tip="启用远端上报" :model-value="draft.enabled" @update:model-value="draft.enabled = $event" /></div>
        <Field v-model="draft.baseUrl" label="服务地址" type="url" placeholder="https://jp.cloud.langfuse.com" description="默认日本 JP；也可填写其他地区或私有部署的服务根地址，支持端口和代理路径。" />
        <div class="langfuse-form-grid">
          <Field v-model="draft.publicKey" label="Public Key" type="password" placeholder="pk-lf-…" :description="config.publicKey ? '已配置，留空保留' : '在该服务的 Langfuse 项目设置中创建项目密钥。'" />
          <Field v-model="draft.secretKey" label="Secret Key" type="password" placeholder="sk-lf-…" :description="config.secretKey ? '已配置，留空保留' : '与 Public Key 配对使用，保存后不回显。'" />
        </div>
        <Collapse title="高级连接设置" hint="环境标识">
          <Field v-model="draft.environment" label="环境标识" description="用于区分 production、test 等运行环境。" />
        </Collapse>
      </div>

      <div v-else-if="section === 'sampling'" class="langfuse-section-stack">
        <div class="langfuse-form-grid">
          <Field v-model="draft.sampleRate" label="对话采样比例" type="number" description="0–1；按整段会话采样，1 表示全部采集。" />
          <Field v-model="draft.backgroundSampleRate" label="独立后台采样比例" type="number" description="0–1；控制记忆整理、索引等独立调用。" />
        </div>
        <div class="langfuse-setting-section">
          <Field v-model="draft.monthlyUnitLimit" label="每月 Units 上限" type="number" description="0–50000；达到后暂停新增记录，按 UTC 自然月重新计算。" />
          <p class="muted small">默认预留 45,000 Units，给后续评分与其他用量留出空间。实际消耗以 Cloud Usage 为准。</p>
        </div>
        <div class="settings-toggle-item"><div><strong>上传输入与输出正文</strong><small>用于排查回答与质量评测；上传前脱敏并限长，图片、Base64 和向量不上传。</small></div><Switch tip="上传输入与输出正文" :model-value="draft.captureContent" @update:model-value="draft.captureContent = $event" /></div>
      </div>

      <div v-else class="langfuse-section-stack">
        <MetricGrid :items="statusMetrics" compact />
        <div class="langfuse-budget">
          <div><strong>{{ status.month || '本月' }}</strong><span>{{ budgetPercent }}% · {{ budgetLimit.toLocaleString() }} Units 上限</span></div>
          <progress :value="budgetPercent" max="100" aria-label="本月已预留额度比例"></progress>
          <p class="muted small">这里只统计本实例的预留额度，云端账单请查看 Cloud Usage。</p>
        </div>
        <p v-if="status.lastError" class="langfuse-status-note warn"><Icon name="alert" :size="16" />{{ status.lastError }}</p>
        <p v-else class="langfuse-status-note"><Icon :name="status.configured ? 'check' : 'info'" :size="16" />{{ status.configured ? '上报已启用，记录约每 5 秒批量发送。' : '完成连接设置并启用后，模型调用会自动上报。' }}</p>
        <Collapse title="更多运行信息" hint="缓冲与采集范围">
          <dl class="langfuse-status-details"><div><dt>待写入缓冲</dt><dd>{{ status.buffered || 0 }}</dd></div><div><dt>本进程已发送</dt><dd>{{ status.sent || 0 }}</dd></div><div><dt>本进程已跳过</dt><dd>{{ status.skipped || 0 }}</dd></div></dl>
          <p class="muted small">只采集实际模型调用。切换模型、历史过期和进程重启继续关联原会话；同一会话有 N 次模型调用时，按 1 + N Units 预留，不含评分。</p>
        </Collapse>
      </div>

      <footer v-if="section !== 'status'" class="langfuse-save-bar"><span class="muted small">{{ dirty ? '有未保存的更改' : '设置已同步' }}</span><button class="btn primary" type="button" :disabled="!dirty || saving" @click="save"><Icon name="save" :size="14" />{{ saving ? '保存中…' : '保存设置' }}</button></footer>
    </section>
  `,
}
