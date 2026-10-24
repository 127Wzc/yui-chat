import { ref, watch, onUnmounted } from "vue"
import { confirmAction, request, setDirtyScope, toast } from "../../app/store/store.js"
import { errorMessage } from "../../shared/data.js"
type Row = Record<string, any>
export const KnowledgeCommandEditor = {
  name: "KnowledgeCommandEditor", props: { open: Boolean, command: { type: Object, required: true } }, emits: ["close", "changed"],
  setup(props: { open: boolean; command: Row }, { emit }: { emit: (name: string) => void }) {
    const title = ref(""), retrievalText = ref(""), current = ref<Row | null>(null), history = ref<Row[]>([]), revision = ref(""), busy = ref(false), baseline = ref("")
    let requestVersion = 0
    const signature = (): string => JSON.stringify([title.value, retrievalText.value])
    async function refresh(): Promise<void> { const version = ++requestVersion; try { const data = await request(`/api/knowledge/commands/${encodeURIComponent(props.command.id)}/history`) as Row; if (version !== requestVersion || !props.open) return; current.value = data.command; history.value = data.history || []; revision.value = data.revision; title.value = current.value?.title || ""; retrievalText.value = current.value?.retrievalText || ""; baseline.value = signature() } catch (error) { if (version === requestVersion) toast(errorMessage(error)) } }
    async function save(): Promise<void> {
      if (busy.value || !retrievalText.value.trim()) return
      busy.value = true
      try {
        if (props.command.isNew) {
          const bundle = { schemaVersion: 1, sourceId: props.command.sourceId || "yunzai", documents: [{ id: props.command.id, title: title.value, retrievalText: retrievalText.value, metadata: {} }] }
          const preview = await request("/api/knowledge/commands/import-preview", { method: "POST", body: JSON.stringify({ bundle }) }) as Row
          await request("/api/knowledge/commands/import", { method: "POST", body: JSON.stringify({ bundle, options: { expectedRevision: preview.revision } }) })
          baseline.value = signature(); emit("changed"); emit("close")
        } else { await request(`/api/knowledge/commands/${encodeURIComponent(props.command.id)}`, { method: "PUT", body: JSON.stringify({ title: title.value, retrievalText: retrievalText.value, expectedRevision: revision.value }) }); await refresh(); emit("changed") }
        toast("已保存，只有变化分块会更新向量")
      } catch (error) { toast(errorMessage(error)) } finally { busy.value = false }
    }
    async function restore(item: Row): Promise<void> {
      if (busy.value) return
      if (!await confirmAction({ title: "回退到此版本？", message: "将用所选历史替换当前内容，当前版本进入历史；含当前最多保留 3 个版本。未变正文复用向量。", confirmText: "回退" })) return
      busy.value = true
      try { await request(`/api/knowledge/commands/${encodeURIComponent(props.command.id)}/restore`, { method: "POST", body: JSON.stringify({ historyId: item.id, expectedRevision: revision.value }) }); await refresh(); emit("changed"); toast("已恢复所选版本") } catch (error) { toast(errorMessage(error)) } finally { busy.value = false }
    }
    async function close(): Promise<void> { if (busy.value) return; if (signature() !== baseline.value && !await confirmAction({ title: "放弃未保存的内容？", message: "当前编辑尚未保存。", confirmText: "放弃修改" })) return; emit("close") }
    watch(() => [props.open, props.command.id], () => { requestVersion++; if (!props.open) { setDirtyScope("knowledge-command-editor", false); return } history.value = []; current.value = null; title.value = ""; retrievalText.value = ""; baseline.value = signature(); if (!props.command.isNew) void refresh() }, { immediate: true })
    watch(() => [props.open, signature(), baseline.value], () => setDirtyScope("knowledge-command-editor", props.open && signature() !== baseline.value))
    onUnmounted(() => { requestVersion++; setDirtyScope("knowledge-command-editor", false) })
    return { title, retrievalText, current, history, busy, save, restore, close }
  },
  template: `<SideDrawer :open="open" title="指令知识与历史" subtitle="优先在外部整理后导入；手动编辑与回退也会记录变更。" width="760px" @close="close"><p class="muted tiny">永久 ID：{{command.id}} · 来源：{{current?.sourceId || command.sourceId || '已删除'}}</p><template v-if="current || command.isNew"><Field label="标题" v-model="title" :disabled="busy"/><Field label="检索正文 retrievalText" type="textarea" :rows="12" v-model="retrievalText" :disabled="busy"/><details v-if="current"><summary>采集元数据（只读）</summary><pre class="command-retrieval-text">{{JSON.stringify(current.metadata,null,2)}}</pre></details></template><p v-else class="muted">此条目已删除，可选择保留的历史版本恢复。</p><details v-for="item in history" :key="item.id"><summary>{{new Date(item.created_at).toLocaleString()}} · {{item.operation}}</summary><pre class="command-retrieval-text">{{item.snapshot.document.retrievalText}}</pre><button class="btn small outline" :disabled="busy" @click="restore(item)">回退到此版本</button></details><template #actions><button class="btn outline" :disabled="busy" @click="close">关闭</button><button v-if="current || command.isNew" class="btn primary" :disabled="busy || !retrievalText.trim()" @click="save">保存</button></template></SideDrawer>`,
}
