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

export default db;