CREATE TABLE tool_call_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  model_call_id TEXT NOT NULL DEFAULT '',
  round INTEGER NOT NULL DEFAULT 0,
  call_index INTEGER NOT NULL DEFAULT 0,
  tool_call_id TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  result_chars INTEGER NOT NULL DEFAULT 0,
  delivery TEXT NOT NULL DEFAULT '',
  requires_final_reply INTEGER NOT NULL DEFAULT 1 CHECK(requires_final_reply IN (0, 1)),
  arguments_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(arguments_json)),
  result_text TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  FOREIGN KEY(run_id) REFERENCES ai_runs(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX tool_call_run_idx ON tool_call_events(run_id, round ASC, call_index ASC, started_at ASC);
CREATE INDEX tool_call_name_idx ON tool_call_events(tool_name, started_at DESC);
CREATE INDEX tool_call_status_idx ON tool_call_events(status, started_at DESC);

-- Group memory retrieval controls and tool execution lineage are part of the
-- same uncommitted schema version as the tool call event table.
ALTER TABLE group_memory_policies
  ADD COLUMN retrieval_result_limit INTEGER
  CHECK(retrieval_result_limit IS NULL OR retrieval_result_limit BETWEEN 1 AND 20);

ALTER TABLE ai_runs ADD COLUMN parent_run_id TEXT NOT NULL DEFAULT '';
ALTER TABLE model_call_events ADD COLUMN parent_tool_id TEXT NOT NULL DEFAULT '';
ALTER TABLE tool_call_events ADD COLUMN parent_tool_id TEXT NOT NULL DEFAULT '';

CREATE INDEX ai_runs_parent_idx ON ai_runs(parent_run_id, started_at DESC);
CREATE INDEX model_call_parent_tool_idx ON model_call_events(parent_tool_id, started_at ASC);
CREATE INDEX tool_call_parent_idx ON tool_call_events(parent_tool_id, started_at ASC);
