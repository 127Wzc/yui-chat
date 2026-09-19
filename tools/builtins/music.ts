import { createHash } from "node:crypto"
import { fetchWithTimeout } from "../../core/network/fetch-timeout.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}
}
function text(value: unknown): string { return String(value ?? "").replace(/<\/?em>/gi, "").trim() }

export class MusicPlayTool {
  name = "music_play"
  source = "builtin"
  category = "media"
  risk = "medium"
  tags = ["music", "qq", "search", "audio"]
  policy = { externalNetwork: true }
  delivery = "media"
  requiresFinalReply = false
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["keyword"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1, timeoutMs: 60000, dispatchMarking: "deferred" }
  description = "Search QQ Music by song title or title and artist, select the first result, then immediately send its music card and audio as two separate messages to the current chat. Do not call message_send again for this result."
  parameters = {
    type: "object",
    properties: { keyword: { type: "string", minLength: 1, maxLength: 200, description: "歌曲名或歌曲名加歌手；直接发送搜索命中的第一首。" } },
    required: ["keyword"],
  }

  async execute(args: RecordValue, context: ToolExecutionContext = {}): Promise<RecordValue> {
    const keyword = text(args.keyword)
    if (!keyword) throw new Error("请提供歌曲名或歌手关键词。")
    const signal = context.agent?.signal || context.signal
    signal?.throwIfAborted()
    const data = record(await fetchWithTimeout("https://u.y.qq.com/cgi-bin/musicu.fcg", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0", Referer: "https://y.qq.com/" },
      signal,
      timeoutMs: 15000,
      body: JSON.stringify({
        comm: { uin: "0", ct: 11, cv: 0, format: "json" },
        search: {
          method: "DoSearchForQQMusicMobile", module: "music.search.SearchCgiService",
          param: { num_per_page: 1, page_num: 1, query: keyword, search_type: 0 },
        },
      }),
      consume: async response => {
        if (!response.ok) throw new Error(`QQ 音乐搜索失败：HTTP ${response.status}`)
        return response.json()
      },
    }))
    const search = record(data.search)
    if (data.code !== 0 || (search.code !== undefined && search.code !== 0)) throw new Error("QQ 音乐搜索服务返回错误。")
    const body = record(record(search.data).body)
    const songs = record(body.song).list || body.item_song
    if (!Array.isArray(songs) || !songs.length) return { status: "failed", isError: true, content: `未找到歌曲：${keyword}`, retryAllowed: false }
    const song = record(songs[0])
    const mid = text(song.mid)
    if (!/^[a-zA-Z0-9]+$/.test(mid)) throw new Error("QQ 音乐首个结果缺少有效歌曲标识。")
    const title = text(song.title || song.name) || "未知歌曲"
    const singers = Array.isArray(song.singer) ? song.singer.map(record) : []
    const singer = singers.map(item => text(item.name)).filter(Boolean).join("/") || "未知歌手"
    const albumMid = text(record(song.album).mid)
    const image = /^[a-zA-Z0-9]+$/.test(albumMid) ? `https://y.gtimg.cn/music/photo_new/T002R150x150M000${albumMid}.jpg` : ""
    const code = createHash("md5").update(`${mid}q;z(&l~sdf2!nK`).digest("hex").slice(0, 5).toUpperCase()
    const event = record(context.e)
    const uin = text(event.self_id || record(event.bot).uin) || "0"
    const audio = new URL("https://c6.y.qq.com/rsc/fcgi-bin/fcg_pyq_play.fcg")
    audio.search = new URLSearchParams({ songid: "", songmid: mid, songtype: "1", fromtag: "50", uin, code }).toString()
    const card = { type: "music", platform: "custom", url: `https://y.qq.com/n/yqq/song/${mid}.html`, audio: audio.href, title, singer, image }
    const { toolRegistry } = await import("../support/registry.js")
    let sentCount = 0
    try {
      // 两次独立且串行的 Registry 投递，禁止将卡片和音频拼入同一消息。
      for (const [index, part] of [card, { type: "audio", source: { kind: "url", value: audio.href } }].entries()) {
        signal?.throwIfAborted()
        const result = record(await toolRegistry.execute("message_send", { parts: [part] }, {
          ...context,
          actionDelivery: Boolean(context.actionId),
          execution: { ...context.execution, background: false, operationId: `${context.execution?.operationId || "music_play"}:${index}` },
          observability: { ...context.observability, toolCallId: `${context.observability?.toolCallId || "music_play"}:${index}` },
        } as Parameters<typeof toolRegistry.execute>[2]))
        const receipt = record(result.receipt)
        if (result.isError || !["sent", "success", "accepted"].includes(text(receipt.status || result.status))) throw new Error("消息发送未成功。")
        sentCount++
      }
      return { status: "success", content: `已发送《${title}》—${singer}，音乐卡片与音频已分两条发送。`, sentCount, executedCount: 1, retryAllowed: false }
    } catch (error) {
      return {
        status: sentCount ? "partial" : "failed",
        isError: true,
        content: `${sentCount ? "音乐卡片已发送，音频发送失败" : "音乐发送失败"}：${error instanceof Error ? error.message : String(error)}`,
        sentCount,
        // 消息片段数不等于业务操作数；已发卡片即消耗本次点歌操作额度。
        executedCount: sentCount ? 1 : 0,
        retryAllowed: false,
        metadata: { receiptStatus: sentCount ? "partial" : "failed", receiptSentCount: sentCount, receiptFailedCount: 2 - sentCount },
      }
    }
  }
}
