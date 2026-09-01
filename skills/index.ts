import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { configStore } from "../config/store.js"
import { createUserExtensionStorage } from "../extensions/storage.js"
import { maskToolRuntimeConfig, resolveToolRuntimeConfig } from "../extensions/runtime-config.js"
import { deriveExtensionId } from "../core/shared/identifiers.js"

type AnyRecord = Record<string, any>
type SkillIssue = { path: string; message: string; level?: "error" | "warn" }
type SkillValidation = { ok: boolean; errors: SkillIssue[]; warnings: SkillIssue[]; issues: SkillIssue[] }
type SkillMetadata = AnyRecord & { name: string; description: string }
type SkillItem = AnyRecord & {
  id: string
  dir: string
  skillFile: string
  name: string
  description: string
  body: string
  enabled: boolean
  validation: SkillValidation
  metadata?: SkillMetadata
  error?: string
}
type SkillCatalogItem = AnyRecord & { id: string; name: string; description: string; enabled: boolean }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : ""
}

function record(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {}
}

const skillStorage = createUserExtensionStorage({
  domain: "skills",
  manifestFile: "SKILL.md",
})
export const skillsDir = skillStorage.dir

const STOP_TERMS = new Set([
  "skill", "skills", "use", "when", "with", "from", "this", "that", "your", "into", "for",
  "用户", "使用", "需要", "可以", "这个", "进行", "任务", "帮助", "适合", "能力", "工作流",
])

function sanitizeSkillId(value: unknown = ""): string {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)
}

async function createSkillDir(dir: string, id: string): Promise<void> {
  try { await fs.mkdir(dir) } catch (err) {
    if (errorCode(err) === "EEXIST") throw new Error(`Skill name “${id}” 已存在`)
    throw err
  }
}

function normalizeRepoUrl(value: unknown = ""): string {
  const raw = String(value || "").trim()
  if (!raw) throw new Error("repo is required")
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}.git`
  if (/^https:\/\/.+/.test(raw)) {
    const url = new URL(raw)
    if (url.username || url.password) throw new Error("repo URL 不允许内嵌用户名或凭证")
    return raw
  }
  if (/^git@[\w.-]+:.+/.test(raw)) return raw
  throw new Error("repo 必须是 HTTPS/SSH Git 地址或 owner/repo；不允许 file:// 和明文 HTTP")
}

function repoNameFromUrl(value: unknown = ""): string {
  const clean = String(value || "").trim().replace(/[#?].*$/, "").replace(/\.git$/, "")
  return sanitizeSkillId(clean.split(/[/:]/).filter(Boolean).pop() || "remote-skill")
}

function runGit(args: string[] = [], opts: AnyRecord = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => { stdout += String(chunk) })
    child.stderr.on("data", chunk => { stderr += String(chunk) })
    child.on("error", reject)
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error((stderr || stdout || `git exited with ${code}`).trim()))
    })
  })
}

function validationResult(errors: SkillIssue[] = [], warnings: SkillIssue[] = []): SkillValidation {
  const issues: SkillIssue[] = [
    ...errors.map(item => ({ level: "error" as const, ...item })),
    ...warnings.map(item => ({ level: "warn" as const, ...item })),
  ]
  return { ok: errors.length === 0, errors, warnings, issues }
}

export function parseSkillMarkdown(source = "", opts: AnyRecord = {}): { metadata: SkillMetadata; body: string; validation: SkillValidation } {
  const text = String(source || "").replace(/^\uFEFF/, "")
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/)
  if (!match) throw new Error(`${opts.file || "SKILL.md"}: 缺少 YAML frontmatter`)
  let metadata
  try {
    metadata = record(parseYaml(match[1]))
  } catch (err) {
    throw new Error(`${opts.file || "SKILL.md"}: YAML 解析失败：${errorMessage(err)}`)
  }
  const errors: SkillIssue[] = []
  const name = String(metadata.name || "").trim()
  const description = String(metadata.description || "").trim()
  if (!name) errors.push({ path: "name", message: "name 不能为空" })
  if (!description) errors.push({ path: "description", message: "description 不能为空" })
  if (name && (!/^[a-z0-9-]+$/.test(name) || name.length > 64)) {
    errors.push({ path: "name", message: "name 只能使用小写字母、数字和横线，且不超过 64 个字符" })
  }
  const validation = validationResult(errors)
  return {
    metadata: { ...metadata, name, description },
    body: match[2].trim(),
    validation,
  }
}

export function formatSkillMarkdown(metadata: AnyRecord = {}, body = ""): string {
  const { name, description, ...extra } = metadata && typeof metadata === "object" ? metadata : {}
  const frontmatter = stringifyYaml({
    name: String(name || "").trim(),
    description: String(description || "").trim(),
    ...extra,
  }, { lineWidth: 0 }).trim()
  return `---\n${frontmatter}\n---\n\n${String(body || "").trim()}\n`
}

function promptTerms(value: unknown = ""): string[] {
  const lower = String(value || "").toLowerCase()
  const terms = new Set((lower.match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter(term => !STOP_TERMS.has(term)))
  for (const chunk of lower.match(/[\p{Script=Han}]{2,}/gu) || []) {
    if (!STOP_TERMS.has(chunk)) terms.add(chunk)
    const max = Math.min(4, chunk.length)
    for (let size = 2; size <= max; size++) {
      for (let index = 0; index <= chunk.length - size; index++) {
        const term = chunk.slice(index, index + size)
        if (!STOP_TERMS.has(term)) terms.add(term)
      }
    }
  }
  return [...terms]
}

async function countFiles(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    let count = 0
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      count += entry.isDirectory() ? await countFiles(path.join(dir, entry.name)) : 1
    }
    return count
  } catch {
    return 0
  }
}

function roleForEvent(e: AnyRecord = {}): keyof typeof ROLE_RANK {
  if (e.isMaster) return "master"
  if (e.sender?.role === "owner") return "groupOwner"
  if (e.sender?.role === "admin") return "groupAdmin"
  return "user"
}

const ROLE_RANK = { user: 0, groupAdmin: 1, groupOwner: 2, master: 3 }

class SkillManager {
  catalog: SkillCatalogItem[] = []
  errors: AnyRecord[] = []

  async ensureDir() {
    await skillStorage.ensure()
  }

  skillPaths(skillId: unknown): { id: string; dir: string; skillFile: string; agentsFile: string } {
    const id = sanitizeSkillId(skillId)
    if (!id) throw new Error("skillId is required")
    const dir = skillStorage.packageDir(id)
    return {
      id,
      dir,
      skillFile: path.join(dir, "SKILL.md"),
      agentsFile: path.join(dir, "agents", "openai.yaml"),
    }
  }

  async disabledSet() {
    const config = await configStore.load() as unknown as AnyRecord
    return new Set((record(config.skills).disabled || []).map(String))
  }

  async sourceMap() {
    const config = await configStore.load() as unknown as AnyRecord
    const sources = record(config.skills).sources
    return sources
  }

  async listSkills() {
    await this.ensureDir()
    const disabled = await this.disabledSet()
    const sources = await this.sourceMap()
    const entries = await fs.readdir(skillsDir, { withFileTypes: true })
    const skills: SkillItem[] = []
    const errors: AnyRecord[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const id = sanitizeSkillId(entry.name)
      const dir = path.join(skillsDir, entry.name)
      const skillFile = path.join(dir, "SKILL.md")
      try {
        const source = await fs.readFile(skillFile, "utf8")
        const parsed = parseSkillMarkdown(source, { file: skillFile })
        const item: SkillItem = {
          id,
          dir,
          skillFile,
          name: parsed.metadata.name,
          description: parsed.metadata.description,
          metadata: parsed.metadata,
          body: parsed.body,
          enabled: !disabled.has(id),
          validation: parsed.validation,
          resources: {
            scripts: await countFiles(path.join(dir, "scripts")),
            references: await countFiles(path.join(dir, "references")),
            assets: await countFiles(path.join(dir, "assets")),
          },
        }
        skills.push(item)
        if (!parsed.validation.ok) errors.push({ skill: id, error: "SKILL.md validation failed", validation: parsed.validation })
      } catch (err) {
        const message = errorMessage(err)
        const validation = validationResult([{ path: "SKILL.md", message }])
        skills.push({ id, dir, skillFile, name: id, description: "", body: "", enabled: false, validation, error: message, resources: { scripts: 0, references: 0, assets: 0 } })
        errors.push({ skill: id, error: message, validation })
      }
    }
    this.catalog = skills.map(item => ({
      id: item.id,
      name: item.name || item.id,
      description: item.description || "",
      descriptionZh: item.description || "",
      enabled: item.enabled,
      validation: item.validation,
      error: item.error,
      resources: item.resources,
      bodyChars: item.body?.length || 0,
      skillFile: item.skillFile,
      format: "openai-skill-md",
      tools: [],
      remote: sources[item.id] || null,
      configSchema: item.metadata?.configSchema || { type: "object", properties: {} },
      runtimeConfig: maskToolRuntimeConfig({ name: item.id, configSchema: item.metadata?.configSchema }, record(record(configStore.get() as unknown as AnyRecord).skills).runtimeVariables?.[item.id]),
    }))
    this.errors = errors
    return skills
  }

  async refresh() {
    return this.listSkills()
  }

  allowedByPackage(skill: SkillItem, e: AnyRecord, config: AnyRecord): boolean {
    const boundary = record(config.tools).boundaryAccess as AnyRecord
    if (boundary?.enabled === false) return true
    const override = boundary?.skillPackages?.[skill.id]
    if (override?.enabled === false) return false
    if (!override?.minRole) return true
    const minimumRole = String(override.minRole) as keyof typeof ROLE_RANK
    return (ROLE_RANK[roleForEvent(e)] ?? 0) >= (ROLE_RANK[minimumRole] ?? 0)
  }

  matchScore(skill: SkillItem, prompt = ""): number {
    const normalized = String(prompt || "").toLowerCase()
    if (!normalized) return 0
    const aliases = [skill.id, skill.name].filter(Boolean).map(value => String(value).toLowerCase())
    if (aliases.some(name => normalized.includes(`$${name}`) || normalized.includes(`@${name}`))) return 1000
    let score = aliases.some(name => name.length >= 3 && normalized.includes(name)) ? 20 : 0
    const descriptionTerms = new Set(promptTerms(skill.description))
    for (const term of promptTerms(normalized)) {
      if (!descriptionTerms.has(term)) continue
      score += /[\p{Script=Han}]/u.test(term) ? Math.min(6, term.length) : 2
    }
    return score
  }

  async buildPrompt(prompt = "", opts: AnyRecord = {}): Promise<string> {
    const config = opts.config || await configStore.load() as unknown as AnyRecord
    const skills = (await this.listSkills()).filter(item => item.enabled && item.validation?.ok && this.allowedByPackage(item, opts.e, config))
    if (!skills.length) return ""
    const catalog = skills.map(item => `- $${item.name}: ${item.description} (路径: ${item.skillFile})`).join("\n")
    const selected = skills
      .map(item => ({ item, score: this.matchScore(item, prompt) }))
      .filter(row => row.score >= 4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(row => row.item)
    const selectedText = selected.map(item => {
      const schema = item.metadata?.configSchema || {}
      const runtimeConfig = resolveToolRuntimeConfig({ name: item.id, configSchema: schema }, { tools: { runtimeVariables: config.skills?.runtimeVariables || {} } })
      // 白名单注入：只有 schema 显式声明、且非 secret、未标记 exposeToModel:false 的变量才进 prompt。
      const exposedConfig = Object.fromEntries(Object.entries(runtimeConfig).filter(([name]) => {
        const field = schema.properties?.[name]
        return field && field.secret !== true && field.exposeToModel !== false
      }))
      return [
      `<skill name="${item.name}" path="${item.skillFile}">`,
      Object.keys(exposedConfig).length ? `<skill-config>${JSON.stringify(exposedConfig)}</skill-config>` : "",
      item.body.slice(0, 12000),
      "</skill>",
      ].filter(Boolean).join("\n")
    }).join("\n\n")
    return [
      "可用 Skills（用户可用 $skill-name 显式调用；也可根据 description 自动匹配）：",
      catalog,
      selectedText ? `\n本轮已加载的 Skill 完整指令：\n${selectedText}` : "",
    ].filter(Boolean).join("\n")
  }
}

export const skillManager = new SkillManager()

export function listSkills() {
  return skillManager.listSkills()
}

export async function createSkillTemplate(skillId = "my-skill", opts: AnyRecord = {}): Promise<AnyRecord> {
  const id = sanitizeSkillId(skillId) || "my-skill"
  const metadata = {
    name: id,
    description: `当用户明确调用 $${id}，或请求与 ${id} 工作流直接相关的任务时使用。`,
  }
  const body = `# ${id}\n\n按照以下步骤完成任务：\n\n1. 确认用户目标和必要输入。\n2. 使用项目现有能力执行任务。\n3. 给出清晰结果，并说明无法完成的部分。`
  // dryRun 只返回模板内容，让控制台先在草稿里编辑，真正保存时才落盘。
  if (opts.dryRun) return { id, metadata, body }
  const { dir, skillFile } = skillManager.skillPaths(id)
  await skillManager.ensureDir()
  await createSkillDir(dir, id)
  await fs.writeFile(skillFile, formatSkillMarkdown(metadata, body), "utf8")
  return { id, skillFile, metadata, body }
}

// 新建：目录 ID 由 SKILL.md 自身特征推导，控制台不需要也不展示它。
export async function createSkillPackage(payload: AnyRecord = {}): Promise<AnyRecord> {
  const manifest = record(payload.manifest)
  await skillManager.ensureDir()
  const metadata = { ...manifest }
  delete metadata.id
  delete metadata.enabled
  delete metadata.descriptionZh
  metadata.name = sanitizeSkillId(manifest.name || payload.name || "")
  metadata.description = String(manifest.description || manifest.descriptionZh || payload.description || "").trim()
  const used = (await listSkills()).map(item => item.id)
  const id = deriveExtensionId([metadata.name, manifest.displayNameZh], "skill", used)
  metadata.name ||= id
  const body = typeof payload.source === "string" ? payload.source : typeof payload.body === "string" ? payload.body : ""
  const markdown = formatSkillMarkdown(metadata, body)
  const validation = parseSkillMarkdown(markdown).validation
  if (!validation.ok) throw new Error(validation.errors[0]?.message || "SKILL.md validation failed")
  const { dir, skillFile } = skillManager.skillPaths(id)
  await createSkillDir(dir, id)
  await fs.writeFile(skillFile, markdown, "utf8")
  if (manifest.enabled === false) await setSkillEnabled(id, false)
  await skillManager.refresh()
  return getSkillPackage(id)
}

export async function installRemoteSkill(payload: AnyRecord = {}): Promise<AnyRecord> {
  await skillManager.ensureDir()
  const repo = normalizeRepoUrl(payload.repo || payload.url || payload.repository)
  const ref = String(payload.ref || payload.branch || "").trim()
  const subdir = String(payload.subdir || "").trim().replace(/^\/+|\/+$/g, "")
  const fallbackId = repoNameFromUrl(repo)
  const overwrite = payload.overwrite === true
  const tmpRoot = await (fs as any).mkdtemp(path.join(os.tmpdir(), "yui-chat-skill-")) as string
  const cloneDir = path.join(tmpRoot, "repo")
  try {
    const args = ["clone", "--depth", "1"]
    if (ref) args.push("--branch", ref)
    args.push(repo, cloneDir)
    await runGit(args)
    const sourceDir = subdir ? path.resolve(cloneDir, subdir) : cloneDir
    const relativeSource = path.relative(cloneDir, sourceDir)
    if (relativeSource.startsWith("..") || path.isAbsolute(relativeSource)) throw new Error("subdir 必须位于仓库目录内")
    const sourceFile = path.join(sourceDir, "SKILL.md")
    const parsed = parseSkillMarkdown(await fs.readFile(sourceFile, "utf8"), { file: sourceFile })
    if (!parsed.validation.ok) throw new Error(parsed.validation.errors[0]?.message || "SKILL.md validation failed")
    const id = sanitizeSkillId(payload.skillId || payload.id || parsed.metadata.name || fallbackId) || fallbackId
    const target = skillManager.skillPaths(id)
    try {
      await fs.access(target.dir)
      if (!overwrite) throw new Error(`Skill ${id} already exists`)
      await fs.rm(target.dir, { recursive: true, force: true })
    } catch (err) {
      if (errorCode(err) !== "ENOENT") throw err
    }
    await fs.mkdir(target.dir, { recursive: true })
    await fs.cp(sourceDir, target.dir, { recursive: true, force: true, filter: (source: string) => !source.split(path.sep).includes(".git") } as any)
    await configStore.update(config => {
      const draft = config as unknown as AnyRecord
      const skills = record(draft.skills)
      draft.skills = {
        ...skills,
        sources: {
          ...record(skills.sources),
          [id]: { repo, ref, subdir },
        },
      }
    })
    await skillManager.refresh()
    return { id, repo, ref, subdir, skillFile: target.skillFile, metadata: parsed.metadata }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export async function updateRemoteSkill(skillId: unknown): Promise<AnyRecord> {
  const id = sanitizeSkillId(skillId)
  const source = (await skillManager.sourceMap())[id]
  if (!source?.repo) throw new Error(`Skill ${id} 没有远程来源记录，请重新安装并覆盖同名`)
  return installRemoteSkill({ ...source, skillId: id, overwrite: true })
}

export async function setSkillEnabled(skillId: unknown, enabled: unknown): Promise<AnyRecord> {
  const { id, skillFile } = skillManager.skillPaths(skillId)
  await fs.access(skillFile)
  await configStore.update(config => {
    const draft = config as unknown as AnyRecord
    const skills = record(draft.skills)
    const disabled = new Set((skills.disabled || []).map(String))
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    draft.skills = { ...skills, disabled: [...disabled].sort() }
  })
  await skillManager.refresh()
  return { id, enabled: Boolean(enabled) }
}

export async function getSkillPackage(skillId: unknown): Promise<AnyRecord> {
  const { id, dir, skillFile } = skillManager.skillPaths(skillId)
  const source = await fs.readFile(skillFile, "utf8")
  const parsed = parseSkillMarkdown(source, { file: skillFile })
  const disabled = await skillManager.disabledSet()
  return {
    id,
    dir,
    skillFile,
    manifestFile: skillFile,
    indexFile: "",
    manifest: { ...parsed.metadata, id, name: parsed.metadata.name, description: parsed.metadata.description, descriptionZh: parsed.metadata.description, enabled: !disabled.has(id) },
    runtimeConfig: maskToolRuntimeConfig({ name: id, configSchema: parsed.metadata?.configSchema }, record(record(configStore.get() as unknown as AnyRecord).skills).runtimeVariables?.[id]),
    metadata: parsed.metadata,
    source: parsed.body,
    markdown: source,
    validation: parsed.validation,
  }
}

export async function updateSkillPackage(skillId: unknown, payload: AnyRecord = {}): Promise<AnyRecord> {
  const { id, skillFile } = skillManager.skillPaths(skillId)
  const manifest = record(payload.manifest)
  const current = parseSkillMarkdown(await fs.readFile(skillFile, "utf8"), { file: skillFile })
  const metadata: AnyRecord = {
    ...current.metadata,
    ...manifest,
    name: sanitizeSkillId(manifest.name || payload.name || id) || id,
    description: String(manifest.description || manifest.descriptionZh || payload.description || "").trim(),
  }
  delete metadata.id
  delete metadata.enabled
  delete metadata.descriptionZh
  const body = typeof payload.source === "string" ? payload.source : typeof payload.body === "string" ? payload.body : ""
  const validation = parseSkillMarkdown(formatSkillMarkdown(metadata, body)).validation
  if (!validation.ok) throw new Error(validation.errors[0]?.message || "SKILL.md validation failed")
  await fs.writeFile(skillFile, formatSkillMarkdown(metadata, body), "utf8")
  if (manifest.enabled !== undefined) await setSkillEnabled(id, manifest.enabled !== false)
  await skillManager.refresh()
  return getSkillPackage(id)
}

export async function deleteSkillPackage(skillId: unknown): Promise<AnyRecord> {
  const { id, dir } = skillManager.skillPaths(skillId)
  await fs.rm(dir, { recursive: true, force: true })
  await configStore.update(config => {
    const draft = config as unknown as AnyRecord
    const skills = record(draft.skills)
    const sources = { ...record(skills.sources) }
    delete sources[id]
    draft.skills = { ...skills, disabled: (skills.disabled || []).filter((item: unknown) => item !== id), sources }
  })
  await skillManager.refresh()
  return { id, deleted: true }
}
