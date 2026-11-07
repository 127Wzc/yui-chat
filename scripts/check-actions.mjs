import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { once } from "node:events"
import express from "express"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const root = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-actions-"))
process.env.YUI_CHAT_RUNTIME_ROOT = root
process.env.YUI_CHAT_PLUGIN_ROOT = pluginRoot
process.chdir(path.resolve(pluginRoot, "../.."))
global.logger = { mark() {}, info() {}, warn() {}, error: console.error, debug() {}, blue: v => v, cyan: v => v, red: v => v }
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = { at: v => ({ type: "at", qq: v }), image: v => ({ type: "image", file: v }), reply: v => ({ type: "reply", id: v }) }
global.plugin = class {
  constructor(options = {}) { Object.assign(this, options) }
  async reply(value) { return this.e.reply(value) }
}
let server, sqliteClient, modelLogStore, sourceFixture
try {
  const { configStore } = await import("../output/runtime/config/store.js")
  const { parseAction, parseActions, figurineAction, matchAction, actionRule } = await import("../output/runtime/core/actions/contract.js")
  const { bindActionArguments, runAction, actionAccess, defaultActionRole, resolveActionTool } = await import("../output/runtime/core/actions/execution.js")
  const { formatActionReply, formatImageActionReply, extractActionResult } = await import("../output/runtime/core/actions/reply.js")
  const { normalizeToolResult } = await import("../output/runtime/tools/support/execution-runtime.js")
  const { WebSearchTool, directWebSearchSetupIssues } = await import("../output/runtime/tools/builtins/web-search.js")
  const { actionParameterFields, parameterInputValue, parseParameterInput, updateParameterValue } = await import("../output/runtime/web/client/features/actions/parameter-fields.js")
  const { actionEditorIssues } = await import("../output/runtime/web/client/features/actions/validation.js")
  const { createActionEntries, actionHelp } = await import("../output/runtime/apps/actions.js")
  const { replaceActionEntries } = await import("../output/runtime/core/runtime/host-command-registry.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { backgroundTaskService } = await import("../output/runtime/core/scheduling/background-task-service.js")
  const { clearResponseState } = await import("../output/runtime/core/chat/response-pipeline.js")
  const { muteScope, clearMutedScopes } = await import("../output/runtime/core/chat/access-control.js")
  const { createWebApp } = await import("../output/runtime/web/http/app.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  ;({ modelLogStore } = await import("../output/runtime/core/observability/model-log.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  const initial = await configStore.load()
  await sqliteClient.init(initial)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  let calls = 0
  let lastArgs
  const echo = { name: "action_echo", source: "builtin", category: "utility", risk: "low", tags: ["test"], policy: {}, parameters: { type: "object", properties: { text: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 3 } }, required: ["text"] }, execution: { effect: "read" }, execute: async args => { calls++; lastArgs = args; return `收到：${args.text}` } }
  toolRegistry.register(echo)
  toolRegistry.register(new WebSearchTool())
  toolRegistry.register({ ...echo, name: "model_only", policy: { requiresModelContext: true } })
  toolRegistry.register({ ...echo, name: "generate_image", category: "media", parameters: { type: "object", properties: { prompt: { type: "string" }, count: { type: "integer" }, aspectRatio: { type: "string" }, referenceImages: { type: "array", items: { type: "string" } } }, required: ["prompt"] }, execute: async args => { calls++; lastArgs = args; return "模拟图片完成" } })
  toolRegistry.register({ ...echo, name: "action_master", policy: { requiresMaster: true } })
  let releaseBackground
  const wait = new Promise(resolve => { releaseBackground = resolve })
  toolRegistry.register({ ...echo, name: "action_background", execution: { effect: "non_idempotent", background: true, maxAttempts: 1 }, backgroundQueue: () => ({ queueKey: "action-test", maxConcurrent: 1, maxQueue: 1 }), execute: async args => { if (args.text === "hold") await wait; calls++; return args.text } })
  const base = parseAction({ id: "echo", name: "回声", command: "回声", tool: "action_echo", textParam: "text", textTemplate: "你好 {{userName}}：{{text}}", defaults: { count: 1 }, categoryId: "lookup" })
  await configStore.update(config => {
    config.web.authToken = "actions-test-local"
    config.chat.rateLimit.enabled = false
    config.tools.enabled = true
    config.tools.enabledTools = ["action_echo", "action_master", "action_background", "generate_image"]
    config.tools.policy.allowExternalNetwork = true
    config.actions.items = { echo: base, figurine: figurineAction() }
  })
  const app = express()
  app.use("/yui-chat", createWebApp())
  server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${server.address().port}`
  const baseUrl = `${origin}/yui-chat`
  async function api(url, method = "GET", body, authorized = true) {
    const response = await fetch(`${baseUrl}${url}`, { method, headers: { "content-type": "application/json", ...(authorized ? { "yui-chat-token": "actions-test-local" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  if (process.argv.includes("--serve")) {
    await (await import("../output/runtime/filters/core/registry.js")).filterRegistry.init()
    console.log(`Actions preview: ${baseUrl}/#actions`)
    console.log("Use the isolated test credential actions-test-local. All tool executions are local mocks.")
    await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve) })
  } else {
    assert.equal((await api("/api/actions", "GET", undefined, false)).status, 401)
    assert.equal((await api("/api/actions", "POST", { action: base }, false)).status, 401)
    const listing = await api("/api/actions")
    assert.equal(listing.status, 200)
    assert.equal(listing.body.items.length, 2)
    assert.equal(listing.body.prefix, "#yui")
    assert.equal(listing.body.roles.length, 4)
    assert.equal(listing.body.examples.length, 2)
    assert.deepEqual(listing.body.templateGroups.map(group => [group.id, group.items.length]), [["drawing",1],["lookup",1],["entertainment",1],["project",1]])
    assert(listing.body.templateGroups.flatMap(group => group.items).every(item => item.enabled === false), "templates do not enable or register actions")
    assert.equal(listing.body.templateGroups[0].items[0].minRole, defaultActionRole(toolRegistry.get("generate_image")), "template drafts inherit the current tool role")
    assert.equal(listing.body.templateGroups[2].items[0].minRole, "master", "unavailable tools do not default to public access")
    const sourceTemplate = listing.body.templateGroups[3].items[0]
    assert.equal(sourceTemplate.minRole, defaultActionRole(resolveActionTool(sourceTemplate)), "source drafts inherit their actual execution policy")
    assert.equal(Object.keys(configStore.get().actions.items).length, 2, "listing templates does not modify configuration")
    const imageTemplate = listing.body.templateGroups[0].items[0]
    assert.equal(imageTemplate.textTemplate, "", "the generic drawing template adds no fixed prompt")
    assert.equal(imageTemplate.input.mode, "text")
    assert.equal(imageTemplate.input.requireImage, false)
    assert.equal(imageTemplate.input.avatarFallback, false)
    const genericPreview = await api("/api/actions/preview", "POST", {action:imageTemplate,message:"#yui画图 雨中的橘猫",imageCount:0})
    assert.equal(genericPreview.status, 200)
    assert.equal(genericPreview.body.preview.arguments.prompt, "雨中的橘猫", "ordinary command text becomes the drawing prompt")
    assert.deepEqual(genericPreview.body.preview.arguments.referenceImages, [], "drawing works without a reference or automatic avatar")
    const originalActions = structuredClone(configStore.get().actions.items)
    const savedDrawing = await api("/api/actions", "POST", {action:imageTemplate})
    assert.equal(savedDrawing.status, 200)
    assert.equal(configStore.get().actions.items[savedDrawing.body.id].enabled, false)
    for (const [id, action] of Object.entries(originalActions)) assert.deepEqual(configStore.get().actions.items[id], action, "creating a template does not alter saved actions")
    await configStore.update(config=>{delete config.actions.items[savedDrawing.body.id]})
    assert.deepEqual(listing.body.examples.map(item=>item.kind), ["tool", "source"])
    assert(listing.body.examples.every(item=>item.enabled === false))
    const exampleDraft = listing.body.examples[0]
    const savedExample = await api("/api/actions", "POST", {action:exampleDraft})
    assert.equal(savedExample.status,200)
    const savedExampleItem = (await api("/api/actions")).body.items.find(item=>item.id===savedExample.body.id)
    assert.equal(savedExampleItem.enabled,false,"saving a prefilled example does not enable it")
    await assert.rejects(runAction(savedExampleItem,"",{user_id:"example",isGroup:false,isMaster:true}),/停用/)
    await configStore.update(config=>{delete config.actions.items[savedExample.body.id]})
    const helpDraft = listing.body.examples[1]
    assert.equal(helpDraft.source.exportName,"sendPluginHelp")
    const savedHelp = await api("/api/actions","POST",{action:helpDraft})
    assert.equal(savedHelp.status,200)
    assert.equal(configStore.get().actions.items[savedHelp.body.id].enabled,false)
    const responseBefore = structuredClone(configStore.get().response)
    await configStore.update(config=>{config.actions.items[savedHelp.body.id].enabled=true;config.response.render.system.engine="svg"})
    const helpReplies=[]
    const helpResult=await runAction(configStore.get().actions.items[savedHelp.body.id],"",{user_id:"help-user",isGroup:false,reply:async value=>helpReplies.push(value)})
    assert.equal(helpReplies.length,1,"source help sends exactly one reply")
    assert.equal(helpReplies[0].type,"image","source help renders a real image")
    assert.equal(helpResult.message,"","source reply must not be sent twice")
    const { buildHelpMenuHtml } = await import("../output/runtime/core/rendering/render-html-service.js")
    const html=buildHelpMenuHtml({title:"<script>bad</script>",groups:[{title:"聊天",commands:[{command:"#yuichat",description:"hello"}]},{title:"管理",commands:[{command:"#yui面板",permission:"master"}]}]})
    assert(!html.includes("<script>"),"help text is escaped")
    assert.equal((html.match(/<section>/g)||[]).length,2)
    assert(html.includes("主人"))
    await configStore.update(config=>{delete config.actions.items[savedHelp.body.id];config.response=responseBefore})
    assert.equal(base.minRole, "user")
    const parameterSchema = { type:"object", properties:{ query:{type:"string"}, tags:{type:"array",items:{type:"string"}}, options:{type:"object"}, count:{type:"integer",enum:[1,2],default:1,minimum:1,maximum:2}, active:{type:"boolean"} }, required:["query","tags"] }
    const editorAction = {...base,textParam:"query",textTemplate:"{{text}}"}
    assert.deepEqual(actionEditorIssues(editorAction,'{"tags":["ok"]}',parameterSchema,[],[]),[])
    assert.deepEqual(actionEditorIssues({...editorAction,name:""},'{"tags":["ok"]}',parameterSchema,[],[]),[],"a command does not need a separate name")
    assert(actionEditorIssues({...editorAction,textTemplate:"{{unknown}}"},'{"tags":[]}',parameterSchema,[],[]).some(issue=>issue.step===2 && issue.message.includes("unknown")))
    assert(actionEditorIssues(editorAction,'{"tags":[1]}',parameterSchema,[],[]).some(issue=>issue.message.includes("tags[0]")))
    assert(actionEditorIssues(editorAction,'{}',parameterSchema,[],[]).some(issue=>issue.message.includes("必填参数 tags")))
    assert(actionEditorIssues(editorAction,'{',parameterSchema,[],[]).some(issue=>issue.message.includes("JSON")))
    assert(actionEditorIssues({...editorAction,reply:{path:"data[bad]",template:"{{userName}}"}},'{"tags":[]}',parameterSchema,[],[]).filter(issue=>issue.step===3).length===2)
    assert(actionEditorIssues({...editorAction,priority:1.5},'{"tags":[]}',parameterSchema,[],[]).some(issue=>issue.step===0))
    assert(actionEditorIssues({...editorAction,input:{images:"none",requireImage:true}},'{"tags":[]}',parameterSchema,[],[]).some(issue=>issue.message.includes("图片来源")))
    const parameterFields = actionParameterFields(parameterSchema,["query"])
    assert.deepEqual(parameterFields.map(field=>field.key),["tags","options","count","active"])
    assert.equal(parameterFields[0].required,true)
    assert.equal(parameterFields[0].type,"textarea")
    assert.equal(parameterFields[1].type,"textarea")
    assert(parameterFields[2].hint.includes("工具默认：1"))
    for (const [name,value] of [["tags",["a","b"]],["options",{a:1}],["count",2],["active",false]]) {
      const schema = parameterSchema.properties[name]
      assert.deepEqual(parseParameterInput(schema,parameterInputValue(schema,value)),value)
    }
    assert.equal(parseParameterInput({type:"string",enum:["", "auto"]},'""'),"", "empty enum strings differ from inheriting defaults")
    assert.equal(parseParameterInput({type:"integer"},""),undefined)
    assert.throws(()=>parseParameterInput({type:"array"},"{}"),/数组/)
    assert.throws(()=>parseParameterInput({type:"object"},"[]"),/对象/)
    assert.throws(()=>parseParameterInput({type:"integer"},1.5),/整数/)
    assert.throws(()=>parseParameterInput({type:"integer",minimum:1},0),/小于/)
    assert.throws(()=>parseParameterInput({type:"array"},"["))
    const inherited = {count:2,options:{keep:true}}
    assert.deepEqual(updateParameterValue(inherited,"count",undefined),{options:{keep:true}})
    assert.equal(inherited.count,2,"editing a copied preset does not mutate the original")
    const channelConfig = {tools:{builtin:{webSearch:{enabledSources:[]}}}}
    assert(directWebSearchSetupIssues(channelConfig,{}).some(issue=>issue.includes("尚未启用")))
    assert.equal(await new WebSearchTool().execute({query:"搜下今日黄金"},{config:channelConfig}),"实时网络搜索没有启用任何渠道。")
    assert.deepEqual(directWebSearchSetupIssues({tools:{builtin:{webSearch:{enabledSources:["tavily"]}}}},{tavilyApiKey:"configured"}),[])
    assert(directWebSearchSetupIssues({tools:{builtin:{webSearch:{enabledSources:["tavily"]}}}},{tavilyApiKey:"configured"},{source:"baidu-ai"})[0].includes("尚未启用"))
    assert(directWebSearchSetupIssues({tools:{builtin:{webSearch:{enabledSources:["tavily"]}}}},{}).some(issue=>issue.includes("API Key")))
    const oldSearchConfig = configStore.get().tools.builtin.webSearch
    await configStore.update(config=>{
      config.tools.builtin.webSearch.enabledSources=[]
      config.tools.runtimeVariables.web_search={baiduApiKey:"private-search-key",tavilyApiKey:"private-tavily-key"}
    })
    const searchAction = parseAction({id:"search-preview",name:"网络搜索",command:"网络搜索",tool:"web_search",textParam:"query",textTemplate:"搜下今日黄金",defaults:{source:"auto",searchDepth:"basic"}})
    const searchPreview = await api("/api/actions/preview","POST",{action:searchAction,message:"#yui网络搜索"})
    assert.equal(searchPreview.body.preview.arguments.query,"搜下今日黄金")
    assert(searchPreview.body.preview.issues.some(issue=>issue.includes("尚未启用")))
    const setupCatalog = await api("/api/actions")
    assert(setupCatalog.body.tools.find(tool=>tool.name === "web_search").setupIssues.some(issue=>issue.includes("尚未启用")))
    assert(!JSON.stringify(setupCatalog.body).includes("private-search-key"))
    assert(!JSON.stringify(setupCatalog.body).includes("private-tavily-key"))
    await configStore.update(config=>{config.tools.builtin.webSearch=oldSearchConfig;delete config.tools.runtimeVariables.web_search})
    assert.equal(matchAction(base, "#yui回声 hello"), "hello")
    assert.equal(matchAction(base, "#yui回声词"), null)
    const noteAction = parseAction({ ...base, name:"", command:"简洁回声", description:"这是一条备注" })
    assert.equal(noteAction.name, "简洁回声", "the command supplies the internal name when omitted")
    assert.equal(parseAction({ ...base, name:undefined }).name, "回声")
    assert.throws(() => parseAction({ ...base, name:42 }), /名称必须是文字/)
    assert.equal(matchAction(noteAction, "#yui简洁回声 hello"), "hello")
    assert.equal(matchAction(noteAction, "#yui这是一条备注"), null, "remarks never become triggers")
    assert.equal(matchAction({ ...noteAction, name:"历史展示名" }, "#yui历史展示名"), null, "display names never become triggers")
    const createdNote = await api("/api/actions", "POST", { action:{...noteAction,name:"",enabled:false} })
    assert.equal(createdNote.status, 200)
    const storedNote = configStore.get().actions.items[createdNote.body.id]
    assert.equal(storedNote.name, "简洁回声")
    assert.equal(storedNote.description, "这是一条备注")
    await configStore.update(config=>{delete config.actions.items[createdNote.body.id]})
    assert.equal(base.ignorePrefix, false, "existing actions require the configured prefix")
    assert.equal(matchAction(base, "回声 hello"), null)
    const noPrefix = parseAction({ ...base, aliases: ["复述", "再说"], ignorePrefix: true })
    for (const [message, expected] of [["回声", ""], ["#yui回声 hello", "hello"], ["回声 hello", "hello"], ["复述 测试", "测试"], ["#yui复述 测试", "测试"], ["再说 内容", "内容"]]) {
      assert.equal(matchAction(noPrefix, message), expected, `optional prefix supports ${message}`)
      assert(new RegExp(actionRule(noPrefix)).test(message), "the host rule matches the same forms")
    }
    for (const message of ["回声词", "复述一下", "请复述 测试", "#其他复述 测试"]) assert.equal(matchAction(noPrefix, message), null, "a command must be complete and at the start")
    const literal = parseAction({ ...noPrefix, command: "回声.+", aliases: [] })
    assert.equal(matchAction(literal, "回声.+ 内容"), "内容")
    assert.equal(matchAction(literal, "回声XX 内容"), null, "command text is escaped before constructing rules")
    assert.throws(() => parseAction({ ...base, ignorePrefix: "true" }), /开关/)
    assert.throws(() => parseAction({ ...base, command: "面板" }), /保留/)
    assert.throws(() => parseAction({ ...base, minRole: "superuser" }), /无效/)
    assert.throws(() => parseAction({ ...base, defaults: { token: "secret" } }), /不允许/)
    assert.throws(() => parseAction({ ...base, defaults: JSON.parse('{"__proto__":{"isMaster":true}}') }), /不允许/)
    assert.throws(() => parseAction({ ...base, textTemplate: "{{process.env}}" }), /变量/)
    assert.throws(() => parseAction({ ...base, input: [] }), /输入/)
    assert.throws(() => parseAction({ ...base, overridable: ["text"] }), /覆盖/)
    assert.throws(() => parseActions({ categories: [{id:"lookup",name:"查询"}], items: { echo: base, dupe: { ...base, id: "dupe" } } }), /已被其他/)
    assert.throws(() => parseActions({ categories: [{id:"lookup",name:"查询"}], items: { echo: base, dupe: { ...base, id: "dupe", priority: 100, stage: "accept" } } }), /已被其他/)
    const aliasConflict = { ...base, id: "dupe", command: "另一入口", aliases: [base.command], priority: 100 }
    assert.throws(() => parseActions({ categories: [{id:"lookup",name:"查询"}], items: { echo: base, dupe: aliasConflict } }), /已被其他/)
    assert.doesNotThrow(() => parseActions({ categories: [{id:"lookup",name:"查询"}], items: { echo: base, dupe: {...aliasConflict, enabled:false} } }))
    const rejectedDuplicate = await api("/api/actions", "POST", {action:aliasConflict})
    assert.equal(rejectedDuplicate.status, 400, "save rejects aliases owned by another active action")
    const copy = parseAction({ ...base, id: "copy", command: "回声二", aliases: ["再说"], ignorePrefix: true })
    copy.defaults.count = 2
    assert.equal(base.defaults.count, 1)
    assert.equal(copy.tool, base.tool)
    const event = { user_id: "user-1", isGroup: true, group_id: "group-1", sender: { nickname: "小明", role: "member" }, reply: async () => {} }
    const savedFree = await api("/api/actions", "POST", { action: { ...base, name:"免前缀验证", command:"直接回声", description:"旧动作备注", aliases:["直说"], ignorePrefix:true, minRole:"master" } })
    assert.equal(savedFree.status, 200)
    const freeItem = (await api("/api/actions")).body.items.find(item => item.id === savedFree.body.id)
    assert.equal(freeItem.ignorePrefix, true, "the setting is persisted and returned by the API")
    const freePreview = await api("/api/actions/preview", "POST", { action:freeItem, message:"直说 测试", role:"user" })
    assert.equal(freePreview.body.preview.matched, true)
    assert.equal(freePreview.body.preview.access.allowed, false, "unprefixed previews retain the action's permissions")
    assert.equal(freePreview.body.preview.arguments.text, "你好 10001：测试")
    const freeEntry = createActionEntries(configStore.get()).find(item => item.name.includes("免前缀验证"))
    assert(freeEntry.plugin.rule[0].reg.test("直接回声 测试"))
    assert(freeEntry.plugin.rule[0].reg.test("直说 测试"))
    const freeReplies = [], callsBeforeFree = calls
    const deniedFree = new freeEntry.class()
    deniedFree.e = { ...event, msg:"直说 测试", message_id:"free-denied", reply:async value => freeReplies.push(value) }
    await deniedFree.run()
    assert.equal(calls, callsBeforeFree, "unprefixed commands do not bypass authorization")
    assert(freeReplies.some(value => String(value).includes("权限")))
    const acceptedFree = new freeEntry.class()
    acceptedFree.e = { ...event, isMaster:true, msg:"直接回声 测试", message_id:"free-allowed", reply:async value => freeReplies.push(value) }
    await acceptedFree.run()
    assert.equal(calls, callsBeforeFree + 1, "the registered command executes after authorization")
    assert.equal(lastArgs.text, "你好 小明：测试")
    const helpFree = actionHelp({ ...event, isMaster:true, msg:"#yui指令说明 免前缀验证" })
    assert(helpFree.includes("#yui直说") && helpFree.includes("可省略前缀") && helpFree.includes("备注：旧动作备注"), "help explains the alias, remark and optional prefix")
    const prefixRequired = await api("/api/actions/" + freeItem.id, "PUT", { action:{...freeItem,ignorePrefix:false,description:"修改后的备注"}, version:freeItem.version })
    assert.equal(prefixRequired.status, 200)
    assert.equal(configStore.get().actions.items[freeItem.id].name, "免前缀验证", "editing a remark preserves a legacy display name")
    assert.equal(configStore.get().actions.items[freeItem.id].description, "修改后的备注")
    const updatedEntry = createActionEntries(configStore.get()).find(item => item.name.includes("免前缀验证"))
    assert.equal(updatedEntry.plugin.rule[0].reg.test("直说 测试"), false, "updated host rules require the prefix again")
    const staleFree = new freeEntry.class()
    staleFree.e = { ...event, isMaster:true, msg:"直说 测试", message_id:"free-stale", reply:async value => freeReplies.push(value) }
    assert.equal(await staleFree.run(), false, "a stale host entry rechecks the saved prefix setting")
    assert.equal(calls, callsBeforeFree + 1)
    await configStore.update(config=>{delete config.actions.items[savedFree.body.id]})

    // 用真实编辑器状态和本地 HTTP 路由验证新动作与旧展示名的保存、复制和预览。
    const originalFetch = global.fetch, originalLocation = global.location, originalStorage = global.localStorage
    global.location = { pathname:"/yui-chat", hash:"#actions", search:"" }
    global.localStorage = { getItem() { return null } }
    global.fetch = (url, options) => originalFetch(new URL(String(url), origin), options)
    const uiIds = []
    let editorApp
    try {
      const { createRenderer, h, compile } = await import("vue")
      const clientModule = new URL("../output/runtime/web/client/features/actions/actions-tab.js", import.meta.url)
      const storeSpecifier = (await fs.readFile(clientModule, "utf8")).match(/from "([^"]+store\/store\.js[^"]*)"/)?.[1]
      assert(storeSpecifier)
      const { store:clientStore } = await import(new URL(storeSpecifier, clientModule).href)
      const { ActionsTab } = await import(clientModule.href)
      compile(ActionsTab.template, { onError(error) { throw error } })
      clientStore.token = "actions-test-local"
      clientStore.actions = (await api("/api/actions")).body
      const renderer = createRenderer({ createElement:tag=>({tag}), createComment:()=>({}), createText:()=>({}), patchProp(){}, insert(){}, remove(){}, setElementText(){}, setText(){}, parentNode(){return null}, nextSibling(){return null} })
      let editor
      editorApp = renderer.createApp({ setup() { editor = ActionsTab.setup(); return () => h("div") } })
      editorApp.mount({})
      await editor.open()
      editor.draft.command = "空白动作"
      editor.selectTool("action_echo")
      editor.draft.enabled = false
      await editor.save()
      assert.equal(editor.editorError.value, "")
      const blankId = editor.editingId.value
      uiIds.push(blankId)
      assert.equal(configStore.get().actions.items[blankId].name, "空白动作", "blank actions also need no separately entered name")
      assert.equal(configStore.get().actions.items[blankId].description, "")
      await editor.close()
      await editor.fromTemplate(clientStore.actions.templateGroups[0].items[0])
      editor.draft.command = "画图甲"
      editor.draft.description = ""
      await editor.save()
      assert.equal(editor.editorError.value, "")
      const newId = editor.editingId.value
      uiIds.push(newId)
      assert.equal(configStore.get().actions.items[newId].name, "画图甲", "new template drafts need no separately entered name")
      await editor.close()
      await editor.open(clientStore.actions.items.find(item=>item.id===newId))
      editor.draft.command = "画图乙"
      editor.replyStage.value = "start"
      await editor.previewReply()
      assert(editor.replyPreview.value.message.includes("画图乙"), "new replies follow a changed command before saving")
      await editor.save()
      assert.equal(editor.editorError.value, "")
      assert.equal(configStore.get().actions.items[newId].name, "画图乙", "new names continue to follow an edited command")
      await editor.close()

      const legacyCreated = await api("/api/actions", "POST", {action:{...imageTemplate,name:"历史展示名",command:"旧画图",description:"旧备注",enabled:false}})
      assert.equal(legacyCreated.status, 200)
      const legacyId = legacyCreated.body.id
      uiIds.push(legacyId)
      clientStore.actions = (await api("/api/actions")).body
      await editor.open(clientStore.actions.items.find(item=>item.id===legacyId))
      assert.equal(editor.preserveLegacyName.value, true)
      editor.draft.command = "更新的画图"
      editor.draft.description = "更新的备注"
      editor.replyStage.value = "start"
      await editor.previewReply()
      assert(editor.replyPreview.value.message.includes("历史展示名"), "legacy reply previews keep the saved display name")
      await editor.save()
      assert.equal(editor.editorError.value, "")
      assert.equal(configStore.get().actions.items[legacyId].name, "历史展示名", "editing a legacy command preserves its display name")
      assert.equal(configStore.get().actions.items[legacyId].description, "更新的备注")
      await editor.close()
      await editor.open(clientStore.actions.items.find(item=>item.id===legacyId), true)
      const copyCommandName = editor.draft.command
      await editor.save()
      assert.equal(editor.editorError.value, "")
      const copyId = editor.editingId.value
      uiIds.push(copyId)
      assert.equal(configStore.get().actions.items[copyId].name, copyCommandName, "a copied action uses its own command as its name")
      assert.equal(configStore.get().actions.items[legacyId].name, "历史展示名")
    } finally {
      editorApp?.unmount()
      global.fetch = originalFetch; global.location = originalLocation; global.localStorage = originalStorage
      if (uiIds.length) await configStore.update(config=>{for (const id of uiIds) delete config.actions.items[id]})
    }
    assert.equal(actionAccess(base, event, configStore.get()).allowed, true)
    for (const [minRole, role, isMaster, allowed] of [["groupAdmin","member",false,false],["groupAdmin","admin",false,true],["groupOwner","admin",false,false],["groupOwner","owner",false,true],["master","owner",false,false],["master","member",true,true]]) {
      assert.equal(actionAccess({ ...base, minRole }, { ...event, isMaster, sender: {role} }, configStore.get()).allowed, allowed)
    }
    assert.equal(actionAccess({ ...base, minRole: "groupAdmin" }, { ...event, isGroup: false, group_id: undefined, sender: { role: "owner" } }, configStore.get()).allowed, false)
    assert.equal(actionAccess({ ...base, tool: "action_master" }, event, configStore.get()).allowed, false)
    const { explainToolPolicy } = await import("../output/runtime/tools/access/policy.js")
    assert(!listing.body.tools.some(tool => tool.name === "model_only"))
    assert.equal((await api("/api/actions", "POST", {action:{...base,command:"模型专用",tool:"model_only"}})).status,400)
    assert.equal(defaultActionRole(toolRegistry.get("action_master")),"master")
    const inheritedAction = await api("/api/actions", "POST", {action:{...base,command:"继承权限",tool:"action_master",minRole:undefined}})
    assert.equal(inheritedAction.status,200)
    assert.equal(configStore.get().actions.items[inheritedAction.body.id].minRole,"master")
    await configStore.update(config=>{delete config.actions.items[inheritedAction.body.id]})
    const toolsBefore = structuredClone(configStore.get().tools)
    await configStore.update(config=>{config.tools.enabled=false;config.tools.enabledTools=[]})
    assert.equal(explainToolPolicy(toolRegistry.get(base.tool),{e:event}).allowed,false)
    assert.equal(actionAccess(base,event,configStore.get()).allowed,true)
    assert.match((await runAction(base,"独立启停",event)).message,/独立启停/)
    assert.equal(explainToolPolicy(toolRegistry.get(base.tool),{e:event,actionId:"missing"}).allowed,false)
    await configStore.update(config=>{config.tools=toolsBefore;config.actions.items.echo={...base,tool:"action_master"}})
    const independent = configStore.get().actions.items.echo
    assert.equal(actionAccess(independent,event,configStore.get()).allowed,true)
    assert.match((await runAction(independent,"独立权限",event)).message,/独立权限/)
    assert.equal(event.isMaster,undefined,"action authorization does not forge caller identity")
    await configStore.update(config=>{config.actions.items.echo={...base,enabled:false}})
    assert.equal(explainToolPolicy(toolRegistry.get(base.tool),{e:event,actionId:base.id}).allowed,false)
    await configStore.update(config=>{config.actions.items.echo=base})
    const bound = bindActionArguments(base, "{{userId}}", event)
    assert.equal(bound.text, "你好 小明：{{userId}}", "user text is substituted only once")
    assert.equal(bindActionArguments({...base,textTemplate:"固定提示词"}, "补充", event).text, "固定提示词\n补充")
    const paramAction = parseAction({ ...base, textParam: "", textTemplate: "", defaults: {text:"固定"}, input:{mode:"parameters"}, overridable:["count"] })
    assert.equal(bindActionArguments(paramAction, "count=2", event).count, 2)
    assert.throws(() => bindActionArguments(paramAction, "text=改变", event), /不允许覆盖/)
    const beforePreview = calls
    const preview = await api("/api/actions/preview", "POST", { action: base, message: "#yui回声 测试", role: "user" })
    assert.equal(preview.body.preview.access.allowed, true)
    assert.equal(preview.body.preview.arguments.text, "你好 10001：测试")
    assert.equal(calls, beforePreview)
    const missing = await api("/api/actions/preview", "POST", { action: figurineAction(), imageCount: 0 })
    assert(missing.body.preview.issues.some(value => value.includes("参考图片")))
    const avatarPreview = await api("/api/actions/preview", "POST", { action: {...figurineAction(),input:{images:"current-and-quote",requireImage:true,avatarFallback:true}}, imageCount:0 })
    assert(!avatarPreview.body.preview.issues.some(value => value.includes("参考图片")))
    assert.match(avatarPreview.body.preview.arguments.referenceImages[0], /nk=10001/, "preview shows the configured avatar fallback")
    await assert.rejects(runAction(figurineAction(), "", event), /图片/)
    assert.equal(calls, beforePreview)
    const current = "https://example.com/current.png", quoted = "https://example.com/quote.png"
    await runAction(figurineAction(), "", { ...event, message: [{type:"image",url:current}], source: { message_id: "quoted" }, getMsg: async () => ({message_id:"quoted", message:[{type:"image",url:quoted}]}) })
    assert.deepEqual(lastArgs.referenceImages, [current])
    await runAction(figurineAction(), "", { ...event, img: [quoted], source: { message_id: "quoted" }, getMsg: async () => ({message_id:"quoted", message:[{type:"image",url:quoted}]}) })
    assert.deepEqual(lastArgs.referenceImages, [quoted], "quoted image is used by default without host duplicates")
    const mergedDrawing = parseAction({...figurineAction(),input:{images:"current-and-quote",requireImage:true,avatarFallback:true}})
    await configStore.update(config=>{config.actions.items.figurine=mergedDrawing})
    await runAction(mergedDrawing, "", { ...event, message: [{type:"image",url:current}], source: { message_id:"quoted" }, getMsg: async () => ({message_id:"quoted", message:[{type:"image",url:quoted}]}) })
    assert.deepEqual(lastArgs.referenceImages, [current,quoted], "drawing templates merge current and quoted images")
    await runAction(mergedDrawing, "", { ...event, user_id:"12345", message:[{type:"at",qq:"23456"}] })
    assert.match(lastArgs.referenceImages[0], /nk=23456/, "avatar fallback uses the real mention")
    await configStore.update(config=>{config.actions.items.figurine=figurineAction()})
    const presetInputAction = parseAction({...figurineAction(),id:"preset-input",command:"预设演示",aliases:[],input:{mode:"image-preset",images:"current-and-quote",requireImage:true,avatarFallback:true},textTemplate:"目标：{{nickname}}（{{qq}}），群：{{group_name}}，发起人：{{sender_nickname}}"})
    await configStore.update(config=>{config.actions.items[presetInputAction.id]=presetInputAction})
    const presetEvent = {...event,user_id:"12345",group_name:"测试群",message:[{type:"at",qq:"23456"}],group:{pickMember:()=>({info:{card:"群名片"}})}}
    await runAction(presetInputAction,"@23456 名字=小星 -p 蓝色背景",presetEvent)
    assert.equal(lastArgs.prompt,"目标：小星（23456），群：测试群，发起人：小明\n\n用户追加要求：\n蓝色背景")
    assert.match(lastArgs.referenceImages[0],/nk=23456/,"the actual mention supplies the target avatar")
    await runAction(presetInputAction,"qq=34567 -p 加底座",presetEvent)
    assert(lastArgs.prompt.includes("目标：群名片（34567）"), "the explicit target and current group card feed prompt variables")
    assert.match(lastArgs.referenceImages[0],/nk=34567/,"explicit QQ takes precedence over the real mention")
    await runAction(presetInputAction,"-p 海边",{...presetEvent,message:[]})
    assert(lastArgs.prompt.includes("目标：小明（12345）") && lastArgs.prompt.endsWith("用户追加要求：\n海边"), "prompt-only input uses the real sender")
    const callsBeforeInvalidPreset = calls
    await assert.rejects(runAction(presetInputAction,"-p",presetEvent), /-p 后/)
    assert.equal(calls,callsBeforeInvalidPreset,"an empty prompt option must not run the tool")
    const presetPreview = await api("/api/actions/preview","POST",{action:presetInputAction,message:"#yui预设演示 qq=34567 name=小花 -p 水彩"})
    assert.equal(presetPreview.status,200)
    assert(presetPreview.body.preview.arguments.prompt.includes("目标：小花（34567）"))
    assert.match(presetPreview.body.preview.arguments.referenceImages[0],/nk=34567/)
    await configStore.update(config=>{delete config.actions.items[presetInputAction.id]})
    let replies = []
    const entries = createActionEntries(configStore.get())
    const entry = entries.find(row => row.name.includes("回声"))
    const message = { ...event, message_id: "dedupe", msg: "#yui回声 指令", reply: async value => replies.push(value) }
    const countBefore = calls
    for (let i = 0; i < 2; i++) { const instance = new entry.class(); instance.e = {...message}; await instance.run() }
    assert.equal(calls, countBefore + 1)
    assert.equal(replies.length, 1)
    muteScope(event)
    const muted = new entry.class(); muted.e = {...message,message_id:"muted"}
    await muted.run()
    assert.equal(calls,countBefore + 1,"muted group does not execute tools")
    assert.equal(replies.length,1,"muted group stays silent")
    clearMutedScopes()
    const other = { plugin: {rule:[{reg:/^#yui回声/}]}, class: class {}, key: "other/index.js", name: "Other", priority: 2000 }
    const loader = { priority: [other] }
    replaceActionEntries(loader, entries)
    assert.equal(loader.priority[0].priority, 1137)
    replaceActionEntries(loader, entries)
    assert.equal(loader.priority.length, entries.length + 1)
    assert(loader.priority.includes(other))
    const fast = {...base, stage:"accept", priority:100}
    const acceptEntries = createActionEntries({ ...configStore.get(), actions: { enabled:true, categories:[{id:"lookup",name:"查询"}], items:{ echo:fast } } })
    assert.equal(typeof acceptEntries[0].plugin.accept, "function")
    assert.equal(acceptEntries[0].plugin.rule.length, 0)
    assert.equal(new RegExp(actionRule(base)).test("#yui回声 x"), true)
    replaceActionEntries(loader, [])
    assert.deepEqual(loader.priority, [other])
    assert(actionHelp({...event,msg:"#yui快捷指令"}).includes("#yui回声"))
    const created = await api("/api/actions", "POST", {action:copy})
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const copyId = created.body.id
    let catalog = (await api("/api/actions")).body
    const saved = catalog.items.find(item => item.id === copyId)
    assert.equal(saved.defaults.count, 2)
    assert.equal(saved.ignorePrefix, true)
    assert.equal((await api(`/api/actions/${copyId}`, "PUT", {action:{...saved,name:"改名"},version:"stale"})).status, 409)
    const disabled = await api(`/api/actions/${copyId}`, "PUT", {action:{...saved,enabled:false},version:saved.version})
    assert.equal(disabled.status, 200)
    catalog = (await api("/api/actions")).body
    const disabledItem = catalog.items.find(item => item.id === copyId)
    const deniedTest = await api(`/api/actions/${copyId}/test`, "POST", {version:disabledItem.version,text:"test"})
    assert.equal(deniedTest.status, 400)
    const echoItem = catalog.items.find(item => item.id === "echo")
    const tested = await api("/api/actions/echo/test", "POST", { version: echoItem.version, text:"测试" })
    assert.equal(tested.status, 200, JSON.stringify(tested.body))
    assert.equal(tested.body.result.status, "success")
    assert(String(tested.body.result.result).includes("测试"))
    const exported = (await api(`/api/actions/export?id=${copyId}`)).body.bundle
    assert.equal(exported.items.length, 1)
    assert.equal(exported.items[0].ignorePrefix, true, "export preserves the prefix option")
    const importedPreview = await api("/api/actions/import", "POST", {bundle:exported})
    assert.equal(importedPreview.body.preview[0].enabled, false)
    assert.equal(importedPreview.body.preview[0].ignorePrefix, true, "import preserves the prefix option while disabling the action")
    assert.equal((await api("/api/actions")).body.items.length, 3)
    assert.equal((await api("/api/actions/import", "POST", {bundle:exported,apply:true})).status, 200)
    catalog = (await api("/api/actions")).body
    const updateCategories = await api("/api/actions/categories", "PUT", {categories:catalog.categories.filter(item=>item.id!=="lookup"),version:catalog.categoriesVersion})
    assert.equal(updateCategories.status, 200)
    assert.equal(parseActions(configStore.get().actions).items.echo.categoryId, "")
    await configStore.update(config => { config.actions.items.background = parseAction({...base,id:"background",command:"后台回声",categoryId:"",tool:"action_background",textTemplate:""}) })
    const background = parseActions(configStore.get().actions).items.background
    const backgroundReplies = []
    const backgroundEvent = {...event,reply:async message=>backgroundReplies.push(message)}
    const hold = await runAction(background,"hold",backgroundEvent)
    const queued = await runAction(background,"queued",backgroundEvent)
    assert.equal(hold.status,"accepted")
    assert.equal(queued.status,"accepted")
    await configStore.update(config=>{config.actions.items.background.enabled=false})
    releaseBackground()
    for (let i=0;i<40 && ["queued","running"].includes(backgroundTaskService.get(queued.taskId)?.status);i++) await new Promise(resolve=>setTimeout(resolve,10))
    assert.equal(backgroundTaskService.get(queued.taskId).status,"error","queued execution rechecks permissions")
    assert(backgroundReplies.includes("hold"), "background tool output is delivered without an extra model call")
    assert(backgroundReplies.some(value=>value.includes("动作或工具权限已变化")), "queued permission denial is reported")
    assert.equal((await api(`/api/actions/echo/tasks/${queued.taskId}`)).status,400)
    await configStore.update(config => { config.actions.items.background.enabled = true })
    let releaseSnapshot
    const snapshotWait = new Promise(resolve => { releaseSnapshot = resolve })
    let observedSnapshot
    toolRegistry.tools.delete("action_background")
    toolRegistry.register({ ...echo, name: "action_background", execution: { effect: "read", background: true },
      configSchema: { type: "object", properties: { prefix: { type: "string", default: "old" } } },
      backgroundQueue: () => ({ queueKey: "snapshot-test", maxConcurrent: 1, maxQueue: 1 }),
      execute: async (args, context) => {
        if (args.text === "hold") await snapshotWait
        else observedSnapshot = { privateHosts: context.config.security.linkSafety.allowPrivateHosts, prefix: context.toolConfig.prefix }
        return args.text
      },
    })
    await runAction(background, "hold", backgroundEvent)
    const snapshotQueued = await runAction(background, "snapshot", backgroundEvent)
    await configStore.update(config => {
      config.security.linkSafety.allowPrivateHosts = false
      config.tools.runtimeVariables.action_background = { prefix: "new" }
    })
    releaseSnapshot()
    for (let i = 0; i < 100 && ["queued", "running"].includes(backgroundTaskService.get(snapshotQueued.taskId)?.status); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(backgroundTaskService.get(snapshotQueued.taskId).status, "ok")
    assert.deepEqual(observedSnapshot, { privateHosts: false, prefix: "new" }, "queued action executes with the config it reauthorized")
    await configStore.update(config => { config.mediaRecognition.includeQuotedMedia = false })
    assert.equal(configStore.get().mediaRecognition.includeQuotedMedia, undefined, "normalization removes the retired quote toggle")
    const reply = (value, options = {}) => formatActionReply({...normalizeToolResult(value),value}, {mode:"auto",path:"",template:"",...options})
    assert.equal(reply("普通文本").message,"普通文本")
    assert.equal(reply("https://example.com/page").message,"https://example.com/page")
    assert.equal(reply("https://example.com/a.png").parts[0].type,"image")
    assert.throws(()=>reply({type:"image",data:{file:"https://example.com/a.png"}}), /source|宿主/)
    for (const kind of ["url", "path", "bytes"]) {
      const value = kind === "url" ? "https://example.com/a.png" : kind === "path" ? path.join(root, "data/yui-chat/cache/temp/a.png") : "aGVsbG8="
      const image = {type:"image",source:{kind,value}}
      assert.deepEqual(reply(image).parts,[image])
      assert.deepEqual(reply({parts:[image]},{mode:"message"}).parts,[image])
    }
    for (const kind of ["file", "cache", "base64", "platform"]) assert.throws(()=>reply({type:"image",source:{kind,value:"legacy"}}),/source/)
    assert.throws(()=>reply({parts:[{type:"forward",nodes:[{parts:[{type:"image",file:"https://example.com/a.png"}]}]}]},{mode:"message"}),/source/)
    assert.equal(reply({data:{text:"完成"}}, {mode:"text",path:"data.text",template:"结果：{{value}}"}).message,"结果：完成")
    assert.equal(reply('{"data":{"images":[{"url":"https://example.com/a.png"}]}}',{mode:"image",path:"data.images[0].url"}).parts[0].source.value,"https://example.com/a.png")
    assert.equal(reply({parts:[{type:"text",text:"消息体"}]},{mode:"message"}).message,"消息体")
    assert.deepEqual(reply({parts:[{type:"mention"}]},{mode:"message"}).parts,[{type:"mention"}],"action previews retain message_send implicit-current-sender mentions")
    assert.equal(reply({kind:"delivery",chain:[],isError:false,issues:[]}).parts.length,0)
    assert.equal(reply({x:1},{mode:"json"}).message,'{\n  "x": 1\n}')
    assert.throws(()=>reply({data:{}},{mode:"text",path:"data.missing"}),/没有字段/)
    assert.throws(()=>extractActionResult({},"__proto__"),/没有字段/)
    assert.throws(()=>parseAction({...base,reply:{path:"data.constructor"}}),/结果字段/)
    assert.equal(reply("不追加",{mode:"silent"}).message,"")
    const samplePreview = await api("/api/actions/reply-preview","POST",{action:{...base,reply:{mode:"text",path:"data.text"}},sample:{data:{text:"预览文本"}}})
    assert.equal(samplePreview.body.preview.message,"预览文本")
    assert(samplePreview.body.fields.includes("data.text"))
    await fs.mkdir(path.join(pluginRoot,"cache"),{recursive:true})
    sourceFixture = await fs.mkdtemp(path.join(pluginRoot,"cache","action-source-test-"))
    await fs.writeFile(path.join(sourceFixture,"source.mjs"),'globalThis.__actionSourceLoads = (globalThis.__actionSourceLoads || 0) + 1; export function echo(args) { return {data:{text:args.text}} }; export class Handler { async run(e,args) { await this.e.reply("源码已回复"); return true } }')
    const sourceAction = parseAction({...base,id:"source",command:"源码回声",categoryId:"",kind:"source",source:{frameworkResources:{target:`plugin:yui-chat/cache/${path.basename(sourceFixture)}/source.mjs`},exportName:"echo",callStyle:"function"},reply:{mode:"text",path:"data.text"}})
    assert.throws(()=>parseAction({...sourceAction,source:{...sourceAction.source,frameworkResources:{target:"plugin:chatgpt-plugin/apps/demo.js"}}}),/旧/)
    assert.throws(()=>parseAction({...sourceAction,source:{...sourceAction.source,frameworkResources:{target:"plugin:yui-chat/../demo.js"}}}),/项目资源/)
    const sourceCreated = await api("/api/actions","POST",{action:sourceAction})
    assert.equal(sourceCreated.status,200,JSON.stringify(sourceCreated.body))
    const savedSource = parseActions(configStore.get().actions).items[sourceCreated.body.id]
    assert.equal(globalThis.__actionSourceLoads,undefined,"saving source does not import code")
    assert.equal((await api("/api/actions/preview","POST",{action:savedSource})).status,200)
    assert.equal(globalThis.__actionSourceLoads,undefined,"preview does not import code")
    const sourceOutput = await runAction(savedSource,"源码内容",event)
    assert.equal(sourceOutput.message,"你好 小明：源码内容")
    const loads = globalThis.__actionSourceLoads
    await new Promise(resolve => setTimeout(resolve, 5))
    await runAction(savedSource,"再次调用",event)
    assert.equal(globalThis.__actionSourceLoads, loads, "unchanged source reuses its module instance")
    await fs.appendFile(path.join(sourceFixture,"source.mjs"), "\n// changed version")
    await runAction(savedSource,"修改后调用",event)
    assert.equal(globalThis.__actionSourceLoads, loads + 1, "changed source reloads once")
    const badReply = await runAction({...savedSource,reply:{mode:"text",path:"data.missing",template:""}},"",event)
    assert.equal(badReply.status,"success")
    assert(badReply.message.includes("动作已执行，但回复设置需要调整"))
    assert(!toolRegistry.get(savedSource.tool),"source bindings do not enter the AI catalog")
    const disabledCustom = {...configStore.get(),tools:{...configStore.get().tools,policy:{...configStore.get().tools.policy,allowCustomTools:false}}}
    assert.equal(actionAccess(savedSource,event,disabledCustom).allowed,false)
    const sourceCopy = parseAction({...savedSource,id:"source-copy",command:"源码副本",defaults:{count:2}})
    assert.equal(sourceCopy.source.frameworkResources.target,savedSource.source.frameworkResources.target)
    sourceCopy.source.method="other"
    assert.equal(savedSource.source.method,"")
    const handler = parseAction({...sourceAction,id:"handler",command:"方法回声",source:{...sourceAction.source,exportName:"Handler",callStyle:"plugin",method:"run"}})
    await configStore.update(config=>{config.actions.items.handler=handler})
    const sent=[]
    const handled=await runAction(handler,"",{...event,reply:async text=>sent.push(text)})
    assert.deepEqual(sent,["源码已回复"])
    assert.equal(handled.message, "", "self replies must not be duplicated")
    await fs.writeFile(path.join(sourceFixture,"message.mjs"),'export class Handler { run(e) { return {text:e.msg,user:e.user_id} } }')
    const mapped = parseAction({...handler,id:"mapped",command:"映射消息",reply:{mode:"text",path:"text"},source:{...handler.source,frameworkResources:{target:`plugin:yui-chat/cache/${path.basename(sourceFixture)}/message.mjs`},useInputAsMessage:true}})
    await configStore.update(config=>{config.actions.items.mapped=mapped})
    assert.equal((await runAction(mapped,"新消息",event)).message,"你好 小明：新消息")
    let delivered
    toolRegistry.register({...echo,name:"message_send",parameters:{type:"object",properties:{parts:{type:"array",items:{type:"object"}}},required:["parts"]},execute:async args=>{delivered=args;return {kind:"delivery",chain:[],receipt:{status:"sent"},isError:false,issues:[]}}})
    assert.equal(explainToolPolicy(toolRegistry.get("message_send"),{e:event}).allowed,false,"message tool remains disabled outside the action")
    const imageHandler = {...mapped,reply:{mode:"image",path:"text",template:""},textTemplate:""}
    await configStore.update(config=>{config.actions.items.mapped=imageHandler})
    const imageResult = await runAction(imageHandler,"https://example.com/generated.png",event)
    assert.equal(imageResult.delivery.status,"success")
    assert.equal(delivered.parts[0].source.value,"https://example.com/generated.png")

    const sample = { chain:[{type:"image",source:{kind:"bytes",value:"aGVsbG8=",mimeType:"image/png"}}], metadata:{model:"actual-model",provider:"test",durationMs:1200,imageCount:1} }
    const replyName = parseAction({...imageTemplate,name:"历史展示名",command:"新的指令",reply:{image:{start:"",running:"",success:"{{actionName}} {{image}}",failure:""}}})
    assert(formatImageActionReply(replyName,event,"success",sample).message.includes("历史展示名"), "saved reply templates keep their legacy display name")
    const replyCommand = parseAction({...replyName,name:""})
    assert(formatImageActionReply(replyCommand,event,"success",sample).message.includes("新的指令"), "new unnamed actions use their command in reply templates")
    const formatted = formatImageActionReply(imageTemplate, event, "success", sample)
    assert.equal(formatted.parts.filter(part => part.type === "image").length, 1)
    assert(formatted.message.includes("actual-model"))
    assert.throws(() => parseAction({...imageTemplate,reply:{image:{start:"",success:"{{image}}{{image}}",failure:""}}}), /只能插入一次/)
    const previewImage = await api("/api/actions/reply-preview", "POST", {action:imageTemplate,stage:"success",sample})
    assert.equal(previewImage.status,200)
    assert.equal(previewImage.body.preview.parts.filter(part => part.type === "image").length,1)

    const { GenerateImageTool } = await import("../output/runtime/tools/builtins/image-generation.js")
    const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
    const realImage = new GenerateImageTool()
    const imageProvider = {name:"image-test",type:"openai-images",baseURL:"https://example.invalid",apiKey:"",authType:"none",headers:{},query:{}}
    const imageModel = name => ({name,modelIdentifier:`${name}-upstream`,apiProvider:"image-test",adapter:"openai-images",purpose:"image",image:{protocol:"openai-images"},params:{}})
    const drawing = parseAction({...imageTemplate,id:"draw-test",command:"绘图试验",enabled:true,textTemplate:"画一只猫",defaults:{model:"image-b",count:1},input:{images:"none"}})
    await configStore.update(config => {
      config.apiProviders.push(imageProvider)
      config.models.push(imageModel("image-a"),imageModel("image-b"))
      config.modelTasks.imageGeneration.modelList = ["image-a"]
      config.actions.items[drawing.id] = drawing
    })
    const queue = realImage.backgroundQueue({model:"image-b"},{config:configStore.get()})
    assert.equal(queue.channelId,"image-b")
    assert.equal(queue.queueKey,"generate_image:image-b")
    toolRegistry.tools.delete("generate_image")
    toolRegistry.register(realImage)
    const originalGenerateImages = adapterRegistry.generateImages
    const imageRequests = []
    const imageDeliveries = []
    adapterRegistry.generateImages = async request => { imageRequests.push(request.channel.id); return {images:[{data:"data:image/png;base64,aGVsbG8=",mimeType:"image/png"}],text:"绘制完成"} }
    toolRegistry.tools.delete("message_send")
    toolRegistry.register({...echo,name:"message_send",parameters:{type:"object",properties:{parts:{type:"array",items:{type:"object"}}},required:["parts"]},execute:async args=>{imageDeliveries.push(args.parts);return {kind:"delivery",chain:[],receipt:{status:"sent"},isError:false,issues:[]}}})
    try {
      const drawingEvent = {...event, user_id:"12345", isMaster:true, reply:async () => { throw new Error("图片动作不应直接重复回复") }}
      const submitted = await runAction(drawing,"",drawingEvent)
      assert.equal(submitted.status,"accepted")
      assert.match(submitted.message, /生成中.*执行中 1\/1/, "the accepted message shows actual queue state")
      for (let i=0;i<100 && !imageDeliveries.length;i++) await new Promise(resolve=>setTimeout(resolve,10))
      assert.deepEqual(imageRequests,["image-b"],"selected model reaches the image adapter")
      assert.equal(imageDeliveries.length,1,"custom result is delivered exactly once")
      assert.equal(imageDeliveries[0].filter(part=>part.type==="image").length,1)
      assert(imageDeliveries[0].some(part=>part.type==="text" && part.text.includes("image-b-upstream")))

      const missing = parseAction({...drawing,defaults:{model:"missing-image-model"}})
      await configStore.update(config=>{config.actions.items[drawing.id]=missing})
      const failed = await runAction(missing,"",drawingEvent)
      assert.equal(failed.status,"accepted")
      for (let i=0;i<100 && imageDeliveries.length<2;i++) await new Promise(resolve=>setTimeout(resolve,10))
      assert.deepEqual(imageRequests,["image-b"],"unavailable explicit model must not fall back")
      assert(imageDeliveries[1].some(part=>String(part.text || "").includes("图片模型不可用")))

      let releaseFirst, notifyFirstStarted
      const firstStarted = new Promise(resolve=>{notifyFirstStarted=resolve})
      const firstWait = new Promise(resolve=>{releaseFirst=resolve})
      let generated = 0
      adapterRegistry.generateImages = async () => { if (generated++ === 0) { notifyFirstStarted(); await firstWait } return {images:[{data:"data:image/png;base64,aGVsbG8=",mimeType:"image/png"}]} }
      await configStore.update(config=>{config.actions.items[drawing.id]=drawing})
      const first = await runAction(drawing,"",drawingEvent)
      await firstStarted
      const second = await runAction(drawing,"",{...drawingEvent,user_id:"23456"})
      assert.match(second.message,/排队中/)
      releaseFirst()
      for (let i=0;i<100 && imageDeliveries.length<5;i++) await new Promise(resolve=>setTimeout(resolve,10))
      assert.equal(backgroundTaskService.get(first.taskId)?.status,"ok")
      assert.equal(backgroundTaskService.get(second.taskId)?.status,"ok")
      assert.equal(imageDeliveries.slice(2).filter(parts=>parts.some(part=>String(part.text || "").includes("已开始生成"))).length,1,"only a waiting task sends the running notification")
      assert.equal(imageDeliveries.length,5,"two results and one running notification are delivered once")

      let releaseImage, notifyImageStarted
      const imageStarted = new Promise(resolve=>{notifyImageStarted=resolve})
      const imageWait = new Promise(resolve=>{releaseImage=resolve})
      adapterRegistry.generateImages = async () => { notifyImageStarted(); await imageWait; return {images:[{data:"data:image/png;base64,aGVsbG8=",mimeType:"image/png"}]} }
      await configStore.update(config=>{config.actions.items[drawing.id]=drawing})
      const pending = await runAction(drawing,"",drawingEvent)
      await imageStarted
      const waiting = await runAction(drawing,"",{...drawingEvent,user_id:"23456"})
      assert.match(waiting.message, /排队中.*任务 2 个.*执行中 1\/1/, "queued messages show the real active and waiting totals")
      await configStore.update(config=>{config.actions.items[drawing.id].enabled=false})
      releaseImage()
      for (let i=0;i<100 && ["queued","running"].includes(backgroundTaskService.get(pending.taskId)?.status);i++) await new Promise(resolve=>setTimeout(resolve,10))
      for (let i=0;i<100 && ["queued","running"].includes(backgroundTaskService.get(waiting.taskId)?.status);i++) await new Promise(resolve=>setTimeout(resolve,10))
      assert.equal(imageDeliveries.length,5,"revoked actions cannot send running notices or completed images")
    } finally { adapterRegistry.generateImages = originalGenerateImages }
    clearResponseState()
    const logCount = await sqliteClient.get("SELECT COUNT(*) AS count FROM ai_runs")
    assert.equal(logCount.count,0,"local actions must not fabricate model runs")
    console.log("ok actions (configuration, role boundaries, preview, CRUD, copies, imports, media, deduplication, dynamic registry, background revocation, no model usage)")
  }
} finally {
  if (sourceFixture) await fs.rm(sourceFixture,{recursive:true,force:true})
  if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)) }
  await modelLogStore?.stop({flush:true})
  await sqliteClient?.close()
  await fs.rm(root,{recursive:true,force:true})
}
process.exit(0)
