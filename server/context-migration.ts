import type { DatabaseSync } from "node:sqlite";
export function migrateContext(db: DatabaseSync) {
  if (db.prepare("SELECT 1 FROM migrations WHERE version=8").get()) return;
  try {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE project_context_anchors (project_id TEXT PRIMARY KEY REFERENCES projects(id), chapter_id TEXT REFERENCES chapters(id), origin TEXT NOT NULL);
      CREATE TRIGGER context_anchor_owned_insert BEFORE INSERT ON project_context_anchors WHEN NEW.chapter_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chapters WHERE id=NEW.chapter_id AND project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'Game Vision ownership mismatch'); END;
      CREATE TRIGGER context_anchor_owned_update BEFORE UPDATE ON project_context_anchors WHEN NEW.chapter_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chapters WHERE id=NEW.chapter_id AND project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'Game Vision ownership mismatch'); END;
      INSERT INTO project_context_anchors(project_id,chapter_id,origin)
      SELECT p.id, CASE WHEN (SELECT count(DISTINCT h.chapter_id) FROM chapter_revisions h WHERE h.project_id=p.id AND h.revision=0 AND h.origin='create' AND h.title='Game Vision')=1
      THEN (SELECT h.chapter_id FROM chapter_revisions h WHERE h.project_id=p.id AND h.revision=0 AND h.origin='create' AND h.title='Game Vision' LIMIT 1) ELSE NULL END, 'legacy-evidence' FROM projects p;
      CREATE TABLE workshop_context_requests (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), chapter_id TEXT NOT NULL REFERENCES chapters(id),
        user_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), context_json TEXT NOT NULL, manifest_json TEXT NOT NULL,
        request_json TEXT NOT NULL, context_digest TEXT NOT NULL, request_digest TEXT NOT NULL, provider_format TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX context_request_project ON workshop_context_requests(project_id,chapter_id);
      CREATE TABLE workshop_response_contexts (message_id TEXT PRIMARY KEY REFERENCES messages(id), request_id TEXT NOT NULL UNIQUE REFERENCES workshop_context_requests(id));
      CREATE TRIGGER context_request_owned BEFORE INSERT ON workshop_context_requests WHEN NOT EXISTS (
        SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=NEW.user_message_id AND m.role='user' AND c.project_id=NEW.project_id AND c.chapter_id=NEW.chapter_id
      ) BEGIN SELECT RAISE(ABORT,'Context request ownership mismatch'); END;
      CREATE TRIGGER response_context_owned BEFORE INSERT ON workshop_response_contexts WHEN NOT EXISTS (
        SELECT 1 FROM workshop_context_requests r JOIN messages u ON u.id=r.user_message_id JOIN messages m ON m.id=NEW.message_id WHERE r.id=NEW.request_id AND m.role='assistant' AND m.conversation_id=u.conversation_id
      ) BEGIN SELECT RAISE(ABORT,'Context response ownership mismatch'); END;
      CREATE TRIGGER context_request_immutable_update BEFORE UPDATE ON workshop_context_requests BEGIN SELECT RAISE(ABORT,'Context request is immutable'); END;
      CREATE TRIGGER context_request_immutable_delete BEFORE DELETE ON workshop_context_requests BEGIN SELECT RAISE(ABORT,'Context request is immutable'); END;
      CREATE TRIGGER context_response_immutable_update BEFORE UPDATE ON workshop_response_contexts BEGIN SELECT RAISE(ABORT,'Context response association is immutable'); END;
      CREATE TRIGGER context_response_immutable_delete BEFORE DELETE ON workshop_response_contexts BEGIN SELECT RAISE(ABORT,'Context response association is immutable'); END;
      INSERT INTO migrations VALUES(8,datetime('now')); COMMIT;`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
