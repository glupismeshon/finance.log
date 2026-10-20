CREATE TABLE records (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  device TEXT,
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX records_seq ON records(user_id, seq);

CREATE TABLE user_seq (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0,
  last_sync INTEGER
);
