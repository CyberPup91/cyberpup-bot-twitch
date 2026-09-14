import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'data', 'bot_database.db');
const db = new Database(dbPath);

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    name TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    trigger TEXT NOT NULL,
    response TEXT NOT NULL,
    UNIQUE(channel, trigger)
  );
`);

export default db;