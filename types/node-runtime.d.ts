declare module "node:path" {
  const path: {
    join: (...parts: string[]) => string
    dirname: (file: string) => string
    resolve: (...parts: string[]) => string
    relative: (from: string, to: string) => string
    isAbsolute: (file: string) => boolean
    basename: (file: string, suffix?: string) => string
    extname: (file: string) => string
    posix: { join: (...parts: string[]) => string }
  }
  export default path
}

declare module "node:fs/promises" {
  interface FileHandle {
    stat(): Promise<FileStat>
    read(buffer: Uint8Array, offset?: number, length?: number, position?: number): Promise<unknown>
    sync(): Promise<void>
    writeFile(contents: string, encoding?: string): Promise<void>
    close(): Promise<void>
  }

  interface FileStat {
    dev: number
    ino: number
    mtimeMs: number
    birthtimeMs: number
    size: number
    isFile(): boolean
    isDirectory(): boolean
  }

  interface DirectoryEntry {
    name: string
    isFile(): boolean
    isDirectory(): boolean
    isSymbolicLink?(): boolean
  }

  const fs: {
    open(path: string, flags: string, mode?: number): Promise<FileHandle>
    mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>
    stat(path: string): Promise<FileStat>
    lstat(path: string): Promise<FileStat>
    chmod(path: string, mode: number): Promise<void>
    access(path: string): Promise<void>
    readFile(path: string, encoding: "utf8"): Promise<string>
    readFile(path: string): Promise<Uint8Array>
    writeFile(path: string, contents: string | Uint8Array, encoding?: "utf8" | { flag?: string; mode?: number }): Promise<void>
    appendFile(path: string, contents: string | Uint8Array, options?: { encoding?: "utf8"; mode?: number }): Promise<void>
    readdir(path: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]>
    realpath(path: string): Promise<string>
    rename(source: string, target: string): Promise<void>
    unlink(path: string): Promise<void>
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
    cp(source: string, target: string, options?: { recursive?: boolean; errorOnExist?: boolean; force?: boolean }): Promise<void>
  }
  export default fs
}

declare module "node:crypto" {
  interface Hash {
    update(value: string | Uint8Array): Hash
    digest(encoding: "hex"): string
  }

  interface RandomBytes {
    toString(encoding: "hex" | "base64url"): string
  }

  export function randomBytes(size: number): Buffer
  export function createCipheriv(algorithm: string, key: Uint8Array, nonce: Uint8Array): { setAAD(value: Uint8Array): void; update(value: string, encoding: string): Buffer; final(): Buffer; getAuthTag(): Buffer }
  export function createDecipheriv(algorithm: string, key: Uint8Array, nonce: Uint8Array): { setAAD(value: Uint8Array): void; setAuthTag(value: Uint8Array): void; update(value: Uint8Array): Buffer; final(): Buffer }
  export function randomUUID(): string
  export function createHash(algorithm: string): Hash
}

declare module "node:fs" {
  interface FileStat {
    size: number
  }

  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void
  export function existsSync(path: string): boolean
  export function statSync(path: string): FileStat
  export function readdirSync(path: string): string[]
  export function readFileSync(path: string, encoding: "utf8"): string
  export function renameSync(source: string, target: string): void
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string
  export function pathToFileURL(path: string): URL
}

declare module "node:worker_threads" {
  interface MessagePort {
    postMessage(message: unknown): void
    on(event: "message", listener: (message: unknown) => void): this
    close(): void
  }

  interface WorkerOptions {
    type?: "module"
    execArgv?: string[]
    workerData?: unknown
  }

  export class Worker {
    constructor(filename: string | URL, options?: WorkerOptions)
    once(event: string, listener: (...args: unknown[]) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
    postMessage(message: unknown): void
    terminate(): Promise<number>
  }

  export const parentPort: MessagePort | null
  export const workerData: unknown
}

declare module "node:net" {
  export function isIP(value: string): number
  export function isIPv4(value: string): boolean
  export function isIPv6(value: string): boolean
}

declare module "node:dns/promises" {
  export function lookup(hostname: string, options: { all: true; verbatim?: boolean }): Promise<Array<{ address: string; family: number }>>
}

declare module "node:http" {
  interface IncomingMessage {
    headers: Record<string, string | string[] | undefined>
    statusCode?: number
    pause(): void
    once(event: "close", listener: () => void): this
    on(event: "data", listener: (chunk: Uint8Array) => void): this
    once(event: "aborted" | "end", listener: () => void): this
    once(event: "error", listener: (error: unknown) => void): this
    destroy(error?: unknown): void
    resume(): void
  }

  interface ClientRequest {
    write(body: string | Uint8Array): void
    destroy(error?: unknown): void
    setTimeout(ms: number, listener: () => void): this
    once(event: "error", listener: (error: unknown) => void): this
    end(): void
  }

  interface RequestOptions {
    ca?: string
    rejectUnauthorized?: boolean
    agent?: boolean
    method?: string
    headers?: Record<string, string>
    signal?: AbortSignal
    lookup?: (hostname: string, options: any, callback: (...args: unknown[]) => void) => void
    allowPrivateHosts?: boolean
    maxBytes?: number
  }

  export const STATUS_CODES: Record<number, string | undefined>
  export function request(url: URL, options: RequestOptions, listener: (response: IncomingMessage) => void): ClientRequest
}

declare module "node:https" {
  export { request } from "node:http"
}

declare const process: {
  pid: number
  kill(pid: number, signal: number): void
  execPath: string
  execArgv: string[]
  pid: number
  env: Record<string, string | undefined>
}
