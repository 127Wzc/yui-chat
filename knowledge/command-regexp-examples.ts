import vm from "node:vm"
import { createHash } from "node:crypto"

const MAX_PATTERN = 1500
const MAX_TEXT = 180
const MAX_POOL = 48
const MAX_EXAMPLES = 8
const cache = new Map<string, string[]>()
export interface CommandRegexpCheck { state: "verified" | "invalid" | "unverified"; matches: boolean[]; reason?: "budget" | "timeout" }
const checks = new Map<string, CommandRegexpCheck>()

/** Validate imported examples, including URLs, without executing handlers or unrestricted regex work. */
export function inspectCommandRegexp(source: string, flags: string, examples: readonly string[], execute = true): CommandRegexpCheck {
  const key = createHash("sha256").update(JSON.stringify([source, flags, examples])).digest("hex")
  const cached = checks.get(key)
  if (cached) return { ...cached, matches: [...cached.matches] }
  if (!execute || source.length > 65000 || flags.length > 20 || examples.length > 64 || examples.some(value => value.length > 8192) || examples.join("").length > 32768) {
    return { state: "unverified", matches: [], reason: "budget" }
  }
  let result: CommandRegexpCheck
  try {
    const matches = new vm.Script("const regex = new RegExp(source, flags); input.map(value => { regex.lastIndex = 0; return regex.test(value) })")
      .runInNewContext({ source, flags, input: [...examples] }, { timeout: 15 }) as boolean[]
    result = { state: "verified", matches: Array.from(matches) }
  } catch (error) {
    result = (error as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
      ? { state: "unverified", matches: [], reason: "timeout" }
      : (error as { name?: string }).name === "SyntaxError" ? { state: "invalid", matches: [] }
        : { state: "unverified", matches: [], reason: "budget" }
  }
  if (checks.size >= 4096) checks.delete(checks.keys().next().value!)
  checks.set(key, result)
  return { ...result, matches: [...result.matches] }
}

/** Match untrusted registration patterns with a shared time limit and fresh lastIndex per example. */
export function validatedCommandExamples(pattern: unknown, candidates: readonly unknown[], flags = ""): string[] {
  const source = String(pattern ?? "")
  if (!source || source.length > MAX_PATTERN || flags.length > 20) return []
  const urlPattern = /https?[:?]|(?:[a-z0-9-]+\.)+[a-z]{2,}\//iu.test(source.replace(/\\([./:])/gu, "$1"))
  const input = [...new Set(candidates.filter((value): value is string => typeof value === "string")
    .map(value => value.trim()).filter(value => value.length > 1 && value.length <= MAX_TEXT
      && !/[\\\r\n\p{Co}]|<[^>]+>|\$\^/u.test(value)
      && !/^(?:[a-z][a-z0-9+.-]*:\/\/|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$))/iu.test(value)
      && (!urlPattern || /^[#/*!%]/u.test(value))))].slice(0, MAX_POOL)
  if (!input.length) return []
  const check = inspectCommandRegexp(source, flags, input)
  return check.state === "verified" ? input.filter((_, index) => check.matches[index]) : []
}

/** Bounded syntax expansion, not a complete regex interpreter. Original-pattern validation is mandatory. */
export function commandExamplesFromRegexp(pattern: unknown, flags = ""): string[] {
  const source = String(pattern ?? ""), key = JSON.stringify([source, flags])
  const cached = cache.get(key)
  if (cached) return [...cached]
  if (!source || source.length > MAX_PATTERN || flags.includes("v")) return []
  let offset = 0, operations = 0, hasLiteral = false
  const bounded = (values: string[]): string[] => [...new Set(values.filter(value => value.length <= MAX_TEXT))].slice(0, MAX_POOL)
  const combine = (left: string[], right: string[]): string[] => {
    const values: string[] = []
    for (const a of left) for (const b of right) {
      if (++operations > 100000) throw new Error("candidate budget")
      if (a.length + b.length <= MAX_TEXT) values.push(a + b)
      if (values.length >= MAX_POOL) return bounded(values)
    }
    return bounded(values)
  }
  const interleave = (branches: string[][]): string[] => {
    const result: string[] = []
    for (let rank = 0; rank < MAX_POOL; rank++) for (const branch of branches) {
      const value = branch[rank]
      if (value !== undefined && !result.includes(value)) result.push(value)
      if (result.length >= MAX_POOL) return result
    }
    return result
  }
  function expression(depth: number): string[] {
    if (depth > 24) throw new Error("nesting budget")
    const branches: string[][] = []
    let sequence = [""]
    while (offset < source.length && source[offset] !== ")") {
      if (source[offset] === "|") { offset++; branches.push(sequence); sequence = [""]; continue }
      let values = atom(depth), minimum = 1, optional = false
      const quantifier = source[offset]
      if (quantifier === "*" || quantifier === "?" || quantifier === "+") {
        offset++; minimum = quantifier === "+" ? 1 : 0; optional = minimum === 0
      } else if (quantifier === "{") {
        const match = source.slice(offset).match(/^\{(\d+)(?:,(\d*))?\}/u)
        if (!match) throw new Error("unsupported quantifier")
        minimum = Number(match[1]); optional = minimum === 0; offset += match[0].length
        if (match[2] && Number(match[2]) < minimum) throw new Error("invalid quantifier")
      }
      if (source[offset] === "?" && quantifier && "*?+{".includes(quantifier)) offset++
      if (minimum > 32) values = []
      else if (minimum > 1) {
        const unit = values; values = [""]
        for (let count = 0; count < minimum; count++) values = combine(values, unit)
      }
      // Prefer omitting optional transport/argument syntax; keep readable literal affixes such as Cookie.
      if (optional) values = quantifier === "{" || values.some(value => /^\s|^@|^\[|示例/u.test(value))
        ? bounded(["", ...values]) : bounded([...values.slice(0, MAX_POOL - 1), ""])
      sequence = combine(sequence, values)
    }
    branches.push(sequence)
    return interleave(branches)
  }
  function atom(depth: number): string[] {
    const character = source[offset++]
    if (character === "^" || character === "$") return [""]
    if (character === ".") return ["示例"]
    if (character === "(") {
      let assertion = false
      if (source[offset] === "?") {
        offset++
        const kind = source[offset++]
        if (kind === "=" || kind === "!") assertion = true
        else if (kind === "<") {
          if (source[offset] === "=" || source[offset] === "!") { offset++; assertion = true }
          else { const end = source.indexOf(">", offset); if (end < 0) throw new Error("invalid group"); offset = end + 1 }
        } else if (kind !== ":") throw new Error("unsupported group")
      }
      const values = expression(depth + 1)
      if (source[offset++] !== ")") throw new Error("unclosed group")
      return assertion ? [""] : values
    }
    if (character === "[") {
      const start = offset - 1
      while (offset < source.length && source[offset] !== "]") { if (source[offset++] === "\\") offset++ }
      if (source[offset++] !== "]") throw new Error("unclosed class")
      const raw = source.slice(start, offset)
      if (raw === "[\\s\\S]" || raw === "[\\S\\s]") return ["示例"]
      const content = raw.slice(1, -1), negated = content.startsWith("^")
      if (!negated) hasLiteral = true
      // Only a single parsed character class is compiled here, without repetition or grouping.
      const regex = new RegExp(`^(?:${raw})$`, flags.replace(/[gydms]/gu, ""))
      const pool = negated ? ["1", "a", "中", " "] : [...Array.from(content), "1", "0", "a", "A", "中", " "]
      const values = bounded(pool.filter(value => value !== "\\" && regex.test(value)))
      const casePair = content.length === 2 && content[0].toLowerCase() === content[1].toLowerCase()
      return negated || casePair || /^(?:[a-zA-Z0-9]-[a-zA-Z0-9])+$/u.test(content) ? values.slice(0, 1) : values
    }
    if (character === "\\") {
      const escaped = source[offset++]
      if (escaped === "b" || escaped === "B") return [""]
      if (escaped === "d") { hasLiteral = true; return ["1"] }
      if (escaped === "w") return ["a"]
      if (escaped === "s") return [" "]
      if (escaped === "D" || escaped === "W" || escaped === "S") return ["中"]
      if (escaped === "n" || escaped === "r" || escaped === "t") return [{ n: "\n", r: "\r", t: "\t" }[escaped]]
      if (escaped === "x" || escaped === "u") {
        const width = escaped === "x" ? 2 : 4, hex = source.slice(offset, offset + width)
        if (!new RegExp(`^[0-9a-f]{${width}}$`, "iu").test(hex)) throw new Error("unsupported escape")
        offset += width; hasLiteral = true; return [String.fromCharCode(parseInt(hex, 16))]
      }
      if (!escaped || /[0-9kpc]/iu.test(escaped)) throw new Error("unsupported reference or escape")
      if (/[\p{L}\p{N}]/u.test(escaped)) hasLiteral = true
      return [escaped]
    }
    if (!character || "*+?{}]".includes(character)) throw new Error("unexpected token")
    if (/[\p{L}\p{N}]/u.test(character)) hasLiteral = true
    return [character]
  }
  let examples: string[] = []
  try {
    const candidates = expression(0)
    if (offset === source.length && hasLiteral) {
      let verified = validatedCommandExamples(source, candidates, flags)
      // Prefer direct command syntax over optional @/reply compatibility prefixes.
      if (verified.some(value => /^[#/*%!]/u.test(value))) verified = verified.filter(value => !/^(?:@|\[reply:)/iu.test(value))
      verified.sort((a, b) => Number(/^[#/*%!]/u.test(b)) - Number(/^[#/*%!]/u.test(a)))
      examples = verified.slice(0, MAX_EXAMPLES)
    }
  } catch {
    // Unsupported syntax is left for external preparation instead of emitting a mangled command.
  }
  cache.set(key, examples)
  if (cache.size > 512) cache.delete(cache.keys().next().value!)
  return [...examples]
}
