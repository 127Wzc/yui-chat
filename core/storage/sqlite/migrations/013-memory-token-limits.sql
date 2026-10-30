-- 扩大群提炼与 AI 整理共用的 Token 范围，保留所有既有覆盖值与采集状态。
CREATE TABLE group_memory_policies_expanded (
  group_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  retention_days INTEGER CHECK(retention_days IS NULL OR retention_days >= 0),
  token_limit INTEGER CHECK(token_limit IS NULL OR token_limit BETWEEN 3000 AND 1000000),
  prompt_template TEXT,
  model_name TEXT,
  max_tokens INTEGER CHECK(max_tokens IS NULL OR max_tokens BETWEEN 256 AND 100000),
  min_confidence REAL CHECK(min_confidence IS NULL OR (min_confidence >= 0 AND min_confidence <= 1)),
  last_daily_end INTEGER NOT NULL DEFAULT 0,
  last_backfill_at INTEGER NOT NULL DEFAULT 0,
  last_backfill_status TEXT NOT NULL DEFAULT '',
  last_backfill_requested INTEGER NOT NULL DEFAULT 0,
  last_backfill_received INTEGER NOT NULL DEFAULT 0,
  last_backfill_saved INTEGER NOT NULL DEFAULT 0,
  last_backfill_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retrieval_result_limit INTEGER CHECK(retrieval_result_limit IS NULL OR retrieval_result_limit BETWEEN 1 AND 20)
) STRICT;

INSERT INTO group_memory_policies_expanded SELECT * FROM group_memory_policies;
DROP TABLE group_memory_policies;
ALTER TABLE group_memory_policies_expanded RENAME TO group_memory_policies;
