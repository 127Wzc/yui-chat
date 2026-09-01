import path from "node:path"
import { dataDir } from "../config/store.js"
import { AtomicJsonRepository } from "../core/storage/atomic-json-repository.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import { safeText } from "./command-document-builder.js"

type UnknownRecord = Record<string, unknown>

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

const staticIndexFile = path.join(dataDir, "command-kb", "static.json")
const manualIndexFile = path.join(dataDir, "command-kb", "manual.json")
const observedIndexFile = path.join(dataDir, "command-kb", "observed.json")

function arrayValue(value: UnknownRecord[]): UnknownRecord[] {
  if (!Array.isArray(value)) throw new Error("指令知识库文件必须是 JSON 数组")
  return value
}

function repository(file: string, label: string): AtomicJsonRepository<UnknownRecord[]> {
  return new AtomicJsonRepository<UnknownRecord[]>({
    file,
    defaultValue: [],
    normalize: arrayValue,
    serialize: value => `${JSON.stringify(value)}\n`,
    onReadError(error) {
      hostRuntime.logger?.warn?.(`[yui-chat] ${label}读取失败，损坏文件已隔离并使用空索引`, error)
    },
  })
}

const staticRepository = repository(staticIndexFile, "静态指令索引")
const manualRepository = repository(manualIndexFile, "手工指令索引")
const observedRepository = repository(observedIndexFile, "动态指令索引")

export function compactCommandDoc(command: UnknownRecord = {}): UnknownRecord {
  const sourceDocs = [...new Set(records(command.helpDocs).map(item => safeText(item.source)).filter(Boolean))]
  const compact = { ...command }
  delete compact.helpDocs
  delete compact.searchText
  delete compact.keywords
  if (sourceDocs.length) compact.sourceDocs = sourceDocs
  return compact
}

export function commandKind(command: UnknownRecord = {}): "manual" | "observed" | "static" {
  if (command.manual || command.pluginKey === "manual") return "manual"
  if (command.dynamic || command.pluginKey === "observed") return "observed"
  return "static"
}

function rows(commands: readonly UnknownRecord[], kind: "manual" | "observed" | "static"): UnknownRecord[] {
  return commands.filter(command => commandKind(command) === kind).map(compactCommandDoc)
}

export interface CommandIndexStorage {
  files: { static: string; manual: string; observed: string }
  load(): Promise<UnknownRecord[]>
  saveAll(commands?: readonly UnknownRecord[]): Promise<void>
  saveStatic(commands?: readonly UnknownRecord[]): Promise<UnknownRecord[]>
  saveManual(commands?: readonly UnknownRecord[]): Promise<UnknownRecord[]>
  saveObserved(commands?: readonly UnknownRecord[]): Promise<UnknownRecord[]>
}

export const commandIndexStorage: CommandIndexStorage = {
  files: {
    static: staticIndexFile,
    manual: manualIndexFile,
    observed: observedIndexFile,
  },

  async load(): Promise<UnknownRecord[]> {
    const split = await Promise.all([
      staticRepository.load(),
      manualRepository.load(),
      observedRepository.load(),
    ])
    return split.flat().map(compactCommandDoc)
  },

  async saveAll(commands: readonly UnknownRecord[] = []): Promise<void> {
    await Promise.all([
      staticRepository.replace(rows(commands, "static")),
      manualRepository.replace(rows(commands, "manual")),
      observedRepository.replace(rows(commands, "observed")),
    ])
  },

  saveStatic(commands: readonly UnknownRecord[] = []): Promise<UnknownRecord[]> {
    return staticRepository.replace(rows(commands, "static"))
  },

  saveManual(commands: readonly UnknownRecord[] = []): Promise<UnknownRecord[]> {
    return manualRepository.replace(rows(commands, "manual"))
  },

  saveObserved(commands: readonly UnknownRecord[] = []): Promise<UnknownRecord[]> {
    return observedRepository.replace(rows(commands, "observed"))
  },
}
