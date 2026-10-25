import { KnowledgeCommandWorkbench } from "./knowledge-command-workbench.js"
// 内置指令知识库维护抽屉：指令列表与独立设置，动作由父组件统一处理。
export const KnowledgeCommandMaintenance = {
  name: "KnowledgeCommandMaintenance",
  components: { KnowledgeCommandWorkbench },
  props: {
    refreshToken: { type: Number, default: 0 },
    open: { type: Boolean, default: false },
    activePane: { type: String, default: "commands" },
    paneItems: { type: Array, default: () => [] },
    draft: { type: Object, required: true },
    digestMetrics: { type: Array, default: () => [] },
    modelDimensions: { type: Number, default: 0 },
    currentDimensions: { type: Number, default: 0 },
    embeddingModelOptions: { type: Array, default: () => [] },
    activeIndexJob: { type: Object, default: null },
    visibleIndexJob: { type: Object, default: null },
    jobProgressTone: { type: Function, required: true },
    jobProgressLabel: { type: Function, required: true },
    jobProgress: { type: Function, required: true },
    jobLabel: { type: Function, required: true },
  },
  emits: [
    "close",
    "refresh",
    "availability-changed",
    "set-pane",
    "open-manual-item",
    "save-command-retrieval",
    "select-embedding-model",
    "sync-dimensions",
  ],
  template: `
    <SideDrawer
      :open="open"
      title="指令知识库"
      subtitle="采集机器人已加载的指令，整理说明后导入，让每条指令更容易被找到。"
      icon="book"
      width="960px"
      modal
      @close="$emit('close')"
    >
      <div class="command-maintenance-shell">
        <div class="command-maintenance-header">
          <div class="segmented command-maintenance-tabs" aria-label="内置指令知识库维护分区">
            <button v-for="item in paneItems" :key="item.value" type="button" :class="{ active: activePane === item.value }" @click="$emit('set-pane', item.value)"><Icon :name="item.icon" :size="13" />{{ item.label }}</button>
          </div>
          <dl v-show="activePane === 'commands'" class="command-maintenance-stats" aria-label="指令收录统计">
            <div v-for="item in digestMetrics" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div>
          </dl>
        </div>

        <section v-show="activePane === 'commands'" class="command-maintenance-pane">
          <KnowledgeCommandWorkbench v-if="open" @edit="$emit('open-manual-item', $event)" @changed="$emit('refresh')" @availability-changed="$emit('availability-changed',$event)" :refresh-token="refreshToken" />
        </section>

        <section v-show="activePane === 'settings'" class="command-maintenance-pane command-maintenance-settings">
          <div class="knowledge-pane-head"><div><div class="section-title"><Icon name="sliders" :size="13" />知识库设置</div><p class="muted tiny">维护本库的用途、字段说明、嵌入模型和指令推荐方式。共用阈值与重排在工作区“全局配置”中设置。</p></div></div>
          <div class="command-retrieval-card">
            <div class="knowledge-pane-head">
              <div><div class="section-title"><Icon name="search" :size="13" />指令检索方式</div><p class="muted tiny">统一用于帮助指令、AI 工具、自动推荐和召回测试。仅切换方式不会重建索引。</p></div>
              <span class="badge accent">{{ draft.commandRetrievalMode === 'lexical' ? '关键词推荐' : '混合推荐' }}</span>
            </div>
            <div class="form-grid dense">
              <Field label="推荐方式" type="select" :options="[{value: 'hybrid', label: '混合推荐（默认）'}, {value: 'lexical', label: '关键词推荐'}]" v-model="draft.commandRetrievalMode" tip="混合推荐结合关键词与向量；向量未配置或不可用时自动降级，并在测试结果中说明。" />
              <Field label="嵌入模型" type="select" :options="embeddingModelOptions" :model-value="draft.commandEmbeddingModel" @update:model-value="$emit('select-embedding-model', $event)" :disabled="Boolean(activeIndexJob)" tip="选择已配置的 embedding 模型；关键词模式下保留模型和已有索引。" />
              <Field v-if="draft.commandEmbeddingModel" label="当前配置维度" :model-value="currentDimensions ? currentDimensions + ' 维' : '尚未配置'" disabled tip="只读，表示已保存的维度；Cosine（余弦）固定不变。" />
              <Field v-if="draft.commandEmbeddingModel" label="所选模型默认维度" :model-value="modelDimensions ? modelDimensions + ' 维' : '模型未声明默认维度'" disabled tip="维度跟随模型配置；如未声明，请先到模型页完善。" />
            </div>
            <div v-if="draft.commandEmbeddingModel && modelDimensions && Number(draft.commandEmbeddingDimensions) !== modelDimensions" class="hint-banner warn"><span>当前设置与模型默认维度不一致。同步后保存将更新向量索引。</span><button class="btn small outline" type="button" :disabled="Boolean(activeIndexJob)" @click="$emit('sync-dimensions')">同步模型维度</button></div>
            <p v-else-if="draft.commandEmbeddingModel && Number(draft.commandEmbeddingDimensions) !== currentDimensions" class="muted tiny">待保存维度：{{ draft.commandEmbeddingDimensions }} 维；保存后更新索引。</p>
            <Field label="用途与适用场景" type="textarea" rows="3" v-model="draft.commandDescription" tip="简要介绍收录范围与适合查询的问题，供工具选库；完整用途在选中本库后提供。修改无需重建向量。" />
            <Field label="字段说明" type="textarea" rows="4" v-model="draft.commandFieldDescription" tip="统一解释 priority、regexp、regexpFlags 等字段，最多 2000 字符。每个知识库在重排和回答时只提供一次，修改无需重建向量。" />
            <div class="row row-end"><button class="btn primary small" type="button" @click="$emit('save-command-retrieval')"><Icon name="save" :size="14" />保存检索设置</button></div>
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

        </section>
      </div>
      <template #actions><button class="btn outline" type="button" @click="$emit('close')"><Icon name="x" :size="14" />关闭</button></template>
    </SideDrawer>
  `,
}
