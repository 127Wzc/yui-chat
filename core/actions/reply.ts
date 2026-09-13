import { actionRecord as record, type ActionReply } from "./contract.js"
import { serializeExecutionResult } from "../../extensions/testing/execution-runtime.js"
import type { ToolExecutionResult } from "../../tools/support/execution-runtime.js"
import { extractMessageChain } from "../message-chain/inbound.js"

type Result = Pick<ToolExecutionResult, "value" | "content" | "metadata" | "status">
export interface ActionReplyPreview { message: string; parts: unknown[]; note: string }

export function extractActionResult(value: unknown, path: string): unknown {
  if (!path) return value
  if (typeof value === "string") {
    try { value = JSON.parse(value) } catch { throw new Error("返回值不是 JSON，无法提取字段") }
  }
  for (const key of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (["__proto__", "prototype", "constructor"].includes(key) || !value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error(`结果中没有字段 ${path}`)
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

function imagePart(value: unknown): unknown {
  const item = record(value)
  if (item.type === "image" && item.source) return item
  if (item.kind && typeof item.value === "string") return { type: "image", source: item }
  if (Buffer.isBuffer(value)) return { type: "image", source: { kind: "base64", value: value.toString("base64"), mimeType: "image/png" } }
  const address = typeof value === "string" ? value : item.url || item.image || item.b64_json
  if (typeof address !== "string" || !address.trim()) throw new Error("图片结果应为图片地址、base64 或图片消息段")
  if (/^https?:\/\//i.test(address)) return { type: "image", source: { kind: "url", value: address } }
  if (/^(?:data:image\/|base64:\/\/)/i.test(address) || item.b64_json) return { type: "image", source: { kind: "base64", value: address.replace(/^base64:\/\//, ""), mimeType: "image/png" } }
  throw new Error("图片地址格式无法识别；本地图片请返回标准 source 消息体")
}

/** 只组装回复，不读 URL、不执行源码；预览与实际投递复用同一转换。 */
export function formatActionReply(result: Result, reply: ActionReply, alreadyReplied = false): ActionReplyPreview {
  const original = record(result.value)
  const metadata = record(result.metadata)
  const empty = (note: string): ActionReplyPreview => ({ message: "", parts: [], note })
  if (!["success", "ok"].includes(result.status)) return { message: serializeExecutionResult(result.content), parts: [], note: "执行状态" }
  if (original.kind === "delivery" && ["failed", "partial"].includes(String(record(original.receipt).status))) return { message: "动作已执行，但部分结果未能发送。", parts: [], note: "投递未完成，不自动重发" }
  if (original.kind === "delivery" || Number(metadata.sentCount) > 0 || alreadyReplied) return empty("执行方法已回传消息，不重复发送")
  if (reply.mode === "silent") return empty("已设置不自动回复")
  const planned = record(metadata.messageSendPlan).parts
  let value = result.value ?? result.content
  if (reply.path) value = extractActionResult(value, reply.path)
  else if (reply.mode === "auto") value = planned || original.chain || original.parts || original.content || original.result || value
  if (value === undefined || value === null || value === "") return empty("没有需要回复的内容")
  let parts: unknown[] = []
  if (reply.mode === "message") {
    if (typeof value === "string") { try { value = JSON.parse(value) } catch { throw new Error("消息体应为 JSON 数组或包含 parts 的对象") } }
    const candidate = Array.isArray(value) ? value : record(value).parts || record(value).chain || (record(value).type ? [value] : null)
    if (!Array.isArray(candidate) || !candidate.length || candidate.length > 50 || candidate.some(part => !record(part).type)) throw new Error("消息体需要 1–50 个带 type 的消息段")
    parts = candidate
  } else if (reply.mode === "image") parts = (Array.isArray(value) ? value.slice(0, 10) : [value]).map(imagePart)
  else if (reply.mode === "auto") {
    if (Array.isArray(value) && value.length && value.every(part => typeof record(part).type === "string")) parts = value.slice(0, 50)
    else if (["text", "image", "audio", "record", "video", "file"].includes(String(record(value).type))) parts = [value]
    else if (typeof value === "string" && (/^https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:[?#]\S*)?$/i.test(value) || /^data:image\//i.test(value))) parts = [imagePart(value)]
    else if (Buffer.isBuffer(value)) parts = [imagePart(value)]
    else if (typeof record(value).text === "string") value = record(value).text
    else if (typeof record(value).url === "string") {
      const url = String(record(value).url)
      if (/\.(?:png|jpe?g|webp|gif)(?:[?#]|$)/i.test(url)) parts = [imagePart(url)]
      else value = url
    }
  }
  if (parts.length) {
    parts = parts.flatMap(part => {
      const item = record(part)
      if (item.data || (["image", "audio", "record", "video", "file"].includes(String(item.type)) && !item.source)) return [...extractMessageChain({ message: [part] })]
      return [part]
    })
    parts = parts.map(part => record(part).type === "json" ? { type: "text", text: serializeExecutionResult(record(part).data) } : part)
    return { message: parts.filter(part => record(part).type === "text").map(part => String(record(part).text || "")).join("\n"), parts, note: "按消息体回传" }
  }
  let message = reply.mode === "json" ? serializeExecutionResult(typeof value === "string" ? (() => { try { return JSON.parse(value) } catch { return value } })() : value) : serializeExecutionResult(value)
  if (reply.template) message = reply.template.replace(/\{\{\s*value\s*\}\}/g, () => message)
  return { message, parts: message ? [{ type: "text", text: message }] : [], note: "文字回复" }
}
