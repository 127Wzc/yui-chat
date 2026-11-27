import crypto from "node:crypto"
type Row = Record<string, any>
export function externalDocument(source: string, identity: unknown[], metadata: Row): Row {
  const id = "cmd-" + crypto.createHash("sha256").update(JSON.stringify([source, ...identity])).digest("hex")
  const title = String(metadata.suggestedCommand || metadata.triggerText || metadata.fnc)
  return { id, title, metadata, retrievalText: [
    "插件名称：" + metadata.pluginName, "插件标识：" + metadata.pluginKey,
    "指令：" + (metadata.suggestedCommand || "待核实（静态触发规则）"), "用途：" + (metadata.description || "待核实"),
    "参数：待核实", "示例：" + (metadata.examples || []).join("、")
  ].join("\n") }
}
