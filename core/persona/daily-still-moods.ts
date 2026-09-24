/**
 * 日常定格的情绪分组。
 *
 * 每个分组是决策模型的一个 Choice 选项，同时决定图库检索用的精确标签；
 * 标签按优先级排列，靠前的标签先查，候选不足时才查后面的标签。
 */
export interface DailyStillMood {
  name: string
  description: string
  tags: string[]
  /** 本地关键词判断使用的额外词；决策模型不可用时才参与。 */
  keywords: string[]
  /** 只在空闲检查中使用，不作为对话判断选项。 */
  idleOnly: boolean
  /** 可选的允许时段，例如 "21:00-02:00"；留空表示全天。 */
  hours: string
}

type UnknownRecord = Record<string, unknown>

/**
 * 默认分组按内网图库（2026-09 共 1218 张）的精确标签数量挑选：
 * 每组合计至少有数十张图，冷门标签排在后面作为补充。
 */
export const DEFAULT_DAILY_STILL_MOODS: DailyStillMood[] = [
  { name: "安慰", description: "对方难过、受挫或需要被安抚，用温柔的方式回应", tags: ["安慰", "摸摸头", "摸头", "抱抱", "治愈"], keywords: ["难受", "伤心", "崩溃", "抱抱", "安慰", "心疼", "不开心"], idleOnly: false, hours: "" },
  { name: "疲惫", description: "抱怨累、困、加班、没精神", tags: ["疲惫", "摆烂", "躺平", "睡觉", "无奈"], keywords: ["累", "困", "加班", "熬夜", "好忙", "疲惫", "没精神"], idleOnly: false, hours: "" },
  { name: "开心", description: "好消息、庆祝、兴奋、气氛愉快", tags: ["开心", "兴奋", "激动", "点赞"], keywords: ["太好了", "好耶", "开心", "庆祝", "恭喜", "成功", "上岸"], idleOnly: false, hours: "" },
  { name: "搞怪", description: "玩梗、搞笑、沙雕气氛，大家在乐", tags: ["搞怪", "滑稽", "调皮", "沙雕"], keywords: ["哈哈哈", "笑死", "绷不住", "乐", "离大谱"], idleOnly: false, hours: "" },
  { name: "得意", description: "炫耀、自夸、被夸后的小得意", tags: ["得意", "傲娇"], keywords: ["厉害", "牛", "得意", "炫耀", "我就说"], idleOnly: false, hours: "" },
  { name: "期待", description: "盼着某件事、等不及、好奇结果", tags: ["期待", "好奇"], keywords: ["期待", "等不及", "快点", "好想", "什么时候"], idleOnly: false, hours: "" },
  { name: "无语", description: "吐槽离谱的事，无话可说", tags: ["无语", "呆滞", "无奈"], keywords: ["无语", "离谱", "服了", "绝了", "什么鬼", "6"], idleOnly: false, hours: "" },
  { name: "嫌弃", description: "对烂梗、糟糕的东西表示嫌弃或嘲讽", tags: ["嫌弃", "鄙视", "嘲讽"], keywords: ["嫌弃", "好烂", "恶心", "咦"], idleOnly: false, hours: "" },
  { name: "震惊", description: "意外消息、难以置信", tags: ["震惊", "破防"], keywords: ["震惊", "卧槽", "真的假的", "不会吧", "天哪", "居然"], idleOnly: false, hours: "" },
  { name: "疑惑", description: "看不懂、困惑、打问号", tags: ["疑惑", "问号", "懵逼"], keywords: ["？", "?", "为什么", "啥", "什么意思", "看不懂"], idleOnly: false, hours: "" },
  { name: "害羞", description: "被夸、被表白、不好意思", tags: ["害羞", "尴尬"], keywords: ["害羞", "脸红", "不好意思", "喜欢你"], idleOnly: false, hours: "" },
  { name: "卖萌", description: "撒娇、求关注、轻松闲聊", tags: ["卖萌", "撒娇", "呆萌", "乖巧", "可爱"], keywords: ["可爱", "撒娇", "贴贴", "要抱"], idleOnly: false, hours: "" },
  { name: "生气", description: "被冒犯、抗议、假装生气", tags: ["生气", "愤怒", "暴躁", "奶凶"], keywords: ["生气", "气死", "哼", "过分"], idleOnly: false, hours: "" },
  { name: "委屈", description: "被欺负、失落、想哭", tags: ["委屈", "哭泣", "大哭", "流泪", "难过"], keywords: ["委屈", "呜呜", "哭", "欺负", "失落"], idleOnly: false, hours: "" },
  { name: "吃瓜", description: "围观八卦、看热闹", tags: ["吃瓜", "暗中观察"], keywords: ["吃瓜", "八卦", "看戏", "围观"], idleOnly: false, hours: "" },
  { name: "摸鱼", description: "上班摸鱼、偷懒、不想干活", tags: ["摸鱼", "摆烂", "发呆"], keywords: ["摸鱼", "上班", "不想干", "划水", "打工"], idleOnly: false, hours: "" },
  { name: "感谢", description: "道谢、感谢帮助", tags: ["感谢", "谢谢", "比心", "爱心", "点赞"], keywords: ["谢谢", "感谢", "多谢", "辛苦了"], idleOnly: false, hours: "" },
  { name: "晚安", description: "道晚安、准备睡觉", tags: ["晚安", "睡觉"], keywords: ["晚安", "睡了", "睡觉"], idleOnly: false, hours: "21:00-02:00" },
  { name: "冒泡", description: "群里冷场时出来露个面", tags: ["冒泡", "打招呼", "暗中观察", "吃瓜"], keywords: [], idleOnly: true, hours: "" },
]

export const DEFAULT_IDLE_MOODS = ["冒泡", "摸鱼", "吃瓜", "卖萌", "晚安"]

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function words(value: unknown, limit: number): string[] {
  const source = Array.isArray(value) ? value.map(text) : text(value).split(/[\s,，、|]+/)
  return [...new Set(source.map(item => item.trim().slice(0, 40)).filter(Boolean))].slice(0, limit)
}

/** 读取配置中的分组；未配置或全部无效时回到默认分组。 */
export function dailyStillMoods(value: unknown): DailyStillMood[] {
  const defaults = () => DEFAULT_DAILY_STILL_MOODS.map(item => ({ ...item, tags: [...item.tags], keywords: [...item.keywords] }))
  if (!Array.isArray(value)) return defaults()
  const seen = new Set<string>()
  const moods: DailyStillMood[] = []
  for (const raw of value) {
    if (!isRecord(raw)) continue
    const name = text(raw.name).trim().slice(0, 24)
    const tags = words(raw.tags, 6)
    if (!name || !tags.length || seen.has(name) || name === "none") continue
    seen.add(name)
    moods.push({
      name,
      description: text(raw.description).trim().slice(0, 120),
      tags,
      keywords: words(raw.keywords, 24),
      idleOnly: raw.idleOnly === true,
      hours: text(raw.hours).trim(),
    })
    if (moods.length >= 60) break
  }
  return moods.length ? moods : defaults()
}

function minutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour < 24 && minute < 60 ? hour * 60 + minute : null
}

/** 判断分组时段；格式错误时视为全天可用，避免一条配置让分组完全失效。 */
export function moodAvailableAt(mood: DailyStillMood, now = new Date()): boolean {
  if (!mood.hours) return true
  const [startText = "", endText = ""] = mood.hours.split("-")
  const start = minutes(startText)
  const end = minutes(endText)
  if (start === null || end === null) return true
  const current = now.getHours() * 60 + now.getMinutes()
  return start <= end ? current >= start && current <= end : current >= start || current <= end
}

/** 决策模型的候选分组：排除仅空闲使用和当前时段不可用的分组。 */
export function conversationMoods(moods: DailyStillMood[], now = new Date()): DailyStillMood[] {
  return moods.filter(mood => !mood.idleOnly && moodAvailableAt(mood, now))
}

/**
 * 空闲检查从指定分组中随机取一个当前时段可用的分组。
 * avoid 里的分组（最近发过的情绪）优先排除；全部被排除时仍从完整候选里取。
 */
export function pickIdleMood(moods: DailyStillMood[], names: unknown, now = new Date(), random = Math.random(), avoid: string[] = []): DailyStillMood | null {
  const wanted = words(names, 60)
  const available = moods.filter(mood => (wanted.length ? wanted.includes(mood.name) : mood.idleOnly) && moodAvailableAt(mood, now))
  const fresh = available.filter(mood => !avoid.includes(mood.name))
  const pool = fresh.length ? fresh : available
  if (!pool.length) return null
  return pool[Math.min(pool.length - 1, Math.floor(random * pool.length))]
}

/** 本地关键词判断：按分组名、标签和关键词命中数排序，没有命中就不发送。 */
export function matchMoodByKeywords(moods: DailyStillMood[], source: string): { mood: DailyStillMood; hits: number } | null {
  const content = source.toLowerCase()
  if (!content.trim()) return null
  let best: { mood: DailyStillMood; hits: number } | null = null
  for (const mood of moods) {
    const terms = [...new Set([mood.name, ...mood.tags, ...mood.keywords].map(item => item.toLowerCase()).filter(Boolean))]
    const hits = terms.reduce((count, term) => count + (content.includes(term) ? 1 : 0), 0)
    if (hits > 0 && (!best || hits > best.hits)) best = { mood, hits }
  }
  return best
}

/** 图库描述的固定四段：主体、文字、心情/氛围、表述含义。 */
export interface StillDescription {
  subject: string
  caption: string
  moods: string[]
  meaning: string
}

const DESCRIPTION_SECTIONS: Array<[keyof Omit<StillDescription, "moods"> | "moods", string]> = [
  ["subject", "主体"],
  ["caption", "文字"],
  ["moods", "心情/氛围"],
  ["meaning", "表述含义"],
]

/** 解析图库描述；不符合模板的描述返回空字段，不抛错。 */
export function parseStillDescription(description: unknown): StillDescription {
  const source = text(description)
  const result: StillDescription = { subject: "", caption: "", moods: [], meaning: "" }
  const marks = DESCRIPTION_SECTIONS
    .map(([key, label]) => {
      const match = new RegExp(`${label.replace("/", "\\/")}\\s*[:：]\\s*`).exec(source)
      return match ? { key, start: match.index, end: match.index + match[0].length } : null
    })
    .filter((item): item is { key: (typeof DESCRIPTION_SECTIONS)[number][0]; start: number; end: number } => Boolean(item))
    .sort((a, b) => a.start - b.start)
  marks.forEach((mark, index) => {
    const value = source.slice(mark.end, marks[index + 1]?.start ?? source.length).trim().replace(/[。.；;]+$/u, "").trim()
    if (mark.key === "moods") result.moods = [...new Set(value.split(/[、,，/\s]+/u).map(item => item.trim()).filter(item => item && item.length <= 8))]
    else result[mark.key] = value
  })
  return result
}

export interface GalleryStatsInput {
  id: string
  description: string
  tags: string[]
}

export interface GalleryStats {
  scanned: number
  total: number | null
  /** 描述里解析出“心情/氛围”的图片数。 */
  described: number
  terms: Array<{ term: string; count: number; coveredBy: string[] }>
  moods: Array<{ name: string; images: number; tags: Array<{ tag: string; count: number }> }>
}

/** 统计“心情/氛围”高频词与情绪分组标签覆盖，辅助扩充分组。 */
export function summarizeGallery(items: GalleryStatsInput[], moods: DailyStillMood[], total: number | null = null, limit = 60): GalleryStats {
  const termCounts = new Map<string, number>()
  const tagCounts = new Map<string, number>()
  let described = 0
  for (const item of items) {
    const parsed = parseStillDescription(item.description)
    if (parsed.moods.length) described += 1
    for (const term of parsed.moods) termCounts.set(term, (termCounts.get(term) || 0) + 1)
    for (const tag of new Set(item.tags)) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
  }
  const covering = (term: string) => moods
    .filter(mood => mood.name === term || mood.tags.includes(term) || mood.keywords.includes(term))
    .map(mood => mood.name)
  return {
    scanned: items.length,
    total,
    described,
    terms: [...termCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([term, count]) => ({ term, count, coveredBy: covering(term) })),
    moods: moods.map(mood => ({
      name: mood.name,
      images: items.filter(item => item.tags.some(tag => mood.tags.includes(tag))).length,
      tags: mood.tags.map(tag => ({ tag, count: tagCounts.get(tag) || 0 })),
    })),
  }
}
