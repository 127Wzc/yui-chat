import { createApp } from "vue"
import { store, applyTheme } from "./app/store/store.js"
import { AppShell } from "./app/app-shell.js"
import { components } from "./ui/components.js"

// 启动即套用主题（后端外壳已提前落 data-theme 防闪烁，这里只做同步）。
applyTheme(store.theme)
import { OverviewTab } from "./features/overview/overview-tab.js"
import { ChatTab } from "./features/chat/chat-tab.js"
import { ProvidersTab } from "./features/providers/providers-tab.js"
import { PersonaTab } from "./features/persona/persona-tab.js"
import { ToolsTab } from "./features/tools/tools-tab.js"
import { FiltersTab } from "./features/filters/filters-tab.js"
import { KnowledgeTab } from "./features/knowledge/knowledge-tab.js"
import { MemoryTab } from "./features/memory/memory-tab.js"
import { AdvancedTab } from "./features/advanced/advanced-tab.js"
import { LogsTab } from "./features/logs/logs-tab.js"

const app = createApp(AppShell)

// 全局注册公共组件库（Panel/Field/Pill/PagedList…）。
for (const [name, component] of Object.entries(components)) {
  app.component(name, component as Parameters<typeof app.component>[1])
}

// 全局注册页面组件，供 AppShell 动态 <component :is> 切换。
for (const tab of [OverviewTab, ChatTab, LogsTab, ProvidersTab, PersonaTab, ToolsTab, FiltersTab, KnowledgeTab, MemoryTab, AdvancedTab]) {
  const name = typeof tab.name === "string" ? tab.name : ""
  if (name) app.component(name, tab as Parameters<typeof app.component>[1])
}

app.config.errorHandler = err => {
  console.error("[yui-chat]", err)
}

app.mount("#app")
