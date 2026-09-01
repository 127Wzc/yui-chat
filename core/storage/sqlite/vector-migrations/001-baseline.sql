-- 可重建的向量库基线；实际 embedding 仅保存于每个 vec_* 虚表。

CREATE TABLE embedding_spaces (
  id TEXT PRIMARY KEY,
  model_name TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK(dimensions > 0),
  distance_metric TEXT NOT NULL DEFAULT 'cosine' CHECK(distance_metric IN ('cosine', 'l2', 'l1')),
  scope_key TEXT NOT NULL DEFAULT '',
  UNIQUE(model_name, dimensions, distance_metric, scope_key)
) STRICT;

CREATE TABLE embedding_records (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE(space_id, owner_type, owner_id),
  FOREIGN KEY(space_id) REFERENCES embedding_spaces(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX embedding_records_owner_idx ON embedding_records(owner_type, owner_id);
