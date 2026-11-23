import { computed, onUnmounted, ref, watch } from "vue"
import { confirmAction, request, setDirtyScope, toast } from "../../app/store/store.js"
import { errorMessage } from "../../shared/data.js"

type Row = Record<string, any>
const base = "/api/knowledge/evaluation"
const clone = (value: any): any => JSON.parse(JSON.stringify(value))
const options = (values: Record<string, string>): Row[] => Object.entries(values).map(([value, label]) => ({ value, label }))
const kinds = { positive: "正例", negative: "无匹配反例", ambiguous: "歧义问法", policy: "权限 / 条件" }
const queryTypes = { exact: "完整指令", paraphrase: "自然问法", typo: "错别字", boundary: "边界问法" }
const actions = { recommend: "推荐指令", "no-match": "不推荐专用指令", clarify: "先澄清问题", "explain-restriction": "说明权限或前置条件" }
const modeNames = { lexical: "仅关键词", hybrid: "混合检索", "hybrid-rerank": "混合 + 重排" }
const modes = Object.keys(modeNames)
const statusNames: Record<string, string> = { queued: "准备中", running: "评测中", completed: "已完成", failed: "未完成", cancelled: "已取消", interrupted: "已中断" }
const lines = (text: string): string[] => text.split("\n").map(s => s.trim()).filter(Boolean)
function download(value: unknown, name: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }))
  const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const KnowledgeEvaluation = {
  name: "KnowledgeEvaluation", props: { open: Boolean }, emits: ["close"],
  setup(props: { open: boolean }, { emit }: { emit: (event: string) => void }) {
    const overview = ref<Row | null>(null), run = ref<Row | null>(null), busy = ref(false), loading = ref(false), loadError = ref("")
    const view = ref("questions"), runId = ref(""), binding = ref("audited"), metricSplit = ref("evaluation")
    const query = ref(""), kind = ref(""), split = ref(""), outcome = ref(""), selectedId = ref("")
    const editor = ref(false), targetEditor = ref(false), caseDraft = ref<Row>({}), targetDraft = ref<Row>({}), checksText = ref(""), conditionsText = ref("")
    const caseRevision = ref(0), targetRevision = ref(0), caseBaseline = ref(""), targetBaseline = ref("")
    const commandQuery = ref(""), commandOptions = ref<Row[]>([]), targetQuery = ref("")
    let disposed = false, overviewVersion = 0, runVersion = 0, commandVersion = 0, polling = false
    const currentDataset = computed<Row>(() => overview.value?.dataset || { cases: [], targets: [] })
    const dataset = computed<Row>(() => view.value === "results" && run.value ? run.value.dataset : currentDataset.value)
    const targets = computed<Row[]>(() => dataset.value.targets || [])
    const targetsById = computed(() => new Map(targets.value.map(t => [t.id, t])))
    const runRecord = computed<Row | undefined>(() => overview.value?.runs.find((r: Row) => r.id === runId.value))
    const sameVersion = computed(() => overview.value?.fingerprint === run.value?.fingerprint)
    const resultsAvailable = computed(() => view.value === "results" || sameVersion.value)
    const activeRun = computed<Row | undefined>(() => overview.value?.runs.find((r: Row) => ["queued", "running"].includes(r.status)))
    const targetOptions = computed(() => currentDataset.value.targets.map((t: Row) => ({ value: t.id, label: t.example, description: t.meaning, meta: t.pluginName || t.selector.pluginKey })))
    const runOptions = computed(() => (overview.value?.runs || []).map((r: Row) => ({ value: r.id, label: `${r.title} · ${statusNames[r.status] || r.status}` })))
    const forbiddenOptions = computed(() => {
      const accepted = new Set((caseDraft.value.expected?.relevantGroups || []).flat())
      return targetOptions.value.map((o: Row) => ({ ...o, disabled: accepted.has(o.value) }))
    })
    function groupTargetOptions(index: number): Row[] {
      const expected = caseDraft.value.expected
      const excluded = new Set([...(expected?.forbiddenTargets || []), ...(expected?.relevantGroups || []).flatMap((g: string[], i: number) => i === index ? [] : g)])
      return targetOptions.value.map((o: Row) => ({ ...o, disabled: excluded.has(o.value) }))
    }
    const targetList = computed<Row[]>(() => currentDataset.value.targets.filter((t: Row) => !targetQuery.value || [t.id, t.example, t.meaning, t.pluginName].join(" ").toLowerCase().includes(targetQuery.value.toLowerCase())))
    const rowMaps = computed(() => Object.fromEntries(modes.map(mode => [mode, new Map((run.value?.modes[mode] || []).map((r: Row) => [r.caseId, r]))])))
    const observed = (c: Row, mode: string): Row | null => resultsAvailable.value ? rowMaps.value[mode]?.get(c.id) as Row || null : null
    const caseTargets = (c: Row): Row[] => (c.expected?.relevantGroups || []).flat().map((id: string) => targetsById.value.get(id)).filter(Boolean)
    const filtered = computed<Row[]>(() => dataset.value.cases.filter((c: Row) => {
      if (kind.value && c.kind !== kind.value || split.value && c.split !== split.value) return false
      if (query.value && ![c.id, c.query, c.family, ...caseTargets(c).map(t => `${t.example} ${t.meaning} ${t.pluginName}`)].join(" ").toLowerCase().includes(query.value.toLowerCase())) return false
      const a = observed(c, "hybrid"), b = observed(c, "hybrid-rerank")
      if (outcome.value === "regression") return c.kind === "positive" && a?.hit && !b?.hit
      if (outcome.value === "gain") return c.kind === "positive" && !a?.hit && b?.hit
      if (outcome.value === "empty") return b?.status === "ok" && !b.results.length
      if (outcome.value === "unrun") return modes.every(m => !observed(c, m))
      return true
    }))
    const selected = computed<Row | undefined>(() => filtered.value.find(c => c.id === selectedId.value) || filtered.value[0])
    const caseSignature = (): string => JSON.stringify([caseDraft.value, checksText.value])
    const targetSignature = (): string => JSON.stringify([targetDraft.value, conditionsText.value])
    const caseDirty = computed(() => editor.value && caseSignature() !== caseBaseline.value)
    const targetDirty = computed(() => targetEditor.value && targetSignature() !== targetBaseline.value)
    watch(caseDirty, v => setDirtyScope("knowledge-evaluation-case", v))
    watch(targetDirty, v => setDirtyScope("knowledge-evaluation-target", v))
    watch(filtered, values => { if (!values.some(c => c.id === selectedId.value)) selectedId.value = values[0]?.id || "" })
    async function loadOverview(): Promise<void> {
      const version = ++overviewVersion
      const data = await request(base) as Row
      if (disposed || version !== overviewVersion) return
      overview.value = data
      if (!runId.value) runId.value = data.runs[0]?.id || ""
    }
    async function loadRun(): Promise<void> {
      const version = ++runVersion, id = runId.value
      if (!id) { run.value = null; return }
      try { const data = await request(`${base}/runs/${encodeURIComponent(id)}?binding=${binding.value}`) as Row; if (!disposed && version === runVersion && id === runId.value) run.value = data }
      catch (error) { if (!disposed && version === runVersion) { run.value = null; toast(errorMessage(error)) } }
    }
    async function refresh(): Promise<void> { loading.value = true; loadError.value = ""; try { await loadOverview(); await loadRun() } catch (error) { if (!disposed) loadError.value = errorMessage(error) } finally { if (!disposed) loading.value = false } }
    watch(() => props.open, open => { if (open) void refresh() }, { immediate: true })
    watch([runId, binding], () => { run.value = null; void loadRun() })
    const timer = setInterval(async () => { if (!props.open || !activeRun.value || polling || disposed) return; polling = true; try { await loadOverview(); await loadRun() } catch { /* 下一次轮询会重试；不启动或重试模型调用。 */ } finally { polling = false } }, 2500)
    onUnmounted(() => { disposed = true; overviewVersion++; runVersion++; commandVersion++; clearInterval(timer); setDirtyScope("knowledge-evaluation-case", false); setDirtyScope("knowledge-evaluation-target", false) })
    async function discard(dirty: boolean): Promise<boolean> { return !dirty || await confirmAction({ title: "放弃未保存的修改？", message: "已保存的题库和历史评测不会改变。", confirmText: "放弃修改" }) }
    async function close(): Promise<void> { if (!busy.value && await discard(caseDirty.value || targetDirty.value)) emit("close") }
    async function closeCase(): Promise<void> { if (!busy.value && await discard(caseDirty.value)) editor.value = false }
    async function closeTarget(): Promise<void> { if (!busy.value && await discard(targetDirty.value)) targetEditor.value = false }
    async function editCase(c?: Row): Promise<void> {
      if (!await discard(caseDirty.value)) return
      caseDraft.value = c ? clone(c) : { family: "manual", kind: "positive", split: "development", queryType: "paraphrase", query: "", context: { role: "member", channel: "group" }, expected: { relevantGroups: [[]], forbiddenTargets: [], action: "recommend", checks: [] } }
      checksText.value = caseDraft.value.expected.checks.join("\n"); caseRevision.value = overview.value?.revision || 0; editor.value = true; caseBaseline.value = caseSignature()
    }
    async function saveCase(): Promise<void> {
      if (busy.value) return
      const c = clone(caseDraft.value)
      c.expected.checks = lines(checksText.value)
      c.expected.relevantGroups = c.expected.relevantGroups.map((group: string[]) => group.filter(Boolean)).filter((group: string[]) => group.length)
      busy.value = true
      try { const saved = await request(`${base}/cases${c.id ? "/" + encodeURIComponent(c.id) : ""}`, { method: c.id ? "PUT" : "POST", body: JSON.stringify({ case: c, expectedRevision: caseRevision.value }) }) as Row; editor.value = false; query.value = ""; kind.value = ""; split.value = ""; outcome.value = ""; selectedId.value = c.id || saved.dataset.cases.at(-1)?.id || ""; await loadOverview(); toast("题目已保存；旧评测保留原快照，新版本需重新评测") }
      catch (error) { toast(errorMessage(error)) } finally { busy.value = false }
    }
    function changeKind(): void {
      const kind = caseDraft.value.kind
      caseDraft.value.expected.action = kind === "negative" ? "no-match" : kind === "ambiguous" ? "clarify" : kind === "policy" ? "explain-restriction" : "recommend"
      if (kind === "negative") caseDraft.value.expected.relevantGroups = []
      else if (!caseDraft.value.expected.relevantGroups.length) caseDraft.value.expected.relevantGroups = [[]]
    }
    async function deleteCase(c: Row): Promise<void> {
      if (busy.value || !await confirmAction({ title: "删除这道题？", message: c.query, detail: "只从当前题库移除，历史评测里的题目和结果继续保留。", confirmText: "删除题目" })) return
      busy.value = true
      try { await request(`${base}/cases/${encodeURIComponent(c.id)}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: overview.value?.revision }) }); await loadOverview(); toast("已从当前题库删除") } catch (error) { toast(errorMessage(error)) } finally { busy.value = false }
    }
    async function editTarget(t?: Row): Promise<void> {
      if (!await discard(targetDirty.value)) return
      targetDraft.value = t ? clone(t) : { example: "", meaning: "", pluginName: "", selector: { pluginKey: "", fnc: "", regexp: "", regexpFlags: "" }, declaredPermission: "unknown", evidence: [] }
      conditionsText.value = (t?.executionConditions || []).join("\n"); targetRevision.value = overview.value?.revision || 0; targetEditor.value = true; targetBaseline.value = targetSignature(); commandOptions.value = []
    }
    async function searchCommands(): Promise<void> { const version = ++commandVersion; try { const data = await request(`${base}/commands?q=${encodeURIComponent(commandQuery.value)}`) as Row; if (!disposed && version === commandVersion) commandOptions.value = data.commands } catch (error) { toast(errorMessage(error)) } }
    async function useCommand(c: Row): Promise<void> { if (!await discard(targetDirty.value)) return; targetDraft.value = { ...clone(c), ...(targetDraft.value.id ? { id: targetDraft.value.id } : {}) }; conditionsText.value = ""; targetBaseline.value = "" }
    async function saveTarget(): Promise<void> {
      if (busy.value) return
      busy.value = true
      const target = { ...clone(targetDraft.value), executionConditions: lines(conditionsText.value) }
      try { const data = await request(`${base}/targets${target.id ? "/" + encodeURIComponent(target.id) : ""}`, { method: target.id ? "PUT" : "POST", body: JSON.stringify({ target, expectedRevision: targetRevision.value }) }) as Row; targetEditor.value = false; if (editor.value) caseRevision.value = data.revision; await loadOverview(); toast("预期目标已保存") } catch (error) { toast(errorMessage(error)) } finally { busy.value = false }
    }
    async function importFile(event: Event, type: string): Promise<void> {
      const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ""
      if (!file) return
      if (file.size > 24 * 1024 * 1024) { toast("文件最多 24 MiB"); return }
      try {
        const data = JSON.parse(await file.text())
        if (type === "dataset") {
          const dataset = data.dataset || data
          if (!await confirmAction({ title: "用导入文件替换当前题库？", message: `文件包含 ${dataset.cases?.length || 0} 道题、${dataset.targets?.length || 0} 个目标。历史评测保留原快照。`, confirmText: "替换当前题库" })) return
          busy.value = true; await request(`${base}/dataset`, { method: "PUT", body: JSON.stringify({ dataset, expectedRevision: overview.value?.revision }) }); await loadOverview()
        } else { busy.value = true; const result = await request(`${base}/runs`, { method: "POST", body: JSON.stringify({ bundle: data }) }) as Row; runId.value = result.id; view.value = "results"; await refresh() }
        toast("导入完成")
      } catch (error) { toast(errorMessage(error)) } finally { busy.value = false }
    }
    async function exportRun(): Promise<void> { try { const data = await request(`${base}/runs/${encodeURIComponent(runId.value)}/export`) as Row; download(data.bundle, "yui-retrieval-evaluation.json") } catch (error) { toast(errorMessage(error)) } }
    async function start(): Promise<void> {
      if (busy.value) return
      busy.value = true
      try {
        const { plan } = await request(`${base}/plan`) as Row
        const accepted = await confirmAction({ title: `开始 ${plan.questions} 道题的三策略评测？`, message: `Embedding：${plan.embedding}；重排：${plan.reranker}。最多 ${plan.maxEmbeddingCalls} 次嵌入和 ${plan.maxRerankCalls} 次重排，可能产生费用。`, detail: `发送到 ${plan.destinations.join("、")}：题库问法和候选指令说明。不发送聊天、个人记忆或配置密钥（密钥仅用于服务鉴权）。使用隔离副本，固定当前题库与配置。`, confirmText: "开始真实评测", tone: "warn" })
        if (!accepted) return
        const result = await request(`${base}/start`, { method: "POST", body: JSON.stringify({ expectedRevision: plan.revision, signature: plan.signature }) }) as Row
        runId.value = result.id; view.value = "results"; await refresh(); toast("评测已启动，可以关闭页面，稍后查看进度")
      } catch (error) { toast(errorMessage(error)) } finally { busy.value = false }
    }
    async function cancel(): Promise<void> { if (!activeRun.value || !await confirmAction({ title: "取消当前评测？", message: "已发生的模型调用仍计入用量，已完成的分组结果会保留。", confirmText: "取消评测" })) return; try { await request(`${base}/runs/${encodeURIComponent(activeRun.value.id)}/cancel`, { method: "POST", body: "{}" }); await refresh() } catch (error) { toast(errorMessage(error)) } }
    const resultLabel = (c: Row, row: Row | null): string => !row ? "未评测" : row.status !== "ok" ? "运行未完成" : c.kind === "positive" ? row.hit ? "目标命中" : "未命中" : c.kind === "negative" ? row.results.length ? "存在误推荐" : "符合无匹配预期" : "需人工核对"
    const correct = (c: Row, row: Row, index: number): boolean => c.expected.relevantGroups.flat().includes(row.matchedIds[index])
    return { overview, run, busy, loading, loadError, view, runId, binding, metricSplit, query, kind, split, outcome, selectedId, filtered, selected, dataset, currentDataset, targetsById, resultsAvailable, runRecord, activeRun, runOptions, forbiddenOptions, groupTargetOptions, targetList, targetQuery, editor, targetEditor, caseDraft, targetDraft, checksText, conditionsText, commandQuery, commandOptions, kinds, actions, queryTypes, modes, modeNames, statusNames, options, observed, caseTargets, close, refresh, editCase, closeCase, saveCase, changeKind, deleteCase, editTarget, closeTarget, saveTarget, searchCommands, useCommand, importFile, exportRun, start, cancel, download, resultLabel, correct,
      percent: (v: unknown) => typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—", milliseconds: (v: unknown) => typeof v === "number" ? `${v.toFixed(1)} ms` : "—", date: (v: string | number) => new Date(v).toLocaleString(),
    }
  },
  template: `
  <SideDrawer :open="open" title="指令检索评测" subtitle="维护题库与预期答案，核对关键词、混合检索和重排的真实结果。" icon="search" width="1380px" @close="close">
    <div class="evaluation-workspace">
      <div class="evaluation-toolbar"><RadioGroup v-model="view" label="评测工作区" :options="[{value:'questions',label:'题库维护'},{value:'results',label:'评测记录'}]"/><div class="row"><button class="btn small outline" :disabled="loading" @click="refresh">刷新</button><button v-if="activeRun" class="btn small danger" @click="cancel">取消评测</button><button class="btn small primary" :disabled="busy || !!activeRun" @click="start">开始三策略评测</button></div></div>
      <p v-if="loadError" class="hint-banner warn">{{loadError}} <button class="btn small outline" @click="refresh">重试</button></p>
      <p v-if="loading && !overview" class="muted">正在读取题库…</p>
      <template v-if="overview">
        <div v-if="activeRun" class="hint-banner"><span>{{statusNames[activeRun.status]}} · {{modeNames[activeRun.progress?.mode] || '固定数据快照'}} · {{activeRun.progress?.completed || 0}} / {{activeRun.progress?.total || currentDataset.cases.length*3}} 条查询。刷新页面不会重复启动。</span></div>
        <div class="evaluation-toolbar" v-if="view==='questions'"><p class="muted small">当前版本 r{{overview.revision}} · {{currentDataset.cases.length}} 道题 · {{currentDataset.targets.length}} 个目标</p><div class="row"><button class="btn small outline" @click="editTarget()">维护预期目标</button><label class="btn small outline">导入题库<input type="file" accept="application/json,.json" hidden @change="importFile($event,'dataset')" :disabled="busy"/></label><button class="btn small outline" @click="download(currentDataset,'yui-retrieval-dataset.json')">导出题库</button><button class="btn small primary" :disabled="busy" @click="editCase()">新增题目</button></div></div>
        <div class="evaluation-toolbar" v-else><Field class="evaluation-run-select" label="评测快照" type="select" v-model="runId" :options="runOptions"/><div class="row"><label class="btn small outline">导入结果<input type="file" accept="application/json,.json" hidden @change="importFile($event,'run')" :disabled="busy"/></label><button class="btn small outline" :disabled="!run" @click="exportRun">导出结果</button></div></div>
        <p v-if="runRecord?.error" class="hint-banner warn">{{runRecord.error}}</p>
        <p v-if="!sameVersion && run && view==='questions'" class="hint-banner warn">当前题库与所选评测版本不同；此处不沿用旧成绩。新增或编辑题目后需重新评测，可在“评测记录”查看旧快照。</p>
        <p v-if="view==='results' && run" class="muted tiny">{{date(run.createdAt)}} · {{run.dataset.cases.length}} 道题的独立快照。历史题目和预期答案只读；修改当前题库不会改写这份成绩。</p>
        <div v-if="view==='results' && run" class="evaluation-summary"><div class="evaluation-toolbar"><strong>三策略对比</strong><div class="evaluation-controls"><Field label="成绩数据范围" type="select" v-model="metricSplit" :options="[{value:'evaluation',label:'固定验收集'},{value:'all',label:'全部样本'},{value:'development',label:'开发集'}]"/><Field label="标识计分口径" type="select" v-model="binding" :options="[{value:'audited',label:'快照标识对齐'},{value:'original',label:'严格原始标识'}]"/></div></div><div class="evaluation-table-wrap"><table><thead><tr><th>方式</th><th>完成查询</th><th>前 {{run.dataset.k}} 条命中率</th><th>首条准确率</th><th>Precision@{{run.dataset.k}}</th><th>首次 P50 / P95</th><th>无匹配误推荐</th></tr></thead><tbody><tr v-for="mode in modes" :key="mode"><td>{{modeNames[mode]}}</td><template v-if="run.metrics[mode]"><td>{{run.metrics[mode][metricSplit].completed}} / {{run.metrics[mode][metricSplit].planned}}</td><td>{{percent(run.metrics[mode][metricSplit].hitAt5)}} <small>({{run.metrics[mode][metricSplit].hits}}/{{run.metrics[mode][metricSplit].positive}})</small></td><td>{{percent(run.metrics[mode][metricSplit].top1)}}</td><td>{{percent(run.metrics[mode][metricSplit].precision)}}</td><td>{{milliseconds(run.metrics[mode][metricSplit].p50)}} / {{milliseconds(run.metrics[mode][metricSplit].p95)}}</td><td>{{run.metrics[mode][metricSplit].falseRecommendations}} / {{run.metrics[mode][metricSplit].negative}}</td></template><td v-else colspan="6">该方式尚未完成</td></tr></tbody></table></div><p class="muted tiny">命中率分母只含正例；缺失或失败正例按未命中计。耗时含实际模型请求，不含最终回答生成。权限和歧义题仅核对候选，不视为执行成功。</p></div>
        <div class="evaluation-console"><aside class="evaluation-sidebar"><SearchInput v-model="query" placeholder="搜索题目、预期指令或插件"/><div class="evaluation-filter-grid"><Field label="样本类别" type="select" v-model="kind" :options="[{value:'',label:'全部类别'},...options(kinds)]"/><Field label="数据划分" type="select" v-model="split" :options="[{value:'',label:'全部划分'},{value:'development',label:'开发集'},{value:'evaluation',label:'验收集'}]"/></div><Field label="评测结果筛选" type="select" v-model="outcome" :options="[{value:'',label:'全部结果'},{value:'regression',label:'重排后丢失命中'},{value:'gain',label:'重排后新增命中'},{value:'empty',label:'重排返回空结果'},{value:'unrun',label:'未评测'}]"/><p class="muted tiny">{{filtered.length}} / {{dataset.cases.length}} 道题</p><div class="evaluation-case-list"><button v-for="c in filtered" :key="c.id" :class="{active:selected?.id===c.id}" @click="selectedId=c.id"><small>{{kinds[c.kind]}} · {{queryTypes[c.queryType]}}</small><strong>{{c.query}}</strong><span>{{c.split==='development'?'开发集':'验收集'}}</span></button><p v-if="!filtered.length" class="muted small">没有匹配题目</p></div></aside>
          <section v-if="selected" class="evaluation-detail"><div class="evaluation-toolbar"><div><p class="muted tiny">{{selected.id}}</p><h3>{{selected.query}}</h3></div><div class="row" v-if="view==='questions'"><button class="btn small outline" :disabled="busy" @click="editCase(selected)">编辑题目</button><button class="btn small danger" :disabled="busy" @click="deleteCase(selected)">删除</button></div></div><p class="muted small">{{selected.context.channel==='group'?'群聊':'私聊'}} · {{({member:"普通成员",groupAdmin:"群管理员",groupOwner:"群主",master:"主人"})[selected.context.role]}} · 预期动作：{{actions[selected.expected.action]}}</p><section class="evaluation-expected"><strong>预期结果</strong><div v-for="(group,i) in selected.expected.relevantGroups" :key="i"><p class="muted tiny">功能组 {{i+1}} · {{group.length>1?'以下任一目标均可接受':'可接受目标'}}</p><article v-for="id in group" :key="id"><code>{{targetsById.get(id)?.example}}</code><p>{{targetsById.get(id)?.meaning}}</p><ul><li v-for="condition in targetsById.get(id)?.executionConditions">{{condition}}</li></ul><details><summary>注册规则与来源</summary><pre>{{JSON.stringify(targetsById.get(id)?.selector,null,2)}}</pre><p v-for="proof in targetsById.get(id)?.evidence" class="muted tiny">{{proof.file}}:{{proof.startLine}}–{{proof.endLine}} · {{proof.claim}}</p></details></article></div><p v-if="!selected.expected.relevantGroups.length" class="muted small">没有预期推荐的专用指令。</p><p class="muted tiny">判定要点</p><ul><li v-for="check in selected.expected.checks">{{check}}</li></ul><p v-if="selected.expected.forbiddenTargets.length" class="muted tiny">标注排除：{{selected.expected.forbiddenTargets.map(id=>targetsById.get(id)?.example || id).join('、')}}</p></section>
            <div class="evaluation-results"><article v-for="mode in modes" :key="mode"><header><strong>{{modeNames[mode]}}</strong><span class="badge" :class="{on:observed(selected,mode)?.hit}">{{resultLabel(selected,observed(selected,mode))}}</span></header><p class="muted tiny" v-if="observed(selected,mode)">首次 {{milliseconds(observed(selected,mode).latencyMs)}} · 缓存 {{milliseconds(observed(selected,mode).warmLatencyMs)}}</p><ol v-if="observed(selected,mode)?.results.length"><li v-for="(item,index) in observed(selected,mode).results.slice(0,dataset.k)" :key="index" :class="{correct:correct(selected,observed(selected,mode),index)}"><code>{{item.suggestedCommand || item.fnc}}</code><small>{{item.pluginKey}} · {{item.fnc}}</small><small v-if="typeof item.rerankScore==='number'">重排分 {{item.rerankScore.toFixed(3)}}</small></li></ol><p v-else class="muted small">{{observed(selected,mode)?'未返回候选':'这份题库尚无对应结果'}}</p></article></div><p class="muted tiny">标绿只代表已标注功能目标命中；角色、日期等参数，以及其他合理等价答案仍需人工核对。</p></section><p v-else class="evaluation-empty muted">没有匹配题目，可以调整筛选或新增题目。</p>
        </div>
      </template>
    </div>
    <SideDrawer :open="editor" :title="caseDraft.id?'编辑评测题目':'新增评测题目'" subtitle="修改当前题库；已有评测保留当时的问法和预期答案。" width="780px" @close="closeCase"><template v-if="editor"><fieldset :disabled="busy" class="evaluation-form-fieldset"><Field label="用户问法" type="textarea" :rows="3" v-model="caseDraft.query"/><div class="form-grid"><Field label="样本类别" type="select" :options="options(kinds)" v-model="caseDraft.kind" @update:model-value="changeKind"/><Field label="问法类型" type="select" :options="options(queryTypes)" v-model="caseDraft.queryType"/><Field label="数据划分" type="select" :options="[{value:'development',label:'开发集'},{value:'evaluation',label:'固定验收集'}]" v-model="caseDraft.split"/><Field label="功能分组" v-model="caseDraft.family"/><Field label="提问角色" type="select" :options="[{value:'member',label:'普通成员'},{value:'groupAdmin',label:'群管理员'},{value:'groupOwner',label:'群主'},{value:'master',label:'主人'}]" v-model="caseDraft.context.role"/><Field label="对话场景" type="select" :options="[{value:'group',label:'群聊'},{value:'private',label:'私聊'}]" v-model="caseDraft.context.channel"/></div><Field label="预期动作" type="select" :options="options(actions)" v-model="caseDraft.expected.action"/><section class="evaluation-editor-groups"><div class="evaluation-toolbar"><strong>可接受的预期目标</strong><button class="btn small outline" @click="editTarget()">新增或维护目标</button></div><p class="muted tiny">同一组内是等价答案；多组表示需要覆盖多个功能。无匹配反例不选择目标。</p><div v-for="(group,i) in caseDraft.expected.relevantGroups" :key="i" class="evaluation-edit-group"><SearchMultiSelect :label="'功能组 ' + (i+1) + ' · 等价答案'" v-model="caseDraft.expected.relevantGroups[i]" :options="groupTargetOptions(i)" :disabled="busy" empty-label="选择可接受的指令目标" placeholder="搜索指令、用途或插件" empty-text="没有匹配的指令目标"/><button class="btn small ghost" type="button" :disabled="busy" @click="caseDraft.expected.relevantGroups.splice(i,1)">删除本组</button></div><button v-if="caseDraft.kind!=='negative'" class="btn small outline" type="button" :disabled="busy" @click="caseDraft.expected.relevantGroups.push([])">添加功能组</button></section><Field label="判定要点 / 预期回答说明" type="textarea" :rows="4" v-model="checksText" hint="每行一项，例如应提示主人权限、不能承诺已执行。"/><SearchMultiSelect label="标注排除 / 易混淆目标" v-model="caseDraft.expected.forbiddenTargets" :options="forbiddenOptions" :disabled="busy" empty-label="选择需要排除的目标" placeholder="搜索需要排除的指令、用途或插件" empty-text="没有匹配的排除目标"/><p class="muted tiny">点击勾选多个目标，已选标签可单独移除；预期答案与排除目标不能重复。</p></fieldset></template><template #actions><button class="btn outline" :disabled="busy" @click="closeCase">取消</button><button class="btn primary" :disabled="busy" @click="saveCase">保存题目</button></template></SideDrawer>
    <SideDrawer :open="targetEditor" :title="targetDraft.id?'编辑预期目标':'预期目标管理'" subtitle="优先从真实指令库选择，也可修正用途、示例和前置条件。不会调用该指令。" width="780px" @close="closeTarget"><template v-if="targetEditor"><fieldset :disabled="busy" class="evaluation-form-fieldset"><details><summary>选择已有目标进行修正（{{currentDataset.targets.length}} 项）</summary><SearchInput v-model="targetQuery" placeholder="筛选已有目标"/><div class="evaluation-target-list"><button v-for="t in targetList" :key="t.id" class="btn small outline" @click="editTarget(t)">{{t.example}} · {{t.meaning}}</button></div></details><div class="evaluation-command-search"><SearchInput v-model="commandQuery" placeholder="从当前指令库查找，如体力、提醒" @keyup.enter="searchCommands"/><button class="btn outline" type="button" @click="searchCommands">查找指令</button></div><div class="evaluation-target-list" v-if="commandOptions.length"><button v-for="(c,i) in commandOptions" :key="i" class="btn small outline" @click="useCommand(c)">{{c.example}} · {{c.meaning}}</button></div><Field label="建议指令示例" v-model="targetDraft.example"/><Field label="实际用途" type="textarea" :rows="3" v-model="targetDraft.meaning"/><div class="form-grid"><Field label="插件标识" v-model="targetDraft.selector.pluginKey"/><Field label="处理函数" v-model="targetDraft.selector.fnc"/></div><Field label="完整注册正则" type="textarea" :rows="3" v-model="targetDraft.selector.regexp"/><Field label="正则选项" v-model="targetDraft.selector.regexpFlags"/><Field label="前置条件" type="textarea" :rows="4" v-model="conditionsText" hint="每行一项；声明权限不等于真实执行入口放行。"/></fieldset></template><template #actions><button class="btn outline" :disabled="busy" @click="closeTarget">关闭</button><button class="btn primary" :disabled="busy" @click="saveTarget">保存预期目标</button></template></SideDrawer>
  </SideDrawer>`,
}
