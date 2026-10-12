import type { DatabaseSync } from "node:sqlite";

export function migrateDocumentProposals(db: DatabaseSync) {
  if (db.prepare("SELECT 1 FROM migrations WHERE version=7").get()) return;
  try {
    db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE proposals ADD COLUMN document_payload TEXT;
    CREATE TRIGGER document_proposal_immutable BEFORE UPDATE OF document_payload ON proposals
    WHEN OLD.document_payload IS NOT NEW.document_payload
    BEGIN SELECT RAISE(ABORT,'Canonical document proposal evidence is immutable'); END;
    CREATE TRIGGER canonical_proposal_content_immutable BEFORE UPDATE OF content,before_snapshot,base_revision,chapter_id,message_id,conversation_id,project_id ON proposals
    WHEN OLD.document_payload IS NOT NULL AND (OLD.content IS NOT NEW.content OR OLD.before_snapshot IS NOT NEW.before_snapshot OR OLD.base_revision IS NOT NEW.base_revision OR OLD.chapter_id IS NOT NEW.chapter_id OR OLD.message_id IS NOT NEW.message_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.project_id IS NOT NEW.project_id)
    BEGIN SELECT RAISE(ABORT,'Canonical document proposal snapshots are immutable'); END;
    INSERT INTO migrations VALUES(7,datetime('now'));
    COMMIT;`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
