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
  const { bindActionArguments, runAction, actionAccess, defaultActionRole } = await import("../output/runtime/core/actions/execution.js")
  const { formatActionReply, extractActionResult } = await import("../output/runtime/core/actions/reply.js")
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
    config.tools.boundaryAccess.enabled = false
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
    assert.throws(() => parseAction({ ...base, command: "面板" }), /保留/)
    assert.throws(() => parseAction({ ...base, minRole: "superuser" }), /无效/)
    assert.throws(() => parseAction({ ...base, defaults: { token: "secret" } }), /不允许/)
    assert.throws(() => parseAction({ ...base, defaults: JSON.parse('{"__proto__":{"isMaster":true}}') }), /不允许/)
    assert.throws(() => parseAction({ ...base, textTemplate: "{{process.env}}" }), /变量/)
    assert.throws(() => parseAction({ ...base, input: [] }), /输入/)
    assert.throws(() => parseAction({ ...base, overridable: ["text"] }), /覆盖/)
    assert.throws(() => parseActions({ categories: [{id:"lookup",name:"查询"}], items: { echo: base, dupe: { ...base, id: "dupe" } } }), /相同阶段/)
    assert.doesNotThrow(() => parseActions({ categories: [{id:"lookup",name:"查询"}], items: { echo: base, dupe: { ...base, id: "dupe", priority: 100 } } }))
    const copy = parseAction({ ...base, id: "copy", command: "回声二" })
    copy.defaults.count = 2
    assert.equal(base.defaults.count, 1)
    assert.equal(copy.tool, base.tool)
    const event = { user_id: "user-1", isGroup: true, group_id: "group-1", sender: { nickname: "小明", role: "member" }, reply: async () => {} }
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
    await assert.rejects(runAction(figurineAction(), "", event), /图片/)
    assert.equal(calls, beforePreview)
    const current = "https://example.com/current.png", quoted = "https://example.com/quote.png"
    await runAction(figurineAction(), "", { ...event, message: [{type:"image",url:current}], source: { message_id: "quoted" }, getMsg: async () => ({message_id:"quoted", message:[{type:"image",url:quoted}]}) })
    assert.deepEqual(lastArgs.referenceImages, [current])
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
    const importedPreview = await api("/api/actions/import", "POST", {bundle:exported})
    assert.equal(importedPreview.body.preview[0].enabled, false)
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
    const reply = (value, options = {}) => formatActionReply({...normalizeToolResult(value),value}, {mode:"auto",path:"",template:"",...options})
    assert.equal(reply("普通文本").message,"普通文本")
    assert.equal(reply("https://example.com/page").message,"https://example.com/page")
    assert.equal(reply("https://example.com/a.png").parts[0].type,"image")
    assert.equal(reply({type:"image",data:{file:"https://example.com/a.png"}}).parts[0].source.value,"https://example.com/a.png")
    assert.equal(reply({data:{text:"完成"}}, {mode:"text",path:"data.text",template:"结果：{{value}}"}).message,"结果：完成")
    assert.equal(reply('{"data":{"images":[{"url":"https://example.com/a.png"}]}}',{mode:"image",path:"data.images[0].url"}).parts[0].source.value,"https://example.com/a.png")
    assert.equal(reply({parts:[{type:"text",text:"消息体"}]},{mode:"message"}).message,"消息体")
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
