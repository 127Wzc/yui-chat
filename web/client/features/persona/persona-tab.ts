import { reactive, computed, ref, watch } from "vue"
import { confirmAction, store, request, toast, saveConfigPatch, setDirtyScope } from "../../app/store/store.js"
import { splitNames, parseJsonText, toJson, shortTime } from "../../shared/format.js"
import { asRecord, errorMessage, type UnknownRecord } from "../../shared/data.js"

interface ConfigNode extends UnknownRecord {
  enabled?: boolean
  groups?: string[]
  prompt?: string
  fallbackMessages?: unknown[]
  probabilityPercent?: number
  cooldownMs?: number
  groupCooldownMs?: number
  model?: string
  voice?: string
  format?: string
  alsoSendText?: boolean
  defaultMode?: string
  autoUsePicture?: boolean
  autoUsePictureThreshold?: number
  characterPrompt?: string
  runtimePrompt?: string
  aliases?: string[]
  assistantLabel?: string
  firstPerson?: string
  respondToFirstPersonCall?: boolean
  respondToAt?: boolean
  scheduledEnabled?: boolean
  intervalHours?: number
  maxChars?: number
  minMessageChars?: number
  groupOnly?: boolean
  enhanceKeywords?: string[]
  enhancePrompt?: string
  enhanceRecallMs?: number
  disabledGroupIds?: string[]
  responseMode?: string
  trigger?: ConfigNode
  ambient?: ConfigNode
  poke?: ConfigNode
  initiativeGreeting?: ConfigNode
  output?: ConfigNode
  segmentation?: ConfigNode
  tts?: ConfigNode
  render?: ConfigNode
  access?: ConfigNode
  remoteFetch?: ConfigNode
  mediaThumbnail?: ConfigNode
  privateChatEnabled?: boolean
  masterBypass?: boolean
  whitelist?: string[] | string
  blacklist?: string[] | string
  recentMessageCount?: number
  mediaThumbnails?: boolean
  mediaThumbnailMaxCount?: number
  chatCardAsImage?: boolean
  intervalMethod?: string
  intervalMinSeconds?: number
  intervalMaxSeconds?: number
  thresholdChars?: number
  mode?: string
  regex?: string
  contentFilterRegex?: string
  lastPreview?: InitiativePreview[]
  [key: string]: unknown
}

interface PersonaConfig extends UnknownRecord {
  persona?: ConfigNode
  response?: ConfigNode
  chat?: ConfigNode
  context?: ConfigNode
  mediaRecognition?: ConfigNode
  knowledge?: ConfigNode
}

interface InitiativePreview extends UnknownRecord {
  groupId?: string
  target?: string
  text?: string
  time?: string
}

interface InitiativeGreeting extends UnknownRecord {
  scheduler?: ConfigNode
}

interface OutputSlice extends UnknownRecord {
  initiativeGreeting?: InitiativeGreeting
  persona?: { prompt?: { runtimePrompt?: string; defaultRuntimePrompt?: string; currentTime?: string } }
}

interface PreviewResult extends UnknownRecord {
  status?: unknown
  result?: {
    preview?: InitiativePreview[]
    text?: string
    groupId?: string
    planned?: number
  }
}

const POKE_RESPONSE_MODE_OPTIONS = [
  { value: "ai-with-fallback", label: "AI 优先，失败回退" },
  { value: "ai", label: "仅 AI 回复" },
  { value: "fallback", label: "仅固定短句" },
]
const RESPONSE_MODE_OPTIONS = [
  { value: "text", label: "文本回复", icon: "message" },
  { value: "voice", label: "语音回复", icon: "activity" },
  { value: "picture", label: "图片回复", icon: "eye" },
]
const SEGMENTATION_INTERVAL_OPTIONS = [
  { value: "random", label: "随机" },
  { value: "log", label: "对数" },
]
const SEGMENTATION_MODE_OPTIONS = [
  { value: "regex", label: "正则表达式" },
  { value: "natural", label: "自然标点" },
]

function initDraft(cfg: PersonaConfig = {}) {
  const persona = cfg.persona || {}
  const trigger = persona.trigger || {}
  const segmentation = cfg.response?.segmentation || {}
  const tts = cfg.response?.tts || {}
  const intervalMin = Number(segmentation.intervalMinSeconds ?? 1.5)
  const intervalMax = Number(segmentation.intervalMaxSeconds ?? 3.5)
  return {
    personaEnabled: Boolean(persona.enabled),
    personaFirstPerson: persona.firstPerson || "",
    personaAliases: (persona.aliases || []).join(", "),
    personaLabel: persona.assistantLabel || "",
    firstPersonEnabled: Boolean(persona.respondToFirstPersonCall),
    respondToAt: persona.respondToAt !== false,
    personaAmbientEnabled: trigger.ambient?.enabled === true,
    personaAmbientGroupOnly: trigger.ambient?.groupOnly !== false,
    personaAmbientMinChars: trigger.ambient?.minMessageChars ?? 2,
    personaAmbientProbability: trigger.ambient?.probabilityPercent ?? 10,
    personaPokeEnabled: trigger.poke?.enabled === true,
    personaPokeBotOnly: trigger.poke?.respondToBotPoke !== false,
    personaPokeResponseMode: trigger.poke?.responseMode || "ai-with-fallback",
    personaPokeProbability: trigger.poke?.probabilityPercent ?? 100,
    personaPokeCooldown: trigger.poke?.cooldownMs ?? 30000,
    personaPokeGroupCooldown: trigger.poke?.groupCooldownMs ?? 30000,
    personaPokePrompt: trigger.poke?.prompt || "",
    personaPokeFallbackMessages: toJson(trigger.poke?.fallbackMessages || []),
    initiativeGreetingEnabled: persona.initiativeGreeting?.enabled !== false,
    initiativeGreetingScheduled: persona.initiativeGreeting?.scheduledEnabled === true,
    initiativeGreetingGroups: (persona.initiativeGreeting?.groups || []).join(", "),
    initiativeGreetingInterval: persona.initiativeGreeting?.intervalHours ?? 3,
    initiativeGreetingProbability: persona.initiativeGreeting?.probabilityPercent ?? 50,
    initiativeGreetingMaxChars: persona.initiativeGreeting?.maxChars ?? 60,
    initiativeGreetingPrompt: persona.initiativeGreeting?.prompt || "",
    initiativeGreetingFallbackMessages: toJson(persona.initiativeGreeting?.fallbackMessages || []),
    personaTriggerProbability: trigger.probabilityPercent ?? 100,
    personaTriggerCooldown: trigger.cooldownMs || 0,
    personaGroupCooldown: trigger.groupCooldownMs || 0,
    personaDisabledGroups: (trigger.disabledGroupIds || []).join(", "),
    personaEnhanceKeywords: (trigger.enhanceKeywords || []).join(", "),
    personaEnhancePrompt: trigger.enhancePrompt || "",
    personaEnhanceRecallMs: trigger.enhanceRecallMs || 0,
    personaOmitChannelPrefix: persona.output?.omitChannelPrefixInFirstPerson !== false,
    segmentationEnabled: segmentation.enabled === true,
    segmentationIntervalMethod: segmentation.intervalMethod || "random",
    segmentationIntervalRange: `${intervalMin},${intervalMax}`,
    segmentationThresholdChars: segmentation.thresholdChars ?? 150,
    segmentationMode: segmentation.mode || "regex",
    segmentationRegex: segmentation.regex || ".*?[。？！!?；;~…]+|.+$",
    segmentationContentFilterRegex: segmentation.contentFilterRegex || "",
    responseMode: cfg.response?.defaultMode || "text",
    pictureAutoEnabled: cfg.response?.autoUsePicture !== false,
    pictureThreshold: cfg.response?.autoUsePictureThreshold ?? 1200,
    chatCardAsImage: cfg.response?.render?.chatCardAsImage !== false,
    ttsEnabled: tts.enabled === true,
    ttsAlsoSendText: tts.alsoSendText !== false,
    ttsModel: tts.model || "tts-1",
    ttsVoice: tts.voice || "alloy",
    ttsFormat: tts.format || "mp3",
    ttsMaxChars: tts.maxChars ?? 300,
    privateChatEnabled: cfg.chat?.access?.privateChatEnabled !== false,
    accessMasterBypass: cfg.chat?.access?.masterBypass !== false,
    accessWhitelist: Array.isArray(cfg.chat?.access?.whitelist) ? cfg.chat.access.whitelist.join(", ") : (cfg.chat?.access?.whitelist || ""),
    accessBlacklist: Array.isArray(cfg.chat?.access?.blacklist) ? cfg.chat.access.blacklist.join(", ") : (cfg.chat?.access?.blacklist || ""),
    contextRecentMessageCount: cfg.context?.recentMessageCount ?? 20,
    mediaEnabled: cfg.mediaRecognition?.enabled !== false,
    mediaRemoteFetch: cfg.mediaRecognition?.remoteFetch?.enabled !== false,
    mediaMaxBytes: cfg.mediaRecognition?.remoteFetch?.maxBytes || 4194304,
    renderMediaThumbnails: cfg.response?.render?.mediaThumbnails !== false,
    renderMediaThumbnailEnabled: cfg.response?.render?.mediaThumbnail?.enabled !== false,
    renderMediaThumbnailCount: cfg.response?.render?.mediaThumbnailMaxCount ?? 3,
    commandPrefixes: Array.isArray(cfg.knowledge?.commandPrefixes) ? cfg.knowledge.commandPrefixes.join(" ") : (cfg.knowledge?.commandPrefixes || "# / *"),
    chatTriggerPrefix: cfg.chat?.triggerPrefix || "#yuichat",
    chatHelpPrefix: cfg.chat?.helpPrefix || "#yuihelp",
    personaCharacterPrompt: persona.characterPrompt || "",
    personaRuntimePrompt: persona.runtimePrompt || "",
  }
}

function configDraftState(value: UnknownRecord = {}) {
  return value
}

function parseIntervalRange(value: unknown = "") {
  const numbers = String(value || "")
    .split(/[，,\s]+/)
    .map(item => Number(item))
    .filter(item => Number.isFinite(item) && item >= 0)
  const min = numbers[0] ?? 1.5
  const max = Math.max(min, numbers[1] ?? min)
  return { min, max }
}

export const PersonaTab = {
  name: "PersonaTab",
  setup() {
    const draft = reactive(initDraft(asRecord<PersonaConfig>(store.config)))
    const savedSnapshot = ref(JSON.stringify(configDraftState(draft)))
    const activeSection = ref("basic")
    const interactionMenu = ref("trigger")
    const triggerMenu = ref("active")
    const replyMenu = ref("overview")
    const greeting = computed<InitiativeGreeting>(() => asRecord<OutputSlice>(store.output).initiativeGreeting
      ? asRecord<InitiativeGreeting>(asRecord<OutputSlice>(store.output).initiativeGreeting)
      : {})
    const isDirty = computed(() => JSON.stringify(configDraftState(draft)) !== savedSnapshot.value)
    const sectionItems = computed(() => [
      {
        value: "basic",
        label: "基础人格",
        icon: "bot",
        description: `${draft.personaFirstPerson || draft.personaLabel || "未设置称呼"} · ${draft.personaAliases ? "含别名" : "无别名"}`,
        badge: draft.personaEnabled ? "开启" : "关闭",
        tone: draft.personaEnabled ? "on" : "",
      },
      {
        value: "advanced",
        label: "互动与输出",
        icon: "sliders",
        description: `伪人 ${draft.personaAmbientEnabled ? `${draft.personaAmbientProbability}%` : "关闭"} · ${RESPONSE_MODE_OPTIONS.find(item => item.value === draft.responseMode)?.label || "文本回复"}`,
      },
      {
        value: "poke",
        label: "戳一戳",
        icon: "zap",
        description: `${draft.personaPokeResponseMode === "fallback" ? "固定短句" : draft.personaPokeResponseMode === "ai" ? "AI 回复" : "AI 优先"} · ${draft.personaPokeProbability}%`,
        badge: draft.personaPokeEnabled ? "开启" : "关闭",
        tone: draft.personaPokeEnabled ? "on" : "",
      },
    ])
    const triggerItems = [
      { value: "active", label: "主动", icon: "activity", description: "伪人参与与主动问候" },
      { value: "passive", label: "被动", icon: "bot", description: "称呼、别名和冷却策略" },
      { value: "at", label: "艾特", icon: "message", description: "回应 @ 机器人" },
      { value: "command", label: "指令", icon: "book", description: "命令前缀与处理优先级" },
    ]
    const replyItems = [
      { value: "overview", label: "默认方式", icon: "sliders", description: "选择常用交付形式" },
      { value: "text", label: "文本", icon: "message", description: "正文与分段策略" },
      { value: "picture", label: "图片", icon: "eye", description: "长文本转图和卡片" },
      { value: "voice", label: "语音", icon: "activity", description: "语音合成参数" },
      { value: "context", label: "上下文", icon: "database", description: "最近消息与媒体" },
    ]

    watch(isDirty, dirty => setDirtyScope("tab:persona", dirty), { immediate: true })
    const greetingPreviewResult = computed<InitiativePreview | null>(() => {
      const previews = greeting.value.scheduler?.lastPreview
      return Array.isArray(previews) ? asRecord<InitiativePreview>(previews[0]) : null
    })
    const responseModeLabel = computed(() => RESPONSE_MODE_OPTIONS.find(item => item.value === draft.responseMode)?.label || "文本回复")
    const personaPromptDigest = computed(() => asRecord(asRecord<OutputSlice>(store.output).persona?.prompt))
    const defaultPersonaRuntimePrompt = computed(() => String(personaPromptDigest.value.defaultRuntimePrompt || ""))
    const personaPromptPreview = computed(() => {
      const firstPerson = String(draft.personaFirstPerson || draft.personaLabel || "助手")
      const character = String(draft.personaCharacterPrompt || "").replaceAll("[first_person]", firstPerson).trim()
      const runtime = String(draft.personaRuntimePrompt || "").replaceAll("[first_person]", firstPerson).trim()
      const currentTime = String(personaPromptDigest.value.currentTime || "").trim()
      return [
        character ? `【角色设定】\n${character}` : "",
        runtime ? `【系统运行规则】\n${runtime}` : "",
        currentTime ? `【当前时间】\n${currentTime}` : "",
      ].filter(Boolean).join("\n\n")
    })

    function resetRuntimePrompt() {
      if (!defaultPersonaRuntimePrompt.value) {
        toast("默认系统运行规则尚未载入，请稍后重试")
        return
      }
      draft.personaRuntimePrompt = defaultPersonaRuntimePrompt.value
      toast("已恢复默认系统运行规则，保存后生效")
    }

    function selectInteractionMenu(menu: string, item = "") {
      interactionMenu.value = menu
      if (!item) return
      if (menu === "trigger") triggerMenu.value = item
      if (menu === "reply") replyMenu.value = item
    }

    async function save() {
      try {
        const interval = parseIntervalRange(draft.segmentationIntervalRange)
        await saveConfigPatch({
          "persona.enabled": draft.personaEnabled,
          "persona.firstPerson": draft.personaFirstPerson,
          "persona.aliases": splitNames(draft.personaAliases),
          "persona.assistantLabel": draft.personaLabel,
          "persona.respondToFirstPersonCall": draft.firstPersonEnabled,
          "persona.respondToAt": draft.respondToAt,
          "persona.trigger.ambient.enabled": draft.personaAmbientEnabled,
          "persona.trigger.ambient.groupOnly": draft.personaAmbientGroupOnly,
          "persona.trigger.ambient.minMessageChars": Number(draft.personaAmbientMinChars ?? 2),
          "persona.trigger.ambient.probabilityPercent": Number(draft.personaAmbientProbability ?? 10),
          "persona.trigger.poke.enabled": draft.personaPokeEnabled,
          "persona.trigger.poke.respondToBotPoke": draft.personaPokeBotOnly,
          "persona.trigger.poke.responseMode": draft.personaPokeResponseMode,
          "persona.trigger.poke.probabilityPercent": Number(draft.personaPokeProbability ?? 100),
          "persona.trigger.poke.cooldownMs": Number(draft.personaPokeCooldown || 0),
          "persona.trigger.poke.groupCooldownMs": Number(draft.personaPokeGroupCooldown || 0),
          "persona.trigger.poke.prompt": draft.personaPokePrompt,
          "persona.trigger.poke.fallbackMessages": parseJsonText(draft.personaPokeFallbackMessages, "戳一戳 fallback", []),
          "persona.initiativeGreeting.enabled": draft.initiativeGreetingEnabled,
          "persona.initiativeGreeting.scheduledEnabled": draft.initiativeGreetingScheduled,
          "persona.initiativeGreeting.groups": splitNames(draft.initiativeGreetingGroups),
          "persona.initiativeGreeting.intervalHours": Number(draft.initiativeGreetingInterval || 3),
          "persona.initiativeGreeting.probabilityPercent": Number(draft.initiativeGreetingProbability ?? 50),
          "persona.initiativeGreeting.maxChars": Number(draft.initiativeGreetingMaxChars || 60),
          "persona.initiativeGreeting.prompt": draft.initiativeGreetingPrompt,
          "persona.initiativeGreeting.fallbackMessages": parseJsonText(draft.initiativeGreetingFallbackMessages, "主动问候 fallback", []),
          "persona.trigger.probabilityPercent": Number(draft.personaTriggerProbability ?? 100),
          "persona.trigger.cooldownMs": Number(draft.personaTriggerCooldown || 0),
          "persona.trigger.groupCooldownMs": Number(draft.personaGroupCooldown || 0),
          "persona.trigger.disabledGroupIds": splitNames(draft.personaDisabledGroups),
          "persona.trigger.enhanceKeywords": splitNames(draft.personaEnhanceKeywords),
          "persona.trigger.enhancePrompt": draft.personaEnhancePrompt,
          "persona.trigger.enhanceRecallMs": Number(draft.personaEnhanceRecallMs || 0),
          "persona.output.omitChannelPrefixInFirstPerson": draft.personaOmitChannelPrefix,
          "response.segmentation.enabled": draft.segmentationEnabled === true,
          "response.segmentation.intervalMethod": draft.segmentationIntervalMethod,
          "response.segmentation.intervalMinSeconds": interval.min,
          "response.segmentation.intervalMaxSeconds": interval.max,
          "response.segmentation.thresholdChars": Number(draft.segmentationThresholdChars || 150),
          "response.segmentation.mode": draft.segmentationMode,
          "response.segmentation.regex": draft.segmentationRegex,
          "response.segmentation.contentFilterRegex": draft.segmentationContentFilterRegex,
          "persona.characterPrompt": draft.personaCharacterPrompt,
          "persona.runtimePrompt": draft.personaRuntimePrompt,
          "response.defaultMode": draft.responseMode,
          "response.autoUsePicture": draft.pictureAutoEnabled,
          "response.autoUsePictureThreshold": Number(draft.pictureThreshold || 1200),
          "response.render.chatCardAsImage": draft.chatCardAsImage,
          "response.tts.enabled": draft.ttsEnabled,
          "response.tts.alsoSendText": draft.ttsAlsoSendText,
          "response.tts.model": draft.ttsModel,
          "response.tts.voice": draft.ttsVoice,
          "response.tts.format": draft.ttsFormat,
          "response.tts.maxChars": Number(draft.ttsMaxChars || 300),
          "chat.access.privateChatEnabled": draft.privateChatEnabled,
          "chat.access.masterBypass": draft.accessMasterBypass,
          "chat.access.whitelist": splitNames(draft.accessWhitelist),
          "chat.access.blacklist": splitNames(draft.accessBlacklist),
          "context.recentMessageCount": Number(draft.contextRecentMessageCount ?? 20),
          "mediaRecognition.enabled": draft.mediaEnabled,
          "mediaRecognition.remoteFetch.enabled": draft.mediaRemoteFetch,
          "mediaRecognition.remoteFetch.maxBytes": Number(draft.mediaMaxBytes || 4194304),
          "response.render.mediaThumbnails": draft.renderMediaThumbnails,
          "response.render.mediaThumbnail.enabled": draft.renderMediaThumbnailEnabled,
          "response.render.mediaThumbnailMaxCount": Number(draft.renderMediaThumbnailCount || 3),
        })
        savedSnapshot.value = JSON.stringify(configDraftState(draft))
        setDirtyScope("tab:persona", false)
        return true
      } catch (err) {
        toast(errorMessage(err))
        return false
      }
    }
    async function resetDraft() {
      if (!isDirty.value) return
      const accepted = await confirmAction({
        title: "放弃尚未保存的人设修改？",
        message: "本页草稿会恢复为最近一次保存的配置，刚才填写的内容无法找回。",
        confirmText: "确认放弃修改",
        tone: "warn",
        icon: "restore",
      })
      if (!accepted) return
      Object.assign(draft, initDraft(asRecord<PersonaConfig>(store.config)))
      savedSnapshot.value = JSON.stringify(configDraftState(draft))
      setDirtyScope("tab:persona", false)
      toast("已放弃未保存修改")
    }

    async function previewGreeting(all: boolean) {
      try {
        const result = asRecord<PreviewResult>(await request("/api/persona/initiative-greeting/preview", {
          method: "POST",
          body: JSON.stringify({ all, groupId: splitNames(draft.initiativeGreetingGroups)[0] || "" }),
        }))
        const output = asRecord<OutputSlice>(store.output)
        const initiativeGreeting = asRecord<InitiativeGreeting>(output.initiativeGreeting)
        const scheduler = { ...asRecord<ConfigNode>(initiativeGreeting.scheduler), status: result.status }
        if (result.result?.preview) {
          scheduler.lastPreview = result.result.preview
        } else if (result.result?.text) {
          scheduler.lastPreview = [{
            groupId: result.result.groupId,
            target: `群 ${result.result.groupId}`,
            text: result.result.text,
            time: new Date().toISOString(),
          }]
        }
        store.output = { ...output, initiativeGreeting: { ...initiativeGreeting, scheduler } }
        toast(all ? `已预演 ${result.result?.planned || 0} 个目标群` : "主动问候预演已生成")
      } catch (err) {
        toast(errorMessage(err))
      }
    }

    return {
      draft, activeSection, interactionMenu, triggerMenu, replyMenu,
      sectionItems, triggerItems, replyItems,
      isDirty, greetingPreviewResult, responseModeLabel, defaultPersonaRuntimePrompt, personaPromptPreview,
      POKE_RESPONSE_MODE_OPTIONS, RESPONSE_MODE_OPTIONS,
      SEGMENTATION_INTERVAL_OPTIONS, SEGMENTATION_MODE_OPTIONS, shortTime,
      selectInteractionMenu, save, resetDraft, resetRuntimePrompt, previewGreeting,
    }
  },
  template: `
    <div class="persona-page">
      <div class="section-stage persona-page-stage">
        <div class="section-intro persona-page-intro">
          <div>
            <h2>助手人设</h2>
            <p>称呼、触发与回复策略。</p>
          </div>
          <button class="btn primary small" type="button" :disabled="!isDirty" @click="save"><Icon name="save" :size="14" />保存</button>
        </div>

        <SectionNav v-model="activeSection" :items="sectionItems" label="助手人设分区" variant="tabs" />

        <Panel flush>
          <div v-if="activeSection === 'basic'" class="persona-section-body">
            <div class="section-heading-row">
              <div><div class="section-title"><Icon name="bot" :size="13" />基础人格</div><p class="muted small">分别设置角色表达和模型运行规则；程序侧权限与安全策略不受提示词修改影响。</p></div>
              <div class="heading-switch"><span>{{ draft.personaEnabled ? '已开启' : '已关闭' }}</span><Switch :model-value="draft.personaEnabled" @update:model-value="draft.personaEnabled = $event" /></div>
            </div>
            <div class="form-grid">
              <Field label="助手自称" v-model="draft.personaFirstPerson" tip="如「玉玉」。" />
              <Field label="别名" hint="逗号分隔" v-model="draft.personaAliases" />
              <Field label="助手名称" v-model="draft.personaLabel" />
            </div>
            <Field label="角色设定" type="textarea" rows="8" v-model="draft.personaCharacterPrompt" tip="只描述角色是谁、如何说话以及与用户的关系；可以使用 [first_person] 代入助手自称。" />
            <div class="persona-prompt-layers">
              <Collapse title="系统运行规则" hint="可自定义 · 保存后生效">
                <Field label="规则内容" type="textarea" rows="14" v-model="draft.personaRuntimePrompt" tip="约束模型如何使用工具、处理媒体、群聊上下文和静默回复；可以使用 [first_person] 代入助手自称。程序侧权限与安全检查仍独立生效。" />
                <div class="action-bar">
                  <button class="btn outline" type="button" :disabled="!defaultPersonaRuntimePrompt" @click="resetRuntimePrompt"><Icon name="restore" :size="14" />重置为默认值</button>
                </div>
              </Collapse>
              <Collapse title="最终提示词预览" hint="运行规则 + 当前角色设定">
                <pre class="persona-prompt-readonly composed">{{ personaPromptPreview }}</pre>
              </Collapse>
            </div>
          </div>

          <div v-else-if="activeSection === 'advanced'" class="persona-section-body settings-stack persona-interaction-body">
            <div class="persona-interaction-workspace">
              <aside class="persona-interaction-rail" aria-label="互动与输出设置导航">
                <div class="persona-rail-kicker">互动与输出</div>
                <button class="persona-rail-group" :class="{ active: interactionMenu === 'trigger' }" type="button" :aria-current="interactionMenu === 'trigger' ? 'page' : undefined" @click="selectInteractionMenu('trigger')">
                  <span class="persona-rail-icon"><Icon name="zap" :size="16" /></span>
                  <span class="persona-rail-copy"><strong>触发设置</strong><small>决定什么时候进入回复流程</small></span>
                </button>
                <div class="persona-rail-subnav" aria-label="触发设置分区">
                  <button v-for="item in triggerItems" :key="item.value" class="persona-rail-subitem" :class="{ active: interactionMenu === 'trigger' && triggerMenu === item.value }" type="button" :aria-current="interactionMenu === 'trigger' && triggerMenu === item.value ? 'page' : undefined" @click="selectInteractionMenu('trigger', item.value)"><Icon :name="item.icon" :size="14" /><span>{{ item.label }}</span></button>
                </div>
                <button class="persona-rail-group" :class="{ active: interactionMenu === 'reply' }" type="button" :aria-current="interactionMenu === 'reply' ? 'page' : undefined" @click="selectInteractionMenu('reply')">
                  <span class="persona-rail-icon"><Icon name="message" :size="16" /></span>
                  <span class="persona-rail-copy"><strong>回复设置</strong><small>选择默认交付和内容形式</small></span>
                </button>
                <div class="persona-rail-subnav" aria-label="回复设置分区">
                  <button v-for="item in replyItems" :key="item.value" class="persona-rail-subitem" :class="{ active: interactionMenu === 'reply' && replyMenu === item.value }" type="button" :aria-current="interactionMenu === 'reply' && replyMenu === item.value ? 'page' : undefined" @click="selectInteractionMenu('reply', item.value)"><Icon :name="item.icon" :size="14" /><span>{{ item.label }}</span></button>
                </div>
              </aside>

              <div class="persona-interaction-content">
                <div v-if="interactionMenu === 'trigger'" class="persona-settings-pane">
                  <div class="persona-content-head">
                    <div><div class="section-title"><Icon name="zap" :size="14" />触发设置</div><p>决定助手在什么情况下进入回复流程。</p></div>
                    <span class="badge on">{{ triggerItems.find(item => item.value === triggerMenu)?.label || '主动' }}</span>
                  </div>
                  <div class="persona-content-stack">
                    <div v-if="triggerMenu === 'active'" class="persona-active-stack">
                      <section class="form-section persona-direct-section">
                        <div class="section-heading-row"><div><div class="section-title"><Icon name="activity" :size="13" />伪人参与</div><p class="muted small">未触发名称、@ 或指令时，按概率从普通群聊消息中主动接话。</p></div><span class="badge" :class="draft.personaAmbientEnabled ? 'on' : ''">{{ draft.personaAmbientEnabled ? draft.personaAmbientProbability + '%' : '已关闭' }}</span></div>
                        <div class="settings-toggle-grid">
                          <div class="settings-toggle-item"><div><strong>启用伪人</strong><small>默认关闭，避免机器人未经允许频繁插话。</small></div><Switch :model-value="draft.personaAmbientEnabled" @update:model-value="draft.personaAmbientEnabled = $event" /></div>
                          <div class="settings-toggle-item"><div><strong>仅限群聊</strong><small>关闭后普通私聊消息也可能触发。</small></div><Switch :model-value="draft.personaAmbientGroupOnly" @update:model-value="draft.personaAmbientGroupOnly = $event" /></div>
                        </div>
                        <div class="form-grid dense">
                          <Field label="触发概率 %" type="number" v-model="draft.personaAmbientProbability" tip="0-100；每条满足条件的普通消息独立判断。" />
                          <Field label="消息最少字符" type="number" v-model="draft.personaAmbientMinChars" />
                        </div>
                      </section>

                      <section class="form-section persona-direct-section">
                        <div class="section-heading-row"><div><div class="section-title"><Icon name="message" :size="13" />主动问候</div><p class="muted small">按目标群、时间间隔和概率主动发起一条新话题。</p></div></div>
                        <div class="settings-toggle-grid">
                          <div class="settings-toggle-item"><div><strong>启用主动问候</strong><small>允许手动测试和主动问候流程。</small></div><Switch :model-value="draft.initiativeGreetingEnabled" @update:model-value="draft.initiativeGreetingEnabled = $event" /></div>
                          <div class="settings-toggle-item"><div><strong>定时发送</strong><small>按配置的间隔和概率自动执行。</small></div><Switch :model-value="draft.initiativeGreetingScheduled" @update:model-value="draft.initiativeGreetingScheduled = $event" /></div>
                        </div>
                        <div class="form-grid dense">
                          <Field label="目标群号" hint="逗号分隔" v-model="draft.initiativeGreetingGroups" />
                          <Field label="间隔小时" type="number" v-model="draft.initiativeGreetingInterval" />
                          <Field label="触发概率 %" type="number" v-model="draft.initiativeGreetingProbability" tip="0-100。" />
                          <Field label="最大字数" type="number" v-model="draft.initiativeGreetingMaxChars" />
                        </div>
                        <div class="form-grid dense">
                          <Field label="提示词" type="textarea" v-model="draft.initiativeGreetingPrompt" />
                          <Field label="兜底短句 JSON" type="textarea" v-model="draft.initiativeGreetingFallbackMessages" />
                        </div>
                        <div class="action-bar">
                          <button class="btn outline" type="button" @click="previewGreeting(false)"><Icon name="eye" :size="14" />测试问候</button>
                          <button class="btn outline" type="button" @click="previewGreeting(true)"><Icon name="eye" :size="14" />测试全部群</button>
                        </div>
                        <div v-if="greetingPreviewResult" class="preview-result-card">
                          <div class="item-head"><div class="item-title"><Icon name="check" :size="14" />测试结果</div></div>
                          <p>{{ greetingPreviewResult.text }}</p>
                          <span class="muted tiny">{{ greetingPreviewResult.target || ('群 ' + greetingPreviewResult.groupId) }} · {{ shortTime(greetingPreviewResult.time) }}</span>
                        </div>
                      </section>
                    </div>

                    <div v-else-if="triggerMenu === 'passive'" class="persona-active-stack">
                      <section class="form-section persona-direct-section">
                        <div class="section-heading-row"><div><div class="section-title"><Icon name="bot" :size="13" />被动称呼触发</div><p class="muted small">消息中出现助手自称或别名时，按概率和冷却策略决定是否回复。</p></div></div>
                        <div class="settings-toggle-grid">
                          <div class="settings-toggle-item"><div><strong>回应名称或别名</strong><small>命中助手自称或别名时进入回复流程。</small></div><Switch :model-value="draft.firstPersonEnabled" @update:model-value="draft.firstPersonEnabled = $event" /></div>
                        </div>
                        <div class="form-grid dense">
                          <Field label="触发概率 %" type="number" v-model="draft.personaTriggerProbability" tip="0-100，用于非必回场景。" />
                          <Field label="用户冷却 ms" type="number" v-model="draft.personaTriggerCooldown" tip="同一用户再次触发前的等待时间。" />
                          <Field label="群冷却 ms" type="number" v-model="draft.personaGroupCooldown" tip="同一群再次触发前的等待时间。" />
                          <Field label="禁用群号" hint="逗号分隔" v-model="draft.personaDisabledGroups" />
                          <Field label="增强关键词" hint="逗号分隔" v-model="draft.personaEnhanceKeywords" />
                          <Field label="关键词提示" type="textarea" v-model="draft.personaEnhancePrompt" />
                          <Field label="增强窗口 ms" type="number" v-model="draft.personaEnhanceRecallMs" tip="关键词命中后的有效时间。" />
                        </div>
                      </section>

                      <section class="form-section persona-direct-section">
                        <div class="section-heading-row"><div><div class="section-title"><Icon name="key" :size="13" />访问控制</div><p class="muted small">控制哪些会话可以进入触发与回复流程。</p></div></div>
                        <div class="settings-toggle-grid">
                          <div class="settings-toggle-item"><div><strong>允许私聊</strong><small>允许用户在私聊中发起对话。</small></div><Switch :model-value="draft.privateChatEnabled" @update:model-value="draft.privateChatEnabled = $event" /></div>
                          <div class="settings-toggle-item"><div><strong>主人绕过限制</strong><small>主人不受名单限制。</small></div><Switch :model-value="draft.accessMasterBypass" @update:model-value="draft.accessMasterBypass = $event" /></div>
                        </div>
                        <div class="form-grid dense">
                          <Field label="对话白名单" hint="逗号分隔" v-model="draft.accessWhitelist" tip="留空表示不启用。" />
                          <Field label="对话黑名单" hint="逗号分隔" v-model="draft.accessBlacklist" />
                        </div>
                      </section>
                    </div>

                    <section v-else-if="triggerMenu === 'at'" class="form-section persona-direct-section">
                      <div class="section-heading-row"><div><div class="section-title"><Icon name="message" :size="13" />艾特触发</div><p class="muted small">被直接 @ 机器人时进入正常回复流程。</p></div></div>
                      <div class="settings-toggle-grid">
                        <div class="settings-toggle-item"><div><strong>回应 @ 机器人</strong><small>关闭后，被 @ 只会被忽略，不影响名称或指令触发。</small></div><Switch :model-value="draft.respondToAt" @update:model-value="draft.respondToAt = $event" /></div>
                      </div>
                    </section>

                    <section v-else class="form-section persona-direct-section">
                      <div class="section-heading-row"><div><div class="section-title"><Icon name="book" :size="13" />指令触发</div><p class="muted small">命令系统先处理明确指令；伪人参与不会抢答指令消息。</p></div></div>
                      <div class="persona-command-summary">
                        <div><span>指令前缀</span><code>{{ draft.commandPrefixes || '未配置' }}</code></div>
                        <div><span>聊天触发前缀</span><code>{{ draft.chatTriggerPrefix }}</code></div>
                        <div><span>帮助前缀</span><code>{{ draft.chatHelpPrefix }}</code></div>
                      </div>
                      <div class="persona-command-note"><Icon name="info" :size="14" /><span>完整的指令知识与前缀维护位于“知识库”页面；这里仅展示当前运行摘要。</span></div>
                    </section>
                  </div>
                </div>

                <div v-else class="persona-settings-pane">
                  <div class="persona-content-head">
                    <div><div class="section-title"><Icon name="message" :size="14" />回复设置</div><p>选择默认交付方式，再按内容类型调整细节。</p></div>
                    <span class="badge on">默认：{{ responseModeLabel }}</span>
                  </div>
                  <div v-if="replyMenu === 'overview'" class="persona-default-mode">
                    <div class="persona-default-mode-head"><div><strong>默认交付方式</strong><p>决定普通对话默认使用文本、图片还是语音回复。</p></div><span class="badge on">{{ responseModeLabel }}</span></div>
                    <div class="response-mode-picker compact" role="radiogroup" aria-label="默认交付方式">
                      <button v-for="item in RESPONSE_MODE_OPTIONS" :key="item.value" class="response-mode-option" :class="{ active: draft.responseMode === item.value }" type="button" role="radio" :aria-checked="draft.responseMode === item.value" @click="draft.responseMode = item.value"><span><Icon :name="item.icon" :size="15" /></span><strong>{{ item.label }}</strong><Icon v-if="draft.responseMode === item.value" name="check" :size="14" /></button>
                    </div>
                  </div>

                  <section v-else-if="replyMenu === 'text'" class="form-section persona-direct-section">
                    <div class="section-heading-row"><div><div class="section-title"><Icon name="message" :size="14" />文本输出</div><p class="muted small">文本专用的显示方式与分段策略。</p></div><span v-if="draft.responseMode === 'text'" class="badge on">默认</span></div>
                    <div class="settings-toggle-grid persona-basic-switches">
                      <div class="settings-toggle-item"><div><strong>省略渠道前缀</strong><small>文本直接输出正文。</small></div><Switch :model-value="draft.personaOmitChannelPrefix" @update:model-value="draft.personaOmitChannelPrefix = $event" /></div>
                      <div class="settings-toggle-item"><div><strong>启用文本分段</strong><small>仅拆分 AI 生成的文本；工具返回、思考过程和兜底短句保持整段发送。</small></div><Switch :model-value="draft.segmentationEnabled" @update:model-value="draft.segmentationEnabled = $event" /></div>
                    </div>
                    <Collapse title="高级分段规则" hint="间隔、阈值和正则表达式">
                      <div class="segmentation-settings">
                        <div class="segmentation-field-row">
                          <div class="segmentation-field-copy"><strong>间隔方法</strong><small>随机更像真人停顿；对数根据每段字数平滑计算等待时间。</small></div>
                          <Field label="" type="select" :options="SEGMENTATION_INTERVAL_OPTIONS" v-model="draft.segmentationIntervalMethod" />
                        </div>
                        <div v-if="draft.segmentationIntervalMethod === 'random'" class="segmentation-field-row">
                          <div class="segmentation-field-copy"><strong>随机间隔时间</strong><small>格式：最小值,最大值，单位为秒，例如 1.5,3.5。</small></div>
                          <Field label="" v-model="draft.segmentationIntervalRange" placeholder="1.5,3.5" />
                        </div>
                        <div v-else class="segmentation-note"><Icon name="info" :size="14" /><span>对数间隔使用 log10(当前分段字数) 秒，并受已保存的最小/最大间隔限制。</span></div>
                        <div class="segmentation-field-row">
                          <div class="segmentation-field-copy"><strong>分段回复字数阈值</strong><small>只有字数小于此值的消息会被分段，超过或等于此值的长消息直接发送，默认为 150。</small></div>
                          <Field label="" type="number" v-model="draft.segmentationThresholdChars" />
                        </div>
                        <div class="segmentation-field-row">
                          <div class="segmentation-field-copy"><strong>分段模式</strong><small>正则表达式可以精确控制每段的结束位置。</small></div>
                          <Field label="" type="select" :options="SEGMENTATION_MODE_OPTIONS" v-model="draft.segmentationMode" />
                        </div>
                        <div v-if="draft.segmentationMode === 'regex'" class="segmentation-field-row">
                          <div class="segmentation-field-copy"><strong>分段正则表达式</strong><small>用于按规则识别分段点，建议保留句末标点匹配。</small></div>
                          <Field label="" v-model="draft.segmentationRegex" placeholder=".*?[。？！!?；;~…]+|.+$" />
                        </div>
                        <div class="segmentation-field-row">
                          <div class="segmentation-field-copy"><strong>内容过滤正则表达式</strong><small>移除分段后内容中的指定字符，例如填写 [。？！] 会移除句号、问号和感叹号。</small></div>
                          <Field label="" v-model="draft.segmentationContentFilterRegex" placeholder="可留空" />
                        </div>
                      </div>
                    </Collapse>
                  </section>

                  <section v-else-if="replyMenu === 'picture'" class="form-section persona-direct-section">
                    <div class="section-heading-row"><div><div class="section-title"><Icon name="eye" :size="14" />图片输出</div><p class="muted small">图片卡片和长文本自动转图策略。</p></div><span v-if="draft.responseMode === 'picture'" class="badge on">默认</span></div>
                    <div class="settings-toggle-grid">
                      <div class="settings-toggle-item"><div><strong>长文本自动转图</strong><small>文本超过阈值时改用图片交付。</small></div><Switch :model-value="draft.pictureAutoEnabled" @update:model-value="draft.pictureAutoEnabled = $event" /></div>
                      <div class="settings-toggle-item"><div><strong>聊天卡片转图片</strong><small>图片模式使用富聊天卡片呈现。</small></div><Switch :model-value="draft.chatCardAsImage" @update:model-value="draft.chatCardAsImage = $event" /></div>
                    </div>
                    <div class="form-grid dense">
                      <Field label="长文本转图阈值" type="number" v-model="draft.pictureThreshold" />
                    </div>
                  </section>

                  <section v-else-if="replyMenu === 'voice'" class="form-section persona-direct-section">
                    <div class="section-heading-row"><div><div class="section-title"><Icon name="activity" :size="14" />语音输出</div><p class="muted small">语音合成参数；分段策略不会作用于语音输出。</p></div><span v-if="draft.responseMode === 'voice'" class="badge on">默认</span></div>
                    <div class="settings-toggle-grid">
                      <div class="settings-toggle-item"><div><strong>启用语音合成</strong><small>语音模式需要可用的 TTS 服务。</small></div><Switch :model-value="draft.ttsEnabled" @update:model-value="draft.ttsEnabled = $event" /></div>
                      <div class="settings-toggle-item"><div><strong>同时发送文本</strong><small>语音发送成功后附带完整文本。</small></div><Switch :model-value="draft.ttsAlsoSendText" @update:model-value="draft.ttsAlsoSendText = $event" /></div>
                    </div>
                    <div class="form-grid dense">
                      <Field label="TTS 模型" v-model="draft.ttsModel" />
                      <Field label="音色" v-model="draft.ttsVoice" />
                      <Field label="音频格式" v-model="draft.ttsFormat" />
                      <Field label="最大合成字符数" type="number" v-model="draft.ttsMaxChars" />
                    </div>
                  </section>

                  <section v-else class="form-section persona-direct-section">
                    <div class="section-heading-row"><div><div class="section-title"><Icon name="database" :size="14" />上下文与媒体</div><p class="muted small">控制最近消息和媒体内容是否随回复提供给模型。</p></div></div>
                    <div class="settings-toggle-grid">
                      <div class="settings-toggle-item"><div><strong>启用媒体上下文</strong><small>识别消息中的图片等媒体。</small></div><Switch :model-value="draft.mediaEnabled" @update:model-value="draft.mediaEnabled = $event" /></div>
                      <div class="settings-toggle-item"><div><strong>下载远程图片</strong><small>下载图片供模型识别，使用受限网络客户端。</small></div><Switch :model-value="draft.mediaRemoteFetch" @update:model-value="draft.mediaRemoteFetch = $event" /></div>
                      <div class="settings-toggle-item"><div><strong>卡片显示缩略图</strong><small>在回复卡片中展示媒体预览。</small></div><Switch :model-value="draft.renderMediaThumbnails" @update:model-value="draft.renderMediaThumbnails = $event" /></div>
                      <div class="settings-toggle-item"><div><strong>压缩缩略图</strong><small>生成适合聊天窗口的预览尺寸。</small></div><Switch :model-value="draft.renderMediaThumbnailEnabled" @update:model-value="draft.renderMediaThumbnailEnabled = $event" /></div>
                    </div>
                    <div class="form-grid dense">
                      <Field label="最近消息条数" type="number" v-model="draft.contextRecentMessageCount" tip="同时用于记录和注入；0 表示关闭最近上下文。" />
                      <Field label="单张图片最大 bytes" type="number" v-model="draft.mediaMaxBytes" />
                      <Field label="缩略图最多张数" type="number" v-model="draft.renderMediaThumbnailCount" />
                    </div>
                  </section>
                </div>
              </div>
            </div>
          </div>

          <div v-else class="persona-section-body">
            <div class="section-heading-row">
              <div><div class="section-title"><Icon name="zap" :size="13" />戳一戳</div><p class="muted small">设置被戳时的触发条件、回复方式和兜底文案。</p></div>
              <div class="heading-switch"><span>{{ draft.personaPokeEnabled ? '已开启' : '已关闭' }}</span><Switch :model-value="draft.personaPokeEnabled" @update:model-value="draft.personaPokeEnabled = $event" /></div>
            </div>
            <div class="settings-toggle-grid">
              <div class="settings-toggle-item"><div><strong>只回应戳机器人</strong><small>忽略群内其他成员之间的戳一戳。</small></div><Switch :model-value="draft.personaPokeBotOnly" @update:model-value="draft.personaPokeBotOnly = $event" /></div>
            </div>
            <div class="form-grid">
              <Field label="回应模式" type="select" :options="POKE_RESPONSE_MODE_OPTIONS" v-model="draft.personaPokeResponseMode" />
              <Field label="触发概率 %" type="number" v-model="draft.personaPokeProbability" tip="0-100，100 表示每次回应。" />
              <Field label="个人冷却 ms" type="number" v-model="draft.personaPokeCooldown" tip="同一用户再次触发前的等待时间。" />
              <Field label="群冷却 ms" type="number" v-model="draft.personaPokeGroupCooldown" tip="同一群再次触发前的等待时间。" />
              <Field label="回复提示词" type="textarea" v-model="draft.personaPokePrompt" />
              <Field label="固定短句 JSON" type="textarea" v-model="draft.personaPokeFallbackMessages" />
            </div>
          </div>
        </Panel>
      </div>
      <div v-if="isDirty" class="sticky-save-bar" role="status">
        <div><span class="dot warn"></span><b>未保存</b></div>
        <div class="row"><button class="btn outline" type="button" @click="resetDraft">放弃</button><button class="btn primary" type="button" @click="save"><Icon name="save" :size="14" />保存</button></div>
      </div>
    </div>
  `,
}
