type UnknownRecord = Record<string, unknown>

export type ImageRenderEngine = "html" | "svg"
export type RenderStrategyScope = "ai" | "system"

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

export function normalizeConfiguredEngine(value: unknown, fallback: ImageRenderEngine = "html"): ImageRenderEngine {
  const engine = text(value).trim().toLowerCase()
  if (engine === "svg" || engine === "sharp-svg") return "svg"
  if (engine === "html") return "html"
  return fallback
}

/** Resolve the effective renderer for every image entry point. */
function scopedRenderConfig(config: unknown, scope: RenderStrategyScope = "ai"): UnknownRecord {
  const root = record(config)
  const response = record(root.response)
  const render = record(response.render)
  if (scope !== "system") return render
  const system = record(render.system)
  return { ...render, ...system }
}

export function resolveRenderEngine(_kind: unknown, requested: unknown, config: unknown = {}, scope: RenderStrategyScope = "ai"): ImageRenderEngine {
  const render = scopedRenderConfig(config, scope)
  const global = normalizeConfiguredEngine(render.engine, "html")
  const selected = text(requested || global).trim().toLowerCase()
  if (selected === "svg" || selected === "sharp-svg") return "svg"
  return selected === "html" || global === "html" ? "html" : "svg"
}

/** 为单次渲染覆盖全局优先级，不修改冻结配置快照。 */
export function withRenderEngine(config: unknown, engine: ImageRenderEngine, options: UnknownRecord = {}): UnknownRecord {
  const root = record(config)
  const response = record(root.response)
  const render = record(response.render)
  return {
    ...root,
    response: {
      ...response,
      render: { ...render, engine, ...options },
    },
  }
}

/** 将系统渲染策略投影到既有渲染服务配置，复用同一套模板和后端。 */
export function withRenderScope(config: unknown, scope: RenderStrategyScope = "ai"): UnknownRecord {
  if (scope !== "system") return record(config)
  const root = record(config)
  const response = record(root.response)
  const render = record(response.render)
  const system = record(render.system)
  return {
    ...root,
    response: {
      ...response,
      render: {
        ...render,
        engine: system.engine ?? "html",
      },
    },
  }
}
