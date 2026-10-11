import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db.js";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";
import { migrateKnowledge } from "../server/knowledge-migration.js";
import { buildContext } from "../server/context.js";
import {
  normalizedConceptName,
  relationshipTypes,
} from "../shared/knowledge.js";
import { textDoc } from "../shared/types.js";

function fixture(path = ":memory:") {
  const db = openDatabase(path),
    store = new Store(db),
    project = store.createProject("Knowledge fixture", "A design foundation"),
    chapter = store.chapters(project.id)[0];
  return { db, store, project, chapter, k: store.knowledge };
}
function pair(f: ReturnType<typeof fixture>) {
  return [
    f.k.createConcept(f.project.id, { name: "Inventory" }),
    f.k.createConcept(f.project.id, { name: "Extraction" }),
  ];
}
function oldRecord(
  f: ReturnType<typeof fixture>,
  kind: "record_decision" | "record_question",
  content: string,
) {
  const w = f.store.workshop(f.chapter.id),
    m = f.store.addMessage(w.conversationId, "assistant", "Review the record");
  const p = f.store.addProposal(
    w.conversationId,
    m.id,
    f.project.id,
    {
      kind,
      chapterId: f.chapter.id,
      title: "Record",
      content,
      reason: "Design reasoning",
    },
    f.store.chapter(f.chapter.id).revision,
  );
  f.store.reviewProposal(p.id, "accept");
  return { p, record: f.store.records(f.project.id).at(-1)! };
}
function downgradeToV4(f: ReturnType<typeof fixture>) {
  // Reconstruct actual pre-knowledge shapes, preserving the existing rows and milestone-1 tables.
  for (const table of [
    "knowledge_sources",
    "knowledge_changes",
    "legacy_record_links",
    "record_concepts",
    "record_chapters",
    "concept_chapters",
    "design_relationships",
    "design_concepts",
  ])
    f.db.exec(`DROP TABLE ${table}`);
  f.db.exec(
    "DROP TRIGGER decision_statement_immutable; DROP TRIGGER decision_supersession_valid; DROP INDEX record_project_identity; DROP INDEX chapter_revision_project;",
  );
  for (const column of [
    "revision",
    "updated_at",
    "superseded_by",
    "resolution",
    "resolved_at",
  ])
    f.db.exec(`ALTER TABLE design_records DROP COLUMN ${column}`);
  f.db.exec("DELETE FROM migrations WHERE version=5");
}

test("concepts are independent project entities with explicit approval, revisions, and durable lifecycle evidence", () => {
  const f = fixture();
  try {
    f.store.archiveChapter(f.chapter.id, 0);
    let c = f.k.createConcept(f.project.id, {
      name: "Player Movement",
      category: "custom movement category",
      description: "Expressive movement",
    });
    assert.equal(c.projectId, f.project.id);
    assert.equal(c.chapterIds.length, 0);
    assert.equal(c.status, "Exploring");
    assert.equal(c.authoritative, false);
    assert.ok(c.createdAt);
    assert.equal(c.sources[0].kind, "manual");
    c = f.k.approveConcept(f.project.id, c.id, { revision: 0 });
    assert.equal(c.status, "Approved");
    assert.equal(c.approvedRevision, 1);
    assert.equal(c.authoritative, true);
    c = f.k.updateConcept(f.project.id, c.id, {
      revision: 1,
      description: "New movement direction",
    });
    assert.equal(c.status, "Needs Revision");
    assert.equal(c.authoritative, false);
    assert.equal(c.approvedRevision, 1);
    const history = f.k.history(f.project.id, "concept", c.id);
    assert.equal(history[1].snapshot.description, "Expressive movement");
    assert.equal(history[1].snapshot.status, "Approved");
    c = f.k.archiveConcept(f.project.id, c.id, { revision: 2 });
    assert.ok(c.archivedAt);
    assert.equal(f.k.concepts(f.project.id).length, 0);
    c = f.k.restoreConcept(f.project.id, c.id, { revision: 3 });
    assert.equal(c.archivedAt, null);
    assert.equal(c.status, "Needs Revision");
    assert.equal(c.category, "custom movement category");
    assert.equal(f.k.history(f.project.id, "concept", c.id).length, 5);
  } finally {
    f.db.close();
  }
});
test("normalized names prevent exact active duplicates, allow project independence, and reject conflicting restoration", () => {
  const f = fixture();
  try {
    assert.equal(
      normalizedConceptName(" ＰＬＡＹＥＲ   Movement "),
      "player movement",
    );
    const c = f.k.createConcept(f.project.id, { name: "Player Movement" });
    assert.throws(
      () =>
        f.k.createConcept(f.project.id, { name: " ＰＬＡＹＥＲ   movement " }),
      /already exists/,
    );
    const other = f.store.createProject("Other", "");
    assert.ok(f.k.createConcept(other.id, { name: "PLAYER MOVEMENT" }).id);
    const a = f.k.archiveConcept(f.project.id, c.id, { revision: 0 });
    f.k.createConcept(f.project.id, { name: "player movement" });
    assert.throws(
      () => f.k.restoreConcept(f.project.id, c.id, { revision: a.revision }),
      /already exists/,
    );
    assert.ok(f.k.concept(f.project.id, c.id).archivedAt);
    const restored = f.k.restoreConcept(f.project.id, c.id, {
      revision: a.revision,
      name: "Legacy Movement",
    });
    assert.equal(restored.name, "Legacy Movement");
    assert.equal(f.k.concepts(f.project.id, false, "movement").length, 2);
  } finally {
    f.db.close();
  }
});
test("concept-chapter associations are many-to-many and reversible without synchronizing chapter prose", () => {
  const f = fixture();
  try {
    const [a, b] = pair(f),
      second = f.store.createChapter(
        f.project.id,
        "Core Gameplay",
        textDoc("Keep this prose"),
      );
    const chapterBefore = f.store.chapter(f.chapter.id),
      secondBefore = f.store.chapter(second.id);
    let linked = f.k.setConceptChapters(f.project.id, a.id, {
      revision: 0,
      chapterIds: [f.chapter.id, second.id],
    });
    f.k.setConceptChapters(f.project.id, b.id, {
      revision: 0,
      chapterIds: [f.chapter.id],
    });
    assert.deepEqual(linked.chapterIds, [f.chapter.id, second.id]);
    assert.equal(
      f.db
        .prepare("SELECT count(*) n FROM concept_chapters WHERE chapter_id=?")
        .get(f.chapter.id)!.n,
      2,
    );
    assert.deepEqual(f.store.chapter(f.chapter.id), chapterBefore);
    assert.deepEqual(f.store.chapter(second.id), secondBefore);
    linked = f.k.approveConcept(f.project.id, a.id, {
      revision: linked.revision,
    });
    linked = f.k.setConceptChapters(f.project.id, a.id, {
      revision: linked.revision,
      chapterIds: [second.id],
    });
    assert.equal(linked.status, "Needs Revision");
    assert.deepEqual(linked.chapterIds, [second.id]);
    assert.deepEqual(
      f.k.history(f.project.id, "concept", a.id).at(-2)!.snapshot.chapterIds,
      [f.chapter.id, second.id],
    );
    f.store.archiveChapter(second.id, 0);
    assert.deepEqual(f.k.concept(f.project.id, a.id).chapterIds, [second.id]);
    linked = f.k.setConceptChapters(f.project.id, a.id, {
      revision: linked.revision,
      chapterIds: [],
    });
    assert.deepEqual(linked.chapterIds, []);
    assert.throws(
      () =>
        f.k.setConceptChapters(f.project.id, a.id, {
          revision: linked.revision,
          chapterIds: [second.id],
        }),
      /live chapters/,
    );
  } finally {
    f.db.close();
  }
});
test("relationship types have clear directionality, symmetric duplicate prevention, and safe retirement", () => {
  const f = fixture();
  try {
    const [a, b] = pair(f);
    for (const type of relationshipTypes) {
      const r = f.k.createRelationship(f.project.id, {
        sourceConceptId: a.id,
        targetConceptId: b.id,
        type,
      });
      assert.equal(r.authoritative, false);
      assert.throws(
        () =>
          f.k.createRelationship(f.project.id, {
            sourceConceptId: a.id,
            targetConceptId: b.id,
            type,
          }),
        /already exists/,
      );
      if (["interacts_with", "conflicts_with"].includes(type)) {
        assert.ok(r.sourceConceptId < r.targetConceptId);
        assert.throws(
          () =>
            f.k.createRelationship(f.project.id, {
              sourceConceptId: b.id,
              targetConceptId: a.id,
              type,
            }),
          /already exists/,
        );
      } else
        assert.ok(
          f.k.createRelationship(f.project.id, {
            sourceConceptId: b.id,
            targetConceptId: a.id,
            type,
          }).id,
        );
      f.k.retireRelationship(f.project.id, r.id, { revision: 0 });
      const next = f.k.createRelationship(f.project.id, {
        sourceConceptId: a.id,
        targetConceptId: b.id,
        type,
      });
      assert.notEqual(next.id, r.id);
      assert.equal(f.k.history(f.project.id, "relationship", r.id).length, 2);
    }
    assert.throws(
      () =>
        f.k.createRelationship(f.project.id, {
          sourceConceptId: a.id,
          targetConceptId: a.id,
          type: "affects",
        }),
      /itself/,
    );
  } finally {
    f.db.close();
  }
});
test("approved relationships become unreviewed after changes and archival retires edges without resurrection", () => {
  const f = fixture();
  try {
    const [a, b] = pair(f);
    let r = f.k.createRelationship(f.project.id, {
      sourceConceptId: a.id,
      targetConceptId: b.id,
      type: "depends_on",
      rationale: "Capacity limits extraction",
    });
    r = f.k.approveRelationship(f.project.id, r.id, { revision: 0 });
    assert.equal(r.authoritative, true);
    r = f.k.updateRelationship(f.project.id, r.id, {
      revision: 1,
      rationale: "New rationale",
    });
    assert.equal(r.status, "Needs Revision");
    assert.equal(
      f.k.history(f.project.id, "relationship", r.id)[1].snapshot.rationale,
      "Capacity limits extraction",
    );
    const archived = f.k.archiveConcept(f.project.id, a.id, { revision: 0 });
    assert.ok(f.k.relationship(f.project.id, r.id).retiredAt);
    assert.equal(f.k.relationships(f.project.id).length, 0);
    assert.equal(
      f.k.history(f.project.id, "relationship", r.id)[0].operation,
      "retire_for_concept_archive",
    );
    assert.throws(
      () =>
        f.k.createRelationship(f.project.id, {
          sourceConceptId: a.id,
          targetConceptId: b.id,
          type: "affects",
        }),
      /archived/,
    );
    f.k.restoreConcept(f.project.id, a.id, { revision: archived.revision });
    assert.equal(f.k.relationships(f.project.id).length, 0);
    assert.equal(f.k.relationship(f.project.id, r.id).authoritative, false);
  } finally {
    f.db.close();
  }
});
test("ownership and revision checks reject foreign concepts, chapters, relationships and sources", () => {
  const f = fixture();
  try {
    const [a, b] = pair(f),
      other = f.store.createProject("Other", "");
    const foreign = f.k.createConcept(other.id, { name: "Foreign" }),
      foreignChapter = f.store.chapters(other.id)[0];
    const r = f.k.createRelationship(f.project.id, {
      sourceConceptId: a.id,
      targetConceptId: b.id,
      type: "affects",
    });
    for (const action of [
      () => f.k.concept(other.id, a.id),
      () => f.k.updateConcept(other.id, a.id, { revision: 0, name: "Wrong" }),
      () => f.k.approveConcept(other.id, a.id, { revision: 0 }),
      () => f.k.archiveConcept(other.id, a.id, { revision: 0 }),
      () => f.k.restoreConcept(other.id, a.id, { revision: 0 }),
      () => f.k.relationship(other.id, r.id),
      () =>
        f.k.updateRelationship(other.id, r.id, {
          revision: 0,
          rationale: "Wrong",
        }),
    ])
      assert.throws(action, /not found/);
    assert.throws(
      () =>
        f.k.setConceptChapters(f.project.id, a.id, {
          revision: 0,
          chapterIds: [foreignChapter.id],
        }),
      /another project/,
    );
    assert.throws(
      () =>
        f.k.createRelationship(f.project.id, {
          sourceConceptId: a.id,
          targetConceptId: foreign.id,
          type: "affects",
        }),
      /not found/,
    );
    assert.throws(
      () =>
        f.k.createConcept(f.project.id, {
          name: "Wrong source",
          source: {
            kind: "chapter",
            chapterId: foreignChapter.id,
            revision: 0,
          },
        }),
      /another project/,
    );
    const before = f.k.history(f.project.id, "concept", a.id);
    f.k.updateConcept(f.project.id, a.id, { revision: 0, description: "New" });
    for (const action of [
      () =>
        f.k.updateConcept(f.project.id, a.id, { revision: 0, name: "Wrong" }),
      () => f.k.approveConcept(f.project.id, a.id, { revision: 0 }),
      () => f.k.archiveConcept(f.project.id, a.id, { revision: 0 }),
      () =>
        f.k.setConceptChapters(f.project.id, a.id, {
          revision: 0,
          chapterIds: [],
        }),
    ])
      assert.throws(action, /changed elsewhere/);
    assert.equal(
      f.k.history(f.project.id, "concept", a.id).length,
      before.length + 1,
    );
  } finally {
    f.db.close();
  }
});
test("approved decisions retain identity and statements, are superseded atomically, and leave chapter content unchanged", () => {
  const f = fixture();
  try {
    const [a] = pair(f),
      chapterBefore = f.store.chapter(f.chapter.id);
    const d = f.k.createRecord(f.project.id, "decision", {
      text: "Cooperative game",
      rationale: "Shared goals",
      chapterIds: [f.chapter.id],
      conceptIds: [a.id],
    });
    assert.equal(d.authoritative, true);
    assert.equal(d.status, "approved");
    assert.throws(
      () =>
        f.db
          .prepare("UPDATE design_records SET text='Silent rewrite' WHERE id=?")
          .run(d.id),
      /superseded/,
    );
    assert.throws(
      () =>
        f.db
          .prepare(
            "UPDATE design_records SET rationale='Silent rewrite' WHERE id=?",
          )
          .run(d.id),
      /superseded/,
    );
    const result = f.k.supersedeDecision(f.project.id, d.id, {
      revision: 0,
      text: "Solo game",
      rationale: "Focused experience",
    });
    assert.notEqual(result.replacement.id, d.id);
    assert.equal(result.previous.text, d.text);
    assert.equal(result.previous.rationale, d.rationale);
    assert.equal(result.previous.authoritative, false);
    assert.equal(result.previous.supersededBy, result.replacement.id);
    assert.throws(
      () =>
        f.db
          .prepare("UPDATE design_records SET superseded_by=NULL WHERE id=?")
          .run(d.id),
      /Invalid decision supersession/,
    );
    assert.equal(result.replacement.authoritative, true);
    assert.deepEqual(result.replacement.relatedConceptIds, [a.id]);
    assert.deepEqual(
      f.k.history(f.project.id, "record", d.id)[1].snapshot.text,
      d.text,
    );
    assert.throws(
      () =>
        f.k.supersedeDecision(f.project.id, d.id, {
          revision: 1,
          text: "Again",
        }),
      /current approved/,
    );
    const ctx = buildContext(f.store, f.chapter.id, []);
    assert.equal(ctx.records.filter((r) => r.kind === "decision").length, 1);
    assert.equal(ctx.records[0].id, result.replacement.id);
    assert.deepEqual(f.store.chapter(f.chapter.id), chapterBefore);
    assert.equal(f.k.projectKnowledge(f.project.id).records.length, 1);
    assert.equal(f.k.projectKnowledge(f.project.id, true).records.length, 2);
  } finally {
    f.db.close();
  }
});
test("record links have normalized ownership checks, stale protection, and historical associations", () => {
  const f = fixture();
  try {
    const [a, b] = pair(f),
      other = f.store.createProject("Other", "");
    const foreign = f.k.createConcept(other.id, { name: "Foreign" });
    const d = f.k.createRecord(f.project.id, "decision", {
      text: "A decision",
      conceptIds: [a.id],
      chapterIds: [f.chapter.id],
    });
    const linked = f.k.setRecordLinks(f.project.id, d.id, {
      revision: 0,
      chapterIds: [],
      conceptIds: [b.id],
    });
    assert.deepEqual(linked.relatedConceptIds, [b.id]);
    assert.deepEqual(linked.relatedChapterIds, []);
    assert.equal(linked.text, d.text);
    assert.equal(linked.authoritative, true);
    assert.deepEqual(
      f.k.history(f.project.id, "record", d.id)[1].snapshot.relatedConceptIds,
      [a.id],
    );
    assert.throws(
      () =>
        f.k.setRecordLinks(f.project.id, d.id, {
          revision: 0,
          chapterIds: [],
          conceptIds: [],
        }),
      /changed elsewhere/,
    );
    assert.throws(
      () =>
        f.k.setRecordLinks(f.project.id, d.id, {
          revision: 1,
          chapterIds: [],
          conceptIds: [foreign.id],
        }),
      /not found/,
    );
    const archived = f.k.archiveConcept(f.project.id, a.id, { revision: 0 });
    assert.ok(archived.archivedAt);
    assert.throws(
      () =>
        f.k.setRecordLinks(f.project.id, d.id, {
          revision: 1,
          chapterIds: [],
          conceptIds: [a.id],
        }),
      /live concepts/,
    );
    assert.deepEqual(f.k.record(f.project.id, d.id), linked);
  } finally {
    f.db.close();
  }
});
test("questions retain resolution history, reopen explicitly, and never generate decisions", () => {
  const f = fixture();
  try {
    const q = f.k.createRecord(f.project.id, "question", {
      text: "What sets capacity?",
      rationale: "Affects difficulty",
    });
    const r = f.k.resolveQuestion(f.project.id, q.id, {
      revision: 0,
      answer: "Backpack upgrades",
    });
    assert.equal(r.status, "resolved");
    assert.equal(r.resolution, "Backpack upgrades");
    assert.ok(r.resolvedAt);
    assert.throws(
      () =>
        f.k.resolveQuestion(f.project.id, q.id, {
          revision: 0,
          answer: "Wrong",
        }),
      /changed elsewhere/,
    );
    const opened = f.k.reopenQuestion(f.project.id, q.id, { revision: 1 });
    assert.equal(opened.status, "open");
    assert.equal(opened.resolution, null);
    const again = f.k.resolveQuestion(f.project.id, q.id, {
      revision: 2,
      answer: "Fixed capacity",
    });
    assert.equal(again.resolution, "Fixed capacity");
    assert.equal(
      f.k.history(f.project.id, "record", q.id)[2].snapshot.resolution,
      "Backpack upgrades",
    );
    assert.equal(
      f.store.records(f.project.id).some((r) => r.kind === "decision"),
      false,
    );
    const d = f.k.createRecord(f.project.id, "decision", {
      text: "Explicit decision",
    });
    assert.throws(
      () =>
        f.k.resolveQuestion(f.project.id, d.id, {
          revision: 0,
          answer: "Wrong",
        }),
      /open question/,
    );
    assert.throws(
      () => f.k.reopenQuestion(f.project.id, d.id, { revision: 0 }),
      /resolved question/,
    );
  } finally {
    f.db.close();
  }
});
test("backend citations verify exact chapters and Workshop ownership, distinguish historical evidence and reject provenance forgery", () => {
  const f = fixture();
  try {
    const sourced = f.k.createConcept(f.project.id, {
      name: "Sourced",
      source: { kind: "chapter", chapterId: f.chapter.id, revision: 0 },
    });
    assert.equal(sourced.sources[0].chapterRevision, 0);
    assert.equal(sourced.sources[0].availability, "available");
    f.store.updateChapter(f.chapter.id, {
      revision: 0,
      content: textDoc("New prose"),
    });
    assert.equal(
      f.k.concept(f.project.id, sourced.id).sources[0].availability,
      "historical",
    );
    const w = f.store.workshop(f.chapter.id),
      m = f.store.addMessage(w.conversationId, "user", "Discuss capacity");
    const c = f.k.createConcept(f.project.id, {
      name: "Discussed",
      source: {
        kind: "workshop",
        conversationId: w.conversationId,
        messageId: m.id,
      },
    });
    assert.equal(c.sources[0].messageId, m.id);
    assert.equal(f.k.history(f.project.id, "concept", c.id)[0].actor, "manual");
    assert.equal(c.authoritative, false);
    const failed = f.store.addMessage(
      w.conversationId,
      "assistant",
      "Partial",
      "failed",
    );
    assert.throws(
      () =>
        f.k.createConcept(f.project.id, {
          name: "Invalid source",
          source: {
            kind: "workshop",
            conversationId: w.conversationId,
            messageId: failed.id,
          },
        }),
      /complete/,
    );
    assert.throws(
      () =>
        f.k.createConcept(f.project.id, {
          name: "Invalid revision",
          source: { kind: "chapter", chapterId: f.chapter.id, revision: 999 },
        }),
      /not found/,
    );
    const other = f.store.createProject("Other", "");
    const fw = f.store.workshop(f.store.chapters(other.id)[0].id);
    assert.throws(
      () =>
        f.k.createConcept(f.project.id, {
          name: "Foreign conversation",
          source: { kind: "workshop", conversationId: fw.conversationId },
        }),
      /another project/,
    );
    assert.throws(() =>
      f.k.createConcept(f.project.id, {
        name: "Forged",
        source: { kind: "proposal", proposalId: m.id } as any,
      }),
    );
    assert.throws(() =>
      f.k.createConcept(f.project.id, {
        name: "Forged",
        source: { kind: "manual", proposalId: m.id } as any,
      }),
    );
    f.store.archiveChapter(f.chapter.id, 1);
    assert.equal(
      f.k.concept(f.project.id, c.id).sources[0].availability,
      "historical",
    );
  } finally {
    f.db.close();
  }
});
test("existing accepted record proposals gain verified provenance exactly once; rejection produces no record", () => {
  const f = fixture();
  try {
    const { p, record } = oldRecord(f, "record_decision", "A binding choice");
    assert.equal(record.sources[0].kind, "proposal");
    assert.equal(record.sources[0].proposalId, p.id);
    assert.equal(record.sources[0].chapterRevision, 0);
    assert.equal(record.sources[0].messageId, p.messageId);
    assert.equal(
      f.k.history(f.project.id, "record", record.id)[0].actor,
      "proposal",
    );
    assert.throws(() => f.k.createRecordFromProposal(p.id), /already created/);
    const w = f.store.workshop(f.chapter.id),
      m = f.store.addMessage(w.conversationId, "assistant", "An alternative");
    const pending = f.store.addProposal(
      w.conversationId,
      m.id,
      f.project.id,
      {
        kind: "record_question",
        chapterId: f.chapter.id,
        title: "Question",
        content: "Why?",
        reason: "Uncertainty",
      },
      0,
    );
    assert.throws(() => f.k.createRecordFromProposal(pending.id), /accepted/);
    f.store.reviewProposal(pending.id, "reject");
    assert.equal(f.store.records(f.project.id).length, 1);
    f.store.archiveChapter(f.chapter.id, 0);
    assert.equal(f.k.record(f.project.id, record.id).authoritative, true);
    assert.equal(
      f.k.record(f.project.id, record.id).sources[0].availability,
      "historical",
    );
  } finally {
    f.db.close();
  }
});
test("multi-record changes, archive cascades and associations roll back on evidence failure", () => {
  const f = fixture();
  try {
    const [a, b] = pair(f),
      d = f.k.createRecord(f.project.id, "decision", { text: "Keep choice" });
    const r = f.k.createRelationship(f.project.id, {
      sourceConceptId: a.id,
      targetConceptId: b.id,
      type: "depends_on",
    });
    const before = f.k.projectKnowledge(f.project.id, true);
    f.db.exec(
      "CREATE TRIGGER fail_supersede BEFORE INSERT ON knowledge_changes WHEN NEW.operation='supersede' BEGIN SELECT RAISE(ABORT,'Simulated evidence failure'); END;",
    );
    assert.throws(
      () =>
        f.k.supersedeDecision(f.project.id, d.id, {
          revision: 0,
          text: "Replacement",
        }),
      /Simulated/,
    );
    assert.deepEqual(f.k.projectKnowledge(f.project.id, true), before);
    f.db.exec(
      "DROP TRIGGER fail_supersede; CREATE TRIGGER fail_archive BEFORE INSERT ON knowledge_changes WHEN NEW.operation='archive' BEGIN SELECT RAISE(ABORT,'Simulated archive failure'); END;",
    );
    assert.throws(
      () => f.k.archiveConcept(f.project.id, a.id, { revision: 0 }),
      /Simulated/,
    );
    assert.equal(f.k.relationship(f.project.id, r.id).retiredAt, null);
    assert.equal(f.k.concept(f.project.id, a.id).archivedAt, null);
    f.db.exec(
      "DROP TRIGGER fail_archive; CREATE TRIGGER fail_links BEFORE INSERT ON knowledge_sources BEGIN SELECT RAISE(ABORT,'Simulated source failure'); END;",
    );
    assert.throws(
      () =>
        f.k.setConceptChapters(f.project.id, a.id, {
          revision: 0,
          chapterIds: [f.chapter.id],
        }),
      /Simulated/,
    );
    assert.equal(f.k.concept(f.project.id, a.id).revision, 0);
    assert.equal(f.k.concept(f.project.id, a.id).chapterIds.length, 0);
    f.db.exec("DROP TRIGGER fail_links");
    assert.deepEqual(f.k.projectKnowledge(f.project.id, true), before);
  } finally {
    f.db.close();
  }
});
test("SQL integrity guards preserve immutable evidence, same-project associations and live relationships", () => {
  const f = fixture();
  try {
    const [a, b] = pair(f),
      other = f.store.createProject("Other", "");
    const foreign = f.store.chapters(other.id)[0];
    const r = f.k.createRelationship(f.project.id, {
      sourceConceptId: a.id,
      targetConceptId: b.id,
      type: "affects",
    });
    assert.throws(
      () =>
        f.db
          .prepare("INSERT INTO concept_chapters VALUES(?,?,?)")
          .run(f.project.id, a.id, foreign.id),
      /FOREIGN KEY/,
    );
    assert.throws(
      () =>
        f.db
          .prepare("UPDATE design_concepts SET archived_at='now' WHERE id=?")
          .run(a.id),
      /Retire/,
    );
    for (const table of ["knowledge_changes", "knowledge_sources"]) {
      assert.throws(
        () => f.db.exec(`UPDATE ${table} SET created_at='tampered'`),
        /immutable/,
      );
      assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable/);
    }
    const archived = f.k.archiveConcept(f.project.id, a.id, { revision: 0 });
    assert.ok(archived.archivedAt);
    assert.throws(
      () =>
        f.db
          .prepare("UPDATE design_relationships SET retired_at=NULL WHERE id=?")
          .run(r.id),
      /live concepts/,
    );
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    f.db.close();
  }
});
test("migration 5 preserves milestone-1 data and legacy records, normalizes valid links and marks unknown or missing evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-knowledge-migration-")),
    path = join(dir, "legacy.sqlite");
  let f = fixture(path);
  try {
    const { p, record: d } = oldRecord(
        f,
        "record_decision",
        "Preserve this decision",
      ),
      { record: q } = oldRecord(
        f,
        "record_question",
        "Unanswered legacy question",
      );
    const other = f.store.createProject("Other", "");
    const foreign = f.store.chapters(other.id)[0];
    const history = f.store.history(f.chapter.id),
      workshop = f.store.workshop(f.chapter.id),
      chapter = f.store.chapter(f.chapter.id);
    downgradeToV4(f);
    const rawLinks = JSON.stringify([
      f.chapter.id,
      "missing-chapter",
      foreign.id,
    ]);
    f.db
      .prepare("UPDATE design_records SET related_chapter_ids=? WHERE id=?")
      .run(rawLinks, d.id);
    f.db
      .prepare("UPDATE design_records SET status='resolved' WHERE id=?")
      .run(q.id);
    f.db.close();
    const db = openDatabase(path),
      store = new Store(db);
    f = { ...f, db, store, k: store.knowledge };
    assert.deepEqual(f.store.chapter(f.chapter.id), chapter);
    assert.deepEqual(f.store.history(f.chapter.id), history);
    const migrated = f.store.records(f.project.id);
    assert.equal(migrated[0].id, d.id);
    assert.equal(migrated[0].text, d.text);
    assert.equal(migrated[0].authoritative, true);
    assert.deepEqual(migrated[0].relatedChapterIds, [f.chapter.id]);
    assert.equal(migrated[0].unavailableChapterReferences.length, 2);
    assert.equal(migrated[0].sources[0].kind, "legacy");
    assert.equal(migrated[0].sources[0].availability, "unknown");
    assert.equal(migrated[0].sources[0].proposalId, null);
    assert.equal(migrated[1].status, "resolved");
    assert.equal(migrated[1].resolution, null);
    assert.equal(migrated[1].resolvedAt, null);
    assert.equal(
      db
        .prepare("SELECT related_chapter_ids FROM design_records WHERE id=?")
        .get(d.id)!.related_chapter_ids,
      rawLinks,
    );
    assert.deepEqual(
      f.store.workshop(f.chapter.id).messages,
      workshop.messages,
    );
    assert.equal(f.store.workshop(f.chapter.id).proposals[0].id, p.id);
    const after = f.k.projectKnowledge(f.project.id, true),
      evidence = f.k.history(f.project.id, "record", d.id);
    assert.equal(evidence[0].snapshot.projectId, f.project.id);
    assert.deepEqual(evidence[0].snapshot.relatedChapterIds, [f.chapter.id]);
    assert.equal(evidence[0].snapshot.text, d.text);
    f.db.close();
    const reopened = openDatabase(path),
      reopenedStore = new Store(reopened);
    f = {
      ...f,
      db: reopened,
      store: reopenedStore,
      k: reopenedStore.knowledge,
    };
    assert.deepEqual(f.k.projectKnowledge(f.project.id, true), after);
    assert.deepEqual(f.k.history(f.project.id, "record", d.id), evidence);
    assert.equal(reopened.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true });
  }
});
test("migration failure rolls back its schema changes and can be retried without losing records", () => {
  const f = fixture();
  try {
    const { record } = oldRecord(f, "record_decision", "Keep legacy statement");
    downgradeToV4(f);
    f.db.exec("CREATE TABLE design_concepts(unexpected TEXT)");
    assert.throws(() => migrateKnowledge(f.db), /already exists/);
    assert.equal(
      f.db.prepare("SELECT version FROM migrations WHERE version=5").get(),
      undefined,
    );
    assert.equal(
      f.db
        .prepare("PRAGMA table_info(design_records)")
        .all()
        .some((r) => r.name === "revision"),
      false,
    );
    assert.equal(
      f.db.prepare("SELECT text FROM design_records WHERE id=?").get(record.id)!
        .text,
      record.text,
    );
    f.db.exec("DROP TABLE design_concepts");
    migrateKnowledge(f.db);
    assert.equal(f.store.records(f.project.id)[0].id, record.id);
  } finally {
    f.db.close();
  }
});
test("project knowledge, decision supersession and question history recover after database reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-knowledge-restart-")),
    path = join(dir, "fixture.sqlite");
  let f = fixture(path);
  try {
    const [a, b] = pair(f);
    f.k.setConceptChapters(f.project.id, a.id, {
      revision: 0,
      chapterIds: [f.chapter.id],
    });
    const r = f.k.createRelationship(f.project.id, {
      sourceConceptId: a.id,
      targetConceptId: b.id,
      type: "interacts_with",
    });
    f.k.approveRelationship(f.project.id, r.id, { revision: 0 });
    const d = f.k.createRecord(f.project.id, "decision", {
      text: "Old choice",
      conceptIds: [a.id],
    });
    f.k.supersedeDecision(f.project.id, d.id, {
      revision: 0,
      text: "New choice",
    });
    const q = f.k.createRecord(f.project.id, "question", {
      text: "What sets capacity?",
      chapterIds: [f.chapter.id],
      source: { kind: "chapter", chapterId: f.chapter.id, revision: 0 },
    });
    f.k.resolveQuestion(f.project.id, q.id, {
      revision: 0,
      answer: "Fixed capacity",
    });
    f.k.reopenQuestion(f.project.id, q.id, { revision: 1 });
    const before = f.k.projectKnowledge(f.project.id, true),
      questionHistory = f.k.history(f.project.id, "record", q.id);
    f.db.close();
    const db = openDatabase(path),
      store = new Store(db);
    f = { ...f, db, store, k: store.knowledge };
    assert.deepEqual(f.k.projectKnowledge(f.project.id, true), before);
    assert.deepEqual(
      f.k.history(f.project.id, "record", q.id),
      questionHistory,
    );
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true });
  }
});
test("knowledge API validates payloads and revision gates, blocks project leakage and disallows forged approval or sources", async () => {
  const f = fixture(),
    app = createApp(f.store, { aiConfigured: false });
  try {
    const base = `/api/projects/${f.project.id}`,
      created = await app.inject({
        method: "POST",
        url: `${base}/concepts`,
        payload: { name: "Inventory" },
      });
    assert.equal(created.statusCode, 200);
    const c = created.json();
    const other = f.store.createProject("Other", "");
    assert.equal(
      (await app.inject(`/api/projects/${other.id}/concepts/${c.id}`))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `${base}/concepts`,
          payload: { name: "Wrong", status: "Approved" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `${base}/concepts`,
          payload: {
            name: "Forged",
            source: { kind: "proposal", proposalId: c.id },
          },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `${base}/concepts/${c.id}`,
          payload: { description: "Missing revision" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `${base}/concepts/${c.id}/approve`,
          payload: { revision: 0 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `${base}/concepts/${c.id}`,
          payload: { revision: 0, description: "Stale" },
        })
      ).statusCode,
      409,
    );
    const q = f.k.createRecord(f.project.id, "question", { text: "Why?" });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `${base}/questions/${q.id}/resolve`,
          payload: {},
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `${base}/questions/${q.id}/resolve`,
          payload: { revision: 0, answer: "Because" },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `${base}/questions/${q.id}/reopen`,
          payload: { revision: 1 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject(`${base}/knowledge?includeHistorical=banana`))
        .statusCode,
      400,
    );
    assert.equal(
      (await app.inject(`${base}/concepts?q=inven`)).json()[0].id,
      c.id,
    );
    assert.equal(
      (await app.inject(`${base}/concepts/${c.id}/history`)).json().length,
      2,
    );
  } finally {
    await app.close();
    f.db.close();
  }
});
test("real HTTP workflow creates, approves, associates and retrieves knowledge while preserving the conversation-review path", async () => {
  const f = fixture(),
    app = createApp(f.store, {
      aiConfigured: true,
      assistant: async (ctx) => ({
        reply: "A reviewable choice",
        proposals: [
          {
            kind: "record_decision",
            chapterId: ctx.active.id,
            title: "Cooperative",
            content: "Cooperative extraction",
            reason: "Shared goals",
          },
        ],
      }),
    });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(address + path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const base = `/api/projects/${f.project.id}`;
    const a = await request(`${base}/concepts`, "POST", { name: "Inventory" }),
      b = await request(`${base}/concepts`, "POST", { name: "Extraction" });
    await request(`${base}/concepts/${a.id}/chapters`, "PUT", {
      revision: 0,
      chapterIds: [f.chapter.id],
    });
    await request(`${base}/concepts/${a.id}/approve`, "POST", { revision: 1 });
    const rel = await request(`${base}/relationships`, "POST", {
      sourceConceptId: a.id,
      targetConceptId: b.id,
      type: "interacts_with",
      rationale: "Capacity affects extraction",
    });
    await request(`${base}/relationships/${rel.id}/approve`, "POST", {
      revision: 0,
    });
    const chat = await fetch(`${address}/api/chapters/${f.chapter.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Record a choice" }),
    });
    assert.match(await chat.text(), /event: complete/);
    const w = await request(`/api/chapters/${f.chapter.id}/workshop`),
      p = w.proposals[0];
    await request(`/api/proposals/${p.id}/review`, "POST", {
      decision: "accept",
    });
    const records = await request(`${base}/records`),
      d = records[0];
    await request(`${base}/records/${d.id}/links`, "PUT", {
      revision: 0,
      chapterIds: [f.chapter.id],
      conceptIds: [a.id, b.id],
    });
    const replaced = await request(
      `${base}/decisions/${d.id}/supersede`,
      "POST",
      { revision: 1, text: "Solo extraction", rationale: "New direction" },
    );
    const knowledge = await request(`${base}/knowledge`);
    assert.equal(knowledge.concepts[0].authoritative, true);
    assert.equal(knowledge.relationships[0].authoritative, true);
    assert.equal(knowledge.records.length, 1);
    assert.equal(knowledge.records[0].id, replaced.replacement.id);
    const historical = await request(
      `${base}/knowledge?includeHistorical=true`,
    );
    assert.equal(historical.records.length, 2);
    const history = await request(`${base}/records/${d.id}/history`);
    assert.equal(history.at(-1).sources[0].proposalId, p.id);
    const q = await request(`${base}/questions`, "POST", {
      text: "What sets capacity?",
      conceptIds: [a.id],
    });
    await request(`${base}/questions/${q.id}/resolve`, "POST", {
      revision: 0,
      answer: "Backpack upgrades",
    });
    await request(`${base}/questions/${q.id}/reopen`, "POST", { revision: 1 });
    const answers = await request(`${base}/records/${q.id}/history`);
    assert.equal(answers[1].snapshot.resolution, "Backpack upgrades");
  } finally {
    await app.close();
    f.db.close();
  }
});

test("accepted-record provenance failure rolls back acceptance and permits exactly one successful retry", () => {
  const f = fixture();
  try {
    const w = f.store.workshop(f.chapter.id),
      m = f.store.addMessage(w.conversationId, "assistant", "Record a choice");
    const p = f.store.addProposal(
      w.conversationId,
      m.id,
      f.project.id,
      {
        kind: "record_decision",
        chapterId: f.chapter.id,
        title: "Decision",
        content: "Keep choice",
        reason: "Reason",
      },
      0,
    );
    f.db.exec(
      "CREATE TRIGGER fail_record_source BEFORE INSERT ON knowledge_sources BEGIN SELECT RAISE(ABORT,'Simulated record provenance failure'); END;",
    );
    assert.throws(() => f.store.reviewProposal(p.id, "accept"), /Simulated/);
    assert.equal(f.store.workshop(f.chapter.id).proposals[0].status, "pending");
    assert.equal(f.store.records(f.project.id).length, 0);
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM knowledge_changes").get()!.n,
      0,
    );
    f.db.exec("DROP TRIGGER fail_record_source");
    f.store.reviewProposal(p.id, "accept");
    assert.equal(f.store.records(f.project.id).length, 1);
    assert.equal(f.store.records(f.project.id)[0].sources[0].proposalId, p.id);
    assert.throws(
      () => f.store.reviewProposal(p.id, "accept"),
      /already been reviewed/,
    );
  } finally {
    f.db.close();
  }
});
test("all relationship and record lifecycle mutations reject stale revisions and cross-project ownership", () => {
  const f = fixture();
  try {
    const [a, b] = pair(f),
      other = f.store.createProject("Other", "");
    const r = f.k.createRelationship(f.project.id, {
      sourceConceptId: a.id,
      targetConceptId: b.id,
      type: "part_of",
    });
    f.k.updateRelationship(f.project.id, r.id, {
      revision: 0,
      rationale: "New",
    });
    for (const operation of [
      () =>
        f.k.updateRelationship(f.project.id, r.id, {
          revision: 0,
          rationale: "Stale",
        }),
      () => f.k.approveRelationship(f.project.id, r.id, { revision: 0 }),
      () => f.k.retireRelationship(f.project.id, r.id, { revision: 0 }),
    ])
      assert.throws(operation, /changed elsewhere/);
    for (const operation of [
      () => f.k.approveRelationship(other.id, r.id, { revision: 1 }),
      () => f.k.retireRelationship(other.id, r.id, { revision: 1 }),
    ])
      assert.throws(operation, /not found/);
    const d = f.k.createRecord(f.project.id, "decision", { text: "Choice" }),
      q = f.k.createRecord(f.project.id, "question", { text: "Why?" });
    const resolved = f.k.resolveQuestion(f.project.id, q.id, {
      revision: 0,
      answer: "Reason",
    });
    assert.throws(
      () => f.k.reopenQuestion(f.project.id, q.id, { revision: 0 }),
      /changed elsewhere/,
    );
    assert.throws(
      () => f.k.reopenQuestion(other.id, q.id, { revision: resolved.revision }),
      /not found/,
    );
    assert.throws(
      () =>
        f.k.resolveQuestion(other.id, q.id, {
          revision: resolved.revision,
          answer: "Wrong",
        }),
      /not found/,
    );
    assert.throws(
      () =>
        f.k.supersedeDecision(other.id, d.id, { revision: 0, text: "Wrong" }),
      /not found/,
    );
    f.k.setRecordLinks(f.project.id, d.id, {
      revision: 0,
      chapterIds: [],
      conceptIds: [a.id],
    });
    assert.throws(
      () =>
        f.k.supersedeDecision(f.project.id, d.id, {
          revision: 0,
          text: "Stale",
        }),
      /changed elsewhere/,
    );
    f.k.archiveConcept(f.project.id, a.id, { revision: 0 });
    assert.throws(
      () => f.k.restoreConcept(f.project.id, a.id, { revision: 0 }),
      /changed elsewhere/,
    );
    assert.equal(f.k.record(f.project.id, d.id).text, "Choice");
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    f.db.close();
  }
});
