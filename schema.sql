CREATE TABLE IF NOT EXISTS app_state (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_meta (
  user_id TEXT PRIMARY KEY,
  current_id TEXT,
  settings TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 3
);

CREATE TABLE IF NOT EXISTS conversations (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  sync_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS messages (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  sync_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id, message_index)
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_order ON conversations (user_id, order_index);
CREATE INDEX IF NOT EXISTS idx_messages_convo_order ON messages (user_id, conversation_id, message_index);
