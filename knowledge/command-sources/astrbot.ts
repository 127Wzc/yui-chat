import { commandApi } from "./http.js"
import type { CommandBundle } from "../command-scanner.js"
import { externalDocument } from "./document.js"
type Row = Record<string, any>
export async function scanAstrBot(address: string, token: string): Promise<CommandBundle> {
  if (!address || !token) throw new Error("请填写 AstrBot API 地址和 JWT")
  const result = await commandApi(address, "/api/commands", token) as Row
  if (result.status !== "ok" || !Array.isArray(result.data?.items)) throw new Error("AstrBot 未返回有效指令列表，请核对 JWT")
  const documents: Row[] = [], warnings = ["仅采集 API 暴露的指令，不包含独立正则触发器；停用指令不收录"]
  const prefixes: string[] = Array.isArray(result.data.wake_prefix) ? result.data.wake_prefix.filter((v: unknown) => typeof v === "string") : []
  function visit(rows: Row[]): void {
    for (const row of rows) {
      if (row.enabled === false || row.plugin_activated === false) continue
      if (!row.is_group && row.handler_full_name && row.effective_command) {
        const examples = prefixes.map(p => p + row.effective_command)
        documents.push(externalDocument("astrbot", [row.handler_full_name], {
          framework: "astrbot", pluginKey: row.plugin, pluginName: row.plugin_display_name || row.plugin,
          registrationKey: row.module_path, fnc: row.handler_name, description: row.description || "",
          permission: row.permission === "everyone" ? "all" : row.permission,
          suggestedCommand: examples[0] || "", examples, activation: "runtime-enabled",
          aliases: row.aliases || [], origin: { type: "astrbot-api", handler: row.handler_full_name }
        }))
      }
      if (Array.isArray(row.sub_commands)) visit(row.sub_commands)
    }
  }
  visit(result.data.items)
  return { schemaVersion: 1, sourceId: "astrbot", complete: false, documents, warnings }
}

