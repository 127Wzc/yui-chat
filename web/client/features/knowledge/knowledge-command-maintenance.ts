// 内置指令知识库维护抽屉：展示采集、检索和质量分区，动作由父组件统一处理。
export const KnowledgeCommandMaintenance = {
  name: "KnowledgeCommandMaintenance",
  props: {
    open: { type: Boolean, default: false },
    activePane: { type: String, default: "commands" },
    paneItems: { type: Array, default: () => [] },
    draft: { type: Object, required: true },
    digestMetrics: { type: Array, default: () => [] },
    digestPills: { type: Array, default: () => [] },
    pluginPills: { type: Array, default: () => [] },
    recommendationSections: { type: Array, default: () => [] },
    knowledgeSummary: { type: Object, default: () => ({}) },
    embeddingModelOptions: { type: Array, default: () => [] },
    activeIndexJob: { type: Object, default: null },
    visibleIndexJob: { type: Object, default: null },
    qualityMetrics: { type: Array, default: () => [] },
    recommendations: { type: Array, default: () => [] },
    weakCommands: { type: Array, default: () => [] },
    jobProgressTone: { type: Function, required: true },
    jobProgressLabel: { type: Function, required: true },
    jobProgress: { type: Function, required: true },
    jobLabel: { type: Function, required: true },
    recConfidenceTone: { type: Function, required: true },
    canDelete: { type: Function, required: true },
  },
  emits: [
    "close",
    "set-pane",
    "open-exclusion",
    "open-manual",
    "open-manual-item",
    "search",
    "rescan",
    "open-capture",
    "save-command-retrieval",
    "request-delete-command",
  ],
  template: `
    <SideDrawer
      :open="open"
      title="维护内置指令知识库"
      subtitle="集中维护机器人指令、采集状态、收录示例和质量问题。"
      icon="book"
      width="960px"
      modal
      @close="$emit('close')"
    >
      <div class="command-maintenance-shell">
        <div class="segmented command-maintenance-tabs" aria-label="内置指令知识库维护分区">
          <button v-for="item in paneItems" :key="item.value" type="button" :class="{ active: activePane === item.value }" @click="$emit('set-pane', item.value)"><Icon :name="item.icon" :size="13" />{{ item.label }}</button>
        </div>

        <section v-if="activePane === 'commands'" class="command-maintenance-pane">
          <div class="knowledge-pane-head">
            <div><div class="section-title"><Icon name="book" :size="13" />指令与收录示例</div><p class="muted tiny">检索已收录指令，并补充扫描不到或说明较弱的示例。</p></div>
            <div class="row"><button class="btn small outline" type="button" @click="$emit('open-exclusion')"><Icon name="filter" :size="14" />排除规则</button><button class="btn primary small" type="button" @click="$emit('open-manual')"><Icon name="plus" :size="14" />补充说明</button></div>
          </div>
          <MetricGrid :items="digestMetrics" compact />
          <PillList :items="digestPills" />
          <Collapse v-if="pluginPills.length" title="插件指令分布" :hint="pluginPills.length + ' 个插件'"><PillList :items="pluginPills" list-class="digest-pills" /></Collapse>
          <div class="command-maintenance-search"><Field label="检索意图" v-model="draft.query" @enter="$emit('search')" /><button class="btn primary" type="button" @click="$emit('search')"><Icon name="search" :size="14" />检索</button><button class="btn outline" type="button" @click="$emit('rescan')"><Icon name="refresh" :size="14" />重扫指令</button></div>
          <div v-if="recommendationSections.length" class="list">
            <div v-for="section in recommendationSections" :key="section.key" class="item subtle">
              <div class="section-title"><Icon name="filter" :size="13" />{{ section.title }}<span class="muted tiny">{{ section.items.length }} 条</span></div>
              <div class="list command-recommendation-list">
                <div v-for="item in section.items" :key="item.id || item._order" class="item subtle" :data-tip="'理由：' + (item.recommendation?.reason || item.reason || '匹配指令知识库')">
                  <div class="item-head"><div class="item-title truncate">{{ item._order + '. ' + (item.recommendation?.command || item.suggestedCommand || item.fnc || '未知指令') }}</div><span class="badge" :class="recConfidenceTone(item.recommendation?.confidence) || (item.recommendation?.confidence === 'high' ? 'on' : '')">{{ item.recommendation?.confidence || 'match' }}</span></div>
                  <p class="muted tiny">{{ item.pluginName || item.pluginKey || 'unknown' }}</p>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="provider-empty-state command-maintenance-empty"><Icon name="search" :size="23" /><strong>输入需求查看收录示例</strong><p>会展示推荐指令、匹配理由和下一步。</p></div>
        </section>

        <section v-else-if="activePane === 'overview'" class="command-maintenance-pane">
          <div class="knowledge-pane-head">
            <div><div class="section-title"><Icon name="sparkles" :size="13" />采集概览</div><p class="muted tiny">查看扫描结果、动态采集状态和当前收录方式。</p></div>
            <div class="row"><button class="btn small outline" type="button" @click="$emit('open-capture')"><Icon name="sliders" :size="14" />编辑策略</button><button class="btn primary small" type="button" @click="$emit('rescan')"><Icon name="refresh" :size="14" />重新扫描</button></div>
          </div>
          <div class="knowledge-value-card" :class="knowledgeSummary.tone">
            <span class="scenario-icon"><Icon :name="knowledgeSummary.tone === 'ready' ? 'check' : (knowledgeSummary.tone === 'warn' ? 'refresh' : 'book')" :size="19" /></span>
            <div><h3>{{ knowledgeSummary.title }}</h3><p>{{ knowledgeSummary.detail }}</p></div>
          </div>
          <MetricGrid :items="digestMetrics" compact />
          <PillList :items="[
            { label: draft.enabled === 'true' ? '知识库开' : '知识库关', active: draft.enabled === 'true' },
            { label: draft.dynamicCapture === 'true' ? '动态捕获开' : '动态捕获关', active: draft.dynamicCapture === 'true' },
            { label: '最大事件 ' + draft.maxEvents, tone: 'accent' },
            ...digestPills
          ]" />
          <div class="command-retrieval-card">
            <div class="knowledge-pane-head">
              <div><div class="section-title"><Icon name="search" :size="13" />指令检索方式</div><p class="muted tiny">全文匹配保留精确命令，配置向量模型后补充语义召回。</p></div>
              <span class="badge" :class="draft.commandEmbeddingModel ? 'accent' : ''">{{ draft.commandEmbeddingModel ? '混合召回' : '全文检索' }}</span>
            </div>
            <div class="form-grid dense">
              <Field label="向量模型" type="select" :options="embeddingModelOptions" v-model="draft.commandEmbeddingModel" tip="先在“模型与回复 → 模型服务”中将 BGE-M3 标记为向量模型。" />
              <Field v-if="draft.commandEmbeddingModel" label="向量维度" type="number" v-model="draft.commandEmbeddingDimensions" tip="BGE-M3 固定 1024 维。" />
            </div>
            <div class="row row-end"><button class="btn primary small" type="button" :disabled="activeIndexJob" @click="$emit('save-command-retrieval')"><Icon name="save" :size="14" />{{ activeIndexJob ? '索引构建中…' : '保存并构建语义索引' }}</button></div>
          </div>
          <div v-if="visibleIndexJob" class="knowledge-index-progress-card" :class="jobProgressTone(visibleIndexJob)">
            <div class="knowledge-index-progress-head">
              <div><div class="section-title"><Icon :name="activeIndexJob ? 'activity' : (visibleIndexJob.status === 'completed' ? 'check' : 'alert')" :size="13" />语义索引进度</div><p class="muted tiny">{{ jobProgressLabel(visibleIndexJob) }}</p></div>
              <div class="row"><StatusDot :state="jobProgressTone(visibleIndexJob) === 'bad' ? 'bad' : (jobProgressTone(visibleIndexJob) === 'done' ? 'on' : 'warn')" :label="jobLabel(visibleIndexJob.status)" /><span class="badge" :class="jobProgressTone(visibleIndexJob) === 'bad' ? 'risk-medium' : (jobProgressTone(visibleIndexJob) === 'done' ? 'on' : 'accent')">{{ jobProgress(visibleIndexJob) }}%</span></div>
            </div>
            <div class="knowledge-index-progress-track"><span :class="{ done: jobProgressTone(visibleIndexJob) === 'done', bad: jobProgressTone(visibleIndexJob) === 'bad' }" :style="{ width: jobProgress(visibleIndexJob) + '%' }"></span></div>
            <div class="knowledge-index-progress-meta"><span>{{ jobProgressLabel(visibleIndexJob) }}</span><span v-if="visibleIndexJob.progress?.total">{{ visibleIndexJob.progress.processed || 0 }} / {{ visibleIndexJob.progress.total }} 个分块</span><span v-else>{{ jobLabel(visibleIndexJob.status) }}</span></div>
            <p v-if="visibleIndexJob.error" class="knowledge-job-error">{{ visibleIndexJob.error }}</p>
          </div>
          <div class="command-example-block"><div class="section-title"><Icon name="message" :size="13" />收录示例</div><div class="knowledge-example"><span>用户说</span><p>“怎么查今天的体力？”</p><Icon name="chevron-right" :size="14" /><span>助手推荐</span><p><code>#体力</code>，并说明参数和下一步。</p></div></div>
          <Collapse v-if="pluginPills.length" title="插件指令分布" :hint="pluginPills.length + ' 个插件'"><PillList :items="pluginPills" list-class="digest-pills" /></Collapse>
        </section>

        <section v-else class="command-maintenance-pane">
          <div class="knowledge-pane-head">
            <div><div class="section-title"><Icon name="activity" :size="13" />收录质量</div><p class="muted tiny">集中定位薄弱说明、缺失示例和动态观察条目。</p></div>
            <button class="btn small outline" type="button" @click="$emit('rescan')"><Icon name="refresh" :size="14" />刷新质量</button>
          </div>
          <MetricGrid :items="qualityMetrics" compact />
          <PagedList v-if="recommendations.length" :rows="recommendations" :page-size="4" label="建议" v-slot="{ item }"><div class="item subtle"><p class="muted small">{{ item }}</p></div></PagedList>
          <PagedList :rows="weakCommands" :page-size="6" label="薄弱指令" empty="暂无明显薄弱指令。" v-slot="{ item }">
            <div class="item subtle" :data-tip="item.description || item.fnc || ''">
              <div class="item-head"><div class="item-title truncate">{{ item.pluginName || item.pluginKey || 'unknown' }}</div><div class="row"><span class="badge" :class="item.qualityScore >= 80 ? 'on' : 'risk-medium'">{{ (item.qualityScore || 0) + ' 分' }}</span><IconButton icon="pencil" tip="二次编辑并重新入库" @click="$emit('open-manual-item', item)" /><IconButton v-if="canDelete(item)" icon="trash" tone="danger" tip="删除知识条目" @click="$emit('request-delete-command', item)" /></div></div>
              <PillList :items="(item.issues || []).map(i => ({ label: i, tone: 'risk-medium' }))" />
              <p class="muted tiny">建议：{{ item.suggestedCommand || item.example || '缺少示例' }}</p>
            </div>
          </PagedList>
        </section>
      </div>
      <template #actions><button class="btn outline" type="button" @click="$emit('close')"><Icon name="x" :size="14" />关闭</button></template>
    </SideDrawer>
  `,
}
