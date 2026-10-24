import assert from "node:assert/strict"
import vm from "node:vm"
import { evaluateCommandCompleteness as grade, prepareCommandCompleteness } from "../output/runtime/knowledge/command-completeness.js"
import { inspectCommandRegexp } from "../output/runtime/knowledge/command-regexp-examples.js"

function document(metadata = {}, changes = {}, top = {}) {
  const m = { pluginName: "游戏", pluginKey: "fixture", priority: 100, regexp: "^#体力$", regexpFlags: "", event: "message", fnc: "stamina", suggestedCommand: "#体力", ...metadata }
  const fields = { 插件名称: m.pluginName, 插件标识: m.pluginKey, 指令: "#体力", 用途: "查询原神剩余树脂", 参数: "无", 示例: "#体力", priority: m.priority, regexp: m.regexp, regexpFlags: JSON.stringify(m.regexpFlags), ...changes }
  return { id: "test", title: "原神体力查询", retrievalText: Object.entries(fields).filter(([,value])=>value!==undefined).flatMap(([key,value])=>(Array.isArray(value)?value:[value]).map(value=>`${key}：${value}`)).join("\n"), metadata: m, ...top }
}
const deduction = (row,code) => row.deductions.find(item=>item.code===code)
const good = document()
const before = JSON.stringify(good)
assert.equal(grade(good).qualityScore,100)
assert.equal(grade(good).completenessStatus,"complete")
assert.equal(grade(good).originalComparison,"not-provided")
assert.equal(grade({...good,...good.metadata,metadata:undefined}).qualityScore,100,"flattened legacy callers use the same score")
assert.equal(JSON.stringify(good),before,"grading never mutates facts")
assert.equal(grade({...good,enabled:false,usageCount:99,sourceId:"other"}).qualityScore,100,"availability, source and usage do not affect score")
const copy=grade(good);copy.deductions.push({code:"pollution"});copy.dimensions.A.deducted=20
assert.deepEqual(grade(good).deductions,[]);assert.equal(grade(good).dimensions.A.deducted,0,"cached results cannot be mutated by callers")

const dead=grade(document({regexp:"((?!))",suggestedCommand:""},{示例:"待核实（无法确认可靠发送示例）"}))
assert.equal(dead.qualityScore,40);assert.equal(dead.scoreCap,40);assert(deduction(dead,"source-dead"))
const invalid=grade(document({regexp:"["}))
assert.equal(invalid.scoreCap,60);assert(deduction(invalid,"source-invalid"));assert(!deduction(invalid,"example-unverified"),"a source syntax error is not charged twice")
assert(deduction(grade(document({regexpFlags:"ii"})),"source-invalid"))
const internal=grade(document({regexp:"sf-plugin-Example-12345",suggestedCommand:""},{示例:"待核实（无法确认可靠发送示例）"}))
assert.equal(deduction(internal,"source-internal").points,5);assert.equal(internal.scoreCap,100,"an internal-looking token alone proves no severe cap")
const listener=grade(document({regexp:".*",suggestedCommand:""},{示例:"待核实（无法确认可靠发送示例）"}))
assert.equal(deduction(listener,"source-listener").points,10)
const event=document({regexp:"(?:)",event:"notice.group.poke",suggestedCommand:"",examples:[]},{指令:"戳一戳事件触发",用途:"响应用户戳一戳",示例:"无（通过戳一戳事件触发）"},{title:"戳一戳回应"})
assert.equal(grade(event).qualityScore,100);assert.equal(grade(event).verification,"event-exempt")
assert(!deduction(grade(event),"source-listener"))
const fakeEvent=grade({...event,metadata:{...event.metadata,suggestedCommand:"poke",examples:["poke"]}})
assert.equal(fakeEvent.qualityScore,90);assert(deduction(fakeEvent,"suggestion-sync"));assert(deduction(fakeEvent,"examples-sync"))
assert.equal(deduction(grade(document({event:undefined})),"source-event").points,5)

assert.equal(grade(document({}, {插件名称:"错位插件"})).qualityScore,98)
const altered=grade(document({}, {regexp:"^#假指令$"}))
assert.equal(altered.scoreCap,60);assert.equal(altered.qualityScore,60)
assert.equal(grade(document({regexpFlags:"i"})).qualityScore,100,"quoted nonempty flags round trip")
assert.equal(grade(document({regexpFlags:""},{regexpFlags:""})).qualityScore,98,"empty flags require an explicit quoted empty string")
assert.equal(grade(document({priority:"-Infinity"})).qualityScore,100)
assert.equal(grade(document({regexp:" #体力 ",suggestedCommand:" #体力 "},{示例:" #体力 "})).qualityScore,100,"source and sample whitespace keep their literal matching meaning")
const duplicates=grade({...good,retrievalText:good.retrievalText.replace("用途：查询原神剩余树脂","用途：查询原神剩余树脂\n用途：补充说明")})
assert.equal(deduction(duplicates,"field-duplicate").points,1)
const extra=grade({...good,retrievalText:good.retrievalText+"\n声明权限：all\n前置条件：消息事件\n限制：待核实"})
assert.equal(deduction(extra,"field-extra").points,3);assert(extra.issues.includes("pending-verification"))
const outOfOrder=grade({...good,retrievalText:good.retrievalText.replace("参数：无\n示例：#体力","示例：#体力\n参数：无")})
assert.equal(deduction(outOfOrder,"field-order").points,2)
assert.equal(deduction(grade({...good,retrievalText:"游离说明\n"+good.retrievalText}),"field-orphan").points,2)
const multiline=document({regexp:"^#体力$|^other\n用途：待核实$"})
assert.equal(grade(multiline).qualityScore,100,"labels and pending phrases inside multiline raw regex stay source text")

assert.equal(deduction(grade({...good,title:"stamina"}),"title-invalid").points,5)
assert.equal(grade({...good,title:"Cookie"}).qualityScore,100,"readable English is not a false positive")
for(const template of ["#<角色名>面板","#{角色名}面板","#｛角色名｝面板","#<平台名>搜索<关键词>"]) assert.equal(grade(document({}, {指令:template})).qualityScore,100)
assert.equal(deduction(grade(document({}, {指令:"<内容>"})),"missing-command").points,10)
assert.equal(deduction(grade(document({}, {指令:"#体力$^#树脂"})),"command-fragment").points,8)
assert.equal(deduction(grade(document({}, {用途:undefined})),"missing-purpose").points,15)
assert.equal(deduction(grade(document({}, {用途:"待核实真实用途"})),"pending-purpose").points,10)
assert.equal(deduction(grade(document({}, {参数:undefined})),"missing-parameters").points,10)
assert.equal(deduction(grade(document({}, {参数:"UID 含义待核实"})),"pending-parameters").points,5)
assert.equal(grade(document({}, {参数:"<QQ号（必填）>"})).qualityScore,100,"a meaningful parameter template is not a generic placeholder")
for(const [length,points] of [[350,0],[351,1],[550,1],[551,3],[1000,3],[1001,5],[2000,5],[2001,8]]) {
  const base=grade(good).lengths.body
  const row=grade(document({}, {用途:"查询原神剩余树脂"+"说明".repeat(length).slice(0,length-base)}))
  assert.equal(row.lengths.body,length);assert.equal(deduction(row,"body-length")?.points||0,points,`body length ${length}`)
}
const noise=grade(document({}, {用途:"查询原神剩余树脂。插件已加载，不保证存在或可用。"}))
assert.equal(deduction(noise,"body-noise").points,2)
assert.equal(grade(document({}, {用途:"查体力"})).qualityScore,100,"short complete entries are not penalized")

for(const sample of ["<数字>","#体力 \\d+","stamina"]) assert(deduction(grade(document({suggestedCommand:sample,examples:[sample]},{示例:sample})),"example-invalid"))
const mismatched=grade(document({suggestedCommand:"#树脂",examples:["#树脂"]},{示例:"#树脂"}))
assert.equal(mismatched.scoreCap,60);assert.equal(deduction(mismatched,"example-mismatch").points,10)
const fallback=grade(document({suggestedCommand:"",examples:[]},{示例:"待核实（无法确认可靠发送示例）"}))
assert.equal(fallback.qualityScore,90);assert.equal(fallback.completenessStatus,"needs-review")
assert.equal(fallback.deductions.filter(item=>item.dimension==="E").length,1,"pending examples incur one deduction, not missing plus pending")
assert.equal(grade(document({examples:[]},{示例:"#体力"})).qualityScore,95,"an existing array must be synchronized")
assert.equal(grade(document({regexp:"^#(?:体力|树脂)$",examples:["#体力","#树脂"]},{示例:["#体力","#树脂"]})).qualityScore,100)
const link="https://example.com/video/123"
assert.equal(grade(document({regexp:"^https://example\\.com/video/[0-9]+$",suggestedCommand:link,examples:[link]},{指令:"发送视频链接触发",用途:"解析视频链接",示例:link},{title:"视频链接解析"})).qualityScore,100,"validation accepts real URL samples even though scanner generation does not guess them")
for(const flags of ["g","y","gy"]) assert.equal(grade(document({regexp:"^#(?:体力|树脂)$",regexpFlags:flags,examples:["#体力","#树脂"]},{示例:["#体力","#树脂"]})).qualityScore,100,"lastIndex resets per sample: "+flags)

for(const [length,points] of [[300,0],[301,1],[800,1],[801,2],[1500,2],[1501,3],[3000,3],[3001,5],[7000,5]]) {
  const prefix="^(?:#体力|",suffix=")$",regexp=prefix+"x".repeat(length-Array.from(prefix+suffix).length)+suffix
  const row=grade(document({regexp}))
  assert.equal(row.lengths.regexp,length);assert.equal(row.qualityScore,100-points);assert.equal(deduction(row,"regexp-length")?.points||0,points)
}
const timeout=grade(document({regexp:"^(a+)+$",suggestedCommand:"a".repeat(1200)+"!"},{示例:"a".repeat(1200)+"!"}))
assert.equal(timeout.verification,"unverified");assert.equal(timeout.scoreCap,100);assert(deduction(timeout,"example-unverified"));assert(!deduction(timeout,"source-invalid"))
assert.equal(inspectCommandRegexp("^#cache$","",["#cache"]).matches[0],true)
const mutableCheck=inspectCommandRegexp("^#cache$","",["#cache"]);mutableCheck.matches[0]=false
assert.equal(inspectCommandRegexp("^#cache$","",["#cache"]).matches[0],true)

const original=vm.Script.prototype.runInNewContext
let calls=0
vm.Script.prototype.runInNewContext=function(...args){calls++;return original.apply(this,args)}
try {
  const unique=document({regexp:"^#缓存验证$",suggestedCommand:"#缓存验证"},{指令:"#缓存验证",示例:"#缓存验证"})
  await prepareCommandCompleteness([unique])
  const first=calls;assert(first>0)
  for(let i=0;i<100;i++) assert.equal(grade({...unique,enabled:i%2===0}).qualityScore,100)
  await prepareCommandCompleteness([unique]);assert.equal(calls,first,"list, sort, report and availability reuse revision results")
  const changed={...unique,retrievalText:unique.retrievalText.replace("示例：#缓存验证","示例：#错误缓存验证")}
  assert.equal(grade(changed).scoreCap,60);assert(calls>first,"changed examples are revalidated")
  const budget=document({regexp:"^#批次预算$",suggestedCommand:"#批次预算"},{指令:"#批次预算",示例:"#批次预算"})
  const beforeBudget=calls;await prepareCommandCompleteness([budget],0)
  assert.equal(grade(budget).verification,"unverified");assert.equal(grade(budget).qualityScore,90);assert.equal(calls,beforeBudget,"batch budget bounds initial regex work")
  for(let i=0;i<20&&grade(budget).verification!=="verified";i++)await new Promise(resolve=>setImmediate(resolve))
  assert.equal(grade(budget).qualityScore,100,"background work clears deductions caused only by our scheduling budget")
} finally {vm.Script.prototype.runInNewContext=original}
for(const doc of [good,document(),event,document({}, {用途:undefined,参数:undefined,示例:undefined})]) {
  const row=grade(doc)
  assert(row.qualityScore>=0&&row.qualityScore<=100)
  for(const dim of Object.values(row.dimensions))assert(dim.deducted>=0&&dim.deducted<=dim.maximum)
  assert.equal(row.qualityScore,Math.max(0,Math.min(row.scoreCap,100-row.deductions.reduce((sum,item)=>sum+item.points,0))))
}
console.log("ok command completeness: weighted deductions, caps, immutable facts, templates/events/URLs, source checks, lengths, regex safety and revision cache")
