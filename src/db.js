import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'data', 'bot_database.db');
const db = new Database(dbPath);

// Initialize Base Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    name TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    trigger TEXT NOT NULL,
    response TEXT NOT NULL,
    userlevel INTEGER DEFAULT 0,
    cooldown INTEGER DEFAULT 5,
    last_used INTEGER DEFAULT 0,
    UNIQUE(channel, trigger)
  );

  CREATE TABLE IF NOT EXISTS automations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    channel TEXT NOT NULL DEFAULT '*',
    trigger_type TEXT NOT NULL,
    trigger_config TEXT NOT NULL DEFAULT '{}',
    conditions TEXT NOT NULL DEFAULT '{}',
    actions TEXT NOT NULL DEFAULT '[]',
    cooldown_sec INTEGER DEFAULT 0,
    user_cooldown_sec INTEGER DEFAULT 0,
    last_fired INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Raid tracking (per channel, per stream session)
  CREATE TABLE IF NOT EXISTS raids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    stream_id TEXT,
    raider_login TEXT NOT NULL,
    viewers INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Last known stream ID per channel (drives per-stream raid clearing)
  CREATE TABLE IF NOT EXISTS channel_streams (
    channel TEXT PRIMARY KEY,
    stream_id TEXT
  );

  -- Auto-shoutout friends (per channel)
  CREATE TABLE IF NOT EXISTS autoso_friends (
    channel TEXT NOT NULL,
    username TEXT NOT NULL,
    added_by TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (channel, username)
  );

  -- Who already got an auto-shoutout this stream (per channel)
  CREATE TABLE IF NOT EXISTS autoso_log (
    channel TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    username TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (channel, stream_id, username)
  );
`);

// Migration Helper: Explicitly add missing columns if upgrading an existing DB
function addColumnIfNotExists(table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    // Column already exists, ignore error
  }
}

addColumnIfNotExists('commands', 'userlevel INTEGER DEFAULT 0');
addColumnIfNotExists('commands', 'cooldown INTEGER DEFAULT 5');
addColumnIfNotExists('commands', 'last_used INTEGER DEFAULT 0');
addColumnIfNotExists('automations', 'user_cooldown_sec INTEGER DEFAULT 0');

export default db;