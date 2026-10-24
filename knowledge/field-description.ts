/** 库级字段约定只用于解释检索结果，不参与分块或向量计算。 */
export const DEFAULT_COMMAND_FIELD_DESCRIPTION = [
  "插件名称为展示名称，插件标识为来源标识；指令为建议发送的文本，用途和示例说明使用方式。",
  "priority 为宿主响应优先级，数值越小越先尝试；未知表示未采集到。仅同一指令的多个实现比较优先级，不覆盖不同指令的相关性排序。",
  "regexp 为触发匹配的正则表达式源码，regexpFlags 为正则选项（如 i 表示忽略大小写，空字符串表示无选项）。正则不是用户直接发送的指令。",
].join("\n")

export function normalizeFieldDescription(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value !== "string") throw new Error("字段说明必须是文本")
  if (value.length > 2000) throw new Error("字段说明不能超过 2000 字符")
  return value.trim()
}
