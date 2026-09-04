import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { runStateMigrations, runVectorMigrations } from "../output/runtime/core/storage/sqlite/migration-runner.js"

const STATE_TABLES = [
  "storage_meta", "runtime_config", "conversations",
  "memory_items", "memory_evidence", "memory_fts",
  "knowledge_bases", "knowledge_documents", "knowledge_chunks", "knowledge_fts", "knowledge_index_jobs",
  "capability_rules", "knowledge_grants",
  "ai_runs", "model_call_events", "model_call_snapshots", "tool_call_events", "ai_usage_daily", "embedding_budget_daily",
  "group_memory_policies", "group_memory_messages", "group_memory_extraction_jobs",
]

const VECTOR_TABLES = ["embedding_spaces", "embedding_records"]
// 旧迁移（git show HEAD:core/storage/sqlite/migrations/*.sql）里真实存在、
// 已被 baseline 移除的表；清单必须与旧表名逐一对应，防止无效断言。
const REMOVED_STATE_TABLES = [
  "messages", "conversation_turns",
  "knowledge_sources", "knowledge_index_generations", "index_jobs",
  "principals", "persona_profiles", "persona_versions", "persona_bindings",
  "retrieval_eval_sets", "retrieval_eval_cases", "retrieval_eval_runs",
  "ai_usage_events", "audit_events",
  "memory_feedback", "memory_capture_policies", "memory_source_messages", "memory_consolidation_windows",
]

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name)
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-sqlite-baseline-"))
let state
let vectors
let legacy

try {
  state = new Database(path.join(root, "state.sqlite3"))
  state.pragma("foreign_keys = ON")
  const stateMigrations = runStateMigrations(state)
  assert.deepEqual(stateMigrations.map(row => row.id), ["001-baseline.sql", "002-tool-call-events.sql", "003-model-call-snapshots.sql", "004-conversation-state.sql"], "state database must apply the baseline, combined tool/runtime, model snapshot, and conversation state migrations")
  for (const table of STATE_TABLES) assert(tableNames(state).includes(table), `missing state table: ${table}`)
  for (const table of REMOVED_STATE_TABLES) assert(!tableNames(state).includes(table), `removed state table must not return: ${table}`)
  assert.equal(state.pragma("quick_check", { simple: true }), "ok", "baseline state database must pass quick_check")

  assert.deepEqual(columnNames(state, "conversations"), ["conversation_key", "history_json", "last_seen_at", "expires_at", "state_json"])
  assert(!columnNames(state, "knowledge_documents").includes("source_id"), "knowledge documents should use source_type/source_key instead of a source table")
  assert(!columnNames(state, "knowledge_index_jobs").includes("generation_id"), "index jobs should no longer persist generations")
  assert(!columnNames(state, "knowledge_grants").includes("default_active"), "knowledge grants should not persist a default flag")
  assert(columnNames(state, "model_call_events").includes("parent_tool_id"), "model call details must persist tool-call lineage")
  assert(!columnNames(state, "model_call_events").includes("source"), "model call source is owned by its run")
  assert.deepEqual(columnNames(state, "model_call_snapshots"), [
    "model_call_id", "run_id", "sequence", "operation", "messages_json", "tools_json", "request_json",
    "message_count", "tool_count", "context_chars", "tool_chars", "truncated", "redaction_version", "captured_at", "updated_at",
  ])
  assert.deepEqual(columnNames(state, "tool_call_events"), [
    "id", "run_id", "model_call_id", "round", "call_index", "tool_call_id", "tool_name", "source", "category", "status",
    "started_at", "ended_at", "duration_ms", "result_chars", "delivery", "requires_final_reply", "arguments_json", "result_text", "error_message", "metadata_json", "parent_tool_id",
  ])
  assert.deepEqual(columnNames(state, "embedding_budget_daily"), ["day", "model_name", "purpose", "estimated_tokens", "calls"])
  assert(!columnNames(state, "group_memory_messages").includes("scope_type"), "group capture is keyed directly by group_id")
  assert(columnNames(state, "group_memory_policies").includes("retrieval_result_limit"), "group memory policies must expose a retrieval result limit override")

  const timestamp = Date.now()
  state.prepare("INSERT INTO ai_runs(id, source, purpose, conversation_key, scope_type, user_id, group_id, prompt_text, response_text, status, started_at, ended_at, duration_ms, input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens, estimated_tokens, model_calls, tool_calls, failed_tools, estimated_cost, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "baseline-run", "chat", "reply", "test", "private", "u1", "", "", "", "ok", timestamp, timestamp + 5, 5, 2, 3, 5, 0, 0, 0, 1, 0, 0, 0, "{}",
  )
  state.prepare("INSERT INTO model_call_events(id, run_id, sequence, purpose, model_name, model_identifier, provider_name, adapter, status, started_at, ended_at, duration_ms, input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens, estimated_input_tokens, estimated_output_tokens, usage_source, price_in, price_out, estimated_cost, error_message, input_text, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "baseline-call", "baseline-run", 0, "reply", "mock-chat", "mock-chat", "mock", "mock", "ok", timestamp, timestamp + 5, 5, 2, 3, 5, 0, 0, 0, 0, "reported", 0, 0, 0, "", "", "{}",
  )
  state.prepare("INSERT INTO model_call_snapshots(model_call_id, run_id, sequence, operation, messages_json, tools_json, request_json, message_count, tool_count, context_chars, tool_chars, truncated, redaction_version, captured_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "baseline-call", "baseline-run", 0, "chat", '[{"role":"user","content":"基线"}]', "[]", "{}", 1, 0, 25, 2, 0, "v1", timestamp, timestamp,
  )
  assert.equal(state.prepare("SELECT message_count FROM model_call_snapshots WHERE model_call_id=?").get("baseline-call")?.message_count, 1, "model request snapshots must link to their model call")
  state.prepare("INSERT INTO tool_call_events(id, run_id, model_call_id, round, call_index, tool_call_id, tool_name, source, category, status, started_at, ended_at, duration_ms, result_chars, delivery, requires_final_reply, arguments_json, result_text, error_message, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "baseline-tool", "baseline-run", "baseline-call", 1, 1, "tool-call-1", "baseline_tool", "builtin", "network", "ok", timestamp, timestamp + 2, 2, 7, "silent", 1, '{"query":"基线"}', "baseline result", "", "{}",
  )
  assert.equal(state.prepare("SELECT tool_name FROM tool_call_events WHERE run_id=?").get("baseline-run")?.tool_name, "baseline_tool", "tool event must link to its model run")
  const daily = state.prepare("SELECT calls, input_tokens, output_tokens, total_tokens, failures FROM ai_usage_daily WHERE day=? AND model_name=? AND purpose=?").get(new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10), "mock-chat", "reply")
  assert.deepEqual(daily, { calls: 1, input_tokens: 2, output_tokens: 3, total_tokens: 5, failures: 0 }, "terminal model calls must update the daily rollup")

  vectors = new Database(path.join(root, "vectors.sqlite3"))
  vectors.pragma("foreign_keys = ON")
  const vectorMigrations = runVectorMigrations(vectors)
  assert.deepEqual(vectorMigrations.map(row => row.id), ["001-baseline.sql"], "vector database must contain only the baseline migration")
  for (const table of VECTOR_TABLES) assert(tableNames(vectors).includes(table), `missing vector table: ${table}`)
  assert(!columnNames(vectors, "embedding_records").includes("vector"), "embedding vectors belong in their per-space vec table, not the metadata table")
  assert.equal(vectors.pragma("quick_check", { simple: true }), "ok", "baseline vector database must pass quick_check")

  legacy = new Database(path.join(root, "legacy.sqlite3"))
  legacy.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY)")
  assert.throws(() => runStateMigrations(legacy), /只支持全新数据库/, "legacy state databases must be rejected instead of partially migrated")

  console.log("ok sqlite-baseline")
} finally {
  state?.close()
  vectors?.close()
  legacy?.close()
  await fs.rm(root, { recursive: true, force: true })
}
