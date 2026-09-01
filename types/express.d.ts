declare module "express" {
  interface ExpressRequest {
    path?: string
  }

  interface ExpressResponse {
    set(headers: Record<string, string>): ExpressResponse
    set(name: string, value: string): ExpressResponse
    type(value: string): ExpressResponse
    send(value: unknown): unknown
  }

  type ExpressHandler = (req: ExpressRequest, res: ExpressResponse, next: () => void) => unknown

  interface ExpressRouter {
    use(...handlers: unknown[]): unknown
    get(path: string, ...handlers: ExpressHandler[]): unknown
    post(path: string, ...handlers: ExpressHandler[]): unknown
    put(path: string, ...handlers: ExpressHandler[]): unknown
    patch(path: string, ...handlers: ExpressHandler[]): unknown
    delete(path: string, ...handlers: ExpressHandler[]): unknown
  }

  interface ExpressFactory {
    Router(): ExpressRouter
    json(options?: Record<string, unknown>): unknown
    static(root: string, options?: Record<string, unknown>): unknown
  }

  const express: ExpressFactory
  export default express
}
