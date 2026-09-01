export {}

declare global {
  type YuiChatMessageSegment = Record<string, unknown>

  interface YuiChatHostSegmentFactory {
    at?: (userId: string | number) => unknown
    image?: (value: unknown) => unknown
    record?: (value: unknown) => unknown
    video?: (value: unknown) => unknown
    file?: (value: unknown) => unknown
    reply?: (messageId: string | number) => unknown
    [name: string]: ((...args: unknown[]) => unknown) | undefined
  }

  interface YuiChatHostBot {
    express?: unknown
    wsf?: Record<string, unknown>
    stat?: { online?: number }
    once?: (event: string, handler: (...args: unknown[]) => void) => unknown
    pickUser?: (userId: string | number) => { sendMsg?: (...args: unknown[]) => unknown | Promise<unknown> }
    [name: string]: unknown
  }

  interface YuiChatHostLogger {
    mark?: (...args: unknown[]) => void
    info?: (...args: unknown[]) => void
    warn?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
    debug?: (...args: unknown[]) => void
    [name: string]: ((...args: unknown[]) => unknown) | undefined
  }

  var Bot: YuiChatHostBot | undefined
  var logger: YuiChatHostLogger | undefined
  var segment: YuiChatHostSegmentFactory | undefined
  var plugin: unknown
}
