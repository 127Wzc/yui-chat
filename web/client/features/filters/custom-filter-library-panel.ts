// Custom Filter 实现库：只负责展示内置/自定义实现和上浮列表动作。
export const CustomFilterLibraryPanel = {
  name: "CustomFilterLibraryPanel",
  props: {
    loading: { type: Boolean, default: false },
    apiError: { type: String, default: "" },
    builtinImplementations: { type: Array, default: () => [] },
    catalog: { type: Array, default: () => [] },
    customFilterCount: { type: Number, default: 0 },
    effectText: { type: Function, required: true },
    stageText: { type: Function, required: true },
  },
  emits: ["retry", "create-filter", "open-filter", "toggle-filter", "remove-filter"],
  template: `
    <Panel title="代码实现" icon="cpu">
      <div v-if="loading" class="empty-state">正在读取代码过滤器…</div>
      <div v-else-if="apiError" class="hint-banner warn"><Icon name="alert" :size="14" /><span>{{ apiError }}。后端升级完成后可在这里创建和维护 Custom Filter。</span><button class="btn small outline" type="button" @click="$emit('retry')">重试</button></div>
      <template v-else>
        <div v-if="builtinImplementations.length" class="form-section">
          <div class="section-heading-row"><div><div class="section-title"><Icon name="sliders" :size="13" />内置代码过滤器</div><p class="muted small">系统提供的确定性处理实现；在规则链里选择并配置。</p></div><span class="filter-count">{{ builtinImplementations.length }} 个</span></div>
          <PagedList :rows="builtinImplementations" :page-size="6" label="内置实现" list-class="extension-library-list" v-slot="{ item }">
            <div class="extension-library-card enabled">
              <span class="extension-type-mark builtin"><Icon name="filter" :size="17" /></span>
              <div class="extension-library-copy"><div class="row"><strong>{{ item.displayNameZh || item.displayName || item.id }}</strong><span class="badge">内置</span><span class="badge on">已加载</span></div><p>{{ item.descriptionZh || item.description || '暂未填写说明' }}</p><small>ID：{{ item.id }} · 阶段：{{ stageText(item.stages || []) }} · {{ effectText(item.effects || []) }}</small></div>
            </div>
          </PagedList>
        </div>
        <div v-if="catalog.length" class="form-section">
          <div class="section-heading-row"><div><div class="section-title"><Icon name="cpu" :size="13" />Custom 代码过滤器</div><p class="muted small">受信任管理员维护的独立代码包。</p></div><span class="filter-count">{{ customFilterCount }} 个实现</span></div>
          <PagedList :rows="catalog" :page-size="6" label="Custom Filter" list-class="extension-library-list" v-slot="{ item }">
            <div class="extension-library-card" :class="{ enabled: item.enabled }">
              <span class="extension-type-mark custom"><Icon name="filter" :size="17" /></span>
              <div class="extension-library-copy">
                <div class="row"><strong>{{ item.displayNameZh || item.name || item.id }}</strong><span class="badge">Custom Filter</span><span class="badge" :class="item.enabled ? 'on' : 'risk-medium'">{{ item.enabled ? '已启用' : '已停用' }}</span></div>
                <p>{{ item.descriptionZh || item.description || '暂未填写说明' }}</p>
                <small>ID：{{ item.id }} · 实现：{{ (item.filters || []).map(filter => filter.displayNameZh || filter.displayName || filter.id).join('、') || '暂无' }} · 资源：{{ Object.keys(item.frameworkResources || {}).length }}</small>
              </div>
              <div class="extension-library-actions">
                <button class="btn small outline" type="button" @click="$emit('open-filter', item.id)"><Icon name="pencil" :size="13" />编辑</button>
                <button class="btn small" :class="item.enabled ? 'outline' : 'primary'" type="button" @click="$emit('toggle-filter', item, !item.enabled)"><Icon :name="item.enabled ? 'power' : 'check'" :size="13" />{{ item.enabled ? '停用' : '启用' }}</button>
                <button class="btn small outline warn" type="button" @click="$emit('remove-filter', item)"><Icon name="trash" :size="13" />删除</button>
              </div>
            </div>
          </PagedList>
        </div>
        <div v-if="!builtinImplementations.length && !catalog.length" class="extension-empty-state"><Icon name="filter" :size="22" /><strong>还没有代码过滤器实现</strong><p>先创建一个骨架，再按步骤补参数、资源和代码。</p><button class="btn primary small" type="button" @click="$emit('create-filter')">新建代码过滤器</button></div>
      </template>
    </Panel>
  `,
}
