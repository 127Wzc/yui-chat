import { computed, defineComponent, ref, watch, type PropType } from "vue"
import { asRecords } from "../../shared/data.js"

type Row = Record<string, any>
type View = "overview" | "direct" | "reranked"
type SortKey = "title" | "lexicalRelevance" | "recallRank" | "vectorSimilarity" | "score" | "rerankRank" | "rerankScore" | "processingResult"
const PROCESSING: Record<string, { label: string; order: number }> = {
  returned: { label: "已返回", order: 0 },
  return_limit: { label: "重排返回上限截断", order: 1 },
  recall_limit: { label: "召回上限截断", order: 2 },
  below_threshold: { label: "低于重排最低分", order: 3 },
  command_conflict: { label: "同指令折叠", order: 4 },
  input_budget: { label: "重排输入预算不足", order: 5 },
  candidate_limit: { label: "未入重排候选", order: 6 },
  unavailable: { label: "当前不可检索", order: 7 },
}
const RERANK_STATES: Record<string, string> = {
  applied: "重排成功", cached: "使用重排缓存", disabled: "重排未开启或没有候选",
  model_unavailable: "重排模型不可用", task_unavailable: "未配置重排任务",
  input_budget: "重排输入预算不足，已回退",
  failed_fallback: "重排失败，已回退召回结果",
}
const COLUMNS: Array<{ key: SortKey; label: string; tip?: string }> = [
  { key: "title", label: "内容" },
  { key: "lexicalRelevance", label: "关键词覆盖率", tip: "命中查询词的比例，0–100%；未被关键词路召回显示 —，不表示正确率。" },
  { key: "recallRank", label: "召回排名", tip: "融合后、模型重排前的候选排名。点击排序不会改写排名。" },
  { key: "vectorSimilarity", label: "向量相似度", tip: "Cosine 范围 −1–1，越高越接近；未被向量路召回显示 —。" },
  { key: "score", label: "融合分", tip: "按关键词和向量两路的排名加权计算，不是两路原始分相加，也不是概率。" },
  { key: "rerankRank", label: "重排排名", tip: "模型评分后、分数门槛和返回数量筛选前的排名；没有有效评分显示 —。" },
  { key: "rerankScore", label: "重排分", tip: "保留模型分数尺度；对话模型为 0–1，专用模型可能超出此范围。" },
  { key: "processingResult", label: "处理结果" },
]

/** 同一次查询的候选及阶段结果；排序、展开和切换只改变本地展示。 */
export const KnowledgeRetrievalResults = defineComponent({
  name: "KnowledgeRetrievalResults",
  props: {
    trace: { type: Object as PropType<Row | null>, default: null },
    diagnostics: { type: Object as PropType<Row | null>, default: null },
  },
  setup(props) {
    const view = ref<View>("overview")
    const sortKey = ref<SortKey>("score")
    const sortDirection = ref<"asc" | "desc">("desc")
    const expanded = ref<string[]>([])
    const fullText = ref(false)
    const succeeded = computed(() => props.trace?.rerankSucceeded === true && ["applied", "cached"].includes(props.diagnostics?.rerank))
    const candidates = computed<Row[]>(() => asRecords(props.trace?.candidates))
    const byId = computed(() => new Map(candidates.value.map(item => [item.id, item])))
    const stageRows = (ids: unknown): Row[] => Array.isArray(ids) ? ids.map(id => byId.value.get(id)).filter((item): item is Row => Boolean(item)) : []
    const directRows = computed(() => stageRows(props.trace?.directResultIds))
    const rerankedRows = computed(() => succeeded.value ? stageRows(props.trace?.finalResultIds) : [])
    const tabItems = computed(() => [
      { value: "overview", label: "总览对比", count: candidates.value.length },
      { value: "direct", label: "直接召回", count: directRows.value.length },
      { value: "reranked", label: "重排结果", count: succeeded.value ? rerankedRows.value.length : "—" },
    ])
    watch(() => props.trace, () => {
      view.value = "overview"
      sortKey.value = succeeded.value ? "rerankScore" : "score"
      sortDirection.value = "desc"
      expanded.value = []
      fullText.value = false
    }, { immediate: true })
    function sortValue(item: Row): number | string | null {
      const key = sortKey.value
      if ((key === "rerankRank" || key === "rerankScore") && !succeeded.value) return null
      if (key === "title") return String(item.title || "")
      if (key === "processingResult") return PROCESSING[item.processingResult]?.order ?? null
      return typeof item[key] === "number" && Number.isFinite(item[key]) ? item[key] : null
    }
    const sortedRows = computed(() => [...candidates.value].sort((a, b) => {
      const av = sortValue(a), bv = sortValue(b)
      // 缺失项始终置后，不能当成 0，也不能在升序时排到有效分数前。
      if (av === null || bv === null) return av === bv ? a.recallRank - b.recallRank : av === null ? 1 : -1
      const comparison = typeof av === "string" ? av.localeCompare(String(bv), "zh-CN") : av - Number(bv)
      return comparison * (sortDirection.value === "asc" ? 1 : -1) || a.recallRank - b.recallRank
    }))
    const visibleRows = computed(() => view.value === "overview" ? sortedRows.value : view.value === "direct" ? directRows.value : rerankedRows.value)
    const rerankInfo = computed<Row>(() => props.trace?.rerank || {})
    const policy = computed<Row>(() => props.trace?.config || {})
    const scoredCount = computed(() => succeeded.value ? asRecords(rerankInfo.value.scores).length : 0)
    const acceptedCount = computed(() => succeeded.value ? asRecords(rerankInfo.value.scores).filter(item => policy.value.rerankMinScore == null || Number(item.score) >= Number(policy.value.rerankMinScore)).length : 0)
    const rerankState = computed(() => {
      const state = props.diagnostics?.rerank || "disabled"
      if (state === "disabled") return candidates.value.length ? "重排未开启" : "没有候选，未执行重排"
      return RERANK_STATES[state] || state
    })
    function sortColumn(key: SortKey): void {
      if (sortKey.value === key) sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc"
      else { sortKey.value = key; sortDirection.value = "asc" }
    }
    function toggleExpanded(id: string): void {
      expanded.value = expanded.value.includes(id) ? expanded.value.filter(value => value !== id) : [...expanded.value, id]
    }
    function formatNumber(value: unknown, digits = 4): string {
      return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—"
    }
    function percentage(value: unknown): string {
      return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—"
    }
    function rank(value: unknown): string { return typeof value === "number" && Number.isFinite(value) ? `#${value}` : "—" }
    function score(item: Row): string { return succeeded.value ? formatNumber(item.rerankScore) : "—" }
    function rerankRank(item: Row): string { return succeeded.value ? rank(item.rerankRank) : "—" }
    function rankChange(item: Row): string {
      if (!succeeded.value || !Number.isFinite(item.rerankRank)) return ""
      const delta = item.recallRank - item.rerankRank
      return delta > 0 ? `↑ ${delta}` : delta < 0 ? `↓ ${Math.abs(delta)}` : "不变"
    }
    const currentSort = computed(() => `${COLUMNS.find(item => item.key === sortKey.value)?.label}${sortDirection.value === "asc" ? "升序" : "降序"}`)
    return {
      view, columns: COLUMNS, tabItems, candidates, visibleRows, succeeded, sortKey, sortDirection, expanded, fullText,
      rerankInfo, policy, scoredCount, acceptedCount, rerankState, currentSort,
      sortColumn, toggleExpanded, formatNumber, percentage, rank, score, rerankRank, rankChange,
      processingLabel: (item: Row) => PROCESSING[item.processingResult]?.label || "未记录",
      sourceLabel: (item: Row) => item.metadata?.command?.pluginName || item.knowledgeBaseName || item.source || "未记录来源",
    }
  },
  template: `
    <div v-if="trace" class="knowledge-retrieval-results">
      <div class="item subtle knowledge-retrieval-summary" aria-live="polite">
        <p class="knowledge-retrieval-counts"><span>召回候选 <strong>{{ candidates.length }}</strong></span><template v-if="succeeded"><span>→ 参与重排 <strong>{{ scoredCount }}</strong></span><span>→ 达到最低分 <strong>{{ acceptedCount }}</strong></span></template><span>→ 最终返回 <strong>{{ trace.finalResultIds?.length || 0 }}</strong></span><span class="badge" :class="succeeded ? 'on' : 'risk-medium'">{{ rerankState }}</span></p>
        <p class="muted tiny">本次问题：{{ trace.query }}</p>
        <p class="muted tiny">{{ diagnostics?.mode === 'hybrid' ? '混合召回' : diagnostics?.mode === 'vector' ? '向量召回' : '关键词召回' }} · 相关性阈值 {{ policy.minRelevance }}<span v-for="weight in policy.weights" :key="weight.baseId"> · 关键词权重 {{ weight.keyword }} / 向量权重 {{ weight.vector }}</span></p>
        <p v-if="succeeded" class="muted tiny"><span v-if="rerankInfo.model">模型 {{ rerankInfo.model }} · </span>最低分 {{ policy.rerankMinScore == null ? '不截断' : policy.rerankMinScore }} · 重排返回上限 {{ policy.rerankResultLimit }} · 耗时 {{ rerankInfo.elapsedMs }} ms</p>
        <p v-if="diagnostics?.fallbackReasons?.length" class="muted tiny">降级原因：{{ diagnostics.fallbackReasons.join('；') }}</p>
      </div>
      <div class="knowledge-retrieval-viewbar">
        <div class="segmented" role="tablist" aria-label="召回结果查看方式"><button v-for="tab in tabItems" :key="tab.value" type="button" role="tab" :id="'knowledge-recall-' + tab.value" :aria-selected="view === tab.value" aria-controls="knowledge-recall-panel" :class="{active: view === tab.value}" @click="view = tab.value">{{ tab.label }} <span class="badge">{{ tab.count }}</span></button></div>
        <label v-if="view !== 'overview'" class="knowledge-retrieval-fulltext"><input v-model="fullText" type="checkbox" />显示完整正文</label>
      </div>
      <div id="knowledge-recall-panel" role="tabpanel" :aria-labelledby="'knowledge-recall-' + view">
        <div v-if="view === 'overview' && candidates.length" class="knowledge-retrieval-table-wrap">
          <table class="knowledge-retrieval-table">
            <thead><tr><th v-for="column in columns" :key="column.key" :aria-sort="sortKey === column.key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'"><button class="knowledge-retrieval-sort" type="button" :class="{active: sortKey === column.key}" :data-tip="column.tip" :aria-label="column.label + '，点击按' + (sortKey === column.key && sortDirection === 'asc' ? '降序' : '升序') + '排列'" @click="sortColumn(column.key)">{{ column.label }}<span aria-hidden="true">{{ sortKey === column.key ? (sortDirection === 'asc' ? '↑' : '↓') : '↕' }}</span></button></th></tr></thead>
            <tbody><template v-for="item in visibleRows" :key="item.id">
              <tr :class="{'is-expanded': expanded.includes(item.id)}">
                <td class="knowledge-retrieval-title"><button type="button" :aria-expanded="expanded.includes(item.id)" @click="toggleExpanded(item.id)"><Icon :name="expanded.includes(item.id) ? 'chevron-down' : 'chevron-right'" :size="12" />{{ item.title }}</button><p class="muted tiny">{{ sourceLabel(item) }}</p></td>
                <td>{{ percentage(item.lexicalRelevance) }}</td><td>{{ rank(item.recallRank) }}</td><td>{{ formatNumber(item.vectorSimilarity) }}</td><td>{{ formatNumber(item.score) }}</td><td>{{ rerankRank(item) }}<small class="knowledge-retrieval-rank-change">{{ rankChange(item) }}</small></td><td>{{ score(item) }}</td>
                <td><span class="badge" :class="item.processingResult === 'returned' ? 'on' : ''" :data-tip="item.finalRank ? '实际返回第 ' + item.finalRank + ' 条；同指令冲突仍遵循宿主顺序。' : undefined">{{ processingLabel(item) }}</span></td>
              </tr>
              <tr v-if="expanded.includes(item.id)" class="knowledge-retrieval-detail"><td colspan="8"><div><strong>完整正文 · {{ item.title }}</strong><p class="knowledge-retrieval-body">{{ item.content }}</p><p class="muted tiny">来源 {{ item.retrievalMethod || '未知' }} · 关键词路排名 {{ rank(item.keywordRank) }} · 向量路排名 {{ rank(item.vectorRank) }}<span v-if="item.finalRank"> · 实际返回 {{ rank(item.finalRank) }}</span></p><p v-if="item.fieldDescription" class="muted tiny">字段说明：{{ item.fieldDescription }}</p><p v-if="item.commandId" class="muted tiny">优先级 {{ item.metadata?.command?.priorityLabel || (item.metadata?.command?.priority ?? '未知') }} · 权限 {{ item.metadata?.command?.permission || '未知' }} · 处理函数 {{ item.metadata?.command?.fnc || '未知' }}</p><p v-if="item.commandId" class="muted tiny knowledge-retrieval-body">{{ item.metadata?.origin?.file || item.metadata?.command?.registrationKey || '未定位' }} · {{ item.metadata?.command?.regexp }}</p></div></td></tr>
            </template></tbody>
          </table>
        </div>
        <div v-else-if="visibleRows.length" class="knowledge-result-list">
          <article v-for="(item, index) in visibleRows" :key="item.id" class="knowledge-result-card">
            <div class="item-head"><button class="knowledge-retrieval-card-title" type="button" :aria-expanded="fullText || expanded.includes(item.id)" @click="toggleExpanded(item.id)">{{ index + 1 }}. {{ item.title }}</button><span class="badge accent">{{ sourceLabel(item) }}</span></div>
            <p class="knowledge-retrieval-body" :class="{'is-preview': !fullText && !expanded.includes(item.id)}">{{ item.content }}</p>
            <p v-if="(fullText || expanded.includes(item.id)) && item.commandId" class="muted tiny knowledge-retrieval-body">{{ item.metadata?.command?.pluginName }} · 优先级 {{ item.metadata?.command?.priorityLabel || (item.metadata?.command?.priority ?? '未知') }} · 权限 {{ item.metadata?.command?.permission || '未知' }} · 处理函数 {{ item.metadata?.command?.fnc || '未知' }}<br>{{ item.metadata?.origin?.file || item.metadata?.command?.registrationKey || '未定位' }} · {{ item.metadata?.command?.regexp }}</p>
            <p class="muted tiny">关键词覆盖率 {{ percentage(item.lexicalRelevance) }} · 召回 {{ rank(item.recallRank) }} · 向量相似度 {{ formatNumber(item.vectorSimilarity) }} · 融合分 {{ formatNumber(item.score) }} · 重排 {{ rerankRank(item) }} · 重排分 {{ score(item) }}</p>
          </article>
        </div>
        <div v-else class="provider-empty-state"><Icon name="search" :size="24" /><strong>{{ view === 'reranked' && !succeeded ? '本次没有重排结果' : '没有符合条件的内容' }}</strong><p>{{ view === 'reranked' && !succeeded ? rerankState + '，可切换直接召回查看结果。' : '请检查原文、索引或相关性阈值。' }}</p></div>
      </div>
      <p class="muted tiny knowledge-retrieval-footer"><span v-if="view === 'overview'">全部 {{ candidates.length }} 条候选 · 当前按{{ currentSort }} · 未评分项始终置后。点击标题展开完整正文。</span>融合分与重排分尺度不同，不直接比较数值大小。</p>
    </div>
    <div v-else class="provider-empty-state"><Icon name="search" :size="24" /><strong>还没有测试结果</strong><p>测试后可查看全部候选，以及召回与重排的排名和分数。</p></div>
  `,
})
