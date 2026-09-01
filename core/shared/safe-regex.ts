import { Worker } from "node:worker_threads"

type UnknownRecord = Record<string, unknown>

const workerSource = `
  const { parentPort, workerData } = require("node:worker_threads")
  try {
    const regex = new RegExp(workerData.pattern, workerData.flags)
    const text = String(workerData.text).replace(regex, String(workerData.replacement))
    parentPort.postMessage({ ok: true, text })
  } catch (err) {
    parentPort.postMessage({ ok: false, message: err.message })
  }
`

function normalizeFlags(value: unknown = ""): string {
  const flags = String(value || "g")
  if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length) {
    throw new Error("正则标志只支持 d、g、i、m、s、u、v、y，且不能重复")
  }
  return flags
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

export interface SafeRegexOptions {
  timeoutMs?: unknown
}

/** 在独立 Worker 中执行受限正则替换，避免灾难性回溯阻塞机器人主进程。 */
export async function replaceWithSafeRegex(
  text: unknown,
  pattern: unknown,
  replacement: unknown = "",
  flags: unknown = "g",
  opts: SafeRegexOptions = {},
): Promise<string> {
  const source = String(pattern || "")
  const input = String(text || "")
  if (!source) throw new Error("请填写正则表达式")
  if (source.length > 256) throw new Error("正则表达式最多 256 个字符")
  if (input.length > 20000) throw new Error("正则处理的单条消息最多 20,000 个字符")
  const timeoutMs = Math.max(20, Math.min(500, Number(opts.timeoutMs) || 80))
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { text: input, pattern: source, replacement: String(replacement || ""), flags: normalizeFlags(flags) },
    } as unknown as ConstructorParameters<typeof Worker>[1])
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = async (callback: () => void): Promise<void> => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      await worker.terminate().catch(() => {})
      callback()
    }
    timer = setTimeout(() => {
      settle(() => reject(new Error(`正则执行超过 ${timeoutMs}ms，已停止；请简化表达式`)))
    }, timeoutMs)
    worker.once("message", (result: unknown) => {
      settle(() => {
        const value = record(result)
        if (value.ok) resolve(String(value.text || ""))
        else reject(new Error(String(value.message || "正则处理失败")))
      })
    })
    worker.once("error", (err: unknown) => {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))))
    })
  })
}
