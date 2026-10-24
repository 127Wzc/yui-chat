import assert from "node:assert/strict"
import { commandExamplesFromRegexp, validatedCommandExamples } from "../output/runtime/knowledge/command-regexp-examples.js"
import { buildCommandDoc } from "../output/runtime/knowledge/command-document-builder.js"

const fixtures = [
  { pattern: String.raw`^#[Dd]ou[Yy]in[Bb]ot账号$|^#抖音bot账号$`, expected: ["#DouYinBot账号", "#抖音bot账号"] },
  { pattern: String.raw`^#?[pP]ing$`, expected: ["#ping"] },
  { pattern: String.raw`^#?[Cc](oo)?[Kk](ie)?代码$`, expected: ["#CooKie代码"] },
  { pattern: String.raw`^#[Qq]+账号$`, expected: ["#Q账号"] },
  { pattern: String.raw`^#我的云盘$|^#rnc$|^#RNC$`, expected: ["#我的云盘", "#rnc", "#RNC"] },
  { pattern: String.raw`^#设置定时禁言\s*(.*)$|^#定时禁言任务$|^#取消定时禁言$`, expected: ["#定时禁言任务", "#取消定时禁言"] },
  { pattern: String.raw`^#点歌\s*(.+?)(?:\s+([12]))?$|#听[1-9][0-9]*|#听[1-9]*$`, expected: ["#听1"] },
  { pattern: String.raw`(?:^\s*@[^#]*(?=#)|^)#(王者|战绩)日报\s*(.*)$`, expected: ["#王者日报", "#战绩日报"], direct: true },
  { pattern: String.raw`(?:\[reply:[^\]]+\]\n?)?^#帮助$`, expected: ["#帮助"], direct: true },
  { pattern: String.raw`^^((#|%|\/)?(zzz|ZZZ|绝区零))抽卡帮助$`, expected: ["#zzz抽卡帮助", "#绝区零抽卡帮助"] },
  { pattern: String.raw`^#(五|四|5|4|星)*(角色|查询)[ 0-9]*$|^(#*uid|#*UID)\+*(18|[1-9])[0-9]{8}$|^#[+＋]*(18|[1-9])[0-9]{8}$`, branches: [/角色|查询/u, /uid|UID/u, /^#[+＋]*\d+$/u] },
  { pattern: String.raw`^#[Dd]ou[Yy]in[Bb]ot删除[0-9]+$|^#抖音bot删除[0-9]+$`, expected: ["#DouYinBot删除0", "#抖音bot删除0"] },
  { pattern: String.raw`^#[aA]bc$|^#中文$`, flags: "gy", expected: ["#abc", "#中文"] },
  { pattern: String.raw`^二维码\s+(.+)$`, expected: ["二维码 示例"] },
  { pattern: String.raw`^#\u5e2e\u52a9$`, expected: ["#帮助"] },
  { pattern: String.raw`^#安装插件(-[Pp]lugin)?$`, expected: ["#安装插件-Plugin", "#安装插件"] },
  { pattern: String.raw`^#设置视频号[Cc]ookie\s+(.+)$`, expected: ["#设置视频号Cookie 示例"] },
  { pattern: String.raw`^#[Tt][Gg](账号|设置|代理)$`, expected: ["#TG账号", "#TG设置", "#TG代理"] },
  { pattern: String.raw`^#七圣召唤查询牌组列表[0-9]{0,2}$`, expected: ["#七圣召唤查询牌组列表"] },
  { pattern: String.raw`^#我的uid[0-9]{0,2}$`, expected: ["#我的uid"] },
  { pattern: String.raw`^#面板角色列表\s*\d{9,10}$`, expected: ["#面板角色列表 111111111"] },
  { pattern: String.raw`^#敌人等级\d{1,3}$`, expected: ["#敌人等级1"] },
  { pattern: String.raw`^#202\d{3}幻想练度统计$`, expected: ["#202111幻想练度统计"] },
  { pattern: "^#接受绑定用户(\\[[a-zA-Z0-9_\\-:\uf03a]+\\]){0,2}$", expected: ["#接受绑定用户"] },
]
for (const fixture of fixtures) {
  const examples = commandExamplesFromRegexp(fixture.pattern, fixture.flags || "")
  assert(examples.length > 0 && examples.length <= 8, fixture.pattern)
  for (const expected of fixture.expected || []) assert(examples.includes(expected), `${fixture.pattern}: missing ${expected}`)
  for (const branch of fixture.branches || []) assert(examples.some(example => branch.test(example)), `${fixture.pattern}: independent branch lost`)
  for (const example of examples) {
    const regex = new RegExp(fixture.pattern, fixture.flags || "")
    assert(regex.test(example), `${fixture.pattern}: invalid example ${example}`)
    assert(!/\$\^|<[^>]+>|\\[dsw]/u.test(example))
    if (fixture.direct) assert(example.startsWith("#"), "optional transport compatibility must not become the command")
  }
  const second = commandExamplesFromRegexp(fixture.pattern, fixture.flags || "")
  assert.deepEqual(second, examples, "generation must be deterministic")
  second.push("cache pollution")
  assert(!commandExamplesFromRegexp(fixture.pattern, fixture.flags || "").includes("cache pollution"))
}
for (const pattern of [String.raw`^#\\s*(检查|我的)*c(oo)?k(ie)?(状态)*$`, String.raw`^(?<text>ab)\k<text>$`, String.raw`^#\p{L}+$`, "[", "^.*$", "^#(.*)$", `^${"(".repeat(40)}a${")".repeat(40)}$`, "^#a{999999}$", String.raw`b23.tv/[0-9A-Za-z]{6,12}`, String.raw`https?://github\.com/[a-z0-9]+/[a-z0-9]+`, String.raw`https?://www\.kugou\.com/share`, String.raw`https?://weixin\.qq\.com/sph`]) {
  assert.deepEqual(commandExamplesFromRegexp(pattern), [], `unsupported or generic pattern should remain pending: ${pattern}`)
}
const douyin = fixtures[0].pattern
const repaired = buildCommandDoc({ fnc: "List", regexp: douyin, suggestedCommand: "#ouinot账号$^#抖音bot账号", examples: ["List", "#ouinot账号$^#抖音bot账号"] })
assert.equal(repaired.suggestedCommand, "#DouYinBot账号")
assert.deepEqual(repaired.examples, ["#DouYinBot账号", "#抖音bot账号"])
assert.equal(repaired.regexp, douyin)
assert.equal(buildCommandDoc({ fnc: "List", regexp: "[" }).suggestedCommand, "")
assert.deepEqual(validatedCommandExamples("^(a+)+$", ["a".repeat(160) + "!"]), [], "untrusted regex verification must remain bounded")
assert.deepEqual(commandExamplesFromRegexp("a".repeat(1501)), [])
console.log(`ok command regexp examples: ${fixtures.length} syntax cases, branch coverage, raw-pattern validation, cache isolation, unsupported syntax and execution budgets`)
