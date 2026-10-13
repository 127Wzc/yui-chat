CREATE TABLE extension_installations (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
) STRICT;
CREATE INDEX extension_installations_status ON extension_installations(status, updated_at);
CREATE TABLE extension_installation_events (
  operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(operation_id, sequence),
  FOREIGN KEY(operation_id) REFERENCES extension_installations(id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER extension_installations_created AFTER INSERT ON extension_installations BEGIN
  INSERT INTO extension_installation_events VALUES(NEW.id, NEW.version, NEW.updated_at, json_extract(NEW.payload, '$.event'));
END;
CREATE TRIGGER extension_installations_changed AFTER UPDATE ON extension_installations BEGIN
  INSERT INTO extension_installation_events VALUES(NEW.id, NEW.version, NEW.updated_at, json_extract(NEW.payload, '$.event'));
END;
CREATE TABLE extension_installation_receipts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  installation_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  retired_at INTEGER
) STRICT;
CREATE UNIQUE INDEX extension_receipts_active_target ON extension_installation_receipts(kind,target_id) WHERE retired_at IS NULL;
CREATE TABLE extension_credentials (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL CHECK(json_valid(payload))
) STRICT;
