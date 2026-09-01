import { defaultPersonaRuntimePrompt } from "../../config/defaults.js"

export function resolvePersonaRuntimePrompt(value: unknown): string {
  const prompt = String(value ?? "").trim()
  return prompt || defaultPersonaRuntimePrompt
}

export function composePersonaSystemPrompt(characterPrompt: unknown, runtimePrompt: unknown = defaultPersonaRuntimePrompt): string {
  const character = String(characterPrompt || "").trim()
  const runtime = resolvePersonaRuntimePrompt(runtimePrompt)
  return [
    character ? `【角色设定】\n${character}` : "",
    `【系统运行规则】\n${runtime}`,
  ].filter(Boolean).join("\n\n")
}
