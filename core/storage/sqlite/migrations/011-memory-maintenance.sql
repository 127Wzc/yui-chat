CREATE TABLE memory_maintenance_versions (
  scope_type TEXT NOT NULL, owner_id TEXT NOT NULL, group_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope_type, owner_id, group_id)
) STRICT;

CREATE TABLE memory_maintenance_jobs (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL DEFAULT 'web-admin',
  status TEXT NOT NULL CHECK(status IN ('queued','collecting','analyzing','ready','applied','undone','cancelled','failed','stale')),
  use_history INTEGER NOT NULL DEFAULT 0 CHECK(use_history IN (0,1)),
  requested_count INTEGER NOT NULL DEFAULT 0,
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(progress_json)),
  snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(snapshot_json)),
  plan_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(plan_json)),
  chunks_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(chunks_json)),
  receipt_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(receipt_json)),
  apply_hash TEXT NOT NULL DEFAULT '', error_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  undo_until INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX memory_maintenance_jobs_target_idx ON memory_maintenance_jobs(group_id,user_id,created_at DESC);
-- 个人全局记忆由同一用户跨群共用，不能只在群内防止重复任务。
CREATE UNIQUE INDEX memory_maintenance_jobs_running_user_idx ON memory_maintenance_jobs(user_id)
  WHERE user_id<>'' AND status IN ('queued','collecting','analyzing');
CREATE UNIQUE INDEX memory_maintenance_jobs_running_group_idx ON memory_maintenance_jobs(group_id)
  WHERE user_id='' AND status IN ('queued','collecting','analyzing');
CREATE TABLE memory_maintenance_sources (
  job_id TEXT NOT NULL REFERENCES memory_maintenance_jobs(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL DEFAULT '', group_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(job_id,memory_id,group_id)
) STRICT;
CREATE INDEX memory_maintenance_sources_memory_idx ON memory_maintenance_sources(memory_id);
CREATE INDEX memory_maintenance_sources_group_idx ON memory_maintenance_sources(group_id);

CREATE TRIGGER memory_maintenance_item_added AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_maintenance_versions VALUES(NEW.scope_type,NEW.owner_id,NEW.group_id,1)
    ON CONFLICT(scope_type,owner_id,group_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER memory_maintenance_item_changed AFTER UPDATE ON memory_items BEGIN
  INSERT INTO memory_maintenance_versions VALUES(OLD.scope_type,OLD.owner_id,OLD.group_id,1)
    ON CONFLICT(scope_type,owner_id,group_id) DO UPDATE SET revision=revision+1;
  INSERT INTO memory_maintenance_versions VALUES(NEW.scope_type,NEW.owner_id,NEW.group_id,1)
    ON CONFLICT(scope_type,owner_id,group_id) DO UPDATE SET revision=revision+1;
  DELETE FROM memory_maintenance_jobs WHERE NEW.status='deleted'
    AND id IN (SELECT job_id FROM memory_maintenance_sources WHERE memory_id=OLD.id);
END;
CREATE TRIGGER memory_maintenance_item_removed AFTER DELETE ON memory_items BEGIN
  INSERT INTO memory_maintenance_versions VALUES(OLD.scope_type,OLD.owner_id,OLD.group_id,1)
    ON CONFLICT(scope_type,owner_id,group_id) DO UPDATE SET revision=revision+1;
  DELETE FROM memory_maintenance_jobs WHERE id IN (SELECT job_id FROM memory_maintenance_sources WHERE memory_id=OLD.id);
END;
CREATE TRIGGER memory_maintenance_evidence_added AFTER INSERT ON memory_evidence BEGIN
  INSERT INTO memory_maintenance_versions SELECT scope_type,owner_id,group_id,1 FROM memory_items WHERE id=NEW.memory_id
    ON CONFLICT(scope_type,owner_id,group_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER memory_maintenance_evidence_removed AFTER DELETE ON memory_evidence BEGIN
  INSERT INTO memory_maintenance_versions SELECT scope_type,owner_id,group_id,1 FROM memory_items WHERE id=OLD.memory_id
    ON CONFLICT(scope_type,owner_id,group_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER memory_maintenance_evidence_changed AFTER UPDATE ON memory_evidence BEGIN
  INSERT INTO memory_maintenance_versions SELECT scope_type,owner_id,group_id,1 FROM memory_items WHERE id IN (OLD.memory_id,NEW.memory_id)
    ON CONFLICT(scope_type,owner_id,group_id) DO UPDATE SET revision=revision+1;
END;
-- 修改原文会使引用该群原文的历史分析失效；默认仅整理不受自然原文到期影响。
CREATE TRIGGER memory_maintenance_raw_changed AFTER UPDATE OF text_content,group_id,message_id,sender_id,sent_at,segments_json,is_command ON group_memory_messages
WHEN NEW.text_content<>OLD.text_content OR NEW.group_id<>OLD.group_id OR NEW.message_id<>OLD.message_id
  OR NEW.sender_id<>OLD.sender_id OR NEW.sent_at<>OLD.sent_at OR NEW.segments_json<>OLD.segments_json OR NEW.is_command<>OLD.is_command BEGIN
  DELETE FROM memory_maintenance_jobs WHERE use_history=1
    AND id IN (SELECT job_id FROM memory_maintenance_sources WHERE group_id=OLD.group_id);
END;
CREATE TRIGGER memory_maintenance_raw_removed AFTER DELETE ON group_memory_messages
WHEN OLD.expires_at=0 OR OLD.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) BEGIN
  DELETE FROM memory_maintenance_jobs WHERE use_history=1
    AND id IN (SELECT job_id FROM memory_maintenance_sources WHERE group_id=OLD.group_id);
END;
