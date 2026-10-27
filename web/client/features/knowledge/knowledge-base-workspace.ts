import { KnowledgeRetrievalResults } from "./knowledge-retrieval-results.js"

// 知识库工作区：库列表、内容/召回/授权/索引四个操作面板；状态和动作由父组件持有。
export const KnowledgeBaseWorkspace = {
  name: "KnowledgeBaseWorkspace",
  components: { KnowledgeRetrievalResults },
  props: {
    globalSettingsOpen: { type: Boolean, default: false },
    globalSettingsBusy: { type: Boolean, default: false },
    globalSettingsDirty: { type: Boolean, default: false },
    globalResultLimit: { type: Number, default: 5 },
    rerankModelOptions: { type: Array, default: () => [] },
    filteredBases: { type: Array, default: () => [] },
    bases: { type: Array, default: () => [] },
    selectedBaseId: { type: String, default: "" },
    selectedBase: { type: Object, default: null },
    baseQuery: { type: String, default: "" },
    basePaneItems: { type: Array, default: () => [] },
    activeBasePane: { type: String, default: "documents" },
    documents: { type: Array, default: () => [] },
    grants: { type: Array, default: () => [] },
    indexJobs: { type: Array, default: () => [] },
    indexInspection: { type: Object, default: null },
    indexJobPagination: { type: Object, default: () => ({ page: 1, pageSize: 10, total: 0 }) },
    retrievalResults: { type: Array, default: () => [] },
    retrievalDiagnostics: { type: Object, default: null },
    retrievalTrace: { type: Object, default: null },
    documentQuery: { type: String, default: "" },
    documentSort: { type: String, default: "updated" },
    draft: { type: Object, required: true },
    baseBusy: { type: Boolean, default: false },
    activeIndexJob: { type: Object, default: null },
    baseHealth: { type: Function, required: true },
    documentOrigin: { type: Function, required: true },
    canEditBuiltinCommand: { type: Function, required: true },
    jobLabel: { type: Function, required: true },
    jobProgress: { type: Function, required: true },
    jobProgressTone: { type: Function, required: true },
    jobProgressLabel: { type: Function, required: true },
    shortId: { type: Function, required: true },
  },
  emits: [
    "open-global-settings",
    "close-global-settings",
    "save-global-settings",
    "refresh-bases",
    "create-base",
    "select-base",
    "open-command-maintenance",
    "open-base-editor",
    "rebuild-base",
    "check-index",
    "repair-index",
    "delete-base",
    "set-base-pane",
    "update-base-query",
    "load-base-details",
    "update-document-query",
    "update-document-sort",
    "open-document-editor",
    "open-builtin-command",
    "delete-document",
    "delete-builtin-command",
    "test-retrieval",
    "open-grant-editor",
    "delete-grant",
    "retry-job",
    "cancel-job",
    "delete-job",
    "change-job-page",
  ],
  template: `
    <div class="section-stage knowledge-stage">
      <header class="ui-page-header">
        <h2>知识库</h2>
        <div class="row"><button class="btn small outline" type="button" aria-haspopup="dialog" :aria-expanded="globalSettingsOpen" @click="$emit('open-global-settings')"><Icon name="sliders" :size="14" />全局配置</button><button class="btn small outline" type="button" @click="$emit('refresh-bases')"><Icon name="refresh" :size="14" />刷新</button><button class="btn primary small" type="button" @click="$emit('create-base')"><Icon name="plus" :size="14" />新建知识库</button></div>
      </header>
      <Dialog :open="globalSettingsOpen" title="知识库全局配置" description="所有知识库、帮助指令、AI 工具和自动召回共用。保存立即生效，无需重建索引。" size="lg" @close="$emit('close-global-settings')">
        <div class="form-grid dense knowledge-global-settings-fields">
          <Field label="每次召回上限" type="number" hint="1–20 条 · 默认 5" v-model="draft.retrievalResultLimit" :disabled="globalSettingsBusy" description="控制最终返回总数；调用方可请求更少，相关性不足时不凑满。" />
          <Field label="相关性阈值" type="number" hint="0–1 · 默认 0.55" v-model="draft.retrievalMinRelevance" :disabled="globalSettingsBusy" description="用于关键词及向量筛选，越高越严格；不是正确率。余弦相似度原始范围为 −1–1。" />
          <div class="command-rerank-model-field">
            <Field label="重排模型" type="select" :options="[{value: '', label: '沿用已配置的重排任务'}, ...rerankModelOptions]" v-model="draft.retrievalRerankModel" :disabled="globalSettingsBusy" tip="全部知识库共用；开启后才调用，关闭或失败时使用融合排名。" />
            <Field class="command-rerank-inline" :label="draft.retrievalRerankEnabled === 'true' ? '已开启' : '未开启'" type="switch" v-model="draft.retrievalRerankEnabled" :disabled="globalSettingsBusy" aria-label="启用全局模型重排" tip="默认关闭；开启后按需调用重排模型，保存后生效。" />
          </div>
          <Field label="重排返回上限" type="number" hint="1–20 条 · 默认 5" v-model="draft.retrievalRerankResultLimit" :disabled="globalSettingsBusy" description="仅重排成功时生效；最终数量取此值、召回上限和调用方请求数中的最小值。关闭或失败时沿用召回上限。" />
          <Field label="重排最低分（可选）" type="number" hint="默认 0.3" v-model="draft.retrievalRerankMinScore" :disabled="globalSettingsBusy" description="越高越相关；对话模型范围为 0–1，专用模型可能返回负分或大于 1 的原始分，请按模型调整。留空仅排序，与相关性阈值独立。" />
        </div>
        <template #footer><button class="btn outline" type="button" :disabled="globalSettingsBusy" @click="$emit('close-global-settings')">取消</button><button class="btn primary" type="button" :disabled="globalSettingsBusy || !globalSettingsDirty" @click="$emit('save-global-settings')"><Icon name="save" :size="14" />{{ globalSettingsBusy ? '保存中…' : '保存全局配置' }}</button></template>
      </Dialog>
      <Panel flush>
        <div class="knowledge-console">
          <aside class="knowledge-sidebar">
            <div class="provider-sidebar-head">
              <div class="section-title">全部知识库</div>
              <span class="filter-count">{{ filteredBases.length }} / {{ bases.length }}</span>
            </div>
            <SearchInput :model-value="baseQuery" placeholder="搜索知识库" @update:model-value="$emit('update-base-query', $event)" />
            <div v-if="filteredBases.length" class="knowledge-base-list">
              <div v-for="base in filteredBases" :key="base.id" class="knowledge-base-card-shell" :class="{ active: selectedBaseId === base.id }">
                <button type="button" class="knowledge-base-card" :class="{ active: selectedBaseId === base.id }" :aria-current="selectedBaseId === base.id ? 'true' : undefined" @click="$emit('select-base', base.id)">
                  <div class="knowledge-base-card-head"><div class="knowledge-base-name truncate">{{ base.name }}</div><StatusDot :state="baseHealth(base).state" :label="baseHealth(base).label" :tip="base.index?.error" /></div>
                  <div class="knowledge-base-meta"><span>{{ base.stats?.documents || 0 }} 篇内容</span><span>{{ base.protected ? '内置' : base.config?.embeddingModel ? '语义检索' : '全文检索' }}</span></div>
                </button>
              </div>
            </div>
            <div v-else class="provider-empty-state"><Icon name="database" :size="24" /><strong>没有匹配的知识库</strong><p>清空搜索或新建一个知识库。</p></div>
          </aside>

          <section v-if="selectedBase" class="knowledge-main">
            <div class="knowledge-hero">
              <div class="knowledge-hero-head">
                <div><div class="knowledge-hero-title">{{ selectedBase.name }}</div><p class="muted small">{{ selectedBase.description || '暂无描述；可补充收录范围和维护说明。' }}</p></div>
                <div class="row-actions">
                  <button v-if="selectedBase.id === 'builtin-commands'" class="btn small outline" type="button" @click="$emit('open-command-maintenance', selectedBase)"><Icon name="sliders" :size="14" />维护指令</button>
                  <button v-if="!selectedBase.protected" class="btn small outline" type="button" @click="$emit('open-base-editor', selectedBase)"><Icon name="pencil" :size="14" />设置</button>
                  <IconButton v-if="!selectedBase.protected" icon="trash" tone="danger" tip="删除知识库" @click="$emit('delete-base', selectedBase)" />
                </div>
              </div>
              <div class="knowledge-health-row">
                <StatusDot :state="baseHealth(selectedBase).state" :label="baseHealth(selectedBase).label" :tip="selectedBase.index?.error" />
                <span>{{ selectedBase.stats?.documents || 0 }} 篇内容</span>
                <details class="knowledge-index-summary"><summary>索引详情<Icon name="chevron-down" :size="12" /></summary><div class="knowledge-index-facts">
                <span class="badge">{{ selectedBase.stats?.chunks || 0 }} 个分块</span>
                <span v-if="selectedBase.id === 'builtin-commands'" class="badge on">可检索 {{ selectedBase.stats?.searchableDocuments || 0 }} 篇 / {{ selectedBase.stats?.searchableChunks || 0 }} 块</span>
                <span v-else class="badge">{{ selectedBase.stats?.characters || 0 }} 字符</span>
                <span class="badge accent">{{ selectedBase.config?.embeddingModel || 'FTS5 全文检索' }}</span>
                <span v-if="selectedBase.config?.embeddingModel" class="badge">Cosine（余弦）</span>
                </div></details>
              </div>
              <div v-if="selectedBase.index?.error" class="hint-banner warn"><Icon name="alert" :size="14" /><span>{{ selectedBase.index.error }}</span></div>
            </div>

            <SectionNav class="knowledge-pane-switch" :model-value="activeBasePane" :items="basePaneItems" variant="tabs" label="当前知识库操作" @update:model-value="$emit('set-base-pane', $event)" />

            <section v-if="activeBasePane === 'documents'" class="knowledge-pane">
              <div class="knowledge-pane-head"><div><div class="section-title"><Icon name="file" :size="13" />内容列表</div><p class="muted tiny">指令下方显示插件、来源和方法；可按资料完整度排序，点击卡片编辑说明。</p></div><button v-if="!selectedBase.protected" class="btn primary small" type="button" @click="$emit('open-document-editor')"><Icon name="plus" :size="14" />添加内容</button></div>
              <div v-if="selectedBase.id === 'builtin-commands'" class="command-content-summary"><span>已收录 {{ selectedBase.stats?.documents || 0 }} 条指令</span><span class="badge on">可检索 {{ selectedBase.stats?.searchableDocuments || 0 }}</span><span class="muted tiny">外部整理后导入；每个 ID 含当前最多保留 3 个版本。</span></div>
              <div class="list-filter knowledge-content-filter"><label class="filter-search"><Icon name="search" :size="14" /><input :value="documentQuery" type="text" placeholder="搜索标题或原文" @input="$emit('update-document-query', $event.target.value)" @keydown.enter="$emit('load-base-details')" /></label><Field v-if="selectedBase.id === 'builtin-commands'" class="knowledge-content-sort" type="select" aria-label="内容排序" :model-value="documentSort" :options="[{value:'updated',label:'最近更新'}, {value:'quality-asc',label:'完整度：低分优先'}, {value:'quality-desc',label:'完整度：高分优先'}]" @update:model-value="$emit('update-document-sort', $event)" /><button class="btn small outline" type="button" @click="$emit('load-base-details')"><Icon name="search" :size="14" />筛选</button></div>
              <PagedList v-if="documents.length" :key="selectedBase.id + ':' + documentSort" :rows="documents" :page-size="8" label="内容" v-slot="{ item }">
                <article class="knowledge-document-card" :class="{ 'is-editable': canEditBuiltinCommand(item), 'is-muted': item.searchable === false }" :tabindex="canEditBuiltinCommand(item) ? 0 : undefined" :role="canEditBuiltinCommand(item) ? 'button' : undefined" @click="$emit('open-builtin-command', item)" @keydown.enter.prevent="$emit('open-builtin-command', item)" @keydown.space.prevent="$emit('open-builtin-command', item)">
                  <div class="item-head"><div><div class="knowledge-document-title-row"><div class="item-title">{{ item.title }}</div><div v-if="selectedBase.id === 'builtin-commands' && documentOrigin(item)" class="knowledge-command-origin-inline"><span><b>插件</b><strong>{{ documentOrigin(item).plugin }}</strong></span><span><b>{{ documentOrigin(item).fileLabel }}</b><code :title="documentOrigin(item).file">{{ documentOrigin(item).file }}</code></span><span><b>方法</b><code>{{ documentOrigin(item).method }}</code></span></div></div><p v-if="selectedBase.id !== 'builtin-commands'" class="muted tiny">{{ item.source_type }} · {{ item.chunks }} 个分块 · {{ item.characters }} 字符</p></div><div v-if="selectedBase.id === 'builtin-commands'" class="row-actions"><span v-if="item.qualityScore != null" class="badge" :class="item.qualityScore >= 90 ? 'on' : item.qualityScore < 60 ? 'risk-high' : 'risk-medium'" :data-tip="'用于确定整理或排除的优先级，不代表召回准确率或执行成功。' + ((item.qualityIssues || []).join('；') || '未发现扣分项')">资料完整度 {{ item.qualityScore }}%</span><IconButton v-if="item.canDelete" icon="trash" tone="danger" tip="删除手动或动态知识条目" @keydown.stop @click.stop="$emit('delete-builtin-command', { id: item.metadata?.commandId, suggestedCommand: item.title })" /></div><div v-else-if="!selectedBase.protected" class="row-actions"><IconButton icon="pencil" tone="accent" tip="编辑完整原文" @click="$emit('open-document-editor', item)" /><IconButton icon="trash" tone="danger" tip="删除内容" @click="$emit('delete-document', item)" /></div></div>
                  <p class="knowledge-document-preview" :class="{ 'knowledge-command-preview': selectedBase.id === 'builtin-commands' }">{{ item.preview || '内容为空' }}</p>
                  <details v-if="selectedBase.id === 'builtin-commands' && (item.qualityDeductions?.length || item.qualityCapReasons?.length)" class="knowledge-quality-details" @click.stop @keydown.stop>
                    <summary>扣分明细</summary>
                    <ul><li v-for="(deduction, index) in item.qualityDeductions" :key="index"><strong>−{{ deduction.points }} 分 · {{ deduction.field }}</strong><span>{{ deduction.reason }}</span><p class="muted tiny">{{ deduction.suggestion }}</p></li></ul>
                    <p v-for="reason in item.qualityCapReasons" :key="reason" class="muted tiny">{{ reason }}</p>
                  </details>
                </article>
              </PagedList>
              <div v-else class="provider-empty-state"><Icon name="file" :size="24" /><strong>{{ documentQuery ? '没有匹配内容' : '这个知识库还没有内容' }}</strong><p>{{ selectedBase.protected ? '内置内容由机器人指令扫描维护。' : '添加第一篇内容后即可使用全文检索。' }}</p><button v-if="!selectedBase.protected && !documentQuery" class="btn primary small" type="button" @click="$emit('open-document-editor')">添加内容</button></div>
            </section>

            <section v-else-if="activeBasePane === 'retrieval'" class="knowledge-pane">
              <div class="knowledge-pane-head"><div><div class="section-title"><Icon name="search" :size="13" />召回测试</div><p class="muted tiny">像真实用户一样提问，确认命中的来源、原文和排序。每次最多 {{ globalResultLimit }} 条；重排成功时还受重排返回上限限制，均在全局配置中管理。</p></div></div>
              <p v-if="selectedBase.id === 'builtin-commands'" class="muted tiny">统一推荐方式：{{ selectedBase.retrievalMode === 'lexical' ? '关键词推荐' : '混合推荐（默认）' }}；与帮助指令及 AI 工具共用。</p>
              <div class="knowledge-search-box"><Field label="测试问题" v-model="draft.retrievalQuery" placeholder="例如：怎么查体力？" @enter="$emit('test-retrieval')" /><button class="btn primary" type="button" :disabled="baseBusy" @click="$emit('test-retrieval')"><Icon name="play" :size="14" />{{ baseBusy ? '检索中…' : '开始测试' }}</button></div>
              <KnowledgeRetrievalResults :trace="retrievalTrace" :diagnostics="retrievalDiagnostics" />
            </section>

            <section v-else-if="activeBasePane === 'grants'" class="knowledge-pane">
              <div class="knowledge-pane-head"><div><div class="section-title"><Icon name="key" :size="13" />访问授权</div><p class="muted tiny">群限定规则只在对应群生效；拒绝规则始终优先。</p></div><button class="btn primary small" type="button" @click="$emit('open-grant-editor')"><Icon name="plus" :size="14" />添加规则</button></div>
              <div v-if="grants.length" class="knowledge-grant-list">
                <div v-for="item in grants" :key="item.id" class="knowledge-grant-row"><div><div class="item-title">{{ item.principal_type }} · {{ item.principal_id }}</div><p class="muted tiny">{{ item.group_id ? '仅群 ' + item.group_id : '所有会话范围' }}</p></div><div class="row"><span v-if="item.principal_type === 'role' && item.principal_id === 'master'" class="badge accent">固定</span><span class="badge" :class="item.access === 'deny' ? 'risk-high' : 'on'">{{ item.access === 'deny' ? '拒绝' : '允许' }}</span><IconButton v-if="!(item.principal_type === 'role' && item.principal_id === 'master')" icon="trash" tone="danger" tip="删除规则" @click="$emit('delete-grant', item)" /></div></div>
              </div>
              <div v-else class="provider-empty-state"><Icon name="key" :size="24" /><strong>没有授权规则</strong><p>没有任何规则时，聊天用户无法检索这个知识库。</p></div>
            </section>

            <section v-else class="knowledge-pane">
              <div class="knowledge-pane-head"><div><div class="section-title">索引完整性</div><p class="muted tiny">日常导入只更新变化的分块；检查不会调用模型，补齐只生成缺失或内容变化的向量。</p></div><div class="row"><button class="btn outline small" :disabled="baseBusy" @click="$emit('check-index')">检查索引</button><button class="btn outline small" :disabled="baseBusy || activeIndexJob" @click="$emit('repair-index')">补齐缺失</button></div></div>
              <div v-if="indexInspection" class="hint-banner" :class="indexInspection.state === 'ready' ? 'ok' : 'warn'"><Icon name="info" :size="14" /><span>最近检查：共 {{ indexInspection.total }} 块，兼容且已建立 {{ indexInspection.indexed }} 块，需补齐 {{ indexInspection.missing }} 块。{{ ({ready: '索引完整。', missing: '可补齐缺失分块。', incompatible: '模型配置已变化，需生成当前模型的向量。', not_configured: '尚未配置向量模型。', unavailable: '向量数据库不可用。', changed: '检查期间内容或配置变化，请重新检查。'})[indexInspection.state] }}</span></div>
              <div class="knowledge-pane-head"><div><div class="section-title"><Icon name="activity" :size="13" />索引任务</div><p class="muted tiny">按最近执行时间排序，每页 10 条；已结束记录保留 7 天，超期任务自动取消。</p></div><button class="btn primary small" type="button" :disabled="baseBusy || activeIndexJob" @click="$emit('rebuild-base')"><Icon name="refresh" :size="14" />{{ activeIndexJob ? '构建中…' : '重建当前库' }}</button></div>
              <div v-if="!selectedBase.config?.embeddingModel" class="hint-banner ok"><Icon name="info" :size="14" /><span>当前使用 FTS5 全文检索，不需要 embedding 模型和向量任务。</span></div>
              <div v-else-if="!selectedBase.active_vector_space_id" class="hint-banner warn"><Icon name="info" :size="14" /><span>Cosine 向量索引尚未就绪，请重建当前库；期间仍可使用全文检索。</span></div>
              <div v-if="indexJobs.length" class="knowledge-job-list">
                <div v-for="item in indexJobs" :key="item.id" class="knowledge-job-row">
                  <div class="knowledge-job-main">
                    <div class="item-title">{{ jobLabel(item.status) }}</div>
                    <p class="muted tiny">{{ jobProgressLabel(item) }} · 尝试 {{ item.attempts }} / {{ item.max_attempts }} · {{ shortId(item.id) }}</p>
                    <div v-if="item.progress || ['queued', 'running', 'completed'].includes(item.status)" class="knowledge-job-progress-track"><span :class="{ done: jobProgressTone(item) === 'done', bad: jobProgressTone(item) === 'bad' }" :style="{ width: jobProgress(item) + '%' }"></span></div>
                    <div v-if="item.progress" class="knowledge-job-progress-meta"><span>{{ jobProgress(item) }}%</span><span v-if="item.progress.total">{{ item.progress.processed || 0 }} / {{ item.progress.total }} 个分块</span></div>
                    <p v-if="item.error" class="knowledge-job-error">{{ item.error }}</p>
                  </div>
                  <div class="row">
                    <button v-if="['failed', 'paused_budget', 'paused_no_model'].includes(item.status)" class="btn small outline" type="button" @click="$emit('retry-job', item)"><Icon name="restore" :size="14" />重试</button>
                    <button v-if="['queued', 'running', 'retrying', 'paused_budget', 'paused_no_model'].includes(item.status)" class="btn small outline" type="button" @click="$emit('cancel-job', item)"><Icon name="x" :size="14" />取消</button>
                    <span v-else-if="item.status === 'canceling'" class="muted tiny">正在停止当前批次…</span>
                    <IconButton v-if="['completed', 'failed', 'canceled', 'superseded'].includes(item.status)" icon="trash" tone="danger" tip="删除任务记录" @click="$emit('delete-job', item)" />
                  </div>
                </div>
              </div>
              <div v-if="indexJobPagination.total > 10" class="memory-pagebar"><span>第 {{ indexJobPagination.page }} / {{ Math.ceil(indexJobPagination.total / 10) }} 页 · 共 {{ indexJobPagination.total }} 条</span><div><button class="icon-btn sm" type="button" :disabled="indexJobPagination.page <= 1" @click="$emit('change-job-page', indexJobPagination.page - 1)"><Icon name="chevron-left" :size="15" /></button><button class="icon-btn sm" type="button" :disabled="indexJobPagination.page >= Math.ceil(indexJobPagination.total / 10)" @click="$emit('change-job-page', indexJobPagination.page + 1)"><Icon name="chevron-right" :size="15" /></button></div></div>
              <div v-else-if="selectedBase.config?.embeddingModel" class="provider-empty-state"><Icon name="activity" :size="24" /><strong>还没有向量索引任务</strong><p>点击“重建当前库”开始构建。</p></div>
            </section>
          </section>

          <section v-else class="provider-empty-state knowledge-main-empty"><Icon name="database" :size="28" /><strong>选择一个知识库</strong><p>右侧会集中展示内容、召回、授权和索引状态。</p></section>
        </div>
      </Panel>
    </div>
  `,
}
