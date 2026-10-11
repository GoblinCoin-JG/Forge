import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export function migrateKnowledge(db: DatabaseSync) {
  if (db.prepare("SELECT version FROM migrations WHERE version=5").get())
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE design_records ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0);
      ALTER TABLE design_records ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE design_records ADD COLUMN superseded_by TEXT REFERENCES design_records(id);
      ALTER TABLE design_records ADD COLUMN resolution TEXT;
      ALTER TABLE design_records ADD COLUMN resolved_at TEXT;
      UPDATE design_records SET updated_at=created_at;
      CREATE UNIQUE INDEX record_project_identity ON design_records(id,project_id);
      CREATE UNIQUE INDEX chapter_revision_project ON chapter_revisions(chapter_id,revision,project_id);
      CREATE TABLE design_concepts (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL, normalized_name TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('Exploring','Proposed','Approved','Needs Revision')),
        revision INTEGER NOT NULL CHECK(revision>=0), approved_revision INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
        UNIQUE(id,project_id)
      );
      CREATE UNIQUE INDEX concept_active_name ON design_concepts(project_id,normalized_name) WHERE archived_at IS NULL;
      CREATE TABLE concept_chapters (
        project_id TEXT NOT NULL, concept_id TEXT NOT NULL, chapter_id TEXT NOT NULL,
        PRIMARY KEY(concept_id,chapter_id),
        FOREIGN KEY(concept_id,project_id) REFERENCES design_concepts(id,project_id),
        FOREIGN KEY(chapter_id,project_id) REFERENCES chapters(id,project_id)
      );
      CREATE INDEX concept_chapter_lookup ON concept_chapters(project_id,chapter_id);
      CREATE TABLE design_relationships (
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),
        source_concept_id TEXT NOT NULL,target_concept_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('depends_on','interacts_with','affects','part_of','conflicts_with')),
        rationale TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Exploring','Proposed','Approved','Needs Revision')),
        revision INTEGER NOT NULL CHECK(revision>=0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,retired_at TEXT,
        UNIQUE(id,project_id), CHECK(source_concept_id<>target_concept_id),
        CHECK(type NOT IN ('interacts_with','conflicts_with') OR source_concept_id<target_concept_id),
        FOREIGN KEY(source_concept_id,project_id) REFERENCES design_concepts(id,project_id),
        FOREIGN KEY(target_concept_id,project_id) REFERENCES design_concepts(id,project_id)
      );
      CREATE UNIQUE INDEX active_relationship_unique ON design_relationships(project_id,source_concept_id,target_concept_id,type) WHERE retired_at IS NULL;
      CREATE INDEX relationship_targets ON design_relationships(project_id,target_concept_id);
      CREATE TABLE record_chapters (
        project_id TEXT NOT NULL,record_id TEXT NOT NULL,chapter_id TEXT NOT NULL,
        PRIMARY KEY(record_id,chapter_id),
        FOREIGN KEY(record_id,project_id) REFERENCES design_records(id,project_id),
        FOREIGN KEY(chapter_id,project_id) REFERENCES chapters(id,project_id)
      );
      CREATE INDEX record_chapter_lookup ON record_chapters(project_id,chapter_id);
      CREATE TABLE record_concepts (
        project_id TEXT NOT NULL,record_id TEXT NOT NULL,concept_id TEXT NOT NULL,
        PRIMARY KEY(record_id,concept_id),
        FOREIGN KEY(record_id,project_id) REFERENCES design_records(id,project_id),
        FOREIGN KEY(concept_id,project_id) REFERENCES design_concepts(id,project_id)
      );
      CREATE INDEX record_concept_lookup ON record_concepts(project_id,concept_id);
      CREATE TABLE legacy_record_links (
        project_id TEXT NOT NULL, record_id TEXT NOT NULL, reference TEXT NOT NULL, reason TEXT NOT NULL,
        PRIMARY KEY(record_id,reference),
        FOREIGN KEY(record_id,project_id) REFERENCES design_records(id,project_id)
      );
      CREATE TABLE knowledge_changes (
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),
        concept_id TEXT,relationship_id TEXT,record_id TEXT,
        revision INTEGER NOT NULL CHECK(revision>=0),operation TEXT NOT NULL,
        actor TEXT NOT NULL CHECK(actor IN ('manual','proposal','migration')),
        snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),created_at TEXT NOT NULL,
        CHECK((concept_id IS NOT NULL)+(relationship_id IS NOT NULL)+(record_id IS NOT NULL)=1),
        UNIQUE(id,project_id),
        FOREIGN KEY(concept_id,project_id) REFERENCES design_concepts(id,project_id),
        FOREIGN KEY(relationship_id,project_id) REFERENCES design_relationships(id,project_id),
        FOREIGN KEY(record_id,project_id) REFERENCES design_records(id,project_id)
      );
      CREATE UNIQUE INDEX concept_change_revision ON knowledge_changes(concept_id,revision) WHERE concept_id IS NOT NULL;
      CREATE UNIQUE INDEX relationship_change_revision ON knowledge_changes(relationship_id,revision) WHERE relationship_id IS NOT NULL;
      CREATE UNIQUE INDEX record_change_revision ON knowledge_changes(record_id,revision) WHERE record_id IS NOT NULL;
      CREATE TABLE knowledge_sources (
        id TEXT PRIMARY KEY,change_id TEXT NOT NULL,project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('manual','chapter','workshop','proposal','legacy')),
        chapter_id TEXT,chapter_revision INTEGER,conversation_id TEXT REFERENCES conversations(id),
        message_id TEXT REFERENCES messages(id),proposal_id TEXT REFERENCES proposals(id),
        details TEXT NOT NULL DEFAULT '',missing_reason TEXT,created_at TEXT NOT NULL,
        FOREIGN KEY(change_id,project_id) REFERENCES knowledge_changes(id,project_id),
        FOREIGN KEY(chapter_id,chapter_revision,project_id) REFERENCES chapter_revisions(chapter_id,revision,project_id),
        CHECK((chapter_id IS NULL)=(chapter_revision IS NULL)),
        CHECK((kind IN ('manual','legacy') AND chapter_id IS NULL AND conversation_id IS NULL AND message_id IS NULL AND proposal_id IS NULL)
          OR (kind='chapter' AND chapter_id IS NOT NULL AND conversation_id IS NULL AND message_id IS NULL AND proposal_id IS NULL)
          OR (kind='workshop' AND chapter_id IS NULL AND conversation_id IS NOT NULL AND proposal_id IS NULL)
          OR (kind='proposal' AND proposal_id IS NOT NULL AND conversation_id IS NOT NULL AND message_id IS NOT NULL))
      );
      CREATE INDEX knowledge_source_change ON knowledge_sources(change_id);
      CREATE TRIGGER knowledge_changes_no_update BEFORE UPDATE ON knowledge_changes BEGIN SELECT RAISE(ABORT,'Knowledge change evidence is immutable'); END;
      CREATE TRIGGER knowledge_changes_no_delete BEFORE DELETE ON knowledge_changes BEGIN SELECT RAISE(ABORT,'Knowledge change evidence is immutable'); END;
      CREATE TRIGGER knowledge_sources_no_update BEFORE UPDATE ON knowledge_sources BEGIN SELECT RAISE(ABORT,'Knowledge source evidence is immutable'); END;
      CREATE TRIGGER knowledge_sources_no_delete BEFORE DELETE ON knowledge_sources BEGIN SELECT RAISE(ABORT,'Knowledge source evidence is immutable'); END;
      CREATE TRIGGER decision_statement_immutable BEFORE UPDATE OF text,rationale,kind,status,project_id ON design_records
        WHEN OLD.kind='decision' AND (NEW.text<>OLD.text OR NEW.rationale<>OLD.rationale OR NEW.kind<>OLD.kind OR NEW.status<>OLD.status OR NEW.project_id<>OLD.project_id)
        BEGIN SELECT RAISE(ABORT,'Approved decisions must be superseded, not edited'); END;
      CREATE TRIGGER decision_supersession_valid BEFORE UPDATE OF superseded_by ON design_records
        WHEN (OLD.superseded_by IS NOT NULL AND NEW.superseded_by IS NOT OLD.superseded_by)
          OR (NEW.superseded_by IS NOT NULL AND (OLD.kind<>'decision' OR NOT EXISTS (
          SELECT 1 FROM design_records d WHERE d.id=NEW.superseded_by AND d.project_id=OLD.project_id AND d.kind='decision' AND d.status='approved' AND d.superseded_by IS NULL AND d.id<>OLD.id
        ))) BEGIN SELECT RAISE(ABORT,'Invalid decision supersession'); END;
      CREATE TRIGGER knowledge_source_ownership BEFORE INSERT ON knowledge_sources
        WHEN (NEW.conversation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND project_id=NEW.project_id))
          OR (NEW.message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages WHERE id=NEW.message_id AND conversation_id=NEW.conversation_id AND state='complete'))
          OR (NEW.proposal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM proposals p JOIN messages m ON m.id=p.message_id WHERE p.id=NEW.proposal_id AND p.project_id=NEW.project_id AND p.conversation_id=NEW.conversation_id AND p.message_id=NEW.message_id AND p.status='accepted' AND m.role='assistant' AND m.state='complete'))
        BEGIN SELECT RAISE(ABORT,'Knowledge source belongs to another project or is not accepted evidence'); END;
      CREATE TRIGGER relationship_live_endpoints_insert BEFORE INSERT ON design_relationships
        WHEN NEW.retired_at IS NULL AND EXISTS (SELECT 1 FROM design_concepts WHERE id IN (NEW.source_concept_id,NEW.target_concept_id) AND archived_at IS NOT NULL)
        BEGIN SELECT RAISE(ABORT,'Active relationships require live concepts'); END;
      CREATE TRIGGER relationship_live_endpoints_update BEFORE UPDATE ON design_relationships
        WHEN NEW.retired_at IS NULL AND EXISTS (SELECT 1 FROM design_concepts WHERE id IN (NEW.source_concept_id,NEW.target_concept_id) AND archived_at IS NOT NULL)
        BEGIN SELECT RAISE(ABORT,'Active relationships require live concepts'); END;
      CREATE TRIGGER concept_archive_retire_relationships BEFORE UPDATE OF archived_at ON design_concepts
        WHEN NEW.archived_at IS NOT NULL AND EXISTS (SELECT 1 FROM design_relationships WHERE retired_at IS NULL AND (source_concept_id=NEW.id OR target_concept_id=NEW.id))
        BEGIN SELECT RAISE(ABORT,'Retire incident relationships before archiving a concept'); END;
    `);
    for (const row of db.prepare("SELECT * FROM design_records").all()) {
      let references: unknown[] = [];
      try {
        const parsed = JSON.parse(String(row.related_chapter_ids));
        if (Array.isArray(parsed)) references = parsed;
        else references = [parsed];
      } catch {
        references = [String(row.related_chapter_ids)];
      }
      for (const ref of references) {
        const id = typeof ref === "string" ? ref : JSON.stringify(ref);
        const c = db
          .prepare("SELECT project_id FROM chapters WHERE id=?")
          .get(id);
        if (c?.project_id === row.project_id)
          db.prepare("INSERT OR IGNORE INTO record_chapters VALUES(?,?,?)").run(
            row.project_id,
            row.id,
            id,
          );
        else
          db.prepare(
            "INSERT OR IGNORE INTO legacy_record_links VALUES(?,?,?,?)",
          ).run(
            row.project_id,
            row.id,
            id,
            c ? "foreign project" : "missing or invalid chapter",
          );
      }
      const date = new Date().toISOString(),
        changeId = randomUUID();
      // Associations are not provenance. Do not infer an origin from chapter links or similar proposal text.
      db.prepare(
        "INSERT INTO knowledge_changes (id,project_id,record_id,revision,operation,actor,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        changeId,
        row.project_id,
        row.id,
        0,
        "migration_baseline",
        "migration",
        JSON.stringify({
          id: row.id,
          projectId: row.project_id,
          kind: row.kind,
          text: row.text,
          rationale: row.rationale,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.created_at,
          revision: 0,
          supersededBy: null,
          resolution: null,
          resolvedAt: null,
          authoritative: row.kind === "decision" && row.status === "approved",
          relatedChapterIds: db
            .prepare(
              "SELECT chapter_id FROM record_chapters WHERE record_id=? ORDER BY rowid",
            )
            .all(row.id)
            .map((r) => r.chapter_id),
          relatedConceptIds: [],
          unavailableChapterReferences: db
            .prepare(
              "SELECT reference,reason FROM legacy_record_links WHERE record_id=? ORDER BY rowid",
            )
            .all(row.id),
        }),
        date,
      );
      db.prepare(
        "INSERT INTO knowledge_sources(id,change_id,project_id,kind,details,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        randomUUID(),
        changeId,
        row.project_id,
        "legacy",
        "Original source and source revisions were not recorded. Legacy chapter links are associations only.",
        date,
      );
    }
    db.exec("INSERT INTO migrations VALUES(5,datetime('now')); COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
