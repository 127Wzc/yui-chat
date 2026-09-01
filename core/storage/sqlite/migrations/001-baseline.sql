-- Yui Chat 从 0 开始的状态库基线。旧版 state.sqlite3 不就地升级。

CREATE TABLE storage_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE runtime_config (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  overrides_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(overrides_json)),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE conversations (
  conversation_key TEXT PRIMARY KEY,
  history_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(history_json)),
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX conversations_expiry_idx ON conversations(expires_at);

CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('user', 'user_group', 'group')),
  owner_id TEXT NOT NULL,
  group_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  fact_key TEXT NOT NULL DEFAULT '',
  fact_value TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json)),
  importance REAL NOT NULL DEFAULT 0.62 CHECK(importance >= 0 AND importance <= 1),
  confidence REAL NOT NULL DEFAULT 0.78 CHECK(confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'warm', 'cold', 'archived', 'deleted')),
  source TEXT NOT NULL DEFAULT 'explicit-user',
  last_confirmed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX memory_items_scope_idx ON memory_items(scope_type, owner_id, group_id, status, updated_at DESC);
CREATE INDEX memory_items_key_idx ON memory_items(scope_type, owner_id, group_id, normalized_key);
CREATE INDEX memory_items_fact_identity_idx ON memory_items(scope_type, owner_id, group_id, fact_key, fact_value, status);
CREATE INDEX memory_items_expiry_idx ON memory_items(expires_at, status);

CREATE TABLE memory_evidence (
  memory_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  message_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(memory_id, source_event_id),
  FOREIGN KEY(memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX memory_evidence_source_event_idx ON memory_evidence(source_event_id);
CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, text, tokenize='unicode61');

CREATE TABLE knowledge_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  embedding_model_name TEXT NOT NULL DEFAULT '',
  embedding_dimensions INTEGER NOT NULL DEFAULT 0 CHECK(embedding_dimensions >= 0),
  distance_metric TEXT NOT NULL DEFAULT 'cosine' CHECK(distance_metric IN ('cosine', 'l2', 'l1')),
  chunk_strategy_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(chunk_strategy_json)),
  retrieval_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(retrieval_json)),
  active_vector_space_id TEXT,
  protected INTEGER NOT NULL DEFAULT 0 CHECK(protected IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  UNIQUE(knowledge_base_id, source_key),
  UNIQUE(id, knowledge_base_id)
) STRICT;
CREATE INDEX knowledge_documents_base_idx ON knowledge_documents(knowledge_base_id, updated_at DESC);

CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  FOREIGN KEY(document_id, knowledge_base_id) REFERENCES knowledge_documents(id, knowledge_base_id) ON DELETE CASCADE,
  UNIQUE(document_id, ordinal)
) STRICT;
CREATE INDEX knowledge_chunks_base_idx ON knowledge_chunks(knowledge_base_id, document_id, ordinal);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(chunk_id UNINDEXED, knowledge_base_id UNINDEXED, title, content, tokenize='unicode61');
CREATE TRIGGER knowledge_chunks_delete_fts BEFORE DELETE ON knowledge_chunks BEGIN
  DELETE FROM knowledge_fts WHERE chunk_id = OLD.id;
END;

CREATE TABLE knowledge_index_jobs (
  id TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL,
  vector_space_id TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  dimensions INTEGER NOT NULL DEFAULT 0 CHECK(dimensions >= 0),
  distance_metric TEXT NOT NULL DEFAULT 'cosine' CHECK(distance_metric IN ('cosine', 'l2', 'l1')),
  chunk_strategy_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(chunk_strategy_json)),
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(progress_json)),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'canceling', 'retrying', 'completed', 'failed', 'paused_budget', 'paused_no_model', 'canceled', 'superseded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts > 0),
  lease_until INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX knowledge_index_jobs_status_idx ON knowledge_index_jobs(status, lease_until, created_at);
CREATE INDEX knowledge_index_jobs_base_status_idx ON knowledge_index_jobs(knowledge_base_id, status, updated_at DESC);

CREATE TABLE capability_rules (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  group_id TEXT NOT NULL DEFAULT '',
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('allow', 'deny')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(subject_type, subject_id, group_id, resource_type, resource_id)
) STRICT;

CREATE TABLE knowledge_grants (
  id TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('role', 'user', 'group', 'user_group')),
  subject_id TEXT NOT NULL,
  group_id TEXT NOT NULL DEFAULT '',
  effect TEXT NOT NULL CHECK(effect IN ('allow', 'deny')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  UNIQUE(knowledge_base_id, subject_type, subject_id, group_id)
) STRICT;
CREATE INDEX knowledge_grants_subject_idx ON knowledge_grants(subject_type, subject_id, group_id, effect);

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  conversation_key TEXT NOT NULL DEFAULT '',
  scope_type TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL DEFAULT '',
  prompt_text TEXT NOT NULL DEFAULT '',
  response_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  failed_tools INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json))
) STRICT;
CREATE INDEX ai_runs_started_idx ON ai_runs(started_at DESC, id DESC);
CREATE INDEX ai_runs_scope_idx ON ai_runs(scope_type, user_id, group_id, started_at DESC);
CREATE INDEX ai_runs_status_idx ON ai_runs(status, started_at DESC);

CREATE TABLE model_call_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  purpose TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  model_identifier TEXT NOT NULL DEFAULT '',
  provider_name TEXT NOT NULL DEFAULT '',
  adapter TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_output_tokens INTEGER NOT NULL DEFAULT 0,
  usage_source TEXT NOT NULL DEFAULT 'unknown',
  price_in REAL NOT NULL DEFAULT 0,
  price_out REAL NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  input_text TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  FOREIGN KEY(run_id) REFERENCES ai_runs(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX model_call_run_idx ON model_call_events(run_id, sequence ASC);
CREATE INDEX model_call_model_idx ON model_call_events(model_name, started_at DESC);
CREATE INDEX model_call_started_idx ON model_call_events(started_at DESC);

CREATE TABLE ai_usage_daily (
  day TEXT NOT NULL,
  model_name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(day, model_name, purpose)
) STRICT;

CREATE TRIGGER model_call_events_rollup_on_insert
AFTER INSERT ON model_call_events WHEN NEW.ended_at > 0
BEGIN
  INSERT INTO ai_usage_daily(day, model_name, purpose, input_tokens, output_tokens, total_tokens, estimated_tokens, cached_tokens, reasoning_tokens, calls, failures, duration_ms, estimated_cost)
  VALUES(strftime('%Y-%m-%d', NEW.started_at / 1000, 'unixepoch', '+8 hours'), NEW.model_name, NEW.purpose, NEW.input_tokens, NEW.output_tokens, NEW.total_tokens, NEW.estimated_input_tokens + NEW.estimated_output_tokens, NEW.cached_tokens, NEW.reasoning_tokens, 1, CASE WHEN NEW.status = 'ok' THEN 0 ELSE 1 END, NEW.duration_ms, NEW.estimated_cost)
  ON CONFLICT(day, model_name, purpose) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    total_tokens = total_tokens + excluded.total_tokens,
    estimated_tokens = estimated_tokens + excluded.estimated_tokens,
    cached_tokens = cached_tokens + excluded.cached_tokens,
    reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
    calls = calls + excluded.calls,
    failures = failures + excluded.failures,
    duration_ms = duration_ms + excluded.duration_ms,
    estimated_cost = estimated_cost + excluded.estimated_cost;
END;

CREATE TRIGGER model_call_events_rollup_on_terminal_update
AFTER UPDATE OF ended_at ON model_call_events WHEN OLD.ended_at = 0 AND NEW.ended_at > 0
BEGIN
  INSERT INTO ai_usage_daily(day, model_name, purpose, input_tokens, output_tokens, total_tokens, estimated_tokens, cached_tokens, reasoning_tokens, calls, failures, duration_ms, estimated_cost)
  VALUES(strftime('%Y-%m-%d', NEW.started_at / 1000, 'unixepoch', '+8 hours'), NEW.model_name, NEW.purpose, NEW.input_tokens, NEW.output_tokens, NEW.total_tokens, NEW.estimated_input_tokens + NEW.estimated_output_tokens, NEW.cached_tokens, NEW.reasoning_tokens, 1, CASE WHEN NEW.status = 'ok' THEN 0 ELSE 1 END, NEW.duration_ms, NEW.estimated_cost)
  ON CONFLICT(day, model_name, purpose) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    total_tokens = total_tokens + excluded.total_tokens,
    estimated_tokens = estimated_tokens + excluded.estimated_tokens,
    cached_tokens = cached_tokens + excluded.cached_tokens,
    reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
    calls = calls + excluded.calls,
    failures = failures + excluded.failures,
    duration_ms = duration_ms + excluded.duration_ms,
    estimated_cost = estimated_cost + excluded.estimated_cost;
END;

CREATE TABLE embedding_budget_daily (
  day TEXT NOT NULL,
  model_name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, model_name, purpose)
) STRICT;

CREATE TABLE group_memory_policies (
  group_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  retention_days INTEGER CHECK(retention_days IS NULL OR retention_days >= 0),
  token_limit INTEGER CHECK(token_limit IS NULL OR token_limit BETWEEN 256 AND 60000),
  prompt_template TEXT,
  model_name TEXT,
  max_tokens INTEGER CHECK(max_tokens IS NULL OR max_tokens BETWEEN 256 AND 65536),
  min_confidence REAL CHECK(min_confidence IS NULL OR (min_confidence >= 0 AND min_confidence <= 1)),
  last_daily_end INTEGER NOT NULL DEFAULT 0,
  last_backfill_at INTEGER NOT NULL DEFAULT 0,
  last_backfill_status TEXT NOT NULL DEFAULT '',
  last_backfill_requested INTEGER NOT NULL DEFAULT 0,
  last_backfill_received INTEGER NOT NULL DEFAULT 0,
  last_backfill_saved INTEGER NOT NULL DEFAULT 0,
  last_backfill_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE group_memory_messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_id TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  sender_role TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  text_content TEXT NOT NULL DEFAULT '',
  segments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(segments_json)),
  content_hash TEXT NOT NULL,
  is_command INTEGER NOT NULL DEFAULT 0 CHECK(is_command IN (0, 1)),
  conflict_count INTEGER NOT NULL DEFAULT 0 CHECK(conflict_count >= 0),
  expires_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(group_id, message_id)
) STRICT;
CREATE INDEX group_memory_messages_group_time_idx ON group_memory_messages(group_id, sent_at DESC);
CREATE INDEX group_memory_messages_expiry_idx ON group_memory_messages(expires_at);

CREATE TABLE group_memory_extraction_jobs (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL CHECK(window_end > window_start),
  content_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(result_json)),
  token_limit INTEGER NOT NULL DEFAULT 0,
  estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
  skipped_message_count INTEGER NOT NULL DEFAULT 0,
  needs_reextract INTEGER NOT NULL DEFAULT 0 CHECK(needs_reextract IN (0, 1)),
  processing_chunk INTEGER NOT NULL DEFAULT 0,
  processing_chunk_total INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(group_id, window_start, window_end, extractor_version)
) STRICT;
CREATE INDEX group_memory_extraction_jobs_due_idx ON group_memory_extraction_jobs(status, next_attempt_at, updated_at);
CREATE INDEX group_memory_extraction_jobs_group_idx ON group_memory_extraction_jobs(group_id, window_start DESC);
