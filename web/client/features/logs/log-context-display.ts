import { computed, ref, type PropType } from "vue"
import { asRecord, type UnknownRecord } from "../../shared/data.js"
import { compactMediaDataForDisplay, modelMessageImageCount } from "./log-media-display.js"

interface ContextItem extends UnknownRecord {
  index?: number
  source?: string
  label?: string
  chars?: number
  tokenEstimate?: number
}

interface ContextSection extends ContextItem {
  messageIndexes?: number[]
  content?: string
}

export interface ContextSnapshot extends UnknownRecord {
  messages?: unknown[]
  request?: UnknownRecord
}

const sources: Record<string, { label: string; icon: string; tone: string }> = {
  "system-context": { label: "系统上下文", icon: "sliders", tone: "system" },
  "step-instruction": { label: "步骤指令", icon: "list", tone: "system" },
  workflow: { label: "前序步骤", icon: "list", tone: "system" },
  "persona-runtime": { label: "系统运行规则", icon: "sliders", tone: "system" },
  "runtime-instruction": { label: "运行时收束指令", icon: "sliders", tone: "system" },
  "runtime-time": { label: "当前时间", icon: "clock", tone: "neutral" },
  persona: { label: "角色设定", icon: "bot", tone: "persona" },
  "persona-extra": { label: "额外系统提示", icon: "message", tone: "persona" },
  skill: { label: "Skill 指令", icon: "sparkles", tone: "skill" },
  memory: { label: "记忆召回", icon: "database", tone: "memory" },
  knowledge: { label: "知识库召回", icon: "book", tone: "knowledge" },
  "command-knowledge": { label: "内置指令知识", icon: "book", tone: "knowledge" },
  media: { label: "媒体与消息附加内容", icon: "file", tone: "media" },
  "message-reference": { label: "本轮指代", icon: "message", tone: "media" },
  recent: { label: "最近消息上下文", icon: "clock", tone: "history" },
  history: { label: "会话历史", icon: "message", tone: "history" },
  current: { label: "当前提问", icon: "message", tone: "current" },
  "model-decision": { label: "模型工具决策", icon: "cpu", tone: "tool" },
  "tool-result": { label: "工具返回结果", icon: "wrench", tone: "tool" },
  other: { label: "其他上下文", icon: "list", tone: "neutral" },
}

export function contextSourceLabel(value: unknown): string {
  const item = asRecord(value)
  const key = String(item.source || (typeof value === "string" ? value : ""))
  return sources[key]?.label || String(item.label || key || sources.other.label)
}

function sourceStyle(source: string) {
  return sources[source] || sources.other
}

function displayText(value: unknown): string {
  const compact = compactMediaDataForDisplay(value)
  if (typeof compact === "string") return compact
  return JSON.stringify(compact ?? "", null, 2) || ""
}

function messageBody(value: unknown): string {
  const content = asRecord(value).content
  if (content == null) return ""
  if (!Array.isArray(content)) return displayText(content)
  return content.map(part => {
    const item = asRecord(part)
    return ["text", "input_text", "output_text"].includes(String(item.type)) && typeof item.text === "string"
      ? item.text : displayText(part)
  }).join("\n\n")
}

export function buildContextDisplay(snapshot: ContextSnapshot | null | undefined) {
  const metadata = asRecord(asRecord(asRecord(snapshot?.request).metadata).context)
  const items = Array.isArray(metadata.items) ? metadata.items.map(item => asRecord<ContextItem>(item)) : []
  const sections = Array.isArray(metadata.sections) ? metadata.sections.map(item => asRecord<ContextSection>(item)) : []
  const itemByIndex = new Map(items.map(item => [Number(item.index), item]))
  const messages = (snapshot?.messages || []).map((value, index) => {
    const message = asRecord(value)
    const item = itemByIndex.get(index) || {}
    const source = String(item.source || "other")
    const body = messageBody(value)
    const chars = Number(item.chars ?? (typeof message.content === "string" ? message.content.length : JSON.stringify(message.content ?? "").length))
    return {
      index, source, label: contextSourceLabel(item), body,
      role: String(message.role || "unknown"),
      chars, tokens: Number(item.tokenEstimate ?? Math.ceil(chars / 4)),
      images: modelMessageImageCount(value),
      toolCalls: message.tool_calls,
      raw: value,
    }
  })
  const validIndexes = (section: ContextSection) => [...new Set((section.messageIndexes || []).filter(index => Number.isInteger(index) && index >= 0 && index < messages.length))]
  const references = new Map<number, number>()
  for (const section of sections) for (const index of validIndexes(section)) references.set(index, (references.get(index) || 0) + 1)
  const groups = sections.map((section, index) => {
    const indexes = validIndexes(section)
    const source = String(section.source || "other")
    // 一个 system 消息可能包含多类注入；缺少分段正文时不能把整条消息冒充某类注入。
    const hasContent = typeof section.content === "string" && section.content.length > 0
    const shared = indexes.some(index => (references.get(index) || 0) > 1)
    const entries = hasContent || shared ? [] : indexes.map(index => messages[index])
    return {
      id: `section-${index}`, source, label: contextSourceLabel(section),
      subtitle: section.label && section.label !== contextSourceLabel(section) ? section.label : "",
      indexes, body: hasContent ? section.content! : "", entries,
      chars: Number(section.chars ?? (hasContent ? section.content!.length : entries.reduce((sum, item) => sum + item.chars, 0))),
      tokens: section.tokenEstimate == null ? null : Number(section.tokenEstimate),
      unavailable: !hasContent && !entries.length,
    }
  })
  // 旧日志没有来源分段，或快照分段不完整时，仍保留所有未被覆盖的消息。
  const uncovered = new Map<string, typeof messages>()
  for (const message of messages) {
    if (references.has(message.index)) continue
    const entries = uncovered.get(message.source) || []
    entries.push(message)
    uncovered.set(message.source, entries)
  }
  for (const [source, entries] of uncovered) groups.push({
    id: `messages-${source}`, source, label: contextSourceLabel(entries[0]), subtitle: "",
    indexes: entries.map(item => item.index), body: "", entries,
    chars: entries.reduce((sum, item) => sum + item.chars, 0),
    tokens: entries.reduce((sum, item) => sum + item.tokens, 0), unavailable: false,
  })
  return { messages, groups, hasSources: sections.length > 0 || items.some(item => item.source) }
}

export const LogContextView = {
  name: "LogContextView",
  props: { snapshot: { type: Object as PropType<ContextSnapshot | null>, default: null } },
  setup(props: { snapshot: ContextSnapshot | null }) {
    const view = ref("messages")
    const display = computed(() => buildContextDisplay(props.snapshot))
    return {
      view, display, sourceStyle, displayText,
      number: (value: unknown) => Number(value || 0).toLocaleString("zh-CN"),
      references: (indexes: number[]) => indexes.map(index => `#${index + 1}`).join("、"),
      preview: (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 100),
    }
  },
  template: `
    <div class="logs-context-view">
      <div class="logs-context-toolbar">
        <div><b>{{ view === 'sources' ? '提示词与上下文来源' : '模型消息顺序' }}</b><span class="muted tiny">{{ view === 'sources' ? '按记录的来源展开，消息编号对应实际顺序' : '保留完整消息顺序，Token 为估算值' }}</span></div>
        <div class="logs-context-switch" aria-label="上下文展示方式">
          <button type="button" :aria-pressed="view === 'messages'" @click="view = 'messages'">按消息顺序</button>
          <button type="button" :aria-pressed="view === 'sources'" @click="view = 'sources'">按来源</button>
        </div>
      </div>
      <p v-if="display.messages.length && !display.hasSources" class="logs-context-note">此日志未记录来源分类，以下按消息展示，不推断注入类型。</p>
      <div v-if="view === 'sources'" class="logs-prompt-list">
        <details v-for="group in display.groups" :key="group.id" class="logs-prompt-card" :data-tone="sourceStyle(group.source).tone" :open="group.source === 'current'">
          <summary>
            <span class="logs-prompt-icon"><Icon :name="sourceStyle(group.source).icon" :size="16" /></span>
            <span class="logs-prompt-heading"><b>{{ group.label }}</b><span v-if="group.subtitle" class="muted tiny">{{ group.subtitle }}</span><span class="logs-prompt-preview">{{ preview(group.body || group.entries[0]?.body || (group.unavailable ? '未保存独立分段正文，可按消息顺序核对' : '工具调用结构')) }}</span></span>
            <span class="logs-prompt-meta"><span>{{ number(group.chars) }} 字符</span><span v-if="group.tokens !== null">≈ {{ number(group.tokens) }} Token</span></span>
            <Icon name="chevron-down" :size="14" class="logs-prompt-chevron" />
          </summary>
          <div class="logs-prompt-body">
            <div class="logs-prompt-provenance"><span v-if="group.body || group.unavailable">{{ group.indexes.length ? '消息 ' + references(group.indexes) : '未记录关联消息' }}</span><span>来源 · {{ group.source }}</span></div>
            <pre v-if="group.body">{{ group.body }}</pre>
            <p v-else-if="group.unavailable" class="logs-context-note">此分段未保存独立正文，请切换“按消息顺序”查看关联消息。来源摘要不代表额外发送了一条消息。</p>
            <div v-for="message in group.entries" :key="message.index" class="logs-prompt-message">
              <div class="logs-prompt-provenance"><b>#{{ message.index + 1 }} · {{ message.role }}</b><span v-if="message.images">图片 {{ number(message.images) }} 张</span></div>
              <pre v-if="message.body">{{ message.body }}</pre>
              <details v-if="message.toolCalls" class="logs-inline-json"><summary>工具调用结构</summary><pre>{{ displayText(message.toolCalls) }}</pre></details>
              <p v-if="!message.body && !message.toolCalls" class="logs-context-note">消息正文为空。</p>
            </div>
          </div>
        </details>
      </div>
      <div v-else class="logs-prompt-list">
        <details v-for="message in display.messages" :key="message.index" class="logs-prompt-card" :data-tone="sourceStyle(message.source).tone" open>
          <summary><span class="logs-prompt-icon logs-prompt-number">{{ message.index + 1 }}</span><span class="logs-prompt-heading"><b>{{ message.role }} <span class="muted">· {{ message.label }}</span></b><span class="logs-prompt-preview">{{ preview(message.body) }}</span></span><span class="logs-prompt-meta"><span>{{ number(message.chars) }} 字符<span v-if="message.images"> · {{ message.images }} 张图片</span></span><span>≈ {{ number(message.tokens) }} Token</span></span><Icon name="chevron-down" :size="14" class="logs-prompt-chevron" /></summary>
          <div class="logs-prompt-body"><pre v-if="message.body">{{ message.body }}</pre><details v-if="message.toolCalls" class="logs-inline-json"><summary>工具调用结构</summary><pre>{{ displayText(message.toolCalls) }}</pre></details><p v-if="!message.body && !message.toolCalls" class="logs-context-note">消息正文为空。</p><details class="logs-inline-json"><summary>完整消息结构</summary><pre>{{ displayText(message.raw) }}</pre></details></div>
        </details>
      </div>
      <p v-if="!display.messages.length && !display.groups.length" class="logs-empty compact"><Icon name="message" :size="20" /><span>本次调用没有消息上下文，可能是 embedding 请求。</span></p>
    </div>
  `,
}
