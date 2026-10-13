/** 扩展创建入口只负责选择创建方式和收集远程 Skill 草稿。 */
export const ExtensionCreateDrawer = {
  name: "ExtensionCreateDrawer",
  props: {
    open: Boolean,
    createMode: String,
    createModeMeta: Object,
    remoteDraft: { type: Object, required: true },
    boolOffOptions: { type: Array, default: () => [] },
  },
  emits: ["create", "close", "install-remote"],
  template: `
    <SideDrawer
      :open="open"
      :title="createModeMeta?.title || '新建扩展'"
      :subtitle="createModeMeta?.subtitle || '先选择扩展形态，再进入对应的创建流程。'"
      :icon="createModeMeta?.icon || 'plus'"
      width="620px"
      :modal="true"
      @close="$emit('close')"
    >
      <div v-if="!createMode" class="list">
        <button class="extension-path-card" type="button" @click.stop="$emit('create', 'custom')"><span class="extension-path-icon blue"><Icon name="cpu" :size="20" /></span><span class="extension-path-copy"><strong>新建 Custom 工具</strong><small>编写本地 JavaScript，配置模型参数、运行变量和执行逻辑。</small><span class="extension-path-example">适合：调用现有模块、接口或明确业务动作</span></span><Icon name="chevron-right" :size="16" /></button>
        <button class="extension-path-card recommended" type="button" @click.stop="$emit('create', 'skill')"><span class="extension-path-icon blue"><Icon name="sparkles" :size="20" /></span><span class="extension-path-copy"><strong>新建 Markdown Skill</strong><small>使用 SKILL.md 描述可重复工作流，无需编写工具执行代码。</small><span class="extension-path-example">适合：分析步骤、内容流程和操作规范</span></span><Icon name="chevron-right" :size="16" /></button>
      </div>
      <template v-else-if="createMode === 'remote'">
        <Field label="Skill 来源" v-model="remoteDraft.repo" tip="填写 owner/repo、仓库或归档 URL；安装后停用。" />
        <div class="extension-example"><Icon name="info" :size="15" /><span>参考值：<code>openai/skills</code>。目标目录必须包含 <code>SKILL.md</code>，其他资源会原样保留。</span></div>
        <Collapse title="更多安装选项" hint="固定版本与候选目录">
          <div class="form-grid">
            <Field label="分支 / Tag" v-model="remoteDraft.ref" tip="可选，例如 main、v1.0.0。" />
            <Field label="仓库子目录" v-model="remoteDraft.subdir" tip="Skill 不在仓库根目录时填写。" />
          </div>
        </Collapse>
      </template>
      <template #actions>
        <button class="btn" type="button" @click="$emit('close')">取消</button>
        <button v-if="createMode === 'remote'" class="btn primary" type="button" @click="$emit('install-remote')"><Icon name="download" :size="14" />提交停用安装</button>
      </template>
    </SideDrawer>
  `,
}
