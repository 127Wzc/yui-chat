// Custom Filter 编辑抽屉：承载创建、资源、参数、代码和试跑步骤，动作全部上浮。
export const CustomFilterEditorDrawer = {
  name: "CustomFilterEditorDrawer",
  props: {
    open: { type: Boolean, default: false },
    title: { type: String, default: "编辑 Custom 代码过滤器" },
    subtitle: { type: String, default: "代码过滤器不会交给模型调用；它在固定阶段接收正文并返回处理结果。" },
    editor: { type: Object, required: true },
    builder: { type: Object, required: true },
    test: { type: Object, required: true },
    resourceBrowser: { type: Object, required: true },
    ai: { type: Object, required: true },
    builderSteps: { type: Array, default: () => [] },
    fieldTypes: { type: Array, default: () => [] },
    boolOptions: { type: Array, default: () => [] },
    stageOptions: { type: Array, default: () => [] },
    effectOptions: { type: Array, default: () => [] },
    effectText: { type: Function, required: true },
  },
  emits: [
    "close",
    "save",
    "open-resource-browser",
    "load-resource-folder",
    "select-resource-entry",
    "generate-ai",
    "apply-ai",
    "use-code-example",
    "seed-test-draft",
    "save-runtime-config",
    "test-filter",
  ],
  template: `
    <SideDrawer :open="open" :title="title" :subtitle="subtitle" icon="filter" width="920px" :modal="true" @close="$emit('close')">
      <div class="custom-builder-nav" role="tablist" aria-label="Custom Filter 创建步骤"><button v-for="step in builderSteps" :key="step.key" type="button" :class="{ active: builder.step === step.key }" @click="builder.step = step.key"><Icon :name="step.icon" :size="14" />{{ step.label }}</button></div>
      <section v-if="builder.step === 'create'" class="custom-builder-pane">
        <div class="extension-result-preview"><Icon name="filter" :size="17" /><div><strong>先说明过滤什么</strong><p>过滤器接收固定阶段的正文，不需要让模型生成正文参数。</p></div></div>
        <div class="form-grid"><Field label="扩展 ID" v-model="editor.id" disabled /><Field label="显示名称" v-model="editor.name" /><Field label="中文短名" v-model="editor.displayNameZh" /><Field label="启用状态" type="select" :options="boolOptions" v-model="editor.enabled" /></div>
        <Field label="中文说明" type="textarea" rows="3" v-model="editor.descriptionZh" placeholder="例如：过滤输入中的敏感词。" />
        <div class="form-grid"><Field label="过滤器 ID" v-model="builder.filterId" tip="规则选择的稳定 ID；建议只用小写字母、数字、下划线和短横线。" /><Field label="实现名称" v-model="builder.displayName" /><Field label="执行阶段" type="select" :options="stageOptions" v-model="builder.stage" /><Field label="副作用" type="select" :options="effectOptions" v-model="builder.effect" /></div>
        <Field label="实现说明" v-model="builder.description" />
        <Collapse title="高级包设置" hint="标签和原始 manifest JSON" nested><Field label="标签" v-model="editor.tags" /><Field label="英文说明" type="textarea" rows="2" v-model="editor.description" /><Field label="高级 manifest JSON" type="textarea" rows="8" v-model="editor.manifestJson" tip="少见字段可直接编辑；可视化步骤会覆盖同名配置。" /></Collapse>
      </section>
      <section v-else-if="builder.step === 'resources'" class="custom-builder-pane">
        <div class="extension-result-preview"><Icon name="link" :size="17" /><div><strong>声明可复用的框架资源</strong><p>资源只对当前 Custom Filter 可见，代码里通过 <code>framework.use('别名')</code> 读取。</p></div></div>
        <div v-for="(row, index) in builder.resources" :key="index" class="custom-builder-row"><Field label="别名" v-model="row.alias" placeholder="system-status" /><Field label="资源引用" v-model="row.reference" placeholder="yunzai:plugins/system/status.js" /><button class="icon-btn" type="button" data-tip="浏览项目文件" @click="$emit('open-resource-browser', index)"><Icon name="folder" :size="15" /></button><button class="icon-btn danger" type="button" data-tip="移除资源" @click="builder.resources.splice(index, 1)"><Icon name="trash" :size="15" /></button></div>
        <p v-if="!builder.resources.length" class="muted small">普通文本处理不需要资源；要复用框架或其他插件函数时再添加。</p>
        <div class="row"><button class="btn small outline" type="button" @click="builder.resources.push({ alias: '', reference: '' })"><Icon name="plus" :size="14" />手动添加</button><button class="btn small outline" type="button" @click="$emit('open-resource-browser', -1)"><Icon name="folder" :size="14" />浏览项目文件</button><span class="muted tiny">只显示项目源码和文档；运行数据、缓存及常见密钥文件已隐藏。</span></div>
        <div v-if="resourceBrowser.open" class="form-section">
          <div class="section-heading-row"><div><div class="section-title"><Icon name="folder" :size="13" />Yunzai / {{ resourceBrowser.path }}</div><p class="muted small">选择文件后会自动填写受控资源引用，不会授权整个文件夹。</p></div><button class="icon-btn" type="button" data-tip="关闭" @click="resourceBrowser.open = false"><Icon name="x" :size="14" /></button></div>
          <div class="row"><button class="btn small outline" type="button" :disabled="resourceBrowser.path === '' || resourceBrowser.loading" @click="$emit('load-resource-folder', resourceBrowser.parent)"><Icon name="chevron-left" :size="13" />上一级</button><button class="btn small outline" type="button" :disabled="resourceBrowser.loading" @click="$emit('load-resource-folder', resourceBrowser.path)"><Icon name="refresh" :size="13" />刷新</button></div>
          <div v-if="resourceBrowser.loading" class="empty-state">正在读取项目文件夹…</div>
          <div v-else-if="resourceBrowser.error" class="hint-banner warn"><Icon name="alert" :size="14" /><span>{{ resourceBrowser.error }}</span></div>
          <div v-else class="extension-library-list">
            <button v-for="item in resourceBrowser.entries" :key="item.path" class="extension-library-card" type="button" @click="$emit('select-resource-entry', item)">
              <span class="extension-type-mark" :class="item.kind === 'directory' ? 'builtin' : 'custom'"><Icon :name="item.kind === 'directory' ? 'folder' : 'file'" :size="16" /></span>
              <span class="extension-library-copy"><strong>{{ item.name }}</strong><small>{{ item.kind === 'directory' ? '文件夹' : item.reference }}</small></span>
            </button>
          </div>
          <p v-if="resourceBrowser.truncated" class="muted tiny">当前文件夹内容较多，只显示前 300 项。</p>
        </div>
      </section>
      <section v-else-if="builder.step === 'parameters'" class="custom-builder-pane">
        <div class="extension-result-preview"><Icon name="sliders" :size="17" /><div><strong>设置固定参数和运行变量</strong><p>正文始终由系统提供；这里仅定义规则可配置的固定参数和不发送给模型的运行变量。</p></div></div>
        <div class="section-title">规则固定参数</div>
        <div v-for="(row, index) in builder.parameters" :key="'arg:' + index" class="custom-builder-row custom-builder-row-wide"><Field label="参数名" v-model="row.name" /><Field label="类型" type="select" :options="fieldTypes" v-model="row.type" /><Field label="说明" v-model="row.description" /><Field label="必填" type="select" :options="boolOptions" v-model="row.required" /><button class="icon-btn danger" type="button" data-tip="移除参数" @click="builder.parameters.splice(index, 1)"><Icon name="trash" :size="15" /></button></div>
        <button class="btn small outline" type="button" @click="builder.parameters.push({ name: '', type: 'string', description: '', required: 'false', secret: 'false', defaultValue: '' })"><Icon name="plus" :size="14" />添加固定参数</button>
        <div class="section-title" style="margin-top:14px">运行变量</div>
        <div v-for="(row, index) in builder.runtimeFields" :key="'config:' + index" class="custom-builder-row custom-builder-row-wide"><Field label="变量名" v-model="row.name" /><Field label="类型" type="select" :options="fieldTypes" v-model="row.type" /><Field label="说明" v-model="row.description" /><Field label="默认值" v-model="row.defaultValue" /><Field label="密钥" type="select" :options="boolOptions" v-model="row.secret" /><button class="icon-btn danger" type="button" data-tip="移除变量" @click="builder.runtimeFields.splice(index, 1)"><Icon name="trash" :size="15" /></button></div>
        <button class="btn small outline" type="button" @click="builder.runtimeFields.push({ name: '', type: 'string', description: '', required: 'false', secret: 'false', defaultValue: '' })"><Icon name="plus" :size="14" />添加运行变量</button>
      </section>
      <section v-else-if="builder.step === 'code'" class="custom-builder-pane">
        <div class="extension-result-preview"><Icon name="pencil" :size="17" /><div><strong>编写 createFilters 入口</strong><p>入口返回 FilterDefinition；正文从 <code>apply({ text, params })</code> 的 text 获取。</p></div></div>
        <div class="hint-banner warn"><Icon name="alert" :size="14" /><span>Custom 代码拥有与插件相同的本机权限，只应由受信任管理员维护。<b>{{ effectText([builder.effect]) }}</b> 的实现试跑可能产生真实副作用。</span></div>
        <div class="custom-code-outline"><div><b>1 · 加载资源</b><span>使用 <code>framework.use('别名')</code>，别名必须先声明。</span></div><div><b>2 · 接收正文</b><span>从 <code>apply({ text, params })</code> 读取当前正文与固定参数。</span></div><div><b>3 · 返回结果</b><span>返回文本、<code>{ kind: 'block' }</code> 或输出阶段的 record。</span></div></div>
        <div class="form-section">
          <div class="section-title"><Icon name="sparkles" :size="13" />用项目 AI 编写草稿</div>
          <p class="muted small">使用当前项目的默认回复模型，独立生成代码；不会加载聊天历史、人格、Skill、记忆或 AI Tool。</p>
          <Field label="处理需求" type="textarea" rows="4" v-model="ai.requirement" placeholder="例如：删除回复中的连续空行，把手机号中间四位替换为星号；不要访问网络。" />
          <div class="row"><button class="btn primary small" type="button" :disabled="ai.running" @click="$emit('generate-ai')"><Icon name="sparkles" :size="14" />{{ ai.running ? '生成中…' : '生成代码草稿' }}</button><button class="btn small outline" type="button" @click="$emit('use-code-example')"><Icon name="code" :size="14" />使用基础示例</button></div>
          <div v-if="ai.error" class="custom-test-error" role="alert"><Icon name="alert" :size="16" /><div><strong>生成失败</strong><p>{{ ai.error }}</p></div></div>
          <div v-if="ai.draft" class="extension-result-preview"><Icon name="sparkles" :size="17" /><div><strong>草稿待确认</strong><p>{{ ai.draft.notes || '请检查生成代码、参数和副作用声明。' }}</p><small>模型：{{ ai.draft.model?.channel || '-' }} · 已读取资源：{{ ai.draft.resources?.included?.length || 0 }} · 跳过：{{ ai.draft.resources?.skipped?.length || 0 }}</small></div></div>
          <Field v-if="ai.draft" label="AI 生成的 index.js 预览" type="textarea" rows="14" :modelValue="ai.draft.source" disabled />
          <div v-if="ai.draft" class="row"><button class="btn primary small" type="button" @click="$emit('apply-ai')"><Icon name="check" :size="14" />应用到编辑器</button><button class="btn small outline" type="button" @click="ai.draft = null"><Icon name="x" :size="14" />放弃草稿</button></div>
        </div>
        <Field label="入口源码 index.js" type="textarea" rows="22" v-model="editor.source" tip="保存后会重新加载。运行变量由 context.filterConfig 提供。" />
      </section>
      <section v-else class="custom-builder-pane">
        <div class="extension-result-preview"><Icon name="play" :size="17" /><div><strong>用真实正文测试</strong><p>先保存代码；测试会真实执行已保存的过滤器逻辑，dryRun 只是上下文提示，不能构成安全沙箱。</p></div></div>
        <div class="row"><strong>从当前代码读取参数</strong><button class="btn small outline" type="button" @click="$emit('seed-test-draft')"><Icon name="refresh" :size="14" />重新生成参数</button></div>
        <Field label="测试正文" type="textarea" rows="4" v-model="test.text" />
        <Field label="测试固定参数 JSON" type="textarea" rows="5" v-model="test.params" placeholder='例如 {"prefix":"处理："}' />
        <Field label="测试运行变量 JSON" type="textarea" rows="5" v-model="test.runtimeConfig" placeholder='例如 {"apiToken":"test-token"}' tip="本次试跑会使用这些值；点击保存运行变量才会持久化。" />
        <div class="row"><button class="btn primary small" type="button" :disabled="test.running" @click="$emit('test-filter')"><Icon name="play" :size="14" />{{ test.running ? '测试中…' : '运行测试' }}</button><button class="btn small outline" type="button" @click="$emit('save-runtime-config')"><Icon name="save" :size="14" />保存运行变量</button></div>
        <div v-if="test.error" class="custom-test-error" role="alert"><Icon name="alert" :size="16" /><div><strong>测试失败</strong><p>{{ test.error }}</p></div></div>
        <JsonBlock v-if="test.result" title="测试结果" :value="test.result" :open="true" />
      </section>
      <template #actions><button class="btn outline" type="button" @click="$emit('close')"><Icon name="x" :size="14" />关闭</button><button class="btn primary small" type="button" @click="$emit('save')"><Icon name="save" :size="14" />保存代码过滤器</button></template>
    </SideDrawer>
  `,
}
