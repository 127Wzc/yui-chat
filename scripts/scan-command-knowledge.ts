import { scanCommandMetadata } from "../knowledge/command-scanner.js"
import { yunzaiRoot } from "../config/store.js"
// 在 Yunzai 根目录执行：node plugins/yui-chat/output/runtime/scripts/scan-command-knowledge.js > commands.json
try {
  const bundle = await scanCommandMetadata(yunzaiRoot)
  process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`指令元数据采集失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
