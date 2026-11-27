import fs from "node:fs/promises"
import path from "node:path"
import { parser } from "@lezer/python"
import type { SyntaxNode } from "@lezer/common"
import type { CommandBundle } from "../command-scanner.js"
import { loadGSConfigs, resolveGSRule } from "./gscore-config.js"
import { externalDocument } from "./document.js"

const kinds = new Set(["on_command", "on_fullmatch", "on_prefix", "on_suffix", "on_keyword", "on_regex"])
const ignored = new Set(["__pycache__", "data", "resources", "venv", "node_modules"])
function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child)
  return result
}
function strings(node: SyntaxNode, text: string): string[] | null {
  if (node.name === "String") {
    const raw = text.slice(node.from, node.to)
    const match = /^(r|u)?("""|'''|"|')([\s\S]*)\2$/i.exec(raw)
    if (!match) return null
    if (match[1]?.toLowerCase() === "r") return [match[3]]
    // Decode common Python escapes without executing source.
    return [match[3].replace(/\\(u[0-9a-f]{4}|U[0-9a-f]{8}|x[0-9a-f]{2}|[nrt\\'"])/gi, (whole, v: string) => {
      if (/^[uUx]/.test(v)) { const n = parseInt(v.slice(1), 16); return n <= 0x10ffff ? String.fromCodePoint(n) : whole }
      return ({n:"\n",r:"\r",t:"\t"} as Record<string,string>)[v] ?? v
    })]
  }
  if (["TupleExpression","ArrayExpression","ParenthesizedExpression"].includes(node.name)) {
    const values = children(node).filter(n => !["(",")","[","]",","].includes(n.name)).map(n => strings(n,text))
    return values.some(v => v === null) ? null : values.flatMap(v => v || [])
  }
  return null
}
export async function scanGSCore(root: string): Promise<CommandBundle> {
  if (!path.isAbsolute(root)) throw new Error("请指定 GSCore 绝对路径")
  const base = await fs.stat(path.join(root,"gsuid_core")).then(s => s.isDirectory() ? path.join(root,"gsuid_core") : root, () => root)
  const configs = await loadGSConfigs(base === root && path.basename(root) === "gsuid_core" ? path.dirname(root) : root)
  const documents: CommandBundle["documents"] = [], warnings = ["源码及配置还原：未验证运行时动态注册与内部条件"], seen = new Set<string>()
  let files = 0, found = 0
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 20) { warnings.push("目录深度超限"); return }
    for (const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink?.() || ignored.has(entry.name)) continue
      const file = path.join(dir,entry.name)
      if (entry.isDirectory()) { await walk(file,depth+1); continue }
      if (!entry.isFile() || !file.endsWith(".py")) continue
      if (++files > 10000) throw new Error("扫描文件数量超限")
      if ((await fs.stat(file)).size > 1000000) continue
      const text = await fs.readFile(file,"utf8"), rel = path.relative(base,file).split(path.sep).join("/")
      const tree = parser.parse(text)
      const services = new Map<string,string>()
      for (const node of children(tree.topNode)) {
        if (node.name !== "AssignStatement") continue
        const parts = children(node), variable = parts[0], call = parts.find(n=>n.name==="CallExpression")
        if (variable?.name !== "VariableName" || !call) continue
        const args = call.getChild("ArgList")
        if (!args || text.slice(call.from,args.from).trim() !== "SV") continue
        const items = children(args).filter(n=>!["(",")",","].includes(n.name))
        const first = items[1]?.name==="AssignOp" ? (text.slice(items[0].from,items[0].to)==="name" ? items[2] : undefined) : items[0]
        const names = first ? strings(first,text) : null
        if (names?.length===1) services.set(text.slice(variable.from,variable.to),names[0])
      }
      tree.iterate({enter(ref) {
        if (ref.type.isError) { if (warnings.length<200) warnings.push("语法待核对："+rel); return }
        if (ref.name !== "DecoratedStatement") return
        const nodes = children(ref.node), fn = nodes.find(n=>n.name==="FunctionDefinition")
        const method = fn?.getChild("VariableName")
        if (!method) return
        const fnc = text.slice(method.from,method.to)
        for (const dec of nodes.filter(n=>n.name==="Decorator")) {
          const args = dec.getChild("ArgList")
          if (!args) continue
          const callee = text.slice(dec.from,args.from).trim().replace(/^@/,"")
          const kind = callee.split(".").pop() || ""
          if (!kinds.has(kind)) continue
          const parts = children(args).filter(n=>!["(",")",","].includes(n.name))
          const arg = parts[1]?.name==="AssignOp" ? (["keyword","keywords"].includes(text.slice(parts[0].from,parts[0].to)) ? parts[2] : undefined) : parts[0]
          const values = arg ? strings(arg,text) : null
          if (!values) { if(warnings.length<200) warnings.push("动态触发器："+rel+":"+fnc); continue }
          const receiver = callee.slice(0,callee.lastIndexOf("."))
          const service = services.get(receiver) || ""
          let prefix: boolean | undefined = true
          let positional = 0
          for (let i=0;i<parts.length;i++) {
            if (parts[i+1]?.name==="AssignOp") {
              if (text.slice(parts[i].from,parts[i].to)==="prefix") {
                const v = parts[i+2] ? text.slice(parts[i+2].from,parts[i+2].to) : ""
                prefix = v==="True" ? true : v==="False" ? false : undefined
              }
              i+=2
            } else if (++positional===4) {
              const v=text.slice(parts[i].from,parts[i].to)
              prefix=v==="True"?true:v==="False"?false:undefined
            }
          }
          for (const value of values.filter(Boolean)) {
            const plugin = rel.split("/")[1] || rel
            const resolved = resolveGSRule(configs.get(plugin),service,prefix,kind,value)
            if (!resolved) continue
            const doc = externalDocument("gscore",[rel,fnc,callee,kind,value],{framework:"gscore",pluginKey:plugin,pluginName:plugin,registrationKey:rel,fnc,description:"",...resolved,triggerText:value,triggerType:kind,origin:{type:"gscore-static",file:rel,method:fnc}})
            if (seen.has(doc.id)) continue
            seen.add(doc.id); documents.push(doc)
            if(documents.length>10000) throw new Error("指令数量超限")
          }
        }
      }})
    }
  }
  for (const name of ["plugins","buildin_plugins"]) {
    const dir=path.join(base,name)
    if(await fs.lstat(dir).then(s=>s.isDirectory(),()=>false)){found++;await walk(dir,0)}
  }
  if(!found) throw new Error("未找到 GSCore 插件目录")
  return {schemaVersion:1,sourceId:"gscore",complete:false,documents,warnings}
}
