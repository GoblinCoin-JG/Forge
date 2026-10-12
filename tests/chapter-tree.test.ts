import { test } from "node:test";
import { canonicalOffer } from "./fixtures/document-offer.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db.js";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";
import { buildContext } from "../server/context.js";
import { chapterOutline } from "../shared/chapter-tree.js";
import { textDoc, docText } from "../shared/types.js";
function fixture(path = ":memory:") {
  const db = openDatabase(path),
    store = new Store(db),
    project = store.createProject("Salvage", "Curiosity"),
    parent = store.createChapter(
      project.id,
      "Core Gameplay",
      textDoc("Explore and return."),
    );
  return { db, store, project, parent };
}
function proposal(f: ReturnType<typeof fixture>) {
  const w = f.store.workshop(f.parent.id),
    m = f.store.addMessage(
      w.conversationId,
      "assistant",
      "Split the loop into sub-chapters.",
    );
  return f.store.addProposal(
    w.conversationId,
    m.id,
    f.project.id,
    {
      kind: "create_subchapter",
      parentId: f.parent.id,
      chapterId: null,
      title: "Salvage Loop",
      content: "## Choose a site\nExplore together.",
      reason: "Develop this part of Core Gameplay.",
    },
    null,
  );
}
test("sub-chapter proposals create nested chapters only on acceptance and never replace the parent", () => {
  const f = fixture();
  try {
    const p = proposal(f);
    assert.equal(p.parentId, f.parent.id);
    assert.equal(f.store.chapters(f.project.id).length, 2);
    f.store.reviewProposal(p.id, "reject");
    assert.equal(f.store.chapters(f.project.id).length, 2);
    const accepted = proposal(f);
    f.store.reviewProposal(accepted.id, "accept");
    const child = f.store
      .chapters(f.project.id)
      .find((c) => c.parentId === f.parent.id)!;
    assert.equal(child.title, "Salvage Loop");
    assert.equal(child.status, "Proposed");
    assert.deepEqual(f.store.chapter(f.parent.id), f.parent);
    assert.deepEqual(
      chapterOutline(f.store.chapters(f.project.id)).map((row) => [
        row.chapter.title,
        row.number,
        row.depth,
      ]),
      [
        ["Game Vision", "01", 0],
        ["Core Gameplay", "02", 0],
        ["Salvage Loop", "02.01", 1],
      ],
    );
  } finally {
    f.db.close();
  }
});
test("multiple split proposals can be accepted independently including after a parent summary update", () => {
  const f = fixture();
  try {
    const a = proposal(f),
      b = proposal(f);
    f.store.updateChapter(f.parent.id, {
      revision: 0,
      content: textDoc("A brief overview"),
    });
    f.store.reviewProposal(b.id, "accept");
    f.store.reviewProposal(a.id, "accept");
    assert.equal(
      f.store.chapters(f.project.id).filter((c) => c.parentId === f.parent.id)
        .length,
      2,
    );
    assert.equal(
      docText(f.store.chapter(f.parent.id).content),
      "A brief overview",
    );
  } finally {
    f.db.close();
  }
});
test("existing standalone chapters can be reparented with content, conversations and revision safeguards intact", () => {
  const f = fixture();
  try {
    const old = f.store.createChapter(
      f.project.id,
      "Progression",
      textDoc("Keep all progression details"),
    );
    const w = f.store.workshop(old.id);
    f.store.addMessage(w.conversationId, "user", "Earlier ideas");
    const moved = f.store.updateChapter(old.id, {
      revision: old.revision,
      parentId: f.parent.id,
    });
    assert.deepEqual(moved.content, old.content);
    assert.equal(moved.parentId, f.parent.id);
    assert.equal(moved.revision, 1);
    assert.equal(
      f.store.workshop(moved.id).messages[0].content,
      "Earlier ideas",
    );
    assert.throws(
      () => f.store.updateChapter(old.id, { revision: 0, parentId: null }),
      /changed elsewhere/,
    );
    assert.throws(
      () =>
        f.store.updateChapter(f.parent.id, { revision: 0, parentId: old.id }),
      /descendants/,
    );
    assert.throws(
      () => f.store.updateChapter(old.id, { revision: 1, parentId: old.id }),
      /itself/,
    );
  } finally {
    f.db.close();
  }
});
test("parent creation, moving and proposal review enforce project and active chapter boundaries", () => {
  const f = fixture();
  try {
    const foreign = f.store.createProject("Other", "Private"),
      outside = f.store.chapters(foreign.id)[0];
    assert.throws(
      () =>
        f.store.createChapter(
          f.project.id,
          "Foreign",
          textDoc(""),
          "Exploring",
          outside.id,
        ),
      /another project/,
    );
    assert.throws(
      () =>
        f.store.updateChapter(f.parent.id, {
          revision: 0,
          parentId: outside.id,
        }),
      /another project/,
    );
    const w = f.store.workshop(f.parent.id),
      m = f.store.addMessage(w.conversationId, "assistant", "A child");
    for (const parentId of [
      outside.id,
      f.store.chapters(f.project.id)[0].id,
      null,
    ])
      assert.throws(
        () =>
          f.store.addProposal(
            w.conversationId,
            m.id,
            f.project.id,
            {
              kind: "create_subchapter",
              parentId,
              chapterId: null,
              title: "Child",
              content: "Notes",
              reason: "Organize",
            },
            null,
          ),
        /active chapter/,
      );
    const p = proposal(f);
    assert.throws(
      () => f.store.reviewProposal(p.id, "accept", { parentId: outside.id }),
      /another project/,
    );
    assert.equal(f.store.workshop(f.parent.id).proposals[0].status, "pending");
    f.store.deleteChapter(f.parent.id);
    assert.throws(() => f.store.reviewProposal(p.id, "accept"), /archived/);
  } finally {
    f.db.close();
  }
});
test("previous top-level proposals can be placed under a parent during explicit approval", async () => {
  const f = fixture(),
    w = f.store.workshop(f.parent.id),
    m = f.store.addMessage(
      w.conversationId,
      "assistant",
      "Earlier flat proposal",
    );
  const p = f.store.addProposal(
    w.conversationId,
    m.id,
    f.project.id,
    {
      chapterId: null,
      title: "Combat",
      content: "A deliberate combat loop",
      reason: "Organize",
    },
    null,
  );
  const app = createApp(f.store, { aiConfigured: false });
  try {
    const r = await app.inject({
      method: "POST",
      url: `/api/proposals/${p.id}/review`,
      payload: { decision: "accept", parentId: f.parent.id },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().parentId, f.parent.id);
    assert.equal(
      f.store.chapters(f.project.id).find((c) => c.title === "Combat")!
        .parentId,
      f.parent.id,
    );
  } finally {
    await app.close();
    f.db.close();
  }
});
test("hierarchy, independent conversations, and pending parent destinations persist after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-tree-")),
    path = join(dir, "book.sqlite");
  let f = fixture(path);
  try {
    const p = proposal(f),
      child = f.store.createChapter(
        f.project.id,
        "Progression",
        textDoc("Growth"),
        "Approved",
        f.parent.id,
      ),
      grandchild = f.store.createChapter(
        f.project.id,
        "Abilities",
        textDoc("Unlocks"),
        "Exploring",
        child.id,
      );
    const w = f.store.workshop(grandchild.id);
    f.store.addMessage(w.conversationId, "user", "Discuss unlocks");
    f.db.close();
    const db = openDatabase(path),
      store = new Store(db);
    f = { ...f, db, store };
    assert.equal(store.chapter(child.id).parentId, f.parent.id);
    assert.equal(store.chapter(grandchild.id).parentId, child.id);
    assert.equal(
      store.workshop(f.parent.id).proposals.find((x) => x.id === p.id)!
        .parentId,
      f.parent.id,
    );
    const context = buildContext(
      store,
      grandchild.id,
      store.workshop(grandchild.id).messages,
    );
    assert.deepEqual(
      context.lineage.map((c) => c.title),
      ["Core Gameplay", "Progression"],
    );
    assert.equal(context.messages[0].content, "Discuss unlocks");
    assert.ok(context.relevant.some((c) => c.id === f.parent.id));
    assert.ok(context.approved.some((c) => c.id === child.id));
    assert.deepEqual(
      buildContext(store, child.id, []).children.map((c) => c.title),
      ["Abilities"],
    );
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true });
  }
});
test("deleting a parent promotes surviving children and preserves nested descendants", () => {
  const f = fixture();
  try {
    const child = f.store.createChapter(
        f.project.id,
        "Progression",
        textDoc("Keep growth"),
        "Approved",
        f.parent.id,
      ),
      nested = f.store.createChapter(
        f.project.id,
        "Abilities",
        textDoc("Keep unlocks"),
        "Exploring",
        child.id,
      );
    f.store.deleteChapter(f.parent.id);
    assert.equal(f.store.chapter(child.id).parentId, null);
    assert.equal(f.store.chapter(child.id).revision, 1);
    assert.equal(f.store.chapter(nested.id).parentId, child.id);
    assert.equal(docText(f.store.chapter(child.id).content), "Keep growth");
  } finally {
    f.db.close();
  }
});
test("legacy flat books migrate to top-level chapters without changing content", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-tree-upgrade-")),
    path = join(dir, "book.sqlite");
  let f = fixture(path);
  try {
    f.db.exec(
      "DROP INDEX chapter_parent; ALTER TABLE chapters DROP COLUMN parent_id; ALTER TABLE proposals DROP COLUMN parent_id; DELETE FROM migrations WHERE version=3",
    );
    f.db.close();
    const db = openDatabase(path),
      store = new Store(db);
    f = { ...f, db, store };
    assert.ok(store.chapters(f.project.id).every((c) => c.parentId === null));
    assert.equal(
      docText(store.chapter(f.parent.id).content),
      "Explore and return.",
    );
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true });
  }
});

test("streamed split proposals carry their parent through generation and approval", async () => {
  const f = fixture();
  const app = createApp(f.store, {
    aiConfigured: true,
    assistant: async (ctx) => ({
      reply: "Review this sub-chapter",
      proposals: [
        canonicalOffer({
          kind: "create_subchapter",
          parentId: ctx.active.id,
          chapterId: null,
          title: "Failure",
          content: "Return after failed missions.",
          reason: "Develop failure stakes.",
        }),
      ],
    }),
  });
  try {
    const r = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.parent.id}/chat`,
      payload: { content: "Split Core Gameplay into sub-chapters" },
    });
    assert.match(r.body, /event: complete/);
    assert.doesNotMatch(r.body, /event: error/);
    const p = f.store.workshop(f.parent.id).proposals[0];
    assert.equal(p.parentId, f.parent.id);
    assert.equal(f.store.chapters(f.project.id).length, 2);
    const review = await app.inject({
      method: "POST",
      url: `/api/proposals/${p.id}/review`,
      payload: { decision: "accept" },
    });
    assert.equal(review.statusCode, 200);
    assert.equal(
      f.store.chapters(f.project.id).find((c) => c.title === "Failure")!
        .parentId,
      f.parent.id,
    );
  } finally {
    await app.close();
    f.db.close();
  }
});
