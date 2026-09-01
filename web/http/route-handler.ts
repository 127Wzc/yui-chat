export type UnknownRecord = Record<string, unknown>

export interface RouteRequest extends UnknownRecord {
  query: UnknownRecord
  body: UnknownRecord
  params: Record<string, string>
  headers?: UnknownRecord
  path?: string
  method?: string
}

export interface RouteResponse {
  status(code: number): RouteResponse
  json(payload: UnknownRecord): unknown
  type(value: string): RouteResponse
  send(value: unknown): unknown
  set(headers: UnknownRecord | string, value?: string): RouteResponse
  append(name: string, value: string): unknown
}

export interface RouteApp {
  get(path: string, ...handlers: unknown[]): unknown
  post(path: string, ...handlers: unknown[]): unknown
  put(path: string, ...handlers: unknown[]): unknown
  patch(path: string, ...handlers: unknown[]): unknown
  delete(path: string, ...handlers: unknown[]): unknown
}

interface RouteOptions {
  errorStatus?: number
  includeValidation?: boolean
}

export type RouteHandler = (req: RouteRequest, res: RouteResponse, next: unknown) => Promise<unknown> | unknown

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(record(error).message || error || "请求失败")
}

export function handleRoute(
  handler: RouteHandler,
  options: RouteOptions = {},
): RouteHandler {
  const errorStatus = options.errorStatus || 500
  return async function routeHandler(req: RouteRequest, res: RouteResponse, next: unknown): Promise<unknown> {
    try {
      return await handler(req, res, next)
    } catch (error) {
      const details = record(error)
      const payload: UnknownRecord = { ok: false, error: errorMessage(error) }
      if (options.includeValidation) payload.validation = details.validation
      if (Array.isArray(details.references)) payload.references = details.references
      const statusCode = Number.isInteger(details.statusCode) ? Number(details.statusCode) : errorStatus
      return res.status(statusCode).json(payload)
    }
  }
}
