import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../server/db.js";
import { migrateKnowledgeProposals } from "../server/proposal-migration.js";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";
import { buildContext } from "../server/context.js";
import { answerSchema, openAIAssistant } from "../server/ai.js";
import type { KnowledgePayload } from "../shared/knowledge-proposals.js";
import type { Proposal } from "../shared/types.js";

function fixture(path = ":memory:") {
  const db = openDatabase(path),
    store = new Store(db),
    project = store.createProject(
      "Knowledge fixture",
      "Movement and extraction",
    ),
    chapter = store.chapters(project.id)[0];
  return { db, store, project, chapter };
}
type Fixture = ReturnType<typeof fixture>;
function envelope(knowledge: KnowledgePayload) {
  return {
    kind: "knowledge" as const,
    title: knowledge.action,
    reason: "A deliberate design improvement",
    description: "Review this change",
    knowledge,
  };
}
function offer(f: Fixture, payloads: KnowledgePayload[]) {
  const active = f.store.chapter(f.chapter.id),
    w = f.store.workshop(active.id),
    m = f.store.addMessage(
      w.conversationId,
      "assistant",
      "Here are reviewable suggestions.",
    );
  f.store.knowledgeProposals.addBatch(
    w.conversationId,
    m.id,
    active,
    f.store.knowledge.projectKnowledge(f.project.id, true),
    payloads.map(envelope),
  );
  return f.store
    .workshop(active.id)
    .proposals.filter((p) => p.messageId === m.id);
}
const concept = (
  key = "movement",
  name = "Player Movement",
): KnowledgePayload => ({
  version: 1,
  action: "create_concept",
  key,
  name,
  category: "mechanic",
  description: "Responsive movement",
  chapterIds: [],
});
function accept(
  f: Fixture,
  p: Proposal,
  outcome: "exploring" | "approve" | "accept" = "approve",
) {
  return f.store.reviewProposal(p.id, "accept", undefined, outcome);
}

test("AI concept review requires explicit authority, preserves provenance, and is exactly once", () => {
  const f = fixture();
  try {
    const [p] = offer(f, [
      { ...concept(), chapterIds: [f.chapter.id] } as KnowledgePayload,
    ]);
    assert.equal(f.store.knowledge.concepts(f.project.id).length, 0);
    assert.throws(() => f.store.reviewProposal(p.id, "accept"), /Choose/);
    const accepted = accept(f, p, "exploring"),
      c = f.store.knowledge.concept(f.project.id, accepted.appliedResult!.id);
    assert.equal(c.status, "Exploring");
    assert.equal(c.authoritative, false);
    assert.deepEqual(c.chapterIds, [f.chapter.id]);
    assert.ok(
      c.sources.every(
        (s) =>
          s.kind === "proposal" &&
          s.proposalId === p.id &&
          s.messageId === p.messageId &&
          s.conversationId === p.conversationId &&
          s.chapterRevision === 0,
      ),
    );
    assert.ok(
      f.store.knowledge
        .history(f.project.id, "concept", c.id)
        .every((h) => h.actor === "proposal"),
    );
    assert.throws(() => accept(f, p), /already been reviewed/);
    const [approved] = offer(f, [concept("inventory", "Inventory")]);
    const result = accept(f, approved);
    assert.equal(
      f.store.knowledge.concept(f.project.id, result.appliedResult!.id)
        .authoritative,
      true,
    );
    assert.equal(f.store.chapter(f.chapter.id).revision, 0);
  } finally {
    f.db.close();
  }
});

test("AI updates and chapter associations preserve original approvals and reject stale target/source revisions", () => {
  const f = fixture();
  try {
    let c = f.store.knowledge.createConcept(f.project.id, {
      name: "Movement",
      description: "Original",
    });
    c = f.store.knowledge.approveConcept(f.project.id, c.id, {
      revision: c.revision,
    });
    const [update] = offer(f, [
      {
        version: 1,
        action: "update_concept",
        targetId: c.id,
        revision: c.revision,
        name: c.name,
        category: c.category,
        description: "New direction",
      },
    ]);
    assert.equal(update.knowledge!.before!.description, "Original");
    const accepted = accept(f, update, "exploring");
    c = f.store.knowledge.concept(f.project.id, c.id);
    assert.equal(c.status, "Exploring");
    assert.equal(c.approvedRevision, 1);
    assert.equal(c.description, "New direction");
    const [link] = offer(f, [
      {
        version: 1,
        action: "associate_concept",
        targetId: c.id,
        revision: c.revision,
        chapterIds: [f.chapter.id],
      },
    ]);
    accept(f, link);
    c = f.store.knowledge.concept(f.project.id, c.id);
    assert.equal(c.authoritative, true);
    assert.deepEqual(c.chapterIds, [f.chapter.id]);
    const [stale] = offer(f, [
      {
        version: 1,
        action: "update_concept",
        targetId: c.id,
        revision: c.revision,
        name: c.name,
        category: c.category,
        description: "Old proposal",
      },
    ]);
    f.store.knowledge.updateConcept(f.project.id, c.id, {
      revision: c.revision,
      description: "Newer edit",
    });
    assert.throws(() => accept(f, stale), /changed/);
    const [sourceStale] = offer(f, [concept("combat", "Combat")]);
    f.store.updateChapter(f.chapter.id, {
      revision: 0,
      title: "Changed source",
    });
    assert.throws(() => accept(f, sourceStale), /changed/);
    assert.equal(
      f.store
        .workshop(f.chapter.id)
        .proposals.find((p) => p.id === sourceStale.id)!.status,
      "pending",
    );
    assert.ok(accepted.appliedResult);
  } finally {
    f.db.close();
  }
});

test("dependent relationships require individually accepted concepts and never silently accept prerequisites", () => {
  const f = fixture();
  try {
    const ps = offer(f, [
      concept("inventory", "Inventory"),
      concept("extraction", "Extraction"),
      {
        version: 1,
        action: "create_relationship",
        source: { newConcept: "inventory" },
        target: { newConcept: "extraction" },
        type: "interacts_with",
        rationale: "Carrying capacity shapes return timing",
      },
    ]);
    assert.equal(ps[2].knowledge!.dependencies.length, 2);
    assert.throws(() => accept(f, ps[2]), /prerequisite/);
    assert.equal(f.store.knowledge.concepts(f.project.id).length, 0);
    accept(f, ps[0], "exploring");
    assert.throws(() => accept(f, ps[2]), /prerequisite/);
    accept(f, ps[1]);
    const applied = accept(f, ps[2], "exploring"),
      r = f.store.knowledge.relationship(
        f.project.id,
        applied.appliedResult!.id,
      );
    assert.equal(r.status, "Exploring");
    const [up] = offer(f, [
      {
        version: 1,
        action: "update_relationship",
        targetId: r.id,
        revision: r.revision,
        source: { id: r.sourceConceptId },
        target: { id: r.targetConceptId },
        type: "affects",
        rationale: "A directed effect",
      },
    ]);
    const approved = accept(f, up);
    const current = f.store.knowledge.relationship(f.project.id, r.id);
    assert.equal(current.authoritative, true);
    assert.equal(current.type, "affects");
    const [retire] = offer(f, [
      {
        version: 1,
        action: "retire_relationship",
        targetId: r.id,
        revision: current.revision,
      },
    ]);
    accept(f, retire, "accept");
    assert.ok(f.store.knowledge.relationship(f.project.id, r.id).retiredAt);
    assert.ok(approved.appliedResult);
  } finally {
    f.db.close();
  }
});

test("unknown, duplicate, rejected and changed concept dependencies cannot apply", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        offer(f, [
          {
            version: 1,
            action: "create_relationship",
            source: { newConcept: "missing" },
            target: { newConcept: "other" },
            type: "depends_on",
            rationale: "",
          },
        ]),
      /dependency/,
    );
    assert.throws(() => offer(f, [concept(), concept()]), /already exists/);
    const ps = offer(f, [
      concept("a", "A"),
      concept("b", "B"),
      {
        version: 1,
        action: "create_relationship",
        source: { newConcept: "a" },
        target: { newConcept: "b" },
        type: "interacts_with",
        rationale: "",
      },
    ]);
    f.store.reviewProposal(ps[0].id, "reject");
    accept(f, ps[1]);
    assert.throws(() => accept(f, ps[2]), /prerequisite/);
    assert.equal(f.store.knowledge.relationships(f.project.id).length, 0);
    const next = offer(f, [
      concept("c", "C"),
      {
        version: 1,
        action: "create_relationship",
        source: { newConcept: "c" },
        target: { id: f.store.knowledge.concepts(f.project.id)[0].id },
        type: "affects",
        rationale: "",
      },
    ]);
    const result = accept(f, next[0]);
    const c = f.store.knowledge.concept(f.project.id, result.appliedResult!.id);
    f.store.knowledge.updateConcept(f.project.id, c.id, {
      revision: c.revision,
      description: "Changed",
    });
    assert.throws(() => accept(f, next[1]), /prerequisite concept changed/);
  } finally {
    f.db.close();
  }
});

test("decisions and questions link concepts; explicit supersession and resolution retain history and proposal sources", () => {
  const f = fixture();
  try {
    const c = f.store.knowledge.createConcept(f.project.id, {
      name: "Movement",
    });
    const [d, q] = offer(f, [
      {
        version: 1,
        action: "record_decision",
        text: "Use responsive controls",
        rationale: "Readable action",
        chapterIds: [f.chapter.id],
        concepts: [{ id: c.id }],
      },
      {
        version: 1,
        action: "record_question",
        text: "Should stamina limit movement?",
        rationale: "Pacing",
        chapterIds: [f.chapter.id],
        concepts: [{ id: c.id }],
      },
    ]);
    assert.throws(() => accept(f, d, "exploring"), /explicit approval/);
    const decision = accept(f, d).appliedResult!;
    const question = accept(f, q, "accept").appliedResult!;
    const [supersede, resolve] = offer(f, [
      {
        version: 1,
        action: "supersede_decision",
        targetId: decision.id,
        revision: decision.revision,
        text: "Use precise arcade controls",
        rationale: "Focused responsiveness",
        chapterIds: [f.chapter.id],
        concepts: [{ id: c.id }],
      },
      {
        version: 1,
        action: "resolve_question",
        targetId: question.id,
        revision: question.revision,
        answer: "Stamina limits sprinting only",
      },
    ]);
    const replacement = accept(f, supersede).appliedResult!;
    accept(f, resolve, "accept");
    assert.equal(
      f.store.knowledge.record(f.project.id, decision.id).text,
      "Use responsive controls",
    );
    assert.equal(
      f.store.knowledge.record(f.project.id, decision.id).supersededBy,
      replacement.id,
    );
    assert.equal(
      f.store.knowledge.record(f.project.id, question.id).resolution,
      "Stamina limits sprinting only",
    );
    assert.ok(
      f.store.knowledge
        .history(f.project.id, "record", decision.id)
        .every((h) => h.actor === "proposal"),
    );
    assert.ok(
      f.store.knowledge
        .record(f.project.id, replacement.id)
        .sources.some((s) => s.proposalId === supersede.id),
    );
    assert.deepEqual(
      f.store.knowledge.record(f.project.id, replacement.id).relatedConceptIds,
      [c.id],
    );
    assert.throws(
      () =>
        offer(f, [
          {
            version: 1,
            action: "record_decision",
            text: "Use precise arcade controls",
            rationale: "",
            chapterIds: [],
            concepts: [],
          },
        ]),
      /already exists/,
    );
  } finally {
    f.db.close();
  }
});

test("duplicate and archived/foreign relationships, records and references are rejected", () => {
  const f = fixture();
  try {
    const a = f.store.knowledge.createConcept(f.project.id, { name: "A" }),
      b = f.store.knowledge.createConcept(f.project.id, { name: "B" });
    const r = f.store.knowledge.createRelationship(f.project.id, {
      sourceConceptId: a.id,
      targetConceptId: b.id,
      type: "interacts_with",
    });
    assert.throws(
      () =>
        offer(f, [
          {
            version: 1,
            action: "create_relationship",
            source: { id: b.id },
            target: { id: a.id },
            type: r.type,
            rationale: "",
          },
        ]),
      /already exists/,
    );
    const other = f.store.createProject("Other", "");
    const foreign = f.store.knowledge.createConcept(other.id, {
      name: "Foreign",
    });
    assert.throws(
      () =>
        offer(f, [
          {
            version: 1,
            action: "record_question",
            text: "Q?",
            rationale: "",
            chapterIds: [],
            concepts: [{ id: foreign.id }],
          },
        ]),
      /outside/,
    );
    assert.throws(
      () =>
        offer(f, [
          {
            ...concept("foreign", "Foreign link"),
            chapterIds: [f.store.chapters(other.id)[0].id],
          } as KnowledgePayload,
        ]),
      /another project/,
    );
    const [p] = offer(f, [
      {
        version: 1,
        action: "update_relationship",
        targetId: r.id,
        revision: r.revision,
        source: { id: a.id },
        target: { id: b.id },
        type: "affects",
        rationale: "",
      },
    ]);
    f.store.knowledge.archiveConcept(f.project.id, a.id, {
      revision: a.revision,
    });
    assert.throws(() => accept(f, p), /retired|archived/);
    assert.throws(
      () =>
        offer(f, [
          {
            version: 1,
            action: "update_concept",
            targetId: a.id,
            revision: a.revision + 1,
            name: "A",
            category: "mechanic",
            description: "",
          },
        ]),
      /unavailable/,
    );
  } finally {
    f.db.close();
  }
});

test("evidence failure rolls back entity, approval, result and acceptance and allows a single retry", () => {
  const f = fixture();
  try {
    const [p] = offer(f, [concept()]);
    f.db.exec(
      "CREATE TRIGGER fail_proposal BEFORE INSERT ON knowledge_sources WHEN NEW.kind='proposal' BEGIN SELECT RAISE(ABORT,'Evidence failure'); END;",
    );
    assert.throws(() => accept(f, p), /Evidence failure/);
    assert.equal(f.store.knowledge.concepts(f.project.id).length, 0);
    assert.equal(f.store.workshop(f.chapter.id).proposals[0].status, "pending");
    assert.equal(
      f.store.workshop(f.chapter.id).proposals[0].appliedResult,
      null,
    );
    f.db.exec("DROP TRIGGER fail_proposal");
    f.db.exec(
      "CREATE TRIGGER fail_approval BEFORE INSERT ON knowledge_sources WHEN (SELECT operation FROM knowledge_changes WHERE id=NEW.change_id)='approve' BEGIN SELECT RAISE(ABORT,'Approval evidence failure'); END;",
    );
    assert.throws(() => accept(f, p), /Approval evidence failure/);
    assert.equal(f.store.knowledge.concepts(f.project.id).length, 0);
    assert.equal(f.store.workshop(f.chapter.id).proposals[0].status, "pending");
    f.db.exec(
      "DROP TRIGGER fail_approval; CREATE TRIGGER fail_result BEFORE UPDATE OF applied_result ON proposals WHEN NEW.applied_result IS NOT NULL BEGIN SELECT RAISE(ABORT,'Result persistence failure'); END;",
    );
    assert.throws(() => accept(f, p), /Result persistence failure/);
    assert.equal(f.store.knowledge.concepts(f.project.id).length, 0);
    assert.equal(f.store.workshop(f.chapter.id).proposals[0].status, "pending");
    f.db.exec("DROP TRIGGER fail_result");
    accept(f, p);
    assert.equal(f.store.knowledge.concepts(f.project.id).length, 1);
    assert.throws(() => accept(f, p), /already/);
  } finally {
    f.db.close();
  }
});

test("rejected proposals leave chapter and knowledge snapshots unchanged; forged authority/provenance is invalid", () => {
  const f = fixture();
  try {
    const [p] = offer(f, [concept()]);
    const before = f.store.knowledge.projectKnowledge(f.project.id, true);
    f.store.reviewProposal(p.id, "reject");
    assert.deepEqual(
      f.store.knowledge.projectKnowledge(f.project.id, true),
      before,
    );
    assert.equal(f.store.chapter(f.chapter.id).revision, 0);
    for (const injected of [
      { projectId: f.project.id },
      { status: "Approved" },
      { source: { kind: "manual" } },
      { version: 2 },
    ])
      assert.equal(
        answerSchema.safeParse({
          reply: "Suggestion",
          proposals: [
            envelope({ ...concept(), ...injected } as KnowledgePayload),
          ],
        }).success,
        false,
      );
    assert.throws(
      () => f.store.knowledge.withAcceptedProposal(p.id, () => {}),
      /accepted/,
    );
  } finally {
    f.db.close();
  }
});

test("knowledge proposal dependencies and applied results survive migration and database reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-proposals-")),
    path = join(dir, "fixture.sqlite");
  let f = fixture(path);
  try {
    const ps = offer(f, [
      concept("inventory", "Inventory"),
      concept("extraction", "Extraction"),
      {
        version: 1,
        action: "create_relationship",
        source: { newConcept: "inventory" },
        target: { newConcept: "extraction" },
        type: "depends_on",
        rationale: "Capacity constrains return",
      },
    ]);
    accept(f, ps[0]);
    const projectId = f.project.id,
      chapterId = f.chapter.id;
    f.db.close();
    const db = openDatabase(path),
      store = new Store(db);
    f = {
      db,
      store,
      project: store.project(projectId),
      chapter: store.chapter(chapterId),
    };
    assert.equal(
      store.workshop(chapterId).proposals[0].appliedResult!.entity,
      "concept",
    );
    accept(f, store.workshop(chapterId).proposals[1]);
    accept(f, store.workshop(chapterId).proposals[2]);
    assert.equal(store.knowledge.relationships(projectId).length, 1);
    assert.equal(
      db.prepare("SELECT count(*) n FROM migrations WHERE version=6").get()!.n,
      1,
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE proposals SET knowledge_payload='{}' WHERE id=?")
          .run(ps[0].id),
      /immutable/,
    );
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streamed extraction generates reviewable knowledge and accepted entities are retrieved by the next conversation", async () => {
  const f = fixture();
  let calls = 0;
  const app = createApp(f.store, {
    aiConfigured: true,
    assistant: async (ctx, _signal, onReply) => {
      calls++;
      assert.equal(ctx.project.id, f.project.id);
      assert.ok(!ctx.knowledge?.concepts.some((c) => c.name === "Foreign"));
      if (calls === 1) {
        assert.equal(ctx.workflow, "extract");
        onReply("A movement concept is worth recording.");
        return answerSchema.parse({
          reply: "A movement concept is worth recording.",
          proposals: [
            envelope({
              ...concept(),
              chapterIds: [f.chapter.id],
            } as KnowledgePayload),
          ],
        });
      }
      assert.ok(
        ctx.knowledge?.concepts.some(
          (c) => c.name === "Player Movement" && c.authoritative,
        ),
      );
      return {
        reply: "Your approved movement direction is in context.",
        proposals: [],
      };
    },
  });
  try {
    const other = f.store.createProject("Other", "");
    f.store.knowledge.createConcept(other.id, { name: "Foreign" });
    const response = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: {
        content: "Extract the meaningful movement design",
        workflow: "extract",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes("event: complete"));
    assert.equal(f.store.knowledge.concepts(f.project.id).length, 0);
    const p = f.store.workshop(f.chapter.id).proposals[0];
    const reviewed = await app.inject({
      method: "POST",
      url: `/api/proposals/${p.id}/review`,
      payload: { decision: "accept", outcome: "approve" },
    });
    assert.equal(reviewed.statusCode, 200);
    const knowledge = await app.inject(
      `/api/projects/${f.project.id}/knowledge`,
    );
    assert.equal(knowledge.json().concepts[0].name, "Player Movement");
    await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Discuss our movement concept" },
    });
    assert.equal(calls, 2);
  } finally {
    await app.close();
    f.db.close();
  }
});

test("knowledge context labels historical decisions and speculative edges and keeps complete current instructions", () => {
  const f = fixture();
  try {
    const a = f.store.knowledge.createConcept(f.project.id, {
      name: "Movement",
    });
    f.store.knowledge.setConceptChapters(f.project.id, a.id, {
      revision: a.revision,
      chapterIds: [f.chapter.id],
    });
    const b = f.store.knowledge.createConcept(f.project.id, { name: "Combat" });
    f.store.knowledge.createRelationship(f.project.id, {
      sourceConceptId: a.id,
      targetConceptId: b.id,
      type: "affects",
    });
    const d = f.store.knowledge.createRecord(f.project.id, "decision", {
      text: "Old",
      conceptIds: [a.id],
      chapterIds: [f.chapter.id],
    });
    f.store.knowledge.supersedeDecision(f.project.id, d.id, {
      revision: d.revision,
      text: "New",
    });
    const w = f.store.workshop(f.chapter.id),
      text = "Preserve this opening instruction. " + "x".repeat(15000),
      user = f.store.addMessage(w.conversationId, "user", text);
    const ctx = buildContext(f.store, f.chapter.id, [user], "extract");
    assert.equal(ctx.messages[0].content, text);
    assert.equal(ctx.knowledge!.relationships[0].authoritative, false);
    assert.ok(
      ctx.knowledge!.records.some(
        (r) => r.text === "Old" && !r.authoritative && r.supersededBy,
      ),
    );
    assert.ok(
      ctx.knowledge!.records.some((r) => r.text === "New" && r.authoritative),
    );
  } finally {
    f.db.close();
  }
});

test("real OpenAI adapter sends strict knowledge schema and parses streamed typed proposals with transport fixture", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, input) => {
      const body = JSON.parse(String(input!.body));
      const items =
        body.response_format.json_schema.schema.properties.proposals.items;
      const knowledgeSchema = items.anyOf.find(
        (s: any) => s.properties.kind.enum[0] === "knowledge",
      );
      assert.ok(knowledgeSchema);
      assert.equal(knowledgeSchema.properties.knowledge.anyOf.length, 10);
      assert.ok(body.messages[0].content.includes("newConcept"));
      const result = JSON.stringify({
        reply: "Movement deserves a concept.",
        proposals: [envelope(concept())],
      });
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: result }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
    const result = await openAIAssistant(
      buildContext(f.store, f.chapter.id, []),
      new AbortController().signal,
      () => {},
    );
    assert.equal(result.proposals[0].kind, "knowledge");
  } finally {
    globalThis.fetch = original;
    f.db.close();
  }
});

test("migration 6 preserves version-5 projects, rich chapters, legacy proposals and knowledge; failure rolls back and retries", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-migration6-")),
    path = join(dir, "legacy.sqlite"),
    f = fixture(path);
  let db = f.db;
  try {
    const c = f.store.knowledge.createConcept(f.project.id, {
      name: "Existing concept",
    });
    const w = f.store.workshop(f.chapter.id),
      m = f.store.addMessage(
        w.conversationId,
        "assistant",
        "Legacy suggestion",
      );
    const p = f.store.addProposal(
      w.conversationId,
      m.id,
      f.project.id,
      {
        kind: "create_chapter",
        chapterId: null,
        title: "Existing proposal",
        content: "Legacy prose",
        reason: "Retain this pending proposal",
      },
      null,
    );
    db.exec(
      "DROP TRIGGER proposal_dependency_owner; DROP TRIGGER proposal_payload_immutable; DROP TRIGGER proposal_result_immutable; DROP TABLE proposal_dependencies; ALTER TABLE proposals DROP COLUMN knowledge_payload; ALTER TABLE proposals DROP COLUMN applied_result; DELETE FROM migrations WHERE version=6;",
    );
    db.exec("CREATE TABLE proposal_dependencies (reserved TEXT)");
    assert.throws(() => migrateKnowledgeProposals(db), /already exists/);
    assert.equal(
      db.prepare("SELECT 1 FROM migrations WHERE version=6").get(),
      undefined,
    );
    assert.ok(
      !db
        .prepare("PRAGMA table_info(proposals)")
        .all()
        .some((r) => r.name === "knowledge_payload"),
    );
    db.exec("DROP TABLE proposal_dependencies");
    db.close();
    db = openDatabase(path);
    const store = new Store(db);
    assert.deepEqual(store.chapter(f.chapter.id).content, f.chapter.content);
    assert.equal(store.knowledge.concept(f.project.id, c.id).name, c.name);
    assert.equal(store.workshop(f.chapter.id).proposals[0].id, p.id);
    assert.equal(store.workshop(f.chapter.id).proposals[0].status, "pending");
    assert.equal(store.workshop(f.chapter.id).proposals[0].knowledge, null);
    migrateKnowledgeProposals(db);
    assert.equal(
      db.prepare("SELECT count(*) n FROM migrations WHERE version=6").get()!.n,
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mixed invalid AI batches roll back reply and all proposals, and generation races retain original knowledge snapshots", async () => {
  const f = fixture();
  const c = f.store.knowledge.createConcept(f.project.id, {
    name: "Movement",
    description: "Original",
  });
  let mode = "invalid";
  const app = createApp(f.store, {
    aiConfigured: true,
    assistant: async (ctx) => {
      if (mode === "invalid")
        return answerSchema.parse({
          reply: "Invalid dependency batch",
          proposals: [
            envelope(concept()),
            envelope({
              version: 1,
              action: "create_relationship",
              source: { newConcept: "missing" },
              target: { newConcept: "movement" },
              type: "affects",
              rationale: "",
            }),
          ],
        });
      f.store.knowledge.updateConcept(f.project.id, c.id, {
        revision: c.revision,
        description: "Edited during generation",
      });
      return answerSchema.parse({
        reply: "Captured refinement",
        proposals: [
          envelope({
            version: 1,
            action: "update_concept",
            targetId: c.id,
            revision: ctx.knowledge!.concepts.find((x) => x.id === c.id)!
              .revision,
            name: c.name,
            category: c.category,
            description: "Proposed new content",
          }),
        ],
      });
    },
  });
  try {
    const failed = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Extract" },
    });
    assert.ok(failed.body.includes("event: error"));
    assert.equal(f.store.workshop(f.chapter.id).proposals.length, 0);
    assert.equal(f.store.knowledge.concepts(f.project.id).length, 1);
    mode = "race";
    await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Refine" },
    });
    const p = f.store.workshop(f.chapter.id).proposals[0];
    assert.equal(p.knowledge!.before!.description, "Original");
    assert.throws(() => accept(f, p), /changed/);
    assert.equal(
      f.store.knowledge.concept(f.project.id, c.id).description,
      "Edited during generation",
    );
  } finally {
    await app.close();
    f.db.close();
  }
});
