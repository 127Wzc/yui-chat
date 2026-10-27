-- Portraits are introduced after 009 with independent task types and monthly quotas.
CREATE TABLE portrait_type_defaults (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  type_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(group_id, user_id)
) STRICT;

CREATE TABLE portrait_reports (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','invalid')),
  report_json TEXT NOT NULL CHECK(json_valid(report_json)),
  sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
  created_at INTEGER NOT NULL,
  UNIQUE(group_id, user_id, type_id, version)
) STRICT;
CREATE INDEX portrait_reports_scope_idx ON portrait_reports(group_id, user_id, type_id, version DESC);

CREATE TABLE portrait_monthly_usage (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  month TEXT NOT NULL,
  report_id TEXT NOT NULL,
  PRIMARY KEY(group_id, user_id, type_id, month)
) STRICT;

CREATE TABLE portrait_jobs (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  month TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  forced INTEGER NOT NULL CHECK(forced IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL DEFAULT 0,
  report_id TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE UNIQUE INDEX portrait_jobs_running_idx ON portrait_jobs(group_id, user_id, type_id) WHERE status='running';

-- Explicit deletion / revision withdraws derived reports, including reports in flight.
CREATE TRIGGER portrait_memory_deleted AFTER DELETE ON memory_items BEGIN
  UPDATE portrait_reports SET status='invalid'
    WHERE EXISTS (SELECT 1 FROM json_each(sources_json,'$.memories') WHERE json_extract(value,'$.id')=OLD.id)
       OR (OLD.type='profile' AND user_id=OLD.owner_id);
END;
CREATE TRIGGER portrait_memory_changed AFTER UPDATE OF text,status ON memory_items
WHEN NEW.text<>OLD.text OR NEW.status IN ('deleted','archived') BEGIN
  UPDATE portrait_reports SET status='invalid'
    WHERE EXISTS (SELECT 1 FROM json_each(sources_json,'$.memories') WHERE json_extract(value,'$.id')=OLD.id)
       OR (OLD.type='profile' AND user_id=OLD.owner_id);
END;
CREATE TRIGGER portrait_raw_deleted AFTER DELETE ON group_memory_messages
WHEN OLD.expires_at=0 OR OLD.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) BEGIN
  UPDATE portrait_reports SET status='invalid' WHERE group_id=OLD.group_id
    AND EXISTS (SELECT 1 FROM json_each(sources_json,'$.messages') WHERE json_extract(value,'$.id')=OLD.id);
END;
CREATE TRIGGER portrait_raw_changed AFTER UPDATE OF text_content ON group_memory_messages
WHEN NEW.text_content<>OLD.text_content BEGIN
  UPDATE portrait_reports SET status='invalid' WHERE group_id=OLD.group_id
    AND EXISTS (SELECT 1 FROM json_each(sources_json,'$.messages') WHERE json_extract(value,'$.id')=OLD.id);
END;
