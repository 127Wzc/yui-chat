import { computed, onMounted, ref } from "vue"
import { confirmAction, request, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"

interface Artifact extends UnknownRecord {
  id: string
  title: string
  source: string
  kind: string
  userId: string
  groupId: string
  sessionId: string
  runId: string
  createdAt: number
  expiresAt: number
  bytes: number
  useCount?: number
  value?: unknown
  uses?: Array<{ tool?: string; runId?: string; at?: number }>
}

interface MemoryRecord extends UnknownRecord {
  id: string
  userId: string
  groupId: string
  scope: string
  type: string
  text: string
}

export const ArtifactPanel = {
  name: "ArtifactPanel",
  emits: ["open-run"],
  setup(_props: unknown, { emit }: { emit: (event: "open-run", runId: string) => void }) {
    const items = ref<Artifact[]>([])
    const query = ref("")
    const loading = ref(false)
    const selected = ref<Artifact | null>(null)
    const memoryRecords = ref<MemoryRecord[]>([])
    const memoryLoading = ref(false)
    const memoryError = ref("")
    const filtered = computed(() => {
      const term = query.value.trim().toLowerCase()
      return items.value.filter(item => !term || [item.title, item.source, item.userId, item.groupId, item.sessionId, item.id].some(value => String(value || "").toLowerCase().includes(term)))
    })
    async function refresh() {
      loading.value = true
      try { items.value = asRecords<Artifact>(asRecord(await request("/api/artifacts")).items) }
      catch (error) { toast(errorMessage(error)) }
      finally { loading.value = false }
    }
    async function show(item: Artifact) {
      try {
        const detail = asRecord<Artifact>(asRecord(await request(`/api/artifacts/${encodeURIComponent(item.id)}`)).item)
        selected.value = detail
        memoryRecords.value = []
        memoryError.value = ""
        if (detail.kind === "memory") void loadMemory(detail)
      }
      catch (error) { toast(errorMessage(error)); await refresh() }
    }
    async function loadMemory(item: Artifact) {
      memoryLoading.value = true
      memoryError.value = ""
      try {
        const result = await request(`/api/artifacts/${encodeURIComponent(item.id)}/memory`)
        if (selected.value?.id === item.id) memoryRecords.value = asRecords<MemoryRecord>(result.items)
      } catch (error) {
        if (selected.value?.id === item.id) memoryError.value = errorMessage(error)
      } finally {
        if (selected.value?.id === item.id) memoryLoading.value = false
      }
    }
    async function copy(item: Artifact) {
      try { await navigator.clipboard.writeText(item.id); toast("已复制资料引用", "success") }
      catch { toast("无法访问剪贴板，请手动复制引用") }
    }
    async function remove(item: Artifact) {
      const accepted = await confirmAction({ title: "删除这份参考资料？", message: item.title, detail: "后续对话将不能再使用此引用；已提交的后台任务和原始记忆不受影响。", confirmText: "删除", tone: "danger", icon: "trash" })
      if (!accepted) return
      try {
        await request(`/api/artifacts/${encodeURIComponent(item.id)}/delete`, { method: "POST" })
        if (selected.value?.id === item.id) selected.value = null
        toast("参考资料已删除", "success")
        await refresh()
      } catch (error) { toast(errorMessage(error)) }
    }
    async function clear() {
      const accepted = await confirmAction({ title: "清空全部参考资料？", message: `将清除当前 ${items.value.length} 份临时资料。`, detail: "不会删除原始记忆、搜索记录或已提交的后台任务。", confirmText: "清空资料", tone: "danger", icon: "trash" })
      if (!accepted) return
      try {
        await request("/api/artifacts/clear", { method: "POST", body: JSON.stringify({ all: true }) })
        selected.value = null
        toast("参考资料已清空", "success")
        await refresh()
      } catch (error) { toast(errorMessage(error)) }
    }
    function openRun(id: unknown) {
      const runId = String(id || "")
      if (!runId) return
      selected.value = null
      emit("open-run", runId)
    }
    const time = (value: unknown) => Number(value) ? new Date(Number(value)).toLocaleString("zh-CN") : "-"
    const content = computed(() => selected.value ? JSON.stringify(selected.value.value, null, 2) : "")
    const sources = computed(() => asRecords(asRecord(selected.value?.value).results))
    const digest = computed(() => String(asRecord(selected.value?.value).hostedDigest || ""))
    const memoryScope = computed(() => {
      const value = asRecord(selected.value?.value)
      if (value.scope === "self") return (typeof value.referenceGroupId === "string" ? value.referenceGroupId : selected.value?.groupId) ? "本人的全局及当前群记忆" : "本人的全局记忆"
      if (value.scope === "user") return `成员 ${String(value.userId || "")} 的记忆`
      if (value.scope === "users") return `成员 ${Array.isArray(value.userIds) ? value.userIds.join("、") : ""} 的记忆`
      if (value.scope === "group") return "本群成员的记忆"
      return value.scope === "all" ? "全部用户的记忆" : "未识别的记忆范围"
    })
    function memoryLocation(item: MemoryRecord): string {
      if (item.scope !== "user_group") return "全局记忆"
      const value = asRecord(selected.value?.value)
      const groupId = typeof value.referenceGroupId === "string" ? value.referenceGroupId : selected.value?.groupId
      if (item.groupId && item.groupId === groupId) return "本群记忆"
      return item.groupId ? `群 ${item.groupId} 的记忆` : "群聊记忆"
    }
    onMounted(() => { void refresh() })
    return { items, query, loading, selected, filtered, content, sources, digest, memoryScope, memoryLocation, memoryRecords, memoryLoading, memoryError, time, refresh, show, loadMemory, copy, remove, clear, openRun }
  },
  template: `
    <Panel title="中间产物" icon="file">
      <template #actions><button class="btn small outline" type="button" :disabled="loading" @click="refresh">刷新</button><button class="btn small outline" type="button" :disabled="!items.length" @click="clear">清空</button></template>
      <p class="muted small">参考资料按用户、群和渠道隔离，默认生成 30 天后失效；结束对话、重启或缓存淘汰时也会清理。</p>
      <Field v-model="query" label="筛选资料" placeholder="标题、来源、用户、群或会话" />
      <div class="table-wrap"><table class="data-table"><thead><tr><th>资料</th><th>来源</th><th>用户 / 群</th><th>创建时间</th><th>操作</th></tr></thead><tbody>
        <tr v-for="item in filtered.slice(0, 100)" :key="item.id"><td><div class="cell-title">{{ item.title }}</div><span class="muted tiny" :title="item.id">{{ item.id.slice(0, 12) }}…</span></td><td>{{ item.source }}<small v-if="item.useCount" class="table-subvalue">已使用 {{ item.useCount }} 次</small></td><td class="muted tiny">{{ item.userId || '-' }}<span v-if="item.groupId"> / {{ item.groupId }}</span></td><td class="muted tiny">{{ time(item.createdAt) }}</td><td><button class="btn small outline" type="button" @click="show(item)">查看</button> <button class="btn small outline" type="button" @click="copy(item)">复制引用</button> <button class="btn small outline" type="button" @click="remove(item)">删除</button></td></tr>
      </tbody></table><div v-if="!filtered.length" class="logs-empty compact">{{ loading ? '正在加载…' : '没有匹配的参考资料' }}</div></div>
      <p v-if="filtered.length > 100" class="muted tiny">显示前 100 条，请使用筛选查找其他资料。</p>
    </Panel>
    <SideDrawer :open="!!selected" title="参考资料详情" subtitle="查看内容、来源和使用记录" icon="file" width="720px" @close="selected = null">
      <div v-if="selected" class="artifact-detail">
        <header class="artifact-detail-heading">
          <span class="artifact-detail-icon"><Icon :name="selected.kind === 'memory' ? 'database' : 'file'" :size="20" /></span>
          <div><span class="badge">{{ selected.kind === 'memory' ? '记忆引用' : '内容快照' }}</span><h3>{{ selected.title }}</h3><p>{{ selected.source }} · 创建于 {{ time(selected.createdAt) }}</p></div>
        </header>
        <dl class="artifact-detail-meta">
          <div><dt>所属用户</dt><dd>{{ selected.userId || '—' }}<span v-if="selected.groupId"> · 群 {{ selected.groupId }}</span></dd></div>
          <div><dt>失效时间</dt><dd>{{ time(selected.expiresAt) }}</dd></div>
          <div class="artifact-detail-wide"><dt>资料引用</dt><dd class="artifact-id">{{ selected.id }}</dd></div>
          <div class="artifact-detail-wide"><dt>当前会话</dt><dd class="artifact-id">{{ selected.sessionId || '—' }}</dd></div>
        </dl>

        <section v-if="selected.kind === 'memory'" class="artifact-detail-section">
          <div class="artifact-section-heading"><div><h3><Icon name="database" :size="16" />当前有效记忆 <span v-if="!memoryLoading && !memoryError" class="badge">{{ memoryRecords.length }}</span></h3><p>{{ memoryScope }}</p></div><button class="btn small outline" type="button" :disabled="memoryLoading" @click="loadMemory(selected)"><Icon name="refresh" :size="13" />刷新</button></div>
          <p class="artifact-note"><Icon name="info" :size="15" /><span>这里展示当前记忆；使用引用时会重新读取并检查权限，内容可能与之前画图时不同。</span></p>
          <div v-if="memoryLoading" class="drawer-loading" role="status"><span class="spinner"></span>正在读取记忆…</div>
          <div v-else-if="memoryError" class="slice-error-banner" role="alert"><Icon name="alert" :size="16" /><p>{{ memoryError }}</p><button class="btn small outline" type="button" @click="loadMemory(selected)">重试</button></div>
          <PagedList v-else :key="selected.id" :rows="memoryRecords" :page-size="10" label="记忆" list-class="artifact-memory-list" empty="当前范围内没有有效记忆。">
            <template #default="{ item }"><article class="artifact-memory-card"><header><span class="badge">{{ item.type === 'episode' ? '提炼经历' : '个人事实' }}</span><span class="muted tiny">{{ item.userId }} · {{ memoryLocation(item) }}</span></header><p>{{ item.text }}</p></article></template>
          </PagedList>
        </section>
        <section v-else class="artifact-detail-section">
          <div class="artifact-section-heading"><div><h3><Icon name="file" :size="16" />参考内容</h3><p>保存时的完整内容快照</p></div></div>
          <div v-if="sources.length || digest" class="artifact-source-list"><div v-if="digest" class="artifact-source"><b>搜索摘要</b><p>{{ digest }}</p></div><div v-for="(source, index) in sources" :key="index" class="artifact-source"><b>{{ source.title || '未命名来源' }}</b><p v-if="source.content">{{ source.content }}</p><span v-if="source.url" class="muted tiny">{{ source.url }}</span></div></div>
          <pre v-else class="artifact-raw-content">{{ content }}</pre>
          <details v-if="sources.length || digest" class="logs-raw-content"><summary>查看原始结果</summary><pre>{{ content }}</pre></details>
        </section>

        <section class="artifact-detail-section">
          <div class="artifact-section-heading"><div><h3><Icon name="activity" :size="16" />来源与使用</h3><p>查看资料的生成和后续使用链路</p></div><button v-if="selected.runId" class="btn small outline" type="button" @click="openRun(selected.runId)">来源链路</button></div>
          <div v-if="selected.uses?.length" class="artifact-usage-list"><div v-for="(use, index) in selected.uses" :key="index" class="artifact-usage-row"><div><b>{{ use.tool || '工具调用' }}</b><span>{{ time(use.at) }}</span></div><button v-if="use.runId" class="btn small ghost" type="button" @click="openRun(use.runId)">查看链路</button></div></div>
          <p v-else class="muted small">暂时没有使用记录。</p>
        </section>
      </div>
      <template #actions><button v-if="selected" class="btn outline" type="button" @click="copy(selected)"><Icon name="copy" :size="14" />复制引用</button><button v-if="selected" class="btn outline" type="button" @click="remove(selected)"><Icon name="trash" :size="14" />删除</button></template>
    </SideDrawer>
  `,
}
