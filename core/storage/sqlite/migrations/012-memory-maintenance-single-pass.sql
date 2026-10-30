-- 整理只执行一次模型调用，移除已失效的分批结果缓存。
ALTER TABLE memory_maintenance_jobs DROP COLUMN chunks_json;

DROP TRIGGER memory_maintenance_raw_changed;
DROP TRIGGER memory_maintenance_raw_removed;

-- 单条原文变化只影响真正引用它的任务；显式清群仍由群级清理入口处理。
CREATE TRIGGER memory_maintenance_raw_changed
AFTER UPDATE OF text_content,group_id,message_id,sender_id,sent_at,segments_json,is_command ON group_memory_messages
WHEN NEW.text_content<>OLD.text_content OR NEW.group_id<>OLD.group_id OR NEW.message_id<>OLD.message_id
  OR NEW.sender_id<>OLD.sender_id OR NEW.sent_at<>OLD.sent_at OR NEW.segments_json<>OLD.segments_json OR NEW.is_command<>OLD.is_command BEGIN
  DELETE FROM memory_maintenance_jobs WHERE use_history=1
    AND EXISTS (SELECT 1 FROM json_each(snapshot_json,'$.messages') WHERE json_extract(value,'$.id')=OLD.id);
END;

CREATE TRIGGER memory_maintenance_raw_removed AFTER DELETE ON group_memory_messages
WHEN OLD.expires_at=0 OR OLD.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) BEGIN
  DELETE FROM memory_maintenance_jobs WHERE use_history=1
    AND EXISTS (SELECT 1 FROM json_each(snapshot_json,'$.messages') WHERE json_extract(value,'$.id')=OLD.id);
END;
