-- Editable questions and immutable evaluation snapshots are independent of knowledge content.
CREATE TABLE knowledge_evaluation_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL DEFAULT 0,
  dataset_json TEXT NOT NULL CHECK(json_valid(dataset_json)),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE knowledge_evaluation_runs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  dataset_fingerprint TEXT NOT NULL,
  bundle_json TEXT NOT NULL CHECK(json_valid(bundle_json)),
  status TEXT NOT NULL DEFAULT 'completed',
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(progress_json)),
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
) STRICT;
