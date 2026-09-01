import { validateFrameworkResources } from "./framework-resources.js"
import { isToolDeliveryMode, isToolExecutionEffect, isToolRepeatPolicy, isToolRetryPolicy, isToolRiskLevel } from "../tools/support/contract.js"

type UnknownRecord = Record<string, unknown>
type IssueLevel = "error" | "warn"

export interface ExtensionValidationIssue {
  level: IssueLevel
  path: string
  message: string
}

export interface ExtensionValidation {
  ok: boolean
  issues: ExtensionValidationIssue[]
  errors: ExtensionValidationIssue[]
  warnings: ExtensionValidationIssue[]
}

const policyBooleanFields = ["requiresMaster", "requiresGroup", "requiresGroupAdmin", "highRisk", "externalNetwork"] as const

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function add(issues: ExtensionValidationIssue[], level: IssueLevel, path: string, message: string): void {
  issues.push({ level, path, message })
}

function validateExecution(issues: ExtensionValidationIssue[], path: string, execution: unknown): void {
  if (execution === undefined) return
  if (!isRecord(execution)) {
    add(issues, "error", path, `${path} must be an object`)
    return
  }
  if (execution.effect !== undefined && !isToolExecutionEffect(execution.effect)) add(issues, "error", `${path}.effect`, `unknown execution effect: ${String(execution.effect)}`)
  if (execution.repeatPolicy !== undefined && !isToolRepeatPolicy(execution.repeatPolicy)) add(issues, "error", `${path}.repeatPolicy`, `unknown repeat policy: ${String(execution.repeatPolicy)}`)
  if (execution.retryPolicy !== undefined && !isToolRetryPolicy(execution.retryPolicy)) add(issues, "error", `${path}.retryPolicy`, `unknown retry policy: ${String(execution.retryPolicy)}`)
  for (const field of ["supportsCount", "polling"] as const) {
    if (execution[field] !== undefined && typeof execution[field] !== "boolean") add(issues, "error", `${path}.${field}`, `${field} must be boolean`)
  }
  for (const field of ["countField", "operationFamily"] as const) {
    if (execution[field] !== undefined && (typeof execution[field] !== "string" || !execution[field].trim())) add(issues, "error", `${path}.${field}`, `${field} must be a non-empty string`)
  }
  for (const field of ["maxCount", "maxAttempts", "maxPolls", "minPollIntervalMs"] as const) {
    if (execution[field] !== undefined && (!Number.isFinite(Number(execution[field])) || Number(execution[field]) < 0)) add(issues, "error", `${path}.${field}`, `${field} must be a non-negative number`)
  }
  for (const field of ["targetFields", "operationFields"] as const) {
    if (execution[field] !== undefined && (!Array.isArray(execution[field]) || execution[field].some(item => typeof item !== "string" || !item.trim()))) {
      add(issues, "error", `${path}.${field}`, `${field} must contain non-empty strings`)
    }
  }
  if (execution.promptCount !== undefined) {
    if (!isRecord(execution.promptCount)) add(issues, "error", `${path}.promptCount`, "promptCount must be an object")
    else {
      for (const field of ["keywords", "units"] as const) {
        if (execution.promptCount[field] !== undefined && (!Array.isArray(execution.promptCount[field]) || execution.promptCount[field].some(item => typeof item !== "string" || !item.trim()))) {
          add(issues, "error", `${path}.promptCount.${field}`, `${field} must contain non-empty strings`)
        }
      }
      if (execution.promptCount.maxClauses !== undefined && (!Number.isInteger(Number(execution.promptCount.maxClauses)) || Number(execution.promptCount.maxClauses) < 1 || Number(execution.promptCount.maxClauses) > 20)) {
        add(issues, "error", `${path}.promptCount.maxClauses`, "maxClauses must be an integer from 1 to 20")
      }
    }
  }
}

function validateExecutionByAction(issues: ExtensionValidationIssue[], path: string, value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    add(issues, "error", path, "executionByAction must be an object")
    return
  }
  for (const [action, execution] of Object.entries(value)) validateExecution(issues, `${path}.${action}`, execution)
}

function validateToolExecutionPolicy(issues: ExtensionValidationIssue[], path: string, tool: UnknownRecord): void {
  validateExecution(issues, `${path}.execution`, tool.execution)
  validateExecutionByAction(issues, `${path}.executionByAction`, tool.executionByAction)
}

function validatePolicy(issues: ExtensionValidationIssue[], path: string, policy: unknown): void {
  if (policy === undefined) return
  if (!isRecord(policy)) {
    add(issues, "error", path, `${path} must be an object`)
    return
  }
  for (const field of policyBooleanFields) {
    if (policy[field] !== undefined && typeof policy[field] !== "boolean") add(issues, "warn", `${path}.${field}`, `${field} should be boolean`)
  }
}

function validatePipeline(issues: ExtensionValidationIssue[], path: string, pipeline: unknown): void {
  if (pipeline === undefined) return
  if (!isRecord(pipeline)) {
    add(issues, "error", path, `${path} must be an object`)
    return
  }
  if (pipeline.callable !== true) add(issues, "warn", `${path}.callable`, "pipeline tools should set callable: true")
  if (!Array.isArray(pipeline.stages) || !pipeline.stages.length) {
    add(issues, "error", `${path}.stages`, "pipeline.stages must contain input and/or output")
  } else if (pipeline.stages.some(stage => !["input", "output"].includes(String(stage)))) {
    add(issues, "error", `${path}.stages`, "pipeline stages only support input and output")
  }
}

function validateToolHint(issues: ExtensionValidationIssue[], path: string, value: unknown): void {
  if (!isRecord(value)) {
    add(issues, "error", path, `${path} must be an object`)
    return
  }
  if (!value.name) add(issues, "error", `${path}.name`, "tool name is required")
  if (!value.description) add(issues, "warn", `${path}.description`, "tool description is recommended")
  if (value.risk && !isToolRiskLevel(value.risk)) add(issues, "error", `${path}.risk`, `unknown risk: ${String(value.risk)}`)
  if (value.delivery && !isToolDeliveryMode(value.delivery)) add(issues, "error", `${path}.delivery`, `unknown delivery mode: ${String(value.delivery)}`)
  if (value.requiresFinalReply !== undefined && typeof value.requiresFinalReply !== "boolean") add(issues, "error", `${path}.requiresFinalReply`, "requiresFinalReply must be boolean")
  validateToolExecutionPolicy(issues, path, value)
  if (value.tags !== undefined && !Array.isArray(value.tags)) add(issues, "warn", `${path}.tags`, "tags should be an array")
  validatePolicy(issues, `${path}.policy`, value.policy)
  validatePipeline(issues, `${path}.pipeline`, value.pipeline)
}

/** 校验扩展声明；所有外部 JSON 都先按 unknown 处理，避免把动态扩展内容误当作可信类型。 */
export function validateExtensionManifest(manifest: unknown = {}, options: { type?: string } = {}): ExtensionValidation {
  const type = options.type || "extension"
  const issues: ExtensionValidationIssue[] = []
  if (!isRecord(manifest)) {
    const issue = { level: "error" as const, path: "manifest", message: `${type} manifest must be an object` }
    return { ok: false, issues: [issue], errors: [issue], warnings: [] }
  }
  const source = record(manifest)
  if (!source.id) add(issues, "warn", "id", "id is recommended and should match the directory name")
  if (!source.name) add(issues, "warn", "name", "name is recommended")
  if (!source.description) add(issues, "warn", "description", "description is recommended")
  if (source.risk && !isToolRiskLevel(source.risk)) add(issues, "error", "risk", `unknown risk: ${String(source.risk)}`)
  if (source.delivery && !isToolDeliveryMode(source.delivery)) add(issues, "error", "delivery", `unknown delivery mode: ${String(source.delivery)}`)
  if (source.requiresFinalReply !== undefined && typeof source.requiresFinalReply !== "boolean") add(issues, "error", "requiresFinalReply", "requiresFinalReply must be boolean")
  validateToolExecutionPolicy(issues, "manifest", source)
  if (source.tags !== undefined && !Array.isArray(source.tags)) add(issues, "warn", "tags", "tags should be an array")
  validatePolicy(issues, "policy", source.policy)
  validatePipeline(issues, "pipeline", source.pipeline)
  issues.push(...validateFrameworkResources(source.frameworkResources))
  if (source.tools !== undefined) {
    if (!Array.isArray(source.tools)) add(issues, "error", "tools", "tools must be an array")
    else {
      const names = new Set<string>()
      source.tools.forEach((tool, index) => {
        validateToolHint(issues, `tools.${index}`, tool)
        const name = isRecord(tool) ? String(tool.name || "").trim() : ""
        if (!name) return
        if (names.has(name)) add(issues, "error", `tools.${index}.name`, `duplicate tool name: ${name}`)
        names.add(name)
      })
    }
  }
  return {
    ok: !issues.some(issue => issue.level === "error"),
    issues,
    errors: issues.filter(issue => issue.level === "error"),
    warnings: issues.filter(issue => issue.level === "warn"),
  }
}
