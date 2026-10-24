import { commandPriorityMetadata, commandRuntimeMetadata, commandOriginalMetadata, buildCommandRetrievalText } from "../../knowledge/command-document-builder.js"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

export function commandKnowledgeView(item: UnknownRecord = {}): UnknownRecord {
  const usageGuide = record(item.usageGuide)
  return {
    id: item.id,
    pluginKey: item.pluginKey,
    pluginName: item.pluginName,
    description: item.description,
    summary: item.summary,
    body: item.body || "",
    retrievalText: buildCommandRetrievalText(item),
    notes: item.notes || "",
    fnc: item.fnc,
    regexp: item.regexp,
    regexpFlags: item.regexpFlags || "",
    example: item.example,
    suggestedCommand: item.suggestedCommand,
    examples: item.examples || [],
    commandHeads: item.commandHeads || usageGuide.heads || [],
    intentHints: item.intentHints || usageGuide.intents || [],
    parameterHints: item.parameterHints || usageGuide.parameters || [],
    usageGuide: item.usageGuide,
    permission: item.permission,
    event: item.event,
    ...commandPriorityMetadata(item),
    sourceRuleKey: item.sourceRuleKey || "",
    origin: item.origin || null,
    runtimeMetadata: commandRuntimeMetadata(item),
    originalMetadata: commandOriginalMetadata(item),
    sourceStatus: item.sourceStatus || "current",
    needsReview: Boolean(item.needsReview),
    dynamic: Boolean(item.dynamic || item.pluginKey === "observed"),
    manual: Boolean(item.manual || item.pluginKey === "manual"),
    overridesCommandId: item.overridesCommandId || "",
    overridesSourceRuleKey: item.overridesSourceRuleKey || "",
    observed: item.observed,
    keywords: item.keywords || [],
    matchedTokens: item.matchedTokens || [],
    reason: item.reason || "",
    recommendation: item.recommendation,
    usageCount: item.usageCount || 0,
    score: item.score || 0,
    sectionKey: item.sectionKey || "",
    sectionLabel: item.sectionLabel || "",
    sectionRank: Number(item.sectionRank || 0),
    updatedAt: item.updatedAt,
  }
}
