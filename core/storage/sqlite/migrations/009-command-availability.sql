CREATE TABLE knowledge_command_disabled (
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('plugin','command')),
  target_id TEXT NOT NULL,
  PRIMARY KEY(source_id, kind, target_id)
) STRICT;
