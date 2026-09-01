import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Yunzai 只加载这一层 JS 宿主入口；实际生产业务从构建后的 runtime-entry.js 启动。
// 通过 YUI_CHAT_PLUGIN_ROOT 固定源码资源根、宿主数据根和编译产物之间的定位关系。
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
process.env.YUI_CHAT_PLUGIN_ROOT ||= pluginRoot
const compiledEntry = path.join(pluginRoot, "output", "runtime", "runtime-entry.js")
try {
  await fs.access(compiledEntry)
} catch {
  throw new Error("Yui Chat 尚未生成运行产物，请在 plugins/yui-chat 执行 pnpm run build:runtime")
}

const runtime = await import(pathToFileURL(compiledEntry).href)

// Smoke 会同时验证源码导入的命令模块；把它们的 ConfigStore 接到同一个编译产物
// SQLite 单例，避免测试因 ESM URL 不同而创建两套运行态。生产不设置该标记。
if (process.env.YUI_CHAT_SMOKE_RUNTIME_ROOT) {
  const [{ configStore }, { sqliteClient }, { SqliteRuntimeConfigRepository }] = await Promise.all([
    import("./output/runtime/config/store.js"),
    import("./output/runtime/core/storage/sqlite/client.js"),
    import("./output/runtime/core/storage/sqlite/runtime-config-repository.js"),
  ])
  if (sqliteClient.status.available) {
    await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  }
}

export const apps = runtime.apps
