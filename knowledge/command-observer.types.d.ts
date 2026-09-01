import type {
  CommandDocument,
  CommandHelpDoc,
  CommandParameterHint,
  UnknownRecord,
} from "./command-document-builder.js"

export interface ObservedCommand extends UnknownRecord {
  head?: string
  firstSeenAt?: string
  lastSeenAt?: string
  count?: number
  handledBy?: string
  samples?: string[]
  signatures?: string[]
}

export interface CommandRecord extends UnknownRecord {
  id?: string
  pluginKey?: string
  pluginName?: string
  description?: string
  summary?: string
  fnc?: string
  regexp?: string
  suggestedCommand?: string
  example?: string
  examples?: string[]
  usageGuide?: {
    heads?: string[]
    intents?: string[]
    parameters?: CommandParameterHint[]
    confidence?: string
    [key: string]: unknown
  }
  commandHeads?: string[]
  intentHints?: string[]
  parameterHints?: CommandParameterHint[]
  keywords?: string[]
  searchText?: string
  helpDocs?: CommandHelpDoc[]
  sourceRuleKey?: string
  sourceCommandId?: string
  overridesCommandId?: string
  overridesSourceRuleKey?: string
  manual?: boolean
  dynamic?: boolean
  observed?: ObservedCommand
  permission?: string
  event?: string
  priority?: number
  updatedAt?: string
}

export interface CommandEvent extends UnknownRecord {
  text?: string
  commandHead?: string
  signature?: string
  commandPrefix?: string
  commandPrefixes?: string[]
  handledBy?: string
  exactMatches?: string[]
  matches?: string[]
  isGroup?: boolean
  groupId?: string
  userId?: string
  time?: string
  observedCommandId?: string
  matchType?: "exact" | "observed" | "fuzzy" | "unmatched"
}

export interface ManualCommandInput extends UnknownRecord {}

export interface ObserverOptions {
  scanOnReady?: boolean
}

export interface CommandObserverStats extends UnknownRecord {
  commands: number
  excludedCommands: number
  events: number
  initialized: boolean
  patched: boolean
  afterHandlers: number
  plugins: number
  observedCommands: number
  manualCommands: number
  exampleCoverageRatio: number
}

export interface CommandRecommendationResponse extends UnknownRecord {
  results: UnknownRecord[]
}

export interface PluginRule extends UnknownRecord {
  reg?: unknown
  fnc?: unknown
  permission?: unknown
  event?: unknown
}

export interface PluginRecord extends UnknownRecord {
  name?: unknown
  dsc?: unknown
  event?: unknown
  rule?: PluginRule[]
}

export interface PluginEntry extends UnknownRecord {
  key?: unknown
  plugin?: PluginRecord
  priority?: unknown
}

export interface PluginsLoaderApi {
  priority?: PluginEntry[]
  deal?: (event: UnknownRecord) => Promise<unknown> | unknown
  __yuiChatObserved?: boolean
}
