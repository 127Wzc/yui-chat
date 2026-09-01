import path from "node:path"
import { fileURLToPath } from "node:url"
import { configStore } from "../../config/store.js"

const assetVersion = "20260901-image-log"
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export const staticRoot = path.join(webRoot, "client")

function escapeHtmlAttribute(value: unknown = ""): string {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function renderWebShell({ nonce = "" }: { nonce?: unknown } = {}): string {
  const mountPath = String(configStore.get().web?.mountPath || "/yui-chat")
  const basePath = `${mountPath.replace(/\/$/, "")}/`
  const vueModuleUrl = JSON.stringify(`${basePath}assets/vendor/vue.esm-browser.prod.js`).replace(/</g, "\\u003c")
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Yui Chat Console</title>
  <base href="${escapeHtmlAttribute(basePath)}" />
  <script nonce="${escapeHtmlAttribute(nonce)}">try{var t=localStorage.getItem("yui-chat-theme");document.documentElement.dataset.theme=t==="dark"?"dark":"light"}catch(e){document.documentElement.dataset.theme="light"}</script>
  <link rel="stylesheet" href="assets/app.css?v=${assetVersion}" />
  <script nonce="${escapeHtmlAttribute(nonce)}" type="importmap">
    {"imports": {"vue": ${vueModuleUrl}}}
  </script>
</head>
<body>
  <div id="app" class="app-shell"></div>
  <script nonce="${escapeHtmlAttribute(nonce)}" type="module" src="assets/main.js?v=${assetVersion}"></script>
</body>
</html>`
}
