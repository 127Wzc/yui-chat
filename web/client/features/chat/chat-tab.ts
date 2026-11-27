import { computed, nextTick, onMounted, onUnmounted, ref } from "vue"
import { confirmAction, refreshSlices, request, requestStream, store, toast } from "../../app/store/store.js"
import { asRecord, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { ChatProcessPanel } from "./chat-process-panel.js"
import { plainTextContent, renderRichContent } from "../../shared/rich-content.js"

interface ChatMessage {
  id: string
  role: string
  text: string
  content?: unknown
  raw?: unknown
  at: string
  name?: string
  status?: string
  progress?: UnknownRecord[]
}

interface StoredMessage {
  progress?: UnknownRecord[]
  name?: string
  status?: string
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
  purpose?: string
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
  progress?: UnknownRecord[]
  displayContent?: unknown[]
  toolChain?: UnknownRecord[]
  deliveredReplyText?: string
  inputBlocked?: boolean
  inputBlockReason?: string
  historySaved?: boolean
  text?: string
  content?: unknown
  images?: unknown[]
  media?: unknown
}

interface ChatResponse extends UnknownRecord {
  sessionId?: string
  session?: ChatSession
  result?: ChatResult
  historyUnavailable?: boolean
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
    name: item.name,
    status: item.status,
    progress: item.progress,
  }
}

/** 增量使用脱敏后文本的偏移，可修正跨分片凭证被脱敏时变化的前缀。 */
export function mergeChatProgress(previous: UnknownRecord, update: UnknownRecord): UnknownRecord {
  const merged = { ...previous, ...update }
  for (const field of ["text", "reasoning"]) {
    const offset = update[`${field}Offset`]
    if (typeof offset === "number") merged[field] = String(previous[field] || "").slice(0, offset) + String(update[field] || "")
    delete merged[`${field}Offset`]
  }
  return merged
}

/** 保留接口中的真实工具结果，在展示层按轮次归入同一个过程入口。 */
export function chatMessagesFromStored(items: StoredMessage[]): ChatMessage[] {
  const output: ChatMessage[] = []
  let process: ChatMessage | undefined
  let matched = new Set<string>()
  for (const [index, item] of items.entries()) {
    if (item.role === "user") { process = undefined; matched = new Set() }
    if (item.role === "process") {
      process = { ...messageFromStored(item, index), progress: (item.progress || []).map(entry => ({ ...entry })) }
      output.push(process)
    } else if (item.role === "tool") {
      if (!process) {
        process = { id: `process-${index}`, role: "process", text: "本轮执行过程", at: String(item.at || ""), progress: [] }
        output.push(process)
      }
      const entries = process.progress ||= []
      const existing = entries.find(entry => entry.kind === "tool" && entry.name === item.name && !matched.has(String(entry.id)))
      if (existing) {
        matched.add(String(existing.id))
        existing.result = item.content ?? item.text
        existing.status = item.status || existing.status
      } else {
        const id = `stored-tool-${index}`
        entries.push({ id, kind: "tool", name: item.name, status: item.status || "ok", result: item.content ?? item.text })
        matched.add(id)
      }
    } else output.push(messageFromStored(item, index))
  }
  return output
}

export const ChatTab = {
  name: "ChatTab",
  components: { ChatProcessPanel },
  setup() {
    const liveProgress = ref<UnknownRecord[]>([])
    const liveText = ref("")
    const liveDelivery = ref<unknown[]>([])
    const mediaUrls = ref<Record<string, string>>({})
    let activeController: AbortController | undefined
    const sessionId = ref("")
    const sessionKey = ref("")
    const messages = ref<ChatMessage[]>([])
    const sessions = ref<ChatSession[]>([])
    const loadingSessions = ref(false)
    const prompt = ref("")
    const channelId = ref("")
    const sending = ref(false)
    const enableTools = ref(true)
    const fileInputEl = ref<HTMLInputElement | null>(null)
    const uploading = ref(false)
    const attachments = ref<Array<{ id: string; name: string; url: string }>>([])
    const optionsMenuEl = ref<HTMLDetailsElement | null>(null)
    const conversationEl = ref<HTMLElement | null>(null)
    const elapsedMs = ref(0)
    let elapsedTimer: ReturnType<typeof setInterval> | undefined
    const turnStatus = computed(() => liveProgress.value.some(entry => entry.kind === "tool" && entry.status === "running") ? "工具执行中" : liveText.value ? "正在回复" : "思考中")
    const elapsedText = computed(() => elapsedMs.value >= 60000 ? `${Math.floor(elapsedMs.value / 60000)}分${Math.floor(elapsedMs.value / 1000) % 60}秒` : `${Math.floor(elapsedMs.value / 1000)}秒`)
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let pollCount = 0

    function pollPendingTools() {
      clearTimeout(pollTimer)
      const pending = messages.value.some(item => item.progress?.some(entry => entry.kind === "tool" && ["accepted", "queued", "running"].includes(String(entry.status))))
      if (disposed || sending.value || pollCount >= 60 || !pending) return
      pollTimer = setTimeout(async () => {
        pollCount += 1
        try { await loadSession(sessionKey.value) } finally { pollPendingTools() }
      }, 2000)
    }
    const suggestions = [
      "你好，请用两句话介绍你自己，并告诉我当前能做什么。",
      "请用自然、简洁的语气解释一下你的回复风格。",
      "如果我想查询机器人指令，你会怎么帮助我？",
      "请给我一个适合群聊的简短欢迎语。",
    ]

    const providers = computed(() => asRecord<ProviderData>(store.providers))
    const config = computed(() => asRecord<AppConfig>(store.config))
    const channels = computed(() => (providers.value.channels || []).filter(item => item.enabled !== false && item.purpose !== "decision"))
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
      const current = conversationEl.value
      const following = !current || current.scrollHeight - current.scrollTop - current.clientHeight < 120
      await nextTick()
      const el = conversationEl.value
      if (el && following) el.scrollTop = el.scrollHeight
    }

    function applySession(session: ChatSession | null | undefined, { updateSelection = true }: { updateSelection?: boolean } = {}) {
      if (!session) {
        messages.value = []
        return
      }
      messages.value = chatMessagesFromStored(session.messages || [])
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
      const requestedSessionId = sessionId.value
      try {
        const response = asRecord<{ sessions?: ChatSession[] }>(await request("/api/chat/test/sessions?limit=50"))
        sessions.value = Array.isArray(response.sessions) ? response.sessions : []
        if (disposed || sending.value || requestedSessionId !== sessionId.value) return
        const selected = sessions.value.find(item => item.sessionId === sessionId.value)
        if (selected) await loadSession(selected.key)
        // 当前会话不在列表时保留已展示的内容，避免刷新期间清空用户输入。
        else if (sessions.value[0] && !sessionId.value && !messages.value.length) await selectSession(sessions.value[0])
      } catch (err) {
        toast(errorMessage(err, "读取测试历史失败"))
      } finally {
        loadingSessions.value = false
        pollPendingTools()
      }
    }

    async function loadSession(key: string) {
      if (!key) return
      try {
        const response = asRecord<{ session?: ChatSession }>(await request(`/api/chat/test/sessions/${encodeURIComponent(key)}`))
        if (!disposed && !sending.value && sessionKey.value === key) applySession(response.session, { updateSelection: false })
      } catch (err) { toast(errorMessage(err, "读取测试对话失败")) }
    }

    const renderContent = (value: unknown) => renderRichContent(value, { cacheRemoteMedia: true, mediaUrls: mediaUrls.value })
    async function loadMediaPreview(event: MouseEvent) {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-chat-media-url]")
      const url = button?.dataset.chatMediaUrl
      if (!button || !url || button.disabled) return
      button.disabled = true
      try {
        const response = await request("/api/chat/media/preview", { method: "POST", body: JSON.stringify({ url }) })
        mediaUrls.value[url] = String(response.url || "")
      } catch (err) { toast(errorMessage(err, "资源预览加载失败")) }
      finally { button.disabled = false }
    }

    function addPendingMessage(message: Pick<ChatMessage, "role" | "text" | "content" | "raw">) {
      messages.value.push({ id: createSessionId(), at: new Date().toISOString(), ...message })
      scrollToBottom()
    }

    function replaceCurrentSession(session: ChatSession | null | undefined) {
      if (!session) return
      const index = sessions.value.findIndex(item => item.key === session.key)
      if (index >= 0) sessions.value.splice(index, 1)
      const { messages: _messages, ...summary } = session
      sessions.value.unshift(summary)
      applySession(session)
    }

    async function uploadFiles(event: Event) {
      const input = event.target as HTMLInputElement
      const files = Array.from(input.files || [])
      input.value = ""
      if (sending.value || uploading.value) return
      uploading.value = true
      try {
        for (const file of files) {
          const mime = file.type || ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as Record<string, string>)[file.name.split(".").pop()?.toLowerCase() || ""] || ""
          if (/^image\/(?:png|jpeg|gif|webp)$/.test(mime)) {
            if (attachments.value.length >= 3) throw new Error("每条消息最多上传 3 张图片")
            if (file.size > 20 * 1024 * 1024) throw new Error("图片不能超过 20 MiB，实际还受当前识图限制约束")
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;/, `data:${mime};`))
              reader.onerror = () => reject(new Error("文件读取失败"))
              reader.readAsDataURL(file)
            })
            const result = await request("/api/chat/attachments", { method: "POST", body: JSON.stringify({ name: file.name, dataUrl }) })
            attachments.value.push({ id: String(result.id), name: String(result.name), url: String(result.url) })
          } else if (/\.(?:txt|md|json|csv|log|ya?ml|xml|html|css|js|ts|py)$/i.test(file.name) || /^text\//.test(mime)) {
            if (file.size > 256 * 1024) throw new Error("文本文件过大，请选择需要讨论的片段")
            const fileText = await file.text()
            const content = `${prompt.value ? prompt.value + "\n\n" : ""}[文件：${file.name}]\n${fileText}`
            if (content.length > 4000) throw new Error("文件内容与输入合计超过 4000 字，请选择需要讨论的片段")
            prompt.value = content
          } else throw new Error("当前支持 PNG、JPEG、WebP、GIF 图片和文本文件")
        }
      } catch (err) { toast(errorMessage(err, "上传失败")) }
      finally { uploading.value = false }
    }

    async function send() {
      const text = String(prompt.value || "").trim() || (attachments.value.length ? "请查看图片附件。" : "")
      if (!text || sending.value || uploading.value) return
      if (text.length > 4000) {
        toast("单条测试消息不能超过 4000 个字符")
        return
      }
      prompt.value = ""
      if (optionsMenuEl.value) optionsMenuEl.value.open = false
      pollCount = 0
      const attached = [...attachments.value]
      attachments.value = []
      addPendingMessage({ role: "user", text, ...(attached.length ? { content: [{ type: "text", text }, ...attached.map(item => ({ type: "image", source: { kind: "url", value: item.url } }))] } : {}) })
      sending.value = true
      elapsedMs.value = 0
      const startedAt = Date.now()
      elapsedTimer = setInterval(() => { elapsedMs.value = Date.now() - startedAt }, 500)
      clearTimeout(pollTimer)
      liveProgress.value = []; liveText.value = ""; liveDelivery.value = []
      const controller = new AbortController()
      activeController = controller
      sessionId.value ||= createSessionId()
      try {
        const response = asRecord<ChatResponse>(await requestStream("/api/chat/test", {
          method: "POST",
          body: JSON.stringify({ prompt: text, sessionId: sessionId.value, channelId: channelId.value, enableTools: enableTools.value, attachments: attached.map(item => item.id), stream: true }),
          signal: controller.signal,
        }, (type, data) => {
          if (type === "progress") {
            const index = liveProgress.value.findIndex(item => item.id === data.id)
            const entry = mergeChatProgress(index >= 0 ? liveProgress.value[index] : {}, data)
            if (index >= 0) liveProgress.value.splice(index, 1, entry)
            else liveProgress.value.push(entry)
            if (entry.kind === "model" && !entry.parentToolId && entry.source !== "subagent" && entry.purpose !== "search-aggregate") {
              const candidate = String(entry.text || "")
              liveText.value = "<EMPTY>".startsWith(candidate.trim()) ? "" : candidate
            }
          } else if (type === "delivery") liveDelivery.value = Array.isArray(data.content) ? data.content : []
          scrollToBottom()
        }))
        sessionId.value = response.sessionId || sessionId.value
        if (response.session) {
          replaceCurrentSession(response.session)
        } else if (response.result?.inputBlocked) {
          addPendingMessage({ role: "system", text: response.result.inputBlockReason || "消息已被输入过滤器拦截。" })
        } else if (response.result) {
          // 服务端未返回会话时仍展示已取得的回复，避免重复发送。
          const recovered: StoredMessage[] = []
          if (response.result.progress?.length) recovered.push({ role: "process", progress: response.result.progress })
          for (const trace of response.result.toolChain || []) {
            const metadata = asRecord(trace.metadata)
            let content: unknown = trace.result ?? trace.resultPreview
            if (typeof content === "string") {
              try { content = JSON.parse(content) as unknown } catch { /* 普通 Markdown 结果保持文本。 */ }
            }
            recovered.push({ role: "tool", name: String(trace.name || ""), status: String(metadata.backgroundStatus || trace.status || ""), at: new Date().toISOString(), content })
          }
          messages.value.push(...chatMessagesFromStored(recovered).map(item => ({ ...item, id: createSessionId() })))
          if (response.result.displayContent?.length) addPendingMessage({ role: "assistant", text: plainTextContent(response.result.displayContent), content: response.result.displayContent, raw: response.result })
          const content = response.result.content ?? response.result.text ?? response.result.images ?? response.result.media
          if (response.result.text || response.result.content || response.result.images?.length) addPendingMessage({ role: "assistant", text: plainTextContent(content), content, raw: response.result })
        }
        liveProgress.value = []; liveText.value = ""; liveDelivery.value = []
        if (response.result?.historySaved === false) toast("回复已生成，但会话历史未能保存。")
        else if (response.historyUnavailable) toast("回复已生成，但暂时无法读取会话历史。")
        await refreshSlices(["setupGuide", "conversations"])
      } catch (err) {
        attachments.value = attached
        for (const item of liveProgress.value) if (item.status === "running") item.status = controller.signal.aborted ? "canceled" : "failed"
        if (liveProgress.value.length) messages.value.push({ id: createSessionId(), role: "process", text: "本轮执行过程", progress: [...liveProgress.value], at: new Date().toISOString() })
        if (liveDelivery.value.length) addPendingMessage({ role: "assistant", text: plainTextContent(liveDelivery.value), content: liveDelivery.value })
        liveProgress.value = []; liveText.value = ""; liveDelivery.value = []
        addPendingMessage({ role: controller.signal.aborted ? "system" : "error", text: controller.signal.aborted ? "已停止生成。已经执行或受理的工具操作不会撤销，可重新选择当前会话查看结果。" : errorMessage(err, "对话测试失败。") })
      } finally {
        clearInterval(elapsedTimer)
        activeController = undefined
        sending.value = false
        pollPendingTools()
        scrollToBottom()
      }
    }

    function onComposerKeydown(event: KeyboardEvent) {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
      event.preventDefault()
      send()
    }

    function useSuggestion(text: string) { prompt.value = text }

    function stop() { activeController?.abort() }

    function newConversation() {
      if (sending.value || uploading.value) return
      clearTimeout(pollTimer)
      sessionId.value = ""
      sessionKey.value = ""
      messages.value = []
      prompt.value = ""
      attachments.value = []
      toast("已开始新的测试对话")
    }

    async function selectSession(session: ChatSession) {
      if (sending.value || uploading.value) return
      attachments.value = []
      clearTimeout(pollTimer)
      sessionKey.value = session.key
      sessionId.value = session.sessionId
      channelId.value = session.channelId || ""
      messages.value = []
      pollCount = 0
      await loadSession(session.key)
      pollPendingTools()
    }

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
          if (next) await selectSession(next)
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
    onUnmounted(() => { disposed = true; activeController?.abort(); clearTimeout(pollTimer); clearInterval(elapsedTimer) })

    return {
      attachments, uploading, uploadFiles, fileInputEl,
      liveProgress, liveText, liveDelivery, stop, elapsedText, turnStatus, optionsMenuEl,
      store, messages, sessions, loadingSessions, prompt, channelId, sending, enableTools, conversationEl, suggestions,
      activeSession, channelOptions, usingMockOnly, send, onComposerKeydown, useSuggestion,
      newConversation, selectSession, deleteSession, copyMessage, timeText, renderRichContent: renderContent, mediaUrls, loadMediaPreview,
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

          <div ref="conversationEl" class="chat-conversation" aria-live="polite" @click="loadMediaPreview">
            <div v-if="!messages.length" class="chat-empty"><span class="chat-empty-icon"><Icon name="message" :size="24" /></span><h3>发送第一条测试消息</h3><p>建议先验证基础回复，再测试人设和指令推荐。</p><div class="chat-suggestions"><button v-for="item in suggestions" :key="item" type="button" @click="useSuggestion(item)">{{ item }}</button></div></div>
            <template v-for="message in messages" :key="message.id"><ChatProcessPanel v-if="message.role === 'process'" :entries="message.progress || []" :media-urls="mediaUrls" /><article v-else class="chat-message" :class="message.role">
              <div class="chat-message-avatar"><Icon :name="message.role === 'user' ? 'message' : (message.role === 'error' ? 'alert' : (message.role === 'system' ? 'info' : 'sparkles'))" :size="15" /></div>
              <div class="chat-bubble"><div class="chat-bubble-head"><b>{{ message.role === 'user' ? '你' : (message.role === 'error' ? '发送失败' : (message.role === 'system' ? '系统提示' : 'AI 助手')) }}</b><span>{{ timeText(message.at) }}</span></div><div class="chat-rich-content" v-html="renderRichContent(message.content ?? message.text)"></div><details v-if="store.developerMode && message.raw" class="chat-raw-content"><summary>原始内容</summary><pre>{{ pretty(message.raw) }}</pre></details><div v-if="message.role === 'assistant'" class="chat-message-meta"><button class="btn ghost sm" type="button" @click="copyMessage(message.text)"><Icon name="copy" :size="13" />复制</button></div></div>
            </article></template>
            <ChatProcessPanel v-if="liveProgress.length" :entries="liveProgress" :active="sending" :media-urls="mediaUrls" />
            <article v-if="liveText" class="chat-message assistant"><div class="chat-bubble"><div class="chat-bubble-head"><b>AI 助手</b><span>实时预览</span></div><div class="chat-rich-content" v-html="renderRichContent(liveText)"></div></div></article>
            <article v-if="liveDelivery.length" class="chat-message assistant"><div class="chat-bubble"><div class="chat-rich-content" v-html="renderRichContent(liveDelivery)"></div></div></article>

          </div>

          <footer class="chat-composer">
            <textarea v-model="prompt" rows="3" maxlength="4000" :disabled="sending" placeholder="输入消息。Enter 发送，Shift + Enter 换行" @keydown="onComposerKeydown"></textarea>
            <input ref="fileInputEl" type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,text/*,.md,.json,.csv,.log,.yaml,.yml,.xml,.html,.css,.js,.ts,.py" :disabled="sending || uploading" @change="uploadFiles">
            <div v-if="attachments.length" class="chat-attachments"><span v-for="(attachment, index) in attachments" :key="attachment.id" class="chat-attachment"><img :src="attachment.url" alt="图片附件"><span>{{ attachment.name }}</span><button class="icon-btn sm" type="button" :disabled="sending || uploading" :aria-label="'移除 ' + attachment.name" @click="attachments.splice(index, 1)"><Icon name="x" :size="13" /></button></span></div>
            <div class="chat-composer-foot">
              <div class="chat-turn-actions">
                <details ref="optionsMenuEl" class="chat-turn-menu">
                  <summary class="chat-turn-option" aria-label="对话选项"><Icon name="gear" :size="14" /><span>{{ enableTools ? '工具已开启' : '对话选项' }}</span><Icon name="chevron-down" :size="12" /></summary>
                  <div class="chat-turn-options"><label class="chat-tools-option"><span><b>启用工具</b><small>按现有权限使用工具，可能产生实际操作；结果显示在当前网页。</small></span><input v-model="enableTools" type="checkbox" role="switch" :disabled="sending"></label></div>
                </details>
                <span v-if="sending" class="chat-turn-status" role="status"><span class="chat-status-dot"></span>{{ turnStatus }} · {{ elapsedText }}</span>
                <button class="chat-turn-option" type="button" :disabled="sending || uploading" aria-label="上传图片或文本文件" @click="fileInputEl?.click()"><Icon name="upload" :size="14" />{{ uploading ? '上传中…' : '上传' }}</button>
              </div>
              <div class="chat-composer-submit"><span>{{ prompt.length }} / 4000</span><button v-if="sending" class="chat-stop" type="button" aria-label="停止生成" @click="stop"><span class="chat-stop-square" aria-hidden="true"></span>停止</button><button v-else class="btn primary chat-send" type="button" :disabled="uploading || (!prompt.trim() && !attachments.length)" @click="send"><Icon name="play" :size="15" />发送</button></div>
            </div>
          </footer>
        </section>
      </div>
    </div>
  `,
}
