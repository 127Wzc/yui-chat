import { spawn } from "node:child_process"
import path from "node:path"
import { cloneJsonValue } from "../../core/shared/json-values.js"
import { runIsolatedModelTask } from "../../models/isolated-task.js"
import { createFrameworkResourceAccess, type FrameworkResourceDeclaration } from "../../extensions/framework-resources.js"
import { validateCustomFilterManifest, type CustomFilterValidation } from "../custom/manager.js"

type UnknownRecord = Record<string, unknown>

interface FilterAuthoringContext extends UnknownRecord {
  event?: unknown
}

interface ResourceContext {
  included: Array<FrameworkResourceDeclaration & { content: string; truncated: boolean }>
  skipped: Array<{ alias: string; reason: string }>
}

const MAX_REQUIREMENT_CHARS = 4000
const MAX_CURRENT_SOURCE_CHARS = 50000
const MAX_GENERATED_SOURCE_CHARS = 80000
const MAX_RESOURCE_CHARS = 12000
const MAX_RESOURCE_TOTAL_CHARS = 36000

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : text(error)
}

function taggedSection(value: unknown, tag: string): string {
  const match = text(value).match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i"))
  return match?.[1]?.trim() || ""
}

function stripCodeFence(value: unknown = ""): string {
  const source = text(value).trim()
  const match = source.match(/^```(?:javascript|js|json)?\s*\n([\s\S]*?)\n```$/i)
  return match ? match[1].trim() : source
}

function sensitiveResource(item: FrameworkResourceDeclaration): boolean {
  const name = path.basename(item.path)
  const normalized = item.path.replace(/\\/g, "/")
  if (item.scope === "yunzai" && /^(?:data|cache|config)(?:\/|$)/i.test(normalized)) return true
  return name.startsWith(".")
    || /^config(?:\.[^.]+)?\.json$/i.test(name)
    || /^(?:credentials?|secrets?|tokens?|api[-_]?keys?)\.(?:json|ya?ml|txt)$/i.test(name)
}

async function resourceContext(manifest: UnknownRecord): Promise<ResourceContext> {
  const framework = createFrameworkResourceAccess(record(manifest.frameworkResources), { packageId: text(manifest.id) || "draft" })
  const included: ResourceContext["included"] = []
  const skipped: ResourceContext["skipped"] = []
  let totalChars = 0
  for (const item of framework.list()) {
    if (sensitiveResource(item)) {
      skipped.push({ alias: item.alias, reason: "疑似包含运行配置或密钥，未发送给模型" })
      continue
    }
    if (totalChars >= MAX_RESOURCE_TOTAL_CHARS) {
      skipped.push({ alias: item.alias, reason: "已达到资源上下文总长度上限" })
      continue
    }
    try {
      const source = await framework.readSource(item.alias, { maxBytes: MAX_RESOURCE_CHARS * 4 })
      const remaining = MAX_RESOURCE_TOTAL_CHARS - totalChars
      const content = source.slice(0, Math.min(MAX_RESOURCE_CHARS, remaining))
      totalChars += content.length
      included.push({ ...item, content, truncated: content.length < source.length })
    } catch (error) {
      skipped.push({ alias: item.alias, reason: errorMessage(error) })
    }
  }
  return { included, skipped }
}

function syntaxCheck(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--check"], {
      stdio: ["pipe", "ignore", "pipe"],
    })
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
    timer.unref?.()
    child.stderr.on("data", (chunk: unknown) => {
      stderr += text(chunk)
      if (stderr.length > 8000) stderr = stderr.slice(0, 8000)
    })
    child.on("error", error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || "生成的 index.js 存在语法错误"))
    })
    child.stdin.end(source)
  })
}

function normalizedGeneratedManifest(generated: UnknownRecord, current: UnknownRecord): UnknownRecord {
  const next = cloneJsonValue(generated)
  const currentFilters = Array.isArray(current.filters) ? current.filters.map(record) : []
  const generatedFilters = Array.isArray(next.filters) ? next.filters.map(record) : []
  if (!generatedFilters.length) throw new Error("项目 AI 没有返回 filters[] 定义")
  next.id = current.id
  next.enabled = current.enabled !== false
  next.frameworkResources = cloneJsonValue(current.frameworkResources || {})
  next.filters = [{
    ...generatedFilters[0],
    id: text(currentFilters[0]?.id || generatedFilters[0].id),
    stages: cloneJsonValue(currentFilters[0]?.stages || generatedFilters[0].stages),
    effects: cloneJsonValue(currentFilters[0]?.effects || generatedFilters[0].effects || ["pure"]),
  }, ...cloneJsonValue(currentFilters.slice(1))]
  return next
}

export interface ParsedFilterDraft {
  manifest: UnknownRecord
  source: string
  notes: string
  validation: CustomFilterValidation
}

export function parseGeneratedFilterDraft(value: unknown, currentManifest: unknown = {}): ParsedFilterDraft {
  const current = record(currentManifest)
  const manifestText = stripCodeFence(taggedSection(value, "FILTER_MANIFEST"))
  const source = stripCodeFence(taggedSection(value, "FILTER_SOURCE"))
  const notes = taggedSection(value, "FILTER_NOTES")
  if (!manifestText || !source) throw new Error("项目 AI 返回格式不完整，请重试并补充更明确的需求")
  let generated: UnknownRecord
  try {
    const parsed: unknown = JSON.parse(manifestText)
    if (!isRecord(parsed)) throw new Error("根值必须是对象")
    generated = parsed
  } catch (error) {
    throw new Error(`项目 AI 返回的 filter.json 无法解析：${errorMessage(error)}`)
  }
  if (source.length > MAX_GENERATED_SOURCE_CHARS) throw new Error("项目 AI 返回的 index.js 过长")
  const manifest = normalizedGeneratedManifest(generated, current)
  const validation = validateCustomFilterManifest(manifest)
  if (!validation.ok) {
    const first = validation.errors[0]
    throw new Error(`项目 AI 返回的 filter.json 校验失败：${first?.path || "manifest"} ${first?.message || ""}`.trim())
  }
  return { manifest, source, notes, validation }
}

export function buildFilterAuthoringPrompt(payload: UnknownRecord = {}, resources: ResourceContext = { included: [], skipped: [] }): string {
  const requirement = text(payload.requirement).trim().slice(0, MAX_REQUIREMENT_CHARS)
  if (!requirement) throw new Error("请描述希望过滤器完成的处理")
  const manifest = cloneJsonValue(record(payload.manifest))
  const currentSource = text(payload.source).slice(0, MAX_CURRENT_SOURCE_CHARS)
  const resourceText = resources.included.map(item => [
    `### 资源别名：${item.alias}`,
    `引用：${item.scope === "plugin" ? `plugin:${item.plugin}/${item.path}` : `yunzai:${item.path}`}`,
    "```",
    item.content,
    "```",
  ].join("\n")).join("\n\n")
  return [
    "管理员希望生成或修改一个 Yui Chat Custom Filter。",
    `需求：\n${requirement}`,
    `当前 filter.json：\n${JSON.stringify(manifest, null, 2)}`,
    `当前 index.js：\n\`\`\`javascript\n${currentSource}\n\`\`\``,
    resourceText ? `已明确授权作为参考的框架资源：\n${resourceText}` : "本次没有提供框架资源正文。",
    "请保持包 ID、过滤器 ID、stages、effects 和 frameworkResources 不变；可以完善名称、说明、parameters、configSchema 和实现。",
  ].join("\n\n")
}

const SYSTEM_PROMPT = `你是 Yui Chat 的 Custom Filter 代码生成器。
只生成确定性 JavaScript 过滤器，不得生成 AI Tool、Skill、MCP 或大模型调用。
正文从 apply({ text, params }, context) 的 text 获取；运行变量从 context.filterConfig 获取。
只允许通过 createFilters({ framework }) 中的 framework.use/readText/readJson/importModule 使用已声明资源。
不得拼接绝对路径，不得读取环境变量、配置密钥或未声明文件，不得写文件或启动子进程。
返回一个包、一个主过滤器；index.js 使用 ESM 并导出 createFilters。
必须严格使用以下格式，不要添加格式外内容：
<FILTER_MANIFEST>
合法 JSON
</FILTER_MANIFEST>
<FILTER_SOURCE>
合法 JavaScript 模块源码
</FILTER_SOURCE>
<FILTER_NOTES>
用简短中文说明生成内容和需要管理员检查的风险
</FILTER_NOTES>`

/** 使用隔离模型生成 Custom Filter 草稿；动态源码只在最终校验后交给用户确认。 */
export async function generateCustomFilterDraft(payload: UnknownRecord = {}, context: FilterAuthoringContext = {}): Promise<UnknownRecord> {
  const manifest = cloneJsonValue(record(payload.manifest))
  const baseValidation = validateCustomFilterManifest(manifest)
  if (!baseValidation.ok) {
    const first = baseValidation.errors[0]
    throw new Error(`请先修正当前 filter.json：${first?.path || "manifest"} ${first?.message || ""}`.trim())
  }
  const resources = await resourceContext(manifest)
  const prompt = buildFilterAuthoringPrompt(payload, resources)
  const model = await runIsolatedModelTask({
    prompt,
    systemPrompt: SYSTEM_PROMPT,
    taskName: text(payload.taskName),
    channelId: text(payload.channelId),
    event: context.event,
    timeoutMs: Number(payload.timeoutMs) || undefined,
    maxTokens: Number(payload.maxTokens) || 4096,
  })
  const draft = parseGeneratedFilterDraft(model.text, manifest)
  await syntaxCheck(draft.source)
  return {
    ...draft,
    model: {
      channel: model.channel,
      adapter: model.adapter,
      task: model.task,
      usage: model.usage,
    },
    resources: {
      included: resources.included.map(({ content: _content, ...item }) => item),
      skipped: resources.skipped,
    },
  }
}
