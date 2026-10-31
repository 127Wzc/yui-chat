import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createSSRApp, h } from "vue"
import { renderToString } from "vue/server-renderer"

globalThis.location = { hash: "", pathname: "/yui-chat", search: "", protocol: "http:", host: "localhost" }
const storageWrites = []
globalThis.localStorage = { getItem: () => null, setItem: (...args) => storageWrites.push(args) }
globalThis.WebSocket = class { constructor() { throw new Error("offline fixture") } }

const shellUrl = new URL("../output/runtime/web/client/app/app-shell.js", import.meta.url)
const { AppShell } = await import(shellUrl)
const storeImport = (await fs.readFile(shellUrl, "utf8")).match(/from "([^\"]*store\/store\.js[^\"]*)"/)[1]
const { store } = await import(new URL(storeImport, shellUrl))
const { components } = await import("../output/runtime/web/client/ui/components.js")

let view
const app = createSSRApp({ ...AppShell, setup() { view = AppShell.setup(); return view } })
for (const [name, component] of Object.entries(components)) app.component(name, component)
const html = await renderToString(app)
const form = html.match(/<form\b[^>]*class="login-form login-manual"[^>]*>[\s\S]*?<\/form>/)?.[0]
assert(form, "login is exposed as a dedicated form")
assert.match(form, /method="post"/)
const password = form.match(/<input\b[^>]*id="current-password"[^>]*>/)?.[0]
assert(password, "password manager receives a stable input identifier")
assert.match(password, /name="password"/)
assert.match(password, /type="password"/)
assert.match(password, /autocomplete="current-password"/)
const defaultFieldApp = createSSRApp({ render: () => h(components.Field, { label: "其他密钥", type: "password" }) })
defaultFieldApp.component("HelpTip", components.HelpTip)
const defaultField = await renderToString(defaultFieldApp)
assert.match(defaultField, /autocomplete="off"/, "other fields retain their existing autocomplete behavior")

class FakeForm { constructor(value) { this.value = value } }
class FakeFormData {
  constructor(form) { this.form = form }
  get(name) { return name === "password" ? this.form.value : null }
}
globalThis.HTMLFormElement = FakeForm
globalThis.FormData = FakeFormData
const requests = []
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, ...options })
  if (String(url).endsWith("/api/auth/session") && options.headers?.["yui-chat-token"] !== "fixture-valid-token") {
    return { ok: false, status: 401, json: async () => ({ ok: false, error: "令牌无效" }) }
  }
  if (!String(url).endsWith("/api/auth/session")) {
    assert.equal(options.headers?.["yui-chat-token"], undefined, "subsequent requests use the session rather than the static token")
    assert.equal(view.loginToken.value, "fixture-valid-token", "the autofilled value is kept until the successful form is removed")
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}

view.loginToken.value = "wrong-token"
await view.loginDirect({ currentTarget: new FakeForm("wrong-token") })
assert.equal(store.ready, false)
assert.equal(store.token, "")
assert.equal(view.loginToken.value, "wrong-token", "failed login keeps the value available for correction")
assert.match(view.loginError.value, /令牌无效/)

// A password manager may change the DOM value without updating the reactive model.
view.loginToken.value = "stale-reactive-value"
await view.loginDirect({ currentTarget: new FakeForm("fixture-valid-token") })
const sessionRequest = requests.filter(item => String(item.url).endsWith("/api/auth/session")).at(-1)
assert.equal(sessionRequest.headers["yui-chat-token"], "fixture-valid-token")
assert.equal(sessionRequest.body, "{}", "the token is sent in the existing authenticated header")
assert.equal(sessionRequest.credentials, "same-origin")
assert.equal(store.ready, true)
assert.equal(store.token, "")
assert.equal(view.loginToken.value, "")
assert(!JSON.stringify(storageWrites).includes("fixture-valid-token"))
console.log("ok web login: password-manager form semantics, autofilled DOM submission, failure retention and short-session transition")
