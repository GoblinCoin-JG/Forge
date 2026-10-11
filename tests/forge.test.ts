import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db.js";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";
import { docText, textDoc, docSchema } from "../shared/types.js";
import { partialReply, type DesignAssistant } from "../server/ai.js";

function fixture() {
  const db = openDatabase(":memory:");
  const store = new Store(db);
  const project = store.createProject(
    "Wormfall",
    "Scavenge wreckage falling through wormholes.",
  );
  const chapter = store.chapters(project.id)[0];
  return { db, store, project, chapter };
}
function propose(f: ReturnType<typeof fixture>) {
  const w = f.store.workshop(f.chapter.id);
  const m = f.store.addMessage(
    w.conversationId,
    "assistant",
    "A proposed revision",
  );
  return f.store.addProposal(
    w.conversationId,
    m.id,
    f.project.id,
    {
      chapterId: f.chapter.id,
      title: "Game Vision",
      content: "Explore. Salvage. Return home.",
      reason: "A clearer player experience.",
    },
    f.chapter.revision,
  );
}

test("blank projects receive only Game Vision; title and premise are optional", () => {
  const db = openDatabase(":memory:");
  const store = new Store(db);
  const p = store.createProject("", "");
  assert.equal(p.title, "Untitled game");
  const chapters = store.chapters(p.id);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, "Game Vision");
  assert.equal(docText(chapters[0].content), "");
  db.close();
});
test("projects, rich text, chapter order, maturity, messages and pending proposals persist after database restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-test-"));
  const path = join(dir, "book.sqlite");
  let db = openDatabase(path);
  let store = new Store(db);
  try {
    const p = store.createProject("Wormfall", "A quiet salvage game.");
    const c = store.chapters(p.id)[0];
    const rich = {
      type: "doc" as const,
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            { type: "text", text: "The promise", marks: [{ type: "bold" }] },
          ],
        },
      ],
    };
    store.updateChapter(c.id, {
      content: rich,
      revision: 0,
      status: "Approved",
    });
    const b = store.createChapter(p.id, "Core Gameplay");
    store.reorder(p.id, [b.id, c.id]);
    const w = store.workshop(c.id);
    const m = store.addMessage(
      w.conversationId,
      "assistant",
      "Would you like a chapter about the world?",
    );
    const proposal = store.addProposal(
      w.conversationId,
      m.id,
      p.id,
      {
        chapterId: null,
        title: "World",
        content: "A world of falling relics.",
        reason: "Explore the setting.",
      },
      null,
    );
    db.close();
    db = openDatabase(path);
    store = new Store(db);
    assert.equal(store.project(p.id).title, "Wormfall");
    assert.deepEqual(
      store.chapters(p.id).map((c) => c.id),
      [b.id, c.id],
    );
    assert.deepEqual(store.chapter(c.id).content, rich);
    assert.equal(store.chapter(c.id).status, "Approved");
    assert.equal(store.workshop(c.id).messages[0].content, m.content);
    assert.equal(store.workshop(c.id).proposals[0].id, proposal.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});
test("rejecting a proposal never changes approved chapter content or revision", () => {
  const f = fixture();
  const updated = f.store.updateChapter(f.chapter.id, {
    status: "Approved",
    revision: 0,
  });
  f.chapter = updated;
  const p = propose(f);
  f.store.reviewProposal(p.id, "reject");
  assert.deepEqual(f.store.chapter(f.chapter.id), updated);
  assert.equal(f.store.workshop(f.chapter.id).proposals[0].status, "rejected");
  f.db.close();
});
test("acceptance applies a reviewed revision exactly once with Proposed maturity", () => {
  const f = fixture();
  const p = propose(f);
  f.store.reviewProposal(p.id, "accept");
  const c = f.store.chapter(f.chapter.id);
  assert.equal(docText(c.content), "Explore. Salvage. Return home.");
  assert.equal(c.status, "Proposed");
  assert.equal(c.revision, 1);
  assert.throws(
    () => f.store.reviewProposal(p.id, "accept"),
    /already been reviewed/,
  );
  f.db.close();
});
test("stale proposal acceptance rolls back and keeps newer manual edits", () => {
  const f = fixture();
  const p = propose(f);
  const edit = f.store.updateChapter(f.chapter.id, {
    content: textDoc("My new direction."),
    revision: 0,
  });
  assert.throws(
    () => f.store.reviewProposal(p.id, "accept"),
    /changed elsewhere/,
  );
  assert.deepEqual(f.store.chapter(f.chapter.id), edit);
  assert.equal(f.store.workshop(f.chapter.id).proposals[0].status, "pending");
  f.db.close();
});
test("new chapter proposals are never added until acceptance", () => {
  const f = fixture();
  const w = f.store.workshop(f.chapter.id);
  const m = f.store.addMessage(
    w.conversationId,
    "assistant",
    "Consider the world.",
  );
  const p = f.store.addProposal(
    w.conversationId,
    m.id,
    f.project.id,
    {
      chapterId: null,
      title: "World",
      content: "A fragmented world.",
      reason: "Explore the setting.",
    },
    null,
  );
  assert.equal(f.store.chapters(f.project.id).length, 1);
  f.store.reviewProposal(p.id, "accept");
  assert.equal(f.store.chapters(f.project.id).length, 2);
  assert.equal(f.store.chapters(f.project.id)[1].status, "Proposed");
  f.db.close();
});
test("reordering rejects duplicate, incomplete and foreign chapter IDs", () => {
  const f = fixture();
  const b = f.store.createChapter(f.project.id, "Gameplay");
  const other = f.store.createProject("Other", "");
  const foreign = f.store.chapters(other.id)[0];
  for (const ids of [
    [f.chapter.id],
    [f.chapter.id, f.chapter.id],
    [f.chapter.id, foreign.id],
  ])
    assert.throws(() => f.store.reorder(f.project.id, ids));
  assert.deepEqual(
    f.store.chapters(f.project.id).map((c) => c.id),
    [f.chapter.id, b.id],
  );
  f.db.close();
});
test("archiving a chapter retains its conversation and proposals outside the live book", () => {
  const f = fixture();
  propose(f);
  f.store.deleteChapter(f.chapter.id);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM conversations").get()!.n,
    1,
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM messages").get()!.n, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM proposals").get()!.n, 1);
  assert.equal(f.store.chapters(f.project.id).length, 0);
  assert.ok(f.store.chapter(f.chapter.id, true).archivedAt);
  f.db.close();
});
test("API works without AI credentials, validates writes and rejects external origins/hosts", async () => {
  const f = fixture();
  const app = createApp(f.store, { aiConfigured: false });
  try {
    assert.equal((await app.inject("/api/projects")).statusCode, 200);
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/projects", payload: {} }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/chapters/${f.chapter.id}`,
          payload: { title: "", revision: 0 },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/chapters/${f.chapter.id}/chat`,
          payload: { content: "Hello" },
        })
      ).statusCode,
      503,
    );
    assert.equal(f.store.workshop(f.chapter.id).messages.length, 0);
    assert.equal(
      (
        await app.inject({
          url: "/api/projects",
          headers: { origin: "https://evil.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/projects",
          headers: { host: "evil.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/projects",
          headers: { origin: "http://localhost:5173" },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
    f.db.close();
  }
});
test("streaming provides active chapter and approved context, persists proposals, and never edits the book", async () => {
  const f = fixture();
  const approved = f.store.createChapter(
    f.project.id,
    "Art",
    textDoc("Muted bronze"),
    "Approved",
  );
  f.store.createChapter(
    f.project.id,
    "Unapproved ideas",
    textDoc("Do not treat this as a decision"),
  );
  const assistant: DesignAssistant = async (context, _signal, emit) => {
    assert.equal(context.active.id, f.chapter.id);
    assert.deepEqual(
      context.approved.map((c) => c.id),
      [approved.id],
    );
    assert.equal(context.messages.at(-1)!.content, "Suggest a clearer vision.");
    emit("Let us explore");
    return {
      reply: "Let us explore the promise.",
      proposals: [
        {
          chapterId: f.chapter.id,
          title: "Game Vision",
          content: "A promise of discovery.",
          reason: "Clear player motivation.",
        },
      ],
    };
  };
  const app = createApp(f.store, { assistant, aiConfigured: true });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Suggest a clearer vision." },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: reply/);
    assert.match(response.body, /event: complete/);
    const w = f.store.workshop(f.chapter.id);
    assert.equal(w.messages.length, 2);
    assert.equal(w.proposals.length, 1);
    assert.equal(w.proposals[0].status, "pending");
    assert.deepEqual(f.store.chapter(f.chapter.id), f.chapter);
  } finally {
    await app.close();
    f.db.close();
  }
});
test("failed and interrupted AI responses persist conversation without proposals or book changes", async () => {
  for (const interrupted of [false, true]) {
    const f = fixture();
    const assistant: DesignAssistant = async (_ctx, _signal, emit) => {
      emit("A partial idea");
      if (interrupted) throw new DOMException("Stopped", "AbortError");
      throw new Error("AI service unavailable");
    };
    const app = createApp(f.store, { assistant, aiConfigured: true });
    try {
      const r = await app.inject({
        method: "POST",
        url: `/api/chapters/${f.chapter.id}/chat`,
        payload: { content: "Explore" },
      });
      assert.match(r.body, /event: error/);
      const w = f.store.workshop(f.chapter.id);
      assert.equal(w.messages.length, 2);
      assert.equal(w.messages[1].state, interrupted ? "interrupted" : "failed");
      assert.equal(w.proposals.length, 0);
      assert.deepEqual(f.store.chapter(f.chapter.id), f.chapter);
    } finally {
      await app.close();
      f.db.close();
    }
  }
});
test("AI cannot propose changes to another project or a non-active chapter", async () => {
  const f = fixture();
  const other = f.store.createChapter(f.project.id, "Other chapter");
  const assistant: DesignAssistant = async () => ({
    reply: "A change",
    proposals: [
      {
        chapterId: other.id,
        title: "Other",
        content: "Wrong target",
        reason: "Wrong target",
      },
    ],
  });
  const app = createApp(f.store, { assistant, aiConfigured: true });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Explore" },
    });
    assert.match(response.body, /outside the active chapter/);
    assert.equal(f.store.workshop(f.chapter.id).proposals.length, 0);
    assert.deepEqual(f.store.chapter(other.id), other);
  } finally {
    await app.close();
    f.db.close();
  }
});
test("partial structured reply decoding handles escaped strings and incomplete unicode", () => {
  assert.equal(partialReply('{"reply":"Hello\\nworld\\"'), 'Hello\nworld"');
  assert.equal(partialReply('{"reply":"A \\u263a'), "A ☺");
  assert.equal(partialReply('{"reply":"A \\u26'), "A ");
  assert.equal(partialReply('{"reply":"Done","proposals":['), "Done");
});

test("deletion compacts chapter numbering without changing remaining content", () => {
  const f = fixture();
  const second = f.store.createChapter(
    f.project.id,
    "Gameplay",
    textDoc("A loop"),
  );
  f.store.deleteChapter(f.chapter.id);
  assert.equal(f.store.chapter(second.id).position, 0);
  assert.equal(docText(f.store.chapter(second.id).content), "A loop");
  assert.equal(f.store.createChapter(f.project.id, "World").position, 1);
  f.db.close();
});

test("rich-text validation rejects unsupported nodes, unsafe links and excessive nesting", () => {
  assert.equal(docSchema.safeParse(textDoc("A valid paragraph")).success, true);
  assert.equal(
    docSchema.safeParse({
      type: "doc",
      content: [{ type: "script", text: "invalid" }],
    }).success,
    false,
  );
  assert.equal(
    docSchema.safeParse({
      type: "doc",
      content: [
        {
          type: "text",
          text: "bad link",
          marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
        },
      ],
    }).success,
    false,
  );
  let child: unknown = { type: "paragraph" };
  for (let i = 0; i < 25; i++) child = { type: "blockquote", content: [child] };
  assert.equal(
    docSchema.safeParse({ type: "doc", content: [child] }).success,
    false,
  );
});
