import { computed, ref } from "vue"
import { asRecord } from "../../shared/data.js"
import { renderRichContent } from "../../shared/rich-content.js"

export const ChatProcessPanel = {
  name: "ChatProcessPanel",
  props: { entries: { type: Array, default: () => [] }, active: Boolean, mediaUrls: { type: Object, default: () => ({}) } },
  setup(props: { entries: unknown[]; active: boolean; mediaUrls?: Record<string, string> }) {
    const expanded = ref(false)
    const openEntries = ref<Record<string, boolean>>({})
    const toolCount = computed(() => props.entries.filter(entry => asRecord(entry).kind === "tool").length)
    function toggle(event: Event) { expanded.value = (event.currentTarget as HTMLDetailsElement).open }
    function toggleEntry(id: unknown, event: Event) { openEntries.value[String(id)] = (event.currentTarget as HTMLDetailsElement).open }
    const statusText = (value: string) => ({ running: "进行中", queued: "排队中", accepted: "已受理", ok: "已完成", failed: "失败", canceled: "已停止", partial: "部分完成", skipped: "已跳过" } as Record<string, string>)[value] || value
    const pretty = (value: unknown) => JSON.stringify(value, null, 2)
    const resultContent = (value: unknown) => { if (typeof value === "string") { try { return JSON.parse(value) as unknown } catch { /* 普通 Markdown 结果保持文本。 */ } } return value }
    const renderContent = (value: unknown) => renderRichContent(value, { cacheRemoteMedia: true, mediaUrls: props.mediaUrls })
    return { expanded, openEntries, toolCount, toggle, toggleEntry, statusText, pretty, resultContent, renderRichContent: renderContent }
  },
  template: `
    <details class="chat-process" :open="expanded" @toggle="toggle">
      <summary><Icon class="chat-process-chevron" name="chevron-right" :size="13" /><span>本轮执行过程</span><span class="chat-process-count">{{ active ? '进行中 · ' : '' }}{{ toolCount }} 次工具调用</span></summary>
      <ol v-if="expanded" class="chat-process-list">
        <li v-for="entry in entries" :key="entry.id" :class="entry.status">
          <details class="chat-process-step" :open="Boolean(openEntries[entry.id])" @toggle="toggleEntry(entry.id, $event)">
          <summary class="chat-process-title"><b>{{ entry.kind === 'model' ? '模型 · ' + entry.channel : '工具 · ' + entry.name }}</b><span>{{ statusText(entry.status) }}<template v-if="entry.durationMs !== undefined"> · {{ entry.durationMs }} ms</template></span></summary>
          <div v-if="openEntries[entry.id]" class="chat-process-step-content">
          <template v-if="entry.kind === 'model'">
            <details class="chat-process-tools"><summary>本次注入 {{ (entry.tools || []).length }} 个工具 · {{ entry.messageCount || 0 }} 条上下文</summary><p v-if="!entry.tools?.length">本次未注入本地工具。</p><details v-for="tool in entry.tools || []" :key="tool.name"><summary>{{ tool.name }}</summary><p>{{ tool.description }}</p><pre>{{ pretty(tool.parameters) }}</pre></details></details>
            <details class="chat-process-reasoning"><summary>模型思考{{ entry.reasoning ? '' : ' · 未返回可见内容' }}</summary><div v-if="entry.reasoning" class="chat-rich-content" v-html="renderRichContent(entry.reasoning)"></div><p v-else>此处只展示模型显式返回的思考文本或摘要。</p></details>
            <details v-if="entry.text"><summary>本次模型输出</summary><div class="chat-rich-content" v-html="renderRichContent(entry.text)"></div></details>
          </template>
          <template v-else><details v-if="entry.arguments"><summary>调用参数</summary><pre>{{ pretty(entry.arguments) }}</pre></details><div v-if="entry.result" class="chat-tool-output"><span>工具结果</span><div class="chat-rich-content" v-html="renderRichContent(resultContent(entry.result))"></div></div></template>
          <p v-if="entry.error" class="chat-process-error">{{ entry.error }}</p>
          <p v-if="entry.historyTruncated">过程内容较长，历史中仅保留部分记录。</p>
          </div></details>
        </li>
      </ol>
    </details>`,
}
