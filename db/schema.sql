-- Unified Inbox — local message store schema.
-- Timestamps are ISO-8601 UTC strings. Money/PII never logged here beyond message bodies.
-- DB engine is accessed only through src/core/store/InboxStore.ts (swappable).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- A channel instance: a specific WhatsApp number, the Duoke bridge, the webstore, or a fake.
CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,           -- e.g. 'whatsapp:num-1', 'duoke', 'webstore', 'fake:demo'
  kind       TEXT NOT NULL,              -- 'whatsapp' | 'duoke' | 'webstore' | 'fake'
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- A customer identity *within a channel* (same human across channels may be linked later).
CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id),
  external_id TEXT NOT NULL,             -- phone / marketplace buyer id / web visitor id
  name        TEXT,
  phone       TEXT,
  meta        TEXT,                      -- JSON
  created_at  TEXT NOT NULL,
  UNIQUE (channel_id, external_id)
);

-- A conversation thread on a channel.
CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL REFERENCES channels(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  thread_key      TEXT NOT NULL,         -- adapter-stable conversation key within the channel
  subject         TEXT,
  status          TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'snoozed' | 'closed'
  unread          INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  assignee        TEXT,                  -- staff name this thread is routed to; NULL = unassigned
  UNIQUE (channel_id, thread_key)
);
CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id);
CREATE INDEX IF NOT EXISTS idx_threads_last    ON threads(last_message_at DESC);

-- Every message, inbound or outbound.
CREATE TABLE IF NOT EXISTS messages (
  id                 TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL REFERENCES threads(id),
  direction          TEXT NOT NULL,      -- 'inbound' | 'outbound'
  body               TEXT NOT NULL,
  channel_message_id TEXT,               -- id assigned by the channel (dedupe / receipts)
  author_name        TEXT,
  meta               TEXT,               -- JSON
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
-- Idempotent ingest: never store the same channel message twice in a thread.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe
  ON messages(thread_id, channel_message_id) WHERE channel_message_id IS NOT NULL;

-- AI-drafted (or human-edited) replies awaiting approval. One "live" draft per thread in practice.
CREATE TABLE IF NOT EXISTS drafts (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(id),
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'suggested', -- suggested|edited|approved|sent|discarded
  provider_id TEXT,                              -- which LLMProvider produced it
  model       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_thread ON drafts(thread_id, updated_at DESC);

-- Immutable audit of every outbound send (who approved, which channel, when).
CREATE TABLE IF NOT EXISTS send_audit (
  id                 TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL,
  channel_id         TEXT NOT NULL,
  draft_id           TEXT,
  body               TEXT NOT NULL,
  channel_message_id TEXT,
  approved_by        TEXT,                -- 'human:ui' for manual approval; future: user id
  auto               INTEGER NOT NULL DEFAULT 0,  -- 1 if sent via enabled auto-send
  sent_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_send_audit_thread ON send_audit(thread_id);
-- countSendsSince filters (channel_id, sent_at) on every send-policy check + guard poll.
CREATE INDEX IF NOT EXISTS idx_send_audit_channel_time ON send_audit(channel_id, sent_at);

-- Small key/value store for app state that must survive restarts (e.g. the WhatsApp
-- kill switch). Values are strings; callers encode as needed.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
