import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import ts from "typescript"
import { yunzaiRoot } from "../config/store.js"
import { buildCommandDoc, normalizeCommandPriority } from "./command-document-builder.js"
import { pluginCommandRule } from "../core/message/command-prefixes.js"

type Row = Record<string, any>
export interface CommandBundle { schemaVersion: 1; sourceId: string; complete: boolean; documents: Row[]; deletedIds?: string[]; warnings?: string[] }
const ignored = new Set(["node_modules", ".git", "config", "data", "cache", "logs", "resources", "output", "dist", "build", "chatgpt-plugin"])
const sha = (value: string): string => crypto.createHash("sha256").update(value).digest("hex")
function literal(node: ts.Node | undefined): unknown {
  if (!node) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isIdentifier(node) && node.text === "Infinity") return "Infinity"
  if (ts.isPrefixUnaryExpression(node)) { const value = literal(node.operand); if (node.operator === ts.SyntaxKind.MinusToken) return value === "Infinity" ? "-Infinity" : typeof value === "number" ? -value : undefined }
  return undefined
}
function property(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const item = node.properties.find(item => ts.isPropertyAssignment(item) && item.name && item.name.getText().replace(/["']/g, "") === name)
  return item && ts.isPropertyAssignment(item) ? item.initializer : undefined
}

/** Hash stable registration identity; no persisted ID allocation or ordinal input. */
function buildDocument(metadata: Row): Row {
  const identity = ["yunzai-command-v1", metadata.registrationKey, metadata.className, metadata.fnc, metadata.regexp, metadata.regexpFlags]
  const id = `cmd-${sha(JSON.stringify(identity))}`
  const derived = buildCommandDoc(metadata)
  metadata.suggestedCommand = derived.suggestedCommand
  metadata.examples = derived.examples || []
  return {
    id, title: String(metadata.suggestedCommand || metadata.description || metadata.pluginName || "待整理指令").slice(0, 500),
    retrievalText: [
      `插件名称：${metadata.pluginName}`, `插件标识：${metadata.pluginKey}`,
      `指令：${metadata.examples.length ? metadata.examples.join(" / ") : "待核实（未生成可验证的示例）"}`, `用途：${metadata.description || "待补充说明"}`,
      ...(metadata.examples.length ? metadata.examples.map((example: string) => `示例：${example}`) : ["示例：待核实（请结合原始规则整理）"]),
      `priority：${metadata.priority ?? "未知"}`,
      `regexp：${metadata.regexp}`, `regexpFlags：${JSON.stringify(metadata.regexpFlags || "")}`,
    ].filter(Boolean).join("\n"),
    metadata,
  }
}

/** Read already-created message instances. Never instantiate a plugin or invoke a handler/getter. */
export async function scanLoadedCommands(entries: readonly Row[]): Promise<CommandBundle> {
  if (entries.length > 10000) throw new Error("已加载插件条目超过采集上限")
  const documents: Row[] = [], warnings: string[] = []
  for (const [pluginOrder, entry] of entries.entries()) {
    const registrationKey = String(entry.key || entry.name || "unknown").replace(/\\/g, "/")
    const pluginKey = registrationKey.split("/")[0]
    if (pluginKey === "chatgpt-plugin") { warnings.push("已跳过旧插件目录的规则"); continue }
    const plugin = entry.plugin
    if (!plugin || !Array.isArray(plugin.rule)) continue
    if (typeof entry.key !== "string" || !entry.key.trim()) throw new Error("已加载规则缺少稳定的插件注册来源，无法生成指令 ID")
    const className = String(entry.class?.name || Object.getPrototypeOf(plugin)?.constructor?.name || "")
    for (const [ruleOrder, rule] of [...plugin.rule].entries()) {
      if (!rule || typeof rule.fnc !== "string" || !rule.fnc) { warnings.push(`${registrationKey}：有规则未声明处理函数，需人工核对`); continue }
      const regexp = rule.reg instanceof RegExp ? rule.reg.source : typeof rule.reg === "string" ? rule.reg : ""
      const regexpFlags = rule.reg instanceof RegExp ? rule.reg.flags : ""
      if (!regexp || regexp.length > 1500) { warnings.push(`${registrationKey}/${rule.fnc}：触发规则无法导出或过长`); continue }
      const priority = normalizeCommandPriority(entry.priority ?? plugin.priority) ?? null
      const metadata: Row = {
        pluginKey, pluginName: String(plugin.name || entry.name || pluginKey).slice(0, 500), className,
        fnc: rule.fnc, regexp, regexpFlags, permission: String(rule.permission || "all"),
        event: String(rule.event || plugin.event || "message"), description: String(plugin.dsc || "").slice(0, 2000),
        priority, pluginOrder, ruleOrder,
        registrationKey, origin: { type: "loaded-plugin-rule", pluginKey, registrationKey, method: rule.fnc, className },
      }
      documents.push(buildDocument(metadata))
      if (documents.length > 10000) throw new Error("已加载指令超过 10000 条，无法一次采集")
    }
  }
  return buildBundle(documents, warnings, warnings.length === 0)
}

/** Standalone static scan: never imports or executes third-party plugin code. */
export async function scanCommandMetadata(root = yunzaiRoot): Promise<CommandBundle> {
  const plugins = path.join(root, "plugins"), files: string[] = [], warnings: string[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 7) { warnings.push(`目录过深，未扫描：${path.relative(root, directory)}`); return }
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || ignored.has(entry.name) || entry.isSymbolicLink?.()) continue
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(file, depth + 1)
      else if (entry.isFile() && /\.[cm]?[jt]s$/u.test(entry.name)) {
        if (files.length >= 10000) throw new Error("源码超过 10000 个文件，请缩小扫描范围")
        files.push(file)
      }
    }
  }
  await visit(plugins, 0)
  const documents: Row[] = []
  let totalBytes = 0
  for (const file of files) {
    const stat = await fs.stat(file)
    if (stat.size > 512 * 1024) { warnings.push(`文件过大，未扫描：${path.relative(root, file)}`); continue }
    totalBytes += stat.size
    if (totalBytes > 64 * 1024 * 1024) throw new Error("源码总量超过 64 MiB，请缩小扫描范围")
    const source = await fs.readFile(file, "utf8"), label = path.relative(root, file).split(path.sep).join("/")
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const pluginKey = label.split("/")[1]
    const ownPrefixHelper = pluginKey === "yui-chat" && ast.statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.endsWith("core/message/command-prefixes.js") && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some(item => item.name.text === "pluginCommandRule" && (item.propertyName?.text || item.name.text) === "pluginCommandRule"))
    const collect = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const constructor = node.members.find(ts.isConstructorDeclaration)
        let settings: ts.ObjectLiteralExpression | undefined
        const findSettings = (child: ts.Node): void => {
          if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.SuperKeyword && child.arguments[0] && ts.isObjectLiteralExpression(child.arguments[0])) settings = child.arguments[0]
          else ts.forEachChild(child, findSettings)
        }
        if (constructor) findSettings(constructor)
        if (settings) {
          const rules = property(settings, "rule")
          if (rules && !ts.isArrayLiteralExpression(rules)) warnings.push(`动态规则需人工补充：${label}:${ast.getLineAndCharacterOfPosition(rules.getStart(ast)).line + 1}`)
          if (rules && ts.isArrayLiteralExpression(rules)) for (const rule of rules.elements) {
            // Only our own two pure registration helpers are known; external calls remain unexecuted.
            const master = ownPrefixHelper && label === "plugins/yui-chat/apps/master.ts" && ts.isCallExpression(rule) && ts.isIdentifier(rule.expression) && rule.expression.text === "masterCommand" ? rule : undefined
            const object = ts.isObjectLiteralExpression(rule) ? rule : undefined
            if (!object && !master) { warnings.push(`动态规则需人工补充：${label}`); continue }
            const reg = object ? property(object, "reg") : undefined, fnc = literal(master ? master.arguments[1] : property(object!, "fnc"))
            let regexp = "", regexpFlags = ""
            if (master && typeof literal(master.arguments[0]) === "string") regexp = pluginCommandRule(String(literal(master.arguments[0])))
            else if (reg && ownPrefixHelper && ts.isCallExpression(reg) && ts.isIdentifier(reg.expression) && reg.expression.text === "pluginCommandRule" && typeof literal(reg.arguments[0]) === "string") regexp = pluginCommandRule(String(literal(reg.arguments[0])))
            else if (reg && ts.isRegularExpressionLiteral(reg)) { const value = reg.getText(ast), end = value.lastIndexOf("/"); regexp = value.slice(1, end); regexpFlags = value.slice(end + 1) }
            else if (typeof literal(reg) === "string") regexp = String(literal(reg))
            if (!regexp || typeof fnc !== "string") { warnings.push(`无法静态确认规则：${label}`); continue }
            const description = String(literal(property(settings!, "dsc")) || "")
            const metadata: Row = { pluginKey, pluginName: literal(property(settings!, "name")) || pluginKey, className: node.name?.text || "", fnc, regexp, regexpFlags, permission: master ? "master" : literal(property(object!, "permission")) || "all", event: (object && literal(property(object, "event"))) || literal(property(settings!, "event")) || "message", priority: literal(property(settings!, "priority")) ?? null, description,
              origin: { type: "runtime-plugin-rule", pluginKey, file: label, method: fnc, className: node.name?.text || "", start: ast.getLineAndCharacterOfPosition(rule.getStart(ast)).line + 1 } }
            metadata.registrationKey = label
            documents.push(buildDocument(metadata))
          }
        }
      }
      ts.forEachChild(node, collect)
    }
    collect(ast)
  }
  return buildBundle(documents, ["离线源码扫描不代表已加载目录，动态注册与间接配置需人工核对。", ...warnings], false)
}

function buildBundle(documents: Row[], warnings: string[], complete: boolean): CommandBundle {
  const seen = new Set<string>()
  for (const document of documents) {
    if (seen.has(document.id)) {
      const metadata = document.metadata
      throw Object.assign(new Error(`指令身份冲突：${metadata.registrationKey} / ${metadata.className} / ${metadata.fnc} / ${metadata.regexp} [${metadata.regexpFlags}]，存在完全相同的重复注册，请先修正来源再采集`), { statusCode: 409 })
    }
    seen.add(document.id)
  }
  const bundle: CommandBundle = { schemaVersion: 1, sourceId: "yunzai", complete, documents, warnings }
  if (Buffer.byteLength(JSON.stringify(bundle)) > 12 * 1024 * 1024) throw new Error("采集文档超过 12 MiB，请减少已加载的指令后分批采集")
  return bundle
}
