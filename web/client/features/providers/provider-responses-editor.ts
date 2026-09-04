import { splitTokens, parseJsonText, toJson } from "../../shared/format.js"
import type { UnknownRecord } from "../../shared/data.js"

export interface ResponsesModelConfig {
  stateMode?: "auto" | "local" | "previous_response_id"
  store?: boolean
  parallelToolCalls?: boolean
  webSearch?: { params?: UnknownRecord }
  fileSearch?: { enabled?: boolean; vectorStoreIds?: string[]; maxNumResults?: number; params?: UnknownRecord }
}

export function responsesModelDraft(responses: ResponsesModelConfig = {}) {
  return {
    responsesStateMode: ["auto", "local", "previous_response_id"].includes(String(responses.stateMode)) ? responses.stateMode as "auto" | "local" | "previous_response_id" : "auto",
    responsesStore: String(responses.store === true),
    responsesParallelToolCalls: String(responses.parallelToolCalls !== false),
    responsesWebSearchParams: toJson(responses.webSearch?.params || {}),
    responsesFileSearch: String(responses.fileSearch?.enabled === true),
    responsesVectorStoreIds: (responses.fileSearch?.vectorStoreIds || []).join(", "),
    responsesFileSearchMaxResults: responses.fileSearch?.maxNumResults ?? 8,
    responsesFileSearchParams: toJson(responses.fileSearch?.params || {}),
  }
}

type ResponsesModelPatchDraft = ReturnType<typeof responsesModelDraft>

export function responsesModelPatch(draft: ResponsesModelPatchDraft, modelName: string) {
  return {
    stateMode: ["local", "previous_response_id"].includes(draft.responsesStateMode) ? draft.responsesStateMode : "auto",
    store: draft.responsesStore === "true",
    parallelToolCalls: draft.responsesParallelToolCalls !== "false",
    webSearch: {
      params: parseJsonText(draft.responsesWebSearchParams, `${modelName} Responses web_search params`, {}),
    },
    fileSearch: {
      enabled: draft.responsesFileSearch === "true",
      vectorStoreIds: splitTokens(draft.responsesVectorStoreIds),
      maxNumResults: Number(draft.responsesFileSearchMaxResults || 8),
      params: parseJsonText(draft.responsesFileSearchParams, `${modelName} Responses file_search params`, {}),
    },
  }
}

export const RESPONSES_STATE_MODE_OPTIONS = [
  { value: "auto", label: "自动（推荐）" },
  { value: "local", label: "本地历史回放（兼容）" },
  { value: "previous_response_id", label: "仅上游 Response ID 链" },
]

export const RESPONSES_MODEL_EDITOR_TEMPLATE = `
  <Collapse v-if="draft.chatProtocol === 'responses'" title="Responses API" hint="协议状态与高级参数" nested>
    <div class="form-grid dense">
      <Field label="上下文维护方式" type="select" :options="RESPONSES_STATE_MODE_OPTIONS" v-model="draft.responsesStateMode" tip="自动模式优先使用 previous_response_id；上游断链时只重放有界本地上下文和完整工具调用对，再建立新链。" />
      <Field v-if="draft.responsesStateMode === 'local'" label="保存上游响应" type="select" :options="BOOL_OFF_OPTIONS" v-model="draft.responsesStore" tip="本地回放默认关闭上游存储，并回传完整历史和必要的加密 reasoning item。" />
      <div v-else-if="draft.responsesStateMode === 'auto'" class="hint-banner ok"><Icon name="link" :size="14" /><span>正常请求只发送增量输入；上游 ID 或工具关联失效时自动切换为无状态重放，成功后保存新的 Response ID。</span></div>
      <div v-else class="hint-banner"><Icon name="link" :size="14" /><span>严格使用上游 Response ID 链；普通断链直接交给渠道 fallback。若代理仅丢失当前轮 Function Call 关联，会有界重放已匹配的调用与结果一次，以完成必须的最终回复，且不会重新执行工具。</span></div>
      <Field label="并行函数调用" type="select" :options="BOOL_OPTIONS" v-model="draft.responsesParallelToolCalls" tip="只读工具可由现有执行器并行；副作用工具仍按本地策略串行。" />
    </div>
    <Collapse title="Built-in Tool 参数" hint="仅在需要限制域名、排序等高级能力时填写" nested>
      <Field label="web_search Params JSON" type="textarea" :rows="3" v-model="draft.responsesWebSearchParams" tip="会合并到原生 web_search 定义，type 由系统固定。" />
      <Field label="file_search Params JSON" type="textarea" :rows="3" v-model="draft.responsesFileSearchParams" tip="会合并到原生 file_search 定义，Vector Store IDs 和 type 由系统固定。" />
    </Collapse>
  </Collapse>
`
