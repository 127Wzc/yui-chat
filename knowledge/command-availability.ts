import { sqliteClient } from "../core/storage/sqlite/client.js"

type Row = Record<string, any>
export interface CommandAvailability { commands: Set<string>; plugins: Set<string> }
const identity = (sourceId: string, id: string): string => JSON.stringify([sourceId, id])
export function commandPluginId(metadata: Row): string {
  const key = typeof metadata.pluginKey === "string" ? metadata.pluginKey : "", name = typeof metadata.pluginName === "string" ? metadata.pluginName : ""
  return key ? `key:${key}` : name ? `name:${name}` : "manual:"
}
export async function readCommandAvailability(): Promise<CommandAvailability> {
  const state: CommandAvailability = { commands: new Set(), plugins: new Set() }
  if (sqliteClient.status.available) for (const row of await sqliteClient.all<Row>("SELECT source_id,kind,target_id FROM knowledge_command_disabled")) {
    state[row.kind === "plugin" ? "plugins" : "commands"].add(identity(row.source_id, row.target_id))
  }
  return state
}
export function commandAvailability(id: string, sourceId: string, metadata: Row, state: CommandAvailability): Row {
  const pluginId = commandPluginId(metadata)
  const commandEnabled = !state.commands.has(identity(sourceId, id)), pluginEnabled = !state.plugins.has(identity(sourceId, pluginId))
  return { pluginId, commandEnabled, pluginEnabled, enabled: commandEnabled && pluginEnabled }
}
// 参数仅为内部固定 SQL 列名；状态在候选 LIMIT 之前过滤，普通文档不受影响。
export function commandEnabledSql(metadata = "d.metadata_json"): string {
  const source = `COALESCE(json_extract(${metadata},'$.importSourceId'),'yunzai')`
  const plugin = `CASE WHEN json_type(${metadata},'$.command.pluginKey')='text' AND json_extract(${metadata},'$.command.pluginKey')<>'' THEN 'key:'||json_extract(${metadata},'$.command.pluginKey') WHEN json_type(${metadata},'$.command.pluginName')='text' AND json_extract(${metadata},'$.command.pluginName')<>'' THEN 'name:'||json_extract(${metadata},'$.command.pluginName') ELSE 'manual:' END`
  return `NOT EXISTS (SELECT 1 FROM knowledge_command_disabled s WHERE s.source_id=${source} AND ((s.kind='command' AND s.target_id=json_extract(${metadata},'$.commandId')) OR (s.kind='plugin' AND s.target_id=${plugin})))`
}
