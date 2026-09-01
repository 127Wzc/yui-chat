import { onMounted, onUnmounted, computed, ref } from "vue"
import {
  store,
  tabSlices,
  request,
  setTab,
  loadInitial,
  refreshTab,
  refreshSlices,
  connectWs,
  syncToken,
  toggleTheme,
  toast,
  hasUnsavedChanges,
  cancelPendingNavigation,
  discardPendingNavigation,
  confirmAction,
  consumeQuickLogin,
} from "./store/store.js"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object") as UnknownRecord[] : []
}

function errorMessage(error: unknown, fallback = "操作失败"): string {
  return error instanceof Error ? error.message : String(error || fallback)
}

const navGroups = [
  {
    label: "",
    tabs: [
      { id: "overview", label: "首页", icon: "dashboard", description: "统一查看系统健康、模型用量和运行趋势" },
      { id: "chat", label: "对话测试", icon: "message", description: "使用当前模型和人设进行安全测试" },
    ],
  },
  {
    label: "AI 助手",
    tabs: [
      { id: "providers", label: "模型与回复", icon: "server", description: "接入模型服务并设置主模型、备用模型和视觉辅助" },
      { id: "persona", label: "助手人设", icon: "bot", description: "称呼、触发与回复" },
      { id: "knowledge", label: "知识库", icon: "book", description: "管理知识库内容、机器人指令和检索质量" },
      { id: "memory", label: "记忆管理", icon: "database", description: "按单用户或单群维护画像与长期记忆" },
    ],
  },
  {
    label: "管理",
    tabs: [
      { id: "tools", label: "AI 能力", icon: "wrench", description: "管理可供模型调用的工具、Skill 与 MCP 服务" },
      { id: "filters", label: "代码过滤器", icon: "filter", description: "按顺序处理输入和输出正文" },
      { id: "tool-permissions", label: "使用权限", icon: "key", description: "设置不同角色可使用的能力范围" },
      { id: "logs", label: "日志与用量", icon: "activity", description: "查看大模型调用、Token 和费用" },
      { id: "advanced", label: "系统设置", icon: "sliders", description: "管理配置备份、运行维护和开发者设置" },
    ],
  },
]
const tabs = navGroups.flatMap(group => group.tabs)

const nameMap = {
  overview: "OverviewTab",
  chat: "ChatTab",
  logs: "LogsTab",
  providers: "ProvidersTab",
  persona: "PersonaTab",
  tools: "ToolsTab",
  filters: "FiltersTab",
  "tool-permissions": "ToolsTab",
  knowledge: "KnowledgeTab",
  memory: "MemoryTab",
  advanced: "AdvancedTab",
}

// 顶栏 + 图标侧栏 + 路由出口 + Toast：全站唯一外壳。
export const AppShell = {
  name: "AppShell",
  setup() {
    const activeComponent = computed(() => nameMap[store.activeTab] || "OverviewTab")
    const activeTabMeta = computed(() => tabs.find(tab => tab.id === store.activeTab) || tabs[0])
    const pendingTabMeta = computed(() => tabs.find(tab => tab.id === store.pendingTab) || null)
    const activeSliceKeys = computed(() => tabSlices[store.activeTab] || tabSlices.overview)
    const activeErrors = computed(() => activeSliceKeys.value
      .filter(key => store.sliceErrors[key])
      .map(key => ({ key, message: store.sliceErrors[key] })))
    const activeLoading = computed(() => activeSliceKeys.value.some(key => store.sliceLoading[key]))
    const refreshing = ref(false)
    const diagnosticsOpen = ref(false)
    const diagnosticsLoading = ref(false)
    const loginToken = ref(store.token || "")
    const loginBusy = ref(false)
    const loginError = ref("")
    const needsLogin = computed(() => !store.authenticated || /unauthorized|token|登录|令牌|401/i.test(store.bootError || ""))
    const diagnosticSummary = computed(() => record(record(store.diagnostics).summary))
    const diagnosticIssues = computed(() => records(record(store.diagnostics).issues))
    const diagnosticCount = computed(() => Number(diagnosticSummary.value.errorCount || 0) + Number(diagnosticSummary.value.warnCount || 0))

    function onHashChange() {
      const tab = (location.hash || "").replace(/^#/, "")
      if (tab) setTab(tab)
    }

    async function boot() {
      try {
        await consumeQuickLogin()
        await loadInitial()
        connectWs()
      } catch (err) {
        store.bootError = errorMessage(err)
      }
    }

    async function refresh() {
      if (refreshing.value) return
      refreshing.value = true
      try {
        if (!store.ready) await loadInitial()
        else {
          if (store.activeTab === "tools") await request("/api/tools/reload", { method: "POST" })
          await refreshTab()
        }
        toast("已刷新")
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        refreshing.value = false
      }
    }

    function diagnosticTarget(issue: UnknownRecord = {}) {
      const text = `${issue.area || ""} ${issue.message || ""}`.toLowerCase()
      if (/model|provider|channel|模型|渠道/.test(text)) return "providers"
      if (/persona|output|response|人格|回复|输出/.test(text)) return "persona"
      if (/tool|mcp|skill|render|工具|权限|渲染/.test(text)) return "tools"
      if (/memory|记忆|画像/.test(text)) return "memory"
      if (/knowledge|command|知识|指令/.test(text)) return "knowledge"
      return "advanced"
    }

    async function openDiagnostics() {
      diagnosticsOpen.value = true
      diagnosticsLoading.value = true
      try {
        await refreshSlices(["diagnostics"])
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        diagnosticsLoading.value = false
      }
    }

    function openDiagnosticTarget(issue: UnknownRecord) {
      diagnosticsOpen.value = false
      setTab(diagnosticTarget(issue))
    }

    function openSystemSettings() {
      diagnosticsOpen.value = false
      setTab("advanced")
    }

    async function retryBoot() {
      store.bootError = ""
      await boot()
    }

    async function loginDirect() {
      const token = String(loginToken.value || "").trim()
      if (!token) {
        loginError.value = "请输入 Web Token"
        return
      }
      loginBusy.value = true
      loginError.value = ""
      try {
        syncToken(token)
        await request("/api/auth/session", { method: "POST", body: "{}" })
        syncToken("")
        loginToken.value = ""
        store.bootError = ""
        await loadInitial()
        connectWs()
        toast("登录成功")
      } catch (err) {
        syncToken("")
        loginError.value = errorMessage(err, "登录失败")
        store.bootError = loginError.value
      } finally {
        loginBusy.value = false
      }
    }

    async function logout() {
      const accepted = await confirmAction({ title: "退出当前浏览器？", message: "浏览器短会话会被清除，下次可由主人发送 #yui面板 重新获取快捷链接，或使用已配置的 web.authToken。", confirmText: "确认退出", tone: "warn", icon: "power" })
      if (!accepted) return
      await request("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {})
      syncToken("")
      store.authenticated = false
      loginToken.value = ""
      store.ready = false
      store.bootError = "请重新登录"
      toast("已退出当前浏览器")
    }

    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!hasUnsavedChanges()) return
      event.preventDefault()
      event.returnValue = ""
    }

    onMounted(() => {
      window.addEventListener("hashchange", onHashChange)
      window.addEventListener("beforeunload", onBeforeUnload)
      boot()
    })
    onUnmounted(() => {
      window.removeEventListener("hashchange", onHashChange)
      window.removeEventListener("beforeunload", onBeforeUnload)
    })

    return {
      store, tabs, navGroups, activeComponent, activeTabMeta, pendingTabMeta,
      activeErrors, activeLoading, refreshing, diagnosticsOpen, diagnosticsLoading,
      diagnosticSummary, diagnosticIssues, diagnosticCount,
      loginToken, loginBusy, loginError, needsLogin,
      setTab, syncToken, toggleTheme, refresh, openDiagnostics, openDiagnosticTarget, openSystemSettings,
      retryBoot, loginDirect, logout,
      cancelPendingNavigation, discardPendingNavigation,
    }
  },
  template: `
    <main v-if="!store.ready" class="workspace auth-workspace">
      <section v-if="needsLogin" class="panel boot-state login-panel">
        <div class="panel-head"><h2><Icon name="key" :size="15" />Web 登录</h2></div>
        <div class="panel-body">
          <p class="muted small">静态登录只接受 <code>config/config.json</code> 中非空的 <code>web.authToken</code>；留空时此入口禁用。主人也可以在机器人聊天中发送 <code>#yui面板</code> 获取一次性快捷链接。</p>
          <form class="login-form login-manual" @submit.prevent="loginDirect">
            <Field
              label="Web Token"
              type="password"
              v-model="loginToken"
              placeholder="输入配置中的 web.authToken"
            />
            <p v-if="loginError || store.bootError" class="form-error">{{ loginError || store.bootError }}</p>
            <div class="action-bar">
              <button class="btn" type="submit" :disabled="loginBusy"><Icon name="key" :size="15" />{{ loginBusy ? "登录中" : "Web Token 登录" }}</button>
              <button class="btn" type="button" @click="retryBoot"><Icon name="refresh" :size="15" />重试</button>
            </div>
          </form>
        </div>
      </section>
      <section v-else-if="store.bootError" class="panel boot-state">
        <div class="panel-head"><h2><Icon name="alert" :size="15" />加载失败</h2></div>
        <div class="panel-body">
          <p class="muted small">{{ store.bootError }}</p>
          <div class="action-bar">
            <button class="btn primary" type="button" @click="retryBoot"><Icon name="refresh" :size="15" />重试</button>
          </div>
        </div>
      </section>
      <section v-else class="loading-state" aria-busy="true">
        <div class="spinner" aria-hidden="true"></div>
        <p class="muted small">正在验证登录…</p>
      </section>
    </main>

    <template v-else>
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-logo"><Icon name="sparkles" :size="17" /></div>
          <div class="brand-text"><b>Yui Chat</b><span>AI 助手管理中心</span></div>
        </div>
        <div v-for="group in navGroups" :key="group.label || 'main'" class="nav-group">
          <span v-if="group.label" class="nav-group-label">{{ group.label }}</span>
          <button
            v-for="tab in group.tabs"
            :key="tab.id"
            class="nav-item"
            :class="{ active: store.activeTab === tab.id }"
            type="button"
            @click="setTab(tab.id)"
          >
            <Icon :name="tab.icon" :size="17" /><span>{{ tab.label }}</span>
          </button>
        </div>
        <div class="nav-spacer"></div>
        <div class="nav-foot">TRSS-Yunzai · isolated AI console</div>
      </aside>

      <header class="topbar">
        <div class="page-title">
          <div class="page-title-row">
            <h1><Icon :name="activeTabMeta.icon" :size="17" />{{ activeTabMeta.label }}</h1>
            <button class="top-diagnostic-button" :class="{ attention: diagnosticCount }" type="button" @click="openDiagnostics">
              <Icon name="activity" :size="13" /><span>诊断</span><b v-if="diagnosticCount">{{ diagnosticCount }}</b><span v-else class="dot on"></span>
            </button>
          </div>
          <p>{{ activeTabMeta.description }}</p>
        </div>
        <div class="top-actions">
          <button class="icon-btn tip-bottom" data-tip="刷新当前页数据" type="button" @click="refresh">
            <Icon name="refresh" :size="16" :class="{ 'icon-spin': refreshing }" />
          </button>
          <button
            class="icon-btn tip-bottom"
            :data-tip="store.theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'"
            type="button"
            @click="toggleTheme"
          >
            <Icon :name="store.theme === 'dark' ? 'sun' : 'moon'" :size="16" />
          </button>
          <details class="account-menu">
            <summary class="account-trigger">
              <span class="account-avatar"><Icon name="key" :size="14" /></span>
              <span>已登录</span>
              <Icon name="chevron-down" :size="13" />
            </summary>
            <div class="account-popover">
              <div class="account-popover-head"><b>当前浏览器登录</b><span>使用受保护的 HttpOnly 会话，不保存 Web Token</span></div>
              <button class="btn danger" type="button" @click="logout"><Icon name="power" :size="14" />退出当前浏览器</button>
            </div>
          </details>
        </div>
      </header>

      <main class="workspace">
        <div v-if="activeLoading" class="page-load-line" aria-label="正在加载当前页面"><span></span></div>
        <section v-if="activeErrors.length" class="slice-error-banner" role="alert">
          <Icon name="alert" :size="17" />
          <div>
            <b>部分数据暂时没有加载成功</b>
            <p>{{ activeErrors.map(item => item.message).join('；') }}</p>
          </div>
          <button class="btn small" type="button" @click="refresh"><Icon name="refresh" :size="14" />重试</button>
        </section>
        <component :is="activeComponent" />
      </main>
    </template>

    <SideDrawer :open="diagnosticsOpen" title="运行诊断" subtitle="集中查看当前错误、警告和运行建议" icon="activity" width="560px" @close="diagnosticsOpen = false">
      <div class="diagnostic-overview">
        <div><b :class="{ danger: Number(diagnosticSummary.errorCount || 0) > 0 }">{{ diagnosticSummary.errorCount || 0 }}</b><span>错误</span></div>
        <div><b :class="{ warn: Number(diagnosticSummary.warnCount || 0) > 0 }">{{ diagnosticSummary.warnCount || 0 }}</b><span>警告</span></div>
        <div><b>{{ diagnosticIssues.length }}</b><span>待检查项</span></div>
      </div>
      <div v-if="diagnosticsLoading" class="drawer-loading"><span class="spinner"></span><span>正在检查运行状态…</span></div>
      <div v-else-if="diagnosticIssues.length" class="diagnostic-drawer-list">
        <article v-for="(issue, index) in diagnosticIssues" :key="index" class="diagnostic-action-card" :class="issue.level">
          <span class="diagnostic-action-icon"><Icon :name="issue.level === 'error' ? 'alert' : 'info'" :size="15" /></span>
          <div class="diagnostic-action-copy"><b>{{ issue.area || '运行状态' }}</b><p>{{ issue.message || '' }}</p><span>{{ issue.level === 'error' ? '需要处理' : '建议检查' }}</span></div>
          <button class="btn small" type="button" @click="openDiagnosticTarget(issue)">去处理<Icon name="chevron-right" :size="13" /></button>
        </article>
      </div>
      <div v-else class="diagnostic-empty"><span class="diagnostic-empty-icon"><Icon name="check" :size="20" /></span><b>当前运行正常</b><p>没有发现需要处理的错误或警告。</p></div>
      <template #actions><button class="btn" type="button" @click="openSystemSettings"><Icon name="sliders" :size="14" />打开系统设置</button></template>
    </SideDrawer>

    <Toast />
    <ConfirmDialog />

    <Teleport to="body">
      <div v-if="store.pendingTab" class="unsaved-layer" role="dialog" aria-modal="true" aria-labelledby="unsaved-title">
        <div class="unsaved-scrim" @click="cancelPendingNavigation"></div>
        <section class="unsaved-dialog">
          <span class="unsaved-icon"><Icon name="alert" :size="20" /></span>
          <div>
            <h2 id="unsaved-title">还有未保存的修改</h2>
            <p>离开“{{ activeTabMeta.label }}”会放弃当前草稿。你准备前往“{{ pendingTabMeta?.label || '其他页面' }}”。</p>
          </div>
          <div class="unsaved-actions">
            <button class="btn" type="button" @click="cancelPendingNavigation">继续编辑</button>
            <button class="btn danger" type="button" @click="discardPendingNavigation">放弃修改并离开</button>
          </div>
        </section>
      </div>
    </Teleport>
  `,
}
