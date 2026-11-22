function runEnd(source: string, start: number): number {
  let end = start + 1
  while (source[end] === source[start]) end++
  return end
}

function atLineStart(source: string, index: number): boolean {
  let start = index
  while (start > 0 && index - start < 3 && source[start - 1] === " ") start--
  return start === 0 || source[start - 1] === "\n"
}

/** 预先配对定长反引号，未闭合标记不会从每个位置反复搜索剩余正文。 */
function markdownBoundaries(source: string): { pairs: Map<number, number>; codeEnds: Map<number, number> } {
  const runs = [...source.matchAll(/`+/gu)]
  const nextByLength = new Map<number, number>(), inlineEnds = new Map<number, number>()
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!
    const next = nextByLength.get(run[0].length)
    if (next !== undefined) inlineEnds.set(run.index, next + run[0].length)
    nextByLength.set(run[0].length, run.index)
  }
  const pairs = new Map<number, number>(), codeEnds = new Map<number, number>()
  const brackets: number[] = [], parentheses: number[] = []
  for (let index = 0; index < source.length;) {
    const character = source[index]
    if (character === "\\") { index += 2; continue }
    if ((index === 0 || source[index - 1] === "\n") && (source[index] === "\t" || source.startsWith("    ", index))) {
      const end = source.indexOf("\n", index)
      codeEnds.set(index, end < 0 ? source.length : end)
      index = codeEnds.get(index)!
      continue
    }
    if (character === "`" || character === "~") {
      const end = runEnd(source, index), length = end - index
      if (length >= 3 && atLineStart(source, index)) {
        let line = source.indexOf("\n", end), codeEnd = source.length
        while (line >= 0) {
          const start = line + 1
          let marker = start
          while (marker - start < 3 && source[marker] === " ") marker++
          const markerEnd = source[marker] === character ? runEnd(source, marker) : marker
          line = source.indexOf("\n", markerEnd)
          if (markerEnd - marker >= length && /^[ \t\r]*$/u.test(source.slice(markerEnd, line < 0 ? source.length : line))) {
            codeEnd = line < 0 ? source.length : line
            break
          }
        }
        codeEnds.set(index, codeEnd)
        index = codeEnd
        continue
      }
      const inlineEnd = character === "`" ? inlineEnds.get(index) : undefined
      if (inlineEnd !== undefined) { codeEnds.set(index, inlineEnd); index = inlineEnd; continue }
      index = end
      continue
    }
    if (character === "[") brackets.push(index)
    else if (character === "]" && brackets.length) pairs.set(brackets.pop()!, index)
    else if (character === "(") parentheses.push(index)
    else if (character === ")" && parentheses.length) pairs.set(parentheses.pop()!, index)
    index++
  }
  return { pairs, codeEnds }
}

function linkTarget(source: string): string | null {
  const body = source.trim()
  const end = body.startsWith("<") ? body.indexOf(">") + 1 : body.search(/\s/u)
  const target = end < 0 ? body : body.slice(0, end)
  const title = end < 0 ? "" : body.slice(end).trim()
  if (!target || title && !/^(?:"[^"]*"|'[^']*'|\([^()]*\))$/u.test(title)) return null
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target
}

function isOpenAiSearchUrl(value: string): boolean {
  try {
    const url = new URL(value.replaceAll("&amp;", "&"))
    return /^https?:$/u.test(url.protocol)
      && [...url.searchParams].some(([key, value]) => key.toLowerCase() === "utm_source" && value.toLowerCase() === "openai")
  } catch {
    // 非完整 HTTP(S) 地址不属于目标引用，保持原文。
    return false
  }
}

/** 只移除带 utm_source=openai 的正文链接；其他文字、链接、代码和图片保持原样。 */
export function cleanBodyLinks(value: unknown): string {
  const source = String(value ?? "")
  const { pairs, codeEnds } = markdownBoundaries(source)
  const ranges: Array<{ start: number; end: number }> = []
  const remove = (start: number, end: number): number => {
    const wrappers: Record<string, string> = { "(": ")", "（": "）", "<": ">", "[": "]" }
    while (true) {
      let left = start, right = end
      while (left > 0 && /[ \t]/u.test(source[left - 1]!)) left--
      while (right < source.length && /[ \t]/u.test(source[right]!)) right++
      const close = left > 0 ? wrappers[source[left - 1]!] : undefined
      if (!close || close !== source[right]) break
      start = left - 1; end = right + 1
    }
    ranges.push({ start, end })
    return end
  }
  for (let index = 0; index < source.length;) {
    const codeEnd = codeEnds.get(index)
    if (codeEnd !== undefined) { index = codeEnd; continue }
    if (source[index] === "\\") { index += 2; continue }
    const image = source[index] === "!" && source[index + 1] === "["
    const bracket = image ? index + 1 : index
    const labelEnd = source[bracket] === "[" ? pairs.get(bracket) : undefined
    if (labelEnd !== undefined) {
      const destinationEnd = source[labelEnd + 1] === "(" ? pairs.get(labelEnd + 1) : undefined
      if (destinationEnd !== undefined) {
        const target = linkTarget(source.slice(labelEnd + 2, destinationEnd))
        if (image || target !== null) {
          index = !image && isOpenAiSearchUrl(target!) ? remove(index, destinationEnd + 1) : destinationEnd + 1
          continue
        }
      }
      // 引用式定义不属于行内搜索引用，避免破坏依赖这些地址的图片。
      if (source[labelEnd + 1] === ":" && atLineStart(source, index)) {
        const end = source.indexOf("\n", labelEnd + 2)
        index = end < 0 ? source.length : end
        continue
      }
      if (image) { index = labelEnd + 1; continue }
    }
    if ((source[index] === "h" || source[index] === "H") && /^https?:\/\//iu.test(source.slice(index, index + 8))) {
      let end = index, depth = 0
      while (end < source.length && !/[\s<>\[\]"'`（），。！？；：“”‘’]/u.test(source[end]!)) {
        if (source[end] === "(") depth++
        else if (source[end] === ")") { if (!depth) break; depth-- }
        end++
      }
      const target = source.slice(index, end).replace(/[.,!?;:]+$/u, "")
      index = isOpenAiSearchUrl(target) ? remove(index, index + target.length) : end
      continue
    }
    index++
  }
  if (!ranges.length) return source
  const result: string[] = []
  let cursor = 0
  for (const range of ranges) { result.push(source.slice(cursor, Math.max(cursor, range.start))); cursor = Math.max(cursor, range.end) }
  result.push(source.slice(cursor))
  return result.join("")
}
