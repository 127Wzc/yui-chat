// 扩展编辑抽屉：Skill 表单与 Custom 五步构建器，草稿对象由父组件持有，保存/测试事件上浮。
export const ExtensionEditorDrawer = {
  name: "ExtensionEditorDrawer",
  props: {
    open: Boolean,
    editorTitle: { type: String, default: "" },
    editorSubtitle: { type: String, default: "" },
    editor: { type: Object, required: true },
    customBuilder: { type: Object, required: true },
    customTest: { type: Object, required: true },
    builderSteps: { type: Array, default: () => [] },
    fieldTypes: { type: Array, default: () => [] },
    testToolOptions: { type: Array, default: () => [] },
    commandPreview: { type: String, default: "" },
    parameterCommand: { type: String, default: "" },
    boolOptions: { type: Array, default: () => [] },
    riskOptions: { type: Array, default: () => [] },
  },
  emits: ["close", "save", "test", "seed-test", "copy-command"],
  template: `
    <SideDrawer
      :open="open"
      :title="editorTitle"
      :subtitle="editorSubtitle"
      icon="pencil"
      width="920px"
      :modal="true"
      @close="$emit('close')"
    >
      <template v-if="editor.type === 'skill'">
        <div class="extension-result-preview"><Icon name="info" :size="17" /><div><strong>OpenAI 原生 Skill</strong><p>系统只读取 SKILL.md。name 和 description 用于发现，完整 Markdown 正文只在匹配时加载。</p></div></div>
        <div class="form-grid">
          <Field v-if="editor.mode !== 'create'" label="目录 ID" v-model="editor.id" :disabled="true" tip="这是项目内的稳定目录标识，创建后不可修改。" />
          <Field label="Skill name" v-model="editor.name" tip="YAML frontmatter 中的 name，也是 $调用名；只能使用小写字母、数字和横线。" />
          <Field label="启用状态" type="select" :options="boolOptions" v-model="editor.enabled" tip="停用状态保存在项目配置中，不修改 SKILL.md 原文。" />
        </div>
        <Field label="Description（触发说明）" type="textarea" rows="4" v-model="editor.descriptionZh" tip="这是自动选择 Skill 的关键。明确写出什么时候应该用、什么时候不该用。" />
        <Collapse title="运行变量" hint="由 configSchema 声明，保存到统一配置">
          <Field label="变量 JSON" type="textarea" rows="7" v-model="editor.runtimeConfigText" tip="只能保存 frontmatter configSchema 已声明的字段。secret 字段以 ******** 回显：保持不变即保留，删除即清除。命中时仅注入非 secret 且未标记 exposeToModel:false 的已声明变量。" />
        </Collapse>
        <Collapse title="SKILL.md 工作流正文" hint="Markdown 指令，命中后加载" :open="true">
          <Field label="Markdown instructions" type="textarea" rows="22" v-model="editor.source" tip="用命令式步骤描述输入、处理流程、输出和必要限制。可引用 scripts/、references/、assets/。" />
        </Collapse>
        <Collapse title="官方目录结构" hint="可选资源目录">
          <div class="list">
            <div class="item subtle"><div class="item-title">SKILL.md</div><div class="cell-sub">必需：name、description 和 Markdown 指令</div></div>
            <div class="item subtle"><div class="item-title">scripts / references / assets</div><div class="cell-sub">可选：脚本、按需文档和输出资源</div></div>
            <div class="item subtle"><div class="item-title">文件位置</div><div class="cell-sub">{{ editor.manifestFile || '-' }}</div></div>
          </div>
        </Collapse>
      </template>
      <template v-else>
        <div class="custom-builder-nav" role="tablist" aria-label="Custom 创建步骤">
          <button v-for="step in builderSteps" :key="step.key" type="button" :class="{ active: customBuilder.step === step.key }" @click="customBuilder.step = step.key"><Icon :name="step.icon" :size="14" />{{ step.label }}</button>
        </div>
        <section v-if="customBuilder.step === 'create'" class="custom-builder-pane">
          <div class="extension-result-preview"><Icon name="cpu" :size="17" /><div><strong>先说明它解决什么问题</strong><p>创建的是一个可启停的本地工具包；后续步骤再补资源、参数、代码和真实测试。</p></div></div>
          <div class="form-grid"><Field v-if="editor.mode !== 'create'" label="扩展 ID" v-model="editor.id" disabled /><Field label="显示名称" v-model="editor.name" /><Field label="中文短名" v-model="editor.displayNameZh" /><Field label="启用状态" type="select" :options="boolOptions" v-model="editor.enabled" /></div>
          <Field label="中文说明" type="textarea" rows="3" v-model="editor.descriptionZh" placeholder="例如：查询库存并返回当前可售数量。" />
          <div class="form-grid"><Field label="工具 name" v-model="customBuilder.toolName" tip="代码导出的工具名；建议只用小写字母、数字和下划线。" /><Field label="工具说明" v-model="customBuilder.toolDescription" /><Field label="需要最终回复" type="select" :options="boolOptions" v-model="customBuilder.requiresFinalReply" tip="默认开启。关闭后，只有本轮单独调用这个工具时才允许不发送模型文字回复。" /></div>
          <Collapse title="执行保护策略" hint="可选，适合有副作用、次数额度或特殊重试规则的工具" nested>
            <Field label="执行策略 JSON" type="textarea" rows="8" v-model="customBuilder.execution" tip="例如：{ &quot;effect&quot;: &quot;non_idempotent&quot;, &quot;repeatPolicy&quot;: &quot;explicit_only&quot;, &quot;supportsCount&quot;: true, &quot;countField&quot;: &quot;count&quot;, &quot;maxCount&quot;: 10, &quot;targetFields&quot;: [&quot;target&quot;], &quot;retryPolicy&quot;: &quot;no_ambiguous_retry&quot; }。未填写时会按工具来源采用安全默认值。" />
            <Field label="按 action 覆盖 JSON" type="textarea" rows="6" v-model="customBuilder.executionByAction" placeholder="{ &quot;search&quot;: { &quot;effect&quot;: &quot;read&quot; }, &quot;write&quot;: { &quot;effect&quot;: &quot;non_idempotent&quot; } }" tip="复合工具可按 action 使用不同的效果、重复和重试策略；没有覆盖的字段继承执行策略。" />
          </Collapse>
          <Collapse title="高级包设置" hint="分类、风险、标签和原始 JSON" nested><div class="form-grid"><Field label="分类" v-model="editor.category" /><Field label="风险" type="select" :options="riskOptions" v-model="editor.risk" /><Field label="标签" v-model="editor.tags" /></div><Field label="英文说明" type="textarea" rows="2" v-model="editor.description" /><Field label="高级 manifest JSON" type="textarea" rows="8" v-model="editor.manifestJson" tip="仅用于少见字段；上面的可视化步骤会覆盖同名配置。" /></Collapse>
        </section>
        <section v-else-if="customBuilder.step === 'resources'" class="custom-builder-pane">
          <div class="extension-result-preview"><Icon name="link" :size="17" /><div><strong>引入 Bot 框架资源</strong><p>为模块、文本或 JSON 资源起别名；代码中通过 <code>framework.use('别名')</code> 使用。</p></div></div>
          <div v-for="(row, index) in customBuilder.resources" :key="index" class="custom-builder-row"><Field label="别名" v-model="row.alias" placeholder="system-status" /><Field label="资源引用" v-model="row.reference" placeholder="yunzai:plugins/system/status.js" /><button class="icon-btn danger" type="button" data-tip="移除资源" @click="customBuilder.resources.splice(index, 1)"><Icon name="trash" :size="15" /></button></div>
          <p v-if="!customBuilder.resources.length" class="muted small">还未引入资源。普通工具不需要这一步；需要复用 Bot 框架或其他插件时再添加。</p>
          <div class="row"><button class="btn small outline" type="button" @click="customBuilder.resources.push({ alias: '', reference: '' })"><Icon name="plus" :size="14" />添加资源</button><span class="muted tiny">支持 <code>plugin:插件名/路径</code> 与 <code>yunzai:路径</code>；越界路径会被拒绝。</span></div>
        </section>
        <section v-else-if="customBuilder.step === 'parameters'" class="custom-builder-pane">
          <div class="extension-result-preview"><Icon name="sliders" :size="17" /><div><strong>配置模型入参与运行变量</strong><p>模型入参会进入工具定义；运行变量只在服务端执行时注入，不会发送给模型。</p></div></div>
          <div class="section-title">模型调用参数</div>
          <div v-for="(row, index) in customBuilder.parameters" :key="'arg:' + index" class="custom-builder-row custom-builder-row-wide"><Field label="参数名" v-model="row.name" /><Field label="类型" type="select" :options="fieldTypes" v-model="row.type" /><Field label="说明" v-model="row.description" /><Field label="必填" type="select" :options="boolOptions" v-model="row.required" /><button class="icon-btn danger" type="button" data-tip="移除参数" @click="customBuilder.parameters.splice(index, 1)"><Icon name="trash" :size="15" /></button></div>
          <button class="btn small outline" type="button" @click="customBuilder.parameters.push({ name: '', type: 'string', description: '', required: 'false', secret: 'false', defaultValue: '' })"><Icon name="plus" :size="14" />添加调用参数</button>
          <div class="section-title" style="margin-top:14px">运行变量</div>
          <div v-for="(row, index) in customBuilder.runtimeFields" :key="'config:' + index" class="custom-builder-row custom-builder-row-wide"><Field label="变量名" v-model="row.name" /><Field label="类型" type="select" :options="fieldTypes" v-model="row.type" /><Field label="说明" v-model="row.description" /><Field label="默认值" v-model="row.defaultValue" /><Field label="密钥" type="select" :options="boolOptions" v-model="row.secret" /><button class="icon-btn danger" type="button" data-tip="移除变量" @click="customBuilder.runtimeFields.splice(index, 1)"><Icon name="trash" :size="15" /></button></div>
          <button class="btn small outline" type="button" @click="customBuilder.runtimeFields.push({ name: '', type: 'string', description: '', required: 'false', secret: 'false', defaultValue: '' })"><Icon name="plus" :size="14" />添加运行变量</button>
        </section>
        <section v-else-if="customBuilder.step === 'code'" class="custom-builder-pane"><div class="extension-result-preview"><Icon name="pencil" :size="17" /><div><strong>编写入口代码</strong><p>入口应导出与上方工具 name 对应的工具；资源通过 <code>createTools({ framework })</code> 注入。</p></div></div><div class="custom-code-outline"><div><b>1 · 加载资源</b><span>使用 <code>framework.use('别名')</code>，别名必须先在“框架资源”中声明。</span></div><div><b>2 · 准备调用</b><span>把模块函数包装成一个小函数，明确它需要的参数和运行环境。</span></div><div><b>3 · 注册工具</b><span>填写 name、中文说明、风险和 JSON Schema，让系统知道何时可用。</span></div><div><b>4 · 执行并返回</b><span>在 <code>execute()</code> 内调用真实逻辑，并只返回工具结果。</span></div></div><Field label="入口源码 index.js" type="textarea" rows="22" v-model="editor.source" tip="保存后立刻重新加载。可按上面的四段结构组织；运行变量从 context.toolConfig 读取。" /></section>
        <section v-else class="custom-builder-pane"><div class="extension-result-preview"><Icon name="play" :size="17" /><div><strong>用真实参数测试</strong><p>请先保存代码；测试会真实执行已保存的工具逻辑，dryRun 只是上下文提示。</p></div></div><div v-if="editor.mode === 'create'" class="extension-example"><Icon name="info" :size="15" /><span>这是尚未保存的草稿。先点右下角“保存扩展”创建它，再回到这一步运行真实测试。</span></div><div class="row"><strong>从当前代码读取 key</strong><button class="btn small outline" type="button" @click="$emit('seed-test')"><Icon name="refresh" :size="14" />重新生成参数</button></div><p class="muted tiny">会合并参数表与源码中的 <code>args.xxx</code>、<code>context.toolConfig.xxx</code>；生成后可直接改值。</p><Field label="选择工具" type="select" :options="testToolOptions" v-model="customTest.tool" /><Field label="测试参数 JSON" type="textarea" rows="6" v-model="customTest.args" placeholder='例如 {"query":"hello"}' /><Field label="测试运行变量 JSON" type="textarea" rows="5" v-model="customTest.runtimeConfig" placeholder='例如 {"apiToken":"test-token"}' tip="只对本次测试生效，不会保存到全局运行变量。" /><button class="btn primary small" type="button" :disabled="customTest.running || !customTest.tool || editor.mode === 'create'" @click="$emit('test')"><Icon name="play" :size="14" />{{ customTest.running ? '测试中…' : '运行测试' }}</button><div class="extension-example command-test-preview"><Icon name="message" :size="15" /><div><strong>机器人内快捷触发</strong><p>先发送 <code>{{ parameterCommand }}</code> 查看参数。普通字段可直接写 <code>参数=值</code>；启用工具后，主人可发送：</p><code>{{ commandPreview }}</code></div><button class="btn small outline" type="button" @click="$emit('copy-command')"><Icon name="copy" :size="14" />复制</button></div><div v-if="customTest.error" class="custom-test-error" role="alert"><Icon name="alert" :size="16" /><div><strong>测试失败</strong><p>{{ customTest.error }}</p></div></div><JsonBlock v-if="customTest.result" title="测试结果" :value="customTest.result" :open="true" /></section>
      </template>
      <template #actions>
        <button class="btn outline" type="button" @click="$emit('close')"><Icon name="x" :size="14" />关闭</button>
        <button class="btn primary small" type="button" @click="$emit('save')"><Icon name="save" :size="14" />保存扩展</button>
      </template>
    </SideDrawer>
  `,
}
