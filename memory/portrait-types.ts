import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

const definitions = [
  { id: "general", command: "画像", name: "综合画像", description: "结合记录分析优势、缺点与相处建议。" },
  { id: "positive", command: "正画像", name: "正画像", description: "聚焦有依据的优点、相处价值与闪光点。" },
  { id: "negative", command: "负画像", name: "负画像", description: "以犀利表达分析问题模式、摩擦与影响。" },
  { id: "matchmaking", command: "找对象", name: "找对象", description: "分析伴侣匹配类型、沟通雷区和行动建议。" },
  { id: "clone", command: "克隆人格", name: "克隆人格", description: "生成可复制的人格模拟提示词，保留表达、反应与边界。" },
] as const
export type PortraitTypeId = typeof definitions[number]["id"]
export interface PortraitType { id: PortraitTypeId; command: string; name: string; description: string; prompt: string }

// 上游 MIT 许可的原始提示词随资源构建；仅使用画像时读取，配置校验不加载正文。
let prompts: Map<string, string> | undefined
function loadPrompt(command: string): string {
  if (!prompts) {
    const source: unknown = parse(readFileSync(fileURLToPath(new URL("../resources/portrait/builtin_prompts.yaml", import.meta.url)), "utf8"))
    if (!Array.isArray(source)) throw new Error("画像内置提示词资源格式无效")
    const loaded = new Map<string, string>()
    for (const definition of definitions) {
      const item = source.find(value => value && typeof value === "object" && value.command === definition.command)
      if (!item || typeof item.content !== "string" || !item.content.trim()) throw new Error(`画像内置提示词缺失：${definition.command}`)
      loaded.set(definition.command, item.content.trim())
    }
    prompts = loaded
  }
  return prompts.get(command)!
}
export const PORTRAIT_TYPES: readonly Readonly<PortraitType>[] = Object.freeze(definitions.map(definition =>
  Object.freeze({ ...definition, get prompt() { return loadPrompt(definition.command) } }),
))
export function findPortraitType(value: unknown): Readonly<PortraitType> | undefined {
  return PORTRAIT_TYPES.find(type => type.id === value || type.command === value || type.name === value)
}
