import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrateKnowledge } from "./knowledge-migration.js";

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
  if (!db.prepare("SELECT version FROM migrations WHERE version = 2").get()) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'update_chapter';
      ALTER TABLE proposals ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE proposals ADD COLUMN section TEXT;
      ALTER TABLE proposals ADD COLUMN proposed_status TEXT;
      ALTER TABLE proposals ADD COLUMN related_chapter_ids TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE proposals ADD COLUMN before_snapshot TEXT;
      UPDATE proposals SET kind='create_chapter' WHERE chapter_id IS NULL;
      UPDATE proposals SET before_snapshot=(SELECT json_object('title',c.title,'content',json(c.content),'status',c.status) FROM chapters c WHERE c.id=proposals.chapter_id AND c.revision=proposals.base_revision) WHERE chapter_id IS NOT NULL;
      CREATE TABLE design_records (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('decision','question')), text TEXT NOT NULL, rationale TEXT NOT NULL, related_chapter_ids TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('approved','open','resolved')), created_at TEXT NOT NULL);
      CREATE INDEX records_project ON design_records(project_id);
      INSERT INTO migrations VALUES (2, datetime('now'));
      COMMIT;`);
  }
  if (!db.prepare("SELECT version FROM migrations WHERE version = 3").get()) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE chapters ADD COLUMN parent_id TEXT REFERENCES chapters(id) ON DELETE SET NULL;
      ALTER TABLE proposals ADD COLUMN parent_id TEXT REFERENCES chapters(id) ON DELETE CASCADE;
      CREATE INDEX chapter_parent ON chapters(project_id, parent_id, position);
      INSERT INTO migrations VALUES (3, datetime('now'));
      COMMIT;`);
  }
  if (!db.prepare("SELECT version FROM migrations WHERE version = 4").get()) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE chapters ADD COLUMN approved_revision INTEGER;
      ALTER TABLE chapters ADD COLUMN archived_at TEXT;
      CREATE UNIQUE INDEX chapter_project_identity ON chapters(id, project_id);
      CREATE TABLE chapter_revisions (
        chapter_id TEXT NOT NULL REFERENCES chapters(id),
        revision INTEGER NOT NULL CHECK(revision >= 0),
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('Exploring','Proposed','Approved','Needs Revision')),
        parent_id TEXT, created_at TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('migration','create','manual','proposal','restore','archive','reparent','unarchive')),
        proposal_id TEXT REFERENCES proposals(id), restored_from INTEGER,
        PRIMARY KEY(chapter_id, revision),
        FOREIGN KEY(chapter_id, project_id) REFERENCES chapters(id, project_id),
        FOREIGN KEY(chapter_id, restored_from) REFERENCES chapter_revisions(chapter_id, revision)
      );
      CREATE TABLE chapter_approvals (
        chapter_id TEXT NOT NULL, revision INTEGER NOT NULL,
        approved_at TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('migration','manual','proposal')),
        proposal_id TEXT REFERENCES proposals(id),
        PRIMARY KEY(chapter_id, revision),
        FOREIGN KEY(chapter_id, revision) REFERENCES chapter_revisions(chapter_id, revision)
      );
      INSERT INTO chapter_revisions (chapter_id,revision,project_id,title,content,status,parent_id,created_at,origin)
        SELECT id,revision,project_id,title,content,status,parent_id,updated_at,'migration' FROM chapters;
      INSERT INTO chapter_approvals (chapter_id,revision,approved_at,origin)
        SELECT id,revision,updated_at,'migration' FROM chapters WHERE status='Approved';
      UPDATE chapters SET approved_revision=revision WHERE status='Approved';
      CREATE INDEX chapter_archive ON chapters(project_id, archived_at, position);
      CREATE TRIGGER revision_immutable_update BEFORE UPDATE ON chapter_revisions BEGIN SELECT RAISE(ABORT,'Chapter history is immutable'); END;
      CREATE TRIGGER revision_immutable_delete BEFORE DELETE ON chapter_revisions BEGIN SELECT RAISE(ABORT,'Chapter history is immutable'); END;
      CREATE TRIGGER approval_immutable_update BEFORE UPDATE ON chapter_approvals BEGIN SELECT RAISE(ABORT,'Chapter approvals are immutable'); END;
      CREATE TRIGGER approval_immutable_delete BEFORE DELETE ON chapter_approvals BEGIN SELECT RAISE(ABORT,'Chapter approvals are immutable'); END;
      CREATE TRIGGER chapter_approval_valid BEFORE UPDATE OF approved_revision ON chapters
        WHEN NEW.approved_revision IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM chapter_approvals WHERE chapter_id=NEW.id AND revision=NEW.approved_revision
        ) BEGIN SELECT RAISE(ABORT,'Approval must reference a saved chapter revision'); END;
      INSERT INTO migrations VALUES (4, datetime('now'));
      COMMIT;`);
  }
  migrateKnowledge(db);
  return db;
}
