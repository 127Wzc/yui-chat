import { createOutputFilters } from "./output.js"
import { normalizeFilter, type NormalizedFilter } from "../core/contract.js"

export const builtinFilterGroups: Array<{
  id: string
  label: string
  factory: () => unknown[]
}> = [
  { id: "message", label: "消息处理", factory: createOutputFilters },
]

/** 创建内置确定性过滤器；所有实现统一经过公共契约归一化。 */
export function createBuiltinFilters(): NormalizedFilter[] {
  return builtinFilterGroups.flatMap(group => group.factory()
    .map(filter => normalizeFilter(filter, {
      source: "builtin",
      category: group.id,
      categoryLabel: group.label,
    }))
    .filter((filter): filter is NormalizedFilter => Boolean(filter)))
}
