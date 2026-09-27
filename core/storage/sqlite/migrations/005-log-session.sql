ALTER TABLE ai_runs ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_ai_runs_session ON ai_runs(session_id, started_at);
