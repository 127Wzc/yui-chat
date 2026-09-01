-- 模型请求的详细上下文单独存储；主链路查询不读取这些正文，详情窗口按需加载。
CREATE TABLE model_call_snapshots (
  model_call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  operation TEXT NOT NULL DEFAULT '',
  messages_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(messages_json)),
  tools_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tools_json)),
  request_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(request_json)),
  message_count INTEGER NOT NULL DEFAULT 0 CHECK(message_count >= 0),
  tool_count INTEGER NOT NULL DEFAULT 0 CHECK(tool_count >= 0),
  context_chars INTEGER NOT NULL DEFAULT 0 CHECK(context_chars >= 0),
  tool_chars INTEGER NOT NULL DEFAULT 0 CHECK(tool_chars >= 0),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1)),
  redaction_version TEXT NOT NULL DEFAULT 'v1',
  captured_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(model_call_id) REFERENCES model_call_events(id) ON DELETE CASCADE,
  FOREIGN KEY(run_id) REFERENCES ai_runs(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX model_call_snapshot_run_idx ON model_call_snapshots(run_id, sequence ASC);
