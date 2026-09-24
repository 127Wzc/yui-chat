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
 * 默认情绪字典，按内网图库（2026-09 共 1219 张）的精确标签数量整理：
 * 标签按命中数和贴合度排序，冷门分组依赖分组名的模糊检索补齐候选。
 * 调整分组时注意选项之间要容易区分，否则决策模型的概率会被分散。
 */
export const DEFAULT_DAILY_STILL_MOODS: DailyStillMood[] = [
  { name: "安慰", description: "对方难过、受挫，需要被安抚", tags: ["安慰", "摸摸头", "摸头", "抱抱", "治愈", "治愈系"], keywords: ["难受", "心疼", "不开心", "抱抱我", "安慰"], idleOnly: false, hours: "" },
  { name: "难过", description: "伤心、想哭、失落、心碎", tags: ["哭泣", "大哭", "流泪", "难过", "伤心", "心碎"], keywords: ["呜呜", "想哭", "哭了", "伤心", "难过", "失落"], idleOnly: false, hours: "" },
  { name: "委屈", description: "被欺负、装可怜、求放过", tags: ["委屈", "可怜", "无辜", "卑微", "求饶"], keywords: ["委屈", "欺负", "可怜", "不是我", "求放过"], idleOnly: false, hours: "" },
  { name: "崩溃", description: "心态炸了、破防、emo", tags: ["崩溃", "破防", "抓狂", "emo", "绝望", "心累"], keywords: ["崩溃", "破防", "emo", "心态炸", "裂开", "绷不住了"], idleOnly: false, hours: "" },
  { name: "疲惫", description: "累、困、加班熬夜、没精神", tags: ["疲惫", "困倦", "躺平", "睡觉", "无奈"], keywords: ["累", "困", "加班", "熬夜", "好忙", "没精神", "疲惫"], idleOnly: false, hours: "" },
  { name: "摸鱼", description: "上班摸鱼、偷懒、不想干活", tags: ["摸鱼", "摆烂", "上班", "无聊"], keywords: ["摸鱼", "上班", "不想干", "划水", "打工", "摆烂"], idleOnly: false, hours: "" },
  { name: "发呆", description: "放空、走神、盯着看", tags: ["发呆", "放空", "凝视", "盯"], keywords: ["发呆", "走神", "放空", "盯"], idleOnly: false, hours: "" },
  { name: "惬意", description: "悠闲、满足、享受当下", tags: ["惬意", "悠闲", "慵懒", "满足", "享受"], keywords: ["舒服", "惬意", "悠闲", "躺着", "满足", "放假"], idleOnly: false, hours: "" },
  { name: "干饭", description: "饿了、吃饭、嘴馋", tags: ["干饭", "吃饭", "流口水", "馋"], keywords: ["饿", "吃饭", "干饭", "好吃", "馋", "外卖"], idleOnly: false, hours: "" },
  { name: "开心", description: "高兴、兴奋、气氛愉快", tags: ["开心", "大笑", "兴奋", "激动", "欢快"], keywords: ["开心", "太好了", "好耶", "哈哈哈", "高兴"], idleOnly: false, hours: "" },
  { name: "庆祝", description: "好消息、恭喜、成功、生日", tags: ["庆祝", "撒花", "鼓掌", "点赞", "生日"], keywords: ["恭喜", "庆祝", "上岸", "成功", "生日快乐", "通过了"], idleOnly: false, hours: "" },
  { name: "加油", description: "鼓励、打气、考试比赛前", tags: ["加油", "鼓励", "努力", "奋斗", "自信"], keywords: ["加油", "冲", "努力", "拼了", "明天考试"], idleOnly: false, hours: "" },
  { name: "得意", description: "炫耀、自夸、被夸后得意", tags: ["得意", "傲娇", "嚣张", "得瑟", "自信"], keywords: ["厉害", "牛", "我就说", "炫耀", "得意"], idleOnly: false, hours: "" },
  { name: "期待", description: "盼着某事、等不及、好奇结果", tags: ["期待", "好奇", "祈祷"], keywords: ["期待", "等不及", "快点", "好想", "什么时候"], idleOnly: false, hours: "" },
  { name: "搞怪", description: "玩梗、沙雕、大家在乐", tags: ["搞怪", "滑稽", "魔性", "沙雕", "调皮"], keywords: ["笑死", "绷不住", "乐", "沙雕", "离大谱"], idleOnly: false, hours: "" },
  { name: "调侃", description: "开玩笑逗人、坏笑、揶揄", tags: ["调侃", "坏笑", "狡黠", "俏皮"], keywords: ["嘿嘿", "坏笑", "逗你", "开玩笑"], idleOnly: false, hours: "" },
  { name: "阴阳怪气", description: "嘲讽、反讽、挑衅", tags: ["阴阳怪气", "嘲讽", "戏谑", "挑衅"], keywords: ["呵呵", "就这", "不会吧", "阴阳"], idleOnly: false, hours: "" },
  { name: "嫌弃", description: "嫌弃、鄙视、看不上", tags: ["嫌弃", "鄙视", "白眼"], keywords: ["嫌弃", "好烂", "恶心", "咦", "垃圾"], idleOnly: false, hours: "" },
  { name: "无语", description: "离谱、无话可说、无奈", tags: ["无语", "呆滞", "无奈", "流汗", "叹气"], keywords: ["无语", "离谱", "服了", "绝了", "什么鬼"], idleOnly: false, hours: "" },
  { name: "震惊", description: "意外、难以置信", tags: ["震惊", "惊讶", "震撼", "吃惊"], keywords: ["震惊", "卧槽", "真的假的", "天哪", "居然"], idleOnly: false, hours: "" },
  { name: "疑惑", description: "看不懂、懵、打问号", tags: ["疑惑", "问号", "懵逼", "困惑"], keywords: ["？", "为什么", "啥", "什么意思", "看不懂", "懵"], idleOnly: false, hours: "" },
  { name: "思考", description: "认真想、琢磨、做决定", tags: ["思考", "专注"], keywords: ["想想", "思考", "琢磨", "纠结", "该怎么办"], idleOnly: false, hours: "" },
  { name: "害羞", description: "被夸、被表白、不好意思", tags: ["害羞", "脸红", "心动", "花痴"], keywords: ["害羞", "脸红", "不好意思", "喜欢你"], idleOnly: false, hours: "" },
  { name: "尴尬", description: "社死、冷场、说错话", tags: ["尴尬", "装傻", "流汗"], keywords: ["尴尬", "社死", "冷场", "说错了", "当我没说"], idleOnly: false, hours: "" },
  { name: "害怕", description: "紧张、恐惧、慌了", tags: ["害怕", "惊恐", "紧张", "慌张"], keywords: ["害怕", "好怕", "紧张", "慌", "吓死"], idleOnly: false, hours: "" },
  { name: "生气", description: "被冒犯、抗议、假装生气", tags: ["生气", "愤怒", "暴躁", "奶凶", "叉腰"], keywords: ["生气", "气死", "哼", "过分", "可恶"], idleOnly: false, hours: "" },
  { name: "拒绝", description: "不要、不行、不同意", tags: ["拒绝", "摇头", "投降"], keywords: ["不要", "不行", "拒绝", "才不", "别"], idleOnly: false, hours: "" },
  { name: "道歉", description: "认错、对不起、求原谅", tags: ["道歉", "对不起", "认错", "求饶"], keywords: ["对不起", "抱歉", "我错了", "sorry", "原谅"], idleOnly: false, hours: "" },
  { name: "冷漠", description: "不想理、敷衍、面无表情", tags: ["冷漠", "面无表情", "淡定"], keywords: ["哦", "随便", "关我什么事", "无所谓"], idleOnly: false, hours: "" },
  { name: "卖萌", description: "撒娇、求关注、装可爱", tags: ["卖萌", "撒娇", "呆萌", "软萌", "乖巧", "可爱"], keywords: ["可爱", "撒娇", "要抱", "理理我"], idleOnly: false, hours: "" },
  { name: "喜欢", description: "表达喜欢、亲近、贴贴", tags: ["贴贴", "爱心", "比心", "亲亲", "喜欢"], keywords: ["贴贴", "喜欢", "爱你", "亲亲", "比心"], idleOnly: false, hours: "" },
  { name: "感谢", description: "道谢、感谢帮助", tags: ["感谢", "谢谢", "比心", "点赞"], keywords: ["谢谢", "感谢", "多谢", "辛苦了"], idleOnly: false, hours: "" },
  { name: "吃瓜", description: "围观八卦、看热闹", tags: ["吃瓜", "围观", "暗中观察", "八卦", "偷看"], keywords: ["吃瓜", "八卦", "看戏", "围观"], idleOnly: false, hours: "" },
  { name: "溜了", description: "告辞、先走了、跑路", tags: ["溜了", "跑路", "逃跑", "再见"], keywords: ["溜了", "先走了", "告辞", "拜拜", "跑路"], idleOnly: false, hours: "" },
  { name: "早安", description: "问早、刚起床", tags: ["早安", "早上好", "元气", "打招呼"], keywords: ["早安", "早上好", "起床", "早啊"], idleOnly: false, hours: "05:00-11:00" },
  { name: "晚安", description: "道晚安、准备睡觉", tags: ["晚安", "睡觉", "困倦"], keywords: ["晚安", "睡了", "睡觉", "先睡"], idleOnly: false, hours: "21:00-03:00" },
  { name: "冒泡", description: "群里冷场时出来露个面", tags: ["冒泡", "打招呼", "挥手", "暗中观察", "窥屏"], keywords: [], idleOnly: true, hours: "" },
]

export const DEFAULT_IDLE_MOODS = ["冒泡", "摸鱼", "吃瓜", "发呆", "卖萌", "早安", "晚安"]

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
