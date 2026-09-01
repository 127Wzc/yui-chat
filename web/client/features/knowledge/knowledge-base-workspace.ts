// 知识库工作区：库列表、内容/召回/授权/索引四个操作面板；状态和动作由父组件持有。
export const KnowledgeBaseWorkspace = {
  name: "KnowledgeBaseWorkspace",
  props: {
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
    indexJobPagination: { type: Object, default: () => ({ page: 1, pageSize: 10, total: 0 }) },
    retrievalResults: { type: Array, default: () => [] },
    documentQuery: { type: String, default: "" },
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
    "refresh-bases",
    "create-base",
    "select-base",
    "open-command-maintenance",
    "open-base-editor",
    "rebuild-base",
    "delete-base",
    "set-base-pane",
    "update-base-query",
    "load-base-details",
    "update-document-query",
    "open-document-editor",
    "open-builtin-command",
    "delete-document",
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
      <div class="section-intro">
        <div><h2>知识库工作区</h2><p>先选库，再集中处理内容、召回、授权与索引异常。</p></div>
        <div class="row"><button class="btn small outline" type="button" @click="$emit('refresh-bases')"><Icon name="refresh" :size="14" />刷新</button><button class="btn primary small" type="button" @click="$emit('create-base')"><Icon name="plus" :size="14" />新建知识库</button></div>
      </div>
      <Panel flush>
        <div class="knowledge-console">
          <aside class="knowledge-sidebar">
            <div class="provider-sidebar-head">
              <div><div class="section-title"><Icon name="database" :size="13" />知识库</div><p class="muted tiny">状态异常的库会优先显示明确提示。</p></div>
              <span class="filter-count">{{ filteredBases.length }} / {{ bases.length }}</span>
            </div>
            <div class="list-filter">
              <label class="filter-search"><Icon name="search" :size="14" /><input :value="baseQuery" type="text" placeholder="搜索名称、描述或 ID" @input="$emit('update-base-query', $event.target.value)" /></label>
            </div>
            <div v-if="filteredBases.length" class="knowledge-base-list">
              <div v-for="base in filteredBases" :key="base.id" class="knowledge-base-card-shell" :class="{ active: selectedBaseId === base.id }">
                <button type="button" class="knowledge-base-card" :class="{ active: selectedBaseId === base.id, 'has-maintenance': base.id === 'builtin-commands' }" @click="$emit('select-base', base.id)">
                  <div class="knowledge-base-card-head"><div class="knowledge-base-name truncate">{{ base.name }}</div><StatusDot :state="baseHealth(base).state" :label="baseHealth(base).label" :tip="base.index?.error" /></div>
                  <p class="knowledge-base-description">{{ base.description || '暂无描述' }}</p>
                  <div class="provider-source-meta"><span class="badge">{{ base.stats?.documents || 0 }} 篇</span><span class="badge">{{ base.stats?.chunks || 0 }} 块</span><span v-if="base.protected" class="badge on">内置</span><span v-else-if="base.config?.embeddingModel" class="badge accent">语义</span><span v-else class="badge">全文</span></div>
                </button>
                <button v-if="base.id === 'builtin-commands'" class="btn small outline knowledge-base-maintain" type="button" @click.stop="$emit('open-command-maintenance', base)"><Icon name="sliders" :size="13" />维护</button>
              </div>
            </div>
            <div v-else class="provider-empty-state"><Icon name="database" :size="24" /><strong>没有匹配的知识库</strong><p>清空搜索或新建一个知识库。</p></div>
          </aside>

          <section v-if="selectedBase" class="knowledge-main">
            <div class="knowledge-hero">
              <div class="knowledge-hero-head">
                <div><div class="knowledge-hero-title">{{ selectedBase.name }}</div><p class="muted small">{{ selectedBase.description || '暂无描述；可补充收录范围和维护说明。' }}</p></div>
                <div class="row-actions">
                  <button v-if="!selectedBase.protected" class="btn small outline" type="button" @click="$emit('open-base-editor', selectedBase)"><Icon name="pencil" :size="14" />设置</button>
                  <button class="btn small outline" type="button" :disabled="baseBusy || activeIndexJob" @click="$emit('rebuild-base')"><Icon name="refresh" :size="14" :class="{ 'icon-spin': baseBusy }" />{{ activeIndexJob ? '构建中…' : '重建索引' }}</button>
                  <IconButton v-if="!selectedBase.protected" icon="trash" tone="danger" tip="删除知识库" @click="$emit('delete-base', selectedBase)" />
                </div>
              </div>
              <div class="knowledge-health-row">
                <StatusDot :state="baseHealth(selectedBase).state" :label="baseHealth(selectedBase).label" :tip="selectedBase.index?.error" />
                <span class="badge">{{ selectedBase.stats?.documents || 0 }} 篇内容</span>
                <span class="badge">{{ selectedBase.stats?.chunks || 0 }} 个分块</span>
                <span class="badge">{{ selectedBase.stats?.characters || 0 }} 字符</span>
                <span class="badge accent">{{ selectedBase.config?.embeddingModel || 'FTS5 全文检索' }}</span>
              </div>
              <div v-if="selectedBase.index?.error" class="hint-banner warn"><Icon name="alert" :size="14" /><span>{{ selectedBase.index.error }}</span></div>
            </div>

            <div class="segmented knowledge-pane-switch" aria-label="当前知识库操作">
              <button v-for="item in basePaneItems" :key="item.value" type="button" :class="{ active: activeBasePane === item.value }" @click="$emit('set-base-pane', item.value)"><Icon :name="item.icon" :size="13" />{{ item.label }}<span v-if="item.badge" class="badge">{{ item.badge }}</span></button>
            </div>

            <section v-if="activeBasePane === 'documents'" class="knowledge-pane">
              <div class="knowledge-pane-head"><div><div class="section-title"><Icon name="file" :size="13" />内容列表</div><p class="muted tiny">内置指令库会在指令后显示插件、文件和方法，并保留一行正文摘要；点击卡片可编辑说明。</p></div><button v-if="!selectedBase.protected" class="btn primary small" type="button" @click="$emit('open-document-editor')"><Icon name="plus" :size="14" />添加内容</button></div>
              <div class="list-filter"><label class="filter-search"><Icon name="search" :size="14" /><input :value="documentQuery" type="text" placeholder="搜索标题或原文" @input="$emit('update-document-query', $event.target.value)" @keydown.enter="$emit('load-base-details')" /></label><button class="btn small outline" type="button" @click="$emit('load-base-details')"><Icon name="search" :size="14" />筛选</button></div>
              <PagedList v-if="documents.length" :rows="documents" :page-size="8" label="内容" v-slot="{ item }">
                <article class="knowledge-document-card" :class="{ 'is-editable': canEditBuiltinCommand(item) }" :tabindex="canEditBuiltinCommand(item) ? 0 : undefined" :role="canEditBuiltinCommand(item) ? 'button' : undefined" @click="$emit('open-builtin-command', item)" @keydown.enter.prevent="$emit('open-builtin-command', item)" @keydown.space.prevent="$emit('open-builtin-command', item)">
                  <div class="item-head"><div><div class="knowledge-document-title-row"><div class="item-title">{{ item.title }}</div><div v-if="selectedBase.id === 'builtin-commands' && documentOrigin(item)" class="knowledge-command-origin-inline"><span><b>插件</b><strong>{{ documentOrigin(item).plugin }}</strong></span><span><b>文件</b><code>{{ documentOrigin(item).file }}</code></span><span><b>方法</b><code>{{ documentOrigin(item).method }}</code></span></div></div><p v-if="selectedBase.id !== 'builtin-commands'" class="muted tiny">{{ item.source_type }} · {{ item.chunks }} 个分块 · {{ item.characters }} 字符</p></div><div v-if="!selectedBase.protected" class="row-actions"><IconButton icon="pencil" tone="accent" tip="编辑完整原文" @click="$emit('open-document-editor', item)" /><IconButton icon="trash" tone="danger" tip="删除内容" @click="$emit('delete-document', item)" /></div></div>
                  <p class="knowledge-document-preview" :class="{ 'knowledge-command-preview': selectedBase.id === 'builtin-commands' }">{{ item.preview || '内容为空' }}</p>
                </article>
              </PagedList>
              <div v-else class="provider-empty-state"><Icon name="file" :size="24" /><strong>{{ documentQuery ? '没有匹配内容' : '这个知识库还没有内容' }}</strong><p>{{ selectedBase.protected ? '内置内容由机器人指令扫描维护。' : '添加第一篇内容后即可使用全文检索。' }}</p><button v-if="!selectedBase.protected && !documentQuery" class="btn primary small" type="button" @click="$emit('open-document-editor')">添加内容</button></div>
            </section>

            <section v-else-if="activeBasePane === 'retrieval'" class="knowledge-pane">
              <div class="knowledge-pane-head"><div><div class="section-title"><Icon name="search" :size="13" />召回测试</div><p class="muted tiny">像真实用户一样提问，确认命中的来源、原文和排序。</p></div></div>
              <div class="knowledge-search-box"><Field label="测试问题" v-model="draft.retrievalQuery" placeholder="例如：退换货需要准备什么？" @enter="$emit('test-retrieval')" /><button class="btn primary" type="button" :disabled="baseBusy" @click="$emit('test-retrieval')"><Icon name="play" :size="14" />{{ baseBusy ? '检索中…' : '开始测试' }}</button></div>
              <div v-if="retrievalResults.length" class="knowledge-result-list">
                <article v-for="(item, index) in retrievalResults" :key="item.id" class="knowledge-result-card"><div class="item-head"><div class="item-title">{{ index + 1 }}. {{ item.title }}</div><span class="badge accent">{{ item.source || selectedBase.name }}</span></div><p>{{ item.content }}</p></article>
              </div>
              <div v-else class="provider-empty-state"><Icon name="search" :size="24" /><strong>还没有测试结果</strong><p>测试后会展示实际命中的原文，方便快速发现内容或索引问题。</p></div>
            </section>

            <section v-else-if="activeBasePane === 'grants'" class="knowledge-pane">
              <div class="knowledge-pane-head"><div><div class="section-title"><Icon name="key" :size="13" />访问授权</div><p class="muted tiny">群限定规则只在对应群生效；拒绝规则始终优先。</p></div><button class="btn primary small" type="button" @click="$emit('open-grant-editor')"><Icon name="plus" :size="14" />添加规则</button></div>
              <div v-if="grants.length" class="knowledge-grant-list">
                <div v-for="item in grants" :key="item.id" class="knowledge-grant-row"><div><div class="item-title">{{ item.principal_type }} · {{ item.principal_id }}</div><p class="muted tiny">{{ item.group_id ? '仅群 ' + item.group_id : '所有会话范围' }}</p></div><div class="row"><span v-if="item.principal_type === 'role' && item.principal_id === 'master'" class="badge accent">固定</span><span class="badge" :class="item.access === 'deny' ? 'risk-high' : 'on'">{{ item.access === 'deny' ? '拒绝' : '允许' }}</span><IconButton v-if="!(item.principal_type === 'role' && item.principal_id === 'master')" icon="trash" tone="danger" tip="删除规则" @click="$emit('delete-grant', item)" /></div></div>
              </div>
              <div v-else class="provider-empty-state"><Icon name="key" :size="24" /><strong>没有授权规则</strong><p>没有任何规则时，聊天用户无法检索这个知识库。</p></div>
            </section>

            <section v-else class="knowledge-pane">
              <div class="knowledge-pane-head"><div><div class="section-title"><Icon name="activity" :size="13" />索引任务</div><p class="muted tiny">按最近执行时间排序，每页 10 条；已结束记录保留 7 天，超期任务自动取消。</p></div><button class="btn primary small" type="button" :disabled="baseBusy || activeIndexJob" @click="$emit('rebuild-base')"><Icon name="refresh" :size="14" />{{ activeIndexJob ? '构建中…' : '重建当前库' }}</button></div>
              <div v-if="!selectedBase.config?.embeddingModel" class="hint-banner ok"><Icon name="info" :size="14" /><span>当前使用 FTS5 全文检索，不需要 embedding 模型和向量任务。</span></div>
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
