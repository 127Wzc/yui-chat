-- 会话身份独立于聊天历史 TTL；只有显式结束/删除对话才删除。
CREATE TABLE langfuse_sessions (
  target TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  conversation_scope TEXT NOT NULL,
  session_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  root_span_id TEXT NOT NULL,
  root_queued INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(target, scope_key)
) STRICT;

CREATE TABLE langfuse_budget_monthly (
  target TEXT NOT NULL,
  month TEXT NOT NULL,
  reserved_units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(target, month)
) STRICT;

-- 保存脱敏后的 OTLP observation，不保存访问密钥；失败记录保留等待重试。
CREATE TABLE langfuse_outbox (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  budget_month TEXT NOT NULL,
  units INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_langfuse_outbox_target ON langfuse_outbox(target, created_at);
