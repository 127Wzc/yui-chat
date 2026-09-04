ALTER TABLE conversations
ADD COLUMN state_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(state_json));
