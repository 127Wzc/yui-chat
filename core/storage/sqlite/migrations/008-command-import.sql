-- The imported catalogue starts empty. Legacy command projections and jobs are not migrated.
DELETE FROM knowledge_documents WHERE knowledge_base_id='builtin-commands';
DELETE FROM knowledge_index_jobs WHERE knowledge_base_id='builtin-commands';
UPDATE knowledge_bases SET active_vector_space_id=NULL,updated_at=updated_at+1 WHERE id='builtin-commands';

CREATE TABLE knowledge_document_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_base_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  operation TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX knowledge_document_history_lookup ON knowledge_document_history(knowledge_base_id, source_key, id DESC);
CREATE TABLE knowledge_import_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE knowledge_import_changes (
  run_id TEXT NOT NULL REFERENCES knowledge_import_runs(id) ON DELETE CASCADE,
  document_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  PRIMARY KEY(run_id, document_key)
) STRICT;
CREATE TABLE knowledge_vector_tasks (
  kind TEXT NOT NULL CHECK(kind IN ('document','delete')),
  owner_id TEXT NOT NULL,
  knowledge_base_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(kind, owner_id)
) STRICT;
CREATE INDEX knowledge_vector_tasks_due ON knowledge_vector_tasks(retry_at, updated_at);
