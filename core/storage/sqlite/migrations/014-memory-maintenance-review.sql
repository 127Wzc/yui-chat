-- 结束审阅只关闭建议，不修改原记忆，也不删除任务的来源和审计记录。
ALTER TABLE memory_maintenance_jobs ADD COLUMN reviewed_at INTEGER NOT NULL DEFAULT 0;
