/** 库级字段约定只用于解释检索结果，不参与分块或向量计算。 */
export const DEFAULT_COMMAND_FIELD_DESCRIPTION = [
  "插件名称为展示名称，插件标识为来源标识；指令为语法模板，用途和具体示例说明使用方式。<参数> 为必填替换变量，[参数] 为可选部分，不原样发送括号。",
  "priority 为宿主响应优先级，数值越小越先尝试；未知表示未采集到。仅同一指令的多个实现比较优先级，不覆盖不同指令的相关性排序。",
  "priority、regexp 和 regexpFlags 是元数据中的运行事实，不参与检索正文。顺序仅表示已知调度顺序，实际处理仍受权限、上下文和处理结果影响。",
].join("\n")

export function normalizeFieldDescription(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value !== "string") throw new Error("字段说明必须是文本")
  if (value.length > 2000) throw new Error("字段说明不能超过 2000 字符")
  return value.trim()
}
