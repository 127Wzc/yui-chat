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
    fnc: item.fnc,
    regexp: item.regexp,
    example: item.example,
    suggestedCommand: item.suggestedCommand,
    examples: item.examples || [],
    commandHeads: item.commandHeads || usageGuide.heads || [],
    intentHints: item.intentHints || usageGuide.intents || [],
    parameterHints: item.parameterHints || usageGuide.parameters || [],
    usageGuide: item.usageGuide,
    permission: item.permission,
    event: item.event,
    priority: item.priority,
    sourceRuleKey: item.sourceRuleKey || "",
    origin: item.origin || null,
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
