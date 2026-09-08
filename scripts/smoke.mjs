import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const yunzaiRoot = path.resolve(pluginRoot, "../..")
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
const runtimeRootEnvironmentVariable = "YUI_CHAT_RUNTIME_ROOT"
const smokeRuntimeRootEnvironmentVariable = "YUI_CHAT_SMOKE_RUNTIME_ROOT"
const pluginRootEnvironmentVariable = "YUI_CHAT_PLUGIN_ROOT"
const productionRuntimePaths = {
  configDir: path.join(pluginRoot, "config"),
  dataDir: path.join(yunzaiRoot, "data", "yui-chat"),
  cacheDir: path.join(pluginRoot, "cache"),
}
let smokeRuntimeRoot = ""
let removeSmokeRuntimeRoot = false
let originalRuntimeRootEnvironment
let originalSmokeRuntimeRootEnvironment
let originalPluginRootEnvironment
const tinyPngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
const builtinFilterIds = ["text_transform", "keyword_filter", "regex_replace", "voice_output"]
const retiredPersonaConfigKeys = [
  "systemPrompt",
  "expression",
  "states",
  "stateProbabilityPercent",
  "toolOrchestrationPrompt",
  "groupContextPrompt",
  "commandGuidePrompt",
  "emptyReplyInstruction",
  "innerInstruction",
]
const retiredPersonaOutputConfigKeys = [
  "splitFirstPersonReplies",
  "splitMaxParts",
  "splitMinChars",
  "splitMinPartChars",
  "splitDelayPerCharMs",
  "splitMaxDelayMs",
  "quoteSplitReplies",
]
const retiredContextConfigKeys = ["enabled", "injectRecent", "maxMessages", "injectLimit", "maxMessageChars"]
const retiredSegmentationConfigKeys = ["llmOnly"]
const webServerSourceFiles = [
  "web/http/app.js",
  "web/http/routes/runtime.ts",
  "web/http/routes/configuration.ts",
  "web/http/routes/capabilities/authoring.ts",
  "web/http/routes/capabilities/extensions.ts",
  "web/http/routes/filters/filters.ts",
  "web/http/routes/knowledge.ts",
  "web/http/routes/knowledge/bases.ts",
  "web/http/routes/knowledge/indexing.ts",
  "web/http/routes/filters/message-processing.ts",
  "web/http/routes/observability.ts",
]
const webToolsSourceFiles = [
  "web/client/features/tools/tools-tab.js",
  "web/client/features/tools/tools-list-panel.ts",
  "web/client/features/tools/builtin-category-panel.ts",
  "web/client/features/tools/global-tool-settings-panel.ts",
  "web/client/features/tools/tool-detail-modal.ts",
  "web/client/features/tools/render-panel.ts",
  "web/client/features/tools/system-render-strategy-panel.ts",
  "web/client/features/tools/tool-configuration-panel.ts",
  "web/client/features/tools/extension-panel.js",
  "web/client/features/tools/extension-library-panel.ts",
  "web/client/features/tools/extension-create-drawer.js",
  "web/client/features/tools/extension-editor-drawer.ts",
  "web/client/features/tools/custom-builder.js",
  "web/client/features/tools/mcp-panel.js",
  "web/client/features/tools/permission-panel.js",
  "web/client/features/tools/permission-role-grid.ts",
  "web/client/features/tools/permission-role-drawer.ts",
  "web/client/features/tools/permission-preview-drawer.ts",
  "web/client/features/tools/permission-preview.ts",
  "web/client/features/tools/shared.js",
]
const webFiltersSourceFiles = [
  "web/client/features/filters/filters-tab.js",
  "web/client/features/filters/message-filters-panel.js",
  "web/client/features/filters/custom-panel.js",
  "web/client/features/filters/custom-filter-editor-drawer.ts",
  "web/client/features/filters/custom-builder.js",
]
const webProviderSourceFiles = [
  "web/client/features/providers/providers-tab.js",
  "web/client/features/providers/provider-editors.js",
  "web/client/features/providers/provider-responses-editor.js",
  "web/client/features/providers/provider-tool-policy-editor.js",
  "web/client/features/providers/provider-routing.js",
  "web/client/features/providers/provider-shared.js",
]

process.chdir(yunzaiRoot)

global.logger = {
  mark: console.log,
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug() {},
  blue: value => value,
  cyan: value => value,
  red: value => value,
}
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = {
  at: id => `[at:${id}]`,
  image: value => `[image:${value}]`,
  record: value => `[record:${value}]`,
  video: value => `[video:${value}]`,
  reply: value => `[reply:${value}]`,
}
global.plugin = class {
  constructor(options = {}) {
    this.options = options
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function pathInside(target, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(target))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function pathsOverlap(first, second) {
  return pathInside(first, second) || pathInside(second, first)
}

async function prepareSmokeRuntimeRoot() {
  originalRuntimeRootEnvironment = process.env[runtimeRootEnvironmentVariable]
  originalSmokeRuntimeRootEnvironment = process.env[smokeRuntimeRootEnvironmentVariable]
  originalPluginRootEnvironment = process.env[pluginRootEnvironmentVariable]
  const requestedRoot = String(process.env[smokeRuntimeRootEnvironmentVariable] || "").trim()
  if (requestedRoot) {
    smokeRuntimeRoot = path.resolve(requestedRoot)
  } else {
    smokeRuntimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-smoke-runtime-"))
    removeSmokeRuntimeRoot = true
  }
  for (const productionPath of Object.values(productionRuntimePaths)) {
    if (pathsOverlap(smokeRuntimeRoot, productionPath)) {
      throw new Error(`Smoke 运行目录不能与生产运行目录重叠：${smokeRuntimeRoot}`)
    }
  }
  await fs.mkdir(smokeRuntimeRoot, { recursive: true })
  process.env[runtimeRootEnvironmentVariable] = smokeRuntimeRoot
  process.env[smokeRuntimeRootEnvironmentVariable] = smokeRuntimeRoot
  process.env[pluginRootEnvironmentVariable] = pluginRoot
}

async function cleanupSmokeRuntimeRoot() {
  try {
    if (removeSmokeRuntimeRoot && smokeRuntimeRoot) {
      await fs.rm(smokeRuntimeRoot, { recursive: true, force: true })
    }
  } finally {
    if (originalRuntimeRootEnvironment === undefined) delete process.env[runtimeRootEnvironmentVariable]
    else process.env[runtimeRootEnvironmentVariable] = originalRuntimeRootEnvironment
    if (originalSmokeRuntimeRootEnvironment === undefined) delete process.env[smokeRuntimeRootEnvironmentVariable]
    else process.env[smokeRuntimeRootEnvironmentVariable] = originalSmokeRuntimeRootEnvironment
    if (originalPluginRootEnvironment === undefined) delete process.env[pluginRootEnvironmentVariable]
    else process.env[pluginRootEnvironmentVariable] = originalPluginRootEnvironment
  }
}

async function ensureRuntimeBuild() {
  const compiledEntry = path.join(pluginRoot, "output", "runtime", "runtime-entry.js")
  try {
    await fs.access(compiledEntry)
  } catch {
    await run(npmCommand, ["run", "build:runtime"], { cwd: pluginRoot, stdio: "inherit" })
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readWebServerSource() {
  return (await Promise.all(webServerSourceFiles.map(readSource))).join("\n")
}

async function readWebToolsSource() {
  return (await Promise.all(webToolsSourceFiles.map(readSource))).join("\n")
}

async function readWebFiltersSource() {
  return (await Promise.all(webFiltersSourceFiles.map(readSource))).join("\n")
}

async function readWebProviderSource() {
  return (await Promise.all(webProviderSourceFiles.map(readSource))).join("\n")
}

async function readSource(relative) {
  const sourcePath = path.join(pluginRoot, relative)
  if (relative.endsWith(".js")) {
    const typescriptPath = sourcePath.replace(/\.js$/u, ".ts")
    try {
      return await fs.readFile(typescriptPath, "utf8")
    } catch {
      // 只有宿主入口、用户动态扩展和第三方资源保留 JS；插件业务源码统一以 TS 为准。
    }
  }
  return fs.readFile(sourcePath, "utf8")
}

async function files(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "output") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await files(full, out)
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full)
  }
  return out
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || yunzaiRoot,
      stdio: options.stdio || "pipe",
      env: { ...process.env, ...(options.env || {}) },
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", data => { stdout += data })
    child.stderr?.on("data", data => { stderr += data })
    child.on("error", reject)
    child.on("close", code => {
      if (code === 0 || options.allowFailure) resolve({ code, stdout, stderr })
      else reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stdout}\n${stderr}`))
    })
  })
}

async function checkSyntax() {
  for (const file of await files(pluginRoot)) {
    await run("node", ["--check", file])
  }
}

async function checkRuntimeIsolation() {
  const { cacheDir, configBackupDir, configDir, configFile, dataDir, runtimeRoot, tempDir } = await import("../output/runtime/config/store.js")
  assert(runtimeRoot === smokeRuntimeRoot, "config store should use the smoke runtime root")
  assert(configDir === path.join(smokeRuntimeRoot, "config"), "smoke config directory should stay under the runtime root")
  assert(configFile === path.join(configDir, "config.json"), "smoke config file should stay under the isolated config directory")
  assert(dataDir === path.join(smokeRuntimeRoot, "data", "yui-chat"), "smoke data should stay under the runtime root")
  assert(configBackupDir === path.join(dataDir, "backups"), "smoke config backups should stay under the isolated data directory")
  assert(cacheDir === path.join(smokeRuntimeRoot, "cache"), "smoke cache should stay under the runtime root")
  assert(tempDir === path.join(cacheDir, "temp"), "smoke temporary files should stay under the isolated cache")
  for (const [name, runtimePath] of Object.entries({ configDir, configFile, configBackupDir, dataDir, cacheDir, tempDir })) {
    assert(pathInside(runtimePath, smokeRuntimeRoot), `${name} must stay inside the smoke runtime root`)
    assert(!Object.values(productionRuntimePaths).some(productionPath => pathsOverlap(runtimePath, productionPath)), `${name} must not overlap a production runtime path`)
  }

  const defaultPathProbe = await run("node", [
    "--input-type=module",
    "--eval",
    "import('./output/runtime/config/store.js').then(({ cacheDir, configDir, dataDir, runtimeRoot }) => process.stdout.write(JSON.stringify({ cacheDir, configDir, dataDir, runtimeRoot })))",
  ], {
    cwd: pluginRoot,
    env: { [runtimeRootEnvironmentVariable]: "", YUI_CHAT_PLUGIN_ROOT: pluginRoot },
  })
  const defaults = JSON.parse(defaultPathProbe.stdout)
  assert(defaults.runtimeRoot === "", "production runtime root should remain disabled when the environment variable is absent")
  assert(defaults.configDir === productionRuntimePaths.configDir, "production config directory should keep its original default")
  assert(defaults.dataDir === productionRuntimePaths.dataDir, "production data directory should keep its original default")
  assert(defaults.cacheDir === productionRuntimePaths.cacheDir, "production cache directory should keep its original default")
}

async function checkConfigSafety() {
  const { cacheDir, configBackupDir, configDir, configFile, configStore, dataDir, extractConfigOverrides, pluginRoot, redactConfigSecrets, runtimeRoot, tempDir, yunzaiRoot } = await import("../output/runtime/config/store.js")
  const { defaults, defaultPersonaRuntimePrompt } = await import("../output/runtime/config/defaults.js")
  const { getSchemaManifest, schema, schemaManifest } = await import("../output/runtime/config/schema.js")
  const { assertConfigValid, validateConfig } = await import("../output/runtime/config/validator.js")
  const { composePersonaSystemPrompt } = await import("../output/runtime/core/persona/prompt-composer.js")
  const config = await configStore.load()
  assert(config.web?.mountPath === "/yui-chat", "web.mountPath should default to /yui-chat")
  assert(config.web?.authToken === "", "web.authToken should default empty so static login stays disabled")
  assert(!("allowLocalhostQuickLogin" in config.web), "obsolete localhost auth bypass must be removed")
  assert(config.web?.loginInGroup === false, "loginInGroup must default false")
  assert(config.system?.backups?.maxFiles === 3, "backup retention should protect at least 3 packages by default")
  assert(config.system?.backups?.maxAgeDays === 30, "backup retention should protect packages for at least 30 days by default")
  const localOverrides = JSON.parse(await fs.readFile(configFile, "utf8"))
  assert(JSON.stringify(localOverrides) === JSON.stringify(extractConfigOverrides(config)), "config.json should persist only local overrides")
  assert(!localOverrides.web && !localOverrides.logging && !localOverrides.system, "default-only config should not persist an automatically generated Web credential")
  assert(config.security?.linkSafety?.allowPrivateHosts === true, "all user URL private-host access should default open in the centralized policy")
  assert(config.security?.linkSafety?.trustedPrivateDnsBypass === true, "trusted private-DNS bypass should default open in the centralized policy")
  assert(!("allowPrivateHosts" in config.mediaRecognition.remoteFetch), "media recognition must not keep a separate private-host switch")
  assert(defaults.mediaRecognition?.recognitionModel === "", "media recognition model should default to auto")
  assert(!("allowPrivateHosts" in config.tools.builtin.websiteFetch), "website fetch must not keep a separate private-host switch")
  assert(config.tools?.enabledTools?.includes("knowledge_manage"), "core preset should expose knowledge_manage")
  assert(config.tools?.enabledTools?.includes("schedule_task"), "core preset should backfill schedule_task for existing configs")
  assert(config.tools?.enabledTools?.includes("image_media"), "core preset should backfill image_media for existing configs")
  assert(config.tools?.enabledTools?.includes("web_search"), "core preset should expose the unified real-time web search tool")
  assert(config.tools?.enabledTools?.includes("file_search") && config.tools?.enabledTools?.includes("tool_search"), "hosted and local search capabilities should share the global capability gate")
  assert(config.tools?.enabledTools?.includes("bilibili_media") && !config.tools?.enabledTools?.includes("bilibili_search"), "core preset should use only the new Bilibili media tool name")
  assert(config.tools?.enabledTools?.includes("dispatch_subagent"), "core preset should backfill dispatch_subagent for existing configs")
  assert(!builtinFilterIds.some(id => config.tools?.enabledTools?.includes(id)), "built-in code filters must not stay coupled to tools.enabledTools")
  assert(Array.isArray(config.response?.messageFilters?.filters), "message filters should default to an empty array")
  assert(!("messageProcessing" in config.response), "retired message processor configuration must be discarded")
  assert(config.response.messageFilters.filters.every(filter => filter?.implementation?.type === "filter" && !("action" in filter)), "message filters should use only the native implementation contract")
  assert(config.tools?.builtin?.scheduleTask?.maxPerUser === 1, "schedule task max per user should default to old plugin limit")
  assert(config.tools?.builtin?.scheduleTask?.cronMaxPerUser === 1, "schedule cron max per user should default to old plugin limit")
  assert(config.tools?.builtin?.imageSearch?.maxResults <= 5, "image search should default to compact result count")
  assert(config.tools?.builtin?.imageSearch?.enabledSources?.includes("pixiv") && config.tools.builtin.imageSearch.pixivR18 === false, "image search should expose Pixiv with the R18 gate closed by default")
  assert(config.tools?.builtin?.imageSearch?.cacheSelectedImages === false, "image_media should send original image URLs unless local caching is explicitly enabled")
  assert(config.tools?.builtin?.webSearch?.enabledSources?.join(",") === "baidu-ai,tavily", "web search should expose configurable Baidu AI and Tavily channels")
  assert(config.tools?.builtin?.toolSearch?.localEnabled === true, "tool search should expose its local Registry implementation separately from the hosted implementation")
  assert(config.tools?.boundaryAccess?.enabled === true, "boundary access should default enabled")
  assert(config.tools?.boundaryAccess?.roles?.groupOwner, "boundary access should expose group owner role")
  assert(Array.isArray(config.tools?.boundaryAccess?.roles?.user?.deniedTools), "boundary access roles should expose explicit deny exceptions")
  const redacted = redactConfigSecrets({
    apiKey: "api-secret",
    headers: { Authorization: "Bearer secret", "x-trace-id": "trace-value" },
    env: { OPENAI_API_KEY: "env-secret", GITHUB_TOKEN: "token-secret", REGION: "cn-test" },
    tokens: ["one", "two"],
    maxTokens: 1024,
  })
  assert(redacted.apiKey === "********", "public config should redact camel-case API keys")
  assert(redacted.headers.Authorization === "********", "public config should redact authorization headers")
  assert(redacted.env.OPENAI_API_KEY === "********" && redacted.env.GITHUB_TOKEN === "********", "public config should redact env-style keys and tokens")
  assert(redacted.tokens.every(value => value === "********"), "public config should redact secret arrays using their parent key")
  assert(redacted.headers["x-trace-id"] === "trace-value" && redacted.env.REGION === "cn-test" && redacted.maxTokens === 1024, "public config should preserve non-secret values")
  assert(config.response?.render?.enabled === true, "render service must default enabled")
  assert(config.response?.render?.engine === "html", "image rendering should default to HTML-first priority")
  const unsafeMountPath = JSON.parse(JSON.stringify(config))
  unsafeMountPath.web.mountPath = '/yui-chat"><script>alert(1)</script>'
  assert(!validateConfig(unsafeMountPath).ok, "web.mountPath must reject HTML-significant characters")
  const unsafePublicUrl = JSON.parse(JSON.stringify(config))
  unsafePublicUrl.web.publicBaseUrl = "https://user:secret@example.com"
  assert(!validateConfig(unsafePublicUrl).ok, "Web public URL must reject embedded credentials")
  const ambiguousPublicUrl = JSON.parse(JSON.stringify(config))
  ambiguousPublicUrl.web.publicBaseUrl = "https://bot.example.com/admin?token=wrong#fragment"
  assert(!validateConfig(ambiguousPublicUrl).ok, "Web server prefix must reject query strings and fragments reserved for the quick-login route")
  assert(config.response?.render?.system?.engine === "html", "system image rendering should default to HTML-first priority")
  assert(!Object.hasOwn(config.response?.render || {}, "markdownEngine") && !Object.hasOwn(config.response?.render || {}, "markmapEngine"), "render config should not keep per-template engine settings")
  assert(config.response?.render?.mediaThumbnails === true, "rich chat card media thumbnails must default enabled")
  assert(Number(config.response?.render?.mediaThumbnailMaxCount) >= 1, "media thumbnail max count should be configured")
  assert(config.response?.render?.mediaThumbnail?.enabled === true, "media thumbnail compression must default enabled")
  assert(config.response?.render?.mediaThumbnail?.format === "jpeg", "media thumbnail compression must default to jpeg")
  assert(config.response?.render?.delivery?.allowTargetSend === false, "render cross-target delivery must default false")
  assert(config.response?.render?.delivery?.allowFilePathImages === false, "render local file image delivery must default false")
  assert(!("allowPrivateHosts" in config.response.render.delivery), "media delivery must not keep a separate private-host switch")
  assert(config.response?.render?.html?.enabled === false, "HTML render backend must default disabled")
  assert(!("allowPrivateHosts" in config.response.render.html) && !("allowedUrlHosts" in config.response.render.html), "HTML render config must not keep separate link-safety controls")
  assert(config.security?.linkSafety?.screenshotAllowedHosts?.join(",") === "*", "central URL screenshot host policy should default to all domains")
  assert(config.persona?.trigger?.ambient?.enabled === false, "ambient first-person trigger must default disabled")
  assert(Number(config.persona?.trigger?.ambient?.probabilityPercent) === 10, "ambient persona participation should use its own conservative default probability")
  assert(config.persona?.trigger?.poke?.enabled === true, "poke first-person trigger should default enabled for direct bot pokes")
  assert(config.persona?.trigger?.poke?.respondToBotPoke !== false, "poke first-person trigger should default to bot-target only")
  assert(config.persona?.trigger?.poke?.responseMode === "ai-with-fallback", "poke first-person trigger should default to ai-with-fallback")
  assert(Array.isArray(config.persona?.trigger?.poke?.fallbackMessages), "poke first-person fallback messages should default to an array")
  assert(Number(config.persona?.trigger?.poke?.cooldownMs) >= 0, "poke first-person cooldown should be configured")
  assert(
    typeof config.persona?.characterPrompt === "string"
      && config.persona.characterPrompt.includes("[first_person]")
      && config.persona.characterPrompt.includes("先给结论")
      && config.persona.characterPrompt.includes("不编造")
      && !config.persona.characterPrompt.includes("knowledge_manage")
      && config.persona.runtimePrompt === defaultPersonaRuntimePrompt
      && config.persona.runtimePrompt.includes("使用工具搜索")
      && config.persona.runtimePrompt.includes("诊断时优先只读工具")
      && config.persona.runtimePrompt.includes("本轮有相应能力时必须调用")
      && config.persona.runtimePrompt.includes("不得只口头答应")
      && config.persona.runtimePrompt.includes("不要无理由重复有副作用的操作")
      && config.persona.runtimePrompt.includes("本轮实际提供给模型的图片")
      && config.persona.runtimePrompt.includes("使用可用的消息投递能力")
      && config.persona.runtimePrompt.includes("<EMPTY>")
      && config.persona.runtimePrompt.length < 1000
      && composePersonaSystemPrompt(config.persona.characterPrompt, config.persona.runtimePrompt).includes("【角色设定】")
      && composePersonaSystemPrompt("自定义角色", "自定义运行规则").includes("自定义运行规则"),
    "persona should expose separate configurable character and runtime prompts with one source default",
  )
  assert(retiredPersonaConfigKeys.every(key => !Object.hasOwn(config.persona || {}, key)), "retired persona prompt, expression, and state fields must not remain in defaults")
  assert(retiredPersonaOutputConfigKeys.every(key => !Object.hasOwn(config.persona?.output || {}, key)), "retired first-person split settings must not remain in defaults")
  assert(config.persona?.initiativeGreeting?.enabled === true, "initiative greeting should default enabled for master command")
  assert(config.persona?.initiativeGreeting?.scheduledEnabled === false, "scheduled initiative greeting must default disabled")
  assert(Number(config.persona?.initiativeGreeting?.probabilityPercent) >= 0, "initiative greeting probability should be configured")
  assert(config.context?.recentMessageCount === 20 && config.context.recentMessageCount === defaults.context?.recentMessageCount, "context should default to twenty recent messages for capture and injection")
  assert(config.memory?.groupCapture?.defaultTokenLimit === 30000 && config.memory.groupCapture.defaultTokenLimit === defaults.memory?.groupCapture?.defaultTokenLimit, "group memory input windows should default to thirty thousand tokens")
  assert(config.memory?.groupCapture?.consolidation?.schedule?.mode === "interval" && config.memory.groupCapture.consolidation.schedule.time === "03:00" && config.memory.groupCapture.consolidation.schedule.cron === "0 3 * * *", "group memory consolidation should expose a compatible interval default and friendly time/Cron options")
  assert(retiredContextConfigKeys.every(key => !Object.hasOwn(config.context || {}, key)), "retired context switches and split counts must not remain in defaults")
  assert(retiredSegmentationConfigKeys.every(key => !Object.hasOwn(config.response?.segmentation || {}, key)), "segmentation should not expose a configurable LLM-only switch")
  assert(!Object.hasOwn(config.chat || {}, "promptBudgets"), "retired prompt budget splits must not remain in defaults")
  assert(Array.isArray(config.knowledge?.commandPrefixes) && config.knowledge.commandPrefixes.includes("#"), "knowledge command prefixes should default to command markers")
  assert(config.logging?.level === "info", "conversation logging should default to info")
  assert(config.system?.backups?.maxFiles === 3 && config.system?.backups?.maxAgeDays === 30, "manual config backups should protect at least 3 files and 30 days by default")
  assert(config.memory?.retrieval?.embeddingTokensPerDay === 200000 && config.knowledge?.indexing?.globalEmbeddingTokensPerDay === 2000000, "embedding budgets should have configurable, practical defaults")
  assert(config.mcp?.serverTemplate?.transport === "stdio", "MCP server template should expose the default stdio transport")
  assert(runtimeRoot === smokeRuntimeRoot, "config safety checks must use the isolated smoke runtime root")
  assert(pathInside(configDir, runtimeRoot) && pathInside(configFile, runtimeRoot) && pathInside(configBackupDir, runtimeRoot), "config and backups must stay inside the isolated runtime root")
  assert(pathInside(dataDir, runtimeRoot), "dataDir must stay inside the isolated runtime root")
  assert(pathInside(cacheDir, runtimeRoot), "cacheDir must stay inside the isolated runtime root")
  assert(pathInside(tempDir, cacheDir), "tempDir must stay inside the isolated cache")
  assert(pluginRoot === path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "runtime isolation must not change the source plugin root")
  assert(!await exists(path.join(yunzaiRoot, "temp/yui-chat")), "root temp directory must not be recreated")
  assert(validateConfig(config).ok, "default merged config should validate")
  const runtimeSecrets = redactConfigSecrets({ tools: { runtimeVariables: { weather: { amapKey: "should-hide" }, github_api: { token: "should-hide" } } } })
  assert(runtimeSecrets.tools.runtimeVariables.weather.amapKey === "********" && runtimeSecrets.tools.runtimeVariables.github_api.token === "********", "runtime variable secrets must still be redacted by field name")
  const editableDraft = await configStore.load()
  editableDraft.persona.assistantLabel = "Smoke Local Draft"
  assert(configStore.get().persona.assistantLabel !== "Smoke Local Draft", "load() should return an editable copy instead of shared state")
  assert(Object.isFrozen(configStore.get()) && Object.isFrozen(configStore.get().persona), "get() should expose a deeply frozen read-only snapshot")
  const manifest = getSchemaManifest()
  assert(schemaManifest.summary.fields === schema.reduce((sum, group) => sum + group.fields.length, 0), "schema manifest should summarize field count")
  assert(schemaManifest.summary.advancedFields > 0, "schema manifest should mark advanced fields")
  assert(manifest.tabs.some(tab => tab.id === "setup"), "schema manifest should expose setup tab")
  assert(manifest.sections.some(section => section.group === "Providers"), "schema manifest should expose provider section")
  assert(manifest.sections.some(section => section.fields.some(field => field.path === "web.authToken" && field.sensitive)), "schema manifest should mark auth token sensitive")
  assert(manifest.sections.some(section => section.fields.some(field => field.path === "system.backups.maxFiles")), "schema manifest should expose backup file retention")
  assert(manifest.sections.some(section => section.fields.some(field => field.path === "system.backups.maxAgeDays")), "schema manifest should expose backup age retention")
  assert(manifest.sections.some(section => section.fields.some(field => field.path === "memory.retrieval.embeddingTokensPerDay")), "schema manifest should expose the memory embedding budget")
  assert(manifest.sections.some(section => section.fields.some(field => field.path === "knowledge.indexing.globalEmbeddingTokensPerDay")), "schema manifest should expose the knowledge embedding budget")
  assert(manifest.sections.some(section => section.fields.some(field => field.path === "security.linkSafety.screenshotAllowedHosts")), "schema manifest should expose the centralized URL screenshot host allowlist")
  const contextFieldPaths = manifest.sections.find(section => section.group === "Context")?.fields.map(field => field.path) || []
  assert(contextFieldPaths.includes("context.recentMessageCount") && retiredContextConfigKeys.every(key => !contextFieldPaths.includes(`context.${key}`)), "schema should expose only the unified recent-message count for context capture and injection")
  const fieldIds = manifest.sections.flatMap(section => section.fields.map(field => field.id))
  const fieldPaths = manifest.sections.flatMap(section => section.fields.map(field => field.path))
  assert(["memory.groupCapture.consolidation.schedule.mode", "memory.groupCapture.consolidation.schedule.time", "memory.groupCapture.consolidation.schedule.cron"].every(path => fieldPaths.includes(path)), "schema should expose group memory consolidation schedule controls")
  assert(new Set(fieldIds).size === fieldIds.length, "schema manifest field ids should be unique")
  assert(new Set(fieldPaths).size === fieldPaths.length, "schema manifest field paths should be unique")
  const invalid = JSON.parse(JSON.stringify(config))
  invalid.mediaRecognition.recognitionModel = "missing-model"
  let rejected = false
  try {
    assertConfigValid(invalid)
  } catch {
    rejected = true
  }
  assert(rejected, "invalid media recognition model should be rejected")
  const invalidKnowledge = JSON.parse(JSON.stringify(config))
  invalidKnowledge.knowledge.commandPrefixes = []
  assert(!validateConfig(invalidKnowledge).ok, "empty command prefixes should be rejected")
  const invalidLogging = JSON.parse(JSON.stringify(config))
  invalidLogging.logging.level = "verbose"
  assert(!validateConfig(invalidLogging).ok, "unsupported conversation log level should be rejected")
  const invalidStaticWebToken = JSON.parse(JSON.stringify(config))
  invalidStaticWebToken.web.authToken = "short"
  assert(!validateConfig(invalidStaticWebToken).ok, "non-empty static Web token should enforce the configured minimum length")
  const invalidBackupLimit = JSON.parse(JSON.stringify(config))
  invalidBackupLimit.system.backups.maxFiles = 0
  assert(!validateConfig(invalidBackupLimit).ok, "backup file retention must reject values below three")
  const invalidRecentMessageCount = JSON.parse(JSON.stringify(config))
  invalidRecentMessageCount.context.recentMessageCount = 1.5
  assert(!validateConfig(invalidRecentMessageCount).ok, "recent message count must be an integer")
  invalidRecentMessageCount.context.recentMessageCount = 1001
  assert(!validateConfig(invalidRecentMessageCount).ok, "recent message count must stay within the configured upper bound")
  const fractionalBackupAge = JSON.parse(JSON.stringify(config))
  fractionalBackupAge.system.backups.maxAgeDays = 30.5
  assert(!validateConfig(fractionalBackupAge).ok, "backup age retention must reject fractional days")
  const invalidRenderHosts = JSON.parse(JSON.stringify(config))
  invalidRenderHosts.security.linkSafety.screenshotAllowedHosts = ["https://example.com/path"]
  assert(!validateConfig(invalidRenderHosts).ok, "URL screenshot allowlist should reject protocols and paths")
  const invalidMcpExecutionPolicy = JSON.parse(JSON.stringify(config))
  invalidMcpExecutionPolicy.mcp.servers = {
    smoke: { enabled: false, transport: "stdio", executionByAction: { read: { repeatPolicy: "not-a-policy" } } },
  }
  assert(!validateConfig(invalidMcpExecutionPolicy).ok, "MCP action execution policy should reject unknown values")
  const invalidCaptureSchedule = JSON.parse(JSON.stringify(config))
  invalidCaptureSchedule.memory.groupCapture.consolidation.schedule.mode = "unsupported"
  assert(!validateConfig(invalidCaptureSchedule).ok, "group memory consolidation should reject an unknown schedule mode")
  invalidCaptureSchedule.memory.groupCapture.consolidation.schedule.mode = "time"
  invalidCaptureSchedule.memory.groupCapture.consolidation.schedule.time = "25:99"
  assert(!validateConfig(invalidCaptureSchedule).ok, "group memory consolidation should reject an invalid fixed schedule time")
  invalidCaptureSchedule.memory.groupCapture.consolidation.schedule.time = "03:00"
  invalidCaptureSchedule.memory.groupCapture.consolidation.schedule.mode = "cron"
  invalidCaptureSchedule.memory.groupCapture.consolidation.schedule.cron = "not a cron"
  assert(!validateConfig(invalidCaptureSchedule).ok, "group memory consolidation should reject an invalid Cron expression")
}

async function checkConfigHotReload() {
  const { configBackupDir, configDir, configFile, configStore } = await import("../output/runtime/config/store.js")
  const original = JSON.parse(JSON.stringify(await configStore.load()))
  const beforeBackups = new Set((await configStore.listBackups({ limit: 0 })).map(item => item.fileName))
  try {
    const beforeMeta = configStore.meta()
    const unchanged = await configStore.reloadFromDisk({ keepCurrent: true })
    assert(unchanged.reloaded === false, "unchanged config file should not trigger full reload")
    assert(configStore.meta().lastReloadedAt === beforeMeta.lastReloadedAt, "unchanged reload should keep lastReloadedAt stable")

    const edited = JSON.parse(JSON.stringify(original))
    edited.persona.assistantLabel = `Smoke Reload ${Date.now()}`
    await fs.writeFile(configFile, `${JSON.stringify(edited, null, 2)}\n`, "utf8")
    await sleep(20)
    const reloaded = await configStore.load()
    assert(reloaded.persona.assistantLabel === edited.persona.assistantLabel, "load() should detect external config file changes")

    const invalid = JSON.parse(JSON.stringify(edited))
    invalid.mediaRecognition.recognitionModel = "missing-model"
    await fs.writeFile(configFile, `${JSON.stringify(invalid, null, 2)}\n`, "utf8")
    await sleep(20)
    const kept = await configStore.load()
    assert(kept.mediaRecognition.recognitionModel !== "missing-model", "invalid external config should not replace in-memory config")
    assert(Boolean(configStore.meta().lastLoadError), "invalid external config should be recorded in config meta")

    await configStore.save(original)
    const sparseOriginal = JSON.parse(await fs.readFile(configFile, "utf8"))
    assert(!sparseOriginal.web && !sparseOriginal.logging && !sparseOriginal.system, "ordinary saves should keep config.json sparse without generating a static Web credential")

    const beforeInvalidSave = JSON.stringify(configStore.get())
    const beforeInvalidDisk = await fs.readFile(configFile, "utf8")
    const invalidSave = JSON.parse(JSON.stringify(original))
    invalidSave.mediaRecognition.recognitionModel = "missing-model"
    let invalidSaveRejected = false
    try {
      await configStore.save(invalidSave)
    } catch {
      invalidSaveRejected = true
    }
    assert(invalidSaveRejected, "invalid save candidate should be rejected")
    assert(JSON.stringify(configStore.get()) === beforeInvalidSave, "rejected save must not change the in-memory snapshot")
    assert(await fs.readFile(configFile, "utf8") === beforeInvalidDisk, "rejected save must not change the config file")

    const retiredFilterConfig = JSON.parse(JSON.stringify(original))
    retiredFilterConfig.response.messageProcessing = { enabled: true, rules: [{ id: "retired-processor" }] }
    retiredFilterConfig.response.messageFilters = {
      enabled: true,
      filters: [{
        id: "retired-tool-filter",
        name: "Retired tool filter",
        enabled: true,
        stage: "output",
        condition: { minTextLength: 0 },
        action: {
          tool: "text_transform",
          arguments: {
            text: { from: "response.text" },
            operation: { value: "trim" },
          },
        },
      }],
    }
    await configStore.save(retiredFilterConfig)
    const cleanedFilters = await configStore.load()
    assert(!("messageProcessing" in cleanedFilters.response), "retired message processor configuration should be removed")
    assert(!cleanedFilters.response.messageFilters.filters.some(filter => filter.id === "retired-tool-filter"), "tool-backed filter rules should be discarded rather than migrated")
    await configStore.save(original)

    const retiredToolRoutingConfig = JSON.parse(JSON.stringify(original))
    const retiredModel = retiredToolRoutingConfig.models.find(model => model?.capabilities?.chat !== false)
    assert(retiredModel, "smoke config should contain a chat model")
    retiredModel.toolPolicy = {
      ...(retiredModel.toolPolicy || {}),
      mode: "denylist",
      allow: ["message_send", "openai:web_search", "local:tool_search"],
      deny: ["image_media", "local:web_search"],
      sources: { web_search: "openai" },
      strategies: { web_search: "fallback" },
    }
    retiredModel.responses = {
      ...(retiredModel.responses || {}),
      toolSearch: true,
      webSearch: {
        ...(retiredModel.responses?.webSearch || {}),
        enabled: true,
      },
    }
    retiredToolRoutingConfig.tools.builtin.imageSearch.fallbackEnabled = true
    retiredToolRoutingConfig.tools.builtin.webSearch.fallbackEnabled = true
    await configStore.save(retiredToolRoutingConfig)
    const cleanedToolRouting = await configStore.load()
    const cleanedModel = cleanedToolRouting.models.find(model => model?.name === retiredModel.name)
    assert(cleanedModel && !Object.hasOwn(cleanedModel.toolPolicy || {}, "sources") && !Object.hasOwn(cleanedModel.toolPolicy || {}, "strategies"), "model tool-policy normalization should discard retired source and strategy fields")
    assert(!Object.hasOwn(cleanedModel.responses || {}, "toolSearch") && !Object.hasOwn(cleanedModel.responses?.webSearch || {}, "enabled"), "Responses normalization should discard retired built-in tool switches")
    assert(JSON.stringify(cleanedModel.toolPolicy?.allow || []) === JSON.stringify(["message_send"]), "model allowlist normalization should discard implementation-prefixed IDs without translating them")
    assert(JSON.stringify(cleanedModel.toolPolicy?.deny || []) === JSON.stringify(["image_media"]), "model denylist normalization should preserve capability IDs and discard implementation-prefixed IDs")
    assert(!Object.hasOwn(cleanedToolRouting.tools?.builtin?.imageSearch || {}, "fallbackEnabled") && !Object.hasOwn(cleanedToolRouting.tools?.builtin?.webSearch || {}, "fallbackEnabled"), "search tool normalization should discard retired fallback switches")
    await configStore.save(original)

    const retiredPersonaConfig = JSON.parse(JSON.stringify(original))
    delete retiredPersonaConfig.persona.characterPrompt
    retiredPersonaConfig.persona.systemPrompt = "Smoke 单一系统提示词：[first_person]。"
    retiredPersonaConfig.persona.expression = { enabled: true, stylePrompt: "不应保留", examples: [] }
    retiredPersonaConfig.persona.states = [{ id: "retired", prompt: "不应保留", weight: 1 }]
    retiredPersonaConfig.persona.stateProbabilityPercent = 100
    retiredPersonaConfig.persona.toolOrchestrationPrompt = "不应保留的工具规则"
    retiredPersonaConfig.persona.groupContextPrompt = "不应保留的群聊规则"
    retiredPersonaConfig.persona.commandGuidePrompt = "不应保留的命令规则"
    retiredPersonaConfig.persona.emptyReplyInstruction = "不应保留的静默规则"
    retiredPersonaConfig.persona.innerInstruction = "不应保留的内部规则"
    retiredPersonaConfig.persona.output.splitFirstPersonReplies = true
    retiredPersonaConfig.persona.output.splitMaxParts = 3
    retiredPersonaConfig.persona.output.splitMinChars = 180
    retiredPersonaConfig.persona.output.splitMinPartChars = 60
    retiredPersonaConfig.persona.output.splitDelayPerCharMs = 200
    retiredPersonaConfig.persona.output.splitMaxDelayMs = 3000
    retiredPersonaConfig.persona.output.quoteSplitReplies = false
    await configStore.save(retiredPersonaConfig)
    const cleanedPersona = await configStore.load()
    assert(cleanedPersona.persona.characterPrompt === retiredPersonaConfig.persona.systemPrompt && !Object.hasOwn(cleanedPersona.persona, "systemPrompt"), "persona normalization should migrate the legacy system prompt into the editable character setting")
    assert(retiredPersonaConfigKeys.every(key => !Object.hasOwn(cleanedPersona.persona || {}, key)), "persona normalization should discard every retired prompt, expression, and state field")
    assert(retiredPersonaOutputConfigKeys.every(key => !Object.hasOwn(cleanedPersona.persona?.output || {}, key)), "persona normalization should discard retired first-person split settings")
    await configStore.save(original)

    const retiredContextConfig = JSON.parse(JSON.stringify(original))
    retiredContextConfig.context.recentMessageCount = 3
    for (const key of retiredContextConfigKeys) retiredContextConfig.context[key] = key === "enabled" || key === "injectRecent" ? false : 99
    await configStore.save(retiredContextConfig)
    const cleanedContext = await configStore.load()
    assert(cleanedContext.context.recentMessageCount === 3, "context normalization should preserve the single recent-message count")
    assert(retiredContextConfigKeys.every(key => !Object.hasOwn(cleanedContext.context || {}, key)), "context normalization should discard retired switches and split counts without migrating them")
    await configStore.save(original)

    const retiredSegmentationConfig = JSON.parse(JSON.stringify(original))
    retiredSegmentationConfig.response.segmentation.llmOnly = false
    await configStore.save(retiredSegmentationConfig)
    const cleanedSegmentation = await configStore.load()
    assert(retiredSegmentationConfigKeys.every(key => !Object.hasOwn(cleanedSegmentation.response?.segmentation || {}, key)), "segmentation normalization should discard the retired LLM-only switch")
    await configStore.save(original)

    const retiredPromptBudgetsConfig = JSON.parse(JSON.stringify(original))
    retiredPromptBudgetsConfig.chat.promptBudgets = { currentInputReserve: 1000, safetyMargin: 200 }
    await configStore.save(retiredPromptBudgetsConfig)
    const cleanedPromptBudgets = await configStore.load()
    assert(!Object.hasOwn(cleanedPromptBudgets.chat || {}, "promptBudgets"), "chat normalization should discard retired prompt budget splits")
    assert(cleanedPromptBudgets.chat.inputTokenBudget === original.chat.inputTokenBudget, "chat normalization should preserve the global input token budget fallback")
    await configStore.save(original)

    const concurrentLabel = `Smoke Concurrent ${Date.now()}`
    const concurrentThreshold = Number(original.response?.autoUsePictureThreshold || 1200) + 7
    await Promise.all([
      configStore.update(async draft => {
        await sleep(15)
        draft.persona.assistantLabel = concurrentLabel
      }),
      configStore.update(draft => {
        draft.response.autoUsePictureThreshold = concurrentThreshold
      }),
    ])
    assert(configStore.get().persona.assistantLabel === concurrentLabel, "serialized updates should preserve the first concurrent change")
    assert(configStore.get().response.autoUsePictureThreshold === concurrentThreshold, "serialized updates should preserve the second concurrent change")
    assert(configStore.meta().revision > beforeMeta.revision, "successful writes should advance the config revision")

    await configStore.save(original)
    const backupsBeforeOrdinarySave = await configStore.listBackups({ limit: 0 })
    const ordinarySave = JSON.parse(JSON.stringify(original))
    ordinarySave.persona.assistantLabel = "No Automatic Backup"
    await configStore.save(ordinarySave, { backupReason: "must-not-create-a-backup" })
    assert((await configStore.listBackups({ limit: 0 })).length === backupsBeforeOrdinarySave.length, "ordinary config saves must not create automatic backups")
    await configStore.save(original)
    const retentionConfig = JSON.parse(JSON.stringify(original))
    retentionConfig.system.backups.maxFiles = 3
    retentionConfig.system.backups.maxAgeDays = 30
    await configStore.save(retentionConfig)
    assert(configStore.backupRetention().maxFiles === 3 && configStore.backupRetention().maxAgeDays === 30, "config store should expose the active backup retention policy")
    const retentionFirst = await configStore.backup("smoke_retention")
    const oldRetentionTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    await fs.utimes(retentionFirst, oldRetentionTime, oldRetentionTime)
    await sleep(5)
    await configStore.backup("smoke_retention")
    await sleep(5)
    await configStore.backup("smoke_retention")
    await sleep(5)
    await configStore.backup("smoke_retention")
    const retained = await configStore.listBackups({ limit: 0 })
    assert(!retained.some(item => item.fileName === path.basename(retentionFirst)), "backup retention should remove the oldest file above the configured limit")
    assert(retained.filter(item => item.reason === "smoke_retention").length >= 3, "backup retention should always protect at least the configured file count")

    const ageConfig = JSON.parse(JSON.stringify(original))
    ageConfig.system.backups.maxFiles = 30
    ageConfig.system.backups.maxAgeDays = 30
    await configStore.save(ageConfig)
    const expiredBackup = await configStore.backup("smoke_expired")
    const expiredTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    await fs.utimes(expiredBackup, expiredTime, expiredTime)
    const pruneResult = await configStore.pruneBackups()
    assert(pruneResult.maxFiles === 30 && pruneResult.maxAgeDays === 30, "backup pruning should use configured file and age limits")
    assert((await configStore.listBackups({ limit: 0 })).some(item => item.fileName === path.basename(expiredBackup)), "backup retention should keep old files while the protected file count has not been reached")

    await configStore.save(original)
    const backupFile = await configStore.backup("smoke_backup")
    assert(backupFile.startsWith(configBackupDir), "config backup should stay in plugin backup dir")
    const backupName = path.basename(backupFile)
    const backups = await configStore.listBackups({ limit: 0, inspect: true })
    const listedBackup = backups.find(item => item.fileName === backupName)
    assert(listedBackup?.kind === "package" && listedBackup.restorable === true && listedBackup.hasRuntimeConfig === true, "config backup listing should expose safe package metadata without returning its contents")
    const backupContents = await fs.readFile(backupFile, "utf8")
    const backupPayload = JSON.parse(backupContents)
    assert(backupName.endsWith(".json") && backupPayload.format === "yui-chat-config-backup-v2" && !backupPayload.config?.web?.authToken && !backupPayload.config?.logging && !backupContents.includes("model_call_events") && !backupContents.includes("ai_runs"), "manual backups should store sparse local overrides without inventing a static Web credential or including SQLite log details")
    const changed = JSON.parse(JSON.stringify(original))
    changed.persona.assistantLabel = "Smoke Restore Candidate"
    await configStore.save(changed)
    assert(configStore.get().persona.assistantLabel === "Smoke Restore Candidate", "changed config should be saved before restore")
    const backupsBeforeRestore = await configStore.listBackups({ limit: 0 })
    await configStore.restoreBackup(backupName)
    assert(configStore.get().persona.assistantLabel === original.persona.assistantLabel, "config restore should load backup content")
    assert((await configStore.listBackups({ limit: 0 })).length === backupsBeforeRestore.length, "config restore must not create an automatic before-restore backup")
    try {
      await configStore.restoreBackup("../config.json")
      assert(false, "unsafe backup path should be rejected")
    } catch (err) {
      assert(err.message.includes("非法配置备份文件名"), "unsafe backup path should fail with safe error")
    }
    const disposableBackup = await configStore.backup("smoke_delete")
    const disposableName = path.basename(disposableBackup)
    assert(await configStore.deleteBackup(disposableName), "explicit backup deletion should remove one selected package")
    assert(!(await configStore.listBackups({ limit: 0 })).some(item => item.fileName === disposableName), "deleted backup should disappear from the package listing")
    assert(!(await configStore.deleteBackup(disposableName)), "deleting an already absent package should report false")
    try {
      await configStore.deleteBackup("../config.json")
      assert(false, "unsafe backup deletion path should be rejected")
    } catch (err) {
      assert(err.message.includes("非法配置备份文件名"), "unsafe backup deletion should fail with a safe error")
    }

    const invalidStartupSource = "{\n  \"broken\":\n"
    await fs.writeFile(configFile, invalidStartupSource, "utf8")
    configStore.loaded = false
    configStore.configFileMtimeMs = 0
    configStore.lastLoadError = null
    const recovered = await configStore.reloadFromDisk({ force: true, keepCurrent: false, persistDefaults: true })
    assert(recovered.fallbackDefault === true, "invalid startup config should fall back to defaults")
    assert(Boolean(recovered.quarantinedFile), "invalid startup config should be quarantined before recovery")
    assert(await fs.readFile(recovered.quarantinedFile, "utf8") === invalidStartupSource, "quarantine should preserve the invalid source verbatim")
    assert(configStore.meta().lastLoadError?.quarantinedFile === recovered.quarantinedFile, "recovery metadata should expose the quarantined file")
    assert(configStore.validate().ok, "recovered default config should validate")
    JSON.parse(await fs.readFile(configFile, "utf8"))

    const temporaryFiles = (await fs.readdir(configDir)).filter(name => name.startsWith(".config.json.") && name.endsWith(".tmp"))
    assert(temporaryFiles.length === 0, "atomic config writes should not leave temporary files")
  } finally {
    await configStore.save(original)
    const afterBackups = await configStore.listBackups({ limit: 0 })
    for (const item of afterBackups) {
      if (beforeBackups.has(item.fileName)) continue
      await fs.unlink(path.join(configBackupDir, item.fileName)).catch(() => {})
    }
  }
}

async function checkAtomicJsonRepository() {
  const { AtomicJsonRepository } = await import("../output/runtime/core/storage/atomic-json-repository.js")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-atomic-json-"))
  const file = path.join(root, "state.json")
  const createRepository = (onReadError, targetFile = file) => new AtomicJsonRepository({
    file: targetFile,
    defaultValue: { count: 0, labels: [] },
    normalize(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("state must be an object")
      return { ...value, labels: Array.isArray(value.labels) ? value.labels : [] }
    },
    validate(value) {
      if (!Number.isInteger(value.count)) throw new Error("count must be an integer")
    },
    onReadError,
  })

  try {
    const repository = createRepository()
    assert((await repository.load()).count === 0, "atomic JSON repository should load its default value when the file is absent")
    await repository.replace({ count: 1, labels: ["saved"] })
    const beforeRejectedDisk = await fs.readFile(file, "utf8")
    let rejected = false
    try {
      await repository.replace({ count: "invalid", labels: [] })
    } catch {
      rejected = true
    }
    assert(rejected, "atomic JSON repository should reject invalid candidates")
    assert((await repository.load()).count === 1, "rejected JSON candidate must not change the in-memory snapshot")
    assert(await fs.readFile(file, "utf8") === beforeRejectedDisk, "rejected JSON candidate must not change the data file")

    await Promise.all([
      repository.update(async state => {
        await sleep(15)
        state.labels.push("first")
      }),
      repository.update(state => {
        state.labels.push("second")
        state.count++
      }),
    ])
    const updated = await repository.load()
    assert(updated.count === 2, "serialized JSON updates should retain the latest numeric change")
    assert(updated.labels.includes("first") && updated.labels.includes("second"), "serialized JSON updates should preserve disjoint changes")
    updated.labels.push("local-only")
    assert(!(await repository.load()).labels.includes("local-only"), "repository reads should return editable copies instead of shared state")
    assert(((await fs.stat(file)).mode & 0o777) === 0o600, "atomic JSON files should use owner-only permissions")

    const corruptSource = "{\n  \"count\":\n"
    await fs.writeFile(file, corruptSource, "utf8")
    let readErrorContext
    const recoveringRepository = createRepository((err, context) => {
      readErrorContext = { err, context }
    })
    const recovered = await recoveringRepository.load()
    assert(recovered.count === 0, "corrupt JSON should recover to the repository default")
    assert(Boolean(readErrorContext?.context?.quarantinedFile), "corrupt JSON should be quarantined before recovery")
    assert(await fs.readFile(readErrorContext.context.quarantinedFile, "utf8") === corruptSource, "quarantine should preserve corrupt JSON verbatim")
    await recoveringRepository.update(state => { state.count = 3 })
    assert(JSON.parse(await fs.readFile(file, "utf8")).count === 3, "repository should resume atomic writes after successful quarantine")

    const replaceFirstFile = path.join(root, "replace-first.json")
    await fs.writeFile(replaceFirstFile, corruptSource, "utf8")
    let replaceFirstError
    const replaceFirstRepository = createRepository((err, context) => { replaceFirstError = { err, context } }, replaceFirstFile)
    await replaceFirstRepository.replace({ count: 4, labels: [] })
    assert(Boolean(replaceFirstError?.context?.quarantinedFile), "replace-before-load should inspect and quarantine an existing corrupt file")
    assert(JSON.parse(await fs.readFile(replaceFirstFile, "utf8")).count === 4, "replace-before-load should write only after corrupt source quarantine")

    const temporaryFiles = (await fs.readdir(root)).filter(name => name.startsWith(".state.json.") && name.endsWith(".tmp"))
    assert(temporaryFiles.length === 0, "atomic JSON repository should not leave temporary files")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function checkPersistentStoreAdapters() {
  const { userSettingsStore } = await import("../output/runtime/user/settings.js")
  const original = JSON.parse(JSON.stringify(await userSettingsStore.load()))
  const event = { user_id: `atomic-store-smoke-${Date.now()}` }
  try {
    await Promise.all([
      userSettingsStore.set(event, { mode: "picture" }),
      userSettingsStore.set(event, { preferredVoice: "smoke-voice" }),
    ])
    const settings = await userSettingsStore.get(event, { response: { defaultMode: "text" } })
    assert(settings.mode === "picture", "user settings repository should preserve the first concurrent patch")
    assert(settings.preferredVoice === "smoke-voice", "user settings repository should preserve the second concurrent patch")
  } finally {
    userSettingsStore.data = original
    userSettingsStore.loaded = true
    await userSettingsStore.save()
  }
}

async function checkUserExtensionStorage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-extension-storage-"))
  const seedDir = path.join(root, "seeds")
  const storageRoot = path.join(root, "data", "extensions")
  try {
    await fs.mkdir(path.join(seedDir, "example-package"), { recursive: true })
    await fs.writeFile(path.join(seedDir, "example-package", "filter.json"), "{}\n", "utf8")

    const { createUserExtensionStorage } = await import("../output/runtime/extensions/storage.js")
    const storage = createUserExtensionStorage({
      domain: "filters",
      manifestFile: "filter.json",
      rootDir: storageRoot,
      seedDirs: [seedDir],
    })
    await storage.ensure()
    await storage.ensure()

    assert(storage.dir === path.join(storageRoot, "filters"), "user extension storage should isolate each module under the shared data root")
    assert(await fs.readFile(path.join(storage.dir, "example-package", "filter.json"), "utf8") === "{}\n", "seed extensions should initialize missing data packages")
    assert(await fs.readFile(path.join(seedDir, "example-package", "filter.json"), "utf8") === "{}\n", "seed packages should remain part of plugin source")

    const { dataDir } = await import("../output/runtime/config/store.js")
    const { customToolsDir } = await import("../output/runtime/tools/custom/manager.js")
    const { customFiltersDir } = await import("../output/runtime/filters/custom/manager.js")
    const { skillsDir } = await import("../output/runtime/skills/index.js")
    assert(customToolsDir === path.join(dataDir, "extensions", "tools"), "Custom Tools should use the shared user extension data path")
    assert(customFiltersDir === path.join(dataDir, "extensions", "filters"), "Custom Filters should use the shared user extension data path")
    assert(skillsDir === path.join(dataDir, "extensions", "skills"), "Skills should use the shared user extension data path")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function checkToolPolicy() {
  const { configStore } = await import("../output/runtime/config/store.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { explainToolPolicy } = await import("../output/runtime/tools/access/policy.js")
  const { getToolCommon, isToolEnabledByConfig, normalizeTool, resolveToolExecutionPolicy } = await import("../output/runtime/tools/support/contract.js")
  const { selectPromptTools } = await import("../output/runtime/core/chat/token-budget.js")
  const { groupIdFromEvent, isGroupEvent, normalizeEventScope } = await import("../output/runtime/core/message/event-scope.js")
  const original = await configStore.load()
  const config = JSON.parse(JSON.stringify(original))
  config.tools.enabledTools = [...new Set([...(config.tools.enabledTools || []), "mute_user", "message_manage", "set_title", "block_user"])]
  try {
    await configStore.save(config)
    await toolRegistry.init()
  const listedTools = await toolRegistry.list()
  const muteMeta = listedTools.find(tool => tool.name === "mute_user")
  assert(muteMeta?.common?.displayNameZh === "禁言成员", "tool list should expose Chinese display name for builtins")
  const messageManageMeta = listedTools.find(tool => tool.name === "message_manage")
  assert(messageManageMeta?.common?.displayNameZh === "群消息管理", "group message management should expose the concise message_manage tool name")
  assert(String(messageManageMeta?.common?.description || "").includes("recall") && String(messageManageMeta?.common?.description || "").includes("essence"), "message_manage should clearly describe recall and essence operations")
  assert(selectPromptTools(listedTools, "玉玉撤回这条消息", { enabled: true, maxTools: 1, maxDefinitionTokens: 1200 })[0]?.name === "message_manage", "Chinese recall intent should select message_manage from its localized parameter semantics")
  assert(selectPromptTools(listedTools, "玉玉禁言我1分钟", { enabled: true, maxTools: 1, maxDefinitionTokens: 1200 })[0]?.name === "mute_user", "Chinese mute intent should select mute_user from its localized display name")
  assert(selectPromptTools(listedTools, "联网查一下今天最新的 AI 新闻", { enabled: true, maxTools: 1, maxDefinitionTokens: 1200 })[0]?.name === "web_search", "explicit real-time web intent should inject web_search in the first model round")
  assert(selectPromptTools(listedTools, "帮我搜索一下 TypeScript 最近的新特性", { enabled: true, maxTools: 1, maxDefinitionTokens: 1200 })[0]?.name === "web_search", "generic non-specialized search intent should inject web_search in the first model round")
  assert(selectPromptTools(listedTools, "搜一张生气的猫咪图片", { enabled: true, maxTools: 1, maxDefinitionTokens: 1200 })[0]?.name === "image_media", "media search intent should still prefer image_media over web_search")
  const inferredGroupEvent = { message_type: "group", group_id: "20001", isMaster: true, user_id: "master", sender: { role: "owner" } }
  const nestedGroupEvent = { group: { group_id: "g2" }, user_id: "u2", sender: { role: "admin" } }
  const privateTemporaryEvent = { message_type: "private", group_id: "source-group", user_id: "u3" }
  assert(isGroupEvent(inferredGroupEvent) && groupIdFromEvent(inferredGroupEvent) === "20001", "message_type=group should recover a missing isGroup flag")
  assert(isGroupEvent(nestedGroupEvent) && groupIdFromEvent(nestedGroupEvent) === "g2", "a host group object should recover group scope for adapters without flat fields")
  assert(!isGroupEvent(privateTemporaryEvent), "an explicit private message should stay private even when it carries a source group id")
  const normalizedGroupEvent = normalizeEventScope({ ...nestedGroupEvent })
  assert(normalizedGroupEvent.isGroup === true && normalizedGroupEvent.group_id === "g2", "event scope normalization should fill the common host fields in place")
  assert(listedTools.find(tool => tool.name === "message_send")?.common?.delivery === "media", "tool list should expose delivery semantics")
  assert(listedTools.find(tool => tool.name === "message_send")?.common?.requiresFinalReply === false, "a completed delivery should explicitly opt out of a second model reply")
  assert(listedTools.find(tool => tool.name === "message_send")?.common?.execution?.effect === "non_idempotent" && listedTools.find(tool => tool.name === "message_send")?.common?.execution?.repeatPolicy === "dedupe", "delivery tools should expose the common side-effect execution policy")
  assert(!listedTools.some(tool => ["send_message", "send_message_to_target", "at_user"].includes(tool.name)), "retired delivery tools should no longer be registered")
  assert(listedTools.find(tool => tool.name === "image_media")?.common?.execution?.repeatPolicy === "bounded", "read-only image media search should remain bounded")
  assert(listedTools.find(tool => tool.name === "image_media")?.common?.autoDelivery?.continueConversation === true, "image_media should explicitly request one conversational continuation after automatic delivery")
  assert(listedTools.find(tool => tool.name === "group_poke")?.common?.execution?.targetFields?.includes("qqs"), "poke should expose a target execution field")
  assert(listedTools.find(tool => tool.name === "group_poke")?.common?.execution?.supportsCount === true && listedTools.find(tool => tool.name === "group_poke")?.common?.execution?.operationFamily === "group_poke", "poke should expose count quota and operation family in the common policy")
  assert(!listedTools.some(tool => tool.name === "media_action"), "retired media_action should no longer be registered")
  assert(listedTools.find(tool => tool.name === "bilibili_media")?.common?.execution?.repeatPolicy === "bounded", "plain Bilibili media search should stay repeatable")
  assert(listedTools.find(tool => tool.name === "bilibili_media")?.common?.executionByAction?.send?.effect === "idempotent_write", "direct-send Bilibili media should prepare local files as an idempotent write")
  assert(listedTools.find(tool => tool.name === "bilibili_media")?.common?.autoDelivery?.continueConversation === true, "bilibili_media should explicitly request one conversational continuation after automatic delivery")
  assert(listedTools.find(tool => tool.name === "message_send")?.common?.autoDelivery === null, "message_send should remain a delivery boundary without controlling conversational continuation")
  assert(!listedTools.some(tool => ["bilibili_search", "image_search"].includes(tool.name)), "renamed media tools should not keep legacy aliases")
  assert(listedTools.find(tool => tool.name === "message_send")?.common?.delivery === "media", "message_send should expose the shared media delivery mode")
  assert(listedTools.find(tool => tool.name === "message_send")?.common?.requiresFinalReply === false, "message_send should finish a successful media delivery without a redundant model reply")
  assert(listedTools.find(tool => tool.name === "message_send")?.common?.execution?.dispatchMarking === "deferred", "message_send should defer its dispatch marker until the host boundary")
  assert(listedTools.find(tool => tool.name === "group_poke")?.common?.execution?.dispatchMarking === "immediate", "ordinary side-effect tools should keep marking dispatch on entry")
  assert(listedTools.find(tool => tool.name === "message_send")?.common?.execution?.effect === "non_idempotent" && listedTools.find(tool => tool.name === "message_send")?.common?.execution?.repeatPolicy === "dedupe", "message_send should protect the ordered chain from duplicate delivery")
  assert(listedTools.find(tool => tool.name === "memory_manage")?.common?.execution?.repeatPolicy === "bounded", "memory reads should remain repeatable")
  assert(listedTools.find(tool => tool.name === "memory_manage")?.common?.executionByAction?.write?.repeatPolicy === "dedupe", "memory writes should protect against duplicate persistence")
  assert(listedTools.find(tool => tool.name === "knowledge_manage")?.common?.executionByAction?.handoff?.repeatPolicy === "dedupe", "knowledge handoff should protect against duplicate dispatch")
  assert(listedTools.find(tool => tool.name === "schedule_task")?.common?.executionByAction?.schedule?.repeatPolicy === "dedupe", "schedule creation should protect against duplicate reminders")
  assert(normalizeTool({ name: "smoke-search", source: "mcp", description: "search", async execute() { return "ok" } }, { source: "mcp" }).common.requiresFinalReply === true, "new silent tools should require a final model reply by default")
  assert(normalizeTool({ name: "smoke-direct", source: "custom", delivery: "media", description: "send", async execute() { return "ok" } }).common.requiresFinalReply === true, "delivery mode should not implicitly disable the final model reply")
  assert(normalizeTool({ name: "smoke-async", source: "custom", requiresFinalReply: false, description: "async send", async execute() { return "ok" } }).common.requiresFinalReply === false, "explicit requiresFinalReply false should allow async no-reply tools")
  const idempotentSmokeTool = normalizeTool({ name: "smoke-idempotent", source: "custom", execution: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["target"], operationFields: ["target"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }, description: "one-shot", async execute() { return "ok" } })
  assert(idempotentSmokeTool.common.execution.repeatPolicy === "dedupe" && idempotentSmokeTool.common.execution.targetFields[0] === "target" && !Object.hasOwn(idempotentSmokeTool.common, "repeatable"), "custom tools should expose only the unified repeatability policy")
  const explicitExecutionTool = normalizeTool({ name: "smoke-execution-policy", source: "custom", execution: { effect: "destructive", repeatPolicy: "explicit_only", retryPolicy: "no_ambiguous_retry", maxAttempts: 1, targetFields: ["target"] }, description: "explicit policy", async execute() { return "ok" } })
  assert(explicitExecutionTool.common.execution.effect === "destructive" && explicitExecutionTool.common.execution.repeatPolicy === "explicit_only" && explicitExecutionTool.common.execution.targetFields[0] === "target", "custom tools should accept the extensible common execution policy")
  const authoritativeExecutionTool = normalizeTool({ name: "smoke-authoritative-execution", source: "custom", execution: { effect: "read", repeatPolicy: "bounded", targetFields: ["query"] }, description: "unified policy", async execute() { return "ok" } })
  assert(authoritativeExecutionTool.common.execution.repeatPolicy === "bounded" && authoritativeExecutionTool.common.execution.targetFields[0] === "query", "the unified execution policy should be authoritative")
  const mixedPolicyTool = normalizeTool({
    name: "smoke-mixed-policy",
    source: "custom",
    execution: { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe" },
    executionByAction: { write: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["id"], operationFields: ["id"], retryPolicy: "no_ambiguous_retry" } },
    description: "mixed policy",
    async execute() { return "ok" },
  })
  assert(resolveToolExecutionPolicy(mixedPolicyTool, { action: "read" }).execution.repeatPolicy === "bounded", "action policy should keep read actions repeatable")
  assert(resolveToolExecutionPolicy(mixedPolicyTool, { action: "write" }).execution.repeatPolicy === "dedupe" && resolveToolExecutionPolicy(mixedPolicyTool, { action: "write" }).execution.targetFields[0] === "id", "action policy should deduplicate write actions with declared keys")
  const legacyTool = normalizeTool({ name: "smoke-legacy", source: "custom", replyPolicy: "none", description: "legacy async", async execute() { return "ok" } })
  assert(legacyTool.common.requiresFinalReply === true && !Object.hasOwn(legacyTool, "replyPolicy"), "removed reply policy fields should not alter normalized tools")
  const privateTools = await toolRegistry.getAllowedTools({ e: { isGroup: false, isMaster: false, user_id: "u1", sender: { role: "member" } } })
  const adminTools = await toolRegistry.getAllowedTools({ e: { isGroup: true, isMaster: false, user_id: "u2", group_id: "g1", sender: { role: "admin" } } })
  const ownerTools = await toolRegistry.getAllowedTools({ e: { isGroup: true, isMaster: false, user_id: "u3", group_id: "g1", sender: { role: "owner" } } })
  const masterTools = await toolRegistry.getAllowedTools({ e: { isGroup: true, isMaster: true, user_id: "master", group_id: "g1", sender: { role: "owner" } } })
  const inferredGroupTools = await toolRegistry.getAllowedTools({ e: inferredGroupEvent })
  const inferredPrivateTools = await toolRegistry.getAllowedTools({ e: privateTemporaryEvent })
  const consolidatedTools = await toolRegistry.getAllowedTools({
    e: { isGroup: true, isMaster: true, user_id: "master", group_id: "g1", sender: { role: "owner" } },
    excludeDeliveryModes: ["current-chat"],
  })
  assert(!consolidatedTools.some(tool => ["send_message", "send_message_to_target", "at_user"].includes(tool.name)), "retired delivery tools should be gone in favour of message_send")
  assert(privateTools.some(tool => tool.name === "knowledge_manage"), "private users should see knowledge_manage")
  assert(privateTools.some(tool => tool.name === "memory_manage"), "private users should see compact memory_manage")
  assert(privateTools.some(tool => tool.name === "render_image"), "private users should see render_image")
  assert(privateTools.some(tool => tool.name === "bilibili_media"), "private users should see Bilibili media")
  assert(privateTools.some(tool => tool.name === "message_send"), "private users should see the unified message sender")
  assert(privateTools.some(tool => tool.name === "schedule_task"), "private users should see schedule_task")
  assert(privateTools.some(tool => tool.name === "image_media"), "private users should see image_media")
  assert(!privateTools.some(tool => tool.name === "mute_user"), "private users must not see mute_user")
  assert(!privateTools.some(tool => tool.name === "message_manage"), "private users must not see message_manage")
  assert(inferredGroupTools.some(tool => tool.name === "set_title"), "group tools should remain visible when the adapter exposes message_type/group_id without isGroup")
  assert(!inferredPrivateTools.some(tool => tool.name === "set_title"), "group tools must stay hidden in an explicit private temporary session")
  assert(selectPromptTools(inferredGroupTools, "玉玉修改我的头衔为cccc", { enabled: true, maxTools: 1, maxDefinitionTokens: 1200 })[0]?.name === "set_title", "title intent should select set_title after shared group scope recovery")
  assert(!privateTools.some(tool => tool.name === "block_user"), "private users must not see block_user when permission groups are enabled")
  assert(!privateTools.some(tool => tool.name === "render_html_screenshot"), "private users must not see disabled HTML screenshot tool")
  assert(!privateTools.some(tool => tool.name === "render_url_screenshot"), "private users must not see disabled URL screenshot tool")
  let titleCall
  const titleEvent = {
    message_type: "group",
    group_id: "20001",
    isMaster: true,
    user_id: "10001",
    sender: { role: "owner" },
    group: { async setTitle(qq, title) { titleCall = { qq, title }; return true } },
  }
  const titleResult = await toolRegistry.execute("set_title", { title: "cccc" }, { e: titleEvent })
  assert(titleEvent.isGroup === true && titleCall?.qq === 10001 && titleCall?.title === "cccc" && String(titleResult).includes("cccc"), "tool execution should normalize group scope before policy and invoke the group adapter")
  const messageSendMeta = listedTools.find(tool => tool.name === "message_send")
  assert(!Object.hasOwn(messageSendMeta?.common?.parameters?.properties || {}, "target"), "message_send should expose only current-chat delivery and no target parameter")
  const currentChatPayloads = []
  const currentChatSend = await toolRegistry.execute("message_send", {
    parts: [{ type: "text", text: "hi" }],
  }, { e: { isMaster: true, isGroup: true, group_id: "20001", sender: { role: "owner" }, reply: async payload => currentChatPayloads.push(payload) } })
  assert(currentChatSend.kind === "delivery" && currentChatPayloads.length === 1, "message_send should deliver to the current event without cross-target routing")
  assert(adminTools.some(tool => tool.name === "knowledge_manage"), "group admins should inherit knowledge_manage")
  assert(adminTools.some(tool => tool.name === "mute_user"), "group admins should see mute_user when enabled")
  assert(adminTools.some(tool => tool.name === "message_manage"), "group admins should see message_manage when enabled")
  assert(adminTools.some(tool => tool.name === "block_user"), "group admins should see block_user when enabled")
  assert(ownerTools.some(tool => tool.name === "mute_user"), "group owners should see mute_user when enabled")
  const matrix = await toolRegistry.accessMatrix({ groupId: "g1", userId: "u2" })
  assert(matrix.roles.includes("user") && matrix.roles.includes("groupAdmin") && matrix.roles.includes("groupOwner") && matrix.roles.includes("master"), "access matrix should include standard roles")
  assert(matrix.summaries.user.allowedBySource.builtin > 0, "access matrix should summarize allowed tools by source")
  assert(Object.keys(matrix.summaries.user.allowedByCategory).length > 0, "access matrix should summarize allowed tools by category")
  assert(Object.keys(matrix.summaries.user.allowedByRisk).length > 0, "access matrix should summarize allowed tools by risk")
  assert(matrix.summaries.user.deniedEnabled > 0, "user access matrix should count denied enabled tools")
  assert(Object.keys(matrix.summaries.user.deniedReasons).length > 0, "access matrix should group denied reasons")
  const muteRow = matrix.rows.find(row => row.tool.name === "mute_user")
  assert(muteRow?.decisions?.user?.allowed === false, "access matrix should deny mute_user to normal users")
  assert(muteRow?.decisions?.groupAdmin?.allowed === true, "access matrix should allow mute_user to group admins")
  assert(muteRow?.decisions?.groupOwner?.allowed === true, "access matrix should allow mute_user to group owners")
    const mcpTool = normalizeTool({
      name: "mcp_cc_search_image",
      description: "Search images from the configured MCP server.",
      descriptionZh: "搜索图片",
      tags: ["mcp", "cc", "external"],
      category: "mcp",
      risk: "external",
      policy: { externalNetwork: true },
      mcp: { serverName: "cc", originalName: "search_image" },
      async execute() { return "smoke mcp" },
    }, { source: "mcp" })
    toolRegistry.tools.set(mcpTool.name, mcpTool)
    const mcpConfig = JSON.parse(JSON.stringify(config))
    mcpConfig.mcp = {
      ...(mcpConfig.mcp || {}),
      enabled: true,
      servers: {
        ...(mcpConfig.mcp?.servers || {}),
        cc: {
          enabled: true,
          transport: "streamableHttp",
          description: "cc表情包图床",
          policy: { externalNetwork: true },
        },
      },
    }
    assert(isToolEnabledByConfig(mcpConfig, mcpTool), "an enabled MCP server should enable its dynamically named tools")
    assert(!isToolEnabledByConfig({ ...mcpConfig, mcp: { ...mcpConfig.mcp, enabled: false } }, mcpTool), "the MCP global switch should disable dynamically named tools")
    const mcpMasterTools = await toolRegistry.getAllowedTools({
      config: mcpConfig,
      e: { isGroup: true, isMaster: true, user_id: "mcp-master", group_id: "g1", sender: { role: "owner" } },
    })
    const mcpUserTools = await toolRegistry.getAllowedTools({
      config: mcpConfig,
      e: { isGroup: true, isMaster: false, user_id: "mcp-user", group_id: "g1", sender: { role: "member" } },
    })
    assert(mcpMasterTools.some(tool => tool.name === mcpTool.name), "masters should receive enabled MCP tools")
    assert(!mcpUserTools.some(tool => tool.name === mcpTool.name), "ordinary users should still be denied MCP tools by boundary access")
    const selectedMcpTools = selectPromptTools(mcpMasterTools, "请用 cc 图床找一个生气的表情包图片", config.tools.promptSelection)
    assert(selectedMcpTools.some(tool => tool.name === mcpTool.name), "Chinese MCP service descriptions should participate in progressive tool selection")
    toolRegistry.tools.delete(mcpTool.name)

    const explicitConfig = JSON.parse(JSON.stringify(await configStore.load()))
  explicitConfig.tools.boundaryAccess.roles.user.allowExternalNetwork = false
  explicitConfig.tools.boundaryAccess.roles.user.allowHighRisk = false
  explicitConfig.tools.boundaryAccess.roles.user.allowedTools = ["image_media"]
  const imageSearchTool = toolRegistry.tools.get("image_media")
  const explicitDecision = explainToolPolicy(imageSearchTool, {
    e: { isGroup: true, isMaster: false, user_id: "u4", group_id: "g2", sender: { role: "member" } },
    config: explicitConfig,
  })
  assert(explicitDecision.allowed === true, "explicitly allowed tool should bypass boundary-level external/high-risk switches")

  const deniedConfig = JSON.parse(JSON.stringify(await configStore.load()))
  deniedConfig.tools.boundaryAccess.roles.user.allowedTools = ["image_media"]
  deniedConfig.tools.boundaryAccess.roles.user.deniedTools = ["image_media"]
  const deniedDecision = explainToolPolicy(imageSearchTool, {
    e: { isGroup: true, isMaster: false, user_id: "u5", group_id: "g2", sender: { role: "member" } },
    config: deniedConfig,
  })
  assert(deniedDecision.allowed === false && deniedDecision.reason.includes("单独禁止"), "explicit deny should override category, source, and explicit allow rules")
  } finally {
    await configStore.save(original)
    await toolRegistry.init()
  }
}

async function checkScheduleTaskTool() {
  const { configStore } = await import("../output/runtime/config/store.js")
  const { AtomicJsonRepository } = await import("../output/runtime/core/storage/atomic-json-repository.js")
  const { ScheduleTaskService, formatScheduleTaskList, scheduleTaskService, sendTaskMessage } = await import("../output/runtime/core/scheduling/schedule-task-service.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const config = JSON.parse(JSON.stringify(await configStore.load()))
  config.tools.builtin.scheduleTask.maxPerUser = 1
  config.tools.builtin.scheduleTask.cronMaxPerUser = 1
  config.tools.builtin.scheduleTask.cronMinIntervalMinutes = 60
  config.tools.enabledTools = [...new Set([...(config.tools.enabledTools || []), "schedule_task"])]
  await toolRegistry.init()
  const e = { isGroup: true, group_id: "20001", user_id: `schedule-smoke-${Date.now()}`, sender: { role: "member", user_id: "", card: "群里第一温柔" } }
  e.sender.user_id = e.user_id
  const created = await toolRegistry.execute("schedule_task", { action: "schedule", content: `提醒群里第一温柔(${e.user_id}) smoke reminder`, delayMinutes: 43200 }, { e, config })
  assert(/已经记下了/.test(created) && /提醒你：smoke reminder/.test(created), "schedule_task should create natural one-time reminder confirmations without recipient metadata")
  const limited = await toolRegistry.execute("schedule_task", { action: "schedule", content: "second reminder", delayMinutes: 43200 }, { e, config })
  assert(/最多保留 1 个一次性定时任务/.test(limited), "schedule_task should enforce per-user limit")
  const list = await toolRegistry.execute("schedule_task", { action: "list" }, { e, config })
  const id = list.match(/编号：(once_[^\s]+)/)?.[1]
  assert(id, "schedule_task list should expose created task id")
  assert(list.includes("你的定时任务") && list.includes("smoke reminder") && !list.includes("群里第一温柔") && !list.includes(e.user_id), "schedule_task list should be human-readable and omit the current recipient identity")
  const cancelled = await toolRegistry.execute("schedule_task", { action: "cancel", taskId: id }, { e, config })
  assert(/已取消定时任务/.test(cancelled), "schedule_task should cancel owned task")
  const cronFast = await toolRegistry.execute("schedule_task", { action: "cron_add", content: "fast", cron: "*/5 * * * *" }, { e, config })
  assert(/间隔过短/.test(cronFast), "schedule_task should reject cron below minimum interval")
  const cronListFast = await toolRegistry.execute("schedule_task", { action: "cron_add", content: "fast list", cron: "0,30 * * * *" }, { e, config })
  assert(/间隔过短/.test(cronListFast), "schedule_task should reject list cron below minimum interval")
  const cronInvalid = await toolRegistry.execute("schedule_task", { action: "cron_add", content: "invalid", cron: "70 * * * *" }, { e, config })
  assert(/cron 表达式无效/.test(cronInvalid), "schedule_task should reject invalid cron fields")
  scheduleTaskService.stop()

  const originalBot = global.Bot
  const originalAt = global.segment.at
  const sentTasks = []
  global.Bot = {
    pickGroup: async () => ({ sendMsg: async message => sentTasks.push(message) }),
  }
  global.segment.at = id => ({ type: "at", data: { qq: String(id) } })
  try {
    await sendTaskMessage({
      scopeType: "group",
      groupId: "20001",
      userId: "900001",
      content: "提醒群里第一温柔(900001) [CQ:at,qq=123456]禁言 2 分钟了哦～",
    }, config)
    assert(sentTasks[0]?.some(item => item?.type === "at" && item.data?.qq === "900001"), "scheduled group reminders should identify the recipient with a native at segment")
    assert(sentTasks[0]?.some(item => item?.type === "at" && item.data?.qq === "123456"), "scheduled reminders should convert CQ at codes into native segments")
    assert(!sentTasks[0]?.some(item => typeof item === "string" && item.includes("[CQ:")), "scheduled reminders should never deliver literal CQ code")
    const deliveredText = sentTasks[0]?.filter(item => typeof item === "string").join("") || ""
    assert(deliveredText.includes("到时间啦") && !deliveredText.includes("群里第一温柔") && !deliveredText.includes("900001"), "scheduled reminders should sound natural and not repeat the native-at recipient")
  } finally {
    global.Bot = originalBot
    global.segment.at = originalAt
  }

  const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-schedule-"))
  try {
    const repository = new AtomicJsonRepository({
      file: path.join(isolatedDir, "tasks.json"),
      defaultValue: { oneTime: [], cron: [] },
    })
    const baseTime = Date.now()
    let attempts = 0
    let alwaysFail = false
    const isolatedService = new ScheduleTaskService({
      repository,
      clock: () => baseTime,
      sender: async () => {
        attempts += 1
        if (alwaysFail || attempts === 1) throw new Error("expected smoke delivery failure")
      },
    })
    const isolatedEvent = { isGroup: false, user_id: "schedule-isolated", sender: { user_id: "schedule-isolated" } }
    assert(/必须是正数/.test(await isolatedService.addOneTime(isolatedEvent, { content: "invalid delay" }, config)), "schedule task should reject a missing delay")
    await isolatedService.addOneTime(isolatedEvent, { content: "retry once", delayMinutes: 1 }, config)
    await isolatedService.tick(new Date(baseTime + 60_000))
    let rows = await isolatedService.list(isolatedEvent)
    assert(rows.oneTime[0]?.status === "retrying" && rows.oneTime[0]?.attempts === 1, "failed one-time delivery should remain visible for retry")
    const retryAt = Date.parse(rows.oneTime[0].nextAttemptAt)
    await isolatedService.tick(new Date(retryAt - 1))
    assert(attempts === 1, "one-time delivery should respect retry backoff")
    await isolatedService.tick(new Date(retryAt))
    assert((await isolatedService.list(isolatedEvent)).oneTime.length === 0, "successful retry should remove the one-time task")

    alwaysFail = true
    attempts = 0
    await isolatedService.addOneTime(isolatedEvent, { content: "terminal failure", delayMinutes: 1 }, config)
    let nextAttempt = baseTime + 60_000
    for (let index = 0; index < 3; index++) {
      await isolatedService.tick(new Date(nextAttempt))
      rows = await isolatedService.list(isolatedEvent)
      if (rows.oneTime[0]?.nextAttemptAt) nextAttempt = Date.parse(rows.oneTime[0].nextAttemptAt)
    }
    rows = await isolatedService.list(isolatedEvent)
    assert(rows.oneTime[0]?.status === "failed" && rows.oneTime[0]?.attempts === 3, "terminal delivery failure should remain visible instead of being lost")

    await isolatedService.cancel(isolatedEvent, rows.oneTime[0].id)
    const concurrent = await Promise.all([
      isolatedService.addOneTime(isolatedEvent, { content: "concurrent one", delayMinutes: 5 }, config),
      isolatedService.addOneTime(isolatedEvent, { content: "concurrent two", delayMinutes: 5 }, config),
    ])
    assert((await isolatedService.list(isolatedEvent)).oneTime.length === 1, "serialized schedule updates should preserve the per-user limit")
    assert(concurrent.filter(result => /最多保留/.test(result)).length === 1, "one concurrent schedule create should be rejected by the limit")

    const otherEvent = { isGroup: true, group_id: "another-group", user_id: "schedule-other", sender: { user_id: "schedule-other" } }
    await isolatedService.addOneTime(otherEvent, { content: "another reminder", delayMinutes: 5 }, { ...config, tools: { ...config.tools, builtin: { ...config.tools.builtin, scheduleTask: { ...config.tools.builtin.scheduleTask, maxPerUser: 2 } } } })
    const allRows = await isolatedService.listAll()
    assert(allRows.oneTime.some(row => row.userId === "schedule-isolated") && allRows.oneTime.some(row => row.userId === "schedule-other"), "master schedule listing should include tasks from every user")
    const ownerList = formatScheduleTaskList(allRows, { title: "全部定时任务", showOwner: true })
    assert(ownerList.includes("群 another-group · 用户 schedule-other") && ownerList.includes("编号：once_"), "master schedule listing should show task ownership and cancellation ids")
  } finally {
    await fs.rm(isolatedDir, { recursive: true, force: true })
  }
}

async function checkExtensions() {
  const { parseSkillMarkdown, setSkillEnabled, skillManager, skillsDir, updateSkillPackage } = await import("../output/runtime/skills/index.js")
  const { McpToolAdapter } = await import("../output/runtime/mcp/index.js")
  const { MessageSendTool } = await import("../output/runtime/tools/builtins/media.js")
  const { deliverMessageChain, extractMessageChain, serializeToolOutput } = await import("../output/runtime/core/message-chain/index.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { getToolCommon, validateToolArguments } = await import("../output/runtime/tools/support/contract.js")
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
  assert(typeof StreamableHTTPClientTransport === "function", "MCP SDK should expose Streamable HTTP client transport")
  const messageSendContract = new MessageSendTool()
  const incompleteMediaArgs = { parts: [{ type: "image", source: { kind: "url" } }] }
  assert(validateToolArguments(messageSendContract, incompleteMediaArgs).ok === true, "message_send should let its implementation return a retryable error for an incomplete source")
  const incompleteMediaResult = await messageSendContract.execute(incompleteMediaArgs)
  assert(incompleteMediaResult.kind === "error" && incompleteMediaResult.metadata?.validationError === true && incompleteMediaResult.issues?.some(issue => String(issue).includes("source.value")), "message_send should explain the missing source.value without throwing at the registry boundary")
  const mediaActionPayloads = []
  const newMediaActionResult = await messageSendContract.execute({
    parts: [
      { type: "text", text: "新格式" },
      { type: "image", source: { kind: "base64", value: "aGVsbG8=", mimeType: "image/png" } },
    ],
  }, {
    e: { isGroup: true, group_id: "smoke", reply: async payload => mediaActionPayloads.push(payload) },
    config: { response: { render: { delivery: { quoteReply: false } } } },
    execution: { operationId: "smoke-media-action" },
  })
  assert(newMediaActionResult.kind === "delivery" && newMediaActionResult.receipt?.status === "sent" && mediaActionPayloads.length === 1, "message_send should deliver an ordered chain containing a direct media source")
  const videoSplitPayloads = []
  const videoSplitResult = await messageSendContract.execute({
    parts: [
      { type: "text", text: "视频简介" },
      { type: "image", source: { kind: "url", value: "https://example.test/video-cover.jpg" } },
      { type: "video", source: { kind: "url", value: "https://example.test/video.mp4" } },
    ],
  }, {
    e: { isGroup: true, group_id: "smoke", reply: async payload => { videoSplitPayloads.push(payload); return { message_id: `video-split-${videoSplitPayloads.length}` } } },
    config: { response: { render: { delivery: { quoteReply: false } } } },
    execution: { operationId: "smoke-video-split" },
  })
  assert(videoSplitResult.kind === "delivery" && videoSplitResult.receipt?.status === "sent" && videoSplitPayloads.length === 2, "message_send should split a video from the preceding OneBot text-and-image payload")
  assert(Array.isArray(videoSplitPayloads[0]) && videoSplitPayloads[0][0] === "视频简介" && JSON.stringify(videoSplitPayloads[0][1]).includes("video-cover.jpg"), "an available video cover should remain in the preceding text-and-image message")
  assert(!Array.isArray(videoSplitPayloads[1]) && JSON.stringify(videoSplitPayloads[1]).includes("video.mp4"), "the video body should be sent as its own OneBot message")
  assert(videoSplitResult.receipt?.parts?.[0]?.messageId === "video-split-1" && videoSplitResult.receipt?.parts?.[2]?.messageId === "video-split-2", "split video delivery should preserve per-part message receipts")
  const bareVideoPayloads = []
  const bareVideoResult = await messageSendContract.execute({
    parts: [{ type: "video", source: { kind: "url", value: "https://example.test/bare-video.mp4" } }],
  }, {
    e: { isGroup: true, group_id: "smoke", reply: async payload => bareVideoPayloads.push(payload) },
    config: { response: { render: { delivery: { quoteReply: false } } } },
    execution: { operationId: "smoke-bare-video" },
  })
  assert(bareVideoResult.kind === "delivery" && bareVideoPayloads.length === 1 && !Array.isArray(bareVideoPayloads[0]), "a video without a cover should be sent directly as one standalone message")
  const mcpAbortController = new AbortController()
  let mcpCallArguments
  const mcpAdapter = new McpToolAdapter("smoke", {
    async callTool(...callArguments) {
      mcpCallArguments = callArguments
      if (callArguments[0]?.arguments?.mode === "structured") {
        return { content: [], structuredContent: { matches: [{ url: "https://example.test/image.png" }] } }
      }
      if (callArguments[0]?.arguments?.mode === "text-json") {
        return { content: [{ type: "text", text: JSON.stringify({ images: [{ id: 777, url: "https://example.test/raw.gif", description: "开心表情包" }] }) }] }
      }
      if (callArguments[0]?.arguments?.mode === "image") {
        return { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }
      }
      if (callArguments[0]?.arguments?.mode === "unknown-media") {
        return { content: [{ type: "resource_link", uri: "https://example.test/archive.bin", description: "unknown media" }] }
      }
      return { content: [{ type: "text", text: "mcp smoke result" }] }
    },
  }, { name: "smoke_tool", description: "MCP smoke tool", inputSchema: { type: "object", properties: {} } })
  const passthroughMcpResult = await mcpAdapter.execute({}, { signal: mcpAbortController.signal })
  assert(passthroughMcpResult.content?.[0]?.type === "text" && passthroughMcpResult.content[0].text === "mcp smoke result", "MCP adapter should hand the raw tool result to the model")
  assert(mcpCallArguments?.[1] === undefined && mcpCallArguments?.[2]?.signal === mcpAbortController.signal, "MCP adapter should pass request options as the third callTool argument")
  const structuredMcpResult = await mcpAdapter.execute({ mode: "structured" }, { signal: mcpAbortController.signal })
  assert(structuredMcpResult.structuredContent?.matches?.[0]?.url === "https://example.test/image.png", "MCP structuredContent should reach the model untouched")
  const textJsonMcpResult = await mcpAdapter.execute({ mode: "text-json" }, { signal: mcpAbortController.signal })
  assert(JSON.parse(textJsonMcpResult.content[0].text).images[0].url === "https://example.test/raw.gif", "raw JSON text MCP results should stay verbatim")
  const refMediaPayloads = []
  const refMediaResult = await messageSendContract.execute({ parts: [{ type: "image", source: { kind: "url", value: "https://example.test/raw.gif" } }] }, {
    e: { isGroup: true, group_id: "smoke", reply: async payload => refMediaPayloads.push(payload) },
    config: { security: { linkSafety: { allowPrivateHosts: true } }, response: { render: { delivery: { quoteReply: false } } } },
    execution: { operationId: "smoke-media-url" },
  })
  assert(refMediaResult.kind === "delivery" && refMediaResult.receipt?.status === "sent" && refMediaPayloads.length === 1, "message_send should deliver a url copied straight out of a tool result")
  const invalidMessagePartResult = await messageSendContract.execute({ parts: [{ type: "image", userId: "777" }] })
  assert(invalidMessagePartResult.kind === "error" && invalidMessagePartResult.metadata?.validationError === true && invalidMessagePartResult.issues?.some(issue => String(issue).includes("source")), "message_send should reject a media part that carries no resource")
  const messageSendPayloads = []
  const messageSendResult = await messageSendContract.execute({
    parts: [
      { type: "mention", userId: "123456" },
      { type: "text", text: "找到了" },
    ],
  }, {
    e: { isGroup: true, group_id: "smoke", reply: async payload => messageSendPayloads.push(payload) },
    config: { response: { render: { delivery: { quoteReply: false } } } },
    execution: { operationId: "smoke-message-send" },
  })
  assert(messageSendResult.kind === "delivery" && messageSendResult.receipt?.status === "sent" && messageSendPayloads[0]?.[0]?.type === "at", "message_send should deliver an ordered internal chain with a native mention")
  assert(messageSendPayloads[0]?.[1] === " 找到了", "text following a mention should keep a separating space")
  const forwardPayloads = []
  const forwardResult = await messageSendContract.execute({
    parts: [{
      type: "forward",
      nodes: [
        { nickname: "来源 1", userId: "10000", parts: [{ type: "text", text: "标题一\nhttps://example.com/one" }] },
        { nickname: "来源 2", parts: [{ type: "text", text: "标题二\nhttps://example.com/two" }] },
      ],
    }],
  }, {
    e: { isGroup: true, self_id: "99999", group_id: "smoke", reply: async payload => forwardPayloads.push(payload) },
    config: { response: { render: { delivery: { quoteReply: false } } } },
    execution: { operationId: "smoke-forward" },
  })
  assert(forwardResult.kind === "delivery" && forwardResult.receipt?.status === "sent", "message_send should deliver merged-forward nodes through the normal receipt path")
  assert(forwardPayloads[0]?.type === "node" && forwardPayloads[0]?.data?.length === 2 && forwardPayloads[0].data[0]?.nickname === "来源 1", "message_send should emit the Yunzai/OneBot node segment shape")
  const nestedForwardResult = await messageSendContract.execute({ parts: [{ type: "forward", nodes: [{ parts: [{ type: "forward", nodes: [] }] }] }] })
  assert(nestedForwardResult.kind === "error" && nestedForwardResult.metadata?.validationError === true, "message_send should reject recursively nested forward messages")
  // 音乐卡片是平台专属消息段，必须按 OneBot 的 music 结构输出。
  const musicPayloads = []
  const musicResult = await messageSendContract.execute({
    parts: [{ type: "music", platform: "163", id: "1901371647" }],
  }, {
    e: { isGroup: true, group_id: "smoke", reply: async payload => musicPayloads.push(payload) },
    config: { response: { render: { delivery: { quoteReply: false } } } },
    execution: { operationId: "smoke-music" },
  })
  assert(musicResult.kind === "delivery" && musicResult.receipt?.status === "sent", "message_send should deliver a platform music card")
  assert(musicPayloads[0]?.type === "music" && musicPayloads[0]?.data?.type === "163" && musicPayloads[0]?.data?.id === "1901371647", "platform music should use the OneBot music segment shape")
  const customMusicPayloads = []
  await messageSendContract.execute({
    parts: [{ type: "music", platform: "custom", url: "https://y.qq.com/song.html", audio: "https://y.qq.com/play.mp3", title: "歌名", singer: "歌手", image: "https://y.qq.com/cover.jpg" }],
  }, {
    e: { isGroup: true, group_id: "smoke", reply: async payload => customMusicPayloads.push(payload) },
    config: { response: { render: { delivery: { quoteReply: false } } } },
    execution: { operationId: "smoke-music-custom" },
  })
  assert(customMusicPayloads[0]?.data?.type === "custom" && customMusicPayloads[0]?.data?.singer === "歌手" && customMusicPayloads[0]?.data?.audio === "https://y.qq.com/play.mp3", "custom music cards should carry url/audio/title/singer/image")
  const badMusic = await messageSendContract.execute({ parts: [{ type: "music", platform: "qq" }] })
  assert(badMusic.kind === "error" && badMusic.metadata?.validationError === true, "a platform music part without an id should be a retryable validation error")
  const mediaMcpResult = await mcpAdapter.execute({ mode: "image" }, { signal: mcpAbortController.signal })
  assert(mediaMcpResult.content?.[0]?.type === "image" && mediaMcpResult.content[0].mimeType === "image/png", "MCP inline media should keep its original block shape")
  assert(mediaMcpResult.content?.[0]?.data === "aGVsbG8=", "MCP results should reach the model completely untouched")
  const unknownMediaMcpResult = await mcpAdapter.execute({ mode: "unknown-media" }, { signal: mcpAbortController.signal })
  assert(unknownMediaMcpResult.content?.[0]?.uri === "https://example.test/archive.bin", "MCP resource links should reach the model verbatim")
  const parsedDataUrlChain = extractMessageChain({ raw_message: "看图[CQ:image,file=data:image/png;base64,aGVsbG8=]" })
  assert(parsedDataUrlChain.find(part => part.type === "image")?.source.value === "data:image/png;base64,aGVsbG8=", "CQ data URLs should keep their unescaped comma inside the media value")
  const qqImageUrl = "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=smoke&rkey=token"
  const parsedQqImageChain = extractMessageChain({ raw_message: `看图[CQ:image,file=${qqImageUrl},file_size=2106380]` })
  assert(parsedQqImageChain.find(part => part.type === "image")?.source.value === qqImageUrl, "CQ image URLs should not absorb the following file_size attribute")
  const deliveredPayloads = []
  const deliveryReceipt = await deliverMessageChain([
    { type: "text", text: "结果" },
    { type: "image", source: { kind: "base64", value: "aGVsbG8=", mimeType: "image/png" } },
  ], {
    e: { isGroup: true, group_id: "smoke", reply: async payload => deliveredPayloads.push(payload) },
    config: { response: { render: { delivery: { quoteReply: false } } } },
  })
  assert(deliveryReceipt.status === "sent" && deliveryReceipt.sentCount === 2 && deliveredPayloads.length === 1, "selected MCP media should be delivered as one ordered message chain")
  const mentionPayloads = []
  const mentionReceipt = await deliverMessageChain([
    { type: "mention", userId: "123456" },
    { type: "text", text: "请查看" },
  ], {
    e: { isGroup: true, group_id: "smoke", reply: async payload => mentionPayloads.push(payload) },
    config: { response: { render: { delivery: { quoteReply: false } } } },
  })
  assert(mentionReceipt.status === "sent" && mentionPayloads[0]?.[0]?.type === "at" && mentionPayloads[0][0]?.qq === "123456", "message-chain mentions should be delivered as native host segments")
  const privateUrlPayloads = []
  const privateUrlReceipt = await deliverMessageChain([
    { type: "image", source: { kind: "url", value: "http://192.168.1.10/selected.png", mimeType: "image/png" } },
  ], {
    e: { isGroup: true, group_id: "smoke", reply: async payload => privateUrlPayloads.push(payload) },
    config: { security: { linkSafety: { allowPrivateHosts: true } }, response: { render: { delivery: { quoteReply: false } } } },
  })
  assert(privateUrlReceipt.status === "sent" && privateUrlReceipt.sentCount === 1 && privateUrlPayloads.length === 1, "media delivery should allow an explicitly private-host image URL")
  const blockedPrivateUrlReceipt = await deliverMessageChain([
    { type: "image", source: { kind: "url", value: "http://192.168.1.10/blocked.png", mimeType: "image/png" } },
  ], {
    e: { isGroup: true, group_id: "smoke", reply: async () => undefined },
    config: { security: { linkSafety: { allowPrivateHosts: false } }, response: { render: { delivery: { quoteReply: false } } } },
  })
  assert(blockedPrivateUrlReceipt.status === "failed" && blockedPrivateUrlReceipt.sentCount === 0 && blockedPrivateUrlReceipt.error?.includes("私网"), "media delivery should block private-host URLs when the centralized policy is explicitly closed")
  await toolRegistry.init()
  const extensionDigest = toolRegistry.extensionDigest()
  assert(extensionDigest.summary.totalTools > 0, "extension digest should count registered tools")
  assert(typeof extensionDigest.summary.customPackages === "number", "extension digest should count custom packages")
  assert(typeof extensionDigest.summary.skillPackages === "number", "extension digest should count skill packages")
  assert(typeof extensionDigest.summary.mcpServers === "number", "extension digest should count MCP servers")
  assert(!Object.hasOwn(extensionDigest, "extensionCatalog"), "extension digest should not expose retired capability mappings")
  const smokeSkillId = "smoke-skill-toggle"
  const { configStore } = await import("../output/runtime/config/store.js")
  const smokeSkillDir = path.join(skillsDir, smokeSkillId)
  await fs.rm(smokeSkillDir, { recursive: true, force: true })
  try {
    await fs.mkdir(smokeSkillDir, { recursive: true })
    await fs.writeFile(path.join(smokeSkillDir, "SKILL.md"), `---
name: ${smokeSkillId}
description: 当用户请求 smoke workflow 或显式调用 $${smokeSkillId} 时使用。
license: MIT
configSchema:
  type: object
  properties:
    tone:
      type: string
      title: 语气
      default: 干练
    apiToken:
      type: string
      secret: true
---

# Smoke workflow

返回 smoke markdown skill 已加载。
`, "utf8")
    await toolRegistry.init()
    assert(!(await toolRegistry.list()).some(tool => getToolCommon(tool).source === "skill"), "Markdown skills must not register executable tools")
    const explicitPrompt = await skillManager.buildPrompt(`请使用 $${smokeSkillId}`, { config: await configStore.load(), e: { isGroup: false, user_id: "u1" } })
    assert(explicitPrompt.includes("Smoke workflow") && explicitPrompt.includes(`<skill name="${smokeSkillId}"`), "explicit skill invocation should load the full SKILL.md body")
    const varsConfig = await configStore.load()
    varsConfig.skills.runtimeVariables = { [smokeSkillId]: { tone: "活泼", apiToken: "smoke-super-secret", rogue: "smoke-leak-me" } }
    const configPrompt = await skillManager.buildPrompt(`请使用 $${smokeSkillId}`, { config: varsConfig, e: { isGroup: false, user_id: "u1" } })
    assert(configPrompt.includes("<skill-config>") && configPrompt.includes("活泼"), "declared skill runtime variables should be injected into the prompt")
    assert(!configPrompt.includes("smoke-super-secret") && !configPrompt.includes("smoke-leak-me"), "secret and undeclared skill variables must never reach the prompt")
    await setSkillEnabled(smokeSkillId, false)
    const disabledPrompt = await skillManager.buildPrompt(`请使用 $${smokeSkillId}`, { config: await configStore.load(), e: { isGroup: false, user_id: "u1" } })
    assert(!disabledPrompt.includes("Smoke workflow"), "disabled markdown skill should not be injected")
    await setSkillEnabled(smokeSkillId, true)
    await updateSkillPackage(smokeSkillId, { manifest: { name: smokeSkillId, description: "更新后的 smoke workflow。", enabled: true }, source: "# Smoke workflow\n\n返回 smoke markdown skill 已加载。" })
    const enabledSource = await fs.readFile(path.join(smokeSkillDir, "SKILL.md"), "utf8")
    assert(enabledSource.includes(`name: ${smokeSkillId}`), "setSkillEnabled must not rewrite SKILL.md")
    assert(enabledSource.includes("license: MIT"), "web edits must preserve unknown official Skill frontmatter fields")
  } finally {
    await fs.rm(smokeSkillDir, { recursive: true, force: true })
    await toolRegistry.init()
  }
}

async function checkExtensionValidation() {
  const { normalizeTool } = await import("../output/runtime/tools/support/contract.js")
  const { customToolManager } = await import("../output/runtime/tools/custom/manager.js")
  const { applyCustomBuilder, customBuilderFromManifest, customTestDraft } = await import("../output/runtime/web/client/features/tools/custom-builder.js")
  const { validateExtensionManifest } = await import("../output/runtime/extensions/validator.js")
  const { browseFrameworkResourceDirectory, createFrameworkResourceAccess, validateFrameworkResources } = await import("../output/runtime/extensions/framework-resources.js")
  const { buildFilterAuthoringPrompt, parseGeneratedFilterDraft } = await import("../output/runtime/filters/authoring/generator.js")
  const { applyToolRuntimeConfigUpdate, maskToolRuntimeConfig, resolveToolRuntimeConfig, SECRET_PLACEHOLDER } = await import("../output/runtime/extensions/runtime-config.js")
  const runtimeTool = {
    name: "smoke_runtime_tool",
    configSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", default: "https://default.example" },
        apiToken: { type: "string", secret: true },
        limit: { type: "number", minimum: 1, maximum: 10 },
      },
    },
  }
  const resolvedRuntime = resolveToolRuntimeConfig(runtimeTool, { tools: { runtimeVariables: { smoke_runtime_tool: { limit: 5 } } } })
  assert(resolvedRuntime.endpoint === "https://default.example" && resolvedRuntime.limit === 5, "runtime config should merge schema defaults with stored overrides")
  const maskedRuntime = maskToolRuntimeConfig(runtimeTool, { endpoint: "https://b", apiToken: "raw-secret" })
  assert(maskedRuntime.apiToken === SECRET_PLACEHOLDER && maskedRuntime.endpoint === "https://b", "masked runtime config should hide secret values and keep overrides only")
  const keptRuntime = applyToolRuntimeConfigUpdate(runtimeTool, { endpoint: "https://b", apiToken: SECRET_PLACEHOLDER }, { apiToken: "raw-secret" })
  assert(keptRuntime.apiToken === "raw-secret", "secret placeholder should keep the stored secret unchanged")
  const clearedRuntime = applyToolRuntimeConfigUpdate(runtimeTool, { endpoint: "https://b" }, { apiToken: "raw-secret" })
  assert(clearedRuntime.apiToken === undefined, "omitted secret should be cleared under whole-replace semantics")
  let undeclaredRuntimeError = ""
  try {
    applyToolRuntimeConfigUpdate(runtimeTool, { rogue: "x" }, {})
  } catch (err) {
    undeclaredRuntimeError = err.message
  }
  assert(undeclaredRuntimeError.includes("rogue"), "undeclared runtime variable keys should be rejected")
  const customBuilder = customBuilderFromManifest({ tools: [{ name: "old_tool", parameters: { type: "object", properties: { legacy: { type: "string" } } } }] }, "smoke-builder")
  customBuilder.toolName = "smoke_builder_tool"
  customBuilder.resources = [{ alias: "version-compare", reference: "plugin:Guoba-Plugin/lib/compareVersions.js" }]
  customBuilder.parameters = [{ name: "query", type: "string", description: "query", required: "true", secret: "false", defaultValue: "" }]
  const builtCustom = applyCustomBuilder({ tools: [
    { name: "old_tool", repeatable: true },
    { name: "second_tool", repeatableByAction: { write: "dedupe" }, idempotencyKeyFields: ["id"] },
  ] }, customBuilder)
  assert(builtCustom.frameworkResources["version-compare"] && builtCustom.tools[0].parameters.required.includes("query"), "custom builder should serialize framework resources and required parameters")
  assert(builtCustom.tools.every(tool => !["repeatable", "repeatableByAction", "idempotencyKeyFields", "idempotencyKeyFieldsByAction"].some(field => Object.hasOwn(tool, field))), "custom builder should remove deprecated execution fields from every tool")
  const testDraft = customTestDraft("return args?.query + context.toolConfig?.apiToken", customBuilder)
  assert("query" in testDraft.args && "apiToken" in testDraft.runtimeConfig, "custom test draft should collect keys declared by source code")
  let runtimeRangeError = ""
  try {
    applyToolRuntimeConfigUpdate(runtimeTool, { limit: 99 }, {})
  } catch (err) {
    runtimeRangeError = err.message
  }
  assert(runtimeRangeError.includes("limit"), "runtime variable range violations should be rejected")
  const highRiskSkill = normalizeTool({
    name: "smoke_high_risk_skill",
    risk: "high",
    parameters: { type: "object", properties: {} },
    async execute() { return "ok" },
  }, { source: "custom" })
  assert(highRiskSkill.common.policy.requiresMaster === true, "high-risk extension tools should default to master-only when no elevated policy is declared")
  const groupAdminSkill = normalizeTool({
    name: "smoke_group_admin_skill",
    risk: "high",
    policy: { requiresGroupAdmin: true },
    parameters: { type: "object", properties: {} },
    async execute() { return "ok" },
  }, { source: "custom" })
  assert(groupAdminSkill.common.policy.requiresGroupAdmin === true && groupAdminSkill.common.policy.requiresMaster !== true, "explicit group-admin extension policy should be preserved")
  const bad = validateExtensionManifest({
    id: "bad",
    risk: "wild",
    tools: [{ description: "missing name" }],
  }, { type: "custom-tool" })
  assert(!bad.ok, "invalid extension manifest should fail validation")
  assert(bad.errors.some(issue => issue.path === "risk"), "invalid risk should be reported")
  assert(bad.errors.some(issue => issue.path === "tools.0.name"), "missing tool name should be reported")
  const duplicateNames = validateExtensionManifest({ tools: [{ name: "same", description: "one" }, { name: "same", description: "two" }] })
  assert(!duplicateNames.ok && duplicateNames.errors.some(issue => issue.path === "tools.1.name"), "duplicate extension tool names should be rejected")
  const good = validateExtensionManifest({
    id: "hello",
    name: "Hello",
    description: "Hello skill",
    risk: "low",
    tags: ["example"],
    policy: { requiresMaster: false, externalNetwork: false },
    execution: { effect: "read", repeatPolicy: "bounded" },
    executionByAction: { write: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["id"], operationFields: ["id"] } },
    tools: [{ name: "hello_echo", description: "echo text", risk: "low", execution: { effect: "read", repeatPolicy: "bounded" }, executionByAction: { write: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["id"], operationFields: ["id"] } } }],
  }, { type: "skill" })
  assert(good.ok, "valid extension manifest should pass validation")
  const resourceAccess = createFrameworkResourceAccess({
    "version-compare": "plugin:Guoba-Plugin/lib/compareVersions.js",
    "root-package": "yunzai:package.json",
  }, { packageId: "smoke-framework-block" })
  const versionBlock = await resourceAccess.use("version-compare")
  assert(versionBlock.compareVersions("2.1.0", "2.0.5") > 0, "framework resource shorthand should import another plugin module")
  const versionSource = await resourceAccess.readSource("version-compare", { maxBytes: 100000 })
  assert(versionSource.includes("compareVersions"), "declared module resources should expose source text to the authoring helper without importing undeclared files")
  const rootPackage = await resourceAccess.use("root-package")
  assert(rootPackage?.name, "framework resource shorthand should load custom JSON resources")
  assert(validateFrameworkResources({ bad: "plugin:Guoba-Plugin/../../package.json" }).some(issue => issue.level === "error"), "framework resources must reject paths outside the declared plugin")
  const browsedResources = await browseFrameworkResourceDirectory("plugins/yui-chat/filters/core")
  assert(browsedResources.entries.some(item => item.reference === "plugin:yui-chat/filters/core/registry.ts"), "framework resource browser should return selectable project source references")
  assert(!browsedResources.entries.some(item => item.name.startsWith(".")), "framework resource browser should hide dotfiles")
  let traversalBlocked = false
  try {
    await browseFrameworkResourceDirectory("../")
  } catch (err) {
    traversalBlocked = /上级目录|超出/.test(err.message)
  }
  assert(traversalBlocked, "framework resource browser should reject traversal outside Yunzai")
  const currentFilterManifest = {
    id: "smoke-ai-filter",
    name: "Smoke Filter",
    enabled: true,
    frameworkResources: {},
    filters: [{
      id: "smoke_ai_filter_transform",
      stages: ["output"],
      effects: ["pure"],
      parameters: { type: "object", properties: {} },
    }],
  }
  const generatedManifest = {
    ...currentFilterManifest,
    name: "Generated Smoke Filter",
    filters: [{
      id: "model_changed_id",
      stages: ["input"],
      effects: ["network"],
      parameters: { type: "object", properties: { suffix: { type: "string" } } },
    }],
  }
  const parsedDraft = parseGeneratedFilterDraft([
    "<FILTER_MANIFEST>",
    JSON.stringify(generatedManifest),
    "</FILTER_MANIFEST>",
    "<FILTER_SOURCE>",
    "export function createFilters() { return [{ id: \"smoke_ai_filter_transform\", stages: [\"output\"], effects: [\"pure\"], async apply({ text }) { return { kind: \"text\", text } } }] }",
    "</FILTER_SOURCE>",
    "<FILTER_NOTES>smoke draft</FILTER_NOTES>",
  ].join("\n"), currentFilterManifest)
  assert(parsedDraft.manifest.id === currentFilterManifest.id && parsedDraft.manifest.filters[0].id === currentFilterManifest.filters[0].id, "AI filter drafts must preserve package and implementation IDs")
  assert(parsedDraft.manifest.filters[0].stages[0] === "output" && parsedDraft.manifest.filters[0].effects[0] === "pure", "AI filter drafts must preserve configured stages and effects")
  assert(buildFilterAuthoringPrompt({ requirement: "trim text", manifest: currentFilterManifest, source: parsedDraft.source }).includes("trim text"), "filter authoring prompt should include the administrator requirement")
  const examplePackage = await customToolManager.getPackage("framework-block-example")
  assert(examplePackage.validation.ok && examplePackage.manifest.enabled === false, "framework block demo should be valid and disabled by default")
  const exampleResult = await customToolManager.testTool("framework-block-example", "status_command_help", {})
  assert(exampleResult.result.includes("#发言榜"), "disabled Custom packages should be testable from the management surface")
  await checkExtensionCreateFlow()
}

// 新建扩展：模板只是草稿，保存时才落盘，目录 ID 由内容特征推导。
async function checkExtensionCreateFlow() {
  const { deriveExtensionId } = await import("../output/runtime/core/shared/identifiers.js")
  const { customToolManager, customToolsDir } = await import("../output/runtime/tools/custom/manager.js")
  const { createSkillPackage, createSkillTemplate, deleteSkillPackage, listSkills } = await import("../output/runtime/skills/index.js")
  assert(deriveExtensionId(["stock_query", "库存查询"], "custom-tool", []) === "stock-query", "extension IDs should come from the first usable ASCII stem")
  assert(deriveExtensionId(["stock_query"], "custom-tool", ["stock-query"]) === "stock-query-2", "derived extension IDs should avoid occupied directories")
  const chineseOnly = deriveExtensionId(["", "库存查询"], "custom-tool", [])
  assert(/^custom-tool-[a-z0-9]+$/.test(chineseOnly) && chineseOnly === deriveExtensionId(["", "库存查询"], "custom-tool", []), "names without an ASCII stem should fall back to a stable hashed ID")

  const listPackageIds = async () => (await customToolManager.listPackages()).map(item => item.id).sort()
  const createdTools = []
  const createdSkills = []
  try {
    const beforeTools = await listPackageIds()
    const template = await customToolManager.createTemplate("smoke-create-draft", { dryRun: true })
    assert(Boolean(template.manifest && template.source), "dry-run custom template should return editable manifest and source")
    assert(JSON.stringify(await listPackageIds()) === JSON.stringify(beforeTools), "dry-run custom template must not create a package directory")

    const manifest = JSON.parse(JSON.stringify(template.manifest))
    manifest.name = "库存查询"
    manifest.tools[0].name = "smoke_stock_query"
    const created = await customToolManager.createPackage({ manifest, source: template.source.replace(template.toolName, "smoke_stock_query") })
    createdTools.push(created.id)
    assert(created.id === "smoke-stock-query" && created.manifest.id === created.id, "saving a custom draft should derive the directory ID from the tool name")
    assert(created.validation.ok, "a saved custom draft should pass manifest validation")

    const beforeSkills = (await listSkills()).map(item => item.id).sort()
    const skillTemplate = await createSkillTemplate("smoke-create-draft", { dryRun: true })
    assert(Boolean(skillTemplate.metadata?.name && skillTemplate.body), "dry-run skill template should return editable metadata and body")
    assert(JSON.stringify((await listSkills()).map(item => item.id).sort()) === JSON.stringify(beforeSkills), "dry-run skill template must not create a skill directory")

    const skill = await createSkillPackage({
      manifest: { name: "smoke-weekly-report", description: "当用户需要生成本周进展汇总时使用。", enabled: true },
      source: skillTemplate.body,
    })
    createdSkills.push(skill.id)
    assert(skill.id === "smoke-weekly-report" && skill.manifest.enabled, "saving a skill draft should derive the directory ID from the skill name")
    assert(skill.validation.ok, "a saved skill draft should pass SKILL.md validation")

    let rejected = ""
    await createSkillPackage({ manifest: { name: "smoke-broken-skill", description: "" }, source: "" }).catch(err => { rejected = err.message })
    assert(rejected, "an invalid skill draft should be rejected before any directory is created")
    assert(!(await listSkills()).some(item => item.id === "smoke-broken-skill"), "a rejected skill draft must not leave a directory behind")
  } finally {
    for (const id of createdTools) await fs.rm(path.join(customToolsDir, id), { recursive: true, force: true })
    for (const id of createdSkills) await deleteSkillPackage(id).catch(() => {})
  }
}

async function checkNetworkTools() {
  const { fetchSafeHttp } = await import("../output/runtime/core/network/safe-http-client.js")
  const { errorDetails, errorSummary } = await import("../output/runtime/core/shared/error-details.js")
  const { assertSafeHttpUrl, isPrivateIp } = await import("../output/runtime/core/network/link-safety-policy.js")
  const { WebsiteFetchTool } = await import("../output/runtime/tools/builtins/network.js")
  const { fetchJson } = await import("../output/runtime/tools/builtins/shared.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  const config = await configStore.load()
  const transportError = Object.assign(new TypeError("fetch failed"), {
    cause: new AggregateError([
      Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET", address: "203.0.113.10", port: 443 }),
      Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT", address: "2001:db8::10", port: 443 }),
    ], "all connection attempts failed"),
    yuiNetwork: { target: "https://example.com/responses?api_key=smoke-secret", method: "POST", timeoutMs: 90000, responseReceived: false },
  })
  const transportDetails = errorDetails(transportError)
  const transportSummary = errorSummary(transportError)
  assert(transportDetails.cause?.causes?.length === 2 && transportSummary.includes("ECONNRESET") && transportSummary.includes("ETIMEDOUT"), "network error diagnostics should preserve AggregateError connection causes")
  assert(!transportSummary.includes("smoke-secret") && !String(transportDetails.target).includes("smoke-secret"), "network error diagnostics must redact credentials")
  let blocked = false
  try {
    await assertSafeHttpUrl("http://127.0.0.1:2536/yui-chat", config.tools.builtin.websiteFetch)
  } catch {
    blocked = true
  }
  assert(blocked, "safe URL helper should block localhost by default")
  assert(isPrivateIp("[::1]") && isPrivateIp("::ffff:7f00:1"), "safe URL helper should recognize bracketed and mapped loopback IPv6")
  const credentialError = await assertSafeHttpUrl("https://user:secret@example.com/").catch(err => err.message)
  assert(credentialError.includes("用户名或密码"), "safe URL helper should reject credentials embedded in URLs")
  const tool = new WebsiteFetchTool()
  const restrictedConfig = JSON.parse(JSON.stringify(config))
  restrictedConfig.security.linkSafety.allowPrivateHosts = false
  const result = await tool.execute({ url: "http://127.0.0.1:2536/yui-chat" }, { config: restrictedConfig })
  assert(result.includes("禁止") || result.includes("localhost") || result.includes("私网"), "website_fetch should reject localhost/private URLs when the centralized policy is closed")
  const normalized = await assertSafeHttpUrl("https://example.com/path?q=1", { ...config.tools.builtin.websiteFetch, allowPrivateHosts: true })
  assert(normalized === "https://example.com/path?q=1", "safe URL helper should preserve a valid https URL")
  const { createServer } = await import("node:http")
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/ok" })
      res.end()
      return
    }
    if (req.url === "/large") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("x".repeat(2048))
      return
    }
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("safe-http-ok")
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const redirected = await fetchSafeHttp(`${baseUrl}/redirect`, { allowPrivateHosts: true, maxBytes: 1024, timeoutMs: 1000 })
    assert(redirected.redirected && await redirected.text() === "safe-http-ok", "safe HTTP client should follow and record validated redirects")
    const sizeError = await fetchSafeHttp(`${baseUrl}/large`, { allowPrivateHosts: true, maxBytes: 1024, timeoutMs: 1000 }).catch(err => err.message)
    assert(sizeError.includes("响应大小超过限制"), "safe HTTP client should stop oversized response bodies")
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
  const originalFetch = global.fetch
  try {
    global.fetch = async url => {
      if (String(url).includes("/broken-json")) {
        return new Response("gateway broken", { status: 502, headers: { "content-type": "text/plain" } })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const error = await fetchJson("https://example.com/broken-json").catch(err => err.message)
    assert(error.includes("gateway broken"), "fetchJson should surface plain-text HTTP errors without rereading body")
    const { GitHubApiTool, WeatherTool } = await import("../output/runtime/tools/builtins/network.js")
    const weatherTool = new WeatherTool()
    assert(weatherTool.configSchema?.properties?.amapKey?.secret === true, "weather tool should declare amapKey as a secret runtime variable")
    const weatherMissing = await weatherTool.execute({ city: "北京" }, { toolConfig: {} })
    assert(weatherMissing.includes("运行变量"), "weather tool without a key should point to runtime variables")
    let weatherKeyUsed = ""
    global.fetch = async url => {
      weatherKeyUsed = String(url).match(/key=([^&]+)/)?.[1] || weatherKeyUsed
      if (String(url).includes("/config/district")) return new Response(JSON.stringify({ districts: [{ name: "北京市", adcode: "110000" }] }), { status: 200, headers: { "content-type": "application/json" } })
      return new Response(JSON.stringify({ lives: [{ weather: "晴" }] }), { status: 200, headers: { "content-type": "application/json" } })
    }
    await weatherTool.execute({ city: "北京" }, { toolConfig: { amapKey: "smoke-runtime-amap" } })
    assert(weatherKeyUsed === "smoke-runtime-amap", "weather tool must read amapKey from context.toolConfig")
    const githubTool = new GitHubApiTool()
    assert(githubTool.configSchema?.properties?.token?.secret === true, "github tool should declare token as a secret runtime variable")
    let githubAuth = ""
    global.fetch = async (url, options = {}) => {
      githubAuth = String(options.headers?.Authorization || "")
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    }
    await githubTool.execute({ path: "/rate_limit" }, { toolConfig: { token: "smoke-runtime-gh" } })
    assert(githubAuth === "Bearer smoke-runtime-gh", "github tool must read token from context.toolConfig")
    const { WebSearchTool } = await import("../output/runtime/tools/builtins/web-search.js")
    const webSearchTool = new WebSearchTool()
    assert(webSearchTool.configSchema?.properties?.baiduApiKey?.secret === true && webSearchTool.configSchema?.properties?.tavilyApiKey?.secret === true, "web_search should declare both provider keys as secret runtime variables")
    const searchConfig = JSON.parse(JSON.stringify(config))
    searchConfig.tools.builtin.webSearch = { defaultSource: "baidu-ai", enabledSources: ["baidu-ai", "tavily"], strategy: "fallback", maxResults: 5, timeoutMs: 1000 }
    let searchCalls = []
    global.fetch = async (url, options = {}) => {
      searchCalls.push({ url: String(url), auth: String(options.headers?.Authorization || "") })
      if (String(url).includes("qianfan.baidubce.com")) return new Response("baidu unavailable", { status: 503, headers: { "content-type": "text/plain" } })
      return new Response(JSON.stringify({ results: [{ title: "Tavily result", url: "https://example.com/tavily", content: "current answer", score: 0.9 }] }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const webResult = await webSearchTool.execute({ query: "current smoke result", source: "auto" }, { config: searchConfig, toolConfig: { baiduApiKey: "smoke-baidu", tavilyApiKey: "smoke-tavily" } })
    assert(webResult.content?.source === "tavily" && webResult.content?.results?.[0]?.url === "https://example.com/tavily", "web_search should fall back from Baidu AI to Tavily")
    assert(!Object.hasOwn(webResult, "source") && webResult.content && !Object.hasOwn(webResult.content, "content"), "web_search should expose one structured content payload without duplicating the result at the top level")
    assert(webResult.metadata?.messageSendAppendPlan?.parts?.[0]?.type === "forward" && webResult.metadata.messageSendAppendPlan.parts[0].nodes?.[0]?.parts?.[0]?.text?.includes("https://example.com/tavily"), "web_search should prepare every source as merged-forward nodes for the following message_send")
    assert(searchCalls.length === 2 && searchCalls[0].auth === "Bearer smoke-baidu" && searchCalls[1].auth === "Bearer smoke-tavily", "web_search should route each provider with its own secret key")
    global.fetch = async url => String(url).includes("qianfan.baidubce.com")
      ? new Response(JSON.stringify({ references: [{ title: "Baidu result", url: "https://example.com/baidu", content: "baidu answer" }] }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ results: [{ title: "Tavily result", url: "https://example.com/tavily", content: "tavily answer" }] }), { status: 200, headers: { "content-type": "application/json" } })
    const parallelResult = await webSearchTool.execute({ query: "parallel smoke", searchMode: "deep", maxResults: 3 }, {
      config: searchConfig,
      toolConfig: { baiduApiKey: "smoke-baidu", tavilyApiKey: "smoke-tavily" },
      searchCapabilities: { webSearch: { hosted: async () => ({
        text: "hosted answer",
        sources: [
          { title: "Hosted result 1", url: "https://example.com/hosted-1", content: "" },
          { title: "Hosted result 2", url: "https://example.com/hosted-2", content: "" },
          { title: "Hosted result 3", url: "https://example.com/hosted-3", content: "" },
        ],
      }) } },
    })
    assert(parallelResult.content?.strategy === "parallel" && parallelResult.content?.results?.length === 3, "web_search deep mode should aggregate hosted and all enabled local channels")
    assert(parallelResult.content?.channelResults?.some(item => item.implementation === "openai:web_search" && item.resultKind === "assistant-message") && parallelResult.content?.channelResults?.filter(item => item.executionOwner === "agent" && item.resultKind === "search-results").length === 2, "parallel search should preserve implementation ownership and result kind in channel diagnostics")
    const parallelUrls = new Set(parallelResult.content?.results?.map(item => item.url))
    assert(parallelUrls.has("https://example.com/hosted-1") && parallelUrls.has("https://example.com/baidu") && parallelUrls.has("https://example.com/tavily"), "parallel search should preserve coverage from every successful channel before applying maxResults")
    assert(parallelResult.content?.hostedDigest === "hosted answer" && (JSON.stringify(parallelResult.content).match(/hosted answer/g) || []).length === 1, "parallel search should keep the hosted assistant digest once instead of copying it into every source")
  } finally {
    global.fetch = originalFetch
  }
}

async function checkProviderTemplates() {
  const { applyProviderBundle, buildProviderBundle, listProviderTemplates } = await import("../output/runtime/models/configuration/provider-templates.js")
  const { filterToolsForModel, modelToolAllowed, modelToolRoute } = await import("../output/runtime/models/configuration/tool-policy.js")
  const { buildModelToolPolicyOptions, modelToolPolicyDraft, modelToolPolicyPatch } = await import("../output/runtime/web/client/features/providers/provider-tool-policy-editor.js")
  const { responsesModelDraft, responsesModelPatch } = await import("../output/runtime/web/client/features/providers/provider-responses-editor.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  const templates = listProviderTemplates()
  assert(templates.some(item => item.id === "qwen"), "provider templates should include qwen")
  assert(templates.some(item => item.id === "gemini"), "provider templates should include gemini")
  assert(templates.some(item => item.id === "claude"), "provider templates should include claude")
  assert(templates.some(item => item.id === "openai_responses"), "provider templates should include OpenAI Responses")
  assert(templates.find(item => item.id === "gemini")?.toolUse === true, "gemini template should expose tool use")
  assert(templates.find(item => item.id === "claude")?.toolUse === true, "claude template should expose tool use")
  assert(!templates.find(item => item.id === "openai_responses")?.responses?.toolSearch, "OpenAI Responses template should keep capability routing out of protocol-specific settings")
  const bundle = buildProviderBundle({ templateId: "qwen", apiKey: "test-key" })
  assert(bundle.provider.type === "qwen", "qwen template should build qwen provider")
  assert(bundle.model.visual === true && bundle.model.toolUse === true, "qwen template should expose vision and tools")
  const config = JSON.parse(JSON.stringify(await configStore.load()))
  const next = applyProviderBundle(config, bundle)
  assert(next.apiProviders.some(item => item.name === bundle.provider.name), "provider bundle should add provider")
  assert(next.models.some(item => item.name === bundle.model.name), "provider bundle should add model")
  assert(next.modelTasks[bundle.taskName].modelList.includes(bundle.model.name), "provider bundle should attach model to task")
  assert(validateConfig(next).ok, "provider template config should validate")
  const responsesBundle = buildProviderBundle({ templateId: "openai_responses", apiKey: "test-key" })
  const responsesConfig = applyProviderBundle(config, responsesBundle)
  assert(validateConfig(responsesConfig).ok, "OpenAI Responses template config should validate")
  const invalidFileSearch = JSON.parse(JSON.stringify(responsesConfig))
  const responsesModel = invalidFileSearch.models.find(item => item.name === responsesBundle.model.name)
  responsesModel.responses.fileSearch = { enabled: true, vectorStoreIds: [] }
  assert(!validateConfig(invalidFileSearch).ok, "Responses file search should require at least one Vector Store ID")
  const allowlistModel = { toolPolicy: { mode: "allowlist", allow: ["message_send", "web_search"], routes: { web_search: { source: "hosted", strategy: "parallel" }, tool_search: { source: "disabled" } } } }
  assert(filterToolsForModel([{ name: "message_send" }, { name: "web_search" }], allowlistModel).map(item => item.name).join(",") === "message_send,web_search", "model allowlists should govern a stable capability shared by local and hosted implementations")
  assert(modelToolAllowed(allowlistModel, "openai:web_search") && !modelToolAllowed(allowlistModel, "openai:tool_search"), "model allowlists should distinguish hosted tool identities")
  assert(!modelToolAllowed({ toolPolicy: { mode: "allowlist", allow: ["openai:web_search"] } }, "openai:web_search"), "implementation-prefixed configuration should not be accepted as a compatibility alias")
  assert(modelToolRoute(allowlistModel, "web_search").source === "hosted" && modelToolRoute(allowlistModel, "web_search").strategy === "parallel" && modelToolRoute(allowlistModel, "tool_search").source === "disabled", "model capability routes should normalize source and strategy independently")
  const toolPolicyDraft = modelToolPolicyDraft({ mode: "allowlist", allow: ["message_send", "web_search", "message_send"], routes: { web_search: { source: "local", strategy: "parallel" } } })
  assert(Array.isArray(toolPolicyDraft.toolPolicyAllow) && toolPolicyDraft.toolPolicyAllow.join(",") === "message_send,web_search", "model tool policy editor should keep canonical allowlist selections as a deduplicated multi-select value")
  const toolPolicyPatch = modelToolPolicyPatch({ ...toolPolicyDraft, toolPolicyAllow: ["web_search", "message_send", "web_search"] })
  assert(toolPolicyPatch.allow.join(",") === "web_search,message_send" && toolPolicyPatch.routes.web_search.source === "local" && toolPolicyPatch.routes.web_search.strategy === "parallel", "model tool policy editor should persist canonical capability routes without protocol-specific duplicates")
  const policyOptions = buildModelToolPolicyOptions({ tools: [
    { name: "image_media", enabled: false, common: { source: "builtin", displayNameZh: "图片搜索" } },
    { name: "message_send", enabled: true, common: { source: "builtin", displayNameZh: "消息发送" } },
  ] }, { tools: { enabled: true, hosted: { openai: { enabled: true, webSearch: { enabled: false }, fileSearch: { enabled: true }, toolSearch: { enabled: true } } } } }, ["image_media", "unknown_saved_tool"])
  assert(!policyOptions.some(item => item.value === "image_media" || item.value === "openai:web_search") && policyOptions.some(item => item.value === "message_send"), "model policy selectors should exclude globally disabled local and hosted tools")
  assert(policyOptions.some(item => item.value === "unknown_saved_tool"), "model policy selectors should retain unknown saved ids so administrators can remove them")
  const consolidatedResponses = responsesModelPatch(responsesModelDraft({}), "smoke-responses")
  assert(!("enabled" in consolidatedResponses.webSearch) && !("toolSearch" in consolidatedResponses), "Responses settings should not duplicate capability routing or enable switches")
  const invalidToolPolicy = JSON.parse(JSON.stringify(responsesConfig))
  invalidToolPolicy.models.find(item => item.name === responsesBundle.model.name).toolPolicy = { mode: "both", allow: [""], sources: { webSearch: "somewhere" } }
  assert(!validateConfig(invalidToolPolicy).ok, "invalid model tool policies should be rejected at the config boundary")
  const invalidImplementationId = JSON.parse(JSON.stringify(responsesConfig))
  invalidImplementationId.models.find(item => item.name === responsesBundle.model.name).toolPolicy = { mode: "allowlist", allow: ["openai:web_search"], routes: {} }
  assert(!validateConfig(invalidImplementationId).ok, "model tool policy lists should reject implementation-prefixed legacy ids")
  const invalidResponsesState = JSON.parse(JSON.stringify(responsesConfig))
  invalidResponsesState.models.find(item => item.name === responsesBundle.model.name).responses.stateMode = "proxy_magic"
  assert(!validateConfig(invalidResponsesState).ok, "unknown Responses state modes should be rejected at the config boundary")
}

async function checkAdapterToolProtocol() {
  const {
    adapterRegistry,
    messagesToClaudeMessages,
    messagesToGeminiContents,
    parseClaudeToolCalls,
    parseGeminiToolCalls,
  } = await import("../output/runtime/models/adapters/registry.js")
  const { parseClaudeStreamResponse } = await import("../output/runtime/models/adapters/claude.js")
  const { parseGeminiStreamResponse } = await import("../output/runtime/models/adapters/gemini.js")
  const { parseResponsesStreamResponse } = await import("../output/runtime/models/adapters/openai/responses/response-adapter.js")
  const { buildReasoningPayload } = await import("../output/runtime/models/configuration/reasoning.js")
  const adapters = adapterRegistry.listAdapters()
  assert(adapters.find(item => item.id === "gemini")?.supportsTools === true, "gemini adapter should support tools")
  assert(adapters.find(item => item.id === "claude")?.supportsTools === true, "claude adapter should support tools")
  assert(adapters.find(item => item.id === "openai-compatible")?.supportsStreaming === true, "OpenAI-compatible adapter should declare streaming support")
  assert(adapters.find(item => item.id === "openai-responses")?.supportsStreaming === true, "OpenAI Responses adapter should declare streaming support")
  assert(adapters.find(item => item.id === "gemini")?.supportsStreaming === true, "Gemini adapter should declare streaming support")
  assert(adapters.find(item => item.id === "claude")?.supportsStreaming === true, "Claude adapter should declare streaming support")
  assert(adapters.find(item => item.id === "openai-responses")?.supportsNativeToolSearch === true, "OpenAI Responses adapter should declare native tool search support")
  assert(adapters.find(item => item.id === "openai-responses")?.protocol === "responses" && adapters.find(item => item.id === "claude")?.protocol === "claude-messages" && adapters.find(item => item.id === "gemini")?.protocol === "gemini-generate-content", "adapter diagnostics should expose the actual upstream conversation protocol")
  const mockModels = await adapterRegistry.listModels({ id: "mock", type: "mock" })
  assert(mockModels.adapter === "mock" && mockModels.models.some(item => item.id === "mock"), "adapter registry should support listing models from adapters")
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "帮我查指令" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "command_search", arguments: JSON.stringify({ query: "体力", limit: 3 }) },
      }],
    },
    { role: "tool", tool_call_id: "call_1", name: "command_search", content: "建议 #体力" },
  ]
  const gemini = messagesToGeminiContents(messages)
  assert(gemini.some(item => item.role === "model" && item.parts.some(part => part.functionCall?.name === "command_search")), "gemini messages should include functionCall")
  assert(gemini.some(item => item.role === "user" && item.parts.some(part => part.functionResponse?.name === "command_search")), "gemini messages should include functionResponse")
  const claude = messagesToClaudeMessages(messages)
  assert(claude.some(item => item.role === "assistant" && item.content.some(part => part.type === "tool_use" && part.name === "command_search")), "claude messages should include tool_use")
  assert(claude.some(item => item.role === "user" && item.content.some(part => part.type === "tool_result" && part.tool_use_id === "call_1")), "claude messages should include tool_result")
  const geminiCalls = parseGeminiToolCalls({ candidates: [{ content: { parts: [{ functionCall: { name: "command_search", args: { query: "体力" } } }] } }] })
  assert(geminiCalls[0]?.name === "command_search" && geminiCalls[0]?.arguments?.query === "体力", "gemini response should parse tool calls")
  const claudeCalls = parseClaudeToolCalls({ content: [{ type: "tool_use", id: "toolu_1", name: "command_search", input: { query: "体力" } }] })
  assert(claudeCalls[0]?.id === "toolu_1" && claudeCalls[0]?.arguments?.query === "体力", "claude response should parse tool calls")
  const openaiReasoning = buildReasoningPayload({ type: "openai-compatible", model: "gpt-5-mini", reasoning: { effort: "medium" } })
  assert(openaiReasoning?.reasoning?.effort === "medium", "openai reasoning helper should emit reasoning.effort")
  const deepseekReasoning = buildReasoningPayload({ type: "openai-compatible", model: "deepseek-reasoner", reasoning: { effort: "high" } })
  assert(deepseekReasoning?.reasoning_effort === "high" && deepseekReasoning?.thinking?.type === "enabled", "deepseek reasoning helper should emit thinking + reasoning_effort")
  const claudeReasoning = buildReasoningPayload({ type: "claude", model: "claude-sonnet", reasoning: { effort: "low" } })
  assert(claudeReasoning?.thinking?.effort === "low", "claude reasoning helper should emit thinking.effort")

  const originalFetch = global.fetch
  let streamedRequest
  try {
    global.fetch = async (_url, options = {}) => {
      streamedRequest = JSON.parse(String(options.body || "{}"))
      const source = [
        'data: {"id":"stream_1","choices":[{"delta":{"content":"你"}}]}',
        'data: {"id":"stream_1","choices":[{"delta":{"content":"好","tool_calls":[{"index":0,"id":"call_stream","function":{"name":"command_","arguments":"{\\"query\\":"}}]}}]}',
        'data: {"id":"stream_1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"search","arguments":"\\"体力\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
        "data: [DONE]",
        "",
      ].join("\n\n")
      return new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const streamed = await adapterRegistry.get("openai-compatible").sendMessage({
      channel: {
        id: "stream-smoke",
        type: "openai-compatible",
        model: "grok-smoke",
        baseURL: "https://stream.example/v1",
        authType: "none",
        params: { temperature: 0.2 },
        timeoutMs: 5000,
        stream: true,
      },
      messages: [{ role: "user", content: "测试" }],
      tools: [{ name: "command_search", description: "Search commands.", parameters: { type: "object", properties: {} }, async execute() {} }],
      toolChoice: { type: "function", name: "command_search" },
      maxTokens: 64,
    })
    assert(streamedRequest.stream === true && streamedRequest.temperature === 0.2, "streaming model request should send stream=true with model params")
    assert(streamedRequest.tool_choice?.function?.name === "command_search", "OpenAI-compatible requests should map a forced function choice")
    assert(streamed.text === "你好", "OpenAI-compatible SSE parser should combine content deltas")
    assert(streamed.toolCalls[0]?.name === "command_search" && streamed.toolCalls[0]?.arguments?.query === "体力", "OpenAI-compatible SSE parser should combine tool-call deltas")
    assert(streamed.stopReason === "tool_calls", "OpenAI-compatible SSE parser should preserve the structured finish reason")
    assert(streamed.usage.total === 6, "OpenAI-compatible SSE parser should keep final token usage")

    let responsesUrl
    let responsesRequest
    global.fetch = async (url, options = {}) => {
      responsesUrl = String(url)
      responsesRequest = JSON.parse(String(options.body || "{}"))
      return new Response(JSON.stringify({
        id: "resp_smoke",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_smoke", encrypted_content: "encrypted-smoke" },
          { type: "web_search_call", id: "ws_smoke", status: "completed", action: { query: "体力 指令", sources: [{ title: "Example", url: "https://example.com" }] } },
          { type: "file_search_call", id: "fs_smoke", status: "completed", queries: ["体力指令"], results: [{ file_id: "file-smoke" }] },
          { type: "tool_search_call", id: "ts_smoke", status: "completed", execution: "server", arguments: { goal: "查找指令工具" } },
          { type: "tool_search_output", id: "tso_smoke", status: "completed", tools: [{ type: "function", name: "command_search" }] },
          { type: "function_call", id: "fc_smoke", call_id: "call_responses", name: "command_search", arguments: JSON.stringify({ query: "体力" }) },
        ],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const responses = await adapterRegistry.get("openai-responses").sendMessage({
      channel: {
        id: "responses-smoke",
        type: "openai-responses",
        model: "gpt-5.4",
        baseURL: "https://responses.example/v1",
        authType: "none",
        timeoutMs: 5000,
        responsesRuntime: { stateMode: "local", toolSearchAllowed: true, webSearchAllowed: true, fileSearchAllowed: true },
        modelConfig: {
          responses: {
            store: false,
            webSearch: { enabled: true },
            toolSearch: { enabled: true },
            fileSearch: { enabled: true, vectorStoreIds: ["vs_smoke"], maxNumResults: 4 },
          },
        },
      },
      messages: [{ role: "user", content: "查一下体力指令" }],
      tools: [
        { name: "tool_search", description: "Local fallback discovery.", parameters: { type: "object", properties: {} }, async execute() {} },
        { name: "web_search", description: "Local fallback web search.", parameters: { type: "object", properties: {} }, async execute() {} },
        { name: "command_search", description: "Search commands. Use for command lookup.", deferLoading: true, execution: { effect: "read" }, parameters: { type: "object", properties: { query: { type: "string" } } }, async execute() {} },
      ],
      maxTokens: 96,
    })
    assert(responsesUrl.endsWith("/v1/responses"), "Responses adapter should call the /responses endpoint")
    assert(responsesRequest.input?.[0]?.role === "user" && responsesRequest.max_output_tokens === 96 && responsesRequest.store === false, "Responses request should map conversation input and output limits without changing local conversation ownership")
    assert(responsesRequest.tools.some(tool => tool.type === "web_search") && responsesRequest.tools.some(tool => tool.type === "file_search" && tool.vector_store_ids?.[0] === "vs_smoke"), "Responses request should include configured hosted search tools")
    assert(responsesRequest.tools.some(tool => tool.type === "tool_search") && responsesRequest.tools.some(tool => tool.type === "function" && tool.name === "command_search" && tool.defer_loading === true), "Responses request should expose deferred local functions through hosted tool search")
    const deferredCommand = responsesRequest.tools.find(tool => tool.type === "function" && tool.name === "command_search")
    assert(deferredCommand.description.includes("Do not") && deferredCommand.description.includes("read-only"), "Responses functions should receive decision-oriented descriptions with non-use guidance and side-effect semantics")
    assert(!responsesRequest.tools.some(tool => tool.type === "function" && ["tool_search", "web_search"].includes(tool.name)), "Responses request should not duplicate hosted tools as local functions")
    assert(responsesRequest.tool_choice === undefined && responsesRequest.include.includes("reasoning.encrypted_content"), "Responses request should request stateless reasoning replay data without forcing an unrelated function")
    assert(responsesRequest.include.includes("web_search_call.action.sources") && responsesRequest.include.includes("file_search_call.results"), "Responses hosted searches should request source and file result details for local forwarding and audit")
    assert(responses.stopReason === "tool_calls" && responses.toolCalls[0]?.id === "call_responses" && responses.toolCalls[0]?.arguments?.query === "体力", "Responses output should normalize native function calls for the existing executor")
    assert(responses.protocol?.outputItems?.some(item => item.type === "reasoning") && responses.usage.cached === 2 && responses.usage.reasoning === 1, "Responses output should preserve replay items and detailed usage")
    assert(responses.hostedToolCalls?.map(item => item.type).join(",") === "web_search_call,file_search_call,tool_search_call,tool_search_output", "Responses output should expose safe hosted-tool audit summaries")
    assert(responses.hostedToolCalls?.[0]?.query === "体力 指令" && responses.hostedToolCalls?.[1]?.resultCount === 1 && responses.hostedToolCalls?.[3]?.loadedTools?.[0] === "command_search", "hosted-tool summaries should preserve useful audit metadata")
    assert(responses.hostedToolCalls?.[0]?.raw?.action?.sources?.[0]?.url === "https://example.com", "Responses hosted tools should retain the upstream output item for bounded audit logging")
    assert(responses.hostedSearchSources?.[0]?.title === "Example" && responses.hostedSearchSources?.[0]?.url === "https://example.com", "Responses hosted web search should expose normalized sources for the output layer")
    assert(responses.upstreamResponseId === "resp_smoke", "Responses output should expose the upstream response id separately from local conversation history")

    let responsesStreamRequest
    global.fetch = async (_url, options = {}) => {
      responsesStreamRequest = JSON.parse(String(options.body || "{}"))
      const source = [
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_stream","status":"in_progress"}}',
        '',
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_stream","role":"assistant","content":[{"type":"output_text","text":""}]}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","item_id":"msg_stream","output_index":0,"delta":"你"}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","item_id":"msg_stream","output_index":0,"delta":"好"}',
        '',
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_stream","call_id":"call_stream","name":"command_search","arguments":""}}',
        '',
        'event: response.function_call_arguments.delta',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_stream","output_index":1,"delta":"{\\"query\\":"}',
        '',
        'event: response.function_call_arguments.delta',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_stream","output_index":1,"delta":"\\"体力\\"}"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
        '',
      ].join("\n")
      return new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const streamedResponses = await adapterRegistry.get("openai-responses").sendMessage({
      channel: {
        id: "responses-stream-smoke",
        type: "openai-responses",
        model: "gpt-5.4",
        baseURL: "https://responses.example/v1",
        authType: "none",
        timeoutMs: 5000,
        stream: true,
        responsesRuntime: { stateMode: "local" },
        modelConfig: { responses: { store: false } },
      },
      messages: [{ role: "user", content: "流式测试" }],
      tools: [{ name: "command_search", description: "Search commands.", parameters: { type: "object", properties: {} }, async execute() {} }],
      maxTokens: 64,
    })
    assert(responsesStreamRequest.stream === true, "Responses streaming requests should send stream=true")
    assert(streamedResponses.text === "你好" && streamedResponses.toolCalls[0]?.name === "command_search" && streamedResponses.toolCalls[0]?.arguments?.query === "体力", "Responses semantic SSE should combine text and function argument deltas")
    assert(streamedResponses.upstreamResponseId === "resp_stream" && streamedResponses.usage.total === 6 && streamedResponses.stopReason === "tool_calls", "Responses semantic SSE should preserve response id, usage and tool stop reason")

    const { buildResponsesRequest, messagesForResponses } = await import("../output/runtime/models/adapters/openai/responses/request-adapter.js")
    const forcedDirectRequest = buildResponsesRequest({
      channel: {
        id: "responses-forced-function",
        type: "openai-responses",
        model: "gpt-5.4",
        responsesRuntime: { stateMode: "local", toolSearchAllowed: true },
        modelConfig: { responses: { stateMode: "local" } },
      },
      messages: [{ role: "user", content: "必须直接搜索" }],
      tools: [{ name: "command_search", description: "Search commands.", deferLoading: true, parameters: { type: "object", properties: {} }, async execute() {} }],
      toolChoice: { type: "function", name: "command_search" },
    })
    assert(forcedDirectRequest.tool_choice?.name === "command_search" && !forcedDirectRequest.tools.some(tool => tool.type === "tool_search") && forcedDirectRequest.tools.find(tool => tool.name === "command_search")?.defer_loading === undefined, "a forced Responses function should be eagerly loaded without a redundant tool-search step")
    const failClosedRequest = buildResponsesRequest({
      channel: {
        id: "responses-fail-closed",
        type: "openai-responses",
        model: "gpt-5.4",
        modelConfig: { responses: { webSearch: { enabled: true }, toolSearch: { enabled: true }, fileSearch: { enabled: true, vectorStoreIds: ["vs_closed"] } } },
      },
      messages: [{ role: "user", content: "不得自动联网" }],
      tools: [{ name: "command_search", description: "Search commands.", deferLoading: true, parameters: { type: "object", properties: {} }, async execute() {} }],
    })
    assert(!failClosedRequest.tools?.some(tool => ["web_search", "file_search", "tool_search"].includes(tool.type)), "Responses hosted tools should fail closed when runtime permission context is absent")
    assert(!failClosedRequest.tools?.some(tool => tool.type === "function" && tool.defer_loading === true), "Responses functions should be eagerly loaded when hosted tool_search is unavailable")

    const linkedRequest = buildResponsesRequest({
      channel: {
        id: "responses-linked",
        type: "openai-responses",
        model: "gpt-5.4",
        params: { conversation: "must-not-leak", previous_response_id: "must-not-leak" },
        responsesRuntime: { stateMode: "previous_response_id", previousResponseId: "resp_previous" },
        modelConfig: { responses: { stateMode: "previous_response_id", store: false } },
      },
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "旧问题" },
        { role: "assistant", content: "旧回答" },
        { role: "user", content: "新问题" },
      ],
      maxTokens: 64,
    })
    assert(linkedRequest.previous_response_id === "resp_previous" && linkedRequest.store === true, "upstream Responses state mode should force storage and link the prior response")
    assert(linkedRequest.instructions === "system prompt", "linked Responses requests should resend current system instructions explicitly")
    assert(linkedRequest.input?.length === 1 && linkedRequest.input[0]?.role === "user" && JSON.stringify(linkedRequest.input).includes("新问题") && !JSON.stringify(linkedRequest.input).includes("旧问题"), "linked Responses requests should send only incremental conversation input")
    assert(linkedRequest.conversation === undefined, "model params must not inject a competing Responses conversation id")

    const replay = messagesForResponses([
      { role: "assistant", content: "", protocol: responses.protocol, toolCalls: responses.toolCalls },
      { role: "tool", toolCallId: "call_responses", content: "建议 #体力" },
    ])
    assert(replay[0]?.type === "reasoning" && replay.some(item => item.type === "function_call") && replay.at(-1)?.type === "function_call_output", "Responses stateless replay should preserve original output items before local function outputs")
    const recoveryReplayMessages = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "旧问题" },
      { role: "assistant", content: "旧回答" },
      { role: "user", content: "查一下体力指令" },
      { role: "assistant", content: "", protocol: responses.protocol, toolCalls: responses.toolCalls },
      { role: "tool", toolCallId: "call_responses", content: "建议 #体力" },
      { role: "tool", toolCallId: "call_orphaned", content: "不应重放的孤立工具结果" },
    ]
    const linkedFallbackBodies = []
    global.fetch = async (_url, options = {}) => {
      const requestBody = JSON.parse(String(options.body || "{}"))
      linkedFallbackBodies.push(requestBody)
      if (linkedFallbackBodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "No tool call found for function call output with call_id call_responses." } }), { status: 400, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ id: "resp_recovered", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "已根据工具结果继续回答。" }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const recoveredLinkedResponse = await adapterRegistry.get("openai-responses").sendMessage({
      channel: {
        id: "responses-linked-recovery",
        type: "openai-responses",
        model: "gpt-5.4",
        baseURL: "https://responses.example/v1",
        authType: "none",
        timeoutMs: 5000,
        responsesRuntime: { stateMode: "auto", previousResponseId: "resp_missing_tool_state" },
        modelConfig: { responses: { stateMode: "auto", store: false } },
      },
      messages: [
        { role: "user", content: "查一下体力指令" },
        { role: "assistant", content: "", protocol: responses.protocol, toolCalls: responses.toolCalls },
        { role: "tool", toolCallId: "call_responses", content: "建议 #体力" },
      ],
      replayMessages: recoveryReplayMessages,
      maxTokens: 64,
    })
    assert(linkedFallbackBodies.length === 2 && linkedFallbackBodies[0].previous_response_id === "resp_missing_tool_state" && linkedFallbackBodies[1].previous_response_id === undefined, "Responses should retry without the upstream link when a proxy loses function-call state")
    assert(linkedFallbackBodies[1].input.some(item => item.type === "function_call") && linkedFallbackBodies[1].input.some(item => item.type === "function_call_output"), "Responses link recovery should replay the complete local function-call pair")
    assert(JSON.stringify(linkedFallbackBodies[1].input).includes("旧问题") && !JSON.stringify(linkedFallbackBodies[1].input).includes("call_orphaned"), "Responses link recovery should use the bounded local checkpoint and discard orphaned tool items")
    assert(recoveredLinkedResponse.upstreamStateReset === true && recoveredLinkedResponse.text.includes("继续回答") && recoveredLinkedResponse.responsesStateRecovery?.reason === "tool_call_link_missing" && recoveredLinkedResponse.responsesStateRecovery?.droppedToolItems === 1, "Responses auto recovery should establish a fresh upstream chain and expose recovery diagnostics")

    const strictToolRepairBodies = []
    global.fetch = async (_url, options = {}) => {
      const requestBody = JSON.parse(String(options.body || "{}"))
      strictToolRepairBodies.push(requestBody)
      if (strictToolRepairBodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "No tool call found for function call output with call_id call_responses." } }), { status: 400, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ id: "resp_strict_tool_repaired", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "工具已经完成，继续给出最终说明。" }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const strictToolRepaired = await adapterRegistry.get("openai-responses").sendMessage({
      channel: {
        id: "responses-linked-strict-tool-repair",
        type: "openai-responses",
        model: "gpt-5.4",
        baseURL: "https://responses.example/v1",
        authType: "none",
        timeoutMs: 5000,
        responsesRuntime: { stateMode: "previous_response_id", previousResponseId: "resp_strict_tool_parent" },
        modelConfig: { responses: { stateMode: "previous_response_id" } },
      },
      messages: [
        { role: "user", content: "查一下体力指令" },
        { role: "assistant", content: "", protocol: responses.protocol, toolCalls: responses.toolCalls },
        { role: "tool", toolCallId: "call_responses", content: "建议 #体力" },
      ],
      maxTokens: 64,
    })
    assert(strictToolRepairBodies.length === 2 && strictToolRepairBodies[0].previous_response_id === "resp_strict_tool_parent" && strictToolRepairBodies[1].previous_response_id === undefined, "strict Responses mode should repair a lost current-turn function-call link once without weakening ordinary chain failures")
    assert(strictToolRepairBodies[1].input.some(item => item.type === "function_call") && strictToolRepairBodies[1].input.some(item => item.type === "function_call_output"), "strict current-turn repair should replay the matched call and output pair without re-executing the tool")
    assert(strictToolRepaired.text.includes("最终说明") && strictToolRepaired.responsesStateRecovery?.reason === "tool_call_link_missing", "strict current-turn repair should let a required final reply complete and remain observable")

    let strictLinkedAttempts = 0
    global.fetch = async () => {
      strictLinkedAttempts++
      return new Response(JSON.stringify({ error: { message: "previous response resp_strict was not found", code: "previous_response_not_found" } }), { status: 400, headers: { "content-type": "application/json" } })
    }
    let strictLinkedError = ""
    try {
      await adapterRegistry.get("openai-responses").sendMessage({
        channel: {
          id: "responses-linked-strict",
          type: "openai-responses",
          model: "gpt-5.4",
          baseURL: "https://responses.example/v1",
          authType: "none",
          timeoutMs: 5000,
          responsesRuntime: { stateMode: "previous_response_id", previousResponseId: "resp_strict" },
          modelConfig: { responses: { stateMode: "previous_response_id" } },
        },
        messages: [{ role: "user", content: "严格链路" }],
        replayMessages: recoveryReplayMessages,
      })
    } catch (error) {
      strictLinkedError = String(error?.message || error)
    }
    assert(strictLinkedAttempts === 1 && strictLinkedError.includes("not found"), "strict previous_response_id mode should fail once and leave channel fallback to the caller")
    const { parseResponsesResponse } = await import("../output/runtime/models/adapters/openai/responses/response-adapter.js")
    const cited = parseResponsesResponse({
      id: "resp_cited",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "检索结论", annotations: [{ type: "url_citation", title: "Example", url: "https://example.com/source" }] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    assert(cited.stopReason === "end_turn" && cited.text === "检索结论", "Responses hosted web citations should not be duplicated inside the answer text")
    assert(cited.hostedSearchSources?.[0]?.title === "Example" && cited.hostedSearchSources?.[0]?.url === "https://example.com/source", "Responses URL annotations should be forwarded as structured hosted search sources")

    let embeddingRequest
    global.fetch = async (_url, options = {}) => {
      embeddingRequest = JSON.parse(String(options.body || "{}"))
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }], model: "embedding-smoke", usage: { prompt_tokens: 2, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const embeddingTest = await adapterRegistry.testChannel({
      id: "embedding-test",
      type: "openai-compatible",
      model: "embedding-smoke",
      baseURL: "https://embedding.example/v1",
      authType: "none",
      modelConfig: { capabilities: { chat: false, embedding: true }, embedding: { defaultDimensions: 2, supportsDimensionOverride: false } },
    })
    assert(embeddingTest.operation === "embedding" && embeddingTest.dimensions === 2 && embeddingTest.vectorCount === 1, "embedding model tests should use embedding requests and report vector dimensions")
    assert(embeddingRequest.input?.[0] === "embedding health check" && embeddingRequest.dimensions === undefined, "embedding model tests should omit unsupported dimension overrides")

    let claudeRequest
    global.fetch = async (_url, options = {}) => {
      claudeRequest = JSON.parse(String(options.body || "{}"))
      return new Response(JSON.stringify({ id: "claude-force", content: [], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } })
    }
    await adapterRegistry.get("claude").sendMessage({
      channel: { id: "claude-force", type: "claude", model: "claude-smoke", apiKey: "smoke", timeoutMs: 5000 },
      messages: [{ role: "user", content: "测试" }],
      tools: [{ name: "message_send", description: "Send.", parameters: { type: "object", properties: {} }, async execute() {} }],
      toolChoice: { type: "function", name: "message_send" },
      maxTokens: 64,
    })
    assert(claudeRequest.tool_choice?.type === "tool" && claudeRequest.tool_choice?.name === "message_send", "Claude requests should map a forced function choice")

    let geminiRequest
    global.fetch = async (_url, options = {}) => {
      geminiRequest = JSON.parse(String(options.body || "{}"))
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { status: 200, headers: { "content-type": "application/json" } })
    }
    await adapterRegistry.get("gemini").sendMessage({
      channel: { id: "gemini-force", type: "gemini", model: "gemini-smoke", apiKey: "smoke", timeoutMs: 5000 },
      messages: [{ role: "user", content: "测试" }],
      tools: [{ name: "message_send", description: "Send.", parameters: { type: "object", properties: {} }, async execute() {} }],
      toolChoice: { type: "function", name: "message_send" },
      maxTokens: 64,
    })
    assert(geminiRequest.toolConfig?.functionCallingConfig?.mode === "ANY" && geminiRequest.toolConfig?.functionCallingConfig?.allowedFunctionNames?.[0] === "message_send", "Gemini requests should map a forced function choice")

    let claudeStreamRequest
    global.fetch = async (_url, options = {}) => {
      claudeStreamRequest = JSON.parse(String(options.body || "{}"))
      const source = [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_stream","role":"assistant","content":[],"usage":{"input_tokens":3}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_stream","name":"command_search","input":{}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"体力\\"}"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join("\n")
      return new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const streamedClaude = await adapterRegistry.get("claude").sendMessage({
      channel: { id: "claude-stream", type: "claude", model: "claude-smoke", apiKey: "smoke", timeoutMs: 5000, stream: true },
      messages: [{ role: "user", content: "流式测试" }],
      tools: [{ name: "command_search", description: "Search.", parameters: { type: "object", properties: {} }, async execute() {} }],
      maxTokens: 64,
    })
    assert(claudeStreamRequest.stream === true, "Claude streaming requests should send stream=true")
    assert(streamedClaude.text === "你好" && streamedClaude.toolCalls[0]?.id === "toolu_stream" && streamedClaude.toolCalls[0]?.arguments?.query === "体力", "Claude SSE should combine text and input_json deltas")
    assert(streamedClaude.usage.total === 5 && streamedClaude.stopReason === "tool_calls", "Claude SSE should preserve usage and tool stop reason")

    let geminiStreamRequest
    global.fetch = async (url, options = {}) => {
      geminiStreamRequest = { url: String(url), body: JSON.parse(String(options.body || "{}")) }
      const source = [
        'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"你"}]}}],"usageMetadata":{"promptTokenCount":3}}',
        '',
        'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"好"},{"functionCall":{"name":"command_search","args":"{\\"query\\":\\"体力\\"}"}}]},"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":2,"totalTokenCount":5}}',
        '',
      ].join("\n")
      return new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const streamedGemini = await adapterRegistry.get("gemini").sendMessage({
      channel: { id: "gemini-stream", type: "gemini", model: "gemini-smoke", apiKey: "smoke", timeoutMs: 5000, stream: true },
      messages: [{ role: "user", content: "流式测试" }],
      tools: [{ name: "command_search", description: "Search.", parameters: { type: "object", properties: {} }, async execute() {} }],
      maxTokens: 64,
    })
    assert(geminiStreamRequest.url.includes(":streamGenerateContent") && geminiStreamRequest.url.includes("alt=sse"), "Gemini streaming requests should use streamGenerateContent with alt=sse")
    assert(streamedGemini.text === "你好" && streamedGemini.toolCalls[0]?.name === "command_search" && streamedGemini.toolCalls[0]?.arguments?.query === "体力", "Gemini SSE should combine text and function-call chunks")
    assert(streamedGemini.usage.total === 5 && streamedGemini.stopReason === "tool_calls", "Gemini SSE should preserve usage and tool finish reason")
  } finally {
    global.fetch = originalFetch
  }
}

async function checkModelRoutingPreview() {
  const { providerResolver } = await import("../output/runtime/models/routing/provider-resolver.js")
  const { chatService } = await import("../output/runtime/core/chat/chat-service.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { runIsolatedModelTask } = await import("../output/runtime/models/isolated-task.js")
  const config = JSON.parse(JSON.stringify(await configStore.load()))
  const digest = providerResolver.buildRoutingDigest(config)
  assert(digest.summary.providers >= 1, "routing digest should count providers")
  assert(digest.summary.models >= 1, "routing digest should count models")
  assert(digest.summary.tasks >= 1, "routing digest should count model tasks")
  assert(config.chat.defaultTask === "replyer", "default task should stay replyer")
  assert(!config.chat.defaultWorkflow && !config.workflows, "workflow config should be normalized away")
  assert(!config.modelTasks.vision_caption && !config.modelTasks.commandHelper, "default model tasks should stay focused on replyer")
  assert(digest.defaultPreview.task === config.chat.defaultTask, "routing digest should include default task preview")
  assert(digest.tasks.some(task => task.name === "replyer"), "routing digest should include replyer task")
  assert(digest.defaultPreview.selected?.name, "routing preview should resolve selected model candidate")
  const firstModelName = config.modelTasks.replyer.modelList[0]
  const transportConfig = JSON.parse(JSON.stringify(config))
  transportConfig.chat.modelRequestTimeoutMs = 120000
  transportConfig.chat.modelStream = true
  const transportModel = transportConfig.models.find(item => item.name === firstModelName)
  transportModel.adapter = "openai-compatible"
  delete transportModel.timeoutMs
  delete transportModel.stream
  transportModel.params = { ...(transportModel.params || {}), timeoutMs: 45000, stream: false, temperature: 0.1 }
  let transportChannel = providerResolver.buildChannel(transportModel, transportConfig)
  assert(transportChannel.timeoutMs === 120000 && transportChannel.stream === true, "transport behavior should come from model/provider/global settings, not request params")
  assert(transportChannel.params.timeoutMs === undefined && transportChannel.params.stream === undefined && transportChannel.params.temperature === 0.1, "transport controls must not leak into upstream model params")
  transportModel.timeoutMs = 180000
  transportModel.stream = true
  transportChannel = providerResolver.buildChannel(transportModel, transportConfig)
  assert(transportChannel.timeoutMs === 180000 && transportChannel.stream === true, "explicit model transport settings should override global values")
  const broken = JSON.parse(JSON.stringify(config))
  const badPreview = providerResolver.buildTaskPreview(broken, "missing_task")
  assert(badPreview.ok === false, "broken task preview should fail")
  assert(badPreview.issues.some(issue => issue.level === "error"), "broken task preview should expose errors")
  const fallbackConfig = JSON.parse(JSON.stringify(config))
  fallbackConfig.models.push(
    { name: "mock-fail", modelIdentifier: "mock-fail", apiProvider: "mock", adapter: "mock", visual: false, toolUse: false, params: { fail: true, failMessage: "smoke fallback first failed" } },
    { name: "mock-ok", modelIdentifier: "mock-ok", apiProvider: "mock", adapter: "mock", visual: false, toolUse: false, params: {} },
  )
  fallbackConfig.modelTasks.fallback_smoke = {
    modelList: ["mock-fail", "mock-ok"],
    selectionStrategy: "fallback",
    maxTokens: 128,
    temperature: 0,
  }
  const fallbackChannels = providerResolver.resolveCandidateChannels({ taskName: "fallback_smoke", config: fallbackConfig })
  assert(fallbackChannels.length === 2 && fallbackChannels[0].id === "mock-fail" && fallbackChannels[1].id === "mock-ok", "fallback strategy should expose ordered candidate channels")
  const fallbackStep = await chatService.runModelStep({
    e: { isGroup: false, user_id: "u1", sender: { nickname: "Smoke" } },
    prompt: "fallback smoke",
    config: fallbackConfig,
    history: [],
    step: { id: "reply", task: "fallback_smoke", mode: "final" },
  })
  assert(fallbackStep.channel === "mock-ok", "fallback step should use second model after first fails")
  assert(fallbackStep.attempts.length === 2 && fallbackStep.attempts[0].status === "error" && fallbackStep.attempts[1].status === "ok", "fallback step should record error and success attempts")
  const originalResolveIsolatedChannels = providerResolver.resolveCandidateChannels
  const originalIsolatedSendMessage = adapterRegistry.sendMessage
  const originalSetTimeout = global.setTimeout
  const isolatedTimeouts = []
  const isolatedChannels = []
  providerResolver.resolveCandidateChannels = () => [
    { id: "smoke-isolated-primary", type: "smoke-isolated-primary", model: "smoke", timeoutMs: 120000, stream: true },
    { id: "smoke-isolated-fallback", type: "smoke-isolated-fallback", model: "smoke", timeoutMs: 600000, stream: true },
  ]
  adapterRegistry.sendMessage = async ({ channel }) => {
    isolatedChannels.push(channel.id)
    if (channel.id === "smoke-isolated-primary") throw new Error("smoke primary isolated failure")
    return { id: "smoke-isolated", text: "{}", usage: {} }
  }
  global.setTimeout = (callback, delay, ...args) => {
    isolatedTimeouts.push(delay)
    return originalSetTimeout(callback, delay, ...args)
  }
  try {
    const isolatedConfig = {
      ...transportConfig,
      modelTasks: {
        ...transportConfig.modelTasks,
        replyer: { ...transportConfig.modelTasks.replyer, selectionStrategy: "fallback" },
      },
    }
    const isolatedResult = await runIsolatedModelTask({ config: isolatedConfig, taskName: "replyer", prompt: "isolated timeout smoke" })
    assert(isolatedResult.channel === "smoke-isolated-fallback" && isolatedChannels.join(",") === "smoke-isolated-primary,smoke-isolated-fallback" && isolatedTimeouts.join(",") === "120000,600000", "isolated fallback candidates should each use their own resolved timeout")
  } finally {
    providerResolver.resolveCandidateChannels = originalResolveIsolatedChannels
    adapterRegistry.sendMessage = originalIsolatedSendMessage
    global.setTimeout = originalSetTimeout
  }
}

async function checkModelRoutingApi() {
  const { configStore } = await import("../output/runtime/config/store.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { providerResolver } = await import("../output/runtime/models/routing/provider-resolver.js")
  const config = JSON.parse(JSON.stringify(await configStore.load()))
  const firstModel = config.models?.[0]?.name || "mock"
  const next = {
    ...config,
    chat: { ...(config.chat || {}), defaultTask: "replyer" },
    mediaRecognition: { ...(config.mediaRecognition || {}), recognitionModel: "" },
    modelTasks: { ...(config.modelTasks || {}), replyer: { modelList: [firstModel], selectionStrategy: "fallback", maxTokens: 128, temperature: 0 } },
  }
  assert(validateConfig(next).ok, "routing config should validate")
  const preview = providerResolver.buildTaskPreview(next, "replyer")
  assert(preview.ok && preview.fallbackEnabled, "routing preview should expose fallback strategy")
}

async function checkMemoryProfile() {
  const { memoryStore } = await import("../output/runtime/memory/store.js")
  const { MemoryForgetTool, MemoryListTool, UserProfileReadTool, UserProfileWriteTool } = await import("../output/runtime/tools/builtins/memory.js")
  const { cacheDir, configStore } = await import("../output/runtime/config/store.js")
  const originalRoot = memoryStore.rootDir
  await fs.mkdir(cacheDir, { recursive: true })
  const tempRoot = await fs.mkdtemp(path.join(cacheDir, "smoke-memory-"))
  const event = { isGroup: true, group_id: "20001", user_id: "10001", sender: { user_id: "10001" } }
  try {
    await memoryStore.resetForTest(tempRoot)
    const write = await new UserProfileWriteTool().execute({
      name: "小明",
      interests: ["原神", "自动化"],
      preferences: ["简洁回答"],
      communicationStyle: "喜欢直接给结论",
    }, { e: event })
    assert(write.includes("小明") && write.includes("原神"), "user_profile_write should update structured profile")
    const read = await new UserProfileReadTool().execute({}, { e: event })
    assert(read.includes("用户 10001 画像") && read.includes("交流风格"), "user_profile_read should return profile summary")
    const listed = await memoryStore.listProfiles({ limit: 5 })
    assert(listed.some(item => item.userId === "10001" && item.summary.some(line => line.includes("小明"))), "memory profile list should expose summaries for Web UI")
    const apiProfile = await memoryStore.setProfile("10002", { name: "小红", interests: ["渲染"] }, { save: false })
    assert(apiProfile.userId === "10002" && apiProfile.profile.interests.includes("渲染"), "memory setProfile should update profiles by user id")
    const editableFact = await memoryStore.addFact(event, "用户喜欢把复杂任务拆成步骤。")
    const editedFact = await memoryStore.updateMemory("10001", editableFact.id, { text: "用户喜欢先看结论，再看步骤。" })
    assert(editedFact.text.includes("先看结论") && editedFact.source === "manual-edit", "memory facts should support intuitive Web editing")
    const managedGroupFact = await memoryStore.saveManagedMemory({ scopeType: "group", ownerId: "20001", text: "本群默认使用简短公告。", tags: ["群偏好"] })
    const managedTargets = await memoryStore.listManagedScopes({ limit: 20 })
    assert(managedTargets.some(item => item.scopeType === "user" && item.ownerId === "10001"), "memory manager should list user targets")
    assert(managedTargets.some(item => item.scopeType === "group" && item.ownerId === "20001"), "memory manager should list group targets")
    const managedGroup = await memoryStore.getManagedScope("group", "20001")
    assert(managedGroup.items.some(item => item.id === managedGroupFact.id), "memory manager should load a single group scope")
    const updatedGroupFact = await memoryStore.saveManagedMemory({ scopeType: "group", ownerId: "20001", id: managedGroupFact.id, text: "本群公告保持三句话以内。" })
    assert(updatedGroupFact.text.includes("三句话以内"), "memory manager should edit group memories in place")
    const memoryList = await new MemoryListTool().execute({ limit: 5 }, { e: event })
    assert(memoryList.includes("先看结论") && memoryList.includes("id:"), "memory_list should expose remembered facts with ids")
    const found = await memoryStore.search(event, "先看结论", 1)
    assert(found[0]?.id, "memory search should return memory id")
    const forgot = await new MemoryForgetTool().execute({ id: found[0].id }, { e: event })
    assert(forgot.includes("已删除记忆"), "memory_forget should delete visible memory")
    await memoryStore.addFact(event, "用户喜欢把复杂任务拆成步骤。")
    const prompt = await memoryStore.buildPrompt(event, "怎么沟通")
    assert(prompt.includes("用户画像") && prompt.includes("简洁回答"), "memory prompt should inject structured profile")
    const targetUserEvent = { ...event, user_id: "10003", sender: { user_id: "10003", nickname: "被提问成员" } }
    await memoryStore.addFact(targetUserEvent, "用户喜欢未定事件簿角色夏彦。", { source: "group-capture" })
    const mentionEvent = {
      ...event,
      user_id: "10004",
      sender: { user_id: "10004", nickname: "提问者" },
      msg: "[CQ:at,qq=10003] 她喜欢什么",
      raw_message: "[CQ:at,qq=10003] 她喜欢什么",
      message: [
        { type: "at", data: { qq: "10003" } },
        { type: "text", data: { text: "她喜欢什么" } },
      ],
    }
    const mentionedPrompt = await memoryStore.buildPrompt(mentionEvent, "喜欢")
    assert(mentionedPrompt.includes("QQ 10003") && mentionedPrompt.includes("用户喜欢未定事件簿角色夏彦"), "memory prompt should inject and attribute a mentioned group member's fact in file fallback mode")
    const unrelatedMentionPrompt = await memoryStore.buildPrompt(mentionEvent, "过来看看这个")
    assert(!unrelatedMentionPrompt.includes("用户喜欢未定事件簿角色夏彦"), "ordinary at mentions should not inject the target member's memory in file fallback mode")
    assert(memoryStore.stats().profiles === 2, "memory stats should count profiles")
    assert(memoryStore.stats().storage?.format === "owner-files-v2", "memory should expose owner-file storage format")
    assert(memoryStore.stats().storage?.boundedTailRead === true, "memory should expose bounded JSONL reads")

    const tracked = await memoryStore.addFact(event, "用户希望持久命中记录能够落盘。")
    const cachedCopies = (await memoryStore.listMemories(event, { limit: 200, includeCold: true })).filter(item => item.id === tracked.id)
    assert(cachedCopies.length === 1, "new memory should not be duplicated in the in-memory cache")
    await memoryStore.buildPrompt(event, "持久命中记录")
    await memoryStore.flush()
    await memoryStore.resetForTest(tempRoot)
    const reloadedTracked = (await memoryStore.listMemories(event, { limit: 200, includeCold: true })).find(item => item.id === tracked.id)
    assert(reloadedTracked?.hitCount >= 1 && reloadedTracked?.lastUsedAt, "memory hit metadata should survive cache reload")

    const maxEpisodes = Number((await configStore.load()).memory.maxEpisodesPerScope)
    for (let index = 0; index < maxEpisodes + 5; index++) {
      await memoryStore.appendInteraction(event, `episode smoke ${index}`, `answer ${index}`)
    }
    await memoryStore.flush()
    const episodeLines = (await fs.readFile(memoryStore.episodeFile(event), "utf8")).trim().split("\n").filter(Boolean)
    assert(episodeLines.length === maxEpisodes, "episode JSONL should be compacted to the configured scope limit")
    assert(JSON.parse(episodeLines[0]).prompt === "episode smoke 5", "episode compaction should retain the newest records")
    assert(memoryStore.stats().episodeFiles === 1, "memory stats should report episode file count")
    assert((await configStore.load()).tools.enabledTools.includes("memory_manage"), "default tools should include compact memory management")
  } finally {
    await memoryStore.resetForTest(originalRoot)
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}

// 具体的会话、记忆、群采集、知识、向量、日志、预算和配置包回归由
// scripts/check-sqlite-integration.mjs 在独立进程完成；此处只验证 Smoke
// 运行目录能创建干净的基线库和兼容增量结构。
async function checkSqliteStorage() {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js")
  await sqliteClient.init(defaults)
  try {
    assert(sqliteClient.status.available, "SQLite state database should initialize in worker")
    assert(sqliteClient.status.integrity === "ok", "SQLite state database should pass quick_check")
    assert((sqliteClient.status.migrations || []).map(row => row.id).join(",") === "001-baseline.sql,002-tool-call-events.sql,003-model-call-snapshots.sql,004-conversation-state.sql", "SQLite state database should apply the baseline, combined tool/runtime, model snapshot, and conversation state schema")
    const removed = await sqliteClient.get("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_sources'")
    assert(!removed, "baseline state database should not recreate removed transitional tables")
  } finally {
    await sqliteClient.close()
  }
}

async function checkMedia() {
  const { configStore } = await import("../output/runtime/config/store.js")
  const { prepareMediaForVision } = await import("../output/runtime/core/media/media-cache.js")
  const { buildMediaUserContent, recentImageRecallModeForPrompt, resolveMediaContext, summarizeMediaContext, visionInputModeForPrompt } = await import("../output/runtime/core/message/media-context.js")
  const { buildOpenAiUserContent, contentToText } = await import("../output/runtime/core/message/message-context.js")
  const { buildUserMessage } = await import("../output/runtime/core/persona/persona-chain.js")
  const { MessageSendTool } = await import("../output/runtime/tools/builtins/media.js")
  const { linkSafetyConfig, matchesHostTarget, resolveTrustedResourceRequest, trustedResourcePolicies, trustedResourceRequest } = await import("../output/runtime/core/network/link-safety-policy.js")
  const { BilibiliMediaTool, ImageMediaTool } = await import("../output/runtime/tools/builtins/network.js")
  const media = { attachments: [{ kind: "image", url: "data:image/png;base64,AAAA", source: "smoke" }], diagnostics: [] }
  const prepared = await prepareMediaForVision(media, { mediaRecognition: { remoteFetch: { enabled: true } } })
  const summary = summarizeMediaContext(prepared)
  assert(prepared.attachments[0].preparedUrl === "data:image/png;base64,AAAA", "data URL should be kept")
  assert(prepared.attachments[0].thumbnailDataUrl === "" || prepared.attachments[0].thumbnailDataUrl.startsWith("data:image/"), "data URL media should expose a safe thumbnail field")
  assert(!summary.includes("AAAA"), "media summary must not leak base64 payload")
  const content = buildOpenAiUserContent("看图", {
    images: [
      { url: "file:///etc/passwd" },
      { url: "/Users/example/private.png" },
      { url: "data:image/png;base64,AAAA" },
    ],
  }, true)
  const visionParts = Array.isArray(content) ? content.filter(part => part.type === "image_url") : []
  assert(visionParts.length === 1 && visionParts[0].image_url.url.startsWith("data:image/png"), "vision content must reject file/local image URLs")
  assert(!contentToText(content).includes("AAAA"), "vision content text summary must not leak base64 payload")
  assert(!contentToText(content).includes("/etc/passwd"), "vision content text summary must not leak local file paths")
  const quotedImageUrl = "https://multimedia.nt.qq.com.cn/download?fileid=smoke"
  const quotedEvent = {
    reply_id: "8416071",
    // 部分宿主会把引用图片同时放进当前事件与 getReply 结果，必须两边都跳过。
    message: [{ type: "image", data: { url: quotedImageUrl } }],
    getReply: async () => ({
      message_id: "8416071",
      sender: { user_id: "10002", nickname: "quoted-user" },
      message: [{ type: "image", data: { url: quotedImageUrl } }],
    }),
  }
  assert(
    visionInputModeForPrompt("撤回这条消息") === "none"
      && visionInputModeForPrompt("看看这张图") === "all"
      && visionInputModeForPrompt("玉玉你能看到这个图里的内容吗") === "all"
      && visionInputModeForPrompt("评价一下") === "all",
    "vision input should distinguish message management from explicit and contextual image understanding",
  )
  assert(
    recentImageRecallModeForPrompt("再看看我刚发的那个图片内容") === "explicit"
      && recentImageRecallModeForPrompt("上一张表情包是什么意思") === "explicit"
      && recentImageRecallModeForPrompt("小呆毛刚才发的是什么") === "explicit"
      && recentImageRecallModeForPrompt("看看这个图") === "adjacent"
      && recentImageRecallModeForPrompt("玉玉这个呢") === "adjacent"
      && recentImageRecallModeForPrompt("评价一下") === "adjacent"
      && recentImageRecallModeForPrompt("今天心情怎么样") === "none"
      && recentImageRecallModeForPrompt("撤回刚才那张图片") === "none",
    "recent image recall should distinguish explicit lookback, adjacent contextual reference, ordinary chat, and management messages",
  )
  const managementMedia = await resolveMediaContext(quotedEvent, "撤回这条消息", { mediaRecognition: { includeQuotedMedia: true, useAtAvatar: false } })
  assert(managementMedia.quote?.messageId === "8416071" && managementMedia.attachments.length === 2 && managementMedia.attachments.every(item => item.visionEligible === false), "message management should keep the quoted message id without enabling duplicated host images")
  assert(!summarizeMediaContext(managementMedia).includes(quotedImageUrl), "message management summaries should not include skipped media URLs")
  const preparedManagementMedia = await prepareMediaForVision(managementMedia, { mediaRecognition: { remoteFetch: { enabled: true } } })
  assert(preparedManagementMedia.attachments.every(item => item.visionSkipped === true && !item.prepareError), "message management should skip all duplicated image downloads entirely")
  const managementContent = buildMediaUserContent("撤回这条消息", preparedManagementMedia, true)
  assert(!Array.isArray(managementContent) && !String(managementContent).includes(quotedImageUrl), "message management should not send quoted image URLs to the model")
  const visualMedia = await resolveMediaContext(quotedEvent, "看看这张图", { mediaRecognition: { includeQuotedMedia: true, useAtAvatar: false } })
  assert(visualMedia.attachments.filter(item => item.visionEligible === true).length === 1 && visualMedia.attachments.find(item => item.visionEligible)?.source === "quote", "an explicitly referenced quote should select the quoted image once instead of duplicating a host-flattened current image")
  const ellipticalQuotedMedia = await resolveMediaContext(quotedEvent, "玉玉那这个呢", { mediaRecognition: { includeQuotedMedia: true, useAtAvatar: false } })
  assert(ellipticalQuotedMedia.attachments.filter(item => item.visionEligible === true).length === 1 && ellipticalQuotedMedia.attachments.find(item => item.visionEligible)?.source === "quote", "elliptical visual follow-ups should read only the explicitly quoted image without recalling unrelated history")
  const inlineSourceQuotedMedia = await resolveMediaContext({
    isGroup: true,
    source: {
      seq: "841607-inline",
      user_id: "10003",
      sender: { user_id: "10003", nickname: "inline-user" },
      message: [{ type: "image", data: { url: "data:image/png;base64,AAAA" } }],
    },
    message: [{ type: "reply", data: { id: "841607-inline" } }],
  }, "评价一下", { mediaRecognition: { includeQuotedMedia: true, useAtAvatar: false } })
  assert(inlineSourceQuotedMedia.quote?.messageId === "841607-inline" && inlineSourceQuotedMedia.attachments.some(item => item.source === "quote" && item.visionEligible === true), "Yunzai inline source media should be used directly for intent-based quoted-image evaluation")
  const directAndQuotedMedia = await resolveMediaContext({
    ...quotedEvent,
    message: [
      { type: "reply", data: { id: "8416071" } },
      { type: "image", data: { url: "data:image/png;base64,BBBB" } },
    ],
  }, "评价一下", { mediaRecognition: { includeQuotedMedia: true, useAtAvatar: false } })
  assert(directAndQuotedMedia.attachments.filter(item => item.visionEligible).length === 1 && directAndQuotedMedia.attachments.find(item => item.visionEligible)?.source !== "quote", "a newly attached image should outrank an older quoted image for an unqualified evaluation")
  const comparedMedia = await resolveMediaContext({
    ...quotedEvent,
    message: [
      { type: "reply", data: { id: "8416071" } },
      { type: "image", data: { url: "data:image/png;base64,BBBB" } },
    ],
  }, "对比这两张", { mediaRecognition: { includeQuotedMedia: true, useAtAvatar: false } })
  assert(comparedMedia.attachments.filter(item => item.visionEligible).length === 2, "comparison intent should include the unique current image and quoted image without duplicating host-flattened URLs")
  const quotedOnlyEvent = {
    ...quotedEvent,
    message: [],
    getReply: async () => ({
      message_id: "8416071",
      sender: { user_id: "10002", nickname: "quoted-user" },
      message: [{ type: "image", data: { url: "data:image/png;base64,AAAA" } }],
    }),
  }
  for (const prompt of ["看看这个", "怎么看这个", "这个怎么看", "这个是什么", "这个呢", "说说你的看法"]) {
    const quotedVisual = await resolveMediaContext(quotedOnlyEvent, prompt, { mediaRecognition: { includeQuotedMedia: true, useAtAvatar: false } })
    assert(quotedVisual.attachments.some(item => item.source === "quote" && item.visionEligible === true), `quoted image should be eligible for visual prompt: ${prompt}`)
    const preparedQuotedVisual = await prepareMediaForVision(quotedVisual, { mediaRecognition: { remoteFetch: { enabled: true } } })
    const quotedContent = buildMediaUserContent(prompt, preparedQuotedVisual, true)
    const quotedParts = Array.isArray(quotedContent) ? quotedContent.filter(part => part.type === "image_url") : []
    assert(quotedParts.length === 1 && quotedParts[0].image_url.url === "data:image/png;base64,AAAA", `quoted image should enter multimodal content: ${prompt}`)
  }
  const quotedFirstPerson = await resolveMediaContext(quotedOnlyEvent, "埋埋帮我看看", { mediaRecognition: { includeQuotedMedia: true, useAtAvatar: false } }, { quoteAsCurrent: true })
  const preparedQuotedFirstPerson = await prepareMediaForVision(quotedFirstPerson, { mediaRecognition: { remoteFetch: { enabled: true } } })
  const quotedFirstPersonMessage = buildUserMessage(quotedOnlyEvent, "埋埋帮我看看", {}, { media: preparedQuotedFirstPerson, vision: true })
  const quotedFirstPersonText = contentToText(quotedFirstPersonMessage.content)
  assert(quotedFirstPersonText.includes("引用消息") && quotedFirstPersonText.includes("8416071") && Array.isArray(quotedFirstPersonMessage.content) && quotedFirstPersonMessage.content.some(part => part.type === "image_url"), "first-person quoted requests should include quoted text and image in the current multimodal user message")
  const quotedTextEvent = {
    reply_id: "8416073",
    getReply: async () => ({
      message_id: "8416073",
      sender: { user_id: "10002", nickname: "quoted-user" },
      message: [{ type: "text", text: "这是被引用的正文" }],
    }),
  }
  const quotedTextMedia = await resolveMediaContext(quotedTextEvent, "埋埋帮我看看", { mediaRecognition: { includeQuotedMedia: true, useAtAvatar: false } }, { quoteAsCurrent: true })
  const quotedTextMessage = buildUserMessage(quotedTextEvent, "埋埋帮我看看", {}, { media: quotedTextMedia, vision: false })
  assert(contentToText(quotedTextMessage.content).includes("这是被引用的正文"), "first-person quoted requests should include quoted text in the current user message")
  const replySegmentEvent = {
    isGroup: true,
    message: [{ type: "reply", data: { id: "8416072" } }],
    group: {
      getChatHistory: async () => [{ message_id: "8416072", raw_message: "[CQ:image,file=data:image/png;base64,AAAA]" }],
    },
  }
  const segmentQuotedVisual = await resolveMediaContext(replySegmentEvent, "怎么看这个", { mediaRecognition: { includeQuotedMedia: true, useAtAvatar: false } })
  const preparedSegmentQuotedVisual = await prepareMediaForVision(segmentQuotedVisual, { mediaRecognition: { remoteFetch: { enabled: true } } })
  const segmentQuotedContent = buildMediaUserContent("怎么看这个", preparedSegmentQuotedVisual, true)
  assert(Array.isArray(segmentQuotedContent) && segmentQuotedContent.some(part => part.type === "image_url"), "reply segments and CQ quoted media should reach multimodal content")
  const bilibiliPageVideoResult = await new MessageSendTool().execute({ parts: [{ type: "video", source: { kind: "url", value: "https://www.bilibili.com/video/BV1Smoke" } }] })
  assert(bilibiliPageVideoResult.kind === "error" && bilibiliPageVideoResult.issues?.some(issue => String(issue).includes("bilibili_media")), "message_send should reject Bilibili page URLs until bilibili_media prepares local cache resources")
  assert(trustedResourcePolicies["bilibili-cdn"].targets.includes("hdslb.com"), "trusted resource policies should keep a single owner-maintained domain/IP list")
  assert(trustedResourceRequest("bilibili-cdn", "http://i0.hdslb.com/bfs/archive/smoke.jpg").url.startsWith("http://i0.hdslb.com/"), "trusted resource URLs should preserve HTTP without forced protocol upgrades")
  assert(resolveTrustedResourceRequest("https://www.bilibili.com/video/BV1Smoke", ["bilibili-page"])?.policyId === "bilibili-page", "Bilibili page classification should use the centralized target policy")
  assert(trustedResourcePolicies["qq-media"].targets.includes("qq.com.cn"), "trusted resource policies should include the QQ media domain")
  const qqMediaRequest = resolveTrustedResourceRequest("https://multimedia.nt.qq.com.cn/download?fileid=smoke", ["qq-media"])
  assert(qqMediaRequest?.policyId === "qq-media" && qqMediaRequest.allowPrivateHosts === true, "QQ media policy should recognize qq.com.cn with the default-open centralized private-DNS bypass")
  assert(resolveTrustedResourceRequest("https://multimedia.nt.qq.com.cn.attacker.test/image.png", ["qq-media"]) === null, "QQ media policy must reject lookalike domains outside the qq.com.cn boundary")
  const enabledTrustedBypass = { security: { linkSafety: { allowPrivateHosts: false, trustedPrivateDnsBypass: true } } }
  assert(linkSafetyConfig({}).trustedPrivateDnsBypass === true && trustedResourceRequest("bilibili-cdn", "https://i0.hdslb.com/smoke.jpg").allowPrivateHosts === true, "trusted private-DNS bypass should remain enabled by default")
  assert(trustedResourceRequest("bilibili-cdn", "https://i0.hdslb.com/smoke.jpg", enabledTrustedBypass).allowPrivateHosts === true, "trusted private-DNS bypass should be controlled only by the centralized runtime policy")
  assert(trustedResourceRequest("bilibili-page", "https://www.bilibili.com/video/BV1Smoke", enabledTrustedBypass).allowPrivateHosts === false, "non-eligible semantic URL policies must not inherit the trusted DNS bypass")
  assert(matchesHostTarget("10.0.0.8", ["10.0.0.8"]) && !matchesHostTarget("10.0.0.9", ["10.0.0.8"]), "trusted resource targets should support exact IP entries")
  let rejectedPrivateCover = false
  try { trustedResourceRequest("bilibili-cdn", "http://127.0.0.1/cover.jpg") } catch (error) { rejectedPrivateCover = /可信域名或 IP/.test(String(error?.message || error)) }
  assert(rejectedPrivateCover, "provider-specific Bilibili cover access must not admit arbitrary private URLs")

  const blocked = await prepareMediaForVision({
    attachments: [{ kind: "image", url: "http://127.0.0.1:9/a.png", source: "smoke" }],
    diagnostics: [],
  }, {
    security: { linkSafety: { allowPrivateHosts: false, trustedPrivateDnsBypass: false } },
    mediaRecognition: {
      remoteFetch: { enabled: true, timeoutMs: 200, maxBytes: 1024, maxAttachments: 1 },
    },
  })
  assert(Boolean(blocked.attachments[0].prepareError), "private media URL should be rejected")
  const blockedContent = buildMediaUserContent("看图", blocked, true)
  assert(!Array.isArray(blockedContent) || !blockedContent.some(part => part.type === "image_url"), "failed media preparation must not fall back to the original remote image URL")
  const fileBlocked = await prepareMediaForVision({
    attachments: [{ kind: "image", url: "file:///etc/passwd", source: "smoke-file" }],
    diagnostics: [],
  }, {
    mediaRecognition: { remoteFetch: { enabled: true } },
  })
  assert(Boolean(fileBlocked.attachments[0].prepareError), "file media URL should be rejected before vision")
  assert(!summarizeMediaContext(fileBlocked).includes("/etc/passwd"), "file media summary must not leak local file paths")
  const mediaContent = buildMediaUserContent("看图", fileBlocked, true)
  assert(!contentToText(mediaContent).includes("/etc/passwd"), "media user content must not leak local file paths")
  const coverUrl = tinyPngDataUrl
  const originalFetch = global.fetch
  const { createServer } = await import("node:http")
  const imageServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png" })
    res.end(Buffer.from(tinyPngDataUrl.split(",")[1], "base64"))
  })
  await new Promise((resolve, reject) => {
    imageServer.once("error", reject)
    imageServer.listen(0, "127.0.0.1", resolve)
  })
  const imageBaseUrl = `http://127.0.0.1:${imageServer.address().port}`
  try {
    const { resetBilibiliSessionForTest } = await import("../output/runtime/tools/builtins/bilibili.js")
    resetBilibiliSessionForTest()
    global.fetch = async (url, options = {}) => {
      const value = String(url)
      if (value === "https://www.bilibili.com") {
        return new Response("ok", { status: 200, headers: { "set-cookie": "buvid3=smoke-cookie; Path=/; HttpOnly", "content-type": "text/html" } })
      }
      if (value.includes("/x/web-interface/search/type")) {
        assert(String(options.headers?.Cookie || "").includes("buvid3=smoke-cookie"), "Bilibili search should carry the bootstrapped session cookie")
        assert(String(options.headers?.Referer || "").includes("bilibili.com"), "Bilibili search should carry a browser referer")
        return new Response(JSON.stringify({
          code: 0,
          data: {
            result: [
              {
                title: "<em class=\"keyword\">随摇</em>测试",
                author: "小透明",
                duration: "5:48",
                play: "949.8万",
                bvid: "BV1m4iwBuEgi",
                aid: 123456,
              },
            ],
          },
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (value.includes("/x/web-interface/view?")) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            title: "随摇测试",
            owner: { name: "小透明" },
            pubdate: 1710000000,
            stat: { view: 100, like: 20, favorite: 5 },
            bvid: "BV1m4iwBuEgi",
            aid: 123456,
            cid: 654321,
            pic: coverUrl,
            desc: "desc",
          },
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (value.includes("/x/player/playurl?")) {
        return new Response(JSON.stringify({ code: 0, data: { durl: [{ url: "https://video.test/smoke.mp4" }] } }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (value === "https://video.test/smoke.mp4") {
        return new Response(Buffer.from("smoke-video"), { status: 200, headers: { "content-type": "video/mp4", "content-length": "11" } })
      }
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })
    }
    const tool = new BilibiliMediaTool()
    const sentBilibiliPayloads = []
    const bilibiliContext = { e: { isGroup: true, group_id: "20001", reply: async payload => sentBilibiliPayloads.push(payload) } }
    // 显式 search：只返回候选清单，交给模型说给用户挑。
    const candidates = await tool.execute({ keyword: "跳舞的随便就行", action: "search" }, bilibiliContext)
    assert(Array.isArray(candidates.results) && candidates.results[0]?.id === "BV1m4iwBuEgi", "a bare keyword search should return a candidate list")
    assert(candidates.results[0]?.title && candidates.results[0]?.author === "小透明", "candidates should carry a readable title and author")
    assert(!candidates.cover, "a candidate list should not pretend to be full video details")
    // action 缺省为 send：选中一条并准备本地封面和视频。
    const downloaded = await tool.execute({ keyword: "跳舞的随便就行", pick: "first" }, bilibiliContext)
    const downloadedContent = downloaded.content
    const downloadedParts = downloaded.metadata?.messageSendPlan?.parts || []
    assert(downloadedContent.source?.kind === "cache" && downloadedContent.source.value.endsWith(".mp4"), "direct-send Bilibili media should return a local video cache path")
    assert(downloadedContent.coverSource?.kind === "cache" && downloadedContent.coverSource.value.endsWith("_cover.png"), "direct-send Bilibili media should also return a local cover cache path")
    assert(downloadedParts[1]?.source?.value === downloadedContent.coverSource.value && downloadedParts[2]?.source?.value === downloadedContent.source.value, "Bilibili media should preserve caption, cover, and video correspondence in its delivery plan")
    assert(downloadedContent.bytes === 11 && downloadedContent.cached === false && !sentBilibiliPayloads.length, "bilibili_media should prepare a plan without bypassing message_send")
    // 同一个视频再次请求时命中缓存，不重复下载。
    const reused = await tool.execute({ keyword: "跳舞的随便就行", action: "send", pick: "first" }, bilibiliContext)
    assert(reused.content.cached === true && reused.content.source.value === downloadedContent.source.value, "a repeated download should reuse the cached file instead of fetching again")
    const gated = await tool.execute({ keyword: "跳舞的随便就行", action: "send" }, {
      ...bilibiliContext,
      toolConfig: { sendVideoFile: false },
    })
    assert(String(gated.content).includes("关闭") && gated.metadata?.messageSendPlan?.parts?.[0]?.type === "text", "admin-disabled video download should become a text-only delivery plan")
    global.fetch = async url => {
      const value = String(url)
      if (value.startsWith("https://cn.bing.com/images/async")) {
        return new Response([
          `<a class="iusc" m="{&quot;t&quot;:&quot;猫一&quot;,&quot;murl&quot;:&quot;${imageBaseUrl}/cat-1.jpg&quot;,&quot;purl&quot;:&quot;cat.example&quot;}"></a>`,
          `<a class="iusc" m="{&quot;t&quot;:&quot;猫二&quot;,&quot;murl&quot;:&quot;${imageBaseUrl}/cat-2.jpg&quot;,&quot;purl&quot;:&quot;cat.example&quot;}"></a>`,
        ].join(""), { status: 200, headers: { "content-type": "text/html" } })
      }
      if (value.startsWith("https://api.lolicon.app/setu/v2")) {
        return new Response(JSON.stringify({ data: [{ pid: 778899, p: 2, uid: 9988, title: "Pixiv Smoke", author: "Smoke Artist", r18: 0, width: 1200, height: 800, urls: { regular: `${imageBaseUrl}/pixiv-778899-p2.jpg` } }] }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response("not found", { status: 404 })
    }
    const imageTool = new ImageMediaTool()
    const imageCacheConfig = JSON.parse(JSON.stringify(await configStore.load()))
    imageCacheConfig.security.linkSafety.allowPrivateHosts = true
    const imageCandidates = await imageTool.execute({ query: "猫", action: "search", limit: 2 }, { config: imageCacheConfig })
    assert(imageCandidates.results?.length === 2 && !imageCandidates.metadata, "image_media action=search should return candidates without an automatic delivery plan")
    const imageDelivery = await imageTool.execute({ query: "猫", count: 2, limit: 2 }, { config: imageCacheConfig })
    const imageParts = imageDelivery.metadata?.messageSendPlan?.parts || []
    assert(imageParts.length === 2 && imageParts.every(part => part.type === "image"), "image_media should send only image parts without titles or source text")
    assert(imageDelivery.content.cacheSelectedImages === false && imageParts.every(part => part.source?.kind === "url" && part.source?.value?.startsWith(imageBaseUrl)), "image_media should pass selected original URLs directly to message_send by default")
    assert(imageDelivery.content.selected[0]?.originalUrl.endsWith("cat-1.jpg") && imageDelivery.content.selected[1]?.originalUrl.endsWith("cat-2.jpg"), "multiple image results should preserve their selected order and original correspondence")
    assert(!imageDelivery.metadata?.messageSendPlan?.finalReply, "image_media should not embed a fixed final reply in its delivery plan")
    const cachedImageConfig = JSON.parse(JSON.stringify(imageCacheConfig))
    cachedImageConfig.tools.builtin.imageSearch.cacheSelectedImages = true
    const cachedImageDelivery = await imageTool.execute({ query: "猫", count: 2, limit: 2 }, { config: cachedImageConfig })
    const cachedImageParts = cachedImageDelivery.metadata?.messageSendPlan?.parts || []
    assert(cachedImageDelivery.content.cacheSelectedImages === true && cachedImageParts.every(part => part.source?.kind === "cache" && part.source?.value?.includes("media-cache/image_")), "image_media should download selected images only when local caching is explicitly enabled")
    const imageConfig = JSON.parse(JSON.stringify(await configStore.load()))
    imageConfig.tools.builtin.imageSearch.enabledSources = ["pixiv"]
    imageConfig.tools.builtin.imageSearch.defaultSource = "pixiv"
    imageConfig.tools.builtin.imageSearch.strategy = "preferred"
    imageConfig.tools.builtin.imageSearch.pixivR18 = false
    imageConfig.security.linkSafety.allowPrivateHosts = true
    const blockedR18 = await imageTool.execute({ query: "白髪", source: "pixiv", r18: true }, { config: imageConfig })
    assert(String(blockedR18).includes("未由管理员启用"), "Pixiv R18 requests must be rejected by the administrator gate")
    const pixivDelivery = await imageTool.execute({ query: "白髪", source: "pixiv" }, { config: imageConfig })
    assert(pixivDelivery.content.selected[0]?.artworkId === "778899" && pixivDelivery.content.selected[0]?.imageIndex === 2, "Pixiv delivery should preserve artwork and page-index correspondence")
    assert(pixivDelivery.metadata?.messageSendPlan?.parts?.[0]?.source?.kind === "url", "Pixiv delivery should also use the original URL unless local caching is enabled")
    resetBilibiliSessionForTest()
    global.fetch = async url => {
      const value = String(url)
      if (value === "https://www.bilibili.com") {
        return new Response("ok", { status: 200, headers: { "set-cookie": "buvid3=fallback-cookie; Path=/", "content-type": "text/html" } })
      }
      if (value.includes("/x/web-interface/search/type")) {
        return new Response("<!DOCTYPE html><title>412</title>", { status: 412, headers: { "content-type": "text/html" } })
      }
      if (value.startsWith("https://html.duckduckgo.com/html/")) {
        return new Response('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1Fallback88%2F&amp;rut=x">降级舞蹈视频_哔哩哔哩_bilibili</a>', { status: 200, headers: { "content-type": "text/html" } })
      }
      if (value.includes("/x/web-interface/view?bvid=BV1Fallback88")) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            title: "降级舞蹈视频",
            owner: { name: "降级UP" },
            pubdate: 1710000000,
            stat: { view: 200, like: 30, favorite: 8 },
            bvid: "BV1Fallback88",
            pic: "https://i0.hdslb.com/fallback.jpg",
          },
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })
    }
    const fallbackPreview = await tool.execute(
      { keyword: "降级舞蹈", action: "search", dryRun: true },
      { e: { isGroup: true, group_id: "20001", reply: async () => {} } },
    )
    const fallbackPreviewText = typeof fallbackPreview === "string" ? fallbackPreview : JSON.stringify(fallbackPreview)
    assert(fallbackPreviewText.includes("BV1Fallback88"), "Bilibili HTTP 412 should fall back to web-indexed BV results")
    assert(fallbackPreviewText.includes("降级舞蹈视频"), "Bilibili fallback should preserve the web-indexed candidate title")
    resetBilibiliSessionForTest()
    global.fetch = async () => new Response("request blocked", { status: 412, headers: { "content-type": "text/plain" } })
    let bilibiliFailure = ""
    try {
      await tool.execute({ keyword: "风控测试", action: "search", dryRun: true }, { e: { isGroup: true, group_id: "20001", reply: async () => {} } })
    } catch (err) {
      bilibiliFailure = err.message
    }
    assert(bilibiliFailure.includes("HTTP 412"), "bilibili lookup should throw HTTP failures for unified tool error logging")
  } finally {
    global.fetch = originalFetch
    await new Promise(resolve => imageServer.close(resolve))
  }
}

async function checkOutputSemantics() {
  const { buildReplyPayload, normalizeResponseText } = await import("../output/runtime/core/chat/response-pipeline.js")
  const { sendChatOutput, splitNaturalReply, splitConfiguredReply, configuredSegmentationDelayMs, formatHostedSearchCitations } = await import("../output/runtime/core/chat/output-service.js")
  const { convertCQCodes, findUnsupportedMediaCQCodes } = await import("../output/runtime/core/message/cq-code.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  const config = JSON.parse(JSON.stringify(await configStore.load()))
  assert(normalizeResponseText("<EMPTY>") === "", "<EMPTY> should normalize to empty")
  assert(normalizeResponseText("<EMPTY>补充说明<EMPTY>") === "补充说明", "outer <EMPTY> markers should be trimmed")
  const payload = await buildReplyPayload("<EMPTY>", config)
  assert(payload.empty === true, "<EMPTY> reply should be silent")
  const cqPayload = await buildReplyPayload("提醒 [CQ:at,qq=123456]请查看", config)
  assert(cqPayload.text.includes("[CQ:at,qq=123456]"), "supported CQ at codes should survive reply payload preparation")
  const cqReply = convertCQCodes(cqPayload.text, { segment: { at: id => ({ type: "at", data: { qq: id } }) } })
  assert(Array.isArray(cqReply) && cqReply[1]?.data?.qq === "123456" && cqReply[2] === " 请查看", "CQ at should become a native segment with a readable separator")
  const rawAtReply = convertCQCodes(cqPayload.text, { segment: { at: id => `[CQ:at,qq=${id}]` } })
  assert(Array.isArray(rawAtReply) && rawAtReply[1]?.type === "at" && rawAtReply[1]?.qq === "123456" && !rawAtReply.some(item => typeof item === "string" && item.includes("[CQ:")), "CQ at should never fall back to literal CQ text when a host segment factory serializes it")
  assert(convertCQCodes("[CQ:image,file=unsafe]文字", { segment: {} }) === "文字", "unsupported CQ codes should remain stripped by default")
  const mediaCodes = findUnsupportedMediaCQCodes("[CQ:image,file=https://example.com/a.png][CQ:record,file=https://example.com/a.mp3]")
  assert(mediaCodes.map(item => item.type).join(",") === "image,record", "media CQ codes should be detected for delivery correction")
  assert(splitNaturalReply("第一句。第二句！第三句？第四句。", { maxParts: 3 }).length === 3, "natural split should respect maxParts")
  const shortReply = "搜索被风控挡回来了。给你两个办法选一个：\n- 稍后再搜\n- 直接发 BV 号"
  assert(splitNaturalReply(shortReply, { maxParts: 3, minChars: 180 }).length === 1, "short replies should not be split by the natural strategy")
  const citedText = formatHostedSearchCitations(
    "结论一。([来源一](https://example.com/one?utm_source=openai))\n结论二。[来源二](https://example.com/two)\n保留 [普通链接](https://local.example/keep)。",
    [
      { title: "来源一", url: "https://example.com/one?utm_source=openai" },
      { title: "来源二", url: "https://example.com/two" },
    ],
  )
  assert(citedText === "结论一。¹\n结论二。²\n保留 [普通链接](https://local.example/keep)。", "hosted search citations should become compact markers without removing unrelated links")
  const indexedParts = splitNaturalReply(`这是第一段，需要有足够长度才能自然切开。${"补充内容".repeat(12)}。给你两个办法选一个：\n- 稍后再搜\n- 直接发 BV 号`, { maxParts: 3, minChars: 80, minPartChars: 40 })
  assert(indexedParts.join("\n").includes("给你两个办法选一个") && !indexedParts.at(-1).startsWith("个："), "natural split should preserve the original text boundary")
  const configuredParts = splitConfiguredReply("第一句。第二句！第三句？", {
    thresholdChars: 150,
    mode: "regex",
    regex: ".*?[。？！]+|.+$",
    contentFilterRegex: "[。？！]",
  })
  assert(configuredParts.join("|") === "第一句|第二句|第三句", "configured segmentation should split and filter model text by regex")
  assert(splitConfiguredReply("超过阈值后保持完整。", { thresholdChars: 4 }).length === 1, "configured segmentation should keep replies at or above the threshold intact")
  assert(configuredSegmentationDelayMs({ intervalMethod: "log", intervalMinSeconds: 1, intervalMaxSeconds: 3 }, 100) === 2000, "log segmentation delay should scale with part length")
  config.response.defaultMode = "text"
  const firstReplies = []
  const firstEvent = {
    isGroup: true,
    group_id: "20001",
    user_id: "990001",
    reply: async (msg, quote, options) => firstReplies.push({ msg, quote, options }),
  }
  await sendChatOutput(firstEvent, { channel: "mock", source: "firstPerson", text: "第一句。第二句！第三句？" }, config, { source: "firstPerson", replyOptions: { recallMsg: 10 } })
  assert(firstReplies.length === 1, "first-person output should no longer use a separate compatibility splitter")
  assert(!String(firstReplies[0].msg).startsWith("[mock]"), "first-person output should omit channel prefix by default")
  assert(firstReplies[0].options?.recallMsg === 10, "first-person replies should preserve reply options")
  config.response.segmentation = {
    enabled: true,
    intervalMethod: "random",
    intervalMinSeconds: 0,
    intervalMaxSeconds: 0,
    thresholdChars: 150,
    mode: "regex",
    regex: ".*?[。？！]+|.+$",
    contentFilterRegex: "",
  }
  const segmentedReplies = []
  await sendChatOutput({
    isGroup: true,
    group_id: "20001",
    user_id: "990001-segmented",
    reply: async msg => segmentedReplies.push(msg),
  }, { channel: "mock", text: "第一句。第二句！第三句？", steps: [{ status: "ok" }] }, config)
  assert(segmentedReplies.length === 3, "text mode should apply the unified LLM segmentation strategy")
  const toolReplies = []
  await sendChatOutput({
    isGroup: true,
    group_id: "20001",
    user_id: "990001-tool",
    reply: async msg => toolReplies.push(msg),
  }, { channel: "mock", source: "tool", text: "第一句。第二句！" }, config, { source: "tool" })
  assert(toolReplies.length === 1, "tool results should always stay intact when text segmentation is enabled")
  const subagentReplies = []
  await sendChatOutput({
    isGroup: true,
    group_id: "20001",
    user_id: "990001-subagent",
    reply: async msg => subagentReplies.push(msg),
  }, { channel: "mock", source: "subagent", text: "第一句。第二句！" }, config, { source: "subagent" })
  assert(subagentReplies.length === 1, "subagent and thinking results should always stay intact")
  config.response.segmentation.enabled = false
  const normalReplies = []
  await sendChatOutput({
    isGroup: true,
    group_id: "20001",
    user_id: "990002",
    reply: async (msg, quote) => normalReplies.push({ msg, quote }),
  }, { channel: "mock", text: "普通回复。" }, config)
  assert(String(normalReplies[0]?.msg || "").startsWith("[mock]"), "normal chat output should keep channel prefix")
  const hostedReplies = []
  const hostedForwardNodes = []
  await sendChatOutput({
    isGroup: true,
    self_id: "99999",
    group_id: "20001",
    user_id: "990002-hosted",
    group: {
      async makeForwardMsg(nodes) {
        hostedForwardNodes.push(...nodes)
        return { type: "node", data: nodes }
      },
    },
    reply: async msg => hostedReplies.push(msg),
  }, {
    channel: "responses",
    text: "远程检索结论。([来源一](https://example.com/one)) 第二条结论。([来源二](https://example.com/two))",
    hostedSearchSources: [
      { title: "来源一", url: "https://example.com/one" },
      { title: "重复来源", url: "https://example.com/one" },
      { title: "来源二", url: "https://example.com/two" },
    ],
  }, config)
  assert(hostedReplies.length === 2 && String(hostedReplies[0]).includes("远程检索结论。¹") && String(hostedReplies[0]).includes("第二条结论。²") && !String(hostedReplies[0]).includes("https://example.com"), "hosted search URLs should leave the visible answer as compact cited text")
  assert(hostedForwardNodes.length === 2 && hostedForwardNodes[0]?.nickname === "OpenAI 远程搜索来源 1" && String(hostedForwardNodes[0]?.message).includes("https://example.com/one"), "hosted search sources should use a deduplicated local merged-forward message")
  const cqReplies = []
  const originalAt = global.segment.at
  global.segment.at = id => ({ type: "at", data: { qq: String(id) } })
  try {
    await sendChatOutput({
      isGroup: true,
      group_id: "20001",
      user_id: "990002-cq",
      reply: async msg => cqReplies.push(msg),
    }, { channel: "mock", text: "提醒 [CQ:at,id=123456]请查看" }, config)
    assert(Array.isArray(cqReplies[0]) && cqReplies[0].some(item => item?.type === "at" && item.data?.qq === "123456"), "chat output should send CQ at as a native segment")
  } finally {
    global.segment.at = originalAt
  }
  const imagePayload = await buildReplyPayload("图片模式回复。", config, {
    forceImage: true,
    e: {
      isGroup: true,
      group_id: "20001",
      user_id: "990003",
      sender: { nickname: "Smoke User" },
    },
    result: {
      channel: "mock",
      adapter: "mock",
      prompt: "请用图片模式回复",
      steps: [{ stepId: "reply", channel: "mock", adapter: "mock", status: "ok", durationMs: 1 }],
      media: { images: 1, mentions: ["123456"] },
    },
  })
  assert(imagePayload.asImage && imagePayload.image?.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "picture mode payload should render a PNG image")
  const imageReplies = []
  await sendChatOutput({
    isGroup: true,
    group_id: "20001",
    user_id: `990004-${Date.now()}`,
    sender: { nickname: "Smoke User" },
    reply: async (msg, quote) => imageReplies.push({ msg, quote }),
  }, { channel: "mock", text: "图片模式文本 fallback。" }, config)
  assert(String(imageReplies[0]?.msg || "").startsWith("[mock]"), "text mode should still send text fallback")
}

async function checkMessageFilters() {
  const { configStore } = await import("../output/runtime/config/store.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { listMessageFilterStages, sortMessageFilters } = await import("../output/runtime/filters/message/message-filter-contract.js")
  const { listMessageFilterTemplates } = await import("../output/runtime/filters/message/message-filter-templates.js")
  const { applyInputFilters, applyOutputFilters } = await import("../output/runtime/filters/message/message-filter-service.js")
  const { filterRegistry } = await import("../output/runtime/filters/core/registry.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const config = JSON.parse(JSON.stringify(await configStore.load()))
  const templates = listMessageFilterTemplates()
  const stages = listMessageFilterStages()
  assert(stages.map(stage => stage.id).join(",") === "input,output", "message filter stage catalog should expose runtime hook metadata")
  const sorted = sortMessageFilters([
    { id: "output-fast", stage: "output", priority: 1 },
    { id: "input-slow", stage: "input", priority: 200 },
    { id: "output-slow", stage: "output", priority: 100 },
    { id: "input-fast", stage: "input", priority: 10 },
  ])
  assert(sorted.map(filter => filter.id).join(",") === "input-fast,input-slow,output-fast,output-slow", "message filters should list input before output and sort priority inside each stage")
  assert(templates.length === 1 && templates[0].filter.enabled === false, "only one disabled message-filter template should ship by default")
  const valid = { ...config.response.messageFilters, filters: [templates[0].filter] }
  assert(validateConfig({ ...config, response: { ...config.response, messageFilters: valid } }).ok, "the built-in message filter template should validate")
  assert(templates[0].filter.implementation?.type === "filter", "new message-filter templates should use native filter implementations")
  const invalid = JSON.parse(JSON.stringify(config))
  invalid.response.messageFilters = { enabled: true, filters: [{ ...templates[0].filter, stage: "before" }] }
  assert(!validateConfig(invalid).ok, "unsupported message filter stages should be rejected")
  await toolRegistry.init()
  await filterRegistry.init()
  const registeredFilters = await filterRegistry.list()
  assert(builtinFilterIds.every(id => registeredFilters.some(filter => filter.id === id && filter.source === "builtin")), "FilterRegistry should own all built-in code filters")
  assert(registeredFilters.find(filter => filter.id === "voice_output")?.effects?.includes("delivery"), "voice output should remain an output delivery filter")
  assert(registeredFilters.find(filter => filter.id === "text_transform")?.stages?.includes("input"), "text transform should remain available before the model")
  const listed = await toolRegistry.list()
  assert(!builtinFilterIds.some(id => listed.some(tool => tool.name === id)), "built-in code filters must be absent from ToolRegistry")
  assert(!listed.some(tool => builtinFilterIds.includes(tool.name) || String(tool.modelDefinition || "").includes("text_transform")), "code filters must not be emitted as model tool definitions")
  const modelTools = await toolRegistry.getAllowedTools({ e: { isMaster: true, isGroup: false, user_id: "smoke-message-filter" } })
  assert(!modelTools.some(tool => builtinFilterIds.includes(tool.name)), "code filters must not consume model tool context")
  const input = await applyInputFilters("  hello  ", {
    e: { isMaster: true, isGroup: false, user_id: "smoke-message-filter" },
    config: { ...config, response: { ...config.response, messageFilters: { enabled: true, filters: [{ id: "trim-input", enabled: true, stage: "input", priority: 100, condition: { minTextLength: 0 }, implementation: { type: "filter", id: "text_transform", arguments: { operation: "trim" } } }] } } },
  })
  assert(input.text === "hello" && !input.blocked, "native filters should inject text automatically and transform user text before the model call")
  const output = await applyOutputFilters("keep secret", {
    e: { isMaster: true, isGroup: false, user_id: "smoke-message-filter" },
    config: { ...config, response: { ...config.response, messageFilters: { enabled: true, filters: [{ id: "filter-output", enabled: true, stage: "output", priority: 100, condition: { minTextLength: 0 }, implementation: { type: "filter", id: "keyword_filter", arguments: { keywords: "secret", action: "remove" } } }] } } },
  })
  assert(output.text === "keep " && !output.blocked, "output filters should transform model text")
  const regexOutput = await applyOutputFilters("编号 123，编号 456", {
    e: { isMaster: true, isGroup: false, user_id: "smoke-message-filter" },
    config: { ...config, response: { ...config.response, messageFilters: { enabled: true, filters: [{ id: "regex-output", enabled: true, stage: "output", priority: 100, condition: { minTextLength: 0 }, implementation: { type: "filter", id: "regex_replace", arguments: { pattern: "\\d+", replacement: "#", flags: "g" } } }] } } },
  })
  assert(regexOutput.text === "编号 #，编号 #", "regex filters should replace text outside the main process")
  const filtersWithoutTools = await applyInputFilters("  independent  ", {
    e: { isMaster: false, isGroup: false, user_id: "smoke-filter-no-tool-permission" },
    config: {
      ...config,
      tools: {
        ...config.tools,
        enabled: false,
        enabledTools: [],
        boundaryAccess: { ...(config.tools?.boundaryAccess || {}), enabled: true, roles: { user: { enabledCategories: [], allowedSources: [], allowedTools: [], deniedTools: ["text_transform"] } } },
      },
      response: { ...config.response, messageFilters: { enabled: true, filters: [{ id: "tool-independent-native", enabled: true, stage: "input", priority: 100, condition: { minTextLength: 0 }, implementation: { type: "filter", id: "text_transform", arguments: { operation: "trim" } } }] } },
    },
  })
  assert(filtersWithoutTools.text === "independent", "native filters must remain independent from Tool enablement and permissions")
  const priorityOutput = await applyOutputFilters("plain", {
    e: { isMaster: true, isGroup: false, user_id: "smoke-message-filter" },
    config: {
      ...config,
      response: {
        ...config.response,
        messageFilters: {
          enabled: true,
          filters: [
            { id: "append-a", enabled: true, stage: "output", priority: 200, condition: { minTextLength: 0 }, implementation: { type: "filter", id: "text_transform", arguments: { operation: "append", suffix: "A" } } },
            { id: "append-b", enabled: true, stage: "output", priority: 10, condition: { minTextLength: 0 }, implementation: { type: "filter", id: "text_transform", arguments: { operation: "append", suffix: "B" } } },
          ],
        },
      },
    },
  })
  assert(priorityOutput.text === "plainBA", "native filters should run from smaller to larger priority")
  assert(priorityOutput.traces.map(trace => trace.filterId).join(",") === "append-b,append-a" && priorityOutput.traces.every(trace => trace.filter === "text_transform"), "native filter ordering should not depend on ToolRegistry")
}

async function checkAccessControl() {
  const { blockUser, checkAccess, clearBlockedUsers, clearMutedScopes, muteScope, unblockUser, unmuteScope } = await import("../output/runtime/core/chat/access-control.js")
  const { preflight } = await import("../output/runtime/core/chat/response-pipeline.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  clearMutedScopes()
  clearBlockedUsers()
  const config = JSON.parse(JSON.stringify(await configStore.load()))
  config.chat.access = {
    privateChatEnabled: false,
    masterBypass: true,
    whitelist: ["20001", "^10003", "20002^10004"],
    blacklist: ["20001^10002"],
  }
  assert(!checkAccess({ isPrivate: true, isMaster: false, user_id: "10001" }, config).ok, "private chat should obey privateChatEnabled")
  assert(checkAccess({ isPrivate: true, isMaster: true, user_id: "master" }, config).ok, "master should bypass access limits")
  assert(checkAccess({ isGroup: true, group_id: "20001", user_id: "10001", sender: { user_id: "10001" } }, config).ok, "whitelisted group should be allowed")
  assert(!checkAccess({ isGroup: true, group_id: "20001", user_id: "10002", sender: { user_id: "10002" } }, config).ok, "group-user blacklist should deny")
  const event = { isGroup: true, group_id: "20001", user_id: "10001", sender: { user_id: "10001" } }
  muteScope(event, { groupId: "20001", durationMs: 60000 })
  const gate = await preflight(event, "hello", config)
  assert(gate.ok === false && gate.silent === true, "muted group should silently fail preflight")
  assert(unmuteScope(event, { groupId: "20001" }), "unmute should clear group mute")
  blockUser(event, { userId: "10001", durationMs: 60000 })
  const blocked = await preflight(event, "hello", config)
  assert(blocked.ok === false && blocked.silent === true && /临时屏蔽/.test(blocked.message), "blocked user should silently fail preflight")
  assert(unblockUser(event, { userId: "10001" }), "unblockUser should clear user block")
}

async function checkRenderService() {
  const { listImageRenderers, registerImageRenderer, renderChatCard, renderCommandHelp, renderConversationList, renderDynamicPanel, renderFunctionPlot, renderHelpMenu, renderImageByConfiguredEngine, renderImageByKind, renderKindCatalog, renderMarkdownDocument, renderMindMap, renderRendererRegistry, renderTextCard, renderWordCloud, unregisterImageRenderer, withRenderScope } = await import("../output/runtime/core/rendering/render-service.js")
  const { assertSafeRenderUrl, isAllowedRenderHost, normalizeMarkdownMathDelimiters, renderHtmlToPng, renderMarkdownHtmlToPng, renderMarkmapHtmlToPng, renderUrlToPng } = await import("../output/runtime/core/rendering/render-html-service.js")
  const { compileFunctionExpression } = await import("../output/runtime/core/rendering/function-plot.js")
  const { resolveRenderImageEngine } = await import("../output/runtime/tools/builtins/render.js")
  const { renderApiOverview, renderPreview } = await import("../output/runtime/core/rendering/render-api-service.js")
  const { buildNextHelpMenu } = await import("../output/runtime/apps/help-menu.js")
  const { deliverRenderedImage, renderAndDeliverImage } = await import("../output/runtime/core/rendering/render-delivery.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  const config = await configStore.load()
  assert(normalizeMarkdownMathDelimiters("\\[x^2\\]\n`\\(raw\\)`\n```tex\n\\[raw\\]\n```") === "$$x^2$$\n`\\(raw\\)`\n```tex\n\\[raw\\]\n```", "rich Markdown should normalize common LaTeX delimiters outside code spans and fences")
  assert(Math.abs(compileFunctionExpression("sin(x) + x^2")(2) - (Math.sin(2) + 4)) < 1e-9, "function plot expressions should use the safe math parser")
  const htmlEngineConfig = JSON.parse(JSON.stringify(config))
  assert(htmlEngineConfig.response.render.html.enabled === false && resolveRenderImageEngine("dynamic-panel", "", htmlEngineConfig) === "html" && resolveRenderImageEngine("markdown", "", htmlEngineConfig) === "html" && resolveRenderImageEngine("mindmap", "auto", htmlEngineConfig) === "html", "unified render_image should keep HTML-first priority independent of the raw HTML screenshot gate")
  const svgPriorityConfig = JSON.parse(JSON.stringify(htmlEngineConfig))
  svgPriorityConfig.response.render.engine = "svg"
  assert(resolveRenderImageEngine("dynamic-panel", "", svgPriorityConfig) === "svg" && resolveRenderImageEngine("markdown", "auto", svgPriorityConfig) === "svg", "global SVG priority should override HTML for every template")
  const systemPriorityConfig = JSON.parse(JSON.stringify(htmlEngineConfig))
  systemPriorityConfig.response.render.engine = "html"
  systemPriorityConfig.response.render.system.engine = "svg"
  assert(resolveRenderImageEngine("dynamic-panel", "", systemPriorityConfig) === "html" && resolveRenderImageEngine("dynamic-panel", "", withRenderScope(systemPriorityConfig, "system")) === "svg", "system rendering priority should be independent from render_image")
  assert(resolveRenderImageEngine("markdown", "", config) === "html", "unified render_image should use the plugin-owned rich Markdown renderer by default")
  assert(resolveRenderImageEngine("markdown", "svg", config) === "svg", "unified render_image should keep the explicit lightweight SVG fallback")
  const card = await renderTextCard({
    title: "Smoke Render",
    subtitle: "渲染服务测试",
    content: "这是一张由 Yui Chat 渲染服务生成的图片。",
  }, config)
  assert(Buffer.isBuffer(card.buffer), "renderTextCard should return a buffer")
  assert(card.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "rendered card should be PNG")
  assert(!card.cache, "render results should not expose a persistent render cache")
  const help = await renderCommandHelp({
    query: "怎么查体力",
    matches: [{ pluginName: "Smoke", description: "体力查询", suggestedCommand: "#体力", reason: "匹配体力查询", permission: "all", event: "message" }],
    stats: { commands: 1, events: 0 },
    config,
  })
  assert(help.buffer.length > 1000, "renderCommandHelp should generate a non-empty image")
  const helpMenu = await renderHelpMenu({
    title: "Smoke 帮助菜单",
    groups: [{
      title: "渲染",
      commands: [
        { command: "#yui渲染帮助菜单", description: "帮助菜单图片", permission: "master" },
        { command: "#yui渲染动态 状态", description: "动态面板图片", permission: "master" },
      ],
    }],
  }, config)
  assert(helpMenu.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "renderHelpMenu should return PNG")
  const builtMenu = buildNextHelpMenu(config)
  assert(builtMenu.groups.length >= 3 && builtMenu.groups.some(group => group.title === "统一渲染" && group.commands.some(command => command.command.includes("render_image"))), "built-in help menu data should expose the unified render entry")
  const sent = []
  const mockEvent = {
    isGroup: true,
    group_id: "20001",
    user_id: "10001",
    reply(payload) {
      sent.push(payload)
      return true
    },
  }
  const delivered = await deliverRenderedImage(helpMenu, { e: mockEvent, config }, { label: "帮助菜单图片" })
  assert(delivered.includes("群 20001") && sent.length === 1 && sent[0] !== undefined, "render delivery should send current chat image")
  const renderedAndDelivered = await renderAndDeliverImage("dynamic-panel", {
    title: "交付测试",
    metrics: [{ label: "delivery", value: "OK" }],
  }, { e: mockEvent, config }, { label: "动态面板图片" })
  assert(renderedAndDelivered.includes("动态面板图片") && sent.length === 2, "renderAndDeliverImage should render by kind and deliver")
  let blockedTarget = false
  try {
    await deliverRenderedImage(helpMenu, {
      e: { ...mockEvent, isMaster: true, bot: { pickGroup: async () => ({ sendMsg() {} }) } },
      config,
    }, { label: "帮助菜单图片", targetType: "group", targetId: "30001" })
  } catch (err) {
    blockedTarget = /默认关闭/.test(err.message)
  }
  assert(blockedTarget, "render delivery should block cross-target sends by default")
  const chatCard = await renderChatCard({
    prompt: "帮我总结当前插件能力",
    answer: "已支持富聊天卡片、指令帮助图和动态面板。",
    sender: { userId: "10001", name: "Smoke User" },
    scope: { type: "group", groupId: "20001", groupName: "Smoke Group" },
    media: { images: 1, mentions: ["123456"] },
    metadata: { channel: "mock", adapter: "mock", toolRounds: 1 },
    steps: [{ stepId: "reply", channel: "mock", adapter: "mock", status: "ok", durationMs: 2 }],
  }, config)
  assert(chatCard.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "renderChatCard should return PNG")
  assert(!chatCard.cache, "chat cards should not expose a persistent render cache")
  const thumbnailChatCard = await renderChatCard({
    prompt: "这张图是什么？",
    answer: "这是一张用于 smoke 的 tiny PNG 缩略图。",
    sender: { userId: "10001", name: "Smoke User" },
    scope: { type: "group", groupId: "20001", groupName: "Smoke Group" },
    media: {
      images: 1,
      thumbnails: [{ dataUrl: tinyPngDataUrl, source: "smoke-data-url", mimeType: "image/png" }],
    },
  }, config)
  assert(thumbnailChatCard.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "renderChatCard should render media data-url thumbnails")
  assert(renderKindCatalog.some(item => item.kind === "chat-card" && item.toolName === "render_image"), "render catalog should use unified image tool")
  assert(renderKindCatalog.some(item => item.kind === "help-menu" && item.toolName === "render_image"), "render catalog should use unified image tool")
  assert(renderKindCatalog.some(item => item.kind === "conversation-list" && item.toolName === "render_image"), "render catalog should use unified image tool")
  assert(renderKindCatalog.some(item => item.kind === "function-plot" && item.publicTemplate === false), "internal function plot scenario should stay available without being a public template")
  assert(renderKindCatalog.every(item => !Object.hasOwn(item, "engine") && item.toolName && item.description), "render catalog entries should use the shared engine strategy")
  assert(renderKindCatalog.every(item => typeof renderRendererRegistry[item.kind]?.render === "function"), "each render catalog kind should have a renderer object")
  assert(listImageRenderers().every(item => Array.isArray(item.aliases) && Array.isArray(item.tags)), "renderer listing should expose cloned aliases and tags")
  assert(listImageRenderers(true).map(item => item.kind).join(",") === "text-card,markdown,mindmap", "public renderer listing should only expose the three base templates")
  assert(renderRendererRegistry.help.kind === "command-help", "render renderer registry should expose aliases")
  const apiOverview = await renderApiOverview(config)
  assert(apiOverview.catalog.some(item => item.kind === "markdown") && !apiOverview.catalog.some(item => item.kind === "dynamic-panel"), "render API overview should expose only public templates")
  assert(apiOverview.system?.engine === config.response.render.system.engine && !Object.hasOwn(apiOverview.system || {}, "chatCardAsImage") && !Object.hasOwn(apiOverview.system || {}, "helpAsImage") && !Object.hasOwn(apiOverview.system || {}, "conversationListAsImage"), "render API overview should expose the independent system rendering strategy")
  assert(apiOverview.html.enabled === false, "render API overview should expose disabled HTML backend by default")
  assert(apiOverview.html.allowedUrlHosts?.join(",") === "*", "render API overview should expose the default all-domain URL host policy")
  const webPreview = await renderPreview({
    template: "text-card",
    data: { title: "Web 预览", sections: [{ title: "说明", lines: ["Web render preview 正常"] }] },
  }, config)
  assert(webPreview.imageBase64 && Buffer.from(webPreview.imageBase64, "base64").subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "render preview API should return base64 PNG")
  assert(!webPreview.cache && !apiOverview.cache, "render API should not expose persistent render cache state")
  const unifiedMarkdown = await renderImageByConfiguredEngine("markdown", { title: "统一分发", markdown: "# OK" }, config)
  assert(unifiedMarkdown.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" && unifiedMarkdown.meta?.requestedEngine === "html", "configured engine dispatcher should render public Markdown through the selected priority")
  registerImageRenderer({
    kind: "smoke-card",
    label: "Smoke 卡片",
    toolName: "render_smoke_card",
    command: "#yui渲染Smoke",
    description: "Smoke-only renderer registration test.",
    aliases: ["smoke_card", "smoke_alias"],
    tags: ["smoke"],
    render: (input, currentConfig) => renderTextCard({ title: input.title || "Smoke Registry", content: "renderer registry ok" }, currentConfig),
  })
  assert(renderRendererRegistry["smoke-card"]?.kind === "smoke-card" && renderRendererRegistry["smoke-alias"]?.kind === "smoke-card", "custom renderer should register normalized kind and aliases")
  const customRender = await renderImageByKind("smoke_card", { title: "Smoke Registry" }, config)
  assert(customRender.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "custom registered renderer should render PNG")
  assert(unregisterImageRenderer("smoke-card"), "custom renderer should unregister cleanly")
  assert(!renderRendererRegistry["smoke-card"] && !renderRendererRegistry["smoke-alias"] && !renderRendererRegistry.smoke_card, "custom renderer aliases should be removed")
  const conversations = await renderConversationList([{
    channel: "mock",
    type: "group",
    groupId: "20001",
    userId: "10001",
    turns: 2,
    historyMessages: 4,
    lastSeenAt: "2026-06-08 12:00:00",
    preview: "渲染会话列表测试",
  }], config)
  assert(conversations.buffer.length > 1000, "renderConversationList should generate a non-empty image")
  const markdown = await renderMarkdownDocument({
    title: "公式与图表",
    markdown: "# 计算\n\n$$a^2+b^2=c^2$$\n\n```mermaid\nflowchart LR\nA[Start] --> B[Done]\n```",
  }, config)
  assert(markdown.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "renderMarkdownDocument should return PNG")
  const mindmap = await renderMindMap({
    title: "重构计划",
    markdown: "# 重构计划\n## 工具\n### 渲染\n- 帮助图\n- 思维导图\n## 配置\n- 权限组",
  }, config)
  assert(mindmap.buffer.length > 1000, "renderMindMap should generate a non-empty image")
  const wordCloud = await renderWordCloud({
    title: "关键词",
    words: [{ text: "工具", weight: 8 }, { text: "渲染", weight: 6 }, { text: "配置", weight: 4 }],
  }, config)
  assert(wordCloud.buffer.length > 1000, "renderWordCloud should generate a non-empty image")
  const dynamicPanel = await renderDynamicPanel({
    title: "运行状态",
    metrics: [{ label: "工具", value: "4" }, { label: "缓存", value: "OK" }],
    sections: [{ title: "说明", lines: ["动态状态图片渲染正常"] }],
  }, config)
  assert(dynamicPanel.buffer.length > 1000, "renderDynamicPanel should generate a non-empty image")
  const generic = await renderImageByKind("dynamic-panel", {
    title: "通用渲染入口",
    metrics: [{ label: "入口", value: "OK" }],
    sections: [{ title: "说明", lines: ["renderImageByKind 正常"] }],
  }, config)
  assert(generic.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "renderImageByKind should return PNG")
  const genericConversations = await renderImageByKind("conversations", {
    rows: [{ channel: "mock", type: "private", userId: "10001", turns: 1, historyMessages: 2 }],
  }, config)
  assert(genericConversations.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "renderImageByKind should normalize conversations alias")
  const genericHelpMenu = await renderImageByKind("menu", {
    title: "通用帮助菜单",
    groups: [{ title: "入口", lines: ["#yuihelp 怎么查体力", "#yuichat 你好"] }],
  }, config)
  assert(genericHelpMenu.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "renderImageByKind should normalize menu alias")
  const functionPlot = await renderFunctionPlot({ title: "Smoke Function", expressions: ["sin(x)", "x^2/8"], xMin: -6, xMax: 6 }, config)
  assert(functionPlot.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "safe function plot renderer should return PNG")
  const webAppSource = await readWebServerSource()
  const webShellSource = await fs.readFile(path.join(pluginRoot, "web/http/shell.ts"), "utf8")
  const webRenderToolsSource = await readWebToolsSource()
  assert(webAppSource.includes("/api/render/templates") && webAppSource.includes("/api/render/preview"), "web app should expose render template API routes")
  assert(webShellSource.includes("assetVersion") && webShellSource.includes("assets/main.js?v="), "web shell should version the SPA entry to avoid stale browser modules")
  assert(webRenderToolsSource.includes("/api/render/preview") && webRenderToolsSource.includes("isFoldedRenderTool") && webRenderToolsSource.includes("response.render.engine") && webRenderToolsSource.includes("工具渲染") && webRenderToolsSource.includes("系统渲染策略") && webRenderToolsSource.includes("SystemRenderStrategyPanel") && !webRenderToolsSource.includes("aiMarkdownEngine") && !webRenderToolsSource.includes("chatCardAsImage"), "tools page should expose one independent strategy per render scope")
  assert(webRenderToolsSource.includes("render_image"), "tools page should keep the unified render_image entry")
  assert(webRenderToolsSource.includes("PermissionPreviewResult") && webRenderToolsSource.includes("showPreviewDrawer"), "role permission verification should use the shared preview drawer")
  assert(webRenderToolsSource.includes("openRolePreview") && webRenderToolsSource.includes("全部角色对比"), "permission verification should compare roles without expanding the role cards")
  assert(!webAppSource.includes("data-tab=\"renderers\"") && !webRenderToolsSource.includes("function renderRenderers"), "web UI should not expose a standalone renderers page")
  assert(isAllowedRenderHost("assets.example.com", ["*.example.com"]), "URL screenshot allowlist should support wildcard subdomains")
  assert(isAllowedRenderHost("anything.example", ["*"]), "URL screenshot host policy should support an explicit all-domain wildcard")
  assert(!isAllowedRenderHost("example.com", ["*.example.com"]), "wildcard URL screenshot entries should not include the root domain")
  assert(isAllowedRenderHost("EXAMPLE.com.", ["example.com"]), "URL screenshot allowlist should normalize hostname case and trailing dots")
  let blockedUnlistedUrl = false
  const restrictedHostConfig = JSON.parse(JSON.stringify(config))
  restrictedHostConfig.security.linkSafety.screenshotAllowedHosts = ["example.com"]
  try {
    await assertSafeRenderUrl("https://not-allowed.invalid/path", restrictedHostConfig)
  } catch (err) {
    blockedUnlistedUrl = /允许域名|允许列表/.test(err.message)
  }
  assert(blockedUnlistedUrl, "URL screenshot safety should reject hosts outside the explicit allowlist before network access")
  const allowlistedConfig = JSON.parse(JSON.stringify(config))
  allowlistedConfig.security.linkSafety.screenshotAllowedHosts = ["127.0.0.1"]
  allowlistedConfig.security.linkSafety.allowPrivateHosts = false
  let blockedLocalUrl = false
  try {
    await assertSafeRenderUrl("http://127.0.0.1:2536/yui-chat", allowlistedConfig)
  } catch {
    blockedLocalUrl = true
  }
  assert(blockedLocalUrl, "URL screenshot safety should still block allowlisted localhost/private URLs by default")
  let disabledBackend = false
  try {
    await renderUrlToPng("https://example.com", {}, config)
  } catch (err) {
    disabledBackend = /未启用/.test(err.message)
  }
  assert(disabledBackend, "URL screenshot backend should be disabled by default")
  disabledBackend = false
  try {
    await renderHtmlToPng("<main>hello</main>", {}, config)
  } catch (err) {
    disabledBackend = /未启用/.test(err.message)
  }
  assert(disabledBackend, "HTML screenshot backend should be disabled by default")
  try {
    const markmap = await renderMarkmapHtmlToPng({ title: "HTML Markmap", markdown: "# hello" }, config)
    assert(markmap?.buffer, "internal Markmap HTML renderer should return an image when available")
  } catch (err) {
    assert(!/未启用/.test(err.message), "internal Markmap HTML renderer should not require the raw HTML backend")
  }
  for (const resource of [
    "resources/render/math/css/katex.min.css",
    "resources/render/math/css/fonts/KaTeX_Main-Regular.woff2",
    "resources/render/math/js/katex.min.js",
    "resources/render/math/js/markdown-it.min.js",
    "resources/render/math/js/mermaid.min.js",
    "resources/render/math/js/index.js",
    "resources/render/markmap/d3.js",
    "resources/render/markmap/markmap-lib.js",
    "resources/render/markmap/markmap-view.js",
  ]) {
    assert(await exists(path.join(pluginRoot, resource)), `HTML render resource should exist: ${resource}`)
  }
}

async function checkCommandRules() {
  const { YuiChat } = await import("../output/runtime/apps/chat.js")
  const { YuiChatMaster } = await import("../output/runtime/apps/master.js")
  const { PLUGIN_COMMAND_PREFIX, PLUGIN_COMMAND_PREFIX_PATTERN, pluginCommand } = await import("../output/runtime/core/message/command-prefixes.js")
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { filterRegistry } = await import("../output/runtime/filters/core/registry.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const app = new YuiChat()
  const masterApp = new YuiChatMaster()
  const publicRules = app.rule || app.options?.rule || []
  const masterRules = masterApp.rule || masterApp.options?.rule || []
  const rules = [...publicRules, ...masterRules]
  const match = text => rules.some(rule => new RegExp(rule.reg).test(text))
  const explicitMatch = text => rules.some(rule => rule.fnc !== "firstPersonCall" && new RegExp(rule.reg).test(text))
  const methodNames = new Set(rules.map(rule => rule.fnc))
  const webLoginRule = rules.find(rule => rule.fnc === "webLogin")
  const explicitRules = rules.filter(rule => rule.fnc !== "firstPersonCall")
  assert(PLUGIN_COMMAND_PREFIX === "#yui" && pluginCommand("chat") === "#yuichat", "plugin commands should derive display text from the single prefix regexp")
  assert(explicitRules.every(rule => String(rule.reg).startsWith(PLUGIN_COMMAND_PREFIX_PATTERN.source)), "every explicit command rule should derive from the single plugin prefix regexp")
  assert(masterRules.length > 0 && masterRules.every(rule => rule.permission === "master"), "the dedicated master command entry should enforce master permission on every rule")
  assert(publicRules.every(rule => !rule.permission), "the public chat entry should not retain master command registrations")
  assert(Number(masterApp.priority ?? masterApp.options?.priority) < Number(app.priority ?? app.options?.priority), "the master command entry should run before the public catch-all rule")
  assert(!explicitMatch("#aichat 你好") && !explicitMatch("#ai面板"), "retired #ai commands should not stay registered")
  assert(defaults.persona.firstPerson === "埋埋", "default first-person trigger should be 埋埋")
  assert(webLoginRule?.permission === "master", "#yui面板 quick-login issuance must stay protected by the host master permission")
  assert(match("#yui第一人称"), "#yui第一人称 should be registered")
  assert(match("#yui第一人称关闭"), "#yui第一人称关闭 should be registered")
  assert(match("#yui第一人称概率20"), "#yui第一人称概率 should be registered")
  assert(match("#yui第一人称随机开启"), "#yui第一人称随机开启 should be registered")
  assert(match("#yui第一人称旁路关闭"), "#yui第一人称旁路关闭 should be registered")
  assert(match("#yui第一人称戳一戳开启"), "#yui第一人称戳一戳开启 should be registered")
  assert(match("#yui第一人称戳一戳关闭"), "#yui第一人称戳一戳关闭 should be registered")
  assert(match("#yui第一人称冷却30秒"), "#yui第一人称冷却 should be registered")
  assert(match("#yui第一人称禁用本群"), "#yui第一人称禁用本群 should be registered")
  assert(match("#yui打招呼"), "#yui打招呼 should be registered")
  assert(match("#yui打招呼123456789"), "#yui打招呼+group should be registered")
  assert(match("#yui设置AI第一人称埋埋"), "#yui设置AI第一人称 should be registered")
  assert(!explicitMatch("#yui学习表达 用户：你好\n回复：你好呀"), "retired #yui学习表达 command must not be registered")
  assert(!explicitMatch("#yui表达样例"), "retired #yui表达样例 command must not be registered")
  assert(match("#yui对话列表"), "#yui对话列表 should be registered")
  assert(match("#yui定时任务") && match("#yui我的定时任务列表"), "self schedule list commands should be registered")
  assert(match("#yui全部定时任务") && match("#yui所有定时任务列表"), "master schedule list commands should be registered")
  const allScheduleRule = rules.find(rule => rule.fnc === "allScheduleTaskList")
  const selfScheduleRule = rules.find(rule => rule.fnc === "scheduleTaskList")
  assert(allScheduleRule?.permission === "master" && !selfScheduleRule?.permission, "only the all-user schedule list command should require master permission")
  assert(match("#yui渲染帮助"), "#yui渲染帮助 should be registered")
  assert(match("#yui渲染帮助菜单"), "#yui渲染帮助菜单 should be registered")
  assert(match("#yui渲染菜单"), "#yui渲染菜单 should be registered")
  assert(match("#yui渲染能力"), "#yui渲染能力 should be registered")
  assert(match("#yui渲染工具"), "#yui渲染工具 should be registered")
  assert(match("#yui截图URL https://example.com"), "#yui截图URL should be registered")
  assert(match("#yui截图HTML <main>hello</main>"), "#yui截图HTML should be registered")
  assert(match("#yui测试工具 weather {\"city\":\"上海\"}"), "#yui测试工具 should be registered")
  assert(match("#yui工具参数 weather"), "#yui工具参数 should be registered")
  assert(match("#yui测试过滤器 text_transform text=你好 operation=trim"), "#yui测试过滤器 should be registered")
  assert(match("#yui过滤器参数 text_transform"), "#yui过滤器参数 should be registered")
  assert(match("#yui渲染MarkdownHTML 标题\n# 内容"), "#yui渲染MarkdownHTML should be registered")
  assert(match("#yui渲染Markdown 标题\n# 内容"), "#yui渲染Markdown should be registered")
  assert(match("#yui渲染思维导图 标题\n# 根节点"), "#yui渲染思维导图 should be registered")
  assert(match("#yui渲染思维导图HTML 标题\n# 根节点"), "#yui渲染思维导图HTML should be registered")
  assert(match("#yui渲染MarkmapHTML 标题\n# 根节点"), "#yui渲染MarkmapHTML should be registered")
  assert(match("#yui渲染词云 标题\n工具 工具 渲染"), "#yui渲染词云 should be registered")
  assert(match("#yui渲染动态 状态\n工具=7\n缓存=OK"), "#yui渲染动态 should be registered")
  const hiddenConfigCommand = ["#yui", "导入配置"].join("")
  assert(!explicitMatch(hiddenConfigCommand), "hidden config fragment alias should stay unregistered")
  assert(!explicitMatch("#yui载入配置片段"), "retired config fragment command should not be registered")
  assert(match("#yui结束对话 @123"), "#yui结束对话 @user should be registered")
  assert(match("#yui本群闭嘴10分钟"), "#yui本群闭嘴 should be registered")
  assert(match("#yui本群张嘴"), "#yui本群张嘴 should be registered")
  assert(match("#yui查看闭嘴列表"), "#yui查看闭嘴列表 should be registered")
  assert(methodNames.has("firstPersonSettings"), "firstPersonSettings handler should exist")
  assert(methodNames.has("initiativeGreeting"), "initiativeGreeting handler should exist")
  assert(methodNames.has("firstPersonTriggerSettings"), "firstPersonTriggerSettings handler should exist")
  assert(methodNames.has("setFirstPerson"), "setFirstPerson handler should exist")
  assert(!methodNames.has("learnExpression") && !methodNames.has("expressionExamples"), "retired persona expression handlers must be removed")
  assert(methodNames.has("conversationList"), "conversationList handler should exist")
  assert(methodNames.has("scheduleTaskList") && methodNames.has("allScheduleTaskList"), "schedule list handlers should exist")
  assert(methodNames.has("renderImageCommand"), "renderImageCommand handler should exist")
  assert(methodNames.has("screenshotHtml"), "screenshotHtml handler should exist")
  assert(methodNames.has("testToolCommand"), "testToolCommand handler should exist")
  assert(methodNames.has("toolParameterCommand"), "toolParameterCommand handler should exist")
  assert(methodNames.has("testFilterCommand"), "testFilterCommand handler should exist")
  assert(methodNames.has("filterParameterCommand"), "filterParameterCommand handler should exist")
  const originalAllowedTools = toolRegistry.getAllowedTools
  const originalExecute = toolRegistry.execute
  const originalFilterList = filterRegistry.list
  const originalFilterGet = filterRegistry.get
  const originalFilterExecute = filterRegistry.execute
  const replies = []
  let receivedArgs = null
  let receivedFilterArgs = null
  try {
    toolRegistry.getAllowedTools = async () => [{
      name: "demo_echo",
      parameters: { type: "object", properties: { city: { type: "string", description: "城市" }, days: { type: "integer", description: "天数" } }, required: ["city"] },
    }]
    toolRegistry.execute = async (name, args) => {
      receivedArgs = { name, args }
      return { ok: true }
    }
    masterApp.reply = async text => { replies.push(String(text)); return true }
    masterApp.e = { isMaster: true, isGroup: false, user_id: "smoke-master", msg: "#yui面板" }
    await masterApp.webLogin()
    assert(/\?quick=[A-Za-z0-9_-]+/.test(replies.at(-1)) && replies.at(-1).includes("3 分钟内有效") && replies.at(-1).includes("只能使用一次"), "#yui面板 should be the owner-facing quick-code issuance path")
    masterApp.e = { isMaster: true, msg: "#yui测试工具 demo_echo city=上海 days=3" }
    await masterApp.testToolCommand()
    assert(receivedArgs?.name === "demo_echo" && receivedArgs.args.city === "上海" && receivedArgs.args.days === 3, "tool command should parse key=value shortcuts")
    masterApp.e.msg = "#yui工具参数 demo_echo"
    await masterApp.toolParameterCommand()
    assert(replies.at(-1).includes("city（string，必填）") && replies.at(-1).includes("#yui测试工具 demo_echo city=示例"), "tool parameter command should explain schema and shortcut")
    const demoFilter = {
      id: "demo_filter",
      displayName: "Demo Filter",
      displayNameZh: "演示过滤器",
      stages: ["input", "output"],
      effects: ["pure"],
      parameters: { type: "object", properties: { text: { type: "string" }, suffix: { type: "string", description: "后缀" } }, required: ["text"] },
    }
    filterRegistry.list = async () => [demoFilter]
    filterRegistry.get = name => name === "demo_filter" ? demoFilter : null
    filterRegistry.execute = async (name, payload, context) => {
      receivedFilterArgs = { name, payload, context }
      return { kind: "text", text: `${payload.text}${payload.params.suffix || ""}` }
    }
    masterApp.e.msg = "#yui测试过滤器 demo_filter text=你好 suffix=！ stage=input"
    await masterApp.testFilterCommand()
    assert(receivedFilterArgs?.name === "demo_filter" && receivedFilterArgs.payload.text === "你好" && receivedFilterArgs.payload.params.suffix === "！" && receivedFilterArgs.context.stage === "input", "filter command should pass text as automatic context and keep only extra parameters")
    masterApp.e.msg = "#yui过滤器参数 demo_filter"
    await masterApp.filterParameterCommand()
    assert(replies.at(-1).includes("正文会自动作为 text 上下文传入") && !replies.at(-1).includes("text（string"), "filter parameter command should hide automatic text input and explain the context")
  } finally {
    toolRegistry.getAllowedTools = originalAllowedTools
    toolRegistry.execute = originalExecute
    filterRegistry.list = originalFilterList
    filterRegistry.get = originalFilterGet
    filterRegistry.execute = originalFilterExecute
  }
  const { apps } = await import("../index.js")
  assert(apps.YuiChatMaster, "dedicated master command app should be exported")
  assert(apps.YuiChatGroupPoke, "group poke notice app should be exported")
  assert(apps.YuiChatFriendPoke, "friend poke notice app should be exported")
  assert(apps.YuiChatNotifyPoke, "notify poke notice app should be exported")
}

async function checkPersonaTrigger() {
  const { evaluateFirstPersonPokeTrigger, evaluateFirstPersonTrigger, clearPersonaTriggerState } = await import("../output/runtime/core/persona/persona-trigger.js")
  const { armConversationContinuation, clearConversationContinuationState } = await import("../output/runtime/core/persona/conversation-continuation.js")
  const { buildPersonaDigest } = await import("../output/runtime/core/persona/persona-digest.js")
  const { handleFirstPersonMessage, handleFirstPersonPokeEvent } = await import("../output/runtime/core/persona/first-person-service.js")
  const { chatService } = await import("../output/runtime/core/chat/chat-service.js")
  const { buildPersonaMessages, buildPersonaMessagesWithContext, formatPersonaBeijingTime } = await import("../output/runtime/core/persona/persona-chain.js")
  const { recentContextStore } = await import("../output/runtime/core/chat/recent-context.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  const config = JSON.parse(JSON.stringify(await configStore.load()))
  config.persona.firstPerson = "埋埋"
  config.persona.aliases = []
  config.persona.characterPrompt = "Smoke 角色设定：你是[first_person]，请保持准确。"
  config.persona.trigger = {
    probabilityPercent: 0,
    alwaysRespondToName: false,
    alwaysRespondToAt: false,
    cooldownMs: 0,
    groupCooldownMs: 0,
    disabledGroupIds: [],
    enhanceKeywords: ["吵架"],
    enhancePrompt: "触发了特殊语气增强。",
    enhanceRecallMs: 10000,
    ambient: { enabled: false, groupOnly: true, minMessageChars: 2, probabilityPercent: 0 },
    poke: {
      enabled: true,
      respondToBotPoke: true,
      responseMode: "ai-with-fallback",
      probabilityPercent: 100,
      cooldownMs: 0,
      groupCooldownMs: 0,
      prompt: "用户戳了[first_person]，请回应。",
      fallbackMessages: ["[first_person]收到戳戳"],
    },
  }
  const event = { isGroup: true, group_id: "20001", user_id: "10001", msg: "埋埋出来吵架", sender: { user_id: "10001" } }
  assert(!evaluateFirstPersonTrigger({ ...event, msg: "普通群聊消息" }, config).ok, "ambient trigger should be disabled by default")
  config.persona.trigger.ambient.enabled = true
  assert(!evaluateFirstPersonTrigger({ ...event, msg: "普通群聊消息" }, config).ok, "ambient probability 0 should block normal messages")
  config.persona.trigger.ambient.probabilityPercent = 100
  const ambient = evaluateFirstPersonTrigger({ ...event, msg: "普通群聊消息" }, config)
  assert(ambient.ok && ambient.reason === "ambient" && config.persona.trigger.probabilityPercent === 0, "ambient participation should use its own probability instead of the name-trigger probability")
  config.persona.respondToFirstPersonCall = false
  const ambientWithDirectNameDisabled = evaluateFirstPersonTrigger({ ...event, msg: "另一条普通群聊消息" }, config)
  assert(ambientWithDirectNameDisabled.ok && ambientWithDirectNameDisabled.reason === "ambient", "ambient participation should remain independent from direct name trigger switch")
  assert(!evaluateFirstPersonTrigger({ ...event, msg: "埋埋看看这条消息" }, config).ok, "ambient participation should not consume a disabled direct-name message")
  config.persona.respondToFirstPersonCall = true
  assert(!evaluateFirstPersonTrigger({ ...event, isGroup: false, msg: "普通私聊消息" }, config).ok, "ambient trigger should default to group-only")
  config.persona.trigger.probabilityPercent = 0
  config.persona.trigger.ambient.enabled = false
  assert(!evaluateFirstPersonTrigger(event, config).ok, "probability 0 should block when direct bypass is disabled")
  config.persona.trigger.alwaysRespondToName = true
  const direct = evaluateFirstPersonTrigger(event, config)
  assert(direct.ok && direct.reason === "direct-name", "direct name should bypass probability")
  assert(direct.extraSystemPrompt.includes("特殊语气"), "keyword enhance prompt should be attached")
  assert(direct.outputOptions?.recallMsg === 10, "keyword enhance recall should be exposed as reply options")
  assert(direct.matchedEnhanceKeywords.includes("吵架"), "keyword enhance trigger should expose matched keywords")
  clearConversationContinuationState()
  armConversationContinuation(event, "帮我识别一张图", "我还没有看到图片，请直接发一张图片给我。")
  const mediaContinuationEvent = {
    ...event,
    msg: "[CQ:image,file=continuation-smoke]",
    raw_message: "[CQ:image,file=continuation-smoke]",
    message: [{ type: "image", data: { url: "https://multimedia.nt.qq.com.cn/download?fileid=continuation-smoke" } }],
  }
  const mediaContinuation = evaluateFirstPersonTrigger(mediaContinuationEvent, config)
  assert(mediaContinuation.ok && mediaContinuation.reason === "continuation" && mediaContinuation.continuationReason === "media", "a requested image sent within the reply window should trigger one contextual continuation without a name or keyword")
  assert(!evaluateFirstPersonTrigger(mediaContinuationEvent, config).ok, "a contextual continuation window should be consumed after one automatic trigger")
  armConversationContinuation(event, "帮我整理方案", "方案已经整理好了。")
  assert(!evaluateFirstPersonTrigger({ ...event, msg: "今晚吃火锅" }, config).ok, "an unrelated message inside the short window should not be taken over")
  clearConversationContinuationState()
  config.persona.trigger.disabledGroupIds = ["20001"]
  assert(!evaluateFirstPersonTrigger(event, config).ok, "disabled group should block first-person trigger")
  config.persona.trigger.disabledGroupIds = []
  const pokeEvent = { isGroup: true, group_id: "20001", operator_id: "10001", target_id: "99999", self_id: "99999", notice_type: "group", sub_type: "poke" }
  const poke = evaluateFirstPersonPokeTrigger(pokeEvent, config)
  assert(poke.ok && poke.reason === "poke" && poke.prompt.includes("埋埋"), "poke trigger should respond to direct bot poke")
  assert(!evaluateFirstPersonPokeTrigger({ ...pokeEvent, target_id: "88888" }, config).ok, "poke trigger should ignore pokes to other users")
  assert(!evaluateFirstPersonPokeTrigger({ ...pokeEvent, operator_id: "99999" }, config).ok, "poke trigger should ignore bot self-poke loops")
  config.persona.trigger.poke.probabilityPercent = 101
  assert(!validateConfig(config).ok, "invalid poke trigger probability should fail validation")
  config.persona.trigger.poke.probabilityPercent = 100
  config.persona.trigger.poke.responseMode = "broken-mode"
  assert(!validateConfig(config).ok, "invalid poke response mode should fail validation")
  config.persona.trigger.poke.responseMode = "ai-with-fallback"
  config.persona.trigger.ambient.probabilityPercent = 101
  assert(!validateConfig(config).ok, "invalid ambient participation probability should fail validation")
  config.persona.trigger.ambient.probabilityPercent = 10
  config.persona.trigger.disabledGroupIds = ["20001"]
  assert(!evaluateFirstPersonPokeTrigger(pokeEvent, config).ok, "disabled group should block poke trigger")
  config.persona.trigger.disabledGroupIds = []
  config.persona.trigger.probabilityPercent = 101
  assert(!validateConfig(config).ok, "invalid persona trigger probability should fail validation")
  config.persona.trigger.probabilityPercent = 100
  const validRuntimePrompt = config.persona.runtimePrompt
  config.persona.runtimePrompt = ""
  assert(!validateConfig(config).ok, "empty persona runtime prompt should fail validation")
  config.persona.runtimePrompt = "x".repeat(50001)
  assert(!validateConfig(config).ok, "oversized persona runtime prompt should fail validation")
  config.persona.runtimePrompt = validRuntimePrompt
  const fixedTime = formatPersonaBeijingTime(new Date("2026-09-01T04:34:56.000Z"))
  assert(fixedTime === "当前北京时间：2026-09-01 12:34（星期二）", "persona time context should use the compact Beijing-time format")
  const digest = await buildPersonaDigest(config)
  assert(digest.identity.firstPerson === "埋埋", "persona digest should expose first-person identity")
  assert(!Object.hasOwn(digest.identity, "states") && !Object.hasOwn(digest.identity, "stateCount") && !Object.hasOwn(digest.identity, "expression"), "persona digest should no longer expose expression or state controls")
  assert(digest.trigger.probabilityPercent === 100, "persona digest should expose trigger probability")
  assert(digest.trigger.ambientEnabled === false, "persona digest should expose ambient trigger state")
  assert(digest.trigger.ambientProbabilityPercent === 10, "persona digest should expose ambient participation probability")
  assert(digest.trigger.enhanceRecallMs === 10000, "persona digest should expose enhance recall")
  assert(digest.trigger.pokeEnabled === true, "persona digest should expose poke trigger state")
  assert(digest.context.recentMessageCount === config.context.recentMessageCount, "persona digest should expose the unified recent-message count")
  assert(!Object.hasOwn(digest.context, "recentEnabled") && !Object.hasOwn(digest.context, "injectRecent") && !Object.hasOwn(digest.context, "maxMessages") && !Object.hasOwn(digest.context, "injectLimit"), "persona digest should not expose retired context controls")
  assert(digest.knowledge.commands >= 0, "persona digest should expose command knowledge state")
  assert(digest.knowledge.characterPromptEnabled === true, "persona digest should expose editable character prompt state")
  assert(digest.prompt.runtimePrompt.includes("使用工具搜索") && digest.prompt.defaultRuntimePrompt === digest.prompt.runtimePrompt && digest.prompt.characterPrompt.includes("Smoke 角色设定") && digest.prompt.composedPreview.includes("【系统运行规则】") && digest.prompt.currentTime.includes("当前北京时间："), "persona digest should expose current and default runtime prompts, the character setting, composed preview, and current Beijing time")
  assert(digest.memory.enabled === true, "persona digest should expose memory state")
  assert(digest.media.enabled === true, "persona digest should expose media state")
  assert(digest.output.defaultMode === config.response.defaultMode && !Object.hasOwn(digest.output, "splitMaxParts"), "persona digest should expose unified output state without legacy split controls")
  const defaultConfig = await configStore.load()
  const defaultPersonaMessages = await buildPersonaMessages({ isGroup: false, user_id: "default-user", sender: { nickname: "Default" } }, "你好", defaultConfig)
  const defaultPersonaPrompt = defaultPersonaMessages[0]?.content || ""
  assert(defaultPersonaPrompt.includes("可靠、自然、简洁") && defaultPersonaPrompt.includes("不编造") && defaultPersonaPrompt.includes("使用工具搜索") && defaultPersonaPrompt.includes("<EMPTY>"), "default composed prompt should include the character setting and default runtime rules")
  assert(defaultPersonaPrompt.includes("使用可用的消息投递能力") && defaultPersonaPrompt.includes("只声称看到了本轮实际提供给模型的图片") && !defaultPersonaPrompt.includes("[CQ:at"), "default system prompt should match current delivery and intent-driven image context behavior")
  const timedPersona = await buildPersonaMessagesWithContext({ isGroup: false, user_id: "time-user", sender: { nickname: "Time" } }, "现在几点", defaultConfig)
  const timeSection = timedPersona.sections.find(item => item.source === "runtime-time")
  assert(timeSection?.label === "当前时间" && /当前北京时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}（星期[一二三四五六日]）/.test(timeSection.content) && defaultPersonaMessages[0]?.content.includes("当前北京时间："), "every persona request should inject a separately auditable Beijing-time reference")
  const customRuntimeConfig = JSON.parse(JSON.stringify(config))
  customRuntimeConfig.persona.runtimePrompt = "Smoke 运行规则：使用[first_person]的当前自定义规则。"
  const personaMessages = await buildPersonaMessages(event, "请告诉我这个指令怎么用", customRuntimeConfig, { source: "firstPerson" })
  const personaPrompt = personaMessages[0]?.content || ""
  assert(personaPrompt.includes("Smoke 角色设定：你是埋埋"), "custom character setting should be injected with runtime variables")
  assert(personaPrompt.includes("Smoke 运行规则：使用埋埋") && !personaPrompt.includes("完成多个动作") && !personaPrompt.includes("<EMPTY>"), "custom runtime prompt should replace the default prompt in the actual persona chain")
  assert(!personaPrompt.includes("表达样例") && !personaPrompt.includes("本轮人格状态") && !personaPrompt.includes("已学习表达样例"), "persona chain should not inject retired expression or state sections")
  const original = JSON.parse(JSON.stringify(await configStore.load()))
  try {
    const next = JSON.parse(JSON.stringify(original))
    next.knowledge.commandPrefixes = ["#", "/", "*", "!"]
    next.persona.trigger.poke = {
      ...(next.persona.trigger.poke || {}),
      enabled: true,
      respondToBotPoke: true,
      responseMode: "fallback",
      probabilityPercent: 100,
      cooldownMs: 0,
      groupCooldownMs: 0,
      fallbackMessages: ["[first_person]fallback烟测"],
    }
    await configStore.save(next)
    const boundedContextConfig = JSON.parse(JSON.stringify(next))
    boundedContextConfig.context.recentMessageCount = 2
    boundedContextConfig.context.ignoreCommands = false
    await configStore.save(boundedContextConfig)
    recentContextStore.clear()
    const contextEvent = { isGroup: true, group_id: "context-smoke", user_id: "context-user", sender: { nickname: "Context User" } }
    assert(recentContextStore.record({ ...contextEvent, msg: "第一条上下文" }), "recent context should record messages while the unified count is positive")
    assert(recentContextStore.record({ ...contextEvent, msg: "第二条上下文" }), "recent context should keep recording within the unified count")
    assert(recentContextStore.record({ ...contextEvent, msg: "第三条上下文" }), "recent context should accept messages after reaching the unified count")
    const boundedContextPrompt = recentContextStore.buildPrompt(contextEvent)
    assert(recentContextStore.stats().messages === 2, "recent message count should cap the retained message window")
    assert(!boundedContextPrompt.includes("第一条上下文") && boundedContextPrompt.includes("第二条上下文") && boundedContextPrompt.includes("第三条上下文"), "the same recent message count should cap the messages injected into the prompt")
    const imageSelectionConfig = JSON.parse(JSON.stringify(boundedContextConfig))
    imageSelectionConfig.context.recentMessageCount = 4
    await configStore.save(imageSelectionConfig)
    recentContextStore.clear()
    const longContextText = "这是一条较长的群聊正文，用来确认最近上下文不会因为单条字符上限而丢失内容。".repeat(12)
    assert(recentContextStore.record({ ...contextEvent, message_id: "long-context", msg: longContextText }), "recent context should retain a long message without a per-message character cap")
    assert(recentContextStore.buildPrompt(contextEvent).includes(longContextText), "recent context prompt should keep the complete long message")
    recentContextStore.clear()
    const selfImageUrl = "https://multimedia.nt.qq.com.cn/download?fileid=recent-self"
    const otherImageUrl = "https://multimedia.nt.qq.com.cn/download?fileid=recent-other"
    assert(recentContextStore.record({ ...contextEvent, message_id: "self-image", msg: "", message: [{ type: "image", data: { url: selfImageUrl } }] }), "recent context should retain image-only messages as volatile references for intentional lookback")
    assert(recentContextStore.record({ ...contextEvent, message_id: "other-image", user_id: "other-user", sender: { card: "玉玉小呆毛", nickname: "Other User" }, msg: "他人后发图", message: [{ type: "image", data: { url: otherImageUrl } }] }), "recent context should retain other group members' image references and aliases")
    const preferredSelfImage = recentContextStore.findRecentImage(contextEvent, { prompt: "再看看我刚发的那个" })
    assert(preferredSelfImage?.url === selfImageUrl && preferredSelfImage.source === "recent-self", "first-person image references should select the current speaker's latest image")
    const namedOtherImage = recentContextStore.findRecentImage(contextEvent, { prompt: "玉玉小呆毛刚才发的是什么" })
    assert(namedOtherImage?.url === otherImageUrl && namedOtherImage.userId === "other-user", "named-member image references should override the current speaker's older image")
    const latestUnqualifiedImage = recentContextStore.findRecentImage(contextEvent, { prompt: "上一张是什么" })
    assert(latestUnqualifiedImage?.url === otherImageUrl, "unqualified recent-image references should follow chronology instead of always preferring the current speaker")
    assert(recentContextStore.record({ ...contextEvent, message_id: "named-no-image", user_id: "text-only-user", sender: { card: "纯文字成员" }, msg: "我只发文字" }), "recent context should retain named text-only participants")
    assert(recentContextStore.findRecentImage(contextEvent, { prompt: "纯文字成员刚才发的是什么" }) === null, "a named participant without an image must not fall back to an unrelated speaker's image")
    recentContextStore.clear()
    assert(recentContextStore.record({ ...contextEvent, message_id: "fallback-image", user_id: "other-user", sender: { nickname: "Other User" }, msg: "他人发图", message: [{ type: "image", data: { url: otherImageUrl } }] }), "recent context should record a fallback group image")
    const fallbackGroupImage = recentContextStore.findRecentImage(contextEvent)
    assert(fallbackGroupImage?.url === otherImageUrl && fallbackGroupImage.source === "recent-group", "recent image lookup should fall back to another group member only when the current speaker has no image")
    recentContextStore.clear()
    const passiveQuotedImageUrl = "https://multimedia.nt.qq.com.cn/download?fileid=passive-quoted"
    const passiveQuotedText = "这是一段超过四十八字的被引用正文，用来验证群聊上下文会保留完整的直接上级内容，而不是过早截断。".repeat(2)
    const passiveQuotedEvent = {
      ...contextEvent,
      message_id: "passive-reply",
      user_id: "other-user",
      sender: { user_id: "other-user", card: "引用者", nickname: "引用者" },
      msg: "这个怎么样",
      // 模拟部分宿主把引用图片同时展开到当前消息；它不应被记录成引用者自己发的图。
      message: [
        { type: "reply", data: { id: "passive-source" } },
        { type: "image", data: { url: passiveQuotedImageUrl } },
      ],
      reply: {
        message_id: "passive-source",
        sender: { user_id: "source-user", nickname: "原作者" },
        text: passiveQuotedText,
        message: [{ type: "image", data: { url: passiveQuotedImageUrl } }],
      },
    }
    assert(recentContextStore.record(passiveQuotedEvent), "recent context should retain a passive group's reply relation")
    const passiveReplyPrompt = recentContextStore.buildPrompt(contextEvent)
    assert(passiveReplyPrompt.includes("引用者(other-user)：这个怎么样"), "recent context should keep the replying speaker")
    assert(passiveReplyPrompt.includes("↳ 回复原作者的消息，含1张图"), "recent context should expose a compact quoted-message relation")
    assert(passiveReplyPrompt.includes(passiveQuotedText), "reply relation should keep the complete quoted text without a per-message character cap")
    assert(!passiveReplyPrompt.includes(passiveQuotedImageUrl) && !passiveReplyPrompt.includes("[1图]"), "passive quoted media should not leak URLs or be misclassified as the replier's own image")
    assert(recentContextStore.record({
      ...contextEvent,
      message_id: "passive-reply-only",
      user_id: "reply-only-user",
      sender: { user_id: "reply-only-user", card: "纯引用者" },
      msg: "",
      raw_message: "",
      message: [{ type: "reply", data: { id: "passive-source" } }],
    }), "recent context should retain a reply-only message for group relation continuity")
    assert(recentContextStore.buildPrompt(contextEvent).includes("纯引用者(reply-only-user)：非文本消息 ↳ 回复上一条消息"), "reply-only context should remain compact and relation-aware")
    recentContextStore.clear()
    const adjacentImageEvent = { ...contextEvent, message_id: "adjacent-image", msg: "", message: [{ type: "image", data: { url: selfImageUrl } }] }
    const adjacentQuestionEvent = { ...contextEvent, message_id: "adjacent-question", msg: "玉玉看看这个图" }
    assert(recentContextStore.record(adjacentImageEvent) && recentContextStore.record(adjacentQuestionEvent), "recent context should retain message order for an adjacent visual follow-up")
    const adjacentImage = recentContextStore.findRecentImage(adjacentQuestionEvent, { maxRowsBack: 1 })
    assert(adjacentImage?.messageId === "adjacent-image", "adjacent visual references should bind to the immediately preceding image after excluding the current message id")
    assert(recentContextStore.record(adjacentQuestionEvent) && recentContextStore.stats().messages === 2, "recording the same message id twice should replace rather than duplicate the context row")
    recentContextStore.clear()
    assert(recentContextStore.record(adjacentImageEvent), "contextual image selection should retain the candidate image")
    assert(recentContextStore.record({ ...contextEvent, message_id: "intervening-text", msg: "中间插入一条无关消息" }), "contextual image selection should retain intervening messages")
    assert(recentContextStore.record(adjacentQuestionEvent), "contextual image selection should retain the later question")
    assert(recentContextStore.findRecentImage(adjacentQuestionEvent, { maxRowsBack: 1 }) === null, "an elliptical visual reference should not jump across an intervening non-image message")
    recentContextStore.clear()
    const disabledContextConfig = JSON.parse(JSON.stringify(boundedContextConfig))
    disabledContextConfig.context.recentMessageCount = 0
    await configStore.save(disabledContextConfig)
    await configStore.save(boundedContextConfig)
    assert(recentContextStore.buildPrompt(contextEvent) === "", "saving zero recent messages should clear retained context before it is re-enabled")
    await configStore.save(disabledContextConfig)
    assert(recentContextStore.record({ ...contextEvent, msg: "关闭后消息" }) === false, "zero recent messages should disable context capture")
    await configStore.save(next)
    const commandEvent = {
      isGroup: true,
      group_id: "20001",
      user_id: "10001",
      msg: "!别的插件命令 埋埋",
      sender: { user_id: "10001", nickname: "User" },
      reply: async () => { throw new Error("first-person should not reply to configured command prefixes") },
    }
    const handled = await handleFirstPersonMessage(commandEvent)
    assert(handled === false, "first-person should ignore configured command prefixes")
    const originalSend = chatService.send
    const directFailureReplies = []
    try {
      const directConfig = JSON.parse(JSON.stringify(next))
      directConfig.persona.firstPerson = "埋埋"
      directConfig.persona.aliases = []
      directConfig.persona.respondToFirstPersonCall = true
      directConfig.persona.trigger.alwaysRespondToName = true
      directConfig.persona.trigger.disabledGroupIds = []
      directConfig.response.replyConfirmType = 0
      await configStore.save(directConfig)
      chatService.send = async () => { throw new Error("HTTP 504 Gateway time-out") }
      const failureHandled = await handleFirstPersonMessage({
        isGroup: true,
        isMaster: true,
        group_id: "20002",
        user_id: "10002",
        msg: "埋埋在吗",
        sender: { user_id: "10002", nickname: "User" },
        reply: async message => { directFailureReplies.push(String(message)); return true },
      })
      assert(failureHandled === true, "direct first-person model failure should still produce a user-facing response")
      assert(directFailureReplies.some(message => message.includes("网关超时")), "direct first-person model failure should explain the temporary gateway timeout")

      clearConversationContinuationState()
      const continuationSources = []
      chatService.send = async (_event, _message, options = {}) => {
        continuationSources.push(String(options.source || ""))
        return { text: continuationSources.length === 1 ? "我还没看到图片，请直接发图给我。" : "这次看到图片了。", channel: "mock" }
      }
      const continuationReplies = []
      const continuationBase = {
        isGroup: true,
        isMaster: true,
        group_id: "20003",
        user_id: "10003",
        sender: { user_id: "10003", nickname: "User" },
        reply: async message => { continuationReplies.push(message); return true },
      }
      assert(await handleFirstPersonMessage({ ...continuationBase, msg: "埋埋帮我识图" }) === true, "a direct model reply should arm the short continuation window after delivery")
      const continuationImage = {
        ...continuationBase,
        msg: "[CQ:image,file=continuation-service-smoke]",
        raw_message: "[CQ:image,file=continuation-service-smoke]",
        message: [{ type: "image", data: { url: "https://multimedia.nt.qq.com.cn/download?fileid=continuation-service-smoke" } }],
      }
      assert(await handleFirstPersonMessage(continuationImage) === true && continuationSources.at(-1) === "firstPersonContinuation", "a requested media-only follow-up should enter the multimodal conversation through the continuation source")
      assert(await handleFirstPersonMessage({ ...continuationImage, __yuiChatReplied: false }) === false, "an automatic continuation response must not re-arm another short continuation")
      assert(continuationReplies.length === 2, "the one-shot continuation should send exactly one additional reply")
    } finally {
      chatService.send = originalSend
      await configStore.save(next)
    }
    recentContextStore.clear()
    assert(recentContextStore.record(commandEvent) === false, "recent context should ignore configured command prefixes")
    const replies = []
    const fallbackHandled = await handleFirstPersonPokeEvent({
      isGroup: true,
      group_id: "20001",
      operator_id: "10001",
      target_id: "99999",
      self_id: "99999",
      notice_type: "group",
      sub_type: "poke",
      sender: { user_id: "10001", nickname: "User" },
      reply: async message => replies.push(String(message)),
    })
    assert(fallbackHandled === true, "poke fallback mode should handle direct bot poke")
    assert(replies.some(message => message.includes("fallback烟测")), "poke fallback mode should send configured fallback text")
  } finally {
    await configStore.save(original)
    recentContextStore.clear()
  }
  clearPersonaTriggerState()
}

async function checkConversations() {
  const { chatService } = await import("../output/runtime/core/chat/chat-service.js")
  const { buildInitiativeGreetingStatus, generateInitiativeGreeting, initiativeGreetingScheduler, sendInitiativeGreeting } = await import("../output/runtime/core/persona/initiative-greeting.js")
  const { applyRuntimeConfig } = await import("../output/runtime/core/runtime/lifecycle.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  const { modelLogStore } = await import("../output/runtime/core/observability/model-log.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { responsesStateKey } = await import("../output/runtime/models/configuration/responses-state.js")
  const { normalizeTool } = await import("../output/runtime/tools/support/contract.js")
  const { createExecutionRuntime } = await import("../output/runtime/tools/support/execution-runtime.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { backgroundTaskService } = await import("../output/runtime/core/scheduling/background-task-service.js")
  const { GroupPokeTool } = await import("../output/runtime/tools/builtins/group-admin.js")
  const { recentContextStore } = await import("../output/runtime/core/chat/recent-context.js")
  const original = JSON.parse(JSON.stringify(await configStore.load()))
  await chatService.clearAll()
  try {
    chatService.conversations.set("mock:g:20001:10001", {
      history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
      lastSeen: Date.now(),
    })
    chatService.conversations.set("qwen:g:20001:10001", {
      history: [{ role: "user", content: "hi2" }, { role: "assistant", content: "hello2" }],
      lastSeen: Date.now(),
    })
    chatService.conversations.set("mock:g:20001:10002", {
      history: [{ role: "user", content: "other" }],
      lastSeen: Date.now(),
    })
    assert(chatService.listConversations().length === 3, "conversation list should include active sessions")
    const cleared = await chatService.clear({ isGroup: true, group_id: "20001", user_id: "10001" })
    assert(cleared === 2, "clear current scope should remove all channel conversations")
    assert(chatService.listConversations().length === 1, "other user conversation should remain")
    assert(await chatService.clearByKeys(["mock:g:20001:10002"]) === 1, "clearByKeys should remove selected conversation")
    assert(chatService.listConversations().length === 0, "conversation list should be empty after cleanup")

    const mockConfig = JSON.parse(JSON.stringify(original))
    mockConfig.apiProviders = [{ name: "mock", type: "mock", authType: "none", baseURL: "", apiKey: "" }]
    mockConfig.models = [{ name: "mock", modelIdentifier: "mock", apiProvider: "mock", adapter: "mock", visual: true, toolUse: true, params: {} }]
    mockConfig.channels = [{ id: "mock", name: "Mock Assistant", type: "mock", enabled: true, model: "mock" }]
    mockConfig.chat.defaultChannel = "mock"
    mockConfig.chat.defaultTask = "replyer"
    delete mockConfig.chat.defaultWorkflow
    for (const task of Object.values(mockConfig.modelTasks || {})) {
      if (task && typeof task === "object") task.modelList = ["mock"]
    }
    mockConfig.modelTasks.replyer = { modelList: ["mock"], selectionStrategy: "sequential", maxTokens: 128, temperature: 0.1 }
    delete mockConfig.workflows
    mockConfig.mediaRecognition.enabled = true
    mockConfig.mediaRecognition.recognitionModel = "mock"
    mockConfig.mediaRecognition.remoteFetch.enabled = true
    await configStore.save(mockConfig)
    const { checkQuotedContext } = await import("./check-quoted-context.mjs")
    await checkQuotedContext(tinyPngDataUrl)
    recentContextStore.clear()
    const recentImageEvent = {
      isGroup: true,
      group_id: "20001",
      user_id: "10001",
      msg: "刚发了一张图片",
      raw_message: "刚发了一张图片",
      message: [{ type: "image", url: tinyPngDataUrl }],
      sender: { user_id: "10001", nickname: "Smoke User" },
    }
    assert(recentContextStore.record(recentImageEvent), "conversation smoke should seed a recent image for intentional lookback")
    const recentImageResult = await chatService.send({
      isGroup: true,
      group_id: "20001",
      user_id: "10001",
      msg: "再看看我刚发的那个图片内容",
      raw_message: "再看看我刚发的那个图片内容",
      sender: { user_id: "10001", nickname: "Smoke User" },
    }, "再看看我刚发的那个图片内容")
    assert(recentImageResult.media?.images === 1, "explicit recent-image intent should attach the current speaker's latest image to the model request")
    assert(recentContextStore.record({
      ...recentImageEvent,
      message_id: "conversation-named-other-image",
      user_id: "10002",
      sender: { user_id: "10002", card: "玉玉小呆毛", nickname: "Other Smoke User" },
    }), "conversation smoke should seed a named group member's image")
    const namedRecentImageResult = await chatService.send({
      isGroup: true,
      group_id: "20001",
      user_id: "10001",
      msg: "玉玉小呆毛刚才发的是什么",
      raw_message: "玉玉小呆毛刚才发的是什么",
      sender: { user_id: "10001", nickname: "Smoke User" },
    }, "玉玉小呆毛刚才发的是什么")
    assert(namedRecentImageResult.media?.images === 1 && namedRecentImageResult.media?.thumbnails?.[0]?.source === "recent-group", "named-member visual intent should attach that member's image instead of the current speaker's older image")
    const ordinaryResult = await chatService.send({
      isGroup: true,
      group_id: "20001",
      user_id: "10001",
      msg: "今天心情怎么样",
      raw_message: "今天心情怎么样",
      sender: { user_id: "10001", nickname: "Smoke User" },
    }, "今天心情怎么样")
    assert(!ordinaryResult.media?.images, "ordinary conversation must not recall or download recent images")
    recentContextStore.clear()
    const adjacentImageEvent = { ...recentImageEvent, message_id: "conversation-adjacent-image", msg: "", raw_message: "" }
    const adjacentQuestionEvent = {
      isGroup: true,
      group_id: "20001",
      user_id: "10001",
      message_id: "conversation-adjacent-question",
      msg: "看看这个图",
      raw_message: "看看这个图",
      sender: { user_id: "10001", nickname: "Smoke User" },
    }
    assert(recentContextStore.record(adjacentImageEvent) && recentContextStore.record(adjacentQuestionEvent), "conversation smoke should retain an adjacent image and question with message ids")
    const adjacentImageResult = await chatService.send(adjacentQuestionEvent, "看看这个图")
    assert(adjacentImageResult.media?.images === 1, "contextual 'look at this image' should bind to the immediately preceding image")
    recentContextStore.clear()
    assert(recentContextStore.record(adjacentImageEvent), "conversation smoke should seed an image before an intervening message")
    assert(recentContextStore.record({ ...adjacentQuestionEvent, message_id: "conversation-intervening", msg: "无关插话", raw_message: "无关插话" }), "conversation smoke should retain an intervening message")
    assert(recentContextStore.record(adjacentQuestionEvent), "conversation smoke should retain the contextual question after intervening text")
    const separatedImageResult = await chatService.send(adjacentQuestionEvent, "看看这个图")
    assert(!separatedImageResult.media?.images, "contextual 'look at this image' should not bind across an intervening non-image message")
    const mediaResult = await chatService.send({
      isGroup: true,
      group_id: "20001",
      user_id: "10001",
      msg: "看这张图",
      raw_message: "看这张图",
      message: [{ type: "image", url: tinyPngDataUrl }],
      sender: { user_id: "10001", nickname: "Smoke User" },
    }, "看这张图")
    assert(mediaResult.media?.images === 1, "chat service should summarize image attachment count")
    assert(mediaResult.media?.thumbnails?.[0]?.dataUrl?.startsWith("data:image/"), "chat service should preserve prepared image thumbnail for rich cards")
    assert(mediaResult.usage && Array.isArray(mediaResult.toolChain), "chat result should expose token usage and tool chain")
    const trackedConversation = chatService.listConversations().find(item => item.userId === "10001")
    assert(trackedConversation?.usage && trackedConversation?.lastTurn, "conversation list should expose accumulated usage and latest turn metadata")
    const toolTraceResult = await chatService.send({
      isGroup: true,
      group_id: "20001",
      user_id: "10001",
      msg: "怎么使用帮助指令",
      raw_message: "怎么使用帮助指令",
      sender: { user_id: "10001", nickname: "Smoke User" },
    }, "怎么使用帮助指令")
    assert(toolTraceResult.toolChain.some(item => item.name === "knowledge_manage" && item.status === "ok"), "chat result should record the knowledge tool chain")

    let hostedRuntime
    let hostedMessages
    let hostedReplayMessages
    let hostedRequestCount = 0
    const hostedAdapter = {
      id: "smoke-hosted-responses",
      protocol: "responses",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      supportsNativeToolSearch: true,
      async sendMessage({ channel, messages = [], replayMessages = [] }) {
        hostedRequestCount++
        hostedRuntime = channel.responsesRuntime
        hostedMessages = messages
        hostedReplayMessages = replayMessages
        return {
          id: "resp_hosted_next",
          upstreamResponseId: "resp_hosted_next",
          text: "远程检索完成。",
          stopReason: "end_turn",
          usage: { input: 1, output: 1, total: 2, source: "reported" },
          toolCalls: [],
          hostedToolCalls: [{
            id: "ws_hosted_smoke",
            type: "web_search_call",
            status: "completed",
            query: "今日黄金价格",
            resultCount: 1,
            sources: [{ title: "黄金交易所", url: "https://example.com/gold" }],
            raw: { type: "web_search_call", id: "ws_hosted_smoke", status: "completed", action: { query: "今日黄金价格", sources: [{ title: "黄金交易所", url: "https://example.com/gold" }] } },
          }],
          hostedSearchSources: [{ title: "黄金交易所", url: "https://example.com/gold" }],
        }
      },
    }
    const hostedChannel = {
      id: hostedAdapter.id,
      type: hostedAdapter.id,
      model: "gpt-smoke",
      provider: { name: "proxy-smoke" },
      modelConfig: {
        apiProvider: "proxy-smoke",
        toolUse: true,
        toolPolicy: { routes: { web_search: { source: "auto", strategy: "fallback" } } },
        responses: { stateMode: "auto", webSearch: { params: {} } },
      },
      timeoutMs: 1000,
    }
    const hostedStateKey = responsesStateKey(hostedChannel)
    adapterRegistry.register(hostedAdapter)
    try {
      const hostedToolsBefore = new Set(modelLogStore.memoryTools.keys())
      const hostedOnlyConfig = JSON.parse(JSON.stringify(mockConfig))
      hostedOnlyConfig.tools.builtin.webSearch.enabledSources = []
      const hostedResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" } },
        prompt: "查今日黄金价格",
        config: hostedOnlyConfig,
        history: [{ role: "user", content: "旧问题" }, { role: "assistant", content: "旧回答" }],
        protocolState: { responses: { [hostedStateKey]: { previousResponseId: "resp_hosted_previous" } } },
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: hostedChannel,
      })
      assert(hostedRuntime?.previousResponseId === "resp_hosted_previous" && hostedRuntime?.stateMode === "auto", "automatic Responses mode should pass the persisted upstream state to the protocol adapter")
      assert(hostedRequestCount === 1 && hostedResult.text === "远程检索完成。", "OpenAI-only search should use the final assistant message from one native Responses request without an aggregate pass")
      assert(!hostedMessages.some(item => item.role === "user" && item.content === "旧问题"), "linked Responses model steps should omit replayed local history")
      assert(hostedReplayMessages.some(item => item.role === "user" && item.content === "旧问题"), "automatic Responses mode should retain a bounded local recovery checkpoint without sending it on the normal linked request")
      assert(hostedResult.toolChain.some(item => item.name === "openai:web_search" && item.source === "openai-hosted" && item.metadata?.remote === true), "OpenAI hosted calls should appear in the same local tool chain and be marked as remote")
      assert(hostedResult.toolsUsed.includes("openai:web_search") && hostedResult.hostedSearchSources?.[0]?.url === "https://example.com/gold", "hosted tools and sources should remain observable on the model result")
      assert(hostedResult.responseState?.previousResponseId === "resp_hosted_next" && hostedResult.responseState?.key === hostedStateKey && hostedResult.responseState?.mode === "auto", "automatic Responses mode should persist the next upstream response id")
      const loggedHostedTool = [...modelLogStore.memoryTools.values()].find(item => !hostedToolsBefore.has(item.id) && item.tool_name === "openai:web_search")
      assert(loggedHostedTool?.source === "openai-hosted" && JSON.parse(loggedHostedTool?.metadata_json || "{}").remote === true, "hosted calls should be persisted as remote tool events in the unified audit log")
      assert(loggedHostedTool?.result_text?.includes("ws_hosted_smoke") && loggedHostedTool.result_text.includes("今日黄金价格"), "hosted tool events should persist the actual upstream output item instead of an empty summary")
    } finally {
      adapterRegistry.adapters.delete(hostedAdapter.id)
    }

    const originalHostedMessageSend = toolRegistry.tools.get("message_send")
    const hostedMessageDeliveries = []
    const hostedMessageRequests = []
    let hostedMessageRuntime
    const hostedMessageSend = normalizeTool({
      ...originalHostedMessageSend,
      name: "message_send",
      common: { ...originalHostedMessageSend.common, delivery: "media", requiresFinalReply: false },
      async execute(args = {}) {
        hostedMessageDeliveries.push(args)
        return {
          kind: "delivery",
          chain: args.parts,
          isError: false,
          issues: [],
          receipt: { id: "smoke-hosted-message-delivery", status: "sent", partCount: args.parts?.length || 0, sentCount: args.parts?.length || 0, failedCount: 0 },
        }
      },
    })
    const hostedMessageAdapter = {
      id: "smoke-hosted-message-continuation",
      protocol: "responses",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      supportsNativeToolSearch: true,
      async sendMessage({ channel, messages = [] }) {
        hostedMessageRuntime = channel.responsesRuntime
        hostedMessageRequests.push(messages)
        if (hostedMessageRequests.length > 1) {
          return { id: "resp_hosted_message_final", text: "已经把两张图片发给你，并完成了结果说明。", stopReason: "end_turn", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        }
        return {
          id: "resp_hosted_message_tool",
          text: "",
          stopReason: "tool_calls",
          usage: { input: 1, output: 1, total: 2, source: "reported" },
          toolCalls: [{ id: "hosted-message-send", name: "message_send", arguments: { parts: [{ type: "text", text: "图片已发送" }] } }],
          hostedToolCalls: [{
            id: "hosted-message-web-search",
            type: "web_search_call",
            status: "completed",
            query: "柴郡猫表情包",
            raw: { type: "web_search_call", id: "hosted-message-web-search", status: "completed", action: { query: "柴郡猫表情包" } },
          }],
        }
      },
    }
    const hostedMessageConfig = JSON.parse(JSON.stringify(mockConfig))
    hostedMessageConfig.tools.enabledTools = ["message_send"]
    hostedMessageConfig.tools.promptSelection.enabled = false
    hostedMessageConfig.chat.maxToolRounds = 2
    toolRegistry.tools.set("message_send", hostedMessageSend)
    adapterRegistry.register(hostedMessageAdapter)
    try {
      const hostedMessageResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "查找资料并发给我",
        config: hostedMessageConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: {
          id: hostedMessageAdapter.id,
          type: hostedMessageAdapter.id,
          model: "smoke",
          modelConfig: { toolUse: true, toolPolicy: { routes: { web_search: { source: "hosted" }, tool_search: { source: "disabled" } } } },
          timeoutMs: 1000,
        },
      })
      assert(hostedMessageDeliveries.length === 1, "a local function call emitted beside a hosted Responses call should still execute once")
      assert(hostedMessageRuntime?.webSearchAllowed === false, "disabling the web_search capability should override the hosted implementation switch")
      assert(hostedMessageRequests.length === 2 && hostedMessageRequests[1].some(item => item.role === "tool"), "hosted plus local Responses calls should feed the local tool result back to the model")
      assert(hostedMessageResult.text.includes("完成了结果说明") && hostedMessageResult.requiresFinalReply === true, "hosted plus message_send Responses output must not be mistaken for a silent single-delivery turn")
    } finally {
      toolRegistry.tools.set("message_send", originalHostedMessageSend)
      adapterRegistry.adapters.delete(hostedMessageAdapter.id)
    }

    const originalDiscoveryTool = toolRegistry.tools.get("tool_search")
    const forcedDiscoveryTool = normalizeTool({
      name: "tool_search",
      source: "builtin",
      category: "discovery",
      description: "Load a deliberately invalid smoke candidate.",
      execution: { effect: "read" },
      async execute() {
        return { status: "success", content: "forced", metadata: { discovery: true, loadTools: ["image_media"] } }
      },
    })
    const disabledToolSnapshots = []
    const disabledToolAdapter = {
      id: "smoke-disabled-tool-search-guard",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ tools = [] }) {
        disabledToolSnapshots.push(tools.map(tool => tool.name))
        if (disabledToolSnapshots.length === 1) return { id: "disabled-search-call", text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: "disabled-search-tool", name: "tool_search", arguments: { query: "图片" } }] }
        return { id: "disabled-search-final", text: "未加载停用工具。", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
      },
    }
    const disabledToolConfig = JSON.parse(JSON.stringify(mockConfig))
    disabledToolConfig.tools.enabledTools = ["tool_search"]
    disabledToolConfig.tools.promptSelection.enabled = false
    disabledToolConfig.chat.maxToolRounds = 2
    toolRegistry.tools.set("tool_search", forcedDiscoveryTool)
    adapterRegistry.register(disabledToolAdapter)
    try {
      await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" } },
        prompt: "尝试查找图片工具",
        config: disabledToolConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: disabledToolAdapter.id, type: disabledToolAdapter.id, model: "smoke", modelConfig: { toolUse: true, toolPolicy: { routes: { tool_search: { source: "local" } } } }, timeoutMs: 1000 },
      })
      assert(disabledToolSnapshots.length === 2 && disabledToolSnapshots.every(names => !names.includes("image_media")), "tool_search should never reload a tool excluded by the global enabled set")
    } finally {
      if (originalDiscoveryTool) toolRegistry.tools.set("tool_search", originalDiscoveryTool)
      else toolRegistry.tools.delete("tool_search")
      adapterRegistry.adapters.delete(disabledToolAdapter.id)
    }

    const finalizerToolName = "smoke_required_tool"
    const finalizerTool = normalizeTool({
      name: finalizerToolName,
      source: "builtin",
      category: "network",
      description: "Return a smoke tool result.",
      async execute() { return "smoke tool result" },
    })
    const finalizerAdapter = {
      id: "smoke-finalizer",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ tools = [] }) {
        if (!tools.length) return { id: "smoke-final", text: "已根据工具结果完成收束。", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        return { id: `smoke-tool-${Date.now()}`, text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: `smoke-call-${Date.now()}`, name: finalizerToolName, arguments: {} }] }
      },
    }
    const finalizerConfig = JSON.parse(JSON.stringify(mockConfig))
    finalizerConfig.tools.enabledTools = [...new Set([...(finalizerConfig.tools.enabledTools || []), finalizerToolName])]
    finalizerConfig.chat.maxToolRounds = 1
    toolRegistry.tools.set(finalizerToolName, finalizerTool)
    adapterRegistry.register(finalizerAdapter)
    try {
      const toolEventsBeforeFinalizer = new Set(modelLogStore.memoryTools.keys())
      const finalizerResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" } },
        prompt: "请调用工具后给我一个结论",
        config: finalizerConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: "smoke-finalizer", type: "smoke-finalizer", model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(finalizerResult.text === "已根据工具结果完成收束。", "tool round limit should trigger a no-tool finalization pass")
      assert(finalizerResult.toolLimitReached === true, "tool round limit should be observable on the model step")
      assert(finalizerResult.toolChain.length === 1 && finalizerResult.toolChain[0].requiresFinalReply === true, "required tool reply policy should be recorded in the tool chain")
      const loggedFinalizerTool = [...modelLogStore.memoryTools.values()].find(item => !toolEventsBeforeFinalizer.has(item.id) && item.tool_name === finalizerToolName)
      assert(loggedFinalizerTool?.run_id && loggedFinalizerTool.model_call_id && loggedFinalizerTool.result_text === "smoke tool result", "direct model steps should persist a linked tool event")
    } finally {
      toolRegistry.tools.delete(finalizerToolName)
      adapterRegistry.adapters.delete(finalizerAdapter.id)
    }

    const mediaCorrectionCalls = []
    const originalCorrectionSendTool = toolRegistry.tools.get("message_send")
    const mediaCorrectionTool = normalizeTool({
      ...originalCorrectionSendTool,
      common: { ...originalCorrectionSendTool.common, delivery: "media", requiresFinalReply: true },
      async execute(args = {}) {
        mediaCorrectionCalls.push(args)
        return "已发送候选媒体。"
      },
    })
    const mediaCorrectionAdapter = {
      id: "smoke-media-correction",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ tools = [], messages = [] }) {
        const correction = messages.some(item => String(item.content || "").includes("媒体发送纠正"))
        if (correction && tools.some(tool => tool.name === "message_send")) {
          return { id: "smoke-media-correction-tool", text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: "smoke-media-send-call", name: "message_send", arguments: { parts: [{ type: "image", source: { kind: "url", value: "https://example.com/selected-image.png", mimeType: "image/png" } }] } }] }
        }
        if (!tools.length) return { id: "smoke-media-correction-final", text: "已发送图片。", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        return { id: "smoke-media-correction-raw", text: "搜到啦：[CQ:image,file=https://example.com/selected-image.png]", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
      },
    }
    const mediaCorrectionConfig = JSON.parse(JSON.stringify(mockConfig))
    mediaCorrectionConfig.tools.enabledTools = [...new Set([...(mediaCorrectionConfig.tools.enabledTools || []), "message_send"])]
    mediaCorrectionConfig.tools.promptSelection.enabled = false
    mediaCorrectionConfig.chat.maxToolRounds = 2
    toolRegistry.tools.set("message_send", mediaCorrectionTool)
    adapterRegistry.register(mediaCorrectionAdapter)
    try {
      const mediaCorrectionResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" } },
        prompt: "搜索一个开心的表情包并发给我",
        config: mediaCorrectionConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: "smoke-media-correction", type: "smoke-media-correction", model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(mediaCorrectionCalls.length === 1 && mediaCorrectionCalls[0].parts?.length === 1, "media correction should turn a direct image CQ response into a message_send call")
      assert(mediaCorrectionResult.text === "已发送图片。" && mediaCorrectionResult.mediaCorrectionStatus === "sent", "media correction should finish with the model's actual delivery result")
      assert(mediaCorrectionResult.mediaCorrectionAttempted === true && mediaCorrectionResult.mediaDirectOutputDetected === true, "media correction metadata should expose the direct media output")
      assert(mediaCorrectionResult.toolChain.some(item => item.name === "message_send" && item.delivery === "media"), "the actual media delivery should be visible in the tool chain")
      assert(mediaCorrectionResult.modelCalls.length === 3, "media correction should use one correction call and one finalization call without looping")
    } finally {
      toolRegistry.tools.set("message_send", originalCorrectionSendTool)
      adapterRegistry.adapters.delete(mediaCorrectionAdapter.id)
    }

    const selectionCalls = []
    const selectionMcpName = "smoke_mcp_media_search"
    const selectionMediaUrl = "https://example.test/candidate.png"
    const selectionMcpTool = normalizeTool({
      name: selectionMcpName,
      source: "custom",
      category: "network",
      description: "Return MCP-like media results for selection smoke testing.",
      async execute() {
        return {
          content: [{ type: "text", text: JSON.stringify({ images: [{ id: "candidate-1", url: selectionMediaUrl, mimeType: "image/png" }] }) }],
        }
      },
    })
    const originalMessageSendTool = toolRegistry.tools.get("message_send")
    const selectionMessageSendTool = normalizeTool({
      ...originalMessageSendTool,
      name: "message_send",
      common: { ...originalMessageSendTool.common, delivery: "media", requiresFinalReply: false },
      async execute(args = {}) {
        const source = args.parts?.find(item => item?.type === "image")?.source || {}
        if (!source.value) return { kind: "error", chain: [{ type: "text", text: "media source missing" }], isError: true, issues: ["media source missing"], metadata: { validationError: true, retryable: true } }
        selectionCalls.push(args)
        return {
          kind: "delivery",
          chain: [{ type: "image", source }],
          isError: false,
          issues: [],
          receipt: { id: "smoke-media-delivery", status: "sent", partCount: 1, sentCount: 1, failedCount: 0 },
        }
      },
    })
    let selectionMediaResponses = 0
    let selectionForcedMessageSend = false
    const selectionAdapter = {
      id: "smoke-media-selection",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ messages = [], tools = [], toolChoice }) {
        if (!tools.length) return { id: "smoke-selection-final", text: "已选择并发送图片。", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        const searched = messages.some(item => item.name === selectionMcpName)
        const selected = messages.some(item => item.name === "message_send")
        if (!searched) return { id: "smoke-selection-search", text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: "smoke-selection-search-call", name: selectionMcpName, arguments: {} }] }
        if (!selected || selectionMediaResponses === 1) {
          selectionMediaResponses++
          selectionForcedMessageSend = tools.length === 1
            && tools[0]?.name === "message_send"
            && toolChoice?.type === "function"
            && toolChoice.name === "message_send"
          // 模型从原始工具结果里直接读出 url，不再依赖任何候选注册表。
          let url = ""
          try {
            const content = String(messages.find(item => item.name === selectionMcpName)?.content || "{}")
            const result = JSON.parse(content.split("\n工具执行状态：", 1)[0])
            url = String(JSON.parse(result.content[0].text).images[0].url || "")
          } catch {}
          return { id: "smoke-selection-media", text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: `smoke-selection-media-call-${selectionMediaResponses}`, name: "message_send", arguments: { parts: [{ type: "image", source: { kind: "url", value: url } }] } }] }
        }
        return { id: "smoke-selection-final", text: "已选择并发送图片。", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
      },
    }
    const selectionConfig = JSON.parse(JSON.stringify(mockConfig))
    selectionConfig.tools.enabledTools = [...new Set([...(selectionConfig.tools.enabledTools || []), selectionMcpName, "message_send"])]
    selectionConfig.tools.promptSelection.enabled = false
    selectionConfig.chat.maxToolRounds = 3
    toolRegistry.tools.set(selectionMcpName, selectionMcpTool)
    toolRegistry.tools.set("message_send", selectionMessageSendTool)
    adapterRegistry.register(selectionAdapter)
    try {
      const selectionResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "搜索一个开心的表情包并发给我",
        config: selectionConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: "smoke-media-selection", type: "smoke-media-selection", model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(selectionCalls.length === 1 && selectionCalls[0].parts?.[0]?.source?.value === selectionMediaUrl, "the model should copy a url straight out of the raw tool result into message_send")
      assert(selectionResult.toolChain.map(item => item.name).join(",") === `${selectionMcpName},message_send`, "media selection should execute search and delivery in separate model-led tool rounds")
      assert(selectionForcedMessageSend === true, "search results should force the next model action to message_send")
      assert(selectionMediaResponses === 1 && selectionResult.modelCalls.length === 2, "completed media delivery should stop duplicate media calls and avoid a redundant final model round")
      assert(selectionResult.searchDeliveryRequired === true && selectionResult.searchDeliveryStatus === "sent", "search delivery should be observable as a completed forced send")
      assert(selectionResult.mediaCorrectionAttempted === false && selectionResult.text === "", "successful model-side media selection should finish without a corrective retry or duplicate text")
    } finally {
      toolRegistry.tools.delete(selectionMcpName)
      toolRegistry.tools.set("message_send", originalMessageSendTool)
      adapterRegistry.adapters.delete(selectionAdapter.id)
    }

    const originalImageMediaTool = toolRegistry.tools.get("image_media")
    const originalImageMessageSend = toolRegistry.tools.get("message_send")
    const imageMediaCalls = []
    const imageDeliveries = []
    let imageModelCalls = 0
    let imageNoToolFinalizations = 0
    let imageInitialToolChoice
    let imageInitialResponsesRuntime
    const imageMediaTool = normalizeTool({
      name: "image_media",
      source: "builtin",
      category: "network",
      description: "Search and deliver images.",
      autoDelivery: { via: "message_send", batching: "merge", continueConversation: true },
      execution: { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe" },
      async execute(args = {}) {
        imageMediaCalls.push(args)
        return {
          status: "success",
          content: { query: "柴郡猫表情包", selected: [{ url: "https://example.com/one.jpg" }, { url: "https://example.com/two.jpg" }] },
          metadata: {
            messageSendPlan: {
              parts: [
                { type: "image", source: { kind: "url", value: "https://example.com/one.jpg" } },
                { type: "image", source: { kind: "url", value: "https://example.com/two.jpg" } },
              ],
            },
          },
        }
      },
    })
    const imageMessageSendTool = normalizeTool({
      ...originalImageMessageSend,
      name: "message_send",
      common: { ...originalImageMessageSend.common, delivery: "media", requiresFinalReply: false },
      async execute(args = {}) {
        imageDeliveries.push(args)
        return {
          kind: "delivery",
          chain: args.parts,
          isError: false,
          issues: [],
          receipt: { id: "smoke-image-delivery", status: "sent", partCount: args.parts.length, sentCount: args.parts.length, failedCount: 0 },
        }
      },
    })
    const imageMediaAdapter = {
      id: "smoke-image-media",
      protocol: "responses",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      supportsNativeToolSearch: true,
      async sendMessage({ channel, tools = [], messages = [], toolChoice }) {
        imageModelCalls++
        if (imageModelCalls === 1) {
          imageInitialToolChoice = toolChoice
          imageInitialResponsesRuntime = { ...channel.responsesRuntime }
        }
        if (!tools.length) {
          imageNoToolFinalizations++
          const instructed = messages.some(item => String(item.content || "").includes("媒体投递后续答"))
          return { id: "smoke-image-media-final", text: instructed ? "给你挑了两张，看看合不合胃口～" : "missing continuation instruction", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        }
        if (imageModelCalls > 1) return { id: "smoke-image-media-natural-final", text: "给你挑了两张，看看合不合胃口～", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        return { id: "smoke-image-media-call", text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: "smoke-image-media-tool-call", name: "image_media", arguments: { query: "柴郡猫表情包", count: 2 } }] }
      },
    }
    const imageMediaConfig = JSON.parse(JSON.stringify(mockConfig))
    imageMediaConfig.tools.enabledTools = [...new Set([...(imageMediaConfig.tools.enabledTools || []), "image_media", "message_send"])]
    imageMediaConfig.tools.promptSelection.enabled = false
    imageMediaConfig.chat.maxToolRounds = 1
    toolRegistry.tools.set("image_media", imageMediaTool)
    toolRegistry.tools.set("message_send", imageMessageSendTool)
    adapterRegistry.register(imageMediaAdapter)
    try {
      const imageMediaResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "搜两张柴郡猫表情包发给我",
        config: imageMediaConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: {
          id: imageMediaAdapter.id,
          type: imageMediaAdapter.id,
          model: "smoke",
          modelConfig: { toolUse: true, toolPolicy: { routes: { web_search: { source: "hosted" }, tool_search: { source: "hosted" } } } },
          timeoutMs: 1000,
        },
      })
      assert(imageInitialToolChoice?.name === "image_media" && imageInitialResponsesRuntime?.webSearchAllowed === false && imageInitialResponsesRuntime?.toolSearchAllowed === false, "explicit image search should force image_media and suppress overlapping hosted web/tool search for that request")
      assert(imageMediaCalls.length === 1 && imageMediaCalls[0].action === "send", "the runtime should merge direct-send intent into image_media when action is omitted")
      assert(imageDeliveries[0]?.parts?.length === 2 && imageDeliveries[0].parts.every(part => part.type === "image"), "image_media automatic delivery should contain image resources only")
      assert(imageMediaResult.toolChain.map(item => item.name).join(",") === "image_media,message_send" && imageMediaResult.toolRounds === 1, "image_media should search and deliver in one model-led round")
      assert(imageMediaResult.modelCalls.length === 2 && imageNoToolFinalizations === 0 && imageMediaResult.searchDeliveryStatus === "sent" && imageMediaResult.text === "给你挑了两张，看看合不合胃口～", "image_media should reuse the normal terminal model response without a separate finalization call")
    } finally {
      toolRegistry.tools.set("image_media", originalImageMediaTool)
      toolRegistry.tools.set("message_send", originalImageMessageSend)
      adapterRegistry.adapters.delete(imageMediaAdapter.id)
    }

    const originalBilibiliSearchTool = toolRegistry.tools.get("bilibili_media")
    const originalBilibiliMessageSend = toolRegistry.tools.get("message_send")
    const bilibiliCoverPath = "/private/tmp/bilibili_selected_cover.jpg"
    const bilibiliVideoPath = "/private/tmp/bilibili_selected_video.mp4"
    const bilibiliSearchCalls = []
    const bilibiliDeliveries = []
    let bilibiliModelCalls = 0
    let bilibiliNoToolFinalizations = 0
    const bilibiliSearchTool = normalizeTool({
      name: "bilibili_media",
      source: "builtin",
      category: "network",
      description: "Search Bilibili videos.",
      autoDelivery: { via: "message_send", batching: "merge", continueConversation: true },
      execution: { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe" },
      executionByAction: {
        send: { effect: "idempotent_write", repeatPolicy: "dedupe", operationFields: ["action", "keyword"], retryPolicy: "safe" },
      },
      async execute(args = {}) {
        bilibiliSearchCalls.push(args)
        return {
          status: "success",
          executedCount: 1,
          content: {
            id: "BV1Selected",
            title: "跳舞候选",
            coverSource: { kind: "cache", value: bilibiliCoverPath, mimeType: "image/jpeg" },
            source: { kind: "cache", value: bilibiliVideoPath, mimeType: "video/mp4" },
          },
          metadata: {
            messageSendPlan: {
              parts: [
                { type: "text", text: "跳舞候选" },
                { type: "image", source: { kind: "cache", value: bilibiliCoverPath, mimeType: "image/jpeg" } },
                { type: "video", source: { kind: "cache", value: bilibiliVideoPath, mimeType: "video/mp4" } },
              ],
            },
          },
        }
      },
    })
    const bilibiliMessageSendTool = normalizeTool({
      ...originalBilibiliMessageSend,
      name: "message_send",
      common: { ...originalBilibiliMessageSend.common, delivery: "media", requiresFinalReply: false },
      async execute(args = {}) {
        const incomplete = args.parts?.some(part => ["image", "video"].includes(part?.type) && !part?.source?.value)
        if (incomplete) return { kind: "error", chain: [{ type: "text", text: "source.value 缺失，请完整复制 bilibili_media 返回的 source。" }], isError: true, issues: ["source.value 缺失"], metadata: { validationError: true, retryable: true } }
        bilibiliDeliveries.push(args)
        return {
          kind: "delivery",
          chain: args.parts,
          isError: false,
          issues: [],
          receipt: { id: "smoke-bilibili-delivery", status: "sent", partCount: args.parts.length, sentCount: args.parts.length, failedCount: 0 },
        }
      },
    })
    const bilibiliAdapter = {
      id: "smoke-bilibili-preparation",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ tools = [] }) {
        bilibiliModelCalls++
        if (!tools.length) {
          bilibiliNoToolFinalizations++
          return { id: "smoke-bilibili-final", text: "这个舞挺有意思的，给你丢过来啦。", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        }
        if (bilibiliModelCalls > 1) return { id: "smoke-bilibili-natural-final", text: "这个舞挺有意思的，给你丢过来啦。", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        return { id: "smoke-bilibili-search", text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: "smoke-bilibili-search-call", name: "bilibili_media", arguments: { keyword: "跳舞", limit: 2 } }] }
      },
    }
    const bilibiliConfig = JSON.parse(JSON.stringify(mockConfig))
    bilibiliConfig.tools.enabledTools = [...new Set([...(bilibiliConfig.tools.enabledTools || []), "bilibili_media", "message_send"])]
    bilibiliConfig.tools.promptSelection.enabled = false
    bilibiliConfig.chat.maxToolRounds = 1
    toolRegistry.tools.set("bilibili_media", bilibiliSearchTool)
    toolRegistry.tools.set("message_send", bilibiliMessageSendTool)
    adapterRegistry.register(bilibiliAdapter)
    try {
      const bilibiliResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "找个 B 站跳舞视频发给我",
        config: bilibiliConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: bilibiliAdapter.id, type: bilibiliAdapter.id, model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(bilibiliSearchCalls.length === 1 && bilibiliSearchCalls[0].action === "send", "the runtime should merge direct-send intent into bilibili_media when action is omitted")
      assert(bilibiliDeliveries[0]?.parts?.[1]?.source?.value === bilibiliCoverPath && bilibiliDeliveries[0]?.parts?.[2]?.source?.value === bilibiliVideoPath, "Bilibili delivery should use the prepared local cover and video resources")
      assert(bilibiliResult.toolChain.map(item => item.name).join(",") === "bilibili_media,message_send" && bilibiliResult.toolRounds === 1, "Bilibili media should search and deliver in one model-led round")
      assert(bilibiliResult.modelCalls.length === 2 && bilibiliNoToolFinalizations === 0 && bilibiliResult.searchDeliveryStatus === "sent" && bilibiliResult.text === "这个舞挺有意思的，给你丢过来啦。", "Bilibili automatic delivery should reuse the normal terminal response without a separate finalization call")
    } finally {
      toolRegistry.tools.set("bilibili_media", originalBilibiliSearchTool)
      toolRegistry.tools.set("message_send", originalBilibiliMessageSend)
      adapterRegistry.adapters.delete(bilibiliAdapter.id)
    }

    const mixedContinueName = "smoke_auto_delivery_continue"
    const mixedSilentName = "smoke_auto_delivery_silent"
    const mixedPassiveName = "smoke_passive_action"
    const mixedOriginalMessageSend = toolRegistry.tools.get("message_send")
    const mixedDeliveries = []
    let mixedScenario = "automatic-plans"
    let mixedModelCall = 0
    let mixedTerminalText = "都给你找来啦，慢慢看～"
    let mixedNoToolFinalizations = 0
    let mixedContinuationInstructionSeen = false
    let mixedPassiveExecutions = 0
    const mixedTool = (name, continueConversation, url) => normalizeTool({
      name,
      source: "builtin",
      category: "network",
      description: "Return an automatic media delivery plan.",
      tags: ["search", "media"],
      autoDelivery: { via: "message_send", batching: "merge", continueConversation },
      execution: { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe", parallelSafe: true },
      async execute() {
        return {
          status: "success",
          content: { url },
          metadata: { messageSendPlan: { parts: [{ type: "image", source: { kind: "url", value: url } }] } },
        }
      },
    })
    const mixedMessageSendTool = normalizeTool({
      ...mixedOriginalMessageSend,
      name: "message_send",
      common: { ...mixedOriginalMessageSend.common, delivery: "media", requiresFinalReply: false },
      async execute(args = {}) {
        mixedDeliveries.push(args)
        return {
          kind: "delivery",
          chain: args.parts,
          isError: false,
          issues: [],
          receipt: { id: "smoke-mixed-delivery", status: "sent", partCount: args.parts.length, sentCount: args.parts.length, failedCount: 0 },
        }
      },
    })
    const mixedPassiveTool = normalizeTool({
      name: mixedPassiveName,
      source: "builtin",
      category: "entertainment",
      description: "Perform one immediate action and finish without a model reply.",
      requiresFinalReply: false,
      execution: { effect: "non_idempotent", repeatPolicy: "dedupe", retryPolicy: "no_ambiguous_retry" },
      async execute() {
        mixedPassiveExecutions++
        return { status: "success", content: "动作完成。", executedCount: 1, retryAllowed: false }
      },
    })
    const mixedAdapter = {
      id: "smoke-mixed-auto-delivery",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ messages = [], tools = [] }) {
        mixedModelCall++
        if (mixedModelCall > 1 && messages.some(item => String(item.content || "").includes("【工具循环继续】"))) {
          mixedContinuationInstructionSeen = true
        }
        if (mixedScenario === "max-tokens-tool") {
          return {
            id: "smoke-mixed-max-tokens",
            text: "准备执行工具",
            stopReason: "max_tokens",
            usage: { input: 1, output: 1, total: 2, source: "reported" },
            toolCalls: [{ id: "smoke-truncated-tool", name: mixedPassiveName, arguments: {} }],
          }
        }
        if (mixedScenario === "pause-turn") {
          return { id: "smoke-mixed-pause", text: "", stopReason: "pause_turn", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        }
        if (mixedScenario === "refusal") {
          return { id: "smoke-mixed-refusal", text: "", stopReason: "refusal", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        }
        if (mixedScenario === "missing-tool-call") {
          return { id: "smoke-mixed-missing-tool", text: "", stopReason: "tool_calls", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        }
        if (!tools.length) {
          mixedNoToolFinalizations++
          return { id: "smoke-mixed-final", text: "都给你找来啦，慢慢看～", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        }
        if (mixedScenario === "automatic-then-passive" && mixedModelCall === 2) {
          return {
            id: "smoke-mixed-follow-up-tool",
            text: "",
            usage: { input: 1, output: 1, total: 2, source: "reported" },
            toolCalls: [{ id: "smoke-mixed-passive-follow-up", name: mixedPassiveName, arguments: {} }],
          }
        }
        if (mixedModelCall > 1) {
          return { id: "smoke-mixed-natural-final", text: mixedTerminalText, usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        }
        return {
          id: "smoke-mixed-tools",
          text: "",
          usage: { input: 1, output: 1, total: 2, source: "reported" },
          toolCalls: mixedScenario === "automatic-and-passive"
            ? [
                { id: "smoke-mixed-continue-call", name: mixedContinueName, arguments: {} },
                { id: "smoke-mixed-passive-call", name: mixedPassiveName, arguments: {} },
              ]
            : mixedScenario === "automatic-then-passive"
              ? [{ id: "smoke-mixed-continue-call", name: mixedContinueName, arguments: {} }]
            : [
                { id: "smoke-mixed-continue-call", name: mixedContinueName, arguments: {} },
                { id: "smoke-mixed-silent-call", name: mixedSilentName, arguments: {} },
              ],
        }
      },
    }
    const mixedConfig = JSON.parse(JSON.stringify(mockConfig))
    mixedConfig.tools.enabledTools = [...new Set([...(mixedConfig.tools.enabledTools || []), mixedContinueName, mixedSilentName, mixedPassiveName, "message_send"])]
    mixedConfig.tools.promptSelection.enabled = false
    mixedConfig.chat.maxToolRounds = 1
    toolRegistry.tools.set(mixedContinueName, mixedTool(mixedContinueName, true, "https://example.com/continue.jpg"))
    toolRegistry.tools.set(mixedSilentName, mixedTool(mixedSilentName, false, "https://example.com/silent.jpg"))
    toolRegistry.tools.set(mixedPassiveName, mixedPassiveTool)
    toolRegistry.tools.set("message_send", mixedMessageSendTool)
    adapterRegistry.register(mixedAdapter)
    try {
      mixedModelCall = 0
      const mixedResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "把两类结果都找来发给我",
        config: mixedConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: mixedAdapter.id, type: mixedAdapter.id, model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(mixedDeliveries.length === 1 && mixedDeliveries[0].parts?.map(part => part.source?.value).join(",") === "https://example.com/continue.jpg,https://example.com/silent.jpg", "mixed automatic delivery plans should merge once in original model-call order")
      assert(mixedResult.toolChain.map(item => item.name).join(",") === `${mixedContinueName},${mixedSilentName},message_send`, "mixed automatic delivery should preserve source-tool boundaries in the trace")
      assert(mixedResult.modelCalls.length === 2 && mixedNoToolFinalizations === 0 && mixedResult.text === "都给你找来啦，慢慢看～", "any continueConversation=true plan should produce one terminal response without forcing an extra finalization call")
      assert(mixedContinuationInstructionSeen && mixedResult.modelCalls.map(item => item.stopReason).join(",") === "tool_calls,end_turn", "the single-turn loop should continue with tools enabled and expose structured stop reasons")
      assert(mixedResult.agentTurn.phase === "completed" && mixedResult.agentTurn.emptyFinalRecoveryCount === 0, "a natural terminal response should complete the Agent Turn without recovery")
      toolRegistry.tools.set(mixedContinueName, mixedTool(mixedContinueName, false, "https://example.com/continue.jpg"))
      mixedModelCall = 0
      mixedContinuationInstructionSeen = false
      const allSilentResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "把两类结果都找来发给我，不用再回复",
        config: mixedConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: mixedAdapter.id, type: mixedAdapter.id, model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(mixedDeliveries.length === 2 && allSilentResult.modelCalls.length === 1 && allSilentResult.text === "", "a batch with every continueConversation flag disabled should finish silently after delivery")
      assert(!mixedContinuationInstructionSeen && allSilentResult.agentTurn.phase === "completed_silent", "an all-silent automatic batch should terminate without another model decision")
      mixedScenario = "automatic-and-passive"
      toolRegistry.tools.set(mixedContinueName, mixedTool(mixedContinueName, true, "https://example.com/continue.jpg"))
      mixedModelCall = 0
      mixedContinuationInstructionSeen = false
      const automaticAndPassiveResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "发一张图片，再执行一个动作",
        config: mixedConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: mixedAdapter.id, type: mixedAdapter.id, model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(mixedDeliveries.length === 3 && mixedDeliveries[2].parts?.length === 1, "an automatic media plan mixed with a passive action should still deliver its media once")
      assert(automaticAndPassiveResult.toolChain.map(item => item.name).join(",") === `${mixedContinueName},${mixedPassiveName},message_send`, "automatic media plus a passive action should preserve all tool traces")
      assert(automaticAndPassiveResult.modelCalls.length === 2 && automaticAndPassiveResult.text === "都给你找来啦，慢慢看～", "continueConversation=true should force one persona continuation when mixed with a non-delivery silent tool")

      mixedModelCall = 0
      mixedTerminalText = "<EMPTY>"
      mixedContinuationInstructionSeen = false
      const automaticEmptyResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "发一张图片，再执行一个动作",
        config: mixedConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: mixedAdapter.id, type: mixedAdapter.id, model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(mixedDeliveries.length === 4 && automaticEmptyResult.modelCalls.length === 3, "a latched continuation should add exactly one no-tool finalization only when the normal terminal model response is empty")
      assert(mixedNoToolFinalizations === 1 && automaticEmptyResult.text === "都给你找来啦，慢慢看～", "automatic delivery should reject a terminal <EMPTY> only when the source tool requested a final persona reply")
      assert(automaticEmptyResult.modelCalls.map(item => item.stopReason).join(",") === "tool_calls,end_turn,end_turn" && automaticEmptyResult.agentTurn.emptyFinalRecoveryCount === 1, "an empty final response should perform exactly one structured recovery")

      mixedScenario = "automatic-then-passive"
      mixedModelCall = 0
      mixedTerminalText = "都给你找来啦，慢慢看～"
      mixedContinuationInstructionSeen = false
      const multiRoundConfig = JSON.parse(JSON.stringify(mixedConfig))
      multiRoundConfig.chat.maxToolRounds = 2
      const automaticThenPassiveResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "先发图片，再执行后续动作",
        config: multiRoundConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: mixedAdapter.id, type: mixedAdapter.id, model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(mixedDeliveries.length === 5, "automatic delivery should happen once while the model continues into a later tool round")
      assert(automaticThenPassiveResult.toolChain.map(item => item.name).join(",") === `${mixedContinueName},message_send,${mixedPassiveName}`, "continueConversation should not terminate the request before a later tool round")
      assert(automaticThenPassiveResult.modelCalls.length === 3 && mixedNoToolFinalizations === 1 && automaticThenPassiveResult.text === "都给你找来啦，慢慢看～", "a natural terminal response after multiple tool rounds should be reused without an extra finalization model call")
      assert(automaticThenPassiveResult.modelCalls.map(item => item.stopReason).join(",") === "tool_calls,tool_calls,end_turn" && automaticThenPassiveResult.agentTurn.phase === "completed", "multiple tool rounds should stay inside one Agent Turn and finish once")

      const passiveExecutionsBeforeStructuredStops = mixedPassiveExecutions
      mixedScenario = "max-tokens-tool"
      mixedModelCall = 0
      const truncatedToolResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "执行这个动作",
        config: mixedConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: mixedAdapter.id, type: mixedAdapter.id, model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(mixedPassiveExecutions === passiveExecutionsBeforeStructuredStops && truncatedToolResult.toolChain.length === 0, "max_tokens must not execute a possibly truncated tool call")
      assert(truncatedToolResult.modelCalls.length === 1 && truncatedToolResult.modelStopReason === "max_tokens" && truncatedToolResult.text.includes("没有执行"), "max_tokens should finish locally without a redundant model finalization")

      mixedScenario = "pause-turn"
      mixedModelCall = 0
      const pausedResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "继续处理",
        config: mixedConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: mixedAdapter.id, type: mixedAdapter.id, model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(pausedResult.modelCalls.length === 1 && pausedResult.toolFinalizationAttempted === false && pausedResult.toolFinalizationReason === "MODEL_PAUSE_TURN_UNSUPPORTED", "unsupported pause_turn should stop explicitly without another model call")

      mixedScenario = "refusal"
      mixedModelCall = 0
      const refusalResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "拒绝测试",
        config: mixedConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: mixedAdapter.id, type: mixedAdapter.id, model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(refusalResult.modelCalls.length === 1 && refusalResult.toolFinalizationAttempted === false && refusalResult.text === "模型拒绝了本次请求。", "an empty refusal should remain terminal and must not retry the model")

      mixedScenario = "missing-tool-call"
      mixedModelCall = 0
      const missingToolResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async () => {} },
        prompt: "调用工具",
        config: mixedConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: mixedAdapter.id, type: mixedAdapter.id, model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(missingToolResult.modelCalls.length === 1 && missingToolResult.toolChain.length === 0 && missingToolResult.toolFinalizationReason === "MODEL_TOOL_CALLS_MISSING", "a malformed tool_calls stop must terminate locally without an empty response loop")
    } finally {
      toolRegistry.tools.delete(mixedContinueName)
      toolRegistry.tools.delete(mixedSilentName)
      toolRegistry.tools.delete(mixedPassiveName)
      toolRegistry.tools.set("message_send", mixedOriginalMessageSend)
      adapterRegistry.adapters.delete(mixedAdapter.id)
    }

    const textSearchName = "smoke_mcp_catalog"
    const textSearchTool = normalizeTool({
      name: textSearchName,
      source: "mcp",
      serverName: "smoke",
      mcp: { serverName: "smoke", originalName: "catalog" },
      category: "mcp",
      description: "Return text-only catalog observations without media resources.",
      async execute() {
        return {
          status: "success",
          content: [{ type: "text", text: "纯文字搜索结果：服务于 2026 年更新。" }],
          metadata: {
            messageSendAppendPlan: {
              parts: [{ type: "forward", nodes: [{ nickname: "搜索来源 1", parts: [{ type: "text", text: "来源标题\nhttps://example.com/source" }] }] }],
            },
          },
        }
      },
    })
    let textSearchCalls = 0
    let textSearchForcedMessageSend = false
    const textSearchDeliveries = []
    const textSearchAdapter = {
      id: "smoke-text-search",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ messages = [], tools = [], toolChoice }) {
        const searched = messages.some(item => item.name === textSearchName)
        if (!searched) {
          textSearchCalls++
          return { id: "smoke-text-search-call", text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: "smoke-text-search-tool-call", name: textSearchName, arguments: {} }] }
        }
        textSearchForcedMessageSend = tools.length === 1
          && tools[0]?.name === "message_send"
          && toolChoice?.type === "function"
          && toolChoice.name === "message_send"
        return {
          id: "smoke-text-search-send",
          text: "",
          usage: { input: 1, output: 1, total: 2, source: "reported" },
          toolCalls: [{ id: "smoke-text-search-send-call", name: "message_send", arguments: { parts: [{ type: "text", text: "文字搜索结果已整理。" }] } }],
        }
      },
    }
    const textSearchConfig = JSON.parse(JSON.stringify(mockConfig))
    textSearchConfig.tools.enabledTools = [...new Set([...(textSearchConfig.tools.enabledTools || []), textSearchName, "message_send"])]
    textSearchConfig.tools.promptSelection.enabled = false
    textSearchConfig.chat.maxToolRounds = 1
    textSearchConfig.mcp.enabled = true
    textSearchConfig.mcp.servers.smoke = { enabled: true, transport: "stdio", command: "smoke" }
    toolRegistry.tools.set(textSearchName, textSearchTool)
    adapterRegistry.register(textSearchAdapter)
    try {
      const textSearchResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" }, reply: async payload => { textSearchDeliveries.push(payload) } },
        prompt: "搜索文字资料并告诉我，不要发送任何媒体",
        config: textSearchConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: "smoke-text-search", type: "smoke-text-search", model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(textSearchCalls === 1 && textSearchResult.toolChain.map(item => item.name).join(",") === `${textSearchName},message_send`, "text-only search should finish through message_send")
      assert(textSearchForcedMessageSend === true && textSearchDeliveries[0] === "文字搜索结果已整理。", "text-only search should force and execute a text message_send delivery")
      assert(textSearchDeliveries[1]?.type === "node" && textSearchDeliveries[1]?.data?.[0]?.message?.includes("https://example.com/source"), "search delivery should append prepared source nodes after the model-authored answer")
      assert(textSearchResult.searchDeliveryRequired === true && textSearchResult.searchDeliveryStatus === "sent" && textSearchResult.toolRounds === 2 && textSearchResult.modelCalls.length === 2 && textSearchResult.text === "", "text-only search delivery should use one bounded terminal send even when search consumed the normal tool round")
    } finally {
      toolRegistry.tools.delete(textSearchName)
      adapterRegistry.adapters.delete(textSearchAdapter.id)
    }

    const pokeCalls = []
    const pokeResult = await new GroupPokeTool().execute({ qqs: ["10001", "10001"], count: 3 }, {
      e: { isGroup: true, group_id: "20001", group: { pokeMember: async qq => pokeCalls.push(qq) } },
    })
    assert(pokeCalls.length === 3 && pokeResult.content.includes("已戳 3 次") && pokeResult.executedCount === 3, "explicit poke count should execute intentional repeats in one tool call")

    const countedTool = normalizeTool({
      name: "smoke_counted_tool",
      source: "custom",
      execution: {
        effect: "non_idempotent",
        repeatPolicy: "explicit_only",
        supportsCount: true,
        countField: "count",
        maxCount: 10,
        targetFields: ["targets"],
        operationFields: ["targets"],
        promptCount: { keywords: ["戳", "poke"], units: ["次", "下"] },
        retryPolicy: "no_ambiguous_retry",
      },
      async execute() { return "unused" },
    })
    const budgetRuntime = createExecutionRuntime({ runId: "smoke-budget", prompt: "请戳我3次", maxSideEffectCalls: 2 })
    const budgetGuard = budgetRuntime.guardToolCall({ tool: countedTool, call: { name: countedTool.name, arguments: { targets: ["a", "b"], count: 3 } } })
    assert(budgetGuard.decision === "rewrite" && budgetGuard.args.count === 1 && budgetGuard.plannedCount === 2, "global side-effect budget should clamp counted multi-target calls before execution")
    const partialRuntime = createExecutionRuntime({ runId: "smoke-partial", prompt: "请戳我3次", maxSideEffectCalls: 20 })
    const partialGuard = partialRuntime.guardToolCall({ tool: countedTool, call: { name: countedTool.name, arguments: { targets: ["a"], count: 3 } } })
    const partialRecord = partialRuntime.recordExecution({ guard: partialGuard, call: { name: countedTool.name }, result: { status: "success", value: "实际成功 0 次，失败 3 次", attempt: 1 } })
    assert(partialRecord.status === "failed" && partialRecord.executedCount === 0 && partialRecord.completedCount === 0 && partialRecord.remainingCount === 3, "unstructured counted results must not be reported as completed")
    const scopedPromptRuntime = createExecutionRuntime({ runId: "smoke-prompt", prompt: "先搜索3次，然后戳我一下", maxSideEffectCalls: 20 })
    const scopedPromptGuard = scopedPromptRuntime.guardToolCall({ tool: countedTool, call: { name: countedTool.name, arguments: { targets: ["a"], count: 1 } } })
    assert(scopedPromptGuard.operations[0].requestedTotal === 1, "count authorization should only use the matching operation clause")

    const guardCircuitTool = normalizeTool({
      name: "smoke_guard_circuit_tool",
      source: "custom",
      execution: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["target"], operationFields: ["target"], retryPolicy: "no_ambiguous_retry" },
      async execute() { return "done" },
    })
    const guardCircuitRuntime = createExecutionRuntime({ runId: "smoke-guard-circuit", maxConsecutiveGuardBlocks: 2 })
    const firstGuard = guardCircuitRuntime.guardToolCall({ tool: guardCircuitTool, call: { name: guardCircuitTool.name, arguments: { target: "a" } } })
    guardCircuitRuntime.recordExecution({ guard: firstGuard, call: { name: guardCircuitTool.name }, result: { status: "success", value: "done", attempt: 1 } })
    const firstBlocked = guardCircuitRuntime.guardToolCall({ tool: guardCircuitTool, call: { name: guardCircuitTool.name, arguments: { target: "a" } } })
    const secondBlocked = guardCircuitRuntime.guardToolCall({ tool: guardCircuitTool, call: { name: guardCircuitTool.name, arguments: { target: "a" } } })
    assert(firstBlocked.code === "OPERATION_ALREADY_ATTEMPTED" && secondBlocked.code === "OPERATION_ALREADY_ATTEMPTED" && guardCircuitRuntime.state.phase === "finalizing" && guardCircuitRuntime.state.finalizationReason === "REPEATED_GUARD_BLOCK", "repeated guard blocks should enter finalization mode")

    const noProgressTool = normalizeTool({
      name: "smoke_no_progress_tool",
      source: "custom",
      execution: { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe", maxAttempts: 1 },
      async execute() { return "same result" },
    })
    const noProgressRuntime = createExecutionRuntime({ runId: "smoke-no-progress", maxNoProgress: 2 })
    for (let index = 0; index < 3; index++) {
      const guard = noProgressRuntime.guardToolCall({ tool: noProgressTool, call: { name: noProgressTool.name, arguments: {} } })
      noProgressRuntime.recordExecution({ guard, call: { name: noProgressTool.name }, result: { status: "success", value: "same result", attempt: 1 } })
    }
    assert(noProgressRuntime.state.phase === "finalizing" && noProgressRuntime.state.finalizationReason === "NO_PROGRESS", "identical read results should trigger the no-progress breaker")

    const pollingTool = normalizeTool({
      name: "smoke_polling_tool",
      source: "custom",
      execution: { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe", polling: true, maxPolls: 2, minPollIntervalMs: 1 },
      async execute() { return "pending" },
    })
    const pollingRuntime = createExecutionRuntime({ runId: "smoke-polling", maxNoProgress: 1 })
    for (let index = 0; index < 2; index++) {
      const guard = pollingRuntime.guardToolCall({ tool: pollingTool, call: { name: pollingTool.name, arguments: {} } })
      pollingRuntime.recordExecution({ guard, call: { name: pollingTool.name }, result: { status: "success", value: "pending", attempt: 1 } })
    }
    const pollingLimit = pollingRuntime.guardToolCall({ tool: pollingTool, call: { name: pollingTool.name, arguments: {} } })
    assert(pollingLimit.decision === "finalize" && pollingLimit.code === "POLLING_LIMIT" && pollingRuntime.state.noProgressStreak === 0, "polling tools should have an independent poll limit and bypass the no-progress breaker")

    const progressiveToolName = "smoke_progressive_tool"
    const progressiveConfig = JSON.parse(JSON.stringify(mockConfig))
    progressiveConfig.tools.enabledTools = ["tool_search", progressiveToolName]
    const progressiveTool = normalizeTool({
      name: progressiveToolName,
      source: "custom",
      description: "用于测试天气查询的渐进式工具。",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      async execute() { return "progressive result" },
    })
    toolRegistry.tools.set(progressiveToolName, progressiveTool)
    try {
      const discoveryContext = {
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" } },
        config: progressiveConfig,
      }
      const ordinaryUserTools = await toolRegistry.getAllowedTools({
        config: progressiveConfig,
        e: { isGroup: true, user_id: "10002", group_id: "20001", sender: { role: "member" } },
      })
      assert(ordinaryUserTools.some(tool => tool.name === "tool_search"), "ordinary users should be able to discover tools without bypassing each discovered tool's own permission")
      const discovered = await toolRegistry.execute("tool_search", { query: "天气", load: true }, {
        ...discoveryContext,
        toolDiscovery: { search: (query, limit) => toolRegistry.searchAllowedTools(query, discoveryContext, limit) },
      })
      assert(discovered.metadata?.loadTools?.includes(progressiveToolName), "tool discovery should return and mark an authorized tool for next-round loading")
      const discoveryPayload = JSON.parse(discovered.content)
      assert(discoveryPayload.tools.some(item => item.name === progressiveToolName) && discoveryPayload.hint, "tool discovery should return a compact loaded-tool summary")
      assert(discoveryPayload.tools.every(item => !Object.hasOwn(item, "parameters")), "tool discovery should not duplicate parameter schemas that are injected as next-round tool definitions")
    } finally {
      toolRegistry.tools.delete(progressiveToolName)
    }

    const backgroundConfig = JSON.parse(JSON.stringify(mockConfig))
    backgroundConfig.chat.execution.background = { enabled: true, maxConcurrent: 2, maxQueue: 4, retentionMs: 60000 }
    const backgroundTask = backgroundTaskService.submit({
      name: "smoke_background_tool",
      runId: "smoke-background-run",
      parentToolId: "smoke-parent-tool",
      config: backgroundConfig,
      execute: async () => {
        await sleep(5)
        return { status: "success", content: "background done" }
      },
    })
    assert(["queued", "running", "ok"].includes(backgroundTask.status) && backgroundTask.parentToolId === "smoke-parent-tool", "background tasks should be accepted with parent lineage")
    await sleep(20)
    const completedBackgroundTask = backgroundTaskService.get(backgroundTask.id)
    assert(completedBackgroundTask?.status === "ok" && completedBackgroundTask.result?.content === "background done", "background task should complete outside the model turn and remain queryable")

    const runtimeBackgroundName = "smoke_runtime_background"
    let runtimeBackgroundExecutions = 0
    const runtimeBackgroundTool = normalizeTool({
      name: runtimeBackgroundName,
      source: "custom",
      requiresFinalReply: false,
      execution: { effect: "non_idempotent", repeatPolicy: "dedupe", background: true, retryPolicy: "no_ambiguous_retry" },
      async execute() { runtimeBackgroundExecutions++; await sleep(5); return "runtime background done" },
    })
    const runtimeBackgroundConfig = JSON.parse(JSON.stringify(mockConfig))
    runtimeBackgroundConfig.tools.enabledTools = [...new Set([...(runtimeBackgroundConfig.tools.enabledTools || []), runtimeBackgroundName])]
    const runtimeBackgroundAdapter = {
      id: "smoke-runtime-background",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ tools = [] }) {
        return tools.length
          ? { id: "smoke-runtime-background-call", text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: "smoke-runtime-background-tool-call", name: runtimeBackgroundName, arguments: {} }] }
          : { id: "smoke-runtime-background-final", text: "unexpected final", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
      },
    }
    toolRegistry.tools.set(runtimeBackgroundName, runtimeBackgroundTool)
    adapterRegistry.register(runtimeBackgroundAdapter)
    try {
      const runtimeBackgroundResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" } },
        prompt: "执行后台动作",
        config: runtimeBackgroundConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: "smoke-runtime-background", type: "smoke-runtime-background", model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(runtimeBackgroundResult.text === "" && runtimeBackgroundResult.toolChain[0]?.status === "accepted" && runtimeBackgroundResult.toolChain[0]?.metadata?.background === true, "background tools should end a silent single-tool turn with an accepted queue result")
      await sleep(20)
      assert(runtimeBackgroundExecutions === 1, "an accepted background tool should execute exactly once after the model turn")
    } finally {
      toolRegistry.tools.delete(runtimeBackgroundName)
      adapterRegistry.adapters.delete(runtimeBackgroundAdapter.id)
    }

    const parallelToolNames = ["smoke_parallel_a", "smoke_parallel_b"]
    const parallelConfig = JSON.parse(JSON.stringify(mockConfig))
    parallelConfig.tools.enabledTools = [...new Set([...(parallelConfig.tools.enabledTools || []), ...parallelToolNames])]
    parallelConfig.tools.promptSelection.enabled = false
    const parallelStarts = {}
    const parallelTools = [
      normalizeTool({ name: parallelToolNames[0], source: "custom", description: "parallel read A", execution: { effect: "read", parallelSafe: true }, async execute() { parallelStarts.a = Date.now(); await sleep(35); return "parallel-a result" } }),
      normalizeTool({ name: parallelToolNames[1], source: "custom", description: "parallel read B", execution: { effect: "read", parallelSafe: true }, async execute() { parallelStarts.b = Date.now(); await sleep(5); return "parallel-b result" } }),
    ]
    for (const tool of parallelTools) toolRegistry.tools.set(tool.name, tool)
    const parallelAdapter = {
      id: "smoke-parallel-tools",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ tools = [], messages = [] }) {
        const toolMessages = messages.filter(item => item.role === "tool")
        if (toolMessages.length < 2) return { id: "smoke-parallel-first", text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: parallelToolNames.map((name, index) => ({ id: `smoke-parallel-call-${index}`, name, arguments: {} })) }
        return { id: "smoke-parallel-final", text: toolMessages.map(item => item.content.includes("parallel-a") ? "A" : "B").join(","), usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
      },
    }
    adapterRegistry.register(parallelAdapter)
    try {
      const parallelResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" } },
        prompt: "并行读取两个值",
        config: parallelConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: "smoke-parallel-tools", type: "smoke-parallel-tools", model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(parallelResult.text === "A,B" && Math.abs(parallelStarts.a - parallelStarts.b) < 25, "same-round read tools should run in parallel while tool responses preserve model call order")
    } finally {
      for (const name of parallelToolNames) toolRegistry.tools.delete(name)
      adapterRegistry.adapters.delete(parallelAdapter.id)
    }

    const quotaPokeCalls = []
    const quotaAdapter = {
      id: "smoke-quota-poke",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ tools = [] }) {
        if (!tools.length) throw new Error("quota poke should finish without a final model request")
        return { id: `smoke-quota-poke-${quotaPokeCalls.length}`, text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: `smoke-quota-poke-call-${quotaPokeCalls.length}`, name: "group_poke", arguments: { qqs: ["10001"], count: 1 } }] }
      },
    }
    const quotaConfig = JSON.parse(JSON.stringify(mockConfig))
    quotaConfig.tools.enabledTools = [...new Set([...(quotaConfig.tools.enabledTools || []), "group_poke"])]
    quotaConfig.chat.maxToolRounds = 5
    const originalPokeTool = toolRegistry.tools.get("group_poke")
    toolRegistry.tools.set("group_poke", normalizeTool({
      ...originalPokeTool,
      async execute(args = {}, context = {}) {
        const result = await originalPokeTool.execute(args, context)
        quotaPokeCalls.push(...Array(Math.max(0, Number(args.count) || 1)).fill(String(args.qqs?.[0] || "10001")))
        return result
      },
    }))
    adapterRegistry.register(quotaAdapter)
    try {
      const quotaResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", group: { pokeMember: async () => {} }, sender: { role: "owner" } },
        prompt: "请戳我3次",
        config: quotaConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: "smoke-quota-poke", type: "smoke-quota-poke", model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(quotaPokeCalls.length === 3, "the runtime quota should execute an explicit three-time side effect")
      assert(quotaResult.requiresFinalReply === false && quotaResult.toolChain.length === 1 && quotaResult.toolRounds === 1 && quotaResult.modelCalls.length === 1, "an explicit quota should finish in one tool round without a final model reply")
      assert(quotaResult.toolChain.at(-1)?.remainingCount === 0 && quotaResult.execution?.sideEffectCount === 3, "the quota ledger should expose completed and remaining counts")
    } finally {
      toolRegistry.tools.set("group_poke", originalPokeTool)
      adapterRegistry.adapters.delete(quotaAdapter.id)
    }

    const ambiguousToolName = "smoke_ambiguous_tool"
    let ambiguousExecutions = 0
    const ambiguousTool = normalizeTool({
      name: ambiguousToolName,
      source: "custom",
      execution: { effect: "non_idempotent", retryPolicy: "no_ambiguous_retry", maxAttempts: 3 },
      description: "Fail after an uncertain side effect.",
      async execute() {
        ambiguousExecutions++
        throw new Error("request timeout after dispatch")
      },
    })
    const ambiguousAdapter = {
      id: "smoke-ambiguous",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ tools = [], messages = [] }) {
        const toolResultCount = messages.filter(item => item.role === "tool").length
        if (!tools.length || toolResultCount >= 2) return { id: "smoke-ambiguous-final", text: "动作结果不确定，已停止自动重试。", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        return { id: "smoke-ambiguous-call", text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: "smoke-ambiguous-tool-call", name: ambiguousToolName, arguments: {} }] }
      },
    }
    const ambiguousConfig = JSON.parse(JSON.stringify(mockConfig))
    ambiguousConfig.tools.enabledTools = [...new Set([...(ambiguousConfig.tools.enabledTools || []), ambiguousToolName])]
    toolRegistry.tools.set(ambiguousToolName, ambiguousTool)
    adapterRegistry.register(ambiguousAdapter)
    try {
      const ambiguousResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" } },
        prompt: "执行这个可能已经成功的动作",
        config: ambiguousConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: "smoke-ambiguous", type: "smoke-ambiguous", model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      const ambiguousTrace = ambiguousResult.toolChain[0]
      assert(ambiguousExecutions === 1 && ambiguousTrace?.status === "ambiguous" && ambiguousTrace.attempt === 1 && ambiguousTrace.retryAllowed === false && ambiguousTrace.completedCount === 0 && ambiguousTrace.remainingCount === 1, "ambiguous side effects must not be retried automatically or be reported as completed")
      assert(ambiguousResult.toolChain[1]?.status === "skipped" && ambiguousResult.toolChain[1]?.guardCode === "AMBIGUOUS_OPERATION", "model retries after an ambiguous side effect must be blocked by the runtime guard")
      assert(ambiguousResult.text === "动作结果不确定，已停止自动重试。", "ambiguous tool results should still be handed to the model for a final explanation")
    } finally {
      toolRegistry.tools.delete(ambiguousToolName)
      adapterRegistry.adapters.delete(ambiguousAdapter.id)
    }

    const dedupeToolName = "smoke_one_shot_tool"
    let dedupeExecutions = 0
    const dedupeTool = normalizeTool({
      name: dedupeToolName,
      source: "custom",
      execution: { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["target"], operationFields: ["target"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 },
      description: "Return a one-shot smoke tool result.",
      async execute() {
        dedupeExecutions++
        return "one-shot tool result"
      },
    })
    const dedupeAdapter = {
      id: "smoke-dedupe",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ tools = [] }) {
        if (!tools.length) return { id: "smoke-dedupe-final", text: "重复调用已安全收束。", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        return { id: `smoke-dedupe-${Date.now()}`, text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: `smoke-dedupe-call-${Date.now()}`, name: dedupeToolName, arguments: { target: "10001" } }] }
      },
    }
    const dedupeConfig = JSON.parse(JSON.stringify(mockConfig))
    dedupeConfig.tools.enabledTools = [...new Set([...(dedupeConfig.tools.enabledTools || []), dedupeToolName])]
    dedupeConfig.chat.maxToolRounds = 3
    toolRegistry.tools.set(dedupeToolName, dedupeTool)
    adapterRegistry.register(dedupeAdapter)
    try {
      const dedupeResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" } },
        prompt: "请执行一次动作，即使模型重复规划也不能重复执行",
        config: dedupeConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: "smoke-dedupe", type: "smoke-dedupe", model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(dedupeExecutions === 1, "a non-repeatable tool should execute only once across repeated model rounds")
      assert(dedupeResult.toolDeduplicated === true && dedupeResult.toolChain.some(item => item.deduplicated && item.status === "skipped"), "duplicate tool rounds should be visible as skipped in the chain")
      assert(dedupeResult.text === "重复调用已安全收束。", "deduplicated tool calls should still receive a final model reply")
    } finally {
      toolRegistry.tools.delete(dedupeToolName)
      adapterRegistry.adapters.delete(dedupeAdapter.id)
    }

    const asyncToolName = "smoke_async_tool"
    const asyncTool = normalizeTool({
      name: asyncToolName,
      source: "custom",
      requiresFinalReply: false,
      description: "Run without a final model reply.",
      async execute() { return "async tool completed" },
    })
    const asyncAdapter = {
      id: "smoke-async",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ tools = [] }) {
        if (!tools.length) throw new Error("async no-reply tool should not trigger a second model call")
        return { id: "smoke-async-call", text: "", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [{ id: "smoke-async-tool-call", name: asyncToolName, arguments: {} }] }
      },
    }
    const asyncConfig = JSON.parse(JSON.stringify(mockConfig))
    asyncConfig.tools.enabledTools = [...new Set([...(asyncConfig.tools.enabledTools || []), asyncToolName])]
    toolRegistry.tools.set(asyncToolName, asyncTool)
    adapterRegistry.register(asyncAdapter)
    try {
      const asyncResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" } },
        prompt: "执行这个异步工具",
        config: asyncConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: "smoke-async", type: "smoke-async", model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(asyncResult.text === "" && asyncResult.requiresFinalReply === false, "a single explicitly async tool may finish without model text")
      assert(asyncResult.modelCalls.length === 1, "a single async no-reply tool should not trigger a second model call")
    } finally {
      toolRegistry.tools.delete(asyncToolName)
      adapterRegistry.adapters.delete(asyncAdapter.id)
    }

    const multiAsyncToolName = "smoke_async_tool_b"
    const multiAsyncTool = normalizeTool({
      name: multiAsyncToolName,
      source: "custom",
      requiresFinalReply: false,
      description: "Run as part of a multi-tool call.",
      async execute() { return "second async tool completed" },
    })
    const multiAsyncAdapter = {
      id: "smoke-multi-async",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      async sendMessage({ tools = [] }) {
        if (!tools.length) return { id: "smoke-multi-final", text: "多个异步工具仍需最终回复。", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: [] }
        return {
          id: "smoke-multi-tool-call",
          text: "",
          usage: { input: 1, output: 1, total: 2, source: "reported" },
          toolCalls: [
            { id: "smoke-multi-a", name: asyncToolName, arguments: {} },
            { id: "smoke-multi-b", name: multiAsyncToolName, arguments: {} },
          ],
        }
      },
    }
    const multiAsyncConfig = JSON.parse(JSON.stringify(mockConfig))
    multiAsyncConfig.tools.enabledTools = [...new Set([...(multiAsyncConfig.tools.enabledTools || []), asyncToolName, multiAsyncToolName])]
    multiAsyncConfig.chat.maxToolRounds = 1
    toolRegistry.tools.set(asyncToolName, asyncTool)
    toolRegistry.tools.set(multiAsyncToolName, multiAsyncTool)
    adapterRegistry.register(multiAsyncAdapter)
    try {
      const multiAsyncResult = await chatService.runModelStepWithChannel({
        e: { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" } },
        prompt: "执行多个异步工具",
        config: multiAsyncConfig,
        history: [],
        step: { id: "reply", task: "replyer", mode: "final" },
        channel: { id: "smoke-multi-async", type: "smoke-multi-async", model: "smoke", modelConfig: { toolUse: true }, timeoutMs: 1000 },
      })
      assert(multiAsyncResult.text === "多个异步工具仍需最终回复。" && multiAsyncResult.requiresFinalReply === true, "multiple async tools must still produce one final model reply")
      assert(multiAsyncResult.toolChain.length === 2, "multi-tool async test should record both tool calls")
    } finally {
      toolRegistry.tools.delete(asyncToolName)
      toolRegistry.tools.delete(multiAsyncToolName)
      adapterRegistry.adapters.delete(multiAsyncAdapter.id)
    }

    const beforeGreetingConversations = chatService.conversations.size
    const greetingText = await generateInitiativeGreeting({
      isGroup: true,
      group_id: "20001",
      user_id: "10001",
      msg: "打个招呼",
      sender: { user_id: "10001", nickname: "Smoke User" },
    }, mockConfig)
    assert(greetingText.length > 0 && greetingText.length <= mockConfig.persona.initiativeGreeting.maxChars, "initiative greeting should generate a bounded greeting")
    assert(chatService.conversations.size === beforeGreetingConversations, "initiative greeting generation should be transient")
    const sent = []
    const currentGreeting = await sendInitiativeGreeting({
      isGroup: true,
      group_id: "20001",
      user_id: "10001",
      msg: "#yui打招呼",
      sender: { user_id: "10001", nickname: "Smoke User" },
      reply: payload => {
        sent.push(payload)
        return true
      },
    }, { config: mockConfig, text: "大家好呀" })
    assert(currentGreeting.target.includes("20001") && sent.includes("大家好呀"), "initiative greeting should send to current group")
    const targetSent = []
    const targetGreeting = await sendInitiativeGreeting({
      isGroup: false,
      user_id: "10001",
      msg: "#yui打招呼30001",
      sender: { user_id: "10001", nickname: "Smoke User" },
      bot: {
        pickGroup: async id => ({
          sendMsg: payload => {
            targetSent.push({ id, payload })
            return true
          },
        }),
      },
    }, { config: mockConfig, groupId: "30001", text: "目标群好" })
    assert(targetGreeting.target.includes("30001") && targetSent[0]?.payload === "目标群好", "initiative greeting should send to specified group")
    assert(initiativeGreetingScheduler.start(mockConfig).active === false, "initiative greeting scheduler should stay inactive by default")
    const scheduledConfig = JSON.parse(JSON.stringify(mockConfig))
    scheduledConfig.persona.initiativeGreeting.scheduledEnabled = true
    scheduledConfig.persona.initiativeGreeting.groups = ["30001"]
    scheduledConfig.persona.initiativeGreeting.probabilityPercent = 100
    scheduledConfig.persona.initiativeGreeting.intervalHours = 1
    const started = initiativeGreetingScheduler.start(scheduledConfig)
    assert(started.active === true && started.scheduledEnabled === true, "initiative greeting scheduler should start when scheduledEnabled=true")
    initiativeGreetingScheduler.stop()
    const applied = await applyRuntimeConfig(scheduledConfig, { reinitTools: false })
    assert(applied.tools === false, "runtime config apply should allow skipping tool reinit")
    assert(applied.initiativeGreeting?.active === true, "runtime config apply should restart initiative greeting scheduler")
    const scheduledSent = []
    const scheduledRun = await initiativeGreetingScheduler.runOnce({
      config: scheduledConfig,
      force: true,
      bot: {
        pickGroup: async id => ({
          sendMsg: payload => {
            scheduledSent.push({ id, payload })
            return true
          },
        }),
      },
    })
    assert(scheduledRun.sent === 1, "initiative greeting scheduler should send forced run")
    const dryRun = await initiativeGreetingScheduler.runOnce({
      config: scheduledConfig,
      force: true,
      dryRun: true,
      text: "预演问候",
    })
    assert(dryRun.dryRun === true && dryRun.planned === 1 && dryRun.sent === 0, "initiative greeting scheduler should support dry-run preview")
    const status = buildInitiativeGreetingStatus(scheduledConfig)
    assert(status.config.groups.includes("30001") && status.scheduler.lastPreview.length === 1, "initiative greeting status should expose config and preview state")
    assert(initiativeGreetingScheduler.stop().active === false, "initiative greeting scheduler should stop cleanly")
  } finally {
    initiativeGreetingScheduler.stop()
    await chatService.clearAll()
    await configStore.save(original)
  }
}

// 数据库字段和日聚合由独立 SQLite 回归覆盖；这里补协议、托管工具与脱敏回显。
async function checkUnifiedModelLogs() {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js")
  const { modelLogStore } = await import("../output/runtime/core/observability/model-log.js")
  const ownsSqliteClient = !sqliteClient.status.available
  await sqliteClient.init(defaults)
  try {
    modelLogStore.start(defaults)
    assert(modelLogStore.stats().persistenceAvailable, "unified model logs should see the baseline SQLite worker")
    const call = modelLogStore.beginModelCall({
      source: "smoke",
      purpose: "chat",
      channel: { id: "responses-log-smoke", type: "openai-responses", model: "gpt-5.4", stream: true, modelConfig: { name: "responses-log-smoke" } },
      messages: [{ role: "assistant", content: "", protocol: { kind: "responses", outputItems: [{ type: "reasoning", encrypted_content: "MUST_NOT_PERSIST" }] } }],
      tools: [
        { type: "web_search" },
        { type: "function", name: "command_search", description: "Search commands.", parameters: { type: "object", properties: {} }, defer_loading: true },
      ],
      request: { protocol: "responses" },
    })
    assert(call?.id, "Responses model log smoke should start a model call")
    modelLogStore.captureModelRequest(call, {
      protocol: "responses",
      phase: "initial",
      body: { model: "gpt-5.4", input: [{ role: "user", content: "调试请求" }], authorization: "MUST_NOT_PERSIST" },
    })
    modelLogStore.completeModelCall(call, {
      response: {
        id: "resp_log_smoke",
        text: "完成",
        stopReason: "end_turn",
        toolCalls: [],
        hostedToolCalls: [{ type: "web_search_call", id: "ws_log_smoke", status: "completed", query: "测试", raw: { type: "web_search_call", private_raw_marker: "RAW_ONLY_IN_TOOL_EVENT" } }],
        responsesStateRecovery: { reason: "tool_call_link_missing", from: "linked", to: "stateless_replay", replayedMessages: 6, droppedToolItems: 1 },
        usage: { input: 2, output: 1, total: 3, cached: 0, reasoning: 0, source: "reported", inputKnown: true, outputKnown: true },
      },
    })
    const detail = await modelLogStore.getModelCallDetail(call.id)
    assert(detail?.modelCall?.adapter === "openai-responses" && detail.modelCall.hosted_tool_call_count === 1, "model logs should expose protocol adapter and hosted-tool call summaries")
    assert(detail?.modelCall?.protocol === "responses" && detail.modelCall.stream === true, "model logs should expose the canonical protocol and streaming mode")
    assert(detail?.snapshot?.request?.model?.protocol === "responses" && detail.snapshot.request.model.stream === true, "model snapshots should expose protocol and streaming mode")
    assert(detail?.modelCall?.responses_state_recovery?.reason === "tool_call_link_missing" && detail.modelCall.responses_state_recovery.droppedToolItems === 1, "model logs should expose bounded Responses recovery diagnostics")
    assert(!JSON.stringify(detail?.modelCall?.hosted_tool_calls || []).includes("RAW_ONLY_IN_TOOL_EVENT"), "model metadata should omit hosted raw payloads that are stored on their dedicated tool events")
    assert(detail?.snapshot?.tools?.[0]?.type === "web_search" && detail.snapshot.tools?.[1]?.description === "Search commands.", "model logs should preserve Responses top-level function and built-in tool definitions")
    assert(!JSON.stringify(detail?.snapshot || {}).includes("MUST_NOT_PERSIST"), "model snapshots should redact encrypted Responses reasoning content")
    assert(detail?.snapshot?.request?.rawRequests?.[0]?.protocol === "responses" && !JSON.stringify(detail?.snapshot?.request?.rawRequests || []).includes("MUST_NOT_PERSIST"), "model logs should retain bounded, redacted raw protocol request bodies")

    const failureCall = modelLogStore.beginModelCall({
      source: "smoke",
      purpose: "chat",
      channel: { id: "failure-log-smoke", type: "openai-compatible", model: "gpt-test", modelConfig: { name: "failure-log-smoke" } },
      messages: [{ role: "user", content: "超时测试" }],
      request: { protocol: "chat-completions" },
    })
    assert(failureCall?.id, "failure model log smoke should start a model call")
    const timeoutError = new Error("请求超时：90000ms")
    timeoutError.code = "ETIMEDOUT"
    timeoutError.yuiNetwork = { target: "https://example.invalid/chat", method: "POST", timeoutMs: 90000, responseReceived: false }
    modelLogStore.completeModelCall(failureCall, { error: timeoutError })
    const failureDetail = await modelLogStore.getModelCallDetail(failureCall.id)
    assert(failureDetail?.modelCall?.error_message?.includes("请求超时") && failureDetail.modelCall.error_details?.code === "ETIMEDOUT" && failureDetail.modelCall.error_details?.responseReceived === false, "model logs should expose failure messages and timeout diagnostics")
  } finally {
    await modelLogStore.stop({ flush: true })
    if (ownsSqliteClient) await sqliteClient.close()
  }
}

async function checkCommandKnowledge() {
  const { buildCommandDoc, commandObserver } = await import("../output/runtime/knowledge/command-observer.js")
  const { CommandRecommendTool, CommandSearchTool } = await import("../output/runtime/tools/builtins/command.js")
  const previousCommands = JSON.parse(JSON.stringify(commandObserver.commands || []))
  const previousEvents = JSON.parse(JSON.stringify(commandObserver.events || []))
  try {
    const doc = buildCommandDoc({
    id: "smoke:aihelp",
    pluginKey: "yui-chat",
    pluginName: "Yui Chat",
    description: "指令检索",
    fnc: "help",
    regexp: "^#yuihelp([\\s\\S]*)$",
    permission: "all",
    event: "message",
    priority: 1,
    helpDocs: [{ source: "README.md", text: "#yuihelp 怎么查体力 #yuichat 你好" }],
  })
  assert(doc.suggestedCommand.startsWith("#yuihelp"), "command knowledge should derive suggested command")
  assert(doc.examples.includes("#yuihelp"), "command knowledge should collect doc command examples")
  assert(doc.commandHeads.includes("#yuihelp"), "command knowledge should derive command heads")
  assert(doc.parameterHints.some(item => item.name === "内容"), "command knowledge should derive parameter hints")
  assert(doc.intentHints.includes("帮助") || doc.intentHints.includes("查询"), "command knowledge should derive intent hints")
  const scoped = buildCommandDoc({
    id: "smoke:scoped-help",
    pluginKey: "scoped-plugin",
    pluginName: "范围指令",
    description: "只保留匹配当前指令的帮助片段",
    summary: "建议指令：/readme/girl.png",
    fnc: "run",
    regexp: "^#真实指令([\\s\\S]*)$",
    permission: "all",
    event: "message",
    priority: 1,
    helpDocs: [{ source: "README.md", text: "#真实指令 查询当前状态\n/readme/girl.png #无关指令" }],
  })
  assert(scoped.suggestedCommand.startsWith("#真实指令") && !scoped.examples.includes("/readme/girl.png"), "command help should ignore unrelated README tokens")
  assert(!scoped.commandHeads.includes("/readme") && !scoped.searchText.includes("/readme/girl.png"), "command search text should not reuse stale derived summaries")
  const unprefixed = buildCommandDoc({
    id: "smoke:unprefixed",
    pluginKey: "unprefixed-plugin",
    pluginName: "无前缀指令",
    description: "无前缀触发规则",
    fnc: "parse",
    regexp: "^ep\\d+$",
    permission: "all",
    event: "message",
    priority: 1,
    helpDocs: [{ source: "README.md", text: "resources/readme/girl.png\n#sf帮助" }],
  })
  assert(!unprefixed.examples.includes("/readme/girl.png") && !unprefixed.suggestedCommand.includes("/readme"), "README assets should not become examples for unprefixed rules")
  const { default: PluginsLoader } = await import("../../../lib/plugins/loader.js")
  const previousPriority = PluginsLoader.priority
  const previousInitializedForScan = commandObserver.initialized
  try {
    commandObserver.commands = [doc]
    commandObserver.initialized = true
    PluginsLoader.priority = [{
      key: "smoke-runtime-plugin",
      priority: 1,
      plugin: {
        name: "Yui Chat",
        dsc: "运行态指令",
        rule: [
          { fnc: "help", reg: /^#yuihelp([\s\S]*)$/, permission: "all", event: "message" },
          { fnc: "internalHook", reg: "sf-plugin-InternalHook-12345", permission: "all", event: "message" },
        ],
      },
    }]
    const initialScan = await commandObserver.scan()
    const runtimeCommand = initialScan.find(item => item.pluginKey === "smoke-runtime-plugin")
    assert(!initialScan.some(item => item.fnc === "internalHook"), "ephemeral internal hook rules must not enter command knowledge")
    const manualOverride = await commandObserver.upsertManualCommand({
      sourceCommandId: runtimeCommand.id,
      sourceRuleKey: runtimeCommand.sourceRuleKey,
      sourceOrigin: runtimeCommand.origin,
      pluginName: "Yui Chat",
      suggestedCommand: "#yui帮助说明",
      description: "手工修订后的说明",
      body: "这是人工修订后的完整正文。",
    })
    PluginsLoader.priority[0].plugin.rule[0].reg = /^#yuihelp更新([\s\S]*)$/
    const scanned = await commandObserver.scan()
    const preservedManual = scanned.find(item => item.id === manualOverride.id)
    assert(runtimeCommand && !runtimeCommand.sourceDocs && !runtimeCommand.examples.includes("/readme/girl.png"), "static scan should only use runtime command metadata")
    assert(runtimeCommand?.origin?.pluginName === "Yui Chat" && runtimeCommand.origin.file === "plugins/smoke-runtime-plugin/index.js" && runtimeCommand.origin.fileRole === "插件入口" && runtimeCommand.origin.method === "help", "static command scans should retain the plugin, source file, and rule method")
    assert(preservedManual?.manual && preservedManual.description === "手工修订后的说明" && preservedManual.body === "这是人工修订后的完整正文。", "manual command edits should retain their full body after a later runtime scan")
    assert(!scanned.some(item => item.pluginKey === "smoke-runtime-plugin") && scanned.filter(item => item.pluginName === "Yui Chat" && item.suggestedCommand === "#yui帮助说明").length === 1, "a manual override should survive a future scan even when the source trigger rule changes")
    await commandObserver.deleteCuratedCommand(manualOverride.id)
  } finally {
    PluginsLoader.priority = previousPriority
    commandObserver.initialized = previousInitializedForScan
    commandObserver.commands = [doc]
  }
  commandObserver.events = [{ exactMatches: [doc.id], matches: [], time: new Date().toISOString() }]
  commandObserver.rebuildUsageCounts()
  const previousInitialized = commandObserver.initialized
  commandObserver.initialized = false
  let scanGuarded = false
  try {
    await commandObserver.scan()
  } catch (error) {
    scanGuarded = error?.code === "COMMAND_OBSERVER_NOT_READY"
  } finally {
    commandObserver.initialized = previousInitialized
  }
  assert(scanGuarded, "command scan should reject before the observer runtime is initialized")
  const matches = commandObserver.findMatches("#yuihelp", 1)
  assert(matches[0]?.suggestedCommand?.startsWith("#yuihelp"), "command search should return suggested command")
  assert(Boolean(matches[0]?.reason), "command search should return recommendation reason")
  assert(matches[0]?.commandHeads?.includes("#yuihelp"), "command search should include command heads")
  const structuredRecommendation = commandObserver.recommendCommands("#yuihelp", { limit: 1 })
  assert(structuredRecommendation.results[0]?.recommendation?.command?.startsWith("#yuihelp"), "command recommendations should expose executable command")
  assert(structuredRecommendation.results[0]?.recommendation?.nextSteps?.length >= 1, "command recommendations should expose next steps")
  assert(["high", "medium", "low", "observed"].includes(structuredRecommendation.results[0]?.recommendation?.confidence), "command recommendations should expose confidence")
  const hybridRecommendation = await commandObserver.recommendCommandsHybrid("#yuihelp", { limit: 1 })
  assert(hybridRecommendation.results[0]?.recommendation?.command?.startsWith("#yuihelp") && ["lexical", "hybrid"].includes(hybridRecommendation.retrieval?.mode), "hybrid command recommendations should preserve lexical fallback and retrieval metadata")
  const manual = await commandObserver.upsertManualCommand({
    suggestedCommand: "#烟测手动命令 <内容>",
    description: "手动补充烟测",
    examples: ["#烟测手动命令 hello"],
    parameterHints: "内容",
  })
  assert(manual.manual === true, "manual command should be marked as manual")
  assert(manual.commandHeads.includes("#烟测手动命令"), "manual command should expose command head")
  assert(commandObserver.findMatches("手动补充烟测", 1)[0]?.id === manual.id, "manual command should be searchable")
  const manualRecommendation = commandObserver.recommendCommands("手动补充烟测", { limit: 1 })
  assert(manualRecommendation.results[0]?.recommendation?.confidence === "manual", "manual command recommendation should expose manual confidence")
  assert(commandObserver.digest({ limit: 10 }).stats.manualCommands >= 1, "command digest should count manual commands")
  const manualReplacement = await commandObserver.upsertManualCommand({
    pluginName: "手动知识",
    suggestedCommand: "#烟测手动命令 <内容>",
    description: "二次编辑后的说明",
  })
  assert(manualReplacement.id === manual.id, "manual command identity should be stable for plugin name plus command")
  assert(commandObserver.commands.filter(item => item.pluginName === "手动知识" && item.suggestedCommand === "#烟测手动命令 <内容>").length === 1, "manual command upsert should keep plugin plus command unique")
  const deletedManual = await commandObserver.deleteCuratedCommand(manual.id)
  assert(deletedManual.deleted === 1, "manual command should be deletable")
  assert(!commandObserver.commands.some(item => item.id === manual.id), "manual command should be removed after delete")
  const noisy = buildCommandDoc({
    id: "smoke:noisy",
    pluginKey: "noise-plugin",
    pluginName: "噪声插件",
    description: "只是近期被频繁触发的无关指令",
    fnc: "noise",
    regexp: "^#无关指令([\\s\\S]*)$",
    permission: "all",
    event: "message",
    priority: 99,
    helpDocs: [{ source: "README.md", text: "#无关指令 #测试" }],
  })
  const relevant = buildCommandDoc({
    id: "smoke:stamina",
    pluginKey: "stamina-plugin",
    pluginName: "体力插件",
    description: "体力查询",
    fnc: "stamina",
    regexp: "^#体力([\\s\\S]*)$",
    permission: "all",
    event: "message",
    priority: 1,
    helpDocs: [{ source: "README.md", text: "#体力 查询当前体力" }],
  })
  commandObserver.commands = [noisy, relevant]
  commandObserver.events = Array.from({ length: 9 }, () => ({ exactMatches: [noisy.id], matches: [], time: new Date().toISOString() }))
  commandObserver.rebuildUsageCounts()
  assert(commandObserver.findMatches("怎么查体力", 1)[0]?.id === relevant.id, "usage-only noisy commands must not outrank semantic matches")
  const observed = commandObserver.upsertObservedCommand({
    text: "#未知动态查询 角色",
    commandHead: "#未知动态查询",
    signature: "#未知动态查询 <内容>",
    commandPrefixes: ["#"],
    handledBy: "[SmokePlugin][dynamicQuery]",
    exactMatches: [],
    matches: [],
    isGroup: true,
    groupId: "20001",
    userId: "10001",
    time: new Date().toISOString(),
  })
  assert(observed?.pluginKey === "observed", "dynamic unknown command should become an observed command doc")
  assert(observed.commandHeads?.includes("#未知动态查询"), "observed command should expose command head")
  assert(observed.parameterHints?.some(item => item.name === "内容"), "observed command should expose parameter hints")
  assert(observed.observed?.signatures?.includes("#未知动态查询 <内容>"), "observed command should store analyzed signatures")
  assert(commandObserver.stats().observedCommands >= 1, "stats should expose observed command count")
  assert(commandObserver.stats().storage?.format === "split-json-v2", "command knowledge should expose split storage format")
  assert(commandObserver.stats().storage?.singleWriterOnly === true, "command knowledge should declare the single-writer boundary")
  const dynamicMatches = commandObserver.findMatches("未知动态查询", 1)
  assert(dynamicMatches[0]?.suggestedCommand?.startsWith("#未知动态查询"), "dynamic observed commands should be searchable")
  const customPrefix = commandObserver.upsertObservedCommand({
    text: "!自定义前缀 帮助",
    commandPrefixes: ["!"],
    handledBy: "[SmokePlugin][customPrefix]",
    exactMatches: [],
    matches: [],
    time: new Date().toISOString(),
  })
  assert(customPrefix?.suggestedCommand === "!自定义前缀", "observed command should respect configured prefixes")
  commandObserver.events.push({
    text: "!自定义前缀 帮助",
    commandHead: "!自定义前缀",
    commandPrefix: "!",
    handledBy: "[SmokePlugin][customPrefix]",
    exactMatches: [],
    matches: [],
    observedCommandId: customPrefix.id,
    matchType: "observed",
    time: new Date().toISOString(),
  })
  const digest = commandObserver.digest({ limit: 10 })
  const quality = commandObserver.qualityReport({ limit: 10 })
  assert(digest.stats.commands >= 2, "command digest should count commands")
  assert(digest.stats.dynamicCommands >= 1, "command digest should count dynamic commands")
  assert(digest.stats.exampleCoverageRatio > 0, "command digest should expose example coverage")
  assert(digest.stats.commandHeadCoverageRatio > 0, "command digest should expose command head coverage")
  assert(digest.distributions.commandHeads.some(item => item.key === "#体力"), "command digest should include command head distribution")
  assert(digest.observer.commandPrefixes.includes("#"), "command digest should expose observer prefixes")
  assert(digest.capture.observed >= 1, "command digest should expose capture observed count")
  assert(digest.capture.byPrefix.some(item => item.key === "!"), "command digest should group captured events by prefix")
  assert(digest.distributions.plugins.length > 0, "command digest should include plugin distribution")
  assert(digest.dynamicCommands.some(item => item.suggestedCommand?.startsWith("#未知动态查询")), "command digest should include observed command samples")
  assert(quality.summary.commands >= 2 && typeof quality.summary.averageQualityScore === "number", "command quality report should summarize indexed commands")
  assert(Array.isArray(quality.weakCommands) && Array.isArray(quality.recommendations), "command quality report should expose weak commands and recommendations")
  const commandSearchOutput = await new CommandSearchTool().execute({ query: "怎么查体力", limit: 1 })
  assert(commandSearchOutput.includes("触发头") && commandSearchOutput.includes("参数") && commandSearchOutput.includes("推荐置信度") && commandSearchOutput.includes("下一步"), "command_search tool should expose command recommendation analysis")
  const commandRecommendOutput = JSON.parse(await new CommandRecommendTool().execute({ query: "怎么查体力", limit: 1, includeAudit: true }))
  assert(commandRecommendOutput.recommendations[0]?.command?.startsWith("#体力"), "command_recommend should return structured executable command")
  assert(commandRecommendOutput.recommendations[0]?.nextSteps?.length >= 1, "command_recommend should return structured next steps")
  assert(commandRecommendOutput.audit?.summary?.commands >= 1, "command_recommend should optionally include knowledge quality audit")
  const { CommandKnowledgeAuditTool } = await import("../output/runtime/tools/builtins/command.js")
  const auditOutput = await new CommandKnowledgeAuditTool().execute({ limit: 3 })
  assert(auditOutput.includes("指令知识库质量") && auditOutput.includes("问题分布"), "knowledge audit action should report quality")
  } finally {
    commandObserver.commands = previousCommands
    commandObserver.events = previousEvents
    commandObserver.rebuildUsageCounts()
    await commandObserver.save()
  }
}

async function checkWebAndBoot() {
  const { applyConfigPatch, createWebApp, deleteModelConfig, deleteProviderConfig, setDefaultModelConfig, updateModelConfig, updateProviderConfig } = await import("../output/runtime/web/http/app.js")
  const { compactMediaDataForDisplay, modelMessageImageCount, modelMessagesImageCount } = await import("../output/runtime/web/client/features/logs/log-media-display.js")
  const logMediaMessages = [
    { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: tinyPngDataUrl } }, { type: "image_url", image_url: { url: tinyPngDataUrl } }] },
    { role: "assistant", content: "收到" },
  ]
  const compactLogMedia = JSON.stringify(compactMediaDataForDisplay(logMediaMessages))
  assert(modelMessageImageCount(logMediaMessages[0]) === 2 && modelMessagesImageCount(logMediaMessages) === 2, "log media display should count every image content part")
  assert(compactLogMedia.includes("Base64 image/png") && !compactLogMedia.includes(tinyPngDataUrl), "log media display should compact Base64 image URLs without changing the snapshot")
  const { buildContextDisplay, contextSourceLabel } = await import("../output/runtime/web/client/features/logs/log-context-display.js")
  const promptSnapshot = {
    messages: [
      { role: "system", content: "角色正文\n记忆正文" },
      logMediaMessages[0],
      { role: "assistant", content: "", tool_calls: [{ id: "call-1", function: { name: "search", arguments: "{}" } }] },
      { role: "tool", content: "工具正文", tool_call_id: "call-1" },
    ],
    request: { metadata: { context: {
      items: [{ index: 0, source: "system-context" }, { index: 1, source: "current" }, { index: 2, source: "model-decision" }, { index: 3, source: "tool-result" }],
      sections: [
        { source: "persona", label: "角色设定", content: "角色正文", messageIndexes: [0] },
        { source: "memory", label: "记忆召回", content: "记忆正文", messageIndexes: [0] },
        { source: "current", messageIndexes: [1, 1, 99] },
      ],
    } } },
  }
  const beforePromptDisplay = JSON.stringify(promptSnapshot)
  const promptDisplay = buildContextDisplay(promptSnapshot)
  assert(promptDisplay.groups.length === 5 && promptDisplay.groups[0].body === "角色正文" && promptDisplay.groups[0].entries.length === 0, "prompt sources should display each injection once without duplicating the composed system message")
  assert(promptDisplay.groups[2].entries.length === 1 && promptDisplay.groups[2].entries[0].images === 2, "source references should ignore duplicate and out-of-range indexes while preserving images")
  assert(promptDisplay.groups[3].entries[0].toolCalls[0].id === "call-1" && promptDisplay.groups[4].entries[0].body === "工具正文", "incomplete source metadata should not hide unlisted tool decisions or results")
  assert(!promptDisplay.messages[1].body.includes(tinyPngDataUrl) && promptDisplay.messages[0].body === promptSnapshot.messages[0].content && JSON.stringify(promptSnapshot) === beforePromptDisplay, "message display should compact media without mutating snapshot content or order")
  const missingSectionBodies = buildContextDisplay({ messages: promptSnapshot.messages, request: { metadata: { context: { sections: [{ source: "persona", messageIndexes: [0] }, { source: "memory", messageIndexes: [0] }] } } } })
  assert(missingSectionBodies.groups.slice(0, 2).every(group => group.unavailable && !group.entries.length), "missing shared source bodies should be labeled unavailable, not replaced by the entire system prompt")
  const oldPromptDisplay = buildContextDisplay({ messages: promptSnapshot.messages })
  assert(!oldPromptDisplay.hasSources && oldPromptDisplay.groups[0].entries.length === 4, "old snapshots should retain every message without guessing prompt sources")
  assert(contextSourceLabel({ source: "message-reference" }) === "本轮指代" && contextSourceLabel({ source: "future-source", label: "未来来源" }) === "未来来源", "prompt source labels should cover reference instructions and preserve unknown source names")
  assert(buildContextDisplay(null).groups.length === 0 && buildContextDisplay({ messages: [] }).messages.length === 0, "missing and embedding snapshots should keep the empty state")
  const app = createWebApp()
  assert(Boolean(app.stack), "web app should be an express router")
  const pluginEntrySource = await fs.readFile(path.join(pluginRoot, "index.js"), "utf8")
  const runtimeEntrySource = await fs.readFile(path.join(pluginRoot, "runtime-entry.ts"), "utf8")
  const webAppSource = await readWebServerSource()
  const webMainSource = await readSource("web/client/main.js")
  const compiledWebMainSource = await fs.readFile(path.join(pluginRoot, "output/runtime/web/client/main.js"), "utf8")
  const webUiSource = await readSource("web/client/ui/components.js")
  const webShellSource = await readSource("web/client/app/app-shell.js")
  const webStoreSource = await readSource("web/client/app/store/store.js")
  const webOverviewSource = await readSource("web/client/features/overview/overview-tab.js")
  const webLogsSource = await readSource("web/client/features/logs/logs-tab.js")
  const webPersonaSource = await readSource("web/client/features/persona/persona-tab.js")
  assert(webAppSource.includes("/api/tools/:name/source-preview") && webAppSource.includes("builtinToolSourcePreview") && webAppSource.includes("sourcePreviewLimit"), "tool source preview should be authenticated, bounded, and resolved only from built-in source files")
  const webMessageFiltersSource = await readSource("web/client/features/filters/message-filters-panel.js")
  const webProvidersSource = await readWebProviderSource()
  const webKnowledgeSource = [
    await readSource("web/client/features/knowledge/knowledge-tab.js"),
    await readSource("web/client/features/knowledge/knowledge-base-workspace.ts"),
    await readSource("web/client/features/knowledge/knowledge-command-maintenance.ts"),
  ].join("\n")
  const webMemorySource = [
    await readSource("web/client/features/memory/memory-tab.js"),
    await readSource("web/client/features/memory/memory-extraction-workspace.ts"),
    await readSource("web/client/features/memory/memory-capture-drawers.ts"),
    await readSource("web/client/features/memory/memory-manage-workspace.ts"),
  ].join("\n")
  const memoryViewMatch = webMemorySource.match(/const memoryView = reactive\(\{([\s\S]*?)\n    \}\)/u)
  assert(memoryViewMatch?.[1].includes("taskListSummary"), "memory extraction workspace view should expose taskListSummary")
  const webToolsSource = await readWebToolsSource()
  const webMcpSource = await readSource("web/client/features/tools/mcp-panel.js")
  const webExtensionPanelSource = [
    await readSource("web/client/features/tools/extension-panel.js"),
    await readSource("web/client/features/tools/extension-editor-drawer.ts"),
  ].join("\n")
  const webExtensionCreateSource = await readSource("web/client/features/tools/extension-create-drawer.js")
  const webFiltersSource = await readWebFiltersSource()
  const webCustomFiltersSource = await readSource("web/client/features/filters/custom-panel.js")
  const webChatSource = await readSource("web/client/features/chat/chat-tab.js")
  const webAdvancedSource = await readSource("web/client/features/advanced/advanced-tab.js")
  const sqliteWorkerSource = await fs.readFile(path.join(pluginRoot, "core/storage/sqlite/worker.ts"), "utf8")
  const webCssSource = await (async () => {
    const stylesDir = path.join(pluginRoot, "web/client/styles")
    const entry = await fs.readFile(path.join(stylesDir, "app.css"), "utf8")
    const imported = [...entry.matchAll(/@import\s+["']\.\/([\w-]+\.css)["'];?/g)].map(match => match[1])
    const parts = await Promise.all(imported.map(name => fs.readFile(path.join(stylesDir, name), "utf8")))
    return [entry, ...parts].join("\n")
  })()
  const { buildSetupGuide } = await import("../output/runtime/core/runtime/setup-guide.js")
  const setupGuide = await buildSetupGuide()
  assert(setupGuide.summary.total === 8 && Array.isArray(setupGuide.steps), "setup guide should expose the eight-step quick setup flow")
  assert(setupGuide.steps.some(item => item.id === "provider-model") && setupGuide.steps.some(item => item.id === "knowledge") && setupGuide.steps.some(item => item.id === "web-chat-test"), "setup guide should include model, knowledge, and Web chat verification steps")
  assert(setupGuide.steps.every(item => item.recommendation && Object.keys(item.defaults || {}).length), "every setup step should include recommendations and reference defaults")
  assert(!webAppSource.includes("/api/persona/expression"), "web app should remove the retired persona expression API")
  assert(webAppSource.includes("/api/persona/initiative-greeting") && webAppSource.includes("/api/persona/initiative-greeting/preview"), "web app should expose initiative greeting APIs")
  assert(webAppSource.includes("/api/knowledge/quality"), "web app should expose command knowledge quality API")
  assert(webAppSource.includes("/api/knowledge/bases/:id/retrieval") && webAppSource.includes("/api/knowledge/rescan"), "web app should expose protected command retrieval settings and guarded rescan APIs")
  assert(webAppSource.includes('app.delete("/api/knowledge/index-jobs/:id"') && webKnowledgeSource.includes("indexJobPagination") && webKnowledgeSource.includes("超期任务自动取消"), "knowledge index history should support paged deletion and seven-day expiration")
  assert(
    pluginEntrySource.includes('path.join(pluginRoot, "output", "runtime", "runtime-entry.js")')
      && runtimeEntrySource.includes("commandObserver.init({ scanOnReady: false })")
      && runtimeEntrySource.includes("const express = hostRuntime.bot?.express")
      && runtimeEntrySource.includes("typeof express.use === \"function\"")
      && !runtimeEntrySource.includes("knowledgeStore.syncBuiltinCommands"),
    "startup should load the compiled entry, preserve the callable Yunzai Express app for the 2536 mount, and leave command scans to the explicit management action",
  )
  assert(webAppSource.includes("progress: parsePayload") && webAppSource.includes("/api/knowledge/index-jobs"), "web app should expose persisted index progress metadata")
  assert(webAppSource.includes("/api/knowledge/manual-command") && webAppSource.includes("app.get(\"/api/knowledge/commands/:id\"") && webAppSource.includes("app.delete(\"/api/knowledge/commands/:id\""), "web app should expose manual command curation APIs")
  assert(webAppSource.includes("/api/memory/scopes/:scopeType/:ownerId") && webAppSource.includes("/api/memory/groups/:groupId/workspace") && webAppSource.includes("/api/memory/groups/:groupId/members/:userId") && webAppSource.includes("deleteScopedMemory"), "web app should expose authenticated global, group-public, and group-member memory maintenance APIs")
  assert(webAppSource.includes("/api/memory/captures/:scopeType/:scopeId/windows/:windowId/run"), "web app should expose authenticated manual extraction-window execution and retry API")
  assert(webAppSource.includes("/api/setup-guide"), "web app should expose setup guide API")
  assert(webAppSource.includes("/api/chat/test") && webAppSource.includes("/api/chat/test/sessions") && webAppSource.includes("/api/chat/test/clear"), "web app should expose safe Web chat-test creation, history, and deletion APIs")
  assert(webAppSource.includes("/api/logs/summary") && webAppSource.includes("/api/logs/runs/:id") && webAppSource.includes("/api/logs/model-calls/:id/detail") && webAppSource.includes("/api/logs/runs/:id/conversation") && webAppSource.includes("/api/logs/cleanup"), "web app should expose unified log summary, timeline, lazy model detail, conversation history, and cleanup APIs")
  assert(webAppSource.includes("/api/message-filters") && !webAppSource.includes("/api/message-processors") && webAppSource.includes("/api/custom-filters"), "web app should expose native and Custom Filter APIs without the retired processor API")
  assert(webAppSource.includes("/api/extension-authoring/resources") && webAppSource.includes("/api/extension-authoring/filter-draft"), "web app should expose authenticated resource browsing and project-AI filter draft APIs")
  assert(webAppSource.includes("X-Content-Type-Options") && webAppSource.includes("X-Frame-Options") && webAppSource.includes('"Cache-Control", "no-store"') && webAppSource.includes("Content-Security-Policy"), "web app should set baseline security, CSP, and no-store API headers")
  assert(webAppSource.includes("app.patch(\"/api/config\""), "web app should expose patch config API")
  assert(!webChatSource.includes("sessionStorage") && !webChatSource.includes("localStorage"), "web chat test must ignore browser storage and keep test transcripts only in SQLite")
  assert(webAppSource.includes("app.post(\"/api/config/backups\"") && webAppSource.includes("app.delete(\"/api/config/backups/:fileName\"") && webAdvancedSource.includes("手动备份配置") && webAdvancedSource.includes("永久删除备份"), "web app should expose authenticated configuration-package creation and single-file deletion")
  assert(webAppSource.includes("/api/config/auth-token") && !webAppSource.includes("/api/config/reload") && webAdvancedSource.includes("saveWebAuthToken") && webAdvancedSource.includes("saveWebAddress") && webAdvancedSource.includes("Web 访问与登录") && webAdvancedSource.includes("快捷链接预览") && webAdvancedSource.includes("if (section === \"status\") loadWebAuthToken()") && !webAdvancedSource.includes('value: "web-auth"'), "system status should include the custom Web server prefix and authenticated static-token management without the obsolete generic reload endpoint")
  assert(!webAppSource.includes("/api/auth/local-temp-token") && webAppSource.includes("/api/auth/quick-login") && !webShellSource.includes("获取临时 Token") && webStoreSource.includes("consumeQuickLogin") && webShellSource.includes("await consumeQuickLogin()"), "Web login should consume owner-issued quick links without exposing a page or localhost token-issuance path")
  assert(!sqliteWorkerSource.includes("backupSqliteDatabase") && !sqliteWorkerSource.includes('case "backup"'), "SQLite state and log storage should not have an automatic backup path")
  assert(webAppSource.includes("app.patch(\"/api/models/:name\"") && webAppSource.includes("/api/models/:name/default") && webAppSource.includes("app.delete(\"/api/models/:name\""), "web app should expose model management API")
  assert(webAppSource.includes("app.patch(\"/api/providers/:name\"") && webAppSource.includes("app.delete(\"/api/providers/:name\"") && webAppSource.includes("/api/providers/models"), "web app should expose provider CRUD and model listing APIs")
  assert(!webAppSource.includes("/api/custom-tools/capability-template") && !webAppSource.includes("/api/skills/capability-template"), "web app should not expose retired capability mapping APIs")
  assert(webAppSource.includes("/api/custom-tools/:id/test"), "web app should expose Custom tool test API")
  assert(!webAppSource.includes("app.delete(\"/api/persona/expression/:id\""), "web app should remove the retired persona expression delete API")
  assert(webMainSource.includes("createApp") && webMainSource.includes("AppShell") && webMainSource.includes("applyTheme") && webMainSource.includes("ChatTab") && webMainSource.includes("FiltersTab") && webMainSource.includes("MemoryTab") && webMainSource.includes("LogsTab"), "web UI should bootstrap top-level Code Filter, logs, and memory management tabs alongside the assistant pages")
  assert(compiledWebMainSource.includes("./ui/components.js?v=") && compiledWebMainSource.includes("./features/providers/providers-tab.js?v="), "web entry should cache-bust nested UI modules alongside the main asset")
  assert(webShellSource.includes("toggleTheme") && webShellSource.includes("对话测试") && webShellSource.includes("模型与回复") && webShellSource.includes("account-menu") && webShellSource.includes("tip-bottom") && webShellSource.includes("unsaved-layer"), "app shell should expose task-oriented navigation, unclipped topbar tooltips, compact login management, and an unsaved-navigation dialog")
  assert(webShellSource.includes("日志与用量") && webShellSource.indexOf('{ id: "logs"') > webShellSource.indexOf('label: "管理"') && webStoreSource.includes('logs: ["config"]') && webLogsSource.includes("visibilitychange") && webLogsSource.includes("setInterval"), "logs page should live in the management navigation group with bounded five-second refresh while visible")
  assert(webStoreSource.includes("refreshTab") && webStoreSource.includes("tabSlices") && webStoreSource.includes("saveConfigPatch") && webStoreSource.includes("loadInitial") && webStoreSource.includes("Promise.allSettled") && webStoreSource.includes("setDirtyScope") && webStoreSource.includes("discardPendingNavigation"), "web store should support page-scoped loading, slice error isolation, and shared dirty-state navigation protection")
  assert(webStoreSource.includes("developerMode") && webStoreSource.includes("setDeveloperMode"), "web store should persist the local developer-mode preference")
  assert(webStoreSource.includes('providers: ["config", "providers", "tools"'), "provider editor should load the live tool catalog for model allowlist and denylist selection")
  assert(webStoreSource.includes("authenticated") && !webStoreSource.includes('localStorage.setItem("yui-chat-token"') && webShellSource.includes("HttpOnly 会话"), "web UI must keep management tokens out of browser storage and use protected sessions")
  assert(webUiSource.includes("openDrawerStack") && webUiSource.includes("layerZIndex") && webUiSource.includes("focusableElements") && webUiSource.includes("aria-labelledby") && webUiSource.includes("ConfirmDialog") && webUiSource.includes("confirm-layer") && !webUiSource.includes("window.confirm"), "shared UI should provide accessible stacked drawers and a global confirmation modal without native dialogs")
  assert(webUiSource.includes("SearchMultiSelect") && webUiSource.includes("search-multi-options") && webProvidersSource.includes("<SearchMultiSelect") && webProvidersSource.includes("toolPolicyOptions"), "model tool policies should use the shared searchable multi-select against the current tool catalog")
  assert(webCssSource.includes("grid-template-columns: 19px minmax(0, 1fr)") && webCssSource.includes(".search-multi-select > summary::marker"), "searchable model tool policy options should keep the checkbox and copy in stable columns without a duplicate native details marker")
  assert(webStoreSource.includes("confirmAction") && webStoreSource.includes("settleConfirm") && webShellSource.includes("<ConfirmDialog"), "global confirmation state should be shared by every page and mounted once in the app shell")
  assert(webUiSource.includes("SectionNav") && webUiSource.includes("section-nav-item"), "shared UI should expose task-oriented second-level navigation")
  assert(webShellSource.includes("top-diagnostic-button") && webShellSource.includes("运行诊断") && webShellSource.includes("diagnosticIssues"), "app shell should expose diagnostics from a compact top-level trigger and drawer")
  assert(webOverviewSource.includes("home-hero") && webOverviewSource.includes("home-dashboard-grid") && webOverviewSource.includes("模型排行") && webOverviewSource.includes("用途分布"), "overview should act as the primary health and usage dashboard")
  assert(webOverviewSource.includes("home-setup-strip") && webOverviewSource.indexOf("home-setup-strip") < webOverviewSource.indexOf("<MetricGrid") && webOverviewSource.includes("继续配置") && !webOverviewSource.includes('v-if="homeStatus !== \'good\'"') && !webOverviewSource.includes("能力架构") && !webOverviewSource.includes("快速操作"), "overview should keep one setup action inside the top status area and remove architecture and quick-operation panels")
  assert(webLogsSource.includes("logs-summary-row") && webLogsSource.includes("logs-filter-row") && webLogsSource.includes("settingsDrawerOpen") && webLogsSource.includes("群聊记忆提炼") && webLogsSource.includes("查看本次提炼输入") && !webLogsSource.includes("filterDrawerOpen") && !webLogsSource.includes('<h1>日志与用量</h1>') && !webLogsSource.includes('<Panel title="模型排行"') && !webLogsSource.includes('<Panel title="Token 趋势"'), "logs page should keep only compact summary metrics with settings, use one-line filters above the run list, and avoid duplicating the shell heading")
  assert(webLogsSource.includes("logs-session-workbench") && webLogsSource.includes("loadConversationTurn") && webLogsSource.includes("toolGroupsForModel") && webLogsSource.includes("LogContextView") && webLogsSource.includes("modelDetail.snapshot") && webLogsSource.includes("loadExtractionResult") && webLogsSource.includes("logs-extraction-result") && webLogsSource.includes("提炼结果") && webLogsSource.includes("rawRequests") && webLogsSource.includes("setDeveloperMode") && webLogsSource.includes("toggleDeveloperMode") && webLogsSource.includes("logs-developer-panel") && webLogsSource.includes("protocolShortLabel") && webLogsSource.includes("streamLabel") && webLogsSource.includes("sessionId") && webLogsSource.includes("logs-inline-message"), "logs page should provide a session workbench with lazy turn details, grouped tool rounds, protocol/stream/session metadata, visible developer diagnostics, and compact failure messages")
  assert(webAdvancedSource.includes("captureScheduleMode") && webAdvancedSource.includes("captureScheduleTime") && webAdvancedSource.includes("captureScheduleCron") && webAdvancedSource.includes("Cron（分 时 日 月 周）"), "advanced memory settings should expose friendly fixed-time and Cron scheduling controls")
  assert(webLogsSource.includes("运行失败诊断详情"), "logs page should expose run-level failure diagnostics in developer mode")
  assert(webLogsSource.includes("row.error_message"), "logs page should show failure messages in the run list")
  assert(webOverviewSource.includes("wizard-inline-config") && webOverviewSource.includes("saveProviderAndTest") && webOverviewSource.includes("saveRouting") && webOverviewSource.includes("savePersona") && webOverviewSource.includes("saveTools") && webOverviewSource.includes("saveKnowledge") && webOverviewSource.includes("saveOutput") && webOverviewSource.includes("sendWizardTest"), "overview setup guide should configure the common path and run the final chat test without leaving the drawer")
  assert(!webPersonaSource.includes("/api/persona/expression") && !webPersonaSource.includes("deleteExpression") && !webPersonaSource.includes("learnAssistant") && !webPersonaSource.includes("expressionExamples"), "persona page should remove expression learning controls")
  assert(webPersonaSource.includes("previewGreeting") && webPersonaSource.includes("initiativeGreetingScheduled"), "persona page should expose initiative greeting controls")
  assert(webPersonaSource.includes("sticky-save-bar") && webPersonaSource.includes("setDirtyScope") && webPersonaSource.includes("放弃") && !webPersonaSource.includes("requestDeleteExpression") && !webPersonaSource.includes("window.confirm"), "persona page should expose draft protection without retired expression deletion flows")
  assert(!webPersonaSource.includes("persona-preview\"") && !webPersonaSource.includes("previewScenario"), "persona page should not re-introduce the mocked side preview")
  assert(webPersonaSource.includes('variant="tabs"') && webPersonaSource.includes("sectionItems") && webPersonaSource.includes("activeSection") && ["基础人格", "互动与输出", "戳一戳"].every(label => webPersonaSource.includes(label)), "persona page should expose three in-page sections through compact secondary tabs")
  assert(webPersonaSource.includes("interactionMenu") && webPersonaSource.includes("triggerMenu") && webPersonaSource.includes("replyMenu") && webPersonaSource.includes("persona-interaction-rail") && ["触发设置", "回复设置", "主动", "被动", "艾特", "指令", "默认方式", "文本", "图片", "语音", "上下文"].every(label => webPersonaSource.includes(label)) && !webPersonaSource.includes('{ value: "access"'), "persona interaction page should use grouped trigger and reply navigation")
  assert(!webPersonaSource.includes("<SideDrawer") && !webPersonaSource.includes("drawers.") && !webPersonaSource.includes("互动记录") && !webPersonaSource.includes("persona-preview-chat") && !webPersonaSource.includes("hint-banner"), "persona page should switch sections in place without drawers, activity summaries, mocked poke previews, or recommendation banners")
  assert(["文本回复", "语音回复", "图片回复"].every(label => webPersonaSource.includes(label)) && webPersonaSource.includes("response-mode-picker") && webPersonaSource.includes("response-mode-picker compact"), "persona page should keep a compact default output selector")
  assert(webPersonaSource.indexOf('<Icon name="message" :size="14" />文本输出') < webPersonaSource.indexOf("segmentation-settings") && webPersonaSource.indexOf("segmentation-settings") < webPersonaSource.indexOf('<Icon name="activity" :size="14" />语音输出') && (webPersonaSource.match(/segmentation-settings/g) || []).length === 1 && webPersonaSource.includes("高级分段规则") && !webPersonaSource.includes("第一人称兼容分段"), "only the text output section should contain the collapsed segmentation strategy")
  assert(webPersonaSource.includes("伪人参与") && webPersonaSource.includes("personaAmbientProbability") && webPersonaSource.includes("persona.trigger.ambient.probabilityPercent"), "persona page should expose independent probabilistic ambient participation")
  assert(webPersonaSource.includes("context.recentMessageCount") && webPersonaSource.includes("最近消息条数") && !webPersonaSource.includes("contextEnabled") && !webPersonaSource.includes("contextInjectRecent") && !webPersonaSource.includes("contextMaxMessages") && !webPersonaSource.includes("contextInjectLimit"), "persona page should expose one recent-message count for both capture and injection")
  assert(webPersonaSource.includes("<Collapse") && webPersonaSource.includes("高级分段规则") && webPersonaSource.includes("启用文本分段") && !webPersonaSource.includes("segmentationLlmOnly") && !webPersonaSource.includes("仅对 LLM 结果分段") && !webPersonaSource.includes(':options="BOOL') && webPersonaSource.includes("settings-toggle-grid") && webPersonaSource.includes("<Switch"), "persona page should keep one text segmentation switch and hide the fixed LLM-only implementation detail")
  assert((webPersonaSource.match(/<Field label="角色设定"/g) || []).length === 1 && webPersonaSource.includes("persona.characterPrompt") && webPersonaSource.includes("persona.runtimePrompt") && webPersonaSource.includes("系统运行规则") && webPersonaSource.includes("重置为默认值") && webPersonaSource.includes("resetRuntimePrompt") && webPersonaSource.includes("最终提示词预览") && !webPersonaSource.includes("persona.systemPrompt") && !webPersonaSource.includes("drawers.prompts") && !webPersonaSource.includes("title=\"人设背景\"") && !webPersonaSource.includes("personaToolOrchestrationPrompt") && !webPersonaSource.includes("groupContextPrompt") && !webPersonaSource.includes("commandGuidePrompt") && !webPersonaSource.includes("emptyReplyInstruction"), "基础人格入口应分离可编辑角色设定、可恢复默认的运行规则和最终预览")
  assert(webShellSource.includes('description: "称呼、触发与回复"') && !webShellSource.includes("设置助手称呼、说话方式、触发条件和回复形式"), "persona page title should stay concise")
  assert(!webPersonaSource.includes("MessageFiltersPanel") && !webPersonaSource.includes("消息过滤器"), "persona page should no longer host the Code Filter workspace")
  assert(webShellSource.includes('{ id: "filters", label: "代码过滤器"') && webStoreSource.includes('"filters"') && webStoreSource.includes('filters: ["filters", "config"]'), "Code Filters should be a top-level sidebar tab with its own data slice")
  assert(!webShellSource.includes("不占用模型上下文"), "filter page title should avoid repeating implementation details")
  assert(webFiltersSource.includes("MessageFiltersPanel") && webFiltersSource.includes("CustomFiltersPanel") && webFiltersSource.includes("规则链") && webFiltersSource.includes("代码实现"), "Code Filter page should separate ordered rules from Custom code implementations")
  assert(!webMessageFiltersSource.includes("不占用模型上下文") && (webMessageFiltersSource.match(/@click="createFilter"><Icon name="plus" :size="14" \/>新建规则/g) || []).length === 1, "filter overview should omit redundant context copy and expose one primary new-rule entry")
  assert(!webFiltersSource.includes("代码过滤器与 AI Tool 分开管理") && !webFiltersSource.includes("这里的代码只在过滤链中运行") && !webFiltersSource.includes("metric-grid compact") && !webCustomFiltersSource.includes('<template #actions><button class="btn primary" type="button" @click="createFilter()">'), "filter implementation list should omit redundant introduction, aggregate metrics, and duplicate primary creation entry")
  assert(webFiltersSource.includes("浏览项目文件") && webFiltersSource.includes("generateWithProjectAi") && webFiltersSource.includes("草稿待确认"), "Custom Filter builder should expose project resource browsing and review-before-apply AI code drafts")
  assert(webMessageFiltersSource.includes("editor.priority") && webMessageFiltersSource.includes("数字越小越先执行") && webMessageFiltersSource.includes("/api/message-filters"), "message-filter UI should explain and use priority ordering through canonical APIs")
  assert(webMessageFiltersSource.includes('draggable="true"') && webMessageFiltersSource.includes("dropOnFilter") && webMessageFiltersSource.includes("filterGroups"), "message-filter UI should group stages and support drag ordering")
  assert(webMessageFiltersSource.includes("选择已有实现") && webMessageFiltersSource.includes("编写自定义代码") && webMessageFiltersSource.includes("代码过滤器"), "message-filter UI should expose native and Custom code implementation paths")
  assert(!webToolsSource.includes("yui-chat-extension-intent") && !webToolsSource.includes("consumeMessageFilterExtensionIntent") && !webToolsSource.includes("pipelineStage"), "AI capability workspace should not own filter creation or pipeline stages")
  assert(webKnowledgeSource.includes("qualityMetrics") && webKnowledgeSource.includes("weakCommands") && webKnowledgeSource.includes("knowledge-value-card"), "knowledge page should explain user value and expose the command knowledge quality view")
  assert(!webKnowledgeSource.includes("knowledgeViewOptions") && !webKnowledgeSource.includes("knowledge-viewbar") && !webKnowledgeSource.includes("activeSection") && !webKnowledgeSource.includes("knowledgeSectionItems"), "knowledge page should render the knowledge base workspace directly without a redundant module selector")
  assert(webKnowledgeSource.includes("saveManual") && webKnowledgeSource.includes("requestDeleteCommand") && webKnowledgeSource.includes("confirmAction"), "knowledge page should use modal confirmations for command deletion")
  assert(webKnowledgeSource.includes("showExclusionDrawer") && webKnowledgeSource.includes("knowledge-pane-switch") && webKnowledgeSource.includes("activeBasePane"), "knowledge page should expose retrieval exclusions and compact current-base actions")
  assert(webKnowledgeSource.includes("showCommandMaintenanceDrawer") && webKnowledgeSource.includes("openCommandMaintenance") && webKnowledgeSource.includes("builtin-commands") && webKnowledgeSource.includes("维护内置指令知识库"), "built-in command knowledge base should expose one card-level maintenance entry")
  assert(webKnowledgeSource.includes("documentOrigin") && webKnowledgeSource.includes("knowledge-command-origin-inline") && webKnowledgeSource.includes("knowledge-command-preview") && webKnowledgeSource.includes("openBuiltinCommandEditor") && webKnowledgeSource.includes("manualSourceCommandId") && webKnowledgeSource.includes("插件") && webKnowledgeSource.includes("文件") && webKnowledgeSource.includes("方法"), "built-in command documents should compactly show their source and open an editable persistent override")
  assert(webKnowledgeSource.includes("maintenancePaneItems") && webKnowledgeSource.includes("采集概览") && webKnowledgeSource.includes("收录示例") && webKnowledgeSource.includes("收录质量"), "built-in command maintenance should group command, capture, example, and quality workflows")
  assert(webShellSource.includes('{ id: "memory", label: "记忆管理"') && webStoreSource.includes('memory: ["config", "memory", "diagnostics"]'), "memory management should be a dedicated sidebar page with its own data slice")
  assert(webMemorySource.includes("group-picker") && webMemorySource.includes("群公共记忆") && webMemorySource.includes("本群记忆") && webMemorySource.includes("全局记忆") && webMemorySource.includes("原始消息（") && webMemorySource.includes("补录历史") && webMemorySource.includes("提炼运行记录") && webMemorySource.includes("扫描昨日及历史") && webMemorySource.includes("等待处理") && webMemorySource.includes("实际模型调用") && webMemorySource.includes("Token 子窗口") && webMemorySource.includes("按日提炼") && webMemorySource.includes("reextractSingleDay") && webMemorySource.includes("runRecordWindows") && webMemorySource.includes("提炼结果（") && webMemorySource.includes("/windows/") && webMemorySource.includes("runExtractionWindow") && webMemorySource.includes("extractionWindowAction") && webMemorySource.includes("立即执行") && webMemorySource.includes("失败重试") && webMemorySource.includes("/api/memory/groups/") && webMemorySource.includes("captureMessageOrder") && webMemorySource.includes("changeCaptureMessageOrder") && webMemorySource.includes("jumpCaptureMessagePage") && webMemorySource.includes("最早在前") && webMemorySource.includes("最新在前"), "memory page should separate source-message backfill from daily extraction runs while exposing token workload, manual execution, failed-day retry, input coverage, message ordering, and page jumps")
  assert(
    webMemorySource.includes("windowSelectionMode")
      && webMemorySource.includes("selectedWindowStarts")
      && webMemorySource.includes("confirmSelectedWindows")
      && webMemorySource.includes("选择需重提炼")
      && webMemorySource.includes("提炼选中窗口"),
    "memory page should share one multi-select workflow between the daily timeline and paginated extraction runs",
  )
  assert(
    webMemorySource.includes("calendarWeeks")
      && webMemorySource.includes("/calendar")
      && ["已形成记忆", "已提炼无结果", "尚未提炼", "处理失败", "无消息"].every(label => webMemorySource.includes(label)),
    "memory page should render the five-state daily extraction calendar from its lightweight summary API",
  )
  assert(!webMemorySource.includes("补录并保存原始记录") && !webMemorySource.includes("goToExtractionMessages") && webMemorySource.indexOf("补录历史") > webMemorySource.indexOf("extractionPane === 'messages'") && webMemorySource.indexOf("扫描昨日及历史") > webMemorySource.indexOf("提炼运行记录") && webMemorySource.includes("captureDraft.useDefault") && webMemorySource.includes("captureDefaultLabel") && webMemorySource.includes("updateCaptureField") && webMemorySource.includes("恢复系统默认") && webMemorySource.includes("设置全局默认值") && webMemorySource.includes("capture-enable-control") && !webMemorySource.includes(':disabled="captureDraft.useDefault'), "capture settings should show per-field inheritance, allow direct edits to create an override, link deliberately to global defaults, combine the capture description with its switch, and provide a one-click default reset while operational actions live in their respective extraction panes")
  assert(webMemorySource.includes("memory-summary-row") && webMemorySource.includes("memoryLifecycle") && webMemorySource.includes("resultAction") && webMemorySource.includes("taskResultSummary") && webMemorySource.includes("extractionResultLabel") && webMemorySource.includes("reviewDuplicateMemories") && webMemorySource.includes("openMemoryEditor") && webMemorySource.includes("confirmAction") && webMemorySource.includes("编辑用户画像") && webMemorySource.includes("删除这条记忆"), "memory page should truncate long list entries, show lifecycle and extraction actions, identify the target member for personal extraction results, review duplicates, open them for editing, retain profile editing, and confirm deletion")
  assert(webChatSource.includes("/api/chat/test/sessions") && webChatSource.includes("历史对话") && webChatSource.includes("删除这段测试对话") && !webChatSource.includes("persistMessages"), "chat page should use SQLite-backed test history without browser-local transcripts")
  assert(webAdvancedSource.includes("开发者模式") && webAdvancedSource.includes("developer-gate") && webAdvancedSource.includes("SystemRenderStrategyPanel") && webAdvancedSource.includes("confirmAction") && webAdvancedSource.includes("确认回滚") && !webAdvancedSource.includes("window.confirm"), "system page should expose hot-updatable system rendering strategy and gate advanced configuration")
  assert(webAdvancedSource.includes("backupMaxFiles") && webAdvancedSource.includes("backupMaxAgeDays") && webAdvancedSource.includes("saveBackupPolicy") && webAdvancedSource.includes("同时超过保留天数") && webAdvancedSource.includes("SQLite 中的能力权限") && webAdvancedSource.includes("运行日志、用量流水") && webAdvancedSource.includes("configBackupDir") && webAdvancedSource.includes("backupContents"), "system backup page should explain the package directory, contents, SQLite whitelist, and excluded detail data")
  assert(webAdvancedSource.includes("saveDeveloperSettings") && webAdvancedSource.includes("memoryEmbeddingTokensPerDay") && webAdvancedSource.includes("knowledgeEmbeddingTokensPerDay") && webAdvancedSource.includes("systemRenderPanel"), "system page should save developer budgets and rendering settings together")
  assert(webAdvancedSource.includes("capturePromptTokenBudget") && webAdvancedSource.includes("captureEmbeddingModel") && webAdvancedSource.includes("captureAdaptiveVector") && webAdvancedSource.includes("记忆提示 Token 预算") && webAdvancedSource.includes("记忆向量模型"), "group-memory defaults should expose prompt budget, vector model, and adaptive vector recall")
  assert(webLogsSource.includes("统一使用 CNY") && !webLogsSource.includes("USD") && webProvidersSource.includes("输入价格 / 1M（CNY）"), "usage and model pricing UI should expose CNY as the only currency")
  assert(webProvidersSource.includes("setDefault") && webProvidersSource.includes("removeModel") && webProvidersSource.includes("ModelEditor"), "providers page should expose model management actions")
  assert(webProvidersSource.includes("ProviderEditor") && webProvidersSource.includes("removeSelectedProvider") && webProvidersSource.includes("provider-source-actions"), "providers page should expose compact provider actions inside provider cards")
  assert(webProvidersSource.includes("provider-page-toolbar") && webProvidersSource.includes("provider-routing-compact") && webProvidersSource.includes("全局设置") && webProvidersSource.includes("requestRemoveProvider") && webProvidersSource.includes("requestRemoveModel") && webProvidersSource.includes("确认切换默认模型") && webProvidersSource.includes("confirmAction") && !webProvidersSource.includes("window.confirm"), "providers page should keep a compact service toolbar and modal confirmations for destructive and default-routing changes")
  assert(webProvidersSource.includes("routing-model-picker") && webProvidersSource.includes("makePrimaryModel") && webProvidersSource.includes("replyerStrategyLabel"), "reply routing should use an explicit primary and fallback model card picker")
  assert(webProvidersSource.includes("modelRequestTimeoutMs") && webProvidersSource.includes("全局请求超时") && webProvidersSource.includes("流式响应") && webProvidersSource.includes("继承全局设置"), "providers page should expose global and per-model transport settings")
  assert(!webProvidersSource.includes("providerSectionItems") && !webProvidersSource.includes("activeSection") && webProvidersSource.includes("activeProviderPane") && webProvidersSource.includes("provider-pane-tabs") && webProvidersSource.includes("查看路由详情"), "providers page should keep one compact service workspace with model and import tabs")
  assert(webProvidersSource.includes("showImportDrawer") && webProvidersSource.includes("provider-import-drawer") && webProvidersSource.includes("selectProviderPane") && webProvidersSource.includes("model-selection-summary") && webProvidersSource.includes("remoteExistingCount") && webProvidersSource.includes("选择可导入项"), "provider model import should open in a side drawer and distinguish existing models from selectable new models")
  assert(webProvidersSource.includes("is-default") && webProvidersSource.includes("has-default") && webProvidersSource.includes("当前主回复模型"), "default models and their providers should expose consistent special states")
  assert(!/\.persona-preview\s*\{/s.test(webCssSource) && !/\.persona-scenarios\s*\{/s.test(webCssSource) && !webCssSource.includes(".persona-preview-chat") && !webCssSource.includes(".persona-preview-message"), "persona preview styles should be removed together with the preview section")
  assert(webProvidersSource.includes("v-if=\"store.developerMode\"") && webProvidersSource.includes("SubAgentConfig"), "experimental sub-agent controls should stay behind developer mode")
  assert(webProvidersSource.includes("fetchModels") && webProvidersSource.includes("/api/providers/models"), "providers page should support fetching model lists from a provider")
  assert(webProvidersSource.includes("embeddingCapability") && webProvidersSource.includes("向量模型参数") && webProvidersSource.includes("套用 BGE-M3 预设") && webProvidersSource.includes("provider-console-compact"), "providers page should expose compact unified embedding model setup")
  assert(webKnowledgeSource.includes("knowledge-index-progress-card") && webKnowledgeSource.includes("jobProgress") && webKnowledgeSource.includes("setInterval(() => refreshIndexJobsOnly"), "knowledge page should display and poll vector index progress")
  assert(webProvidersSource.includes("推理 / 思考强度") && webProvidersSource.includes("reasoningEffort"), "providers page should expose unified reasoning controls")
  assert(
    webToolsSource.includes("toggleTool")
      && webToolsSource.includes("capability-category-select")
      && webToolsSource.includes("capability-mode-tabs")
      && webToolsSource.includes("selectedTag")
      && webToolsSource.includes("clearTag")
      && webToolsSource.includes("permission-role-grid")
      && webToolsSource.includes("previewBlockedRows")
      && webToolsSource.includes("新增扩展")
      && webToolsSource.includes("配置角色权限")
      && webToolsSource.includes("验证此角色")
      && webToolsSource.includes("capability-tool-table")
      && webToolsSource.includes("capability-row-actions")
      && webToolsSource.includes("openToolDetail(tool, 'config')")
      && webToolsSource.includes("hasWebConfig(tool)")
      && webToolsSource.includes("tool.name === 'render_image'")
      && webToolsSource.includes("toolRepeatabilityLabel, toolHasRepeatProtection")
      && webToolsSource.includes("ToolDetailModal")
      && webToolsSource.includes("ToolConfigurationPanel")
      && webToolsSource.includes("tool-channel-list")
      && webToolsSource.includes(':draggable="!channel.fixed"')
      && webToolsSource.includes("defaultSource`] = enabledSources[0] ||")
      && webToolsSource.includes("openai:web_search")
      && webToolsSource.includes("openai:tool_search")
      && webToolsSource.includes("local:tool_search")
      && webToolsSource.includes('["image_media", "web_search", "tool_search"].includes(toolDetail.name)')
      && webToolsSource.includes("启用并保存即可使用")
      && webToolsSource.includes("capability-global-settings")
      && webToolsSource.includes("globalToolsEnabled")
      && !webToolsSource.includes('value: "global"')
      && webToolsSource.includes("riskBadgeClass, riskLabel")
      && webToolsSource.includes("toolAccessOverride")
      && webToolsSource.includes("单独禁止")
      && webToolsSource.includes("新建 Markdown Skill")
      && webToolsSource.includes("extensionLibraryRows")
      && webToolsSource.includes("先选择扩展形态")
      && webToolsSource.includes("framework.use")
      && webToolsSource.includes("运行测试")
      && webToolsSource.includes("新增 MCP")
      && webToolsSource.includes("SideDrawer"),
    "tools page should unify scenario tags, the searchable tool list, configuration actions, and readable permission previews"
  )
  assert(
    webMcpSource.includes("toggleGlobal")
      && webMcpSource.includes("openCreate")
      && webMcpSource.includes("快速创建")
      && webMcpSource.includes("JSON 导入")
      && webMcpSource.includes("importedServerConfig")
      && webMcpSource.includes("mcp-panel-actions")
      && webMcpSource.includes("mcp-server-actions")
      && webMcpSource.includes("streamableHttp")
      && webMcpSource.includes("服务器发送事件 (sse)")
      && webMcpSource.includes("可流式传输的 HTTP (streamableHttp)")
      && !webMcpSource.includes("环境变量 JSON")
      && !webMcpSource.includes("环境变量必须是 JSON 对象")
      && !webMcpSource.includes("showDrawer")
      && !webMcpSource.includes("draft.createId")
      && !webMcpSource.includes("MCP 服务管理"),
    "MCP should put the global switch beside the create action, expose all three transports, use line-based environment variables, and keep one direct quick-create/JSON-import editor with row-level enable and edit controls",
  )
  assert(
    webToolsSource.includes("当前自定义扩展")
      && webToolsSource.includes("extension-tool-table")
      && webToolsSource.includes("ExtensionCreateDrawer")
      && webToolsSource.includes("新建扩展")
      && webToolsSource.includes("导入 Skill")
      && webToolsSource.includes("重新扫描")
      && !webToolsSource.includes("可选：从能力建议生成草稿"),
    "extension workspace should place horizontal create/import actions above a compact installed-extension list",
  )
  assert(
    webExtensionPanelSource.includes("dryRun: true")
      && webExtensionPanelSource.includes('editor.mode === "create"')
      && webExtensionPanelSource.includes("editor.mode !== 'create'")
      && !webExtensionPanelSource.includes('<Field label="扩展 ID"')
      && !webExtensionPanelSource.includes('<Field label="目录 ID"'),
    "creating an extension should edit a local draft and only write it on save, without asking for a directory ID",
  )
  assert(!webExtensionPanelSource.includes("内置工具") && !webExtensionPanelSource.includes("已加载工具总览"), "custom extensions and built-in tools should remain in separate management views")
  assert(!webExtensionPanelSource.includes("open-external") && !webExtensionCreateSource.includes("MCP"), "extension creation should not duplicate or link to MCP resources managed on the MCP page")
  assert(webToolsSource.includes("hasRuntimeConfig(tool)") && webToolsSource.includes("yui-chat:open-tool-detail") && webToolsSource.includes("saveConfiguration") && webToolsSource.includes("保存配置"), "tools with runtime variables and multi-channel sources should expose a fixed modal-footer save action")
  assert(webToolsSource.includes("confirmAction") && webToolsSource.includes("确认永久删除") && webToolsSource.includes("确认停用") && !webToolsSource.includes("window.confirm"), "tools page destructive and disabling actions should use the shared confirmation modal")
  assert(
    webToolsSource.includes('store.activeTab === "tool-permissions"')
      && webToolsSource.includes("内置能力")
      && webToolsSource.includes("扩展能力")
      && webToolsSource.includes("MCP 服务")
      && webToolsSource.includes("图片渲染")
      && !webToolsSource.includes("统一使用权限")
      && !webToolsSource.includes("验证当前权限")
      && !webToolsSource.includes('value: "external", label: "外部服务"'),
    "capability center should use one unified ability workspace plus one permission workspace instead of mixing sources and permissions at the top level",
  )
  assert(webToolsSource.includes('toolSource(tool) === "builtin"') && webToolsSource.includes('toolSource(tool) === "custom"'), "built-in tools and Custom extensions should use separate list and editing workspaces")
  assert(!webToolsSource.includes("不执行旧式") && !webToolsSource.includes("旧格式"), "tools page should describe only the current extension model")
  assert(webAdvancedSource.includes("systemSectionItems") && webAdvancedSource.includes("运行与登录") && webAdvancedSource.includes("备份与恢复") && webAdvancedSource.includes("群记忆默认") && webAdvancedSource.includes("saveCaptureDefaults") && webAdvancedSource.includes("开发者设置"), "system page should combine runtime status and Web login while separating backups, group-memory defaults, and developer settings")
  assert(webPersonaSource.includes("activeSection === 'advanced'") && webPersonaSource.includes("activeSection === 'basic'") && webPersonaSource.includes("greetingPreviewResult") && webPersonaSource.includes("previewGreeting") && webPersonaSource.includes("personaCharacterPrompt"), "persona page should keep interaction tests and the editable character setting in their in-page sections")
  assert(webToolsSource.includes("新增扩展") && webToolsSource.includes("新增 MCP") && webAdvancedSource.includes("applyDiagnosticAction"), "capability and diagnostics pages should expose concise creation actions and safe repair actions")
  assert(webCssSource.includes(".section-nav") && webCssSource.includes(".section-stage") && webCssSource.includes(".section-entry-grid") && webCssSource.includes(".capability-category-select"), "web styles should support category filtering and the unified capability workspace")
  const { configStore } = await import("../output/runtime/config/store.js")
  const original = await configStore.load()
  const webTestAuthToken = `smoke-web-${Date.now()}-token`
  const webTestConfig = JSON.parse(JSON.stringify(original))
  webTestConfig.web.authToken = webTestAuthToken
  await configStore.save(webTestConfig)
  const originalWebBot = global.Bot
  const { createServer } = await import("node:http")
  const express = (await import("express")).default
  const apiTestApp = express()
  apiTestApp.use(app)
  const apiServer = createServer(apiTestApp)
  await new Promise((resolve, reject) => {
    apiServer.once("error", reject)
    apiServer.listen(0, "127.0.0.1", resolve)
  })
  try {
    global.Bot = {
      ...originalWebBot,
      pickGroup: async groupId => String(groupId) === "web-memory-group" ? {
        getChatHistory: async (_sequence, limit) => [{
          message_id: "web-history-1",
          user_id: "web-history-user",
          time: Date.now() - 60000,
          sender: { user_id: "web-history-user", nickname: "网页历史用户", role: "member" },
          message: [{ type: "text", data: { text: "网页接口补录的原始聊天记录" } }],
        }].slice(0, limit),
      } : null,
    }
    const port = apiServer.address().port
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "yui-chat-token": webTestAuthToken },
      body: "{}",
    })
    const sessionPayload = await sessionResponse.json()
    const setCookie = sessionResponse.headers.get("set-cookie") || ""
    assert(sessionResponse.ok && sessionPayload.result?.expiresAt && !sessionPayload.result?.token, "Web token exchange should return session metadata without exposing the access token to JS")
    assert(setCookie.includes("yui_chat_session=") && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), "Web session cookie should be HttpOnly and SameSite Strict")
    const cookie = setCookie.split(";")[0]
    const cookieConfigResponse = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { cookie } })
    assert(cookieConfigResponse.ok, "HttpOnly Web session should authorize protected APIs")
    const webTestSessionId = "smoke-web-history"
    const webTestCreateResponse = await fetch(`http://127.0.0.1:${port}/api/chat/test`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ prompt: "请确认 SQLite 测试历史已开启。", sessionId: webTestSessionId }),
    })
    const webTestCreatePayload = await webTestCreateResponse.json()
    assert(webTestCreateResponse.ok && webTestCreatePayload.session?.messageCount === 2, "web chat tests should persist their complete transcript to SQLite")
    const webTestHistoryResponse = await fetch(`http://127.0.0.1:${port}/api/chat/test/sessions`, { headers: { cookie } })
    const webTestHistoryPayload = await webTestHistoryResponse.json()
    const webTestSession = webTestHistoryPayload.sessions?.find(item => item.sessionId === webTestSessionId)
    assert(webTestHistoryResponse.ok && webTestSession?.messages?.length === 2, "web chat history API should read persisted SQLite transcripts")
    const webTestDeleteResponse = await fetch(`http://127.0.0.1:${port}/api/chat/test/sessions/${encodeURIComponent(webTestSession.key)}`, { method: "DELETE", headers: { cookie } })
    const webTestDeletePayload = await webTestDeleteResponse.json()
    assert(webTestDeleteResponse.ok && webTestDeletePayload.cleared === 1, "web chat history API should delete one persisted SQLite transcript")
    const memoryGroupId = "web-memory-group"
    const memoryUserId = "web-memory-user"
    const captureConfigResponse = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ patch: {
        "memory.groupCapture.defaultRetentionDays": 30,
        "memory.groupCapture.defaultTokenLimit": 3000,
        "memory.groupCapture.promptTemplate": "自定义群记忆提示词",
        "memory.groupCapture.consolidation.modelName": "mock",
      } }),
    })
    const captureConfigPayload = await captureConfigResponse.json()
    assert(captureConfigResponse.ok && captureConfigPayload.config?.memory?.groupCapture?.defaultTokenLimit === 3000 && captureConfigPayload.config?.memory?.groupCapture?.consolidation?.modelName === "mock", "memory capture's shared retention, Token, prompt, and model settings should save through the global configuration API")
    const capturePolicyResponse = await fetch(`http://127.0.0.1:${port}/api/memory/captures/group/${memoryGroupId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      // 只有 overrides 显式开启的字段才会形成单群覆盖。
      body: JSON.stringify({ enabled: true, retentionDays: 1, tokenLimit: 17, promptTemplate: "忽略的旧字段", modelName: "ignored" }),
    })
    const capturePolicyPayload = await capturePolicyResponse.json()
    assert(capturePolicyResponse.ok && capturePolicyPayload.policy?.scopeId === memoryGroupId && capturePolicyPayload.policy?.enabled === true && capturePolicyPayload.policy?.tokenLimit === 3000 && capturePolicyPayload.policy?.promptTemplate === "自定义群记忆提示词" && capturePolicyPayload.policy?.modelName === "mock" && !Object.values(capturePolicyPayload.policy?.overrides || {}).some(Boolean), "new capture policies should inherit global defaults until an override is explicitly enabled")
    const captureOverrideResponse = await fetch(`http://127.0.0.1:${port}/api/memory/captures/group/${memoryGroupId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        enabled: true,
        overrides: { retentionDays: true, tokenLimit: true, promptTemplate: true, modelName: true, maxTokens: true, minConfidence: true, retrievalResultLimit: true },
        retentionDays: 1, tokenLimit: 1300, promptTemplate: "仅用于 Web 测试群", modelName: "mock", maxTokens: 2048, minConfidence: 0.8, retrievalResultLimit: 2,
      }),
    })
    const captureOverridePayload = await captureOverrideResponse.json()
    assert(captureOverrideResponse.ok && captureOverridePayload.policy?.retentionDays === 1 && captureOverridePayload.policy?.tokenLimit === 3000 && captureOverridePayload.policy?.promptTemplate === "仅用于 Web 测试群" && captureOverridePayload.policy?.modelName === "mock" && captureOverridePayload.policy?.maxTokens === 2048 && captureOverridePayload.policy?.minConfidence === 0.8 && captureOverridePayload.policy?.retrievalResultLimit === 2 && Object.values(captureOverridePayload.policy?.overrides || {}).every(Boolean), "memory capture policy API should persist explicit per-group overrides and report effective values")
    const historyBackfillResponse = await fetch(`http://127.0.0.1:${port}/api/memory/captures/group/${memoryGroupId}/history`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ limit: 20 }),
    })
    const historyBackfillPayload = await historyBackfillResponse.json()
    assert(historyBackfillResponse.ok && historyBackfillPayload.result?.saved === 1, "memory capture API should save a capped batch from the host group history interface")
    const rawMessagesResponse = await fetch(`http://127.0.0.1:${port}/api/memory/captures/group/${memoryGroupId}/messages?q=${encodeURIComponent("补录")}&page=1&pageSize=20`, { headers: { cookie } })
    const rawMessagesPayload = await rawMessagesResponse.json()
    assert(rawMessagesResponse.ok && rawMessagesPayload.messages?.total === 1 && rawMessagesPayload.messages?.items?.[0]?.text.includes("原始聊天记录"), "memory capture API should expose searchable paginated raw records separately from memories")
    assert(rawMessagesPayload.messages?.items?.[0]?.normalization?.label && rawMessagesPayload.messages?.items?.[0]?.segmentCounts?.text === 1, "raw message API should expose normalized segment observability")
    const rawMessagesAscendingResponse = await fetch(`http://127.0.0.1:${port}/api/memory/captures/group/${memoryGroupId}/messages?q=${encodeURIComponent("补录")}&page=1&pageSize=20&order=asc`, { headers: { cookie } })
    const rawMessagesAscendingPayload = await rawMessagesAscendingResponse.json()
    assert(rawMessagesAscendingResponse.ok && rawMessagesAscendingPayload.messages?.order === "asc" && rawMessagesAscendingPayload.messages?.items?.[0]?.messageId === rawMessagesPayload.messages?.items?.[0]?.messageId, "memory capture API should expose explicit oldest-first ordering")
    const localCalendarDay = (value = Date.now()) => {
      const date = new Date(value)
      const pad = number => String(number).padStart(2, "0")
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }
    const calendarFrom = new Date()
    calendarFrom.setHours(0, 0, 0, 0)
    calendarFrom.setDate(calendarFrom.getDate() - 2)
    const calendarTo = new Date()
    calendarTo.setHours(0, 0, 0, 0)
    const calendarResponse = await fetch(`http://127.0.0.1:${port}/api/memory/captures/group/${memoryGroupId}/calendar?fromDay=${localCalendarDay(calendarFrom)}&toDay=${localCalendarDay(calendarTo)}`, { headers: { cookie } })
    const calendarPayload = await calendarResponse.json()
    const todayCalendarItem = calendarPayload.calendar?.items?.find(item => item.day === localCalendarDay(calendarTo))
    assert(
      calendarResponse.ok
        && calendarPayload.calendar?.items?.length === 3
        && todayCalendarItem?.status === "unprocessed"
        && todayCalendarItem?.messageCount === 1
        && todayCalendarItem?.rawAvailable === true,
      "memory capture calendar API should return an inclusive daily summary with unprocessed raw-message days",
    )
    const reextractPreviewResponse = await fetch(`http://127.0.0.1:${port}/api/memory/captures/group/${memoryGroupId}/reextract-preview?startAt=${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())}`, { headers: { cookie } })
    const reextractPreviewPayload = await reextractPreviewResponse.json()
    assert(reextractPreviewResponse.ok && reextractPreviewPayload.plan?.dayCount >= 1 && reextractPreviewPayload.plan?.windowCount >= 1 && reextractPreviewPayload.plan?.selectedMessageCount === 1, "memory capture API should preview custom-range daily extraction coverage before queueing work")
    const reextractResponse = await fetch(`http://127.0.0.1:${port}/api/memory/captures/group/${memoryGroupId}/reextract`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ startAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }),
    })
    const reextractPayload = await reextractResponse.json()
    assert(reextractResponse.ok && reextractPayload.result?.dayCount >= 1 && Array.isArray(reextractPayload.windows), "memory capture API should create custom-range daily re-extraction tasks and return observable windows")
    const windowPageResponse = await fetch(`http://127.0.0.1:${port}/api/memory/captures/group/${memoryGroupId}/windows?page=1&pageSize=1`, { headers: { cookie } })
    const windowPagePayload = await windowPageResponse.json()
    assert(
      windowPageResponse.ok
        && windowPagePayload.windows?.total >= 1
        && windowPagePayload.windows?.page === 1
        && windowPagePayload.windows?.pageSize === 1
        && windowPagePayload.windows?.items?.length === 1,
      "memory extraction run API should return stable newest-first pagination metadata",
    )
    const selectedWindowStart = Number(reextractPayload.windows?.[0]?.windowStart || 0)
    const selectedReextractResponse = await fetch(`http://127.0.0.1:${port}/api/memory/captures/group/${memoryGroupId}/reextract`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ windowStarts: [selectedWindowStart] }),
    })
    const selectedReextractPayload = await selectedReextractResponse.json()
    assert(
      selectedReextractResponse.ok
        && selectedReextractPayload.result?.mode === "selection"
        && selectedReextractPayload.result?.requested === 1
        && Number(selectedReextractPayload.result?.queued || 0) + Number(selectedReextractPayload.result?.alreadyQueued || 0) === 1,
      "memory capture API should reuse the re-extraction endpoint for selected daily windows",
    )
    const publicMemoryResponse = await fetch(`http://127.0.0.1:${port}/api/memory/groups/${memoryGroupId}/facts`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "本群每周一同步产品进展。", tags: ["约定"] }),
    })
    const publicMemoryPayload = await publicMemoryResponse.json()
    assert(publicMemoryResponse.ok && publicMemoryPayload.workspace?.groupMemory?.items?.some(item => item.text.includes("每周一")), "group workspace API should add and list searchable public group memories")
    const groupMemberMemoryResponse = await fetch(`http://127.0.0.1:${port}/api/memory/groups/${memoryGroupId}/members/${memoryUserId}/facts`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ scopeType: "user_group", text: "该用户在本群负责产品发布。", tags: ["职责"] }),
    })
    const globalMemberMemoryResponse = await fetch(`http://127.0.0.1:${port}/api/memory/groups/${memoryGroupId}/members/${memoryUserId}/facts`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ scopeType: "user", text: "该用户偏好先看结论。", tags: ["偏好"] }),
    })
    const globalMemberMemoryPayload = await globalMemberMemoryResponse.json()
    assert(groupMemberMemoryResponse.ok && globalMemberMemoryResponse.ok && globalMemberMemoryPayload.workspace?.globalMemory?.items?.some(item => item.text.includes("先看结论")), "member memory API should save a group-only and a cross-group global fact separately")
    const groupWorkspaceResponse = await fetch(`http://127.0.0.1:${port}/api/memory/groups/${memoryGroupId}/workspace?groupQuery=${encodeURIComponent("每周一")}&memberQuery=${memoryUserId}`, { headers: { cookie } })
    const groupWorkspacePayload = await groupWorkspaceResponse.json()
    assert(groupWorkspaceResponse.ok && groupWorkspacePayload.workspace?.groupMemory?.items?.length === 1 && groupWorkspacePayload.workspace?.members?.some(item => item.userId === memoryUserId), "group workspace API should search public facts and progressively list matching members")
    const memberWorkspaceResponse = await fetch(`http://127.0.0.1:${port}/api/memory/groups/${memoryGroupId}/members/${memoryUserId}?groupQuery=${encodeURIComponent("负责")}&globalQuery=${encodeURIComponent("结论")}`, { headers: { cookie } })
    const memberWorkspacePayload = await memberWorkspaceResponse.json()
    assert(memberWorkspaceResponse.ok && memberWorkspacePayload.workspace?.groupMemory?.items?.some(item => item.text.includes("负责产品发布")) && memberWorkspacePayload.workspace?.globalMemory?.items?.some(item => item.text.includes("先看结论")), "member workspace API should keep group-only and user-global searches isolated")
    const filtersResponse = await fetch(`http://127.0.0.1:${port}/api/message-filters`, { headers: { cookie } })
    const filtersPayload = await filtersResponse.json()
    assert(filtersResponse.ok && Array.isArray(filtersPayload.filtering?.filters) && Array.isArray(filtersPayload.implementations) && Number.isInteger(filtersPayload.templates?.[0]?.filter?.priority), "canonical message-filter API should expose filters, native implementations, templates, and priority")
    assert(filtersPayload.templates?.every(template => template.filter?.implementation?.type === "filter"), "new message-filter API templates should use the native filter implementation type")
    assert(filtersPayload.filtering.filters.every(filter => ["filter", "tool"].includes(filter?.implementation?.type) && !filter.action), "canonical message-filter API should expose implementation instead of action.tool")
    assert(filtersPayload.filtering.filters.filter(filter => builtinFilterIds.includes(filter?.implementation?.id)).every(filter => filter.implementation.type === "filter"), "canonical message-filter API should serialize built-ins as native filters")
    assert(builtinFilterIds.every(id => filtersPayload.implementations.some(implementation => implementation.id === id && implementation.source === "builtin")), "canonical message-filter API should list FilterRegistry built-ins as implementations")
    const nativeFilterTestResponse = await fetch(`http://127.0.0.1:${port}/api/message-filters/test`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        text: "hello",
        filter: {
          id: "smoke-api-native-filter",
          name: "Smoke API native filter",
          enabled: true,
          stage: "output",
          priority: 100,
          condition: { minTextLength: 0 },
          implementation: { type: "filter", id: "text_transform", arguments: { operation: "append", suffix: "!" } },
        },
      }),
    })
    const nativeFilterTestPayload = await nativeFilterTestResponse.json()
    assert(nativeFilterTestResponse.ok && nativeFilterTestPayload.result?.output === "hello!" && nativeFilterTestPayload.result?.traces?.[0]?.filter === "text_transform", "native filter API test should inject text without a Tool argument binding")
    const customFiltersResponse = await fetch(`http://127.0.0.1:${port}/api/custom-filters`, { headers: { cookie } })
    const customFiltersPayload = await customFiltersResponse.json()
    assert(customFiltersResponse.ok && Array.isArray(customFiltersPayload.implementations) && customFiltersPayload.custom && Array.isArray(customFiltersPayload.custom.catalog), "Custom Filter API should expose its independent package catalog and implementations")
    const resourceBrowserResponse = await fetch(`http://127.0.0.1:${port}/api/extension-authoring/resources?path=${encodeURIComponent("plugins/yui-chat/filters/core")}`, { headers: { cookie } })
    const resourceBrowserPayload = await resourceBrowserResponse.json()
    assert(resourceBrowserResponse.ok && resourceBrowserPayload.result?.entries?.some(item => item.reference === "plugin:yui-chat/filters/core/registry.ts"), "resource browser API should return safe project source references")
    const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
    const { providerResolver } = await import("../output/runtime/models/routing/provider-resolver.js")
    const authoringAdapter = adapterRegistry.get("openai-compatible")
    const originalResolveAuthoringChannels = providerResolver.resolveCandidateChannels
    const originalAuthoringSend = authoringAdapter.sendMessage
    try {
      providerResolver.resolveCandidateChannels = () => [{ id: "smoke-authoring-model", type: "openai-compatible", modelConfig: {}, provider: {} }]
      authoringAdapter.sendMessage = async () => ({
        id: "smoke-authoring-response",
        text: [
          "<FILTER_MANIFEST>",
          JSON.stringify({
            id: "model-changed-package",
            name: "AI Generated Smoke",
            enabled: true,
            frameworkResources: {},
            filters: [{ id: "model_changed_filter", stages: ["input"], effects: ["network"], parameters: { type: "object", properties: { suffix: { type: "string" } } } }],
          }),
          "</FILTER_MANIFEST>",
          "<FILTER_SOURCE>",
          "export function createFilters() { return [{ id: \"smoke_ai_api_filter\", stages: [\"output\"], effects: [\"pure\"], async apply({ text }) { return { kind: \"text\", text: text.trim() } } }] }",
          "</FILTER_SOURCE>",
          "<FILTER_NOTES>已生成去除首尾空白的草稿。</FILTER_NOTES>",
        ].join("\n"),
        usage: { input: 10, output: 20, total: 30 },
        toolCalls: [],
      })
      const aiDraftResponse = await fetch(`http://127.0.0.1:${port}/api/extension-authoring/filter-draft`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          requirement: "trim text",
          manifest: {
            id: "smoke-ai-api",
            name: "Smoke AI API",
            enabled: true,
            frameworkResources: {},
            filters: [{ id: "smoke_ai_api_filter", stages: ["output"], effects: ["pure"], parameters: { type: "object", properties: {} } }],
          },
          source: "export function createFilters() { return [] }",
        }),
      })
      const aiDraftPayload = await aiDraftResponse.json()
      assert(aiDraftResponse.ok && aiDraftPayload.result?.manifest?.id === "smoke-ai-api" && aiDraftPayload.result?.manifest?.filters?.[0]?.id === "smoke_ai_api_filter", "AI draft API should validate generated code and preserve stable filter identities")
      assert(aiDraftPayload.result?.model?.channel === "smoke-authoring-model" && aiDraftPayload.result?.source?.includes("text.trim()"), "AI draft API should report the project model and return reviewable source without saving it")
    } finally {
      providerResolver.resolveCandidateChannels = originalResolveAuthoringChannels
      authoringAdapter.sendMessage = originalAuthoringSend
    }
    const retiredFiltersResponse = await fetch(`http://127.0.0.1:${port}/api/message-processors`, { headers: { cookie } })
    assert(retiredFiltersResponse.status === 404, "retired message-processor API should be unavailable")
    const crossSitePatch = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie, host: `127.0.0.1:${port}`, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ patch: {} }),
    })
    assert(crossSitePatch.status === 401, "cookie-authenticated configuration changes should reject cross-site requests")
    const testResponse = await fetch(`http://127.0.0.1:${port}/api/custom-tools/framework-block-example/test`, {
      method: "POST",
      headers: { "content-type": "application/json", "yui-chat-token": webTestAuthToken },
      body: JSON.stringify({ tool: "status_command_help", args: {} }),
    })
    const testPayload = await testResponse.json()
    assert(testResponse.ok && testPayload.result?.result?.includes("#发言榜"), "Custom tool test API should execute the saved framework-block demo")
  } finally {
    global.Bot = originalWebBot
    await configStore.save(original)
    await new Promise(resolve => apiServer.close(resolve))
  }
  try {
    const nextThreshold = Number(original.response?.autoUsePictureThreshold || 1200) + 1
    const { next, changedPaths } = applyConfigPatch(original, { "response.autoUsePictureThreshold": nextThreshold })
    assert(changedPaths.includes("response.autoUsePictureThreshold"), "config patch should report changed paths")
    assert(next.response.autoUsePictureThreshold === nextThreshold, "config patch should update nested value")
    await configStore.save(next)
    assert(configStore.get().response.autoUsePictureThreshold === nextThreshold, "patched config should save through config store")
    let unsafeBlocked = false
    try {
      applyConfigPatch(original, { "__proto__.polluted": true })
    } catch {
      unsafeBlocked = true
    }
    assert(unsafeBlocked, "config patch should block unsafe prototype paths")
    const modelConfig = {
      ...original,
      models: [
        ...(original.models || []),
        { name: "smoke-model-admin", modelIdentifier: "smoke-model", apiProvider: original.apiProviders?.[0]?.name || "mock", adapter: "mock", visual: false, toolUse: true, params: {} },
      ],
      modelTasks: {
        ...(original.modelTasks || {}),
        replyer: {
          ...(original.modelTasks?.replyer || {}),
          modelList: [...new Set([...(original.modelTasks?.replyer?.modelList || []), "smoke-model-admin"])],
        },
      },
    }
    const defaulted = setDefaultModelConfig(modelConfig, "smoke-model-admin", "replyer")
    assert(defaulted.chat.defaultChannel === "smoke-model-admin", "model default helper should update default channel")
    assert(defaulted.modelTasks.replyer.modelList[0] === "smoke-model-admin", "model default helper should move model to front of task")
    const updatedModelConfig = updateModelConfig(defaulted, "smoke-model-admin", {
      modelIdentifier: "smoke-model-v2",
      apiProvider: original.apiProviders[0].name,
      adapter: "mock",
      visual: true,
      toolUse: false,
      priceIn: 1,
      priceOut: 2,
      reasoning: { target: "deepseek", effort: "high" },
      timeoutMs: 180000,
      stream: true,
      params: { temperature: 0.1 },
    })
    const updatedModel = updatedModelConfig.models.find(item => item.name === "smoke-model-admin")
    assert(updatedModel.modelIdentifier === "smoke-model-v2", "model update helper should update model identifier")
    assert(updatedModel.visual === true && updatedModel.toolUse === false, "model update helper should update model capabilities")
    assert(updatedModel.priceIn === 1 && updatedModel.priceOut === 2, "model update helper should update model prices")
    assert(updatedModel.reasoning?.target === "deepseek" && updatedModel.reasoning?.effort === "high", "model update helper should update unified reasoning config")
    assert(updatedModel.timeoutMs === 180000 && updatedModel.stream === true, "model update helper should update transport overrides")
    assert(updatedModel.params.temperature === 0.1, "model update helper should update params")
    const inheritedTransport = updateModelConfig(updatedModelConfig, "smoke-model-admin", { timeoutMs: null, stream: null }).models.find(item => item.name === "smoke-model-admin")
    assert(inheritedTransport.timeoutMs === undefined && inheritedTransport.stream === undefined, "model transport overrides should support returning to global inheritance")
    let invalidModelProviderBlocked = false
    try {
      updateModelConfig(defaulted, "smoke-model-admin", { apiProvider: "missing-provider" })
    } catch {
      invalidModelProviderBlocked = true
    }
    assert(invalidModelProviderBlocked, "model update helper should reject missing providers")
    const deleted = deleteModelConfig(defaulted, "smoke-model-admin")
    assert(!deleted.next.models.some(item => item.name === "smoke-model-admin"), "model delete helper should remove model")
    assert(!deleted.next.modelTasks.replyer.modelList.includes("smoke-model-admin"), "model delete helper should remove task references")
    let lastModelBlocked = false
    try {
      deleteModelConfig({ ...original, models: [original.models[0]], modelTasks: { replyer: { modelList: [original.models[0].name] } } }, original.models[0].name)
    } catch {
      lastModelBlocked = true
    }
    assert(lastModelBlocked, "model delete helper should block deleting the last model")
    const providerUpdated = updateProviderConfig(original, original.apiProviders[0].name, {
      baseURL: "https://smoke.example/v1",
      authType: "bearer",
      authHeader: "Authorization",
      apiKey: "smoke-secret",
      headers: { "x-smoke": "1" },
      query: { smoke: "yes" },
    })
    assert(providerUpdated.apiProviders[0].baseURL === "https://smoke.example/v1", "provider update helper should update baseURL")
    assert(providerUpdated.apiProviders[0].apiKey === "smoke-secret", "provider update helper should replace api key when provided")
    const providerKeptKey = updateProviderConfig(providerUpdated, original.apiProviders[0].name, { baseURL: "https://smoke2.example/v1", apiKey: "" })
    assert(providerKeptKey.apiProviders[0].apiKey === "smoke-secret", "provider update helper should keep api key when empty")
    const providerCleared = updateProviderConfig(providerUpdated, original.apiProviders[0].name, { clearApiKey: true })
    assert(providerCleared.apiProviders[0].apiKey === "", "provider update helper should clear api key explicitly")
    const providerDeleteConfig = {
      ...original,
      apiProviders: [
        ...(original.apiProviders || []),
        { name: "smoke-provider-delete", type: "mock", baseURL: "", apiKey: "", authType: "none", headers: {}, query: {} },
      ],
      models: [
        ...(original.models || []),
        { name: "smoke-provider-model-a", modelIdentifier: "smoke-a", apiProvider: "smoke-provider-delete", adapter: "mock", visual: false, toolUse: true, params: {} },
        { name: "smoke-provider-model-b", modelIdentifier: "smoke-b", apiProvider: "smoke-provider-delete", adapter: "mock", visual: true, toolUse: false, params: {} },
      ],
      channels: [
        ...(original.channels || []),
        { id: "smoke-provider-channel", name: "smoke-provider-channel", apiProvider: "smoke-provider-delete", type: "mock", enabled: true, model: "smoke-a", baseURL: "", apiKey: "", headers: {}, params: {} },
      ],
      chat: {
        ...(original.chat || {}),
        defaultChannel: "smoke-provider-model-a",
      },
      mediaRecognition: {
        ...(original.mediaRecognition || {}),
        recognitionModel: "smoke-provider-model-b",
      },
      modelTasks: {
        ...(original.modelTasks || {}),
        replyer: {
          ...(original.modelTasks?.replyer || {}),
          modelList: [...new Set([...(original.modelTasks?.replyer?.modelList || []), "smoke-provider-model-a", "smoke-provider-model-b"])],
        },
      },
    }
    const providerDeleted = deleteProviderConfig(providerDeleteConfig, "smoke-provider-delete")
    assert(providerDeleted.deleted === "smoke-provider-delete", "provider delete helper should report deleted provider")
    assert(providerDeleted.removedModels.length === 2, "provider delete helper should collect removed models")
    assert(!providerDeleted.next.apiProviders.some(item => item.name === "smoke-provider-delete"), "provider delete helper should remove provider")
    assert(!providerDeleted.next.models.some(item => item.apiProvider === "smoke-provider-delete"), "provider delete helper should remove provider models")
    assert(!providerDeleted.next.channels.some(item => item.apiProvider === "smoke-provider-delete"), "provider delete helper should remove related legacy channels")
    assert(!providerDeleted.next.modelTasks.replyer.modelList.some(item => item === "smoke-provider-model-a" || item === "smoke-provider-model-b"), "provider delete helper should clean task model references")
    assert(providerDeleted.next.mediaRecognition.recognitionModel === "", "provider delete helper should clear removed recognition model")
  } finally {
    await configStore.save(original)
  }
  await import("../index.js")
}

async function checkWebAuthSecurity() {
  const { configStore } = await import("../output/runtime/config/store.js")
  const original = JSON.parse(JSON.stringify(await configStore.load()))
  const { buildWebAddresses, consumeQuickLogin, issueQuickLogin, issueWebAccessToken, readWebToken, requireWebAuth, validateConfiguredWebToken } = await import("../output/runtime/web/http/auth.js")
  try {
    assert(original.web.authToken === "" && !validateConfiguredWebToken("anything"), "empty static Web token should disable configured-token authentication")
    assert(readWebToken({ headers: { authorization: "Bearer bearer-token" } }) === "bearer-token", "web auth should accept standard Bearer tokens")
    assert(readWebToken({ headers: {}, query: { token: "query-token" } }) === "", "HTTP auth must ignore URL tokens outside the dedicated quick-login consumer")
    const quick = issueQuickLogin("smoke-master")
    const quickSession = consumeQuickLogin(quick.code)
    let replayRejected = false
    try { consumeQuickLogin(quick.code) } catch { replayRejected = true }
    assert(quick.code.length >= 20 && quick.ttlMs === 180000 && replayRejected, "owner-issued quick codes should be high entropy, three-minute, and single use")

    const session = issueWebAccessToken("smoke-user")
    const cookie = `yui_chat_session=${encodeURIComponent(session.token)}`
    assert(readWebToken({ headers: { cookie } }) === session.token && quickSession.token, "web auth should read short HttpOnly sessions created directly or through quick login")

    const configured = JSON.parse(JSON.stringify(original))
    configured.web.authToken = "smoke-static-auth-token"
    configured.web.publicBaseUrl = "https://bot.example.com:8443/admin/"
    configured.web.mountPath = "/yui-chat"
    await configStore.save(configured)
    const addresses = await buildWebAddresses({ quickCode: "smoke-quick-code" })
    assert(addresses.custom.includes("https://bot.example.com:8443/admin/yui-chat/?quick=smoke-quick-code"), "custom Web server prefixes should preserve ports and path prefixes before appending the mount route and quick code")
    assert(addresses.custom.length === 1, "an explicit Web server prefix should replace auto-discovered Yunzai addresses")
    const response = () => ({
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this },
      json(payload) { this.payload = payload; return this },
    })
    let authorized = false
    const headerResponse = response()
    requireWebAuth({ headers: { "yui-chat-token": configured.web.authToken } }, headerResponse, () => { authorized = true })
    assert(authorized && headerResponse.statusCode === 200, "non-empty configured Web token should authorize request headers")

    authorized = false
    const queryResponse = response()
    requireWebAuth({ query: { token: configured.web.authToken } }, queryResponse, () => { authorized = true })
    assert(!authorized && queryResponse.statusCode === 401, "ordinary query tokens must not bypass Web auth")

    authorized = false
    const crossSiteResponse = response()
    requireWebAuth({ method: "POST", headers: { cookie, host: "localhost:2536", origin: "https://evil.example", "sec-fetch-site": "cross-site" } }, crossSiteResponse, () => { authorized = true })
    assert(!authorized && crossSiteResponse.statusCode === 401, "cross-site state changes must not use the cookie session")

    authorized = false
    const sameOriginResponse = response()
    requireWebAuth({ method: "POST", headers: { cookie, host: "localhost:2536", origin: "http://localhost:2536", "sec-fetch-site": "same-origin" } }, sameOriginResponse, () => { authorized = true })
    assert(authorized && sameOriginResponse.statusCode === 200, "same-origin state changes should accept the cookie session")
  } finally {
    await configStore.save(original)
  }
}

async function checkWebConfigAdmin() {
  const { configStore } = await import("../output/runtime/config/store.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { createWebApp } = await import("../output/runtime/web/http/app.js")
  const { issueQuickLogin } = await import("../output/runtime/web/http/auth.js")
  const { createServer } = await import("node:http")
  const express = (await import("express")).default
  const original = JSON.parse(JSON.stringify(await configStore.load()))
  const router = createWebApp()
  const app = express()
  app.use(router)
  const server = createServer(app)
  let createdBackup = ""
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const port = server.address().port
    assert(original.web.authToken === "", "fresh Web configuration should leave static login disabled")
    const disabledStaticResponse = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "yui-chat-token": "unconfigured-token" },
      body: "{}",
    })
    assert(disabledStaticResponse.status === 401, "static login should reject every token while config web.authToken is empty")

    const quick = issueQuickLogin("smoke-master")
    const quickLoginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/quick-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: quick.code }),
    })
    const quickCookie = String(quickLoginResponse.headers.get("set-cookie") || "").split(";")[0]
    assert(quickLoginResponse.ok && quickCookie.includes("yui_chat_session="), "an owner-issued quick code should establish a protected browser session")
    const replayResponse = await fetch(`http://127.0.0.1:${port}/api/auth/quick-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: quick.code }),
    })
    assert(replayResponse.status === 401, "an owner-issued quick code should be rejected after its first use")

    const tokenViewResponse = await fetch(`http://127.0.0.1:${port}/api/config/auth-token`, { headers: { cookie: quickCookie } })
    const tokenViewPayload = await tokenViewResponse.json()
    assert(tokenViewResponse.ok && tokenViewPayload.authToken === "", "a quick-login session should be able to inspect the disabled static credential")
    const rotatedToken = `smoke-rotated-${Date.now()}-token`
    const tokenSaveResponse = await fetch(`http://127.0.0.1:${port}/api/config/auth-token`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: quickCookie },
      body: JSON.stringify({ authToken: rotatedToken }),
    })
    const newCookie = String(tokenSaveResponse.headers.get("set-cookie") || "").split(";")[0]
    assert(tokenSaveResponse.ok && newCookie.includes("yui_chat_session="), "a quick-login session should be able to enable optional static login")
    const staticSessionResponse = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "yui-chat-token": rotatedToken },
      body: "{}",
    })
    assert(staticSessionResponse.ok, "a configured non-empty static token should establish a browser session")

    const currentSessionHeaders = { "content-type": "application/json", cookie: newCookie }
    const shortTokenResponse = await fetch(`http://127.0.0.1:${port}/api/config/auth-token`, {
      method: "PUT",
      headers: currentSessionHeaders,
      body: JSON.stringify({ authToken: "short" }),
    })
    assert(shortTokenResponse.status === 400, "Web token rotation should reject an unsafe short credential")
    const clearTokenResponse = await fetch(`http://127.0.0.1:${port}/api/config/auth-token`, {
      method: "PUT",
      headers: currentSessionHeaders,
      body: JSON.stringify({ authToken: "" }),
    })
    const clearedCookie = String(clearTokenResponse.headers.get("set-cookie") || "").split(";")[0]
    assert(clearTokenResponse.ok && clearedCookie.includes("yui_chat_session="), "clearing the static token should disable static login while preserving the current browser through a fresh short session")
    const disabledAgainResponse = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "yui-chat-token": rotatedToken },
      body: "{}",
    })
    assert(disabledAgainResponse.status === 401, "cleared static token should stop authorizing the static session endpoint")
    const clearedSessionHeaders = { "content-type": "application/json", cookie: clearedCookie }
    const hotTool = "message_send"
    const beforeHotToggle = (await toolRegistry.list()).find(item => item.name === hotTool)
    assert(beforeHotToggle, "hot tool toggle smoke should resolve a registered built-in tool")
    const toggledEnabled = beforeHotToggle.enabled !== true
    const hotToggleResponse = await fetch(`http://127.0.0.1:${port}/api/tools/enabled`, {
      method: "POST",
      headers: clearedSessionHeaders,
      body: JSON.stringify({ tool: hotTool, enabled: toggledEnabled }),
    })
    const hotTogglePayload = await hotToggleResponse.json()
    assert(hotToggleResponse.ok && hotTogglePayload.hotApplied === true && hotTogglePayload.runtime?.tools === false, "single-tool enable changes should apply as a live policy update without rebuilding the registry")
    assert(hotTogglePayload.tools?.find(item => item.name === hotTool)?.enabled === toggledEnabled, "hot tool toggle response should immediately reflect the saved state")
    assert((await toolRegistry.getEnabledTools()).some(item => item.name === hotTool) === toggledEnabled, "the next model tool resolution should read the hot-applied enabled state")
    const hotRestoreResponse = await fetch(`http://127.0.0.1:${port}/api/tools/enabled`, {
      method: "POST",
      headers: clearedSessionHeaders,
      body: JSON.stringify({ tool: hotTool, enabled: beforeHotToggle.enabled === true }),
    })
    assert(hotRestoreResponse.ok, "hot tool toggle smoke should restore the original tool state")
    const tempTokenResponse = await fetch(`http://127.0.0.1:${port}/api/auth/local-temp-token`, { method: "POST" })
    assert(tempTokenResponse.status === 404, "Web must not expose a local temporary-token issuance endpoint")
    const missingQuickResponse = await fetch(`http://127.0.0.1:${port}/api/auth/quick-login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    assert(missingQuickResponse.status === 401, "quick-login endpoint should only consume a code already issued by the owner command")
    const reloadResponse = await fetch(`http://127.0.0.1:${port}/api/config/reload`, { method: "POST", headers: clearedSessionHeaders, body: "{}" })
    assert(reloadResponse.status === 404, "retired generic configuration reload endpoint should be unavailable")
    const backupCreateResponse = await fetch(`http://127.0.0.1:${port}/api/config/backups`, { method: "POST", headers: clearedSessionHeaders, body: "{}" })
    const backupCreatePayload = await backupCreateResponse.json()
    createdBackup = String(backupCreatePayload.fileName || "")
    assert(backupCreateResponse.ok && createdBackup && backupCreatePayload.backups?.some(item => item.fileName === createdBackup && item.kind === "package"), "authenticated backup API should create and inspect one configuration package")
    const backupDeleteResponse = await fetch(`http://127.0.0.1:${port}/api/config/backups/${encodeURIComponent(createdBackup)}`, { method: "DELETE", headers: clearedSessionHeaders })
    assert(backupDeleteResponse.ok, "authenticated backup API should delete the selected configuration package")
    createdBackup = ""
  } finally {
    if (createdBackup) await configStore.deleteBackup(createdBackup).catch(() => {})
    await configStore.save(original)
    await new Promise(resolve => server.close(resolve))
  }
}

async function checkCapabilities() {
  const { buildCapabilityRegistry } = await import("../output/runtime/core/runtime/capability-registry.js")
  const registry = await buildCapabilityRegistry()
  const ids = new Set((registry.capabilities || []).map(item => item.id))
  for (const id of ["first-person", "model-workflows", "web-management", "tools-skills-mcp", "command-knowledge", "cache-lifecycle"]) {
    assert(ids.has(id), `capability registry should include ${id}`)
  }
  assert(registry.summary.total >= 8, "capability registry should expose core modules")
  assert(registry.summary.enabled >= 6, "capability registry should report enabled modules")
  assert(registry.capabilities.some(item => item.apis?.includes("/api/tools/access-matrix")), "capability registry should document tool access matrix API")
  assert(!registry.capabilities.some(item => item.apis?.includes("/api/persona/expression")), "capability registry should not document the retired persona expression API")
  const firstPersonCapability = registry.capabilities.find(item => item.id === "first-person")
  assert(firstPersonCapability?.configPaths?.includes("persona") && !firstPersonCapability?.configPaths?.includes("persona.expression"), "first-person capability should expose the unified persona configuration without retired expression paths")
  assert(registry.capabilities.some(item => item.apis?.includes("/api/knowledge/quality")), "capability registry should document command knowledge quality API")
  assert(registry.runtime.tools.total > 0, "capability registry should include runtime tool stats")
  assert(registry.runtime.persona?.identity?.firstPerson, "capability registry should include persona digest")
  assert(typeof registry.runtime.extensions?.errors === "number", "capability registry should include extension digest")
}

async function checkDiagnostics() {
  const { runtimeRoot } = await import("../output/runtime/config/store.js")
  const { buildDiagnostics } = await import("../output/runtime/core/runtime/diagnostics.js")
  const result = await buildDiagnostics()
  assert(pathInside(result.paths.configDir, runtimeRoot) && pathInside(result.paths.dataDir, runtimeRoot) && pathInside(result.paths.cacheDir, runtimeRoot) && pathInside(result.paths.tempDir, runtimeRoot), "diagnostics should report only isolated smoke runtime paths")
  assert(!result.paths.tempInsidePluginCache, "diagnostics should identify that the smoke cache is intentionally outside the source plugin directory")
  assert(!result.paths.rootTempExists, "diagnostics should report root temp absent")
  assert(typeof result.safety.webAuthTokenConfigured === "boolean", "diagnostics should report whether optional static Web login is configured")
  assert(typeof result.summary.customTools === "number" && typeof result.summary.markdownSkills === "number", "diagnostics should expose current extension counts")
  assert(!Object.hasOwn(result.tools, "extensionCatalog"), "diagnostics should not expose retired capability mappings")
  assert(result.capabilities?.summary?.total >= 8, "diagnostics should include capability registry")
  assert(result.runtime.commandKnowledge?.stats, "diagnostics should include command knowledge digest")
  assert(result.runtime.persona?.identity?.firstPerson, "diagnostics should include persona digest")
  assert(result.tools.extensionDigest?.summary, "diagnostics should include extension digest")
  assert(typeof result.safety.messageFiltersEnabled === "boolean" && Number.isInteger(result.summary.messageFilters), "diagnostics should expose message filter status")
}

async function checkPluginIsolation() {
  // 纯 Node 扫描：不依赖外部 rg/grep，保证任何环境下都能执行隔离检查。
  const pattern = /chatgpt-plugin\/utils\/tools|from ['"][^'"]*chatgpt-plugin|chatgpt-plugin\/node_modules/
  for (const file of await files(pluginRoot)) {
    assert(!pattern.test(await fs.readFile(file, "utf8")), `new plugin should not import old chatgpt-plugin tools: ${path.relative(pluginRoot, file)}`)
  }
}

async function exists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

async function checkSubAgent() {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { schemaManifest } = await import("../output/runtime/config/schema.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { DispatchSubagentTool } = await import("../output/runtime/tools/builtins/subagent.js")
  const { chatService } = await import("../output/runtime/core/chat/chat-service.js")
  assert(defaults.subAgent && defaults.subAgent.enabled === false, "subAgent must default to disabled")
  assert(defaults.subAgent.maxDepth === 1, "subAgent default maxDepth should be 1")
  assert(defaults.subAgent.maxTasksPerDispatch === 3 && defaults.subAgent.maxConcurrency === 3, "subAgent should default to bounded dispatch and global concurrency")
  assert(defaults.subAgent.maxToolCallsPerRound === 4 && defaults.subAgent.maxDurationMs === 120000, "subAgent should default to bounded tool calls and duration")
  assert(Array.isArray(defaults.subAgent.allowedTools) && !defaults.subAgent.allowedTools.includes("dispatch_subagent"), "subAgent allowedTools must exclude dispatch_subagent to prevent recursion")
  assert(schemaManifest.sections.some(section => section.group === "SubAgent" && section.fields.some(field => field.path === "subAgent.maxDurationMs")), "config schema should expose sub-agent resource boundaries")
  assert(defaults.tools.enabledTools.includes("dispatch_subagent"), "dispatch_subagent should be in default enabledTools")
  const badDepth = JSON.parse(JSON.stringify(defaults))
  badDepth.subAgent.maxDepth = 9
  assert(!validateConfig(badDepth).ok, "subAgent.maxDepth out of range should fail validation")
  const badBudget = JSON.parse(JSON.stringify(defaults))
  badBudget.subAgent.maxTasksPerDispatch = 9
  badBudget.subAgent.maxToolCallsPerRound = 20
  badBudget.subAgent.maxDurationMs = 1000
  assert(!validateConfig(badBudget).ok, "subAgent resource budget out of range should fail validation")
  const badTokens = JSON.parse(JSON.stringify(defaults))
  badTokens.modelTasks.replyer.maxTokens = 0
  assert(!validateConfig(badTokens).ok, "model task token limit must be positive")
  const badTask = JSON.parse(JSON.stringify(defaults))
  badTask.subAgent.task = "missing-task"
  assert(!validateConfig(badTask).ok, "subAgent.task referencing missing modelTask should fail validation")
  await toolRegistry.init()
  assert((await toolRegistry.list()).some(tool => tool.name === "dispatch_subagent"), "dispatch_subagent tool should be registered")
  assert(typeof chatService.runSubAgent === "function", "chatService should expose runSubAgent executor")
  const tool = new DispatchSubagentTool()
  const offResult = await tool.execute({ task: "查一下体力怎么查" }, { config: { subAgent: { enabled: false } } })
  assert(/未启用/.test(offResult), "dispatch_subagent should refuse when subAgent disabled")
  const depthResult = await tool.execute({ task: "继续派生" }, { config: { subAgent: { enabled: true, maxDepth: 1 } }, agent: { depth: 1 } })
  assert(/递归深度/.test(depthResult), "dispatch_subagent should refuse at max recursion depth (no nested spawn)")
  const oversizedBatch = await tool.execute({ tasks: ["one", "two", "three"] }, { config: { subAgent: { enabled: true, maxDepth: 1, maxTasksPerDispatch: 2 } }, agent: { depth: 0 } })
  assert(/最多派发 2 个/.test(oversizedBatch), "dispatch_subagent should reject oversized task batches before starting work")
  const subTools = toolRegistry.getToolsByNames(defaults.subAgent.allowedTools, { e: { isMaster: true, isGroup: false, sender: { role: "member" } } })
  assert(!subTools.some(tool => tool.name === "dispatch_subagent"), "sub-agent tool whitelist must exclude dispatch_subagent")
  assert(toolRegistry.getToolsByNames(["dispatch_subagent"], { e: { isMaster: true } }).length === 1, "master can access dispatch_subagent")
  assert(toolRegistry.getToolsByNames(["dispatch_subagent"], { e: { isMaster: false, isGroup: true, sender: { role: "member" } } }).length === 0, "non-master must be blocked from dispatch_subagent (requiresMaster)")
  assert(tool.parameters?.properties?.tasks, "dispatch_subagent should support parallel tasks array")
  assert(typeof chatService.listSubAgentRuns === "function", "chatService should expose listSubAgentRuns for trace")
  const activeBefore = chatService.activeSubAgentRuns
  chatService.activeSubAgentRuns = defaults.subAgent.maxConcurrency
  try {
    const busy = await chatService.runSubAgent({
      task: "busy smoke",
      e: { isGroup: false, user_id: "subagent-smoke" },
      config: defaults,
    })
    assert(busy.busy === true && /繁忙/.test(busy.text), "subAgent global concurrency should reject excess runs")
  } finally {
    chatService.activeSubAgentRuns = activeBefore
  }
}

async function main() {
  const checks = [
    ["syntax", checkSyntax],
    ["runtime-isolation", checkRuntimeIsolation],
    ["config-safety", checkConfigSafety],
    ["config-hot-reload", checkConfigHotReload],
    ["atomic-json-repository", checkAtomicJsonRepository],
    ["persistent-store-adapters", checkPersistentStoreAdapters],
    ["user-extension-storage", checkUserExtensionStorage],
    ["provider-templates", checkProviderTemplates],
    ["adapter-tool-protocol", checkAdapterToolProtocol],
    ["model-routing-preview", checkModelRoutingPreview],
    ["model-routing-api", checkModelRoutingApi],
    ["sub-agent", checkSubAgent],
    ["tool-policy", checkToolPolicy],
    ["schedule-task", checkScheduleTaskTool],
    ["extensions", checkExtensions],
    ["extension-validation", checkExtensionValidation],
    ["network-tools", checkNetworkTools],
    ["memory-profile", checkMemoryProfile],
    ["sqlite-storage", checkSqliteStorage],
    ["media", checkMedia],
    ["output-semantics", checkOutputSemantics],
    ["message-filters", checkMessageFilters],
    ["access-control", checkAccessControl],
    ["persona-trigger", checkPersonaTrigger],
    ["render-service", checkRenderService],
    ["command-rules", checkCommandRules],
    ["conversations", checkConversations],
    ["unified-model-logs", checkUnifiedModelLogs],
    ["command-knowledge", checkCommandKnowledge],
    ["web-auth-security", checkWebAuthSecurity],
    ["web-config-admin", checkWebConfigAdmin],
    ["web-and-boot", checkWebAndBoot],
    ["capabilities", checkCapabilities],
    ["diagnostics", checkDiagnostics],
    ["plugin-isolation", checkPluginIsolation],
  ]
  const selected = new Set(String(process.env.YUI_CHAT_SMOKE_CHECKS || "").split(",").map(item => item.trim()).filter(Boolean))
  for (const [name, fn] of selected.size ? checks.filter(([name]) => selected.has(name)) : checks) {
    await fn()
    console.log(`ok ${name}`)
  }
}

async function runSmoke() {
  await ensureRuntimeBuild()
  await prepareSmokeRuntimeRoot()
  try {
    await main()
  } finally {
    await cleanupSmokeRuntimeRoot()
  }
}

runSmoke().then(() => {
  process.exit(0)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
