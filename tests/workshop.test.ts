import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db.js";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";
import { buildContext } from "../server/context.js";
import { answerSchema, type Answer } from "../server/ai.js";
import { docText, textDoc, type Doc } from "../shared/types.js";
import { lineDiff } from "../shared/diff.js";
import { canonicalOffer } from "./fixtures/document-offer.js";
import { documentExcerpt } from "../shared/document-context.js";
function setup(path = ":memory:") {
  const db = openDatabase(path),
    store = new Store(db),
    project = store.createProject("Salvage", "Quiet exploration"),
    chapter = store.chapters(project.id)[0];
  return { db, store, project, chapter };
}
function offer(
  f: ReturnType<typeof setup>,
  change: Partial<
    Exclude<Answer["proposals"][number], { kind: "knowledge" | "document" }>
  >,
) {
  const w = f.store.workshop(f.chapter.id),
    m = f.store.addMessage(
      w.conversationId,
      "assistant",
      "Review this suggestion.",
    );
  const current = f.store.chapter(f.chapter.id);
  return f.store.addProposal(
    w.conversationId,
    m.id,
    f.project.id,
    canonicalOffer({
      kind: "update_chapter",
      chapterId: current.id,
      title: current.title,
      content: "New direction",
      reason: "Focus the experience",
      ...change,
    }),
    change.chapterId === null ? null : current.revision,
    current,
    documentExcerpt(current.content, 500000).receipt,
  );
}
const heading = (text: string) => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text }],
});
const rich: Doc = {
  type: "doc",
  content: [
    heading("Loop"),
    {
      type: "paragraph",
      content: [{ type: "text", text: "Old loop", marks: [{ type: "bold" }] }],
    },
    heading("Rewards"),
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Keep these rewards",
          marks: [{ type: "italic" }],
        },
      ],
    },
  ],
};

test("section approval preserves unrelated rich text; rejects ambiguous and missing headings", () => {
  const f = setup();
  try {
    f.store.updateChapter(f.chapter.id, { revision: 0, content: rich });
    const p = offer(f, {
      kind: "revise_section",
      section: "Loop",
      content: "Choose a route, salvage, return.",
    });
    assert.deepEqual(p.before!.content, rich);
    assert.deepEqual(f.store.chapter(f.chapter.id).content, rich);
    f.store.reviewProposal(p.id, "accept");
    const c = f.store.chapter(f.chapter.id);
    assert.deepEqual(c.content.content!.slice(-2), rich.content!.slice(-2));
    assert.match(docText(c.content), /Choose a route/);
    assert.throws(
      () => offer(f, { kind: "revise_section", section: "Missing" }),
      /existing heading/,
    );
    assert.throws(
      () => offer(f, { kind: "add_section", section: "Rewards" }),
      /already exists/,
    );
    const addition = offer(f, {
      kind: "add_section",
      section: "Failure",
      content: "Return with damaged gear.",
    });
    f.store.reviewProposal(addition.id, "accept");
    assert.deepEqual(
      f.store
        .chapter(c.id)
        .content.content!.slice(0, c.content.content!.length),
      c.content.content,
    );
    assert.match(docText(f.store.chapter(c.id).content), /Failure/);
    const duplicate = { ...rich, content: [...rich.content!, heading("Loop")] };
    f.store.updateChapter(c.id, {
      revision: f.store.chapter(c.id).revision,
      content: duplicate,
    });
    assert.throws(
      () => offer(f, { kind: "revise_section", section: "Loop" }),
      /unique existing heading/,
    );
  } finally {
    f.db.close();
  }
});

test("status changes require approval and affect only maturity; stale status changes cannot overwrite", () => {
  const f = setup();
  try {
    const p = offer(f, {
      kind: "change_status",
      proposedStatus: "Approved",
      content: "",
    });
    assert.equal(f.store.chapter(f.chapter.id).status, "Exploring");
    f.store.reviewProposal(p.id, "accept");
    assert.deepEqual(f.store.chapter(f.chapter.id).content, f.chapter.content);
    assert.equal(f.store.chapter(f.chapter.id).status, "Approved");
    const rejected = offer(f, {
      kind: "change_status",
      proposedStatus: "Needs Revision",
      content: "",
    });
    f.store.reviewProposal(rejected.id, "reject");
    assert.equal(f.store.chapter(f.chapter.id).status, "Approved");
    const stale = offer(f, {
      kind: "change_status",
      proposedStatus: "Exploring",
      content: "",
    });
    f.store.updateChapter(f.chapter.id, { revision: 1, title: "New vision" });
    assert.throws(
      () => f.store.reviewProposal(stale.id, "accept"),
      /Regenerate/,
    );
    assert.throws(
      () => offer(f, { kind: "change_status", content: "" }),
      /requires a maturity/,
    );
  } finally {
    f.db.close();
  }
});

test("decisions and significant questions remain proposals until accepted and are chapter-linked", () => {
  const f = setup();
  try {
    const decision = offer(f, {
      kind: "record_decision",
      content: "The game is cooperative.",
    });
    const question = offer(f, {
      kind: "record_question",
      content: "What happens on mission failure?",
    });
    assert.equal(f.store.records(f.project.id).length, 0);
    const context = buildContext(f.store, f.chapter.id, []);
    assert.equal(context.pending.length, 2);
    assert.equal(context.records.length, 0);
    f.store.reviewProposal(decision.id, "accept");
    f.store.reviewProposal(question.id, "accept");
    assert.deepEqual(f.store.chapter(f.chapter.id), f.chapter);
    const records = f.store.records(f.project.id);
    assert.deepEqual(
      records.map((r) => r.status),
      ["approved", "open"],
    );
    assert.deepEqual(records[0].relatedChapterIds, [f.chapter.id]);
    assert.equal(buildContext(f.store, f.chapter.id, []).records.length, 2);
    const another = f.store.createProject("Other", "");
    assert.throws(
      () =>
        f.store.resolveQuestion(another.id, records[1].id, {
          revision: records[1].revision,
          answer: "A reviewed answer",
        }),
      /not found/,
    );
    f.store.resolveQuestion(f.project.id, records[1].id, {
      revision: records[1].revision,
      answer: "A reviewed answer",
    });
    assert.equal(buildContext(f.store, f.chapter.id, []).records.length, 1);
    const rejected = offer(f, {
      kind: "record_decision",
      content: "Competitive instead",
    });
    f.store.reviewProposal(rejected.id, "reject");
    assert.equal(f.store.records(f.project.id).length, 2);
    assert.throws(
      () => f.store.reviewProposal(decision.id, "accept"),
      /already been reviewed/,
    );
  } finally {
    f.db.close();
  }
});

test("proposal sources, targets, revisions and related chapters are validated against project boundaries", () => {
  const f = setup();
  try {
    const other = f.store.createProject("Secret", "Secret premise"),
      foreign = f.store.chapters(other.id)[0],
      fw = f.store.workshop(foreign.id);
    assert.throws(
      () => offer(f, { relatedChapterIds: [foreign.id] }),
      /another project/,
    );
    assert.throws(() => offer(f, { chapterId: foreign.id }), /outside/);
    assert.throws(() => offer(f, { kind: "create_chapter" }), /target/);
    assert.throws(() => offer(f, { kind: "revise_section" }), /heading/);
    assert.throws(
      () => offer(f, { proposedStatus: "Approved" }),
      /proposedStatus|Only status/,
    );
    const w = f.store.workshop(f.chapter.id),
      m = f.store.addMessage(fw.conversationId, "assistant", "Foreign source");
    assert.throws(
      () =>
        f.store.addProposal(
          w.conversationId,
          m.id,
          f.project.id,
          canonicalOffer({
            chapterId: f.chapter.id,
            title: "Vision",
            content: "Bad",
            reason: "Bad",
          }),
          0,
        ),
      /source/,
    );
    const user = f.store.addMessage(
      w.conversationId,
      "user",
      "Untrusted source",
    );
    assert.throws(
      () =>
        f.store.addProposal(
          w.conversationId,
          user.id,
          f.project.id,
          {
            chapterId: f.chapter.id,
            title: "Vision",
            content: "Bad",
            reason: "Bad",
          },
          0,
        ),
      /source/,
    );
  } finally {
    f.db.close();
  }
});

test("context includes vision, selected chapter, relevant drafts and approved decisions while isolating projects and bounding large books", () => {
  const f = setup();
  try {
    const active = f.store.createChapter(
      f.project.id,
      "Core Gameplay",
      textDoc("salvage"),
    );
    const draft = f.store.createChapter(
      f.project.id,
      "Salvage inventory",
      textDoc("Still exploring"),
    );
    const approved = f.store.createChapter(
      f.project.id,
      "Visual style",
      textDoc("Muted colors"),
      "Approved",
    );
    const other = f.store.createProject("Secret title", "Secret premise"),
      secret = f.store.chapters(other.id)[0];
    f.store.updateChapter(secret.id, {
      revision: 0,
      status: "Approved",
      content: textDoc("Secret design"),
    });
    const w = f.store.workshop(active.id),
      m = f.store.addMessage(
        w.conversationId,
        "user",
        "How does salvage work?",
      );
    const c = buildContext(f.store, active.id, [m], "challenge");
    assert.equal(c.project.id, f.project.id);
    assert.equal(c.vision!.id, f.chapter.id);
    assert.equal(c.active.id, active.id);
    assert.ok(c.relevant.some((x) => x.id === draft.id));
    assert.ok(c.approved.some((x) => x.id === approved.id));
    assert.equal(c.workflow, "challenge");
    assert.doesNotMatch(JSON.stringify(c), /Secret/);
    for (let i = 0; i < 25; i++)
      f.store.createChapter(
        f.project.id,
        `Salvage ${i}`,
        textDoc("salvage ".repeat(30000)),
        "Approved",
      );
    const messages = Array.from({ length: 100 }, () => ({
      ...m,
      content: "design ".repeat(2000),
    }));
    const bounded = buildContext(f.store, active.id, messages);
    assert.ok(
      bounded.providerRequest!.contextBytes <=
        bounded.manifest!.limits.contextBytes,
    );
    assert.ok(
      bounded.providerRequest!.requestBytes <=
        bounded.manifest!.limits.requestBytes,
    );
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.messages.length <= 20);
  } finally {
    f.db.close();
  }
});

test("AI generation validates all proposals atomically and workflow modes reach the context builder", async () => {
  const f = setup();
  const app = createApp(f.store, {
    aiConfigured: true,
    assistant: async (ctx) => {
      assert.equal(ctx.workflow, "challenge");
      return {
        reply: "A tradeoff",
        proposals: [
          {
            kind: "record_decision",
            chapterId: f.chapter.id,
            title: "Cooperative",
            content: "Cooperative",
            reason: "Shared goals",
          },
          {
            kind: "revise_section",
            chapterId: f.chapter.id,
            title: "Missing",
            section: "Absent",
            content: "Bad edit",
            reason: "Missing",
          },
        ],
      };
    },
  });
  try {
    const r = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Challenge it", workflow: "challenge" },
    });
    assert.match(r.body, /event: error/);
    assert.equal(f.store.workshop(f.chapter.id).proposals.length, 0);
    assert.deepEqual(f.store.chapter(f.chapter.id), f.chapter);
    assert.equal(f.store.workshop(f.chapter.id).messages[1].state, "failed");
    const bad = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Hello", workflow: "unknown" },
    });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
    f.db.close();
  }
});

test("changes during AI generation retain the original snapshot and fail approval", async () => {
  const f = setup();
  const app = createApp(f.store, {
    aiConfigured: true,
    assistant: async () => {
      f.store.updateChapter(f.chapter.id, {
        revision: 0,
        content: textDoc("New manual content"),
      });
      return {
        reply: "A proposal",
        proposals: [
          canonicalOffer({
            chapterId: f.chapter.id,
            title: "Vision",
            content: "Old idea expanded",
            reason: "Expansion",
          }),
        ],
      };
    },
  });
  try {
    await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Expand" },
    });
    const p = f.store.workshop(f.chapter.id).proposals[0];
    assert.deepEqual(p.before!.content, f.chapter.content);
    const result = await app.inject({
      method: "POST",
      url: `/api/proposals/${p.id}/review`,
      payload: { decision: "accept" },
    });
    assert.equal(result.statusCode, 409);
    assert.equal(
      docText(f.store.chapter(f.chapter.id).content),
      "New manual content",
    );
  } finally {
    await app.close();
    f.db.close();
  }
});

test("decisions, questions, snapshots and lifecycle states survive restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-workshop-")),
    path = join(dir, "book.sqlite");
  let f = setup(path);
  try {
    const p = offer(f, { kind: "record_decision", content: "Cooperative" }),
      q = offer(f, { kind: "record_question", content: "How many players?" });
    f.store.reviewProposal(p.id, "accept");
    f.store.reviewProposal(q.id, "accept");
    const pending = offer(f, {
      kind: "add_section",
      section: "Experience",
      content: "Curiosity",
    });
    const id = f.chapter.id;
    f.db.close();
    const db = openDatabase(path),
      store = new Store(db);
    f = { ...f, db, store };
    const w = store.workshop(id);
    assert.equal(w.records.length, 2);
    assert.equal(w.proposals.find((x) => x.id === p.id)!.status, "accepted");
    assert.deepEqual(
      w.proposals.find((x) => x.id === pending.id)!.before!.content,
      f.chapter.content,
    );
    assert.equal(w.messages.length, 3);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true });
  }
});

test("structured responses reject unknown instructions and unsupported operations", () => {
  assert.equal(
    answerSchema.safeParse({
      reply: "Hello",
      proposals: [
        {
          kind: "delete_chapter",
          chapterId: null,
          title: "X",
          content: "X",
          reason: "X",
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    answerSchema.safeParse({
      reply: "Hello",
      proposals: [],
      execute: "Delete everything",
    }).success,
    false,
  );
  assert.equal(
    answerSchema.safeParse({
      reply: "Hello",
      proposals: [
        { chapterId: null, title: "X", content: "X", reason: "X", sql: "DROP" },
      ],
    }).success,
    false,
  );
});

test("readable diff preserves unchanged lines and identifies additions and removals", () => {
  assert.deepEqual(lineDiff("Keep\nOld\nEnd", "Keep\nNew\nEnd"), [
    { kind: "same", text: "Keep" },
    { kind: "removed", text: "Old" },
    { kind: "added", text: "New" },
    { kind: "same", text: "End" },
  ]);
});

test("excerpted active chapters cannot be replaced from incomplete AI context", async () => {
  const f = setup();
  f.store.updateChapter(f.chapter.id, {
    revision: 0,
    content: textDoc("Long chapter ".repeat(10000)),
  });
  const app = createApp(f.store, {
    aiConfigured: true,
    assistant: async (ctx) => {
      assert.equal(ctx.activeTruncated, true);
      return {
        reply: "Replace this",
        proposals: [
          {
            kind: "update_chapter",
            chapterId: f.chapter.id,
            title: "Vision",
            content: "Only the excerpt",
            reason: "Too short",
          },
        ],
      };
    },
  });
  try {
    const r = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Improve" },
    });
    assert.match(r.body, /section proposal/);
    assert.equal(f.store.workshop(f.chapter.id).proposals.length, 0);
    assert.equal(docText(f.store.chapter(f.chapter.id).content).length, 130000);
  } finally {
    await app.close();
    f.db.close();
  }
});

test("context builder rejects history from another project's conversation", () => {
  const f = setup();
  try {
    const foreign = f.store.createProject("Private game", "Private premise");
    const w = f.store.workshop(f.store.chapters(foreign.id)[0].id);
    const secret = f.store.addMessage(
      w.conversationId,
      "user",
      "Never expose this foreign history",
    );
    const context = buildContext(f.store, f.chapter.id, [secret]);
    assert.equal(context.messages.length, 0);
    assert.doesNotMatch(JSON.stringify(context), /foreign history/);
  } finally {
    f.db.close();
  }
});

test("migration upgrades legacy proposals without resetting content or conversations", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-legacy-"));
  const path = join(dir, "book.sqlite");
  let f = setup(path);
  try {
    const current = (() => {
      const w = f.store.workshop(f.chapter.id),
        m = f.store.addMessage(
          w.conversationId,
          "assistant",
          "Legacy revision",
        );
      return f.store.addProposal(
        w.conversationId,
        m.id,
        f.project.id,
        {
          chapterId: f.chapter.id,
          title: "Game Vision",
          content: "Reviewed later",
          reason: "Original legacy contract",
        },
        0,
        f.chapter,
      );
    })();
    const w = f.store.workshop(f.chapter.id);
    const m = f.store.addMessage(
      w.conversationId,
      "assistant",
      "A world chapter",
    );
    const addition = f.store.addProposal(
      w.conversationId,
      m.id,
      f.project.id,
      {
        chapterId: null,
        title: "World",
        content: "Fragments",
        reason: "Setting",
      },
      null,
    );
    // Reconstruct the shipped v1 table shape and migration marker.
    f.db.exec("DROP TRIGGER canonical_proposal_content_immutable");
    for (const name of [
      "kind",
      "description",
      "section",
      "proposed_status",
      "related_chapter_ids",
      "before_snapshot",
    ])
      f.db.exec(`ALTER TABLE proposals DROP COLUMN ${name}`);
    f.db.exec(
      "DROP TABLE design_records; DELETE FROM migrations WHERE version=2",
    );
    f.db.close();
    const db = openDatabase(path),
      store = new Store(db);
    f = { ...f, db, store };
    const upgraded = store.workshop(f.chapter.id);
    assert.equal(upgraded.messages.length, 2);
    assert.equal(
      upgraded.proposals.find((p) => p.id === addition.id)!.kind,
      "create_chapter",
    );
    assert.deepEqual(
      upgraded.proposals.find((p) => p.id === current.id)!.before!.content,
      f.chapter.content,
    );
    assert.throws(
      () => store.reviewProposal(current.id, "accept"),
      /Legacy full replacement/,
    );
    assert.deepEqual(store.chapter(f.chapter.id).content, f.chapter.content);
    store.reviewProposal(addition.id, "accept");
    assert.equal(store.chapters(f.project.id).length, 2);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true });
  }
});
