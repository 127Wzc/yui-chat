// 依赖安装后自动生成 output/runtime，避免宿主加载时才发现缺少运行产物。
// 构建失败只告警不阻断：Yunzai 根目录的一次 pnpm i 会安装全部插件，
// 单个插件的构建错误不应让整个宿主安装失败，由 index.js 的产物检查兜底。
try {
  await import("./build-runtime.mjs")
} catch (error) {
  console.error(`[yui-chat] 运行产物自动构建失败：${error?.message ?? error}`)
  console.error("[yui-chat] 请进入 plugins/yui-chat 手动执行 pnpm run build:runtime")
}
