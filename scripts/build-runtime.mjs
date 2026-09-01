import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outputRoot = path.join(pluginRoot, "output")
const runtimeRoot = path.join(outputRoot, "runtime")
const typesRoot = path.join(outputRoot, "typescript")
// 跟随调用方的包管理器：Yunzai 用 pnpm workspace 安装插件，写死 npm 会绕开
// pnpm 的 node_modules 布局；直接执行 node scripts/build-runtime.mjs 时退回 npm。
const runnerAgent = process.env.npm_config_user_agent ?? ""
const runnerName = runnerAgent.startsWith("pnpm") ? "pnpm" : runnerAgent.startsWith("yarn") ? "yarn" : "npm"
const npmCommand = process.platform === "win32" ? `${runnerName}.cmd` : runnerName
const clientAssetVersion = "20260901-image-log"

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: pluginRoot,
      stdio: "inherit",
      env: process.env,
    })
    child.once("error", reject)
    child.once("exit", code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(" ")} 退出码为 ${code ?? "unknown"}`))
    })
  })
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(filePath))
    else if (entry.isFile()) files.push(filePath)
  }
  return files
}

async function copyTree(source, target, filter = () => true) {
  await fs.cp(source, target, {
    recursive: true,
    filter,
  })
}

async function mergeTypeScriptRuntime() {
  const collisions = []
  const modules = []
  const files = await walk(typesRoot)
  for (const source of files) {
    if (!source.endsWith(".js")) continue
    const relative = path.relative(typesRoot, source)
    const target = path.join(runtimeRoot, relative)
    try {
      await fs.access(target)
      collisions.push(relative)
      continue
    } catch {
      // 目标不存在时才合并 TS 产物，避免覆盖静态资源或其他运行产物。
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(source, target)
    modules.push(relative)
    const sourceMap = `${source}.map`
    try {
      await fs.access(sourceMap)
      await fs.copyFile(sourceMap, `${target}.map`)
    } catch {
      // 当前 TS 构建不生成 source map；保留这个分支以支持后续切换配置。
    }
  }
  return { modules, collisions }
}

async function copyStaticAssets() {
  const staticRoots = []
  const resources = path.join(pluginRoot, "resources")
  const examples = path.join(pluginRoot, "examples")
  const webClient = path.join(pluginRoot, "web", "client")
  const sqliteMigrations = path.join(pluginRoot, "core", "storage", "sqlite", "migrations")
  const sqliteVectorMigrations = path.join(pluginRoot, "core", "storage", "sqlite", "vector-migrations")
  await copyTree(resources, path.join(runtimeRoot, "resources"))
  staticRoots.push("resources")
  await copyTree(examples, path.join(runtimeRoot, "examples"))
  staticRoots.push("examples")
  await copyTree(sqliteMigrations, path.join(runtimeRoot, "core", "storage", "sqlite", "migrations"))
  staticRoots.push("core/storage/sqlite/migrations")
  await copyTree(sqliteVectorMigrations, path.join(runtimeRoot, "core", "storage", "sqlite", "vector-migrations"))
  staticRoots.push("core/storage/sqlite/vector-migrations")

  const webTarget = path.join(runtimeRoot, "web", "client")
  await copyTree(webClient, webTarget, source => {
    const relative = path.relative(webClient, source)
    if (!relative) return true
    if (relative === "vendor" || relative.startsWith(`vendor${path.sep}`)) return true
    return ![".js", ".ts", ".map"].includes(path.extname(source))
  })
  staticRoots.push("web/client (非 JS/TS 与 vendor)")
  return staticRoots
}

async function versionClientModuleImports() {
  const clientRoot = path.join(runtimeRoot, "web", "client")
  for (const file of await walk(clientRoot)) {
    if (!file.endsWith(".js") || file.includes(`${path.sep}vendor${path.sep}`)) continue
    const source = await fs.readFile(file, "utf8")
    const versioned = source.replace(/((?:from\s+|import\s*\(\s*))(["'])(\.\.?\/[^"']+\.js)(\2)/g, (full, prefix, quote, spec) => {
      if (spec.includes("?")) return full
      return `${prefix}${quote}${spec}?v=${clientAssetVersion}${quote}`
    })
    if (versioned !== source) await fs.writeFile(file, versioned, "utf8")
  }
}

await fs.rm(runtimeRoot, { recursive: true, force: true })
await fs.rm(typesRoot, { recursive: true, force: true })
await fs.mkdir(outputRoot, { recursive: true })

// 先构建严格 TypeScript 业务模块，再构建管理台浏览器模块。
await run(npmCommand, ["run", "build:types"])
// 管理台浏览器代码使用独立模块目标，避免把 Node 宿主配置带入前端产物。
await run(npmCommand, ["run", "build:client"])
// 浏览器入口带版本号还不足以刷新已经缓存的子模块；对生产前端产物的相对模块导入统一加同一版本。
await versionClientModuleImports()

const { modules, collisions } = await mergeTypeScriptRuntime()
const staticRoots = await copyStaticAssets()
const manifest = {
  format: "yui-chat-runtime-build-v1",
  generatedAt: new Date().toISOString(),
  sourceRoot: pluginRoot,
  runtimeRoot,
  typescriptModules: modules.sort(),
  javascriptCollisions: collisions.sort(),
  staticRoots,
}
await fs.writeFile(
  path.join(runtimeRoot, "runtime-build-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
)
console.log(`ok runtime build: ${modules.length} TS modules, ${collisions.length} runtime collisions`)
