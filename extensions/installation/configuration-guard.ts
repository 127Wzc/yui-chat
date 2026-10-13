import { sqliteClient } from "../../core/storage/sqlite/client.js"
import type { RuntimeConfigObject } from "../../config/types.js"

/** Generic config editors cannot bypass managed activation, endpoint, binding or tool-review entry points. */
export async function assertManagedConfigWrite(before: RuntimeConfigObject, after: RuntimeConfigObject): Promise<void> {
  if (!sqliteClient.status.available) return
  const rows = await sqliteClient.all<{ kind: string; target_id: string }>("SELECT kind,target_id FROM extension_installation_receipts WHERE retired_at IS NULL")
  const unresolved = await sqliteClient.all<{ kind: string; target_id: string }>("SELECT json_extract(payload,'$.kind') AS kind,json_extract(payload,'$.plan.targetId') AS target_id FROM extension_installations WHERE json_extract(payload,'$.phase') IS NOT NULL AND status NOT IN ('succeeded','failed','canceled','expired')")
  rows.push(...unresolved)
  if (JSON.stringify((before.security as Record<string, any>)?.linkSafety?.extensionGrants) !== JSON.stringify((after.security as Record<string, any>)?.linkSafety?.extensionGrants)) throw new Error("扩展网络授权请使用安装记录中的精确授权入口")
  const priorSkills = before.skills as Record<string, any> || {}
  const nextSkills = after.skills as Record<string, any> || {}
  for (const row of rows) {
    if (row.kind === "skill") {
      const previous = (priorSkills.disabled || []).includes(row.target_id)
      const next = (nextSkills.disabled || []).includes(row.target_id)
      if (previous !== next) throw new Error("受管理 Skill 的启停请使用扩展页的独立入口")
    } else {
      const prior = (before.mcp?.servers as Record<string, unknown>)?.[row.target_id]
      const next = (after.mcp?.servers as Record<string, unknown>)?.[row.target_id]
      if (JSON.stringify(prior) !== JSON.stringify(next)) throw new Error("受管理 MCP 的修改请使用服务页和安装授权入口")
    }
  }
}
