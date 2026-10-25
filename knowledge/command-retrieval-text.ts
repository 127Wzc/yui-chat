type Row = Record<string, unknown>

/** 去掉采集实现字段；原始事实始终保留在 metadata 中。兼容多行正则。 */
export function cleanCommandRetrievalText(value: unknown, metadata: Row = {}): string {
  const lines = String(value ?? "").replace(/\r\n?/gu, "\n").split("\n")
  const output: string[] = []
  let skipping = false, regexRemaining = 0
  for (const line of lines) {
    if (regexRemaining > 0) { regexRemaining--; continue }
    const field = line.match(/^\s*([^：:\n]{1,32})[：:]/u)?.[1].trim()
    if (field && ["priority", "regexp", "regexpFlags"].includes(field)) {
      skipping = true
      if (field === "regexp") regexRemaining = Math.max(0, String(metadata.regexp || "").split("\n").length - 1)
      continue
    }
    if (field) skipping = false
    if (!skipping) output.push(line)
  }
  return output.join("\n").trim()
}

/** 事件/内部监听保留在目录中，但不伪装成可以发送的指令。 */
export function isSendableCommand(command: Row): boolean {
  const event = String(command.event || "message")
  if (/^(?:notice|request|meta_event)(?:\.|$)/u.test(event)) return false
  const source = String(command.regexp || "")
  const broad = ["", "(?:)", ".*", ".+", "^(.*)", "^.*$", "^.+$", "^(.*)$", "^(.+)$", "^[\\s\\S]*$", "^[\\s\\S]+$", "^(?!#).*$"].includes(source)
  // 宽泛监听只有人工确认的具体触发文本才进入发送推荐。
  return !broad || Boolean(command.suggestedCommand && !/待核实|无法确认/u.test(String(command.suggestedCommand)))
}
