// 记忆页的配置、重提炼和编辑抽屉；数据与动作由 MemoryTab 统一持有。
export const MemoryCaptureDrawers = {
  name: "MemoryCaptureDrawers",
  props: {
    view: { type: Object, required: true },
  },
  template: `
    <SideDrawer
      :open="view.showCaptureSettings"
      :title="view.captureDraftEditing ? '编辑群聊采集配置' : '新增群聊采集配置'"
      subtitle="新群默认跟随系统；直接修改任一项会自动变为本群自定义，也可一键恢复为系统默认。"
      icon="message"
      width="720px"
      modal
      @close="view.showCaptureSettings = false"
    >
      <section class="capture-global-defaults-entry">
        <div><h3>需要调整所有群的默认值？</h3><p>在系统设置中维护。新建配置及仍跟随系统默认的群会同步更新；本群自定义项不会受影响。</p></div>
        <button class="btn small outline" type="button" @click="view.openSystemSettings('memory-capture')"><Icon name="sliders" :size="14" />设置全局默认值</button>
      </section>
      <section class="capture-config-section">
        <div class="capture-enable-control"><div><h3>采集开关</h3><p>开启后保存该群的原始消息；记忆提炼在后台执行，原始记录与记忆块始终独立。</p></div><span><Switch v-model="view.captureDraft.enabled" /><b :class="{ 'is-paused': !view.captureDraft.enabled }">{{ view.captureDraft.enabled ? '已开启' : '已暂停' }}</b></span></div>
        <Field label="群号" v-model="view.captureDraft.scopeId" placeholder="输入群号" :disabled="view.captureDraftEditing" />
      </section>
      <section class="capture-config-section">
        <div class="memory-section-head"><div><h3>原始消息与输入切分</h3><p>状态会明确标出值来自系统还是本群；直接编辑即可创建单群覆盖。</p></div></div>
        <div class="form-grid capture-token-limits">
          <div><div class="capture-field-source"><span class="capture-source-pill" :class="{ 'is-default': view.captureDraft.useDefault.retentionDays }">{{ view.captureFieldSource('retentionDays') }}</span><button v-if="!view.captureDraft.useDefault.retentionDays" class="btn small outline" type="button" @click="view.resetCaptureField('retentionDays')">恢复默认</button></div><Field label="原始消息保留天数" type="number" :model-value="view.captureDraft.retentionDays" @update:model-value="value => view.updateCaptureField('retentionDays', value)" :hint="view.captureFieldHint('retentionDays')" /></div>
          <div><div class="capture-field-source"><span class="capture-source-pill" :class="{ 'is-default': view.captureDraft.useDefault.tokenLimit }">{{ view.captureFieldSource('tokenLimit') }}</span><button v-if="!view.captureDraft.useDefault.tokenLimit" class="btn small outline" type="button" @click="view.resetCaptureField('tokenLimit')">恢复默认</button></div><Field label="输入 Token 上限（单日子窗口）" type="number" :model-value="view.captureDraft.tokenLimit" @update:model-value="value => view.updateCaptureField('tokenLimit', value)" :hint="view.captureFieldHint('tokenLimit')" /></div>
        </div>
      </section>
      <section class="capture-config-section">
        <div class="memory-section-head"><div><h3>对话记忆召回</h3><p>全文命中少于此数量时，才会补一次向量召回；也决定自动注入的记忆条数。</p></div></div>
        <div class="capture-field-source"><span class="capture-source-pill" :class="{ 'is-default': view.captureDraft.useDefault.retrievalResultLimit }">{{ view.captureFieldSource('retrievalResultLimit') }}</span><button v-if="!view.captureDraft.useDefault.retrievalResultLimit" class="btn small outline" type="button" @click="view.resetCaptureField('retrievalResultLimit')">恢复默认</button></div>
        <Field label="记忆召回条数（向量触发阈值）" type="number" :model-value="view.captureDraft.retrievalResultLimit" @update:model-value="value => view.updateCaptureField('retrievalResultLimit', value)" :hint="view.captureFieldHint('retrievalResultLimit') + '；范围 1–20'" />
      </section>
      <section class="capture-config-section">
        <div class="memory-section-head"><div><h3>记忆提炼</h3><p>每项均可直接编辑；留空模型会跟随默认对话模型。</p></div></div>
        <div class="capture-field-source"><span class="capture-source-pill" :class="{ 'is-default': view.captureDraft.useDefault.modelName }">{{ view.captureFieldSource('modelName') }}</span><button v-if="!view.captureDraft.useDefault.modelName" class="btn small outline" type="button" @click="view.resetCaptureField('modelName')">恢复系统默认</button></div>
        <Field label="提炼模型" type="select" :options="view.extractionModelOptions" :model-value="view.captureDraft.modelName" @update:model-value="value => view.updateCaptureField('modelName', value)" :hint="view.captureFieldHint('modelName')" />
        <div class="form-grid capture-token-limits">
          <div><div class="capture-field-source"><span class="capture-source-pill" :class="{ 'is-default': view.captureDraft.useDefault.maxTokens }">{{ view.captureFieldSource('maxTokens') }}</span><button v-if="!view.captureDraft.useDefault.maxTokens" class="btn small outline" type="button" @click="view.resetCaptureField('maxTokens')">恢复默认</button></div><Field label="输出 Token 上限" type="number" :model-value="view.captureDraft.maxTokens" @update:model-value="value => view.updateCaptureField('maxTokens', value)" :hint="view.captureFieldHint('maxTokens')" /></div>
          <div><div class="capture-field-source"><span class="capture-source-pill" :class="{ 'is-default': view.captureDraft.useDefault.minConfidence }">{{ view.captureFieldSource('minConfidence') }}</span><button v-if="!view.captureDraft.useDefault.minConfidence" class="btn small outline" type="button" @click="view.resetCaptureField('minConfidence')">恢复默认</button></div><Field label="候选置信度阈值" type="number" :model-value="view.captureDraft.minConfidence" @update:model-value="value => view.updateCaptureField('minConfidence', value)" :hint="view.captureFieldHint('minConfidence')" /></div>
        </div>
        <div class="capture-field-source"><span class="capture-source-pill" :class="{ 'is-default': view.captureDraft.useDefault.promptTemplate }">{{ view.captureFieldSource('promptTemplate') }}</span><button v-if="!view.captureDraft.useDefault.promptTemplate" class="btn small outline" type="button" @click="view.resetCaptureField('promptTemplate')">恢复系统默认</button></div>
        <Field label="提炼提示词" type="textarea" :rows="12" :model-value="view.captureDraft.promptTemplate" @update:model-value="value => view.updateCaptureField('promptTemplate', value)" :hint="view.captureFieldHint('promptTemplate')" />
        <details class="capture-default-prompt"><summary>查看系统默认提示词（{{ view.captureDefaultLabel('promptTemplate') }}）</summary><pre>{{ view.captureDefaults.promptTemplate }}</pre></details>
      </section>
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
      width="560px"
      @close="view.showMemoryDrawer = false"
    >
      <Field label="记忆内容" type="textarea" :rows="8" v-model="view.draft.memoryText" placeholder="写入一条明确、可复用的事实。" />
      <Field label="标签" v-model="view.draft.memoryTags" placeholder="偏好, 沟通方式（可选）" />
      <template #actions>
        <button class="btn outline" type="button" @click="view.showMemoryDrawer = false"><Icon name="x" :size="14" />取消</button>
        <button class="btn primary" type="button" :disabled="view.busy" @click="view.saveMemory"><Icon name="save" :size="14" />保存记忆</button>
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
