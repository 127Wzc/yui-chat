import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ignoredDirs = new Set([".git", ".superpowers", "cache", "node_modules", "output", "resources", "scripts", "vendor"])

async function listSourceFiles(dir, files = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) await listSourceFiles(file, files)
    else if (entry.isFile() && !entry.name.endsWith(".d.ts") && (/\.(?:js|ts)$/u.test(entry.name))) files.push(file)
  }
  return files
}

function relative(file) {
  return path.relative(pluginRoot, file).split(path.sep).join("/")
}

function resolveImport(fromFile, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return null
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    resolved,
    resolved.replace(/\.js$/u, ".ts"),
    `${resolved}.ts`,
    `${resolved}.js`,
    path.join(resolved, "index.ts"),
    path.join(resolved, "index.js"),
  ]
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate
  }
  return null
}

function findImportCycles(graph) {
  const state = new Map()
  const stack = []
  const cycles = []

  function visit(file) {
    if (state.get(file) === "done") return
    if (state.get(file) === "visiting") {
      const start = stack.indexOf(file)
      cycles.push([...stack.slice(start), file])
      return
    }
    state.set(file, "visiting")
    stack.push(file)
    for (const dependency of graph.get(file) || []) visit(dependency)
    stack.pop()
    state.set(file, "done")
  }

  for (const file of graph.keys()) visit(file)
  return cycles
}

function assertRule(condition, message, errors) {
  if (!condition) errors.push(message)
}

const files = await listSourceFiles(pluginRoot)
const knownFiles = new Set(files)
const sources = new Map(await Promise.all(files.map(async file => [file, await fs.readFile(file, "utf8")])))
async function domainSource(name) {
  const jsPath = path.join(pluginRoot, name)
  const tsPath = jsPath.replace(/\.js$/u, ".ts")
  return sources.get(tsPath) || sources.get(jsPath) || ""
}
const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g
const graph = new Map()

for (const [file, source] of sources) {
  const dependencies = []
  for (const match of source.matchAll(importPattern)) {
    const dependency = resolveImport(file, match[1], knownFiles)
    if (dependency) dependencies.push(dependency)
  }
  graph.set(file, dependencies)
}

const errors = []
for (const cycle of findImportCycles(graph)) {
  errors.push(`静态导入循环：${cycle.map(relative).join(" -> ")}`)
}

const retiredPersonaSourceTokens = [
  "persona-expression-store",
  "personaExpressionStore",
  "/api/persona/expression",
  "learnExpression",
  "expressionExamples",
  "selectPersonaState",
]
const retiredPersonaConfigTokens = [
  "stateProbabilityPercent",
  "toolOrchestrationPrompt",
  "groupContextPrompt",
  "commandGuidePrompt",
  "emptyReplyInstruction",
  "innerInstruction",
]
const retiredPersonaStores = [
  path.join(pluginRoot, "core", "persona", "persona-expression-store.js"),
  path.join(pluginRoot, "core", "persona", "persona-expression-store.ts"),
]
assertRule(retiredPersonaStores.every(file => !knownFiles.has(file)), "persona-expression-store 已退役，不应继续存在", errors)
for (const [file, source] of sources) {
  const name = relative(file)
  for (const token of retiredPersonaSourceTokens) {
    assertRule(!source.includes(token), `${name} 仍引用已退役的人设表达/状态能力：${token}`, errors)
  }
  if (name === "config/store.js" || name === "config/store.ts") continue
  for (const token of retiredPersonaConfigTokens) {
    assertRule(!source.includes(token), `${name} 仍读取已退役的人设配置：${token}`, errors)
  }
}

const entrySource = sources.get(path.join(pluginRoot, "index.js")) || ""
assertRule(!entrySource.includes("config.web.authToken"), "index.js 不得把长期 Web Token 写入启动日志", errors)

const webApp = await domainSource("web/http/app.js")
assertRule(webApp.split("\n").length <= 100, "web/http/app.ts 只应作为路由组合入口，不能重新堆积业务路由", errors)
for (const name of ["Runtime", "Config", "Extension", "Knowledge"]) {
  assertRule(webApp.includes(`register${name}Routes(app)`), `web/http/app.ts 缺少 register${name}Routes(app)`, errors)
}
assertRule(webApp.includes("X-Content-Type-Options") && webApp.includes("X-Frame-Options"), "web/http/app.ts 必须保留基础安全响应头", errors)

const webAuth = await domainSource("web/http/auth.js")
const webSocket = await domainSource("web/http/websocket.js")
const requireWebAuthSource = webAuth.match(/export function requireWebAuth[\s\S]*?\n}/)?.[0] || ""
assertRule(!webAuth.includes("allowLocalhostQuickLogin") && !webSocket.includes("allowLocalhostQuickLogin"), "Web HTTP 与 WebSocket 不得恢复本机免鉴权旁路", errors)
assertRule(
  requireWebAuthSource.includes("readWebHeaderToken(req)")
    && requireWebAuthSource.includes("readWebSessionToken(req)")
    && !/req\??\.(?:query|body)/.test(requireWebAuthSource),
  "HTTP 管理接口不得从 URL 或请求体读取长期 Token",
  errors,
)

for (const file of files.filter(file => relative(file).startsWith("web/http/routes/"))) {
  const source = sources.get(file) || ""
  assertRule(source.split("\n").length <= 400, `${relative(file)} 超过 400 行，请继续按领域拆分`, errors)
  assertRule(!/catch\s*\(err\)/.test(source), `${relative(file)} 应通过 handleRoute 统一输出错误`, errors)
}

const webToolsTab = await domainSource("web/client/features/tools/tools-tab.js")
assertRule(
  webToolsTab.includes("./permission-panel.js")
    && webToolsTab.includes("./extension-panel.js")
    && webToolsTab.includes("./mcp-panel.js")
    && webToolsTab.includes("./shared.js"),
  "Web tools tab 应保持角色权限、扩展管理、MCP 管理和共享展示规则分离",
  errors,
)
assertRule(webToolsTab.split("\n").length <= 800, "web/client/features/tools/tools-tab.ts 超过 800 行，请按已有组件边界继续拆分", errors)
const webExtensionPanel = await domainSource("web/client/features/tools/extension-panel.js")
const webMcpPanel = await domainSource("web/client/features/tools/mcp-panel.js")
assertRule(webExtensionPanel.split("\n").length <= 850, "web/client/features/tools/extension-panel.ts 超过 850 行，请优先精简扩展管理交互", errors)
assertRule(webMcpPanel.split("\n").length <= 400, "web/client/features/tools/mcp-panel.ts 超过 400 行，请优先精简 MCP 管理交互", errors)

const webProvidersTab = await domainSource("web/client/features/providers/providers-tab.js")
assertRule(
  webProvidersTab.includes("./provider-editors.js")
    && webProvidersTab.includes("./provider-routing.js")
    && webProvidersTab.includes("./provider-shared.js"),
  "Web providers tab 应保持供应商/模型编辑、回复路由和共享请求/选项逻辑分离",
  errors,
)
assertRule(webProvidersTab.split("\n").length <= 650, "web/client/features/providers/providers-tab.ts 超过 650 行，请按已有组件边界继续拆分", errors)
const webProviderEditors = await domainSource("web/client/features/providers/provider-editors.js")
assertRule(webProviderEditors.split("\n").length <= 600, "web/client/features/providers/provider-editors.ts 超过 600 行，请优先精简供应商和模型编辑交互", errors)

const lifecycle = await domainSource("core/runtime/lifecycle.js")
assertRule(!lifecycle.includes("web/app.js") && !lifecycle.includes("web/http/app.js"), "core/runtime/lifecycle.js 不得反向导入 Web app 入口", errors)

const renderService = await domainSource("core/rendering/render-service.js")
assertRule(
  renderService.includes("./image-renderer-registry.js") && renderService.includes("./render-engine.js"),
  "core/rendering/render-service.ts 应保持渲染算法、引擎策略和注册表职责分离",
  errors,
)
assertRule(renderService.split("\n").length <= 1000, "core/rendering/render-service.ts 超过 1000 行，请按渲染领域继续拆分", errors)

const configStore = await domainSource("config/store.js")
assertRule(configStore.includes("writeFileAtomic(configFile"), "config/store.ts 必须通过原子替换写入主配置", errors)
assertRule(!configStore.includes("fs.writeFile(configFile"), "config/store.ts 不得直接覆盖主配置文件", errors)
assertRule(configStore.includes("YUI_CHAT_RUNTIME_ROOT") && configStore.includes("runtimeRoot"), "config/store.ts 必须支持显式隔离运行目录", errors)

const mediaCache = await domainSource("core/media/media-cache.js")
const renderHtmlService = await domainSource("core/rendering/render-html-service.js")
const linkSafetyPolicy = await domainSource("core/network/link-safety-policy.js")
const safeHttpClient = await domainSource("core/network/safe-http-client.js")
const networkTools = await domainSource("tools/builtins/network.js")
const skillManager = await domainSource("skills/index.js")
assertRule(Boolean(linkSafetyPolicy), "链接与 DNS 安全必须保留统一策略模块", errors)
assertRule(
  !knownFiles.has(path.join(pluginRoot, "core", "network", "url-safety.ts"))
    && !knownFiles.has(path.join(pluginRoot, "core", "network", "provider-host-policy.ts")),
  "已退役的分散 URL/可信域名策略文件不得恢复",
  errors,
)
assertRule(
  linkSafetyPolicy.includes("trustedResourcePolicies")
    && linkSafetyPolicy.includes("security")
    && linkSafetyPolicy.includes("trustedPrivateDnsBypass")
    && linkSafetyPolicy.includes("dns.lookup"),
  "可信资源、私网例外和 DNS 判定必须在统一链接安全策略中维护",
  errors,
)
assertRule(safeHttpClient.includes("./link-safety-policy.js"), "安全 HTTP 客户端必须复用统一链接安全策略", errors)
const defaultsSource = await domainSource("config/defaults.js")
assertRule((defaultsSource.match(/allowPrivateHosts:/g) || []).length === 1, "运行配置只能在 security.linkSafety 保留一个私网访问开关", errors)
assertRule(mediaCache.includes("fetchSafeHttp") && !mediaCache.includes("fetchWithTimeout"), "远程媒体必须通过安全 HTTP 客户端读取", errors)
assertRule(renderHtmlService.includes("fetchSafeHttp(inputUrl"), "远程 HTML 文本必须通过安全 HTTP 客户端读取", errors)
assertRule(
  renderHtmlService.includes("lib/renderer/loader.js")
    && renderHtmlService.includes('getRenderer?.("puppeteer")')
    && !renderHtmlService.includes("userDataDir:"),
  "HTML 渲染必须复用 Yunzai Puppeteer 单例，不得创建或争用独立浏览器资料目录",
  errors,
)
assertRule(
  renderHtmlService.includes("screenshotAllowedHosts") && renderHtmlService.includes("requireAllowedUrlHost: true"),
  "URL 截图必须同时保留显式域名允许列表和页面请求拦截",
  errors,
)
assertRule(networkTools.includes("fetchSafeHttp(text(args.url)"), "website_fetch 必须通过安全 HTTP 客户端读取用户 URL", errors)
assertRule(!skillManager.includes("|| /^file:") && !skillManager.includes("if (/^file:"), "远程 Skill 安装不得接受本地 file:// 仓库", errors)

for (const name of ["knowledge/command-observer.js", "user/settings.js", "core/scheduling/schedule-task-service.js"]) {
  const source = await domainSource(name)
  assertRule(source.includes("AtomicJsonRepository"), `${name} 必须复用统一原子 JSON 仓库`, errors)
  assertRule(!source.includes("fs.writeFile("), `${name} 不得直接覆盖持久化 JSON`, errors)
}

const commandObserver = await domainSource("knowledge/command-observer.js")
assertRule(
  commandObserver.includes("./command-document-builder.js") && commandObserver.includes("./command-query-service.js"),
  "knowledge/command-observer.js 应保持文档构建、查询报告与观察生命周期分离",
  errors,
)
// TS 规范实现包含显式领域类型与宿主边界收窄；保持观察器主体在 750 行以内，避免类型迁移导致门禁误报。
assertRule(commandObserver.split("\n").length <= 750, "knowledge/command-observer.js 超过 750 行，请按领域继续拆分", errors)

for (const [file, source] of sources) {
  if (relative(file) === "core/runtime/host-runtime.ts" || relative(file) === "core/runtime/host-runtime.js") continue
  assertRule(!/\bglobal\.(?:Bot|logger|segment)\b/.test(source), `${relative(file)} 不得直接读取宿主全局对象`, errors)
  assertRule(!/extends\s+plugin\b/.test(source), `${relative(file)} 应通过 hostRuntime.Plugin 继承宿主插件基类`, errors)
  assertRule(!/(?<!hostRuntime\.)\bBot(?:\?\.|\.)/.test(source), `${relative(file)} 应通过 hostRuntime.bot 访问 Bot`, errors)
  const injectedLoggerBoundary = ["core/storage/sqlite/client.ts", "core/storage/sqlite/client.js"].includes(relative(file))
  if (!injectedLoggerBoundary) assertRule(!/(?<!hostRuntime\.)\blogger(?:\?\.|\.)/.test(source), `${relative(file)} 应通过 hostRuntime.logger 记录日志`, errors)
  assertRule(!/catch(?:\s*\([^)]*\))?\s*\{\s*\}/.test(source), `${relative(file)} 的空 catch 必须说明降级意图或记录错误`, errors)

  const allowedJsonClone = [
    "core/shared/json-values.ts",
    "core/shared/json-values.js",
    "core/rendering/render-api-service.ts",
    "core/rendering/render-api-service.js",
    "tools/custom/manager.ts",
    "tools/custom/manager.js",
  ].includes(relative(file))
  if (!allowedJsonClone && !relative(file).startsWith("web/client/")) {
    assertRule(!/JSON\.parse\(JSON\.stringify\(/.test(source), `${relative(file)} 应复用 cloneJsonValue`, errors)
  }
}

for (const [file, source] of sources) {
  const name = relative(file)
  if (name.startsWith("apps/") || name.startsWith("skills/") || name.startsWith("web/http/routes/")) {
    assertRule(!source.includes("configStore.save("), `${name} 的读改写配置必须使用 configStore.update()`, errors)
  }
}

if (errors.length) {
  throw new Error(`结构检查失败：\n- ${errors.join("\n- ")}`)
}

console.log(`ok structure (${files.length} files)`)
