-- 只扩展元数据，不改写已有正文、状态、时间、证据或已完成窗口。
ALTER TABLE memory_items ADD COLUMN validity_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_items ADD COLUMN superseded_by TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_items ADD COLUMN observed_at INTEGER NOT NULL DEFAULT 0;

-- 模型结果先落检查点；写入中断后复用结果，已应用批次不再请求模型。
CREATE TABLE group_memory_extraction_batches (
  job_id TEXT NOT NULL REFERENCES group_memory_extraction_jobs(id) ON DELETE CASCADE,
  batch_key TEXT NOT NULL,
  source_versions_json TEXT NOT NULL CHECK(json_valid(source_versions_json)),
  candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json)),
  status TEXT NOT NULL CHECK(status IN ('extracted','applied')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(job_id,batch_key)
) STRICT;

CREATE TABLE memory_extraction_budget_daily (
  day TEXT PRIMARY KEY,
  used_tokens INTEGER NOT NULL DEFAULT 0 CHECK(used_tokens>=0),
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens>=0)
) STRICT;
