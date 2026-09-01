// 记忆提炼工作区：按日状态、原始消息和运行记录共用父组件的加载与操作状态。
export const MemoryExtractionWorkspace = {
  name: "MemoryExtractionWorkspace",
  props: {
    view: { type: Object, required: true },
  },
  template: `
    <template v-if="view.activeWorkspace === 'extract'">
      <header class="group-memory-toolbar extraction-toolbar">
        <div class="group-picker">
          <span class="group-picker-label">当前群聊</span>
          <button class="group-picker-trigger" type="button" :aria-expanded="view.showGroupPicker" @click="view.showGroupPicker = !view.showGroupPicker"><span class="truncate">{{ view.selectedPolicy ? view.policyTitle(view.selectedPolicy) : '选择已采集的群' }}</span><span v-if="view.selectedPolicy" class="status-dot" :class="{ paused: !view.selectedPolicy.enabled }"></span><Icon name="chevron-down" :size="16" /></button>
          <div v-if="view.showGroupPicker" class="group-picker-menu">
            <label class="memory-search"><Icon name="search" :size="14" /><input v-model="view.groupPickerQuery" type="search" placeholder="搜索群号" autofocus /></label>
            <div v-for="policy in view.filteredPolicies" :key="policy.scopeId" class="group-picker-item" :class="[{ active: policy.scopeId === view.selectedGroupId }, policy.enabled ? 'is-running' : 'is-paused']"><button class="group-picker-option" type="button" @click="view.selectGroup(policy)"><span class="status-dot" :class="{ paused: !policy.enabled }"></span><span class="truncate">{{ view.policyTitle(policy) }}</span><small class="group-picker-state">{{ policy.enabled ? '采集中' : '已暂停' }}</small></button><button class="icon-btn sm group-picker-edit" type="button" data-tip="编辑采集设置" @click.stop="view.openCaptureSettings(policy)"><Icon name="pencil" :size="14" /></button></div>
          </div>
        </div>
        <span v-if="view.selectedPolicy" class="extraction-policy-summary">{{ view.selectedPolicy.retentionDays ? view.selectedPolicy.retentionDays + ' 天保留' : '永久保留' }} · 每日提炼 · {{ view.compactNumber(view.selectedPolicy.tokenLimit) }} Token/子窗口 · {{ view.selectedPolicy.modelName || '默认对话模型' }} · {{ view.policyOverrideSummary(view.selectedPolicy) }}</span>
        <button class="icon-btn" type="button" :disabled="view.captureBusy" data-tip="刷新消息和提炼任务" @click="view.loadExtractionWorkspace()"><Icon name="refresh" :size="16" :class="{ 'icon-spin': view.captureBusy }" /></button>
      </header>

      <div v-if="view.selectedPolicy" class="extraction-workspace">
        <nav class="extraction-subtabs" aria-label="提炼数据视图"><button type="button" :class="{ active: view.extractionPane === 'timeline' }" @click="view.extractionPane = 'timeline'">按日提炼 <span>{{ view.timelineWindows.length }}</span></button><button type="button" :class="{ active: view.extractionPane === 'messages' }" @click="view.extractionPane = 'messages'">原始消息 <span>{{ view.captureMessages.total }}</span></button><button type="button" :class="{ active: view.extractionPane === 'tasks' }" @click="view.extractionPane = 'tasks'">运行记录 <span>{{ view.extractionCounts.windows }}</span></button></nav>
        <p class="extraction-boundary-note"><Icon name="info" :size="14" />原始消息用于核对与提炼；只有提炼结果会进入记忆管理和正常召回。</p>
        <div v-if="view.extractionPane !== 'messages'" class="window-selection-toolbar" :class="{ active: view.windowSelectionMode }">
          <button class="btn small outline" type="button" @click="view.toggleWindowSelectionMode"><Icon :name="view.windowSelectionMode ? 'x' : 'check'" :size="14" />{{ view.windowSelectionMode ? '退出选择' : '选择窗口' }}</button>
          <template v-if="view.windowSelectionMode">
            <span>已选 <b>{{ view.selectedWindowStarts.length }}</b> 个 · {{ view.compactNumber(view.selectedWindowSummary.messages) }} 条消息 · 约 {{ view.compactNumber(view.selectedWindowSummary.tokens) }} Token</span>
            <div class="row">
              <button class="btn small outline" type="button" @click="view.selectVisibleWindows('all')">选择当前视图</button>
              <button class="btn small outline" type="button" @click="view.selectVisibleWindows('unprocessed')">选择尚未提炼</button>
              <button class="btn small outline" type="button" @click="view.selectVisibleWindows('needs')">选择需重提炼</button>
              <button class="btn small outline" type="button" @click="view.selectVisibleWindows('failed')">选择失败窗口</button>
              <button class="btn small outline" type="button" :disabled="!view.selectedWindowStarts.length" @click="view.clearWindowSelection">清空</button>
              <button class="btn primary small" type="button" :disabled="!view.selectedWindowStarts.length || !view.selectedPolicy.enabled || view.captureAction === 'reextract-selection'" @click="view.confirmSelectedWindows()"><Icon name="sparkles" :size="14" />{{ view.captureAction === 'reextract-selection' ? '正在入队…' : '提炼选中窗口' }}</button>
            </div>
          </template>
        </div>

        <section v-if="view.extractionPane === 'timeline'" class="timeline-workbench">
          <header class="timeline-head calendar-head">
            <div><h2>按日提炼覆盖</h2><p>{{ view.calendarSummary.days }} 天有消息 · {{ view.compactNumber(view.calendarSummary.messages) }} 条消息 · 形成 {{ view.compactNumber(view.calendarSummary.memories) }} 条记忆；每天仅在隔天后入队。</p></div>
            <div class="calendar-head-actions">
              <div class="segmented calendar-range-tabs" role="group" aria-label="日历时间范围"><button type="button" :aria-pressed="view.calendarRange === '30d'" :class="{ active: view.calendarRange === '30d' }" @click="view.calendarRange = '30d'">近 30 天</button><button type="button" :aria-pressed="view.calendarRange === '90d'" :class="{ active: view.calendarRange === '90d' }" @click="view.calendarRange = '90d'">近 90 天</button><button type="button" :aria-pressed="view.calendarRange === 'year'" :class="{ active: view.calendarRange === 'year' }" @click="view.calendarRange = 'year'">近一年</button></div>
              <button class="btn primary small" type="button" :disabled="!view.selectedPolicy.enabled" @click="view.openReextractDialog"><Icon name="sparkles" :size="14" />按时间段重提炼</button>
            </div>
          </header>
          <div class="calendar-meta-row">
            <div class="timeline-legend calendar-status-legend"><span class="is-memory">已形成记忆</span><span class="is-no-result">已提炼无结果</span><span class="is-unprocessed">尚未提炼</span><span class="is-failed">处理失败</span><span class="is-empty">无消息</span></div>
            <div class="calendar-metric-control"><span>深浅表示</span><div class="segmented calendar-metric-tabs" role="group" aria-label="日历强度指标"><button type="button" :aria-pressed="view.calendarMetric === 'messages'" :class="{ active: view.calendarMetric === 'messages' }" @click="view.calendarMetric = 'messages'">消息</button><button type="button" :aria-pressed="view.calendarMetric === 'tokens'" :class="{ active: view.calendarMetric === 'tokens' }" @click="view.calendarMetric = 'tokens'">Token</button><button type="button" :aria-pressed="view.calendarMetric === 'memories'" :class="{ active: view.calendarMetric === 'memories' }" @click="view.calendarMetric = 'memories'">记忆</button></div></div>
          </div>
          <div v-if="view.calendarBusy || view.captureBusy" class="calendar-loading"><Icon name="refresh" :size="16" class="icon-spin" /><span>正在加载按日状态…</span></div>
          <div v-else-if="view.calendarWeeks.length" class="memory-calendar" role="group" :aria-label="'按日记忆提炼日历，颜色表示处理结果，深浅表示' + view.calendarMetricLabel">
            <div class="calendar-weekday-labels" aria-hidden="true"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
            <div :ref="view.setCalendarWeeksElement" class="calendar-weeks" @scroll.passive="view.handleCalendarScroll">
              <div v-for="week in view.calendarWeeks" :key="week.start" class="calendar-week">
                <span class="calendar-month-label" aria-hidden="true">{{ week.label }}</span>
                <button v-for="item in week.days" :key="item.day" type="button" :disabled="item.outOfRange" :aria-label="view.calendarDayAriaLabel(item)" :aria-current="item.day === view.calendarMeta.todayDay ? 'date' : undefined" :aria-pressed="view.windowSelectionMode ? view.isWindowSelected(item) : undefined" :class="[view.calendarDayClass(item), { active: !view.windowSelectionMode && view.selectedTimelineWindow?.day === item.day, 'is-selecting': view.windowSelectionMode }]" :title="view.calendarDayTitle(item)" @click="view.windowSelectionMode ? view.toggleWindowSelection(item) : view.selectTimelineWindow(item)">
                  <Icon v-if="item.needsReextract" name="refresh" :size="8" />
                  <Icon v-else-if="view.calendarStatus(item).key === 'memory'" name="check" :size="8" />
                  <Icon v-else-if="view.calendarStatus(item).key === 'no_result'" name="info" :size="8" />
                  <Icon v-else-if="view.calendarStatus(item).key === 'failed'" name="alert" :size="8" />
                  <Icon v-else-if="view.calendarStatus(item).key === 'unprocessed'" :name="item.windowStatus === 'running' ? 'activity' : 'clock'" :size="8" />
                  <span v-if="view.isWindowSelected(item)" class="calendar-select-mark" aria-hidden="true"><Icon name="check" :size="8" /></span>
                  <span class="calendar-day-number" aria-hidden="true">{{ view.dayNumber(item.day) }}</span>
                </button>
              </div>
            </div>
          </div>
          <div v-else class="memory-list-empty"><Icon name="activity" :size="20" /><span>还没有可规划的原始消息时间窗。</span></div>

          <section v-if="view.selectedTimelineWindow" class="window-inspector">
            <header><div><h3>{{ view.rangeLabel(view.selectedTimelineWindow.windowStart, view.selectedTimelineWindow.windowEnd) }} · {{ view.timelineStatus(view.selectedTimelineWindow).label }}</h3><p>{{ view.selectedTimelineWindow.sourceMessageCount || view.selectedTimelineWindow.messageCount || 0 }} 条消息 · 预计 {{ view.compactNumber(view.selectedTimelineWindow.estimatedInputTokens) }} Token · {{ view.selectedTimelineWindow.modelCallCount || view.selectedTimelineWindow.chunkCount || 0 }} 个子窗口</p><p v-if="view.selectedTimelineWindow.skippedMessageCount" class="muted tiny">{{ view.selectedTimelineWindow.skippedMessageCount }} 条单条超限消息已保留原文，未送入模型。</p><p v-if="view.selectedTimelineWindow.needsReextract" class="batch-progress-label">该日补录了新消息，等待管理员确认后重提炼。</p></div><div class="row"><span v-if="view.selectedTimelineWindow.rawAvailable === false && view.selectedTimelineWindow.id" class="badge muted">原始消息已过期</span><span v-if="view.selectedTimelineWindow.warningCount" class="badge risk-medium">{{ view.selectedTimelineWindow.warningCount }} 条需核对</span><button v-if="(view.timelineStatus(view.selectedTimelineWindow).key === 'failed' || view.selectedTimelineWindow.needsReextract) && view.selectedTimelineWindow.canReextract !== false && view.selectedTimelineWindow.rawAvailable !== false" class="btn small outline" type="button" @click="view.reextractSingleDay(view.selectedTimelineWindow)"><Icon name="refresh" :size="14" />重提炼这一天</button></div></header>
            <div v-if="view.timelineDetailLoading" class="calendar-detail-loading"><Icon name="refresh" :size="16" class="icon-spin" /><span>正在加载这一天的原始消息和提炼结果…</span></div>
            <div v-else-if="view.timelineDetailError" class="calendar-detail-error"><Icon name="alert" :size="16" /><span>{{ view.timelineDetailError }}</span></div>
            <div v-else class="window-inspector-grid">
              <section><div class="inspector-title"><h3>原始消息（{{ view.timelineWindowDetail?.totalMessages || view.selectedWindowMessages.length }}）</h3><span>消息段按原顺序保存</span></div><div class="inspector-message-list"><article v-for="message in view.selectedWindowMessages.slice(0, 8)" :key="message.id"><time>{{ view.timeLabel(message.sentAt) }}</time><b>{{ message.senderName || message.senderId }}</b><p>{{ message.text || '非文本消息' }}</p><div><span v-for="segment in view.segmentSummary(message)" :key="segment" class="badge">{{ segment }}</span><span class="badge" :class="view.normalizationView(message).tone">{{ view.normalizationView(message).label }}</span></div></article><p v-if="!view.selectedWindowMessages.length" class="muted small">这一天没有可展示的原始文本消息。</p><p v-else-if="(view.timelineWindowDetail?.totalMessages || view.selectedWindowMessages.length) > 8" class="muted tiny">为保持浏览速度，这里展示前 8 条；原始消息总数为 {{ view.timelineWindowDetail?.totalMessages || view.selectedWindowMessages.length }} 条。</p></div></section>
              <section><div class="inspector-title"><h3>提炼结果（{{ view.selectedTimelineWindow.memoryResultCount ?? view.selectedTimelineWindow.result?.length ?? 0 }}）</h3><span>新增、强化或修改现有事实</span></div><div class="inspector-result-list"><article v-for="result in view.selectedTimelineWindow.result || []" :key="result.id"><div><span class="badge" :class="view.resultAction(result).tone">{{ view.resultAction(result).label }}</span><span class="badge">{{ view.extractionScopeLabel(result.scopeType) }}</span></div><p>{{ result.text }}</p><small>证据：{{ result.evidenceMessageIds?.join('、') || '无' }}</small></article><p v-if="view.selectedTimelineWindow.truncated" class="muted tiny">结果较多，当前展示前 {{ view.selectedTimelineWindow.result?.length || 0 }} 条，另有 {{ view.selectedTimelineWindow.omittedItemCount || 0 }} 条未展开；汇总共形成 {{ view.selectedTimelineWindow.memoryResultCount || 0 }} 条记忆。</p><p v-else-if="!view.selectedTimelineWindow.result?.length" class="muted small">{{ view.timelineStatus(view.selectedTimelineWindow).key === 'failed' ? (view.selectedTimelineWindow.errorMessage || '这一天处理失败，尚未形成可复用记忆。') : view.timelineStatus(view.selectedTimelineWindow).key === 'no_result' ? '已完成提炼，但没有发现可复用的新事实。' : view.timelineStatus(view.selectedTimelineWindow).key === 'empty' ? '这一天没有原始消息。' : '这一天尚未形成可复用记忆，或仍在等待提炼。' }}</p></div></section>
            </div>
          </section>
        </section>

        <section v-else-if="view.extractionPane === 'messages'" class="extraction-list-pane">
          <header class="extraction-pane-toolbar">
            <div><h2>原始消息</h2><p>实时采集与历史补录都进入同一份原始记录，并按群号和消息 ID 去重。</p></div>
            <div class="extraction-inline-operation">
              <label class="compact-number-field"><span>补录最近</span><input class="input" type="number" min="1" :max="view.backfillLimitMax" step="10" v-model="view.historyBackfillLimit" /><span>条</span></label>
              <label class="compact-number-field"><span>起始消息 ID</span><input class="input" type="text" placeholder="可选，从该消息向前" v-model="view.historyBackfillFrom" /></label>
              <button class="btn small outline" type="button" :disabled="view.captureAction === 'backfill' || view.captureBusy || !view.selectedPolicy.enabled" @click="view.backfillHistory()"><Icon name="download" :size="14" />{{ view.captureAction === 'backfill' ? '补录中…' : '补录历史' }}</button>
              <button v-if="(view.selectedPolicy.messageCount || 0) > 0" class="btn small outline" type="button" :disabled="view.captureAction === 'backfill' || view.captureBusy || !view.selectedPolicy.enabled" title="从本群已保存的最早一条消息继续向前拉取更早历史" @click="view.backfillHistory({ continueFromOldest: true })"><Icon name="history" :size="14" />继续向前补录</button>
            </div>
          </header>
          <div v-if="view.captureAction === 'backfill' || view.selectedPolicy.backfill?.status" class="extraction-operation-status" :class="{ 'is-error': view.selectedPolicy.backfill?.status === 'failed' }">
            <span class="badge" :class="view.selectedPolicy.backfill?.status === 'completed' ? 'on' : (view.selectedPolicy.backfill?.status === 'failed' ? 'risk-high' : 'risk-medium')">{{ view.captureAction === 'backfill' ? '补录中' : view.backfillStatusLabel(view.selectedPolicy.backfill?.status) }}</span>
            <p v-if="view.captureAction === 'backfill'">正在从宿主读取近期群历史并保存，完成后会自动刷新列表。</p>
            <p v-else-if="view.selectedPolicy.backfill?.status === 'completed'">{{ view.timeLabel(view.selectedPolicy.backfill?.at) }} · 请求 {{ view.selectedPolicy.backfill?.requested || 0 }} 条，返回 {{ view.selectedPolicy.backfill?.received || 0 }} 条，新增 {{ view.selectedPolicy.backfill?.saved || 0 }} 条。</p>
            <p v-else>{{ view.selectedPolicy.backfill?.error || '最近一次补录未完成。' }}</p>
          </div>
          <div class="memory-list-tools"><label class="memory-search"><Icon name="search" :size="14" /><input v-model="view.captureMessageQuery" type="search" placeholder="搜索发言人、消息 ID 或正文" /></label><span class="muted tiny">{{ view.captureMessages.total }} 条</span></div>
          <div class="raw-message-table"><div class="raw-message-table-head"><span>时间</span><span>发言人</span><span>消息摘要</span><span>消息段</span><span>规范状态</span></div><details v-for="item in view.captureMessages.items" :key="item.id"><summary><time>{{ view.timeLabel(item.sentAt) }}</time><b>{{ item.senderName || item.senderId }}</b><p>{{ item.text || '非文本消息' }}</p><span class="segment-chip-list"><small v-for="segment in view.segmentSummary(item)" :key="segment">{{ segment }}</small></span><span class="badge" :class="view.normalizationView(item).tone">{{ view.normalizationView(item).label }}</span></summary><div class="raw-message-detail"><span>消息 ID：{{ item.messageId }}</span><button class="btn small outline" type="button" :disabled="view.captureAction === 'backfill' || view.captureBusy || !view.selectedPolicy.enabled" title="以这条消息为起点，按上方设置的条数向前拉取更早历史" @click="view.backfillFromMessage(item)"><Icon name="download" :size="13" />从此消息向前补录</button><span v-if="item.replyMessageId">回复：{{ item.replyMessageId }}</span><p v-if="item.normalization?.issues?.length">{{ item.normalization.issues.join('；') }}</p><pre class="code-block">{{ JSON.stringify(item.segments, null, 2) }}</pre></div></details></div>
          <div v-if="view.captureMessages.total > view.captureMessages.pageSize" class="memory-pagebar"><span>第 {{ view.captureMessages.page }} / {{ Math.ceil(view.captureMessages.total / view.captureMessages.pageSize) }} 页</span><div><button class="icon-btn sm" type="button" :disabled="view.captureMessages.page <= 1 || view.captureBusy" @click="view.changeCaptureMessagePage(view.captureMessages.page - 1)"><Icon name="chevron-left" :size="15" /></button><button class="icon-btn sm" type="button" :disabled="view.captureMessages.page >= Math.ceil(view.captureMessages.total / view.captureMessages.pageSize) || view.captureBusy" @click="view.changeCaptureMessagePage(view.captureMessages.page + 1)"><Icon name="chevron-right" :size="15" /></button></div></div>
        </section>

        <section v-else class="extraction-list-pane">
          <header class="extraction-pane-toolbar">
            <div><h2>提炼运行记录</h2><p>按窗口日期从新到旧分页；扫描时仅自动入队昨天及更早的自然日。</p></div>
            <button class="btn primary small" type="button" :disabled="view.captureAction === 'extract' || view.captureBusy || !view.selectedPolicy.enabled" @click="view.queueExtraction"><Icon name="sparkles" :size="14" />{{ view.captureAction === 'extract' ? '发起中…' : '扫描昨日及历史' }}</button>
          </header>
          <div class="capture-progress-grid"><span><b>{{ view.selectedPolicy.windowProgress?.pending || 0 }}</b> 等待处理</span><span><b>{{ view.selectedPolicy.windowProgress?.running || 0 }}</b> 正在提炼</span><span><b>{{ view.selectedPolicy.windowProgress?.completed || 0 }}</b> 已完成</span><span :class="{ danger: view.selectedPolicy.windowProgress?.failed }"><b>{{ view.selectedPolicy.windowProgress?.failed || 0 }}</b> 失败</span></div>
          <p v-if="view.captureAction === 'extract'" class="extraction-operation-status"><span class="badge risk-medium">正在创建任务</span><span>页面会自动刷新各时间窗的处理状态。</span></p>
          <div v-if="view.captureWindows.length" class="extraction-task-list"><button v-for="item in view.runRecordWindows" :key="item.id" type="button" :aria-pressed="view.windowSelectionMode ? view.isWindowSelected(item) : undefined" :class="{ 'is-running': item.status === 'running', 'is-failed': item.status === 'failed', 'is-selected': view.isWindowSelected(item), 'is-selecting': view.windowSelectionMode }" @click="view.openRunWindow(item)"><em v-if="view.windowSelectionMode" class="window-select-mark">{{ view.isWindowSelected(item) ? '✓' : '' }}</em><span class="badge" :class="item.status === 'completed' ? 'on' : (item.status === 'failed' ? 'risk-high' : 'risk-medium')">{{ view.windowStatusLabel(item.status) }}</span><strong>{{ view.rangeLabel(item.windowStart, item.windowEnd) }}</strong><p>{{ item.sourceMessageCount }} 条 · {{ view.compactNumber(item.estimatedInputTokens) }} Token · {{ item.modelCallCount || item.chunkCount || 0 }} 个子窗口</p><small>{{ view.taskListSummary(item) }}</small><Icon :name="view.isWindowSelected(item) ? 'check' : 'chevron-right'" :size="15" /></button></div>
          <div v-else class="memory-list-empty"><Icon name="activity" :size="20" /><span>还没有提炼任务，可扫描已有原始消息后开始。</span></div>
          <div v-if="view.captureWindowPage.total > view.captureWindowPage.pageSize" class="memory-pagebar"><span>第 {{ view.captureWindowPage.page }} / {{ Math.ceil(view.captureWindowPage.total / view.captureWindowPage.pageSize) }} 页 · 共 {{ view.captureWindowPage.total }} 条</span><div><button class="icon-btn sm" type="button" :disabled="view.captureWindowPage.page <= 1 || view.captureBusy" @click="view.changeCaptureWindowPage(view.captureWindowPage.page - 1)"><Icon name="chevron-left" :size="15" /></button><button class="icon-btn sm" type="button" :disabled="view.captureWindowPage.page >= Math.ceil(view.captureWindowPage.total / view.captureWindowPage.pageSize) || view.captureBusy" @click="view.changeCaptureWindowPage(view.captureWindowPage.page + 1)"><Icon name="chevron-right" :size="15" /></button></div></div>
        </section>
      </div>
      <div v-else class="member-memory-empty group-memory-empty"><Icon name="message" :size="28" /><strong>还没有群聊采集配置</strong><p>通过右上角“采集设置”添加群号并开启采集；Token、模型和提示词统一在“全局设置”中维护。</p><button class="btn primary small" type="button" @click="view.openCaptureSettings()"><Icon name="plus" :size="14" />新增采集配置</button></div>
    </template>
  `,
}
