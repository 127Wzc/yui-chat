declare module "better-sqlite3" {
  interface DatabaseOptions {
    readonly?: boolean
    fileMustExist?: boolean
    timeout?: number
  }

  interface Statement {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): Record<string, unknown>
    pluck(toggle?: boolean): Statement
  }

  interface Database {
    readonly open: boolean
    prepare(sql: string): Statement
    exec(sql: string): void
    pragma(sql: string): unknown
    transaction<T>(operation: () => T): () => T
    close(): void
  }

  class BetterSqlite3 implements Database {
    readonly open: boolean
    constructor(file: string, options?: DatabaseOptions)
    prepare(sql: string): Statement
    exec(sql: string): void
    pragma(sql: string): unknown
    transaction<T>(operation: () => T): () => T
    close(): void
  }

  export default BetterSqlite3
}

declare module "sqlite-vec" {
  export function load(database: unknown): void
}
