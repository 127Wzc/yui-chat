import { PLUGIN_COMMAND_PREFIX } from "../../../core/message/command-prefixes.js"
import crypto from "node:crypto"
import { configStore, redactConfigSecrets } from "../../../config/store.js"
import type { JsonValue } from "../../../core/message-chain/types.js"
import { actionRecord as record, actionCommand, figurineAction, actionExamples, matchAction, parseAction, parseActions, type ActionDefinition } from "../../../core/actions/contract.js"
import { actionAccess, bindActionArguments, runAction, validateActionArguments, resolveActionTool, defaultActionRole } from "../../../core/actions/execution.js"
import { formatActionReply } from "../../../core/actions/reply.js"
import { normalizeToolResult } from "../../../tools/support/execution-runtime.js"
import { resolveToolRuntimeConfig } from "../../../extensions/runtime-config.js"
import { directWebSearchSetupIssues } from "../../../tools/builtins/web-search.js"
import { actionCommandStatus } from "../../../core/runtime/host-command-registry.js"
import { toolRegistry } from "../../../tools/support/registry.js"
import { getToolCommon, validateToolArguments } from "../../../tools/support/contract.js"
import { boundaryRoles, boundaryRoleLabels } from "../../../tools/access/roles.js"
import { previewToolEvent } from "../../../tools/access/matrix.js"
import { backgroundTaskService } from "../../../core/scheduling/background-task-service.js"
import { requireWebAuth as auth } from "../auth.js"
import { handleRoute, type RouteApp } from "../route-handler.js"
import { updateConfigAndApply } from "../runtime-config.js"

const applyOptions = { reinitTools: false, reinitFilters: false, restartInitiativeGreeting: false, restartScheduleTasks: false }
function version(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20) }
function stale(): never { throw Object.assign(new Error("内容已被其他操作修改，请刷新后重新编辑。"), { statusCode: 409 }) }
function asJson(value: unknown): JsonValue { return value as JsonValue }
function newId(prefix = "action"): string { return `${prefix}-${crypto.randomUUID().slice(0, 8)}` }

function setupIssues(name: string, args: Record<string, unknown> = {}): string[] {
  const tool = toolRegistry.get(name)
  if (name !== "web_search" || !tool || getToolCommon(tool).source !== "builtin") return []
  const config = configStore.get()
  return directWebSearchSetupIssues(config, resolveToolRuntimeConfig(tool, config), args)
}

function checkDefinition(action: ActionDefinition): void {
  const tool = resolveActionTool(action)
  if (!tool) { if (action.enabled) throw new Error("关联工具不存在，请先安装工具或保存为停用动作"); return }
  if (action.kind === "source") return
  const common = getToolCommon(tool)
  if (record(common.policy).requiresModelContext === true) throw new Error("此工具需要模型会话，不能绑定动作")
  const schema = record(common.parameters)
  const defaultsValidation = validateToolArguments({ ...tool, common: { ...common, parameters: { ...schema, required: [] } } }, action.defaults)
  if (!defaultsValidation.ok) throw new Error(`默认参数无效：${defaultsValidation.issues.join("；")}`)
  const properties = record(schema.properties)
  for (const key of [action.textParam, ...(action.input.images === "none" ? [] : [action.input.imageParam]), ...action.overridable].filter(Boolean)) {
    if (!Object.hasOwn(properties, key)) throw new Error(`工具没有声明参数 ${key}`)
  }
}

export function actionCatalog() {
  const config = configStore.get()
  const actions = parseActions(config.actions)
  return {
    prefix: PLUGIN_COMMAND_PREFIX, enabled: actions.enabled, categories: actions.categories, categoriesVersion: version(actions.categories), runtime: { ...actionCommandStatus },
    roles: boundaryRoles.map(value => ({ value, label: boundaryRoleLabels[value] })),
    items: Object.values(actions.items).map(item => ({ ...item, setupIssues: item.kind === "tool" ? setupIssues(item.tool, item.defaults) : [], version: version(item), fullCommand: actionCommand(item), access: Object.fromEntries(boundaryRoles.map(role => [role, actionAccess(item, { ...previewToolEvent(role), ...(item.scope === "private" ? { isGroup: false, group_id: undefined, sender: {} } : {}) }, config)])) })),
    template: figurineAction(), examples: actionExamples(),
  }
}

export function registerActionRoutes(app: RouteApp): void {
  app.get("/api/actions", auth, handleRoute(async (_req, res) => {
    const tools = (await toolRegistry.list()).filter(item => record(getToolCommon(item).policy).requiresModelContext !== true).map(item => {
      const common = getToolCommon(item)
      return { name: item.name, label: common.displayNameZh || item.name, description: common.descriptionZh || common.description, source: common.source,
        parameters: common.parameters, minRole: defaultActionRole(item), setupIssues: setupIssues(String(item.name)), packageId: record(item).packageId || record(common).packageId || "" }
    })
    res.json({ ok: true, ...actionCatalog(), tools })
  }))
  app.post("/api/actions/reply-preview", auth, handleRoute((req, res) => {
    const action = parseAction({ ...record(req.body.action), kind: "tool", tool: "preview" })
    const value = req.body.sample
    const preview = formatActionReply({ ...normalizeToolResult(value), value }, action.reply)
    const fields: string[] = []
    function visit(value: unknown, path = "", depth = 0) {
      if (depth > 5 || fields.length >= 60 || !value || typeof value !== "object") return
      for (const [key, child] of Object.entries(value)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) continue
        const next = Array.isArray(value) ? `${path}[${key}]` : path ? `${path}.${key}` : key
        fields.push(next)
        if (fields.length >= 60) break
        visit(child, next, depth + 1)
      }
    }
    let parsed = value
    if (typeof value === "string") { try { parsed = JSON.parse(value) } catch { /* 纯文本样例没有字段列表。 */ } }
    visit(parsed)
    res.json({ ok: true, preview, fields })
  }, { errorStatus: 400 }))
  app.post("/api/actions/preview", auth, handleRoute((req, res) => {
    const action = parseAction(req.body.action)
    checkDefinition(action)
    const message = String(req.body.message || actionCommand(action))
    const input = matchAction(action, message)
    const role = String(req.body.role || "user")
    if (!(boundaryRoles as readonly string[]).includes(role)) throw new Error("角色无效")
    const event = { ...previewToolEvent(role), ...(req.body.scope === "private" ? { isGroup: false, group_id: undefined, sender: {} } : {}) }
    const imageCount = Math.max(0, Math.min(3, Number(req.body.imageCount) || 0))
    const images = Array.from({ length: imageCount }, (_, index) => `https://preview.invalid/image-${index + 1}.png`)
    const args = bindActionArguments(action, input || "", event, action.input.images === "none" ? undefined : images)
    const issues: string[] = action.kind === "tool" ? setupIssues(action.tool, args) : []
    if (input === null) issues.push("示例消息未命中当前动作")
    if (action.input.requireImage && !imageCount) issues.push("缺少必需的参考图片")
    try { validateActionArguments(action, args) } catch (error) { issues.push(error instanceof Error ? error.message : String(error)) }
    const config = configStore.get()
    const access = actionAccess(action, event, { ...config, actions: asJson({ ...parseActions(config.actions), items: { [action.id]: action } }) })
    const conflicts = Object.values(parseActions(configStore.get().actions).items).filter(item => item.id !== action.id && item.enabled && matchAction(item, message) !== null)
      .map(item => ({ name: item.name, stage: item.stage, priority: item.priority }))
    res.json({ ok: true, preview: { matched: input !== null, access, arguments: args, issues, conflicts, stage: action.stage, priority: action.priority,
      note: "仅模拟匹配和参数；未读取图片、导入模块或执行工具。第三方前置触发可能影响最终分发。" } })
  }, { errorStatus: 400 }))
  app.get("/api/actions/export", auth, handleRoute((req, res) => {
    const actions = parseActions(configStore.get().actions)
    const id = String(req.query.id || "")
    if (id && !actions.items[id]) throw new Error("动作不存在")
    res.json({ ok: true, bundle: { format: "yui-chat-actions", version: 1, categories: actions.categories, items: id ? [actions.items[id]] : Object.values(actions.items) } })
  }, { errorStatus: 400 }))
  app.post("/api/actions/import", auth, handleRoute(async (req, res) => {
    const bundle = record(req.body.bundle)
    if (bundle.format !== "yui-chat-actions" || bundle.version !== 1 || !Array.isArray(bundle.items)) throw new Error("不是受支持的动作配置包")
    const incoming = parseActions({ categories: bundle.categories, items: Object.fromEntries(bundle.items.map(value => { const item = parseAction(value); return [item.id, item] })) })
    if (Object.keys(incoming.items).length !== bundle.items.length) throw new Error("导入包中存在重复动作 ID")
    const prepared = Object.values(incoming.items).map(item => ({ ...item, id: newId(), enabled: false }))
    if (req.body.apply !== true) { res.json({ ok: true, preview: prepared, note: "导入后为停用状态，继续共享原工具实现；不会安装或启用工具。" }); return }
    const result = await updateConfigAndApply(config => {
      const current = parseActions(config.actions)
      const categoryMap = new Map<string, string>()
      for (const category of incoming.categories) {
        const found = current.categories.find(item => item.name === category.name)
        const id = found?.id || (current.categories.some(item => item.id === category.id) ? newId("category") : category.id)
        if (!found) current.categories.push({ id, name: category.name })
        categoryMap.set(category.id, id)
      }
      for (const item of prepared) current.items[item.id] = { ...item, categoryId: categoryMap.get(item.categoryId) || "" }
      config.actions = asJson(parseActions(current))
    }, {}, applyOptions)
    res.json({ ok: true, count: prepared.length, runtime: result.runtime })
  }, { errorStatus: 400 }))
  app.put("/api/actions/categories", auth, handleRoute(async (req, res) => {
    const result = await updateConfigAndApply(config => {
      const actions = parseActions(config.actions)
      if (req.body.version !== version(actions.categories)) stale()
      const categories = parseActions({ categories: req.body.categories }).categories
      const ids = new Set(categories.map(item => item.id))
      for (const item of Object.values(actions.items)) if (!ids.has(item.categoryId)) item.categoryId = ""
      actions.categories = categories
      config.actions = asJson(actions)
    }, {}, applyOptions)
    res.json({ ok: true, runtime: result.runtime })
  }, { errorStatus: 400 }))
  app.post("/api/actions", auth, handleRoute(async (req, res) => {
    const raw = record(req.body.action)
    const tool = toolRegistry.get(String(raw.tool || ""))
    const item = parseAction({ ...raw, minRole: raw.minRole ?? (tool ? defaultActionRole(tool) : "user") }, newId())
    checkDefinition(item)
    const result = await updateConfigAndApply(config => {
      const actions = parseActions(config.actions)
      actions.items[item.id] = item
      config.actions = asJson(parseActions(actions))
    }, {}, applyOptions)
    res.json({ ok: true, id: item.id, runtime: result.runtime })
  }, { errorStatus: 400 }))
  app.put("/api/actions/:id", auth, handleRoute(async (req, res) => {
    const item = parseAction(req.body.action, req.params.id)
    checkDefinition(item)
    const result = await updateConfigAndApply(config => {
      const actions = parseActions(config.actions)
      const current = actions.items[item.id]
      if (!current) throw new Error("动作不存在")
      if (req.body.version !== version(current)) stale()
      actions.items[item.id] = item
      config.actions = asJson(parseActions(actions))
    }, {}, applyOptions)
    res.json({ ok: true, runtime: result.runtime })
  }, { errorStatus: 400 }))
  app.delete("/api/actions/:id", auth, handleRoute(async (req, res) => {
    const result = await updateConfigAndApply(config => {
      const actions = parseActions(config.actions)
      const item = actions.items[req.params.id]
      if (!item) throw new Error("动作不存在")
      if (req.body.version !== version(item)) stale()
      delete actions.items[item.id]
      config.actions = asJson(actions)
    }, {}, applyOptions)
    res.json({ ok: true, runtime: result.runtime })
  }, { errorStatus: 400 }))
  app.post("/api/actions/:id/test", auth, handleRoute(async (req, res) => {
    const action = parseActions(configStore.get().actions).items[req.params.id]
    if (!action) throw new Error("动作不存在")
    if (req.body.version !== version(action)) stale()
    const images = req.body.images ?? []
    if (!Array.isArray(images) || images.length > 3 || images.some(value => typeof value !== "string" || !/^https?:\/\//.test(value) || value.length > 4000)) throw new Error("参考图必须是最多 3 个 HTTP(S) 地址")
    const result = await runAction(action, String(req.body.text || ""), { isMaster: true, isGroup: false, user_id: "web-action-test" }, { web: true, images })
    res.json({ ok: true, result: redactConfigSecrets(result), note: "真实执行已保存的动作；当前浏览器不具备机器人会话投递目标。" })
  }, { errorStatus: 400 }))
  app.get("/api/actions/:id/tasks/:taskId", auth, handleRoute((req, res) => {
    const task = backgroundTaskService.get(req.params.taskId)
    if (!task || task.parentToolId !== `action:${req.params.id}`) throw new Error("任务不存在或已过期")
    const action = parseActions(configStore.get().actions).items[req.params.id]
    let reply: unknown = null
    if (action && task.status === "ok") {
      try { reply = formatActionReply({ ...normalizeToolResult(task.result), value: task.result }, action.reply) } catch (error) { reply = { message: error instanceof Error ? error.message : String(error), parts: [], note: "回复配置需要调整" } }
    }
    res.json({ ok: true, task: redactConfigSecrets({ ...task, reply }) })
  }, { errorStatus: 400 }))
}
