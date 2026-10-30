import { MemoryGroupPicker } from "./memory-group-picker.js"
import { MemoryPortraitWorkspace } from "./memory-portrait.js"
import { MemoryMaintenanceDialog } from "./memory-maintenance.js"

// 记忆管理工作区：群公共记忆、群成员与成员记忆列表。
export const MemoryManageWorkspace = {
  name: "MemoryManageWorkspace",
  components: { MemoryPortraitWorkspace, MemoryGroupPicker, MemoryMaintenanceDialog },
  props: {
    view: { type: Object, required: true },
  },
  template: `
    <template v-if="view.activeWorkspace === 'manage'">
      <header class="group-memory-toolbar">
        <MemoryGroupPicker :view="view" />
        <span v-if="view.selectedPolicy" class="muted small group-memory-context">{{ view.selectedPolicy.enabled ? '正在采集' : '采集已暂停' }}</span>
        <button class="icon-btn" type="button" :disabled="view.busy" data-tip="刷新群和记忆列表" @click="view.refreshWorkspace"><Icon name="refresh" :size="16" :class="{ 'icon-spin': view.busy }" /></button>
      </header>

      <div v-if="view.selectedGroupId && view.groupWorkspace" class="group-memory-body">
        <section class="group-memory-section">
          <div class="memory-section-head group-memory-section-head">
            <div><h2>群公共记忆</h2><p>对全体成员生效，只在当前群中召回；卡片会标出当前生命周期。</p></div>
            <div class="row"><MemoryMaintenanceDialog :group-id="view.selectedGroupId" name="本群公共记忆" @submitted="view.openMaintenanceTasks" /><MemoryMaintenanceDialog :group-id="view.selectedGroupId" :batch="true" name="本群已记录成员及公共记忆" @submitted="view.openMaintenanceTasks" /><button class="btn primary small" type="button" @click="view.openMemoryEditor(null, view.targetForGroup())"><Icon name="plus" :size="14" />添加群记忆</button></div>
          </div>
          <div class="memory-list-tools">
            <SearchInput v-model="view.groupMemoryQuery" placeholder="搜索群公共记忆" />
            <span class="muted tiny">{{ view.groupMemory.total }} 条</span>
          </div>
          <div v-if="view.groupMemory.items.length" class="memory-row-list">
            <article v-for="item in view.groupMemory.items" :key="item.id" class="memory-summary-row" tabindex="0" role="button" :title="item.text" @click="view.openMemoryEditor(item, view.targetForGroup())" @keydown.enter.self.prevent="view.openMemoryEditor(item, view.targetForGroup())" @keydown.space.self.prevent="view.openMemoryEditor(item, view.targetForGroup())">
              <span class="memory-bullet">•</span><div class="memory-row-copy"><p>{{ item.text }}</p><div class="memory-row-meta"><span>置信度 {{ view.memoryPercent(item.confidence) }}</span><span v-if="item.lifecycle">{{ item.lifecycle.halfLifeDays === null ? '不随时间衰减' : '活跃度 ' + view.memoryPercent(item.lifecycle.decay) }}</span><span v-if="item.evidenceCount">{{ item.evidenceCount }} 条来源</span></div></div><span class="memory-lifecycle" :class="view.memoryLifecycle(item).tone" :title="view.memoryLifecycle(item).title">{{ view.memoryLifecycle(item).label }}</span><span class="muted tiny">{{ view.timeLabel(item.updatedAt || item.createdAt) }}</span>
              <button class="icon-btn sm" type="button" data-tip="删除记忆" @click.stop="view.deleteMemory(item, view.targetForGroup())"><Icon name="trash" :size="14" /></button>
            </article>
          </div>
          <div v-else class="memory-list-empty"><Icon name="database" :size="20" /><span>这里还没有群公共记忆。</span></div>
          <div v-if="view.groupMemory.total > view.groupMemory.pageSize" class="memory-pagebar"><span>第 {{ view.groupMemory.page }} / {{ Math.ceil(view.groupMemory.total / view.groupMemory.pageSize) }} 页</span><div><button class="icon-btn sm" type="button" :disabled="view.groupMemory.page <= 1" @click="view.changeGroupPage(view.groupMemory.page - 1)"><Icon name="chevron-left" :size="15" /></button><button class="icon-btn sm" type="button" :disabled="view.groupMemory.page >= Math.ceil(view.groupMemory.total / view.groupMemory.pageSize)" @click="view.changeGroupPage(view.groupMemory.page + 1)"><Icon name="chevron-right" :size="15" /></button></div></div>
        </section>

        <div class="group-member-area">
          <aside class="group-member-list">
            <div class="memory-section-head"><div><h2>群成员</h2><p>显示有记忆或已采集发言的成员，默认按记忆块数排列。</p></div></div>
            <SearchInput v-model="view.memberQuery" placeholder="搜索成员 QQ 或昵称" />
            <div class="group-member-rows">
              <button v-for="member in view.members" :key="member.userId" class="group-member-row" :class="{ active: view.selectedMember?.userId === member.userId }" type="button" @click="view.selectMember(member)"><span class="memory-target-icon"><Icon name="bot" :size="15" /></span><span class="group-member-copy"><strong>{{ member.name || '用户 ' + member.userId }}</strong><small>QQ {{ member.userId }}</small></span><span v-if="member.memoryCount" class="badge">{{ member.memoryCount }}</span></button>
              <p v-if="!view.members.length" class="muted small">暂无匹配成员。</p>
            </div>
          </aside>

          <section v-if="view.selectedMember && view.memberWorkspace" class="member-memory-panel">
            <header class="member-memory-head"><div><h2>{{ view.selectedMemberName }}</h2><p>{{ view.memberScope === 'portrait' ? '结合本群发言和有效记忆生成，各类型每人每群每月一次。' : (view.memberScope === 'user_group' ? '仅显示可复用事实，仅在当前群中召回' : '仅显示可复用事实，所有对话可用') + '；活跃度随时间衰减，再次确认后重新计时。' }}</p></div><div v-if="view.memberScope !== 'portrait'" class="row"><MemoryMaintenanceDialog :group-id="view.selectedGroupId" :user-id="view.selectedMember.userId" :name="view.selectedMemberName" @submitted="view.openMaintenanceTasks" /><button class="btn small outline" type="button" @click="view.openProfileEditor"><Icon name="bot" :size="14" />编辑画像</button><button class="btn primary small" type="button" @click="view.openMemoryEditor(null, view.targetForMember())"><Icon name="plus" :size="14" />添加记忆</button></div></header>
            <div class="segmented member-memory-tabs" aria-label="成员记忆范围"><button type="button" :class="{ active: view.memberScope === 'user_group' }" @click="view.memberScope = 'user_group'">本群记忆 <span>{{ view.memberWorkspace.groupMemory.total }}</span></button><button type="button" :class="{ active: view.memberScope === 'user' }" @click="view.memberScope = 'user'">全局记忆 <span>{{ view.memberWorkspace.globalMemory.total }}</span></button><button type="button" :class="{ active: view.memberScope === 'portrait' }" @click="view.memberScope = 'portrait'">聊天画像</button></div>
            <MemoryPortraitWorkspace v-if="view.memberScope === 'portrait'" :group-id="view.selectedGroupId" :user-id="view.selectedMember.userId" :name="view.selectedMemberName" :enabled="Boolean(view.selectedPolicy?.enabled)" />
            <template v-else>
            <div class="memory-list-tools"><SearchInput v-model="view.memberMemoryQuery" placeholder="搜索该成员的记忆" /><span class="muted tiny">{{ view.currentMemberMemory.total }} 条</span></div>
            <div v-if="view.currentMemberMemory.items.length" class="memory-row-list">
              <article v-for="item in view.currentMemberMemory.items" :key="item.id" class="memory-summary-row" tabindex="0" role="button" :title="item.text" @click="view.openMemoryEditor(item, view.targetForMember())" @keydown.enter.self.prevent="view.openMemoryEditor(item, view.targetForMember())" @keydown.space.self.prevent="view.openMemoryEditor(item, view.targetForMember())"><span class="memory-bullet">•</span><div class="memory-row-copy"><p>{{ item.text }}</p><div class="memory-row-meta"><span>置信度 {{ view.memoryPercent(item.confidence) }}</span><span v-if="item.lifecycle">{{ item.lifecycle.halfLifeDays === null ? '不随时间衰减' : '活跃度 ' + view.memoryPercent(item.lifecycle.decay) }}</span><span v-if="item.evidenceCount">{{ item.evidenceCount }} 条来源</span></div></div><span class="memory-lifecycle" :class="view.memoryLifecycle(item).tone" :title="view.memoryLifecycle(item).title">{{ view.memoryLifecycle(item).label }}</span><span class="muted tiny">{{ view.timeLabel(item.updatedAt || item.createdAt) }}</span><button class="icon-btn sm" type="button" data-tip="删除记忆" @click.stop="view.deleteMemory(item, view.targetForMember())"><Icon name="trash" :size="14" /></button></article>
            </div>
            <div v-else class="memory-list-empty"><Icon name="database" :size="20" /><span>这里还没有{{ view.memberScope === 'user_group' ? '本群' : '全局' }}记忆。</span></div>
            <div v-if="view.currentMemberMemory.total > view.currentMemberMemory.pageSize" class="memory-pagebar"><span>第 {{ view.currentMemberMemory.page }} / {{ Math.ceil(view.currentMemberMemory.total / view.currentMemberMemory.pageSize) }} 页</span><div><button class="icon-btn sm" type="button" :disabled="view.currentMemberMemory.page <= 1" @click="view.changeMemberPage(view.currentMemberMemory.page - 1)"><Icon name="chevron-left" :size="15" /></button><button class="icon-btn sm" type="button" :disabled="view.currentMemberMemory.page >= Math.ceil(view.currentMemberMemory.total / view.currentMemberMemory.pageSize)" @click="view.changeMemberPage(view.currentMemberMemory.page + 1)"><Icon name="chevron-right" :size="15" /></button></div></div>
            </template>
          </section>
          <section v-else class="member-memory-empty"><Icon name="bot" :size="24" /><strong>选择一位群成员</strong><p>可分别维护其在本群的记忆和跨群可用的全局记忆。</p></section>
        </div>
      </div>
      <div v-else class="member-memory-empty group-memory-empty"><Icon name="message" :size="28" /><strong>先添加一个采集群</strong><p>添加并保存采集配置后，即可在这里维护群公共记忆和成员记忆。</p><button class="btn primary small" type="button" @click="view.openCaptureSettings()"><Icon name="plus" :size="14" />新增采集配置</button></div>
    </template>
  `,
}
