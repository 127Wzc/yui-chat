/**
 * 消费供应商返回的 Server-Sent Events。
 *
 * 适配器只关心协议事件的 JSON 结构；这里负责处理 SSE 的 event/data
 * 分帧、跨网络 chunk 的半行以及多行 data，避免每个供应商重复实现一套
 * 读取循环。事件会在空行或流结束时派发。
 */
export interface ServerSentEvent {
  event: string
  data: string
}

export async function consumeServerSentEvents(
  response: Response,
  onEvent: (event: ServerSentEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error("流式响应没有可读取的正文")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let eventName = ""
  let dataLines: string[] = []

  const dispatch = (): void => {
    if (!dataLines.length) {
      eventName = ""
      return
    }
    const data = dataLines.join("\n")
    const event = eventName
    eventName = ""
    dataLines = []
    onEvent({ event, data })
  }

  const consumeLine = (line: string): void => {
    const value = String(line || "").replace(/\r$/, "")
    if (!value) {
      dispatch()
      return
    }
    // SSE 注释通常用于 keep-alive；不应让它形成一个空事件。
    if (value.startsWith(":")) return
    const separator = value.indexOf(":")
    const field = separator < 0 ? value : value.slice(0, separator)
    const content = separator < 0 ? "" : value.slice(separator + 1).replace(/^ /, "")
    if (field === "event") eventName = content
    else if (field === "data") dataLines.push(content)
  }

  let done = false
  while (!done) {
    const part = await reader.read()
    buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done })
    const lines = buffer.split(/\n/)
    buffer = part.done ? "" : lines.pop() || ""
    for (const line of lines) consumeLine(line)
    if (part.done) {
      if (buffer) consumeLine(buffer)
      dispatch()
      done = true
    }
  }
}
