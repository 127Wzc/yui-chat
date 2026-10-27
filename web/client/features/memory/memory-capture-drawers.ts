import { PortraitScopeDefaults } from "./memory-portrait.js"

// 复用统一 Field，来源状态和恢复动作放在控件下方，避免挤占标签行。
export const CaptureSettingField = {
  name: "CaptureSettingField",
  props: {
    view: { type: Object, required: true },
    fieldName: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, default: "number" },
    options: { type: Array, default: () => [] },
    rows: { type: Number, default: 8 },
  },
  template: `<div class="capture-setting-field"><Field :label="label" :type="type" :options="options" :rows="rows" :model-value="view.captureDraft[fieldName]" @update:model-value="value => view.updateCaptureField(fieldName, value)" :description="view.captureFieldHint(fieldName)" /><div class="capture-setting-meta"><span class="capture-setting-source" :title="'系统默认：' + view.captureDefaultLabel(fieldName)">{{ view.captureFieldSource(fieldName) }}<span v-if="!view.captureDraft.useDefault[fieldName]"> · 默认 {{ view.captureDefaultLabel(fieldName) }}</span></span><button v-if="!view.captureDraft.useDefault[fieldName]" class="btn small ghost capture-reset" type="button" :aria-label="'将' + label + '恢复为系统默认'" @click="view.resetCaptureField(fieldName)"><Icon name="refresh" :size="12" />恢复默认</button></div></div>`,
}

// 记忆页的配置、重提炼和编辑抽屉；数据与动作由 MemoryTab 统一持有。
export const MemoryCaptureDrawers = {
  name: "MemoryCaptureDrawers",
  components: { PortraitScopeDefaults, CaptureSettingField },
  props: {
    view: { type: Object, required: true },
  },
  template: `
    <SideDrawer
      :open="view.showCaptureSettings"
      :title="view.captureDraftEditing ? '编辑群聊采集配置' : '新增群聊采集配置'"
      subtitle="设置原始消息的保留与提炼。修改字段即可覆盖本群默认值。"
      icon="message"
      width="720px"
      modal
      @close="view.showCaptureSettings = false"
    >
      <div class="capture-settings-form">
        <section class="capture-global-defaults-entry">
          <p>未修改的字段会跟随系统更新。</p>
          <button class="btn small ghost" type="button" @click="view.openSystemSettings('memory-capture')">全局默认设置<Icon name="chevron-right" :size="14" /></button>
        </section>
        <section class="capture-config-section">
          <Field label="群消息采集" type="switch" v-model="view.captureDraft.enabled" description="保存本群原始消息，供后台记忆提炼与画像使用。" />
          <Field label="群号" v-model="view.captureDraft.scopeId" placeholder="输入群号" :disabled="view.captureDraftEditing" />
        </section>
        <section class="capture-config-section">
          <div class="memory-section-head"><div><h3>消息与记忆</h3><p>控制原文保留、单次提炼用量和对话召回数量。</p></div></div>
          <div class="form-grid capture-token-limits">
            <CaptureSettingField :view="view" field-name="retentionDays" label="原始消息保留天数" />
            <CaptureSettingField :view="view" field-name="tokenLimit" label="输入 Token 上限" />
            <CaptureSettingField :view="view" field-name="retrievalResultLimit" label="记忆召回条数" />
          </div>
        </section>
        <PortraitScopeDefaults v-if="view.showCaptureSettings && view.captureDraftEditing" :group-id="view.captureDraft.scopeId" />
        <section class="capture-config-section">
          <div class="memory-section-head"><div><h3>记忆提炼</h3><p>选择模型，调整输出长度与候选记忆的最低置信度。</p></div></div>
          <CaptureSettingField :view="view" field-name="modelName" label="提炼模型" type="select" :options="view.extractionModelOptions" />
          <div class="form-grid capture-token-limits">
            <CaptureSettingField :view="view" field-name="maxTokens" label="输出 Token 上限" />
            <CaptureSettingField :view="view" field-name="minConfidence" label="候选置信度阈值" />
          </div>
          <details class="capture-prompt-editor">
            <summary><span>提炼提示词<small>{{ view.captureFieldSource('promptTemplate') }}</small></span><Icon name="chevron-down" :size="15" /></summary>
            <div class="capture-prompt-body">
              <CaptureSettingField :view="view" field-name="promptTemplate" label="本群提炼提示词" type="textarea" :rows="10" />
              <details v-if="!view.captureDraft.useDefault.promptTemplate" class="capture-default-prompt"><summary>查看系统默认提示词</summary><pre>{{ view.captureDefaults.promptTemplate }}</pre></details>
            </div>
          </details>
        </section>
      </div>
      <template #actions><span v-if="view.captureDraftDirty && view.captureDraftPolicy" class="muted tiny">有未保存的修改</span><button class="btn outline" type="button" @click="view.showCaptureSettings = false"><Icon name="x" :size="14" />取消</button><button class="btn primary" type="button" :disabled="view.captureBusy" @click="view.saveCapturePolicy"><Icon name="save" :size="14" />{{ view.captureBusy ? '保存中…' : '保存配置' }}</button></template>
    </SideDrawer>

    <SideDrawer
      :open="view.showReextractDialog"
      title="规划全量重提炼"
      subtitle="选择时间段后按自然日拆分；每一天会按 Token 上限自动划分模型子窗口。"
      icon="sparkles"
      width="680px"
      modal
      @close="view.showReextractDialog = false"
    >
      <section class="reextract-dialog-body">
        <div class="form-grid two">
          <label class="field"><span class="field-label">起始时间</span><input class="input" type="datetime-local" v-model="view.reextractStart" @change="view.previewReextraction()" /></label>
          <label class="field"><span class="field-label">结束时间</span><input class="input" type="datetime-local" v-model="view.reextractEnd" @change="view.previewReextraction()" /></label>
        </div>
        <div v-if="view.reextractPlan" class="reextract-plan-summary">
          <span><b>{{ view.reextractPlan.dayCount }}</b> 个自然日</span>
          <span><b>{{ view.compactNumber(view.reextractPlan.selectedMessageCount) }}</b> 条消息</span>
          <span><b>{{ view.compactNumber(view.reextractPlan.estimatedInputTokens) }}</b> 预计 Token</span>
          <span><b>{{ view.reextractPlan.modelCallCount }}</b> 个 Token 子窗口</span>
        </div>
        <div v-if="view.reextractPlan?.windows?.length" class="reextract-mini-timeline" aria-label="受影响的时间窗预览">
          <span v-for="item in view.reextractPlan.windows.slice(-96)" :key="item.windowStart" :class="view.timelineStatus(item).tone" :title="view.rangeLabel(item.windowStart, item.windowEnd) + ' · ' + item.messageCount + ' 条消息 · ' + view.compactNumber(item.estimatedInputTokens) + ' Token · ' + item.modelCallCount + ' 个子窗口'"></span>
        </div>
        <p class="capture-action-note">已有事实会按稳定事实键合并、强化或修改，不会简单重复新增；原始消息不会被删除。</p>
      </section>
      <template #actions><button class="btn outline" type="button" @click="view.showReextractDialog = false">取消</button><button class="btn primary" type="button" :disabled="view.reextractBusy || !view.reextractPlan?.selectedMessageCount" @click="view.confirmReextraction"><Icon name="sparkles" :size="14" />{{ view.reextractBusy ? '创建中…' : '创建重提炼任务' }}</button></template>
    </SideDrawer>

    <SideDrawer
      :open="view.showMemoryDrawer"
      :title="view.draft.memoryId ? '查看和编辑记忆' : '添加记忆'"
      :subtitle="view.scopeLabel(view.draft)"
      icon="database"
      width="640px"
      @close="view.showMemoryDrawer = false"
    >
      <section v-if="view.memoryDetail" class="memory-detail-overview" aria-label="记忆状态与衰减">
        <div class="memory-detail-heading"><span class="memory-lifecycle" :class="view.memoryLifecycle(view.memoryDetail).tone">{{ view.memoryLifecycle(view.memoryDetail).label }}</span><span class="muted small">{{ view.memorySourceLabel(view.memoryDetail) }}</span></div>
        <div class="memory-metrics">
          <div><span>置信度</span><strong>{{ view.memoryPercent(view.memoryDetail.confidence) }}</strong><progress v-if="view.memoryDetail.confidence != null" :value="view.memoryDetail.confidence" max="1" aria-label="记忆置信度"></progress><small>写入可信程度，不随时间递减</small></div>
          <div><span>当前活跃度</span><strong>{{ view.memoryPercent(view.memoryDetail.lifecycle?.decay) }}</strong><progress v-if="view.memoryDetail.lifecycle?.decay != null" :value="view.memoryDetail.lifecycle.decay" max="1" aria-label="记忆活跃度"></progress><small>{{ view.memoryDetail.lifecycle ? (view.memoryDetail.lifecycle.halfLifeDays === null ? '此类记忆不随时间衰减' : '半衰期 ' + view.memoryDetail.lifecycle.halfLifeDays + ' 天') : '此存储后端未提供衰减指标' }}</small></div>
        </div>
        <dl class="memory-time-grid">
          <div><dt>最近确认</dt><dd>{{ view.memoryTimeLabel(view.memoryDetail.lifecycle?.lastConfirmedAt || view.memoryDetail.lastSeenAt) }}</dd></div>
          <div><dt>有效期限</dt><dd>{{ view.memoryDetail.expiresAt ? view.memoryTimeLabel(view.memoryDetail.expiresAt) : '无固定到期时间' }}</dd></div>
          <div v-if="view.memoryDetail.lifecycle?.nextTransitionAt" class="memory-next-transition"><dt>预计下次变化</dt><dd>{{ view.memoryTimeLabel(view.memoryDetail.lifecycle.nextTransitionAt) }} · {{ view.memoryLifecycle({ status: view.memoryDetail.lifecycle.nextStatus }).label }}</dd></div>
        </dl>
        <p class="memory-detail-note">置信度是写入时的评估值，不代表经过统计验证的准确率。活跃度影响召回优先级；再次确认会重新计时，归档不等于删除。</p>
      </section>
      <Field label="记忆内容" type="textarea" :rows="4" v-model="view.draft.memoryText" placeholder="写入一条明确、可复用的事实。" />
      <Field label="标签" v-model="view.draft.memoryTags" placeholder="偏好, 沟通方式（可选）" />
      <section v-if="view.draft.memoryId" class="memory-source-section" aria-label="关联的来源消息">
        <div class="memory-detail-heading"><h3><Icon name="message" :size="16" />来源消息 <span v-if="view.memoryDetail?.evidenceCount != null" class="badge">{{ view.memoryDetail.evidenceCount }}</span></h3><span v-if="view.memoryDetailLoading" class="muted small" role="status">正在加载…</span></div>
        <p class="memory-detail-note">这些消息为提炼或强化记忆提供依据。原文按采集保留期限清理，关联标识会保留；人工修订后的内容可能与原始证据不同。</p>
        <div v-if="view.memorySources.items.length" class="memory-source-list">
          <article v-for="source in view.memorySources.items" :key="source.id" class="memory-source-card" :class="{ 'is-unavailable': !source.available }">
            <header><span class="memory-source-avatar"><template v-if="source.available">{{ (source.senderName || source.senderId || '群').slice(0, 1) }}</template><Icon v-else name="message" :size="17" /></span><div><strong>{{ source.available ? (source.senderName || source.senderId || '群成员') : '来源原文不可用' }}</strong><small>{{ source.available ? view.memoryTimeLabel(source.sentAt) : '原文已清理、已过期或未保存在本地' }}</small></div><span v-if="source.groupId" class="memory-source-group">群 {{ source.groupId }}</span></header>
            <blockquote v-if="source.available">{{ source.text || '这条消息没有可展示的文字，可能包含图片等内容。' }}</blockquote>
            <details><summary>消息标识</summary><dl><div v-if="source.senderId"><dt>发送者</dt><dd>{{ source.senderId }}</dd></div><div><dt>消息 ID</dt><dd>{{ source.messageId || '未记录' }}</dd></div></dl></details>
          </article>
        </div>
        <p v-else-if="!view.memoryDetailLoading && !view.memoryDetailError" class="memory-source-empty"><Icon name="message" :size="20" /><span>暂无关联消息</span><small>手动添加、画像编辑和平台资料同步通常没有聊天原文证据。</small></p>
        <div v-if="view.memoryDetailError" class="memory-source-error" role="alert"><span>{{ view.memoryDetailError }}</span><button class="btn small outline" type="button" @click="view.loadMemoryDetail(view.memorySources.items.length ? view.memorySources.page + 1 : 1)">重试加载</button></div>
        <button v-else-if="view.memorySources.items.length < view.memorySources.total" class="btn small outline memory-source-more" type="button" :disabled="view.memoryDetailLoading" @click="view.loadMemoryDetail(view.memorySources.page + 1)">加载更多来源（已显示 {{ view.memorySources.items.length }} / {{ view.memorySources.total }}）</button>
      </section>
      <template #actions>
        <button class="btn outline" type="button" @click="view.showMemoryDrawer = false"><Icon name="x" :size="14" />取消</button>
        <button class="btn primary" type="button" :disabled="view.busy || view.memoryDetailLoading || Boolean(view.memoryDetailError)" @click="view.saveMemory"><Icon name="save" :size="14" />保存记忆</button>
      </template>
    </SideDrawer>

    <SideDrawer
      :open="view.showProfileDrawer"
      title="编辑用户画像"
      :subtitle="view.selectedMember ? '用户 ' + view.selectedMember.userId : ''"
      icon="bot"
      width="560px"
      @close="view.showProfileDrawer = false"
    >
      <div class="form-grid two">
        <Field label="称呼" v-model="view.draft.profileName" />
        <Field label="代称" v-model="view.draft.profilePronouns" />
        <Field label="兴趣" v-model="view.draft.profileInterests" placeholder="逗号分隔" />
        <Field label="偏好" v-model="view.draft.profilePreferences" placeholder="逗号分隔" />
        <Field label="不喜欢" v-model="view.draft.profileDislikes" placeholder="逗号分隔" />
        <Field label="交流风格" v-model="view.draft.profileStyle" />
      </div>
      <Field label="备注" type="textarea" :rows="4" v-model="view.draft.profileNotes" />
      <template #actions>
        <button class="btn outline" type="button" @click="view.showProfileDrawer = false"><Icon name="x" :size="14" />取消</button>
        <button class="btn primary" type="button" :disabled="view.busy" @click="view.saveProfile"><Icon name="save" :size="14" />保存画像</button>
      </template>
    </SideDrawer>
  `,
}
