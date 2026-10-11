import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path: string) {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`,
  );
  if (!db.prepare("SELECT version FROM migrations WHERE version = 1").get()) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, premise TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE chapters (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('Exploring','Proposed','Approved','Needs Revision')), position INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE INDEX chapter_order ON chapters(project_id, position);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, chapter_id TEXT NOT NULL UNIQUE REFERENCES chapters(id) ON DELETE CASCADE);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'complete', created_at TEXT NOT NULL);
      CREATE INDEX message_order ON messages(conversation_id, created_at);
      CREATE TABLE proposals (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, chapter_id TEXT REFERENCES chapters(id) ON DELETE CASCADE, title TEXT NOT NULL, content TEXT NOT NULL, reason TEXT NOT NULL, base_revision INTEGER, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')), created_at TEXT NOT NULL);
      INSERT INTO migrations VALUES (1, datetime('now'));
      COMMIT;`);
  }
  return db;
}
