import type { CommandBundle } from "../command-scanner.js"
import { scanAstrBot } from "./astrbot.js"
import { scanGSCore } from "./gscore.js"
export interface CommandSourceField { key: string; label: string; type: "text" | "password"; defaultValue?: string }
export interface CommandSourceAdapter {
  id: string
  label: string
  fields: readonly CommandSourceField[]
  collect(options: Record<string, unknown>): Promise<CommandBundle>
}
const adapters = new Map<string, CommandSourceAdapter>()
export function registerCommandSource(adapter: CommandSourceAdapter): void {
  if (adapters.has(adapter.id)) throw new Error("重复采集来源")
  adapters.set(adapter.id,adapter)
}
registerCommandSource({id:"yunzai",label:"TRSS / Yunzai",fields:[],collect:async()=> (await import("../command-observer.js")).commandObserver.collectLoadedCommands()})
registerCommandSource({id:"astrbot",label:"AstrBot API",fields:[{key:"address",label:"API 地址",type:"text",defaultValue:"http://127.0.0.1:6185"},{key:"token",label:"Dashboard JWT",type:"password"}],collect:o=>scanAstrBot(String(o.address||""),String(o.token||""))})
registerCommandSource({id:"gscore",label:"GSCore 目录",fields:[{key:"root",label:"GSCore 项目绝对路径",type:"text"}],collect:o=>scanGSCore(String(o.root||""))})
export function listCommandSources() { return [...adapters.values()].map(({id,label,fields})=>({id,label,fields})) }
export async function collectCommandSource(id: string, options: Record<string,unknown>): Promise<CommandBundle> {
  const adapter=adapters.get(id)
  if(!adapter) throw new Error("未知采集来源")
  return adapter.collect(options)
}
