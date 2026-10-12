import type { DatabaseSync } from "node:sqlite";

export function migrateKnowledgeProposals(db: DatabaseSync) {
  if (db.prepare("SELECT 1 FROM migrations WHERE version=6").get()) return;
  try {
    db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE proposals ADD COLUMN knowledge_payload TEXT;
    ALTER TABLE proposals ADD COLUMN applied_result TEXT;
    CREATE TABLE proposal_dependencies (
      proposal_id TEXT NOT NULL REFERENCES proposals(id),
      prerequisite_id TEXT NOT NULL REFERENCES proposals(id),
      reference_key TEXT NOT NULL,
      PRIMARY KEY(proposal_id,reference_key),
      CHECK(proposal_id<>prerequisite_id)
    );
    CREATE TRIGGER proposal_dependency_owner BEFORE INSERT ON proposal_dependencies
    WHEN NOT EXISTS (SELECT 1 FROM proposals p JOIN proposals q ON q.id=NEW.prerequisite_id
      WHERE p.id=NEW.proposal_id AND p.project_id=q.project_id AND p.message_id=q.message_id)
    BEGIN SELECT RAISE(ABORT,'Proposal dependencies must share project and response'); END;
    CREATE TRIGGER proposal_payload_immutable BEFORE UPDATE OF knowledge_payload ON proposals
      WHEN OLD.knowledge_payload IS NOT NEW.knowledge_payload
      BEGIN SELECT RAISE(ABORT,'Proposal snapshots are immutable'); END;
    CREATE TRIGGER proposal_result_immutable BEFORE UPDATE OF applied_result ON proposals
      WHEN OLD.applied_result IS NOT NULL AND OLD.applied_result IS NOT NEW.applied_result
      BEGIN SELECT RAISE(ABORT,'Applied proposal result is immutable'); END;
    INSERT INTO migrations VALUES(6,datetime('now'));
    COMMIT;`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
