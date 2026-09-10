import { computed, nextTick, onMounted, ref } from "vue"
import { confirmAction, refreshSlices, request, store, toast } from "../../app/store/store.js"
import { asRecord, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { plainTextContent, renderRichContent } from "../../shared/rich-content.js"

interface ChatMessage {
  id: string
  role: string
  text: string
  content?: unknown
  raw?: unknown
  at: string
}

interface StoredMessage {
  role: string
  text?: unknown
  content?: unknown
  at?: unknown
}

interface ChatSession {
  key: string
  sessionId: string
  channelId?: string
  title?: string
  messageCount?: number
  lastSeenAt?: string
  messages?: StoredMessage[]
}

interface Channel {
  id: string
  name?: string
  model?: string
  enabled?: boolean
}

interface ProviderData extends UnknownRecord {
  channels?: Channel[]
}

interface ModelConfig {
  adapter?: string
  name?: string
}

interface AppConfig extends UnknownRecord {
  chat?: { defaultChannel?: string }
  models?: ModelConfig[]
}

interface ChatResult extends UnknownRecord {
  inputBlocked?: boolean
  inputBlockReason?: string
  text?: string
  content?: unknown
  images?: unknown[]
  media?: unknown
}

interface ChatResponse extends UnknownRecord {
  sessionId?: string
  session?: ChatSession
  result?: ChatResult
}

function createSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function messageFromStored(item: StoredMessage, index: number): ChatMessage {
  const content = item.content !== undefined ? item.content : item.text
  return {
    id: `${index}-${item.role}-${plainTextContent(content)}`,
    role: item.role,
    text: plainTextContent(content),
    content,
    raw: item,
    at: String(item.at || ""),
  }
}

export const ChatTab = {
  name: "ChatTab",
  setup() {
    const sessionId = ref("")
    const sessionKey = ref("")
    const messages = ref<ChatMessage[]>([])
    const sessions = ref<ChatSession[]>([])
    const loadingSessions = ref(false)
    const prompt = ref("")
    const channelId = ref("")
    const sending = ref(false)
    const conversationEl = ref<HTMLElement | null>(null)
    const suggestions = [
      "你好，请用两句话介绍你自己，并告诉我当前能做什么。",
      "请用自然、简洁的语气解释一下你的回复风格。",
      "如果我想查询机器人指令，你会怎么帮助我？",
      "请给我一个适合群聊的简短欢迎语。",
    ]

    const providers = computed(() => asRecord<ProviderData>(store.providers))
    const config = computed(() => asRecord<AppConfig>(store.config))
    const channels = computed(() => (providers.value.channels || []).filter(item => item.enabled !== false))
    const channelOptions = computed(() => [
      { value: "", label: `默认回复模型${config.value.chat?.defaultChannel ? ` · ${config.value.chat.defaultChannel}` : ""}` },
      ...channels.value.map(item => ({ value: item.id, label: `${item.name || item.id}${item.model && item.model !== item.id ? ` · ${item.model}` : ""}` })),
    ])
    const usingMockOnly = computed(() => {
      const models = config.value.models || []
      return Boolean(models.length) && models.every(model => model.adapter === "mock" || model.name === "mock")
    })
    const activeSession = computed(() => sessions.value.find(item => item.key === sessionKey.value) || null)

    async function scrollToBottom() {
      await nextTick()
      const el = conversationEl.value
      if (el) el.scrollTop = el.scrollHeight
    }

    function applySession(session: ChatSession | null | undefined, { updateSelection = true }: { updateSelection?: boolean } = {}) {
      if (!session) {
        messages.value = []
        return
      }
      messages.value = (session.messages || []).map(messageFromStored)
      // sessionKey 始终跟随正在展示的会话，侧栏高亮和“删除当前会话”才能对上；
      // updateSelection 只控制是否覆盖 sessionId 与用户选择的渠道。
      sessionKey.value = session.key
      if (updateSelection) {
        sessionId.value = session.sessionId
        channelId.value = session.channelId || ""
      }
      scrollToBottom()
    }

    async function loadSessions() {
      loadingSessions.value = true
      try {
        const response = asRecord<{ sessions?: ChatSession[] }>(await request("/api/chat/test/sessions?limit=50"))
        sessions.value = Array.isArray(response.sessions) ? response.sessions : []
        const selected = sessions.value.find(item => item.sessionId === sessionId.value)
        if (selected) applySession(selected, { updateSelection: false })
        // 列表为空或当前会话不在列表（如 SQLite 降级只有本地消息）时保留已展示的
        // 内容；只有用户显式切换或新建会话才清空当前对话。
        else if (sessions.value[0] && !sessionId.value && !messages.value.length) applySession(sessions.value[0])
      } catch (err) {
        toast(errorMessage(err, "读取测试历史失败"))
      } finally {
        loadingSessions.value = false
      }
    }

    function addPendingMessage(message: Pick<ChatMessage, "role" | "text" | "content" | "raw">) {
      messages.value.push({ id: createSessionId(), at: new Date().toISOString(), ...message })
      scrollToBottom()
    }

    function replaceCurrentSession(session: ChatSession | null | undefined) {
      if (!session) return
      const index = sessions.value.findIndex(item => item.key === session.key)
      if (index >= 0) sessions.value.splice(index, 1)
      sessions.value.unshift(session)
      applySession(session)
    }

    async function send() {
      const text = String(prompt.value || "").trim()
      if (!text || sending.value) return
      if (text.length > 4000) {
        toast("单条测试消息不能超过 4000 个字符")
        return
      }
      prompt.value = ""
      addPendingMessage({ role: "user", text })
      sending.value = true
      try {
        const response = asRecord<ChatResponse>(await request("/api/chat/test", {
          method: "POST",
          body: JSON.stringify({ prompt: text, sessionId: sessionId.value || createSessionId(), channelId: channelId.value }),
        }))
        sessionId.value = response.sessionId || sessionId.value
        if (response.session) {
          replaceCurrentSession(response.session)
        } else if (response.result?.inputBlocked) {
          addPendingMessage({ role: "system", text: response.result.inputBlockReason || "消息已被输入过滤器拦截。" })
        } else if (response.result?.text || response.result?.content || response.result?.images?.length || response.result?.media) {
          // SQLite 降级时服务端没有持久会话可回查：直接用返回的回复文本本地追加，
          // 不再依赖 loadSessions 兜底（空列表会把刚发的消息清掉）。
          const content = response.result.content ?? response.result.text ?? response.result.images ?? response.result.media
          addPendingMessage({ role: "assistant", text: plainTextContent(content), content, raw: response.result })
        }
        await refreshSlices(["setupGuide", "conversations"])
      } catch (err) {
        addPendingMessage({ role: "error", text: errorMessage(err, "对话测试失败。") })
      } finally {
        sending.value = false
        scrollToBottom()
      }
    }

    function onComposerKeydown(event: KeyboardEvent) {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
      event.preventDefault()
      send()
    }

    function useSuggestion(text: string) { prompt.value = text }

    function newConversation() {
      sessionId.value = ""
      sessionKey.value = ""
      messages.value = []
      prompt.value = ""
      toast("已开始新的测试对话")
    }

    function selectSession(session: ChatSession) { applySession(session) }

    async function deleteSession(session: ChatSession) {
      const accepted = await confirmAction({
        title: "删除这段测试对话？",
        message: "将从 SQLite 中永久删除该测试会话及其消息。",
        detail: `共 ${session.messageCount || 0} 条消息`,
        confirmText: "删除对话",
        tone: "danger",
        icon: "trash",
      })
      if (!accepted) return
      try {
        await request(`/api/chat/test/sessions/${encodeURIComponent(session.key)}`, { method: "DELETE" })
        sessions.value = sessions.value.filter(item => item.key !== session.key)
        if (sessionKey.value === session.key) {
          const next = sessions.value[0]
          if (next) applySession(next)
          else newConversation()
        }
        toast("测试对话已删除")
        await refreshSlices(["conversations"])
      } catch (err) {
        toast(errorMessage(err, "删除测试对话失败"))
      }
    }

    async function copyMessage(text: string) {
      try {
        await navigator.clipboard.writeText(String(text || ""))
        toast("回复已复制")
      } catch {
        toast("复制失败，请手动选择文本")
      }
    }

    function timeText(value: unknown) {
      if (!value) return ""
      const date = new Date(String(value))
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    }

    function sessionTime(value: unknown) {
      const date = new Date(String(value))
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    }

    onMounted(async () => {
      await loadSessions()
      await scrollToBottom()
    })

    return {
      store, messages, sessions, loadingSessions, prompt, channelId, sending, conversationEl, suggestions,
      activeSession, channelOptions, usingMockOnly, send, onComposerKeydown, useSuggestion,
      newConversation, selectSession, deleteSession, copyMessage, timeText, renderRichContent,
      pretty: (value: unknown) => {
        try { return JSON.stringify(value, null, 2) || String(value ?? "") } catch { return String(value ?? "") }
      },
      sessionTime,
    }
  },
  template: `
    <div class="chat-test-page">
      <section class="chat-test-hero">
        <div>
          <span class="eyebrow"><Icon name="sparkles" :size="13" />真实模型验证</span>
          <h2>和你的 AI 助手聊两句</h2>
          <p>测试对话与历史记录保存在本机 SQLite，可随时切换或删除。</p>
        </div>
        <button class="btn" type="button" @click="newConversation"><Icon name="plus" :size="15" />新对话</button>
      </section>

      <div class="chat-safe-note"><Icon name="info" :size="15" /><span>安全测试模式：不会调用工具，不会向群聊发送内容，也不会写入长期记忆。</span></div>
      <div v-if="usingMockOnly" class="chat-safe-note warn"><Icon name="alert" :size="15" /><span>当前仍在使用 Mock 模型。可以体验页面流程，但接入真实模型后才能验证真实回复效果。</span></div>

      <div class="chat-test-workspace">
        <aside class="chat-history-panel">
          <div class="chat-history-head"><b>历史对话</b><span>{{ sessions.length }}</span></div>
          <div v-if="loadingSessions" class="chat-history-empty">正在读取…</div>
          <div v-else-if="!sessions.length" class="chat-history-empty">还没有已保存的测试对话</div>
          <div v-else class="chat-history-list">
            <article v-for="session in sessions" :key="session.key" class="chat-history-row" :class="{ active: activeSession?.key === session.key }" @click="selectSession(session)">
              <button class="chat-history-select" type="button"><b>{{ session.title }}</b><span>{{ session.messageCount }} 条 · {{ sessionTime(session.lastSeenAt) }}</span></button>
              <button class="icon-btn sm danger" type="button" data-tip="删除测试对话" @click.stop="deleteSession(session)"><Icon name="trash" :size="13" /></button>
            </article>
          </div>
        </aside>

        <section class="chat-window">
          <header class="chat-window-head">
            <div class="chat-agent"><span class="chat-agent-avatar"><Icon name="bot" :size="18" /></span><div><b>{{ store?.config?.persona?.firstPerson || 'Yui Chat' }}</b><span>{{ activeSession ? '已保存的 Web 测试对话' : '新的 Web 测试对话' }}</span></div></div>
            <label class="chat-model-select"><span>本次使用</span><select v-model="channelId" :disabled="sending"><option v-for="option in channelOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          </header>

          <div ref="conversationEl" class="chat-conversation" aria-live="polite">
            <div v-if="!messages.length" class="chat-empty"><span class="chat-empty-icon"><Icon name="message" :size="24" /></span><h3>发送第一条测试消息</h3><p>建议先验证基础回复，再测试人设和指令推荐。</p><div class="chat-suggestions"><button v-for="item in suggestions" :key="item" type="button" @click="useSuggestion(item)">{{ item }}</button></div></div>
            <article v-for="message in messages" :key="message.id" class="chat-message" :class="message.role">
              <div class="chat-message-avatar"><Icon :name="message.role === 'user' ? 'message' : (message.role === 'error' ? 'alert' : (message.role === 'system' ? 'info' : 'sparkles'))" :size="15" /></div>
              <div class="chat-bubble"><div class="chat-bubble-head"><b>{{ message.role === 'user' ? '你' : (message.role === 'error' ? '发送失败' : (message.role === 'system' ? '系统提示' : 'AI 助手')) }}</b><span>{{ timeText(message.at) }}</span></div><div class="chat-rich-content" v-html="renderRichContent(message.content ?? message.text)"></div><details v-if="store.developerMode && message.raw" class="chat-raw-content"><summary>原始内容</summary><pre>{{ pretty(message.raw) }}</pre></details><div v-if="message.role === 'assistant'" class="chat-message-meta"><button class="btn ghost sm" type="button" @click="copyMessage(message.text)"><Icon name="copy" :size="13" />复制</button></div></div>
            </article>
            <article v-if="sending" class="chat-message assistant"><div class="chat-message-avatar"><Icon name="sparkles" :size="15" /></div><div class="chat-bubble chat-thinking"><span></span><span></span><span></span><em>正在思考</em></div></article>
          </div>

          <footer class="chat-composer"><textarea v-model="prompt" rows="3" maxlength="4000" :disabled="sending" placeholder="输入一条测试消息。Enter 发送，Shift + Enter 换行" @keydown="onComposerKeydown"></textarea><div class="chat-composer-foot"><span>{{ prompt.length }} / 4000</span><button class="btn primary chat-send" type="button" :disabled="sending || !prompt.trim()" @click="send"><Icon :name="sending ? 'refresh' : 'play'" :class="{ 'icon-spin': sending }" :size="15" />{{ sending ? "生成中" : "发送" }}</button></div></footer>
        </section>
      </div>
    </div>
  `,
}
