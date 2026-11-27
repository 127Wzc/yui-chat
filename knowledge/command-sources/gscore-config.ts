import fs from "node:fs/promises"
import path from "node:path"
type Row = Record<string, any>
export async function loadGSConfigs(root: string): Promise<Map<string, Row>> {
  const dir = path.join(root, "data", "plugins_configs")
  const configs = new Map<string, Row>()
  for (const entry of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const file = path.join(dir,entry.name)
    if ((await fs.stat(file)).size > 2*1024*1024) continue
    try { configs.set(entry.name.slice(0,-5),JSON.parse(await fs.readFile(file,"utf8"))) } catch { /* unresolved configuration */ }
  }
  return configs
}
export function resolveGSRule(config: Row | undefined, service: string, prefix: boolean | undefined, kind: string, value: string): Row | null {
  const sv = config?.sv?.[service]
  if (config?.enabled === false || sv?.enabled === false) return null
  const unresolved = {activation:"unverified-static",examples:[],suggestedCommand:""}
  if (!config || config.enabled !== true || sv?.enabled !== true || prefix === undefined) return unresolved
  const list = (v: unknown): string[] | null => typeof v === "string" ? [v] : Array.isArray(v) && v.every(x=>typeof x==="string") ? v : null
  const normal = list(config.prefix), forced = list(config.force_prefix)
  if (prefix && (!normal || !forced || typeof config.allow_empty_prefix !== "boolean" || typeof config.disable_force_prefix !== "boolean")) return unresolved
  const prefixes = prefix ? [...new Set([...(normal||[]).filter(Boolean),...(config.disable_force_prefix?[]:forced||[]),...(config.allow_empty_prefix?[""]:[])])] : [""]
  if (!prefixes.length) prefixes.push("")
  const examples = kind === "on_fullmatch" || kind === "on_command" ? prefixes.map(p=>p+value) : []
  return {activation:"config-resolved",service,prefixes,examples,suggestedCommand:examples[0]||"",priority:sv.priority,permissionLevel:Math.min(Number(config.pm??6),Number(sv.pm??6)),pluginPermissionLevel:config.pm,servicePermissionLevel:sv.pm,area:sv.area,pluginArea:config.area}
}
