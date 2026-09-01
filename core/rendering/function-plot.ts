type Token = { type: "number" | "name" | "operator" | "paren" | "comma"; value: string }
type RpnToken = Token & { arity?: number }

const functions: Record<string, (value: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
}

const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3, "u-": 4 }

function tokenize(raw: string): Token[] {
  const source = raw.trim().replace(/^\s*(?:y\s*=|f\s*\(\s*x\s*\)\s*=)\s*/i, "")
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const rest = source.slice(index)
    const whitespace = rest.match(/^\s+/)
    if (whitespace) { index += whitespace[0].length; continue }
    const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i)
    if (number) { tokens.push({ type: "number", value: number[0] }); index += number[0].length; continue }
    const name = rest.match(/^[a-z_][a-z0-9_]*/i)
    if (name) { tokens.push({ type: "name", value: name[0].toLowerCase() }); index += name[0].length; continue }
    const char = source[index]
    if ("+-*/^".includes(char)) tokens.push({ type: "operator", value: char })
    else if ("()".includes(char)) tokens.push({ type: "paren", value: char })
    else if (char === ",") tokens.push({ type: "comma", value: char })
    else throw new Error(`不支持的表达式字符：${char}`)
    index += 1
  }
  if (!tokens.length) throw new Error("函数表达式不能为空。")
  return tokens
}

function isValueEnd(token: Token | undefined): boolean {
  return Boolean(token && (token.type === "number" || token.type === "name" || (token.type === "paren" && token.value === ")")))
}

function isValueStart(token: Token | undefined): boolean {
  return Boolean(token && (token.type === "number" || token.type === "name" || (token.type === "paren" && token.value === "(")))
}

function withImplicitMultiplication(tokens: Token[]): Token[] {
  const out: Token[] = []
  for (const token of tokens) {
    const previous = out[out.length - 1]
    const functionCall = previous?.type === "name" && Object.hasOwn(functions, previous.value) && token.type === "paren" && token.value === "("
    if (!functionCall && isValueEnd(previous) && isValueStart(token)) out.push({ type: "operator", value: "*" })
    out.push(token)
  }
  return out
}

function toRpn(raw: string): RpnToken[] {
  const tokens = withImplicitMultiplication(tokenize(raw))
  const output: RpnToken[] = []
  const stack: Token[] = []
  let previous: Token | undefined
  for (const token of tokens) {
    if (token.type === "number") output.push(token)
    else if (token.type === "name") {
      if (token.value === "x" || token.value === "pi" || token.value === "e") output.push(token)
      else if (Object.hasOwn(functions, token.value)) stack.push(token)
      else throw new Error(`不支持的函数或变量：${token.value}`)
    } else if (token.type === "operator") {
      const current: Token = { ...token, value: token.value === "-" && (!previous || previous.type === "operator" || previous.value === "(" || previous.type === "comma") ? "u-" : token.value }
      while (stack.length) {
        const top = stack[stack.length - 1]
        if (top.type !== "operator") break
        const rightAssociative = current.value === "^" || current.value === "u-"
        if ((precedence[top.value] || 0) < (precedence[current.value] || 0) || (rightAssociative && precedence[top.value] === precedence[current.value])) break
        output.push(stack.pop() as Token)
      }
      stack.push(current)
    } else if (token.type === "paren" && token.value === "(") stack.push(token)
    else if (token.type === "comma") {
      while (stack.length && stack[stack.length - 1].value !== "(") output.push(stack.pop() as Token)
      if (!stack.length) throw new Error("函数参数分隔符位置无效。")
    } else if (token.type === "paren" && token.value === ")") {
      while (stack.length && stack[stack.length - 1].value !== "(") output.push(stack.pop() as Token)
      if (!stack.length) throw new Error("函数表达式括号不匹配。")
      stack.pop()
      if (stack[stack.length - 1]?.type === "name") output.push({ ...(stack.pop() as Token), arity: 1 })
    }
    previous = token
  }
  while (stack.length) {
    const token = stack.pop() as Token
    if (token.type === "paren") throw new Error("函数表达式括号不匹配。")
    output.push(token)
  }
  return output
}

export function compileFunctionExpression(expression: string): (x: number) => number {
  const rpn = toRpn(expression)
  return (x: number): number => {
    const stack: number[] = []
    for (const token of rpn) {
      if (token.type === "number") stack.push(Number(token.value))
      else if (token.type === "name" && token.arity === 1) {
        const value = stack.pop()
        if (value === undefined) return Number.NaN
        stack.push(functions[token.value](value))
      } else if (token.type === "name") stack.push(token.value === "x" ? x : token.value === "pi" ? Math.PI : Math.E)
      else if (token.type === "operator") {
        if (token.value === "u-") {
          const value = stack.pop()
          if (value === undefined) return Number.NaN
          stack.push(-value)
          continue
        }
        const right = stack.pop()
        const left = stack.pop()
        if (left === undefined || right === undefined) return Number.NaN
        if (token.value === "+") stack.push(left + right)
        else if (token.value === "-") stack.push(left - right)
        else if (token.value === "*") stack.push(left * right)
        else if (token.value === "/") stack.push(left / right)
        else stack.push(left ** right)
      }
    }
    return stack.length === 1 ? stack[0] : Number.NaN
  }
}

function escapeXml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export interface FunctionPlotInput {
  title?: unknown
  expressions?: unknown
  expression?: unknown
  xMin?: unknown
  xMax?: unknown
  yMin?: unknown
  yMax?: unknown
}

export function buildFunctionPlotSvg(input: FunctionPlotInput = {}): { svg: string; meta: Record<string, unknown> } {
  const expressions = (Array.isArray(input.expressions) ? input.expressions : [input.expression || input.expressions])
    .map(item => String(item || "").trim()).filter(Boolean).slice(0, 6)
  if (!expressions.length) throw new Error("至少需要一个函数表达式。")
  const xMin = Number.isFinite(Number(input.xMin)) ? Number(input.xMin) : -10
  const xMax = Number.isFinite(Number(input.xMax)) ? Number(input.xMax) : 10
  if (xMin >= xMax) throw new Error("xMin 必须小于 xMax。")
  const compiled = expressions.map(expression => ({ expression, evaluate: compileFunctionExpression(expression) }))
  const samples = 720
  const values = compiled.flatMap(item => Array.from({ length: samples + 1 }, (_, index) => item.evaluate(xMin + (xMax - xMin) * index / samples)).filter(Number.isFinite))
  if (!values.length) throw new Error("函数在指定范围内没有可绘制的有限值。")
  let yMin = Number.isFinite(Number(input.yMin)) ? Number(input.yMin) : Math.min(...values)
  let yMax = Number.isFinite(Number(input.yMax)) ? Number(input.yMax) : Math.max(...values)
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMin === yMax) { yMin = yMin - 1; yMax = yMax + 1 }
  if (yMin >= yMax) throw new Error("yMin 必须小于 yMax。")
  const padding = (yMax - yMin) * 0.08
  if (!Number.isFinite(Number(input.yMin))) yMin -= padding
  if (!Number.isFinite(Number(input.yMax))) yMax += padding
  const width = 1200
  const height = 820
  const plot = { left: 100, top: 130, right: 1140, bottom: 740 }
  const px = (x: number) => plot.left + (x - xMin) / (xMax - xMin) * (plot.right - plot.left)
  const py = (y: number) => plot.bottom - (y - yMin) / (yMax - yMin) * (plot.bottom - plot.top)
  const colors = ["#257c6a", "#2d5f8b", "#7654a6", "#a84f61", "#a9842c", "#c15f2e"]
  const grid: string[] = []
  for (let index = 0; index <= 10; index++) {
    const x = plot.left + (plot.right - plot.left) * index / 10
    const y = plot.top + (plot.bottom - plot.top) * index / 10
    const xv = xMin + (xMax - xMin) * index / 10
    const yv = yMax - (yMax - yMin) * index / 10
    grid.push(`<line x1="${x}" y1="${plot.top}" x2="${x}" y2="${plot.bottom}" stroke="#e5e9e2"/><text x="${x}" y="${plot.bottom + 30}" text-anchor="middle">${escapeXml(xv.toFixed(2).replace(/\.00$/, ""))}</text>`)
    grid.push(`<line x1="${plot.left}" y1="${y}" x2="${plot.right}" y2="${y}" stroke="#e5e9e2"/><text x="${plot.left - 16}" y="${y + 7}" text-anchor="end">${escapeXml(yv.toFixed(2).replace(/\.00$/, ""))}</text>`)
  }
  const paths = compiled.map((item, expressionIndex) => {
    const segments: string[] = []
    let drawing = false
    let previousY = Number.NaN
    for (let index = 0; index <= samples; index++) {
      const x = xMin + (xMax - xMin) * index / samples
      const y = item.evaluate(x)
      const discontinuous = !Number.isFinite(y) || y < yMin - (yMax - yMin) || y > yMax + (yMax - yMin) || (Number.isFinite(previousY) && Math.abs(y - previousY) > (yMax - yMin) * 0.55)
      if (discontinuous) { drawing = false; previousY = y; continue }
      segments.push(`${drawing ? "L" : "M"}${px(x).toFixed(2)},${py(y).toFixed(2)}`)
      drawing = true
      previousY = y
    }
    return `<path d="${segments.join(" ")}" fill="none" stroke="${colors[expressionIndex]}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`
  })
  const xAxis = xMin <= 0 && xMax >= 0 ? `<line x1="${px(0)}" y1="${plot.top}" x2="${px(0)}" y2="${plot.bottom}" stroke="#667064" stroke-width="2"/>` : ""
  const yAxis = yMin <= 0 && yMax >= 0 ? `<line x1="${plot.left}" y1="${py(0)}" x2="${plot.right}" y2="${py(0)}" stroke="#667064" stroke-width="2"/>` : ""
  const legend = expressions.map((expression, index) => `<g transform="translate(${plot.left + index * 170},92)"><line x1="0" y1="0" x2="28" y2="0" stroke="${colors[index]}" stroke-width="5"/><text x="38" y="7" font-weight="700">${escapeXml(expression.slice(0, 18))}</text></g>`).join("")
  const title = String(input.title || "函数图").slice(0, 80)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f7f6ee"/><rect x="28" y="24" width="1144" height="772" rx="18" fill="#fff" stroke="#d9ded4"/><text x="64" y="66" font-family="sans-serif" font-size="30" font-weight="800" fill="#1f2520">${escapeXml(title)}</text><g font-family="sans-serif" font-size="15" fill="#667064">${grid.join("")}${xAxis}${yAxis}${paths.join("")}${legend}</g></svg>`
  return { svg, meta: { title, expressions, xMin, xMax, yMin, yMax, engine: "sharp-svg" } }
}
