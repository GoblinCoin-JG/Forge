import { test } from "node:test";
import { canonicalOffer } from "./fixtures/document-offer.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../server/db.js";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";
import { buildContext } from "../server/context.js";
import { textDoc, type Doc } from "../shared/types.js";

function fixture(path = ":memory:") {
  const db = openDatabase(path),
    store = new Store(db),
    project = store.createProject("History fixture", "Original vision");
  return { db, store, project, chapter: store.chapters(project.id)[0] };
}
const rich: Doc = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Gameplay" }],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Explore",
          marks: [
            { type: "bold" },
            {
              type: "link",
              attrs: {
                href: "https://example.com",
                target: "_blank",
                rel: "noopener noreferrer",
              },
            },
          ],
        },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Return home",
                  marks: [{ type: "italic" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
test("exact approvals survive material edits; formatting and title changes are unreviewed while reparenting is not", () => {
  const f = fixture();
  try {
    const c = f.store.updateChapter(f.chapter.id, {
      revision: 0,
      content: rich,
    });
    const approved = f.store.approveChapter(c.id, c.revision);
    assert.equal(approved.approvedRevision, approved.revision);
    const parent = f.store.createChapter(f.project.id, "Gameplay");
    const moved = f.store.updateChapter(c.id, {
      revision: approved.revision,
      parentId: parent.id,
    });
    assert.equal(moved.status, "Approved");
    assert.equal(moved.changedSinceApproval, false);
    const changed = f.store.updateChapter(c.id, {
      revision: moved.revision,
      title: "Changed vision",
      status: "Approved",
    });
    assert.equal(changed.status, "Needs Revision");
    assert.equal(changed.changedSinceApproval, true);
    assert.equal(changed.approvedRevision, approved.revision);
    assert.deepEqual(f.store.approvedChapter(c.id)!.content, rich);
    assert.equal(f.store.approvedChapter(c.id)!.title, c.title);
    const reapproved = f.store.approveChapter(c.id, changed.revision);
    const formatted = f.store.updateChapter(c.id, {
      revision: reapproved.revision,
      content: {
        ...rich,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Explore" }] },
        ],
      },
    });
    assert.equal(formatted.changedSinceApproval, true);
    assert.equal(formatted.status, "Needs Revision");
    assert.equal(f.store.history(c.id).filter((h) => h.approvedAt).length, 2);
  } finally {
    f.db.close();
  }
});
test("all saved snapshots and approvals are immutable and canonical object key order is not material", () => {
  const f = fixture();
  try {
    const c = f.store.updateChapter(f.chapter.id, {
      revision: 0,
      content: rich,
    });
    const a = f.store.approveChapter(c.id, c.revision);
    const reordered = { content: rich.content, type: "doc" } as Doc;
    const next = f.store.updateChapter(c.id, {
      revision: a.revision,
      content: reordered,
    });
    assert.equal(next.status, "Approved");
    assert.equal(next.changedSinceApproval, false);
    for (const sql of [
      "UPDATE chapter_revisions SET title='tampered'",
      "DELETE FROM chapter_revisions",
      "UPDATE chapter_approvals SET origin='manual'",
      "DELETE FROM chapter_approvals",
    ])
      assert.throws(() => f.db.exec(sql), /immutable/);
    assert.throws(
      () =>
        f.db
          .prepare("UPDATE chapters SET approved_revision=999 WHERE id=?")
          .run(c.id),
      /saved chapter revision/,
    );
    assert.deepEqual(
      f.store.history(c.id).find((h) => h.revision === 1)!.content,
      rich,
    );
  } finally {
    f.db.close();
  }
});
test("restoration appends an unreviewed version with exact rich JSON and retains every earlier snapshot", () => {
  const f = fixture();
  try {
    const c = f.store.updateChapter(f.chapter.id, {
      revision: 0,
      content: rich,
      title: "Original title",
    });
    const a = f.store.approveChapter(c.id, c.revision);
    const edited = f.store.updateChapter(c.id, {
      revision: a.revision,
      content: textDoc("Later prose"),
      title: "Later title",
    });
    const before = f.store.history(c.id);
    const restored = f.store.restoreChapter(c.id, c.revision, edited.revision);
    assert.deepEqual(restored.content, rich);
    assert.equal(restored.title, "Original title");
    assert.equal(restored.status, "Needs Revision");
    assert.equal(restored.approvedRevision, a.revision);
    assert.equal(restored.revision, edited.revision + 1);
    const after = f.store.history(c.id);
    assert.deepEqual(after.slice(1), before);
    assert.equal(after[0].origin, "restore");
    assert.equal(after[0].restoredFrom, c.revision);
    assert.equal(after[0].approvedAt, null);
  } finally {
    f.db.close();
  }
});
test("stale restores and approvals leave both the document and history untouched", () => {
  const f = fixture();
  try {
    const saved = f.store.updateChapter(f.chapter.id, {
      revision: 0,
      content: rich,
    });
    const history = f.store.history(saved.id);
    assert.throws(
      () => f.store.restoreChapter(saved.id, 0, 0),
      /changed elsewhere/,
    );
    assert.throws(
      () => f.store.approveChapter(saved.id, 0),
      /changed elsewhere/,
    );
    assert.deepEqual(f.store.history(saved.id), history);
    assert.deepEqual(f.store.chapter(saved.id), saved);
    const other = f.store.createProject("Other", "");
    const foreign = f.store.chapters(other.id)[0];
    f.store.updateChapter(foreign.id, {
      revision: 0,
      content: textDoc("Foreign"),
    });
    assert.throws(
      () => f.store.restoreChapter(saved.id, 999, saved.revision),
      /not found/,
    );
    assert.equal(
      f.store.history(saved.id).every((h) => h.projectId === f.project.id),
      true,
    );
  } finally {
    f.db.close();
  }
});
test("proposal acceptance and restoration record source evidence and stale proposals cannot overwrite restoration", async () => {
  const f = fixture();
  const app = createApp(f.store, {
    aiConfigured: true,
    assistant: async (ctx) => ({
      reply: "Review this",
      proposals: [
        canonicalOffer({
          kind: "update_chapter",
          chapterId: ctx.active.id,
          title: "Game Vision",
          content: "## Loop\n\n**Explore** and return.",
          reason: "Clarify the loop",
        }),
      ],
    }),
  });
  try {
    const chat = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Improve the vision" },
    });
    assert.match(chat.body, /event: complete/);
    const p = f.store.workshop(f.chapter.id).proposals[0];
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/proposals/${p.id}/review`,
          payload: { decision: "accept" },
        })
      ).statusCode,
      200,
    );
    const h = f.store.history(f.chapter.id)[0];
    assert.equal(h.origin, "proposal");
    assert.equal(h.proposalId, p.id);
    assert.equal(h.approvedAt, null);
    assert.equal(h.status, "Proposed");
    await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Another proposal" },
    });
    const pending = f.store.workshop(f.chapter.id).proposals[1];
    const restored = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/restore`,
      payload: { savedRevision: 0, revision: 1 },
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/proposals/${pending.id}/review`,
          payload: { decision: "accept" },
        })
      ).statusCode,
      409,
    );
    assert.deepEqual(f.store.chapter(f.chapter.id).content, f.chapter.content);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/chapters/${f.chapter.id}/approve`,
          payload: { revision: 2 },
        })
      ).statusCode,
      200,
    );
    const approval = f.store.history(f.chapter.id)[0];
    assert.ok(approval.approvedAt);
    assert.equal(approval.approvalOrigin, "manual");
  } finally {
    await app.close();
    f.db.close();
  }
});
test("archival preserves history, decisions, conversations and proposals, promotes children, and blocks archived writes", async () => {
  const f = fixture();
  const app = createApp(f.store, { aiConfigured: false });
  try {
    const child = f.store.createChapter(
      f.project.id,
      "Child",
      rich,
      "Approved",
      f.chapter.id,
    );
    const w = f.store.workshop(f.chapter.id),
      m = f.store.addMessage(
        w.conversationId,
        "assistant",
        "Record a decision",
      );
    const decision = f.store.addProposal(
      w.conversationId,
      m.id,
      f.project.id,
      {
        kind: "record_decision",
        chapterId: f.chapter.id,
        title: "Decision",
        content: "Cooperative",
        reason: "Shared goals",
      },
      0,
    );
    f.store.reviewProposal(decision.id, "accept");
    const pending = f.store.addProposal(
      w.conversationId,
      m.id,
      f.project.id,
      { chapterId: null, title: "Later", content: "Later", reason: "Later" },
      null,
    );
    const failed = await app.inject({
      method: "DELETE",
      url: `/api/chapters/${f.chapter.id}`,
      payload: { revision: 99 },
    });
    assert.equal(failed.statusCode, 409);
    assert.equal(f.store.chapter(child.id).parentId, f.chapter.id);
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/chapters/${f.chapter.id}`,
          payload: { revision: 0 },
        })
      ).statusCode,
      200,
    );
    assert.equal(f.store.project(f.project.id).chapterCount, 1);
    assert.equal(f.store.chapters(f.project.id, true)[0].id, f.chapter.id);
    assert.equal(f.store.chapter(child.id).parentId, null);
    assert.equal(f.store.chapter(child.id).changedSinceApproval, false);
    assert.equal(f.store.history(child.id)[0].origin, "reparent");
    assert.equal(f.store.workshop(f.chapter.id).messages[0].id, m.id);
    assert.equal(f.store.workshop(f.chapter.id).proposals.length, 2);
    assert.equal(f.store.records(f.project.id)[0].status, "approved");
    assert.throws(
      () => f.store.reviewProposal(pending.id, "accept"),
      /archived/,
    );
    assert.throws(() => f.store.restoreChapter(f.chapter.id, 0, 1), /archived/);
    assert.throws(
      () =>
        f.store.createChapter(
          f.project.id,
          "Wrong",
          undefined,
          undefined,
          f.chapter.id,
        ),
      /archived/,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/chapters/${f.chapter.id}`,
          payload: { revision: 1, content: textDoc("Wrong") },
        })
      ).statusCode,
      409,
    );
    const returned = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/unarchive`,
      payload: { revision: 1 },
    });
    assert.equal(returned.statusCode, 200);
    assert.equal(f.store.history(f.chapter.id)[0].origin, "unarchive");
    assert.equal(f.store.chapter(f.chapter.id).archivedAt, null);
    // Returning a source does not resurrect a proposal's obsolete target revision.
    assert.throws(
      () =>
        f.store.reviewProposal(
          f.store.workshop(f.chapter.id).proposals[0].id,
          "accept",
        ),
      /already/,
    );
  } finally {
    await app.close();
    f.db.close();
  }
});
test("context exposes previous approved content separately from the newer draft and excludes archived chapters", () => {
  const f = fixture();
  try {
    const a = f.store.approveChapter(f.chapter.id, 0);
    const changed = f.store.updateChapter(a.id, {
      revision: a.revision,
      content: textDoc("Unreviewed idea"),
    });
    const hidden = f.store.createChapter(
      f.project.id,
      "Archived design",
      textDoc("Retired context"),
      "Approved",
    );
    f.store.archiveChapter(hidden.id, 0);
    const c = buildContext(f.store, changed.id, []);
    assert.equal(c.active.status, "Needs Revision");
    assert.equal(c.active.changedSinceApproval, true);
    assert.deepEqual(
      c.approved.find((h) => h.id === changed.id)!.content,
      f.chapter.content,
    );
    assert.doesNotMatch(JSON.stringify(c), /Retired context|Archived design/);
  } finally {
    f.db.close();
  }
});
test("history, approvals and archived source evidence survive database restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-history-")),
    path = join(dir, "fixture.sqlite");
  let f = fixture(path);
  try {
    const a = f.store.approveChapter(f.chapter.id, 0);
    f.store.updateChapter(a.id, { revision: a.revision, content: rich });
    const before = f.store.history(a.id);
    f.store.archiveChapter(a.id, 2);
    const archived = f.store.chapter(a.id, true);
    f.db.close();
    const db = openDatabase(path);
    f = { ...f, db, store: new Store(db) };
    assert.deepEqual(f.store.history(a.id).slice(1), before);
    assert.deepEqual(f.store.chapter(a.id, true), archived);
    assert.equal(f.store.chapters(f.project.id).length, 0);
    const returned = f.store.unarchiveChapter(a.id, 3);
    assert.equal(returned.changedSinceApproval, true);
    assert.equal(returned.approvedRevision, 1);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true });
  }
});
test("version 3 migration preserves current data, backfills only available baselines, and is repeatable", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v3-")),
    path = join(dir, "fixture.sqlite");
  let db: DatabaseSync = new DatabaseSync(path);
  try {
    // Actual pre-history table shapes; no new Store calls construct the old fixture.
    db.exec(`CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT INTO migrations VALUES(1,'old'),(2,'old'),(3,'old');
      CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT,premise TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE chapters(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT,content TEXT,status TEXT,position INTEGER,revision INTEGER,updated_at TEXT,parent_id TEXT REFERENCES chapters(id));
      CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),chapter_id TEXT UNIQUE REFERENCES chapters(id));
      CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES conversations(id),role TEXT,content TEXT,state TEXT,created_at TEXT);
      CREATE TABLE proposals(id TEXT PRIMARY KEY,conversation_id TEXT,message_id TEXT,project_id TEXT,chapter_id TEXT,title TEXT,content TEXT,reason TEXT,base_revision INTEGER,status TEXT,created_at TEXT,kind TEXT,description TEXT,section TEXT,proposed_status TEXT,related_chapter_ids TEXT,before_snapshot TEXT,parent_id TEXT);
      CREATE TABLE design_records(id TEXT PRIMARY KEY,project_id TEXT,kind TEXT,text TEXT,rationale TEXT,related_chapter_ids TEXT,status TEXT,created_at TEXT);
      INSERT INTO projects VALUES('p','Legacy','Premise','old','old');
      `);
    db.prepare("INSERT INTO chapters VALUES(?,?,?,?,?,?,?,?,?)").run(
      "c",
      "p",
      "Vision",
      JSON.stringify(rich),
      "Approved",
      0,
      7,
      "old",
      null,
    );
    db.exec(
      "INSERT INTO conversations VALUES('w','p','c'); INSERT INTO messages VALUES('m','w','assistant','Evidence','complete','old');",
    );
    db.prepare("INSERT INTO design_records VALUES(?,?,?,?,?,?,?,?)").run(
      "d",
      "p",
      "decision",
      "Cooperative",
      "Reason",
      '["c"]',
      "approved",
      "old",
    );
    db.close();
    db = openDatabase(path);
    let store = new Store(db);
    assert.deepEqual(store.chapter("c").content, rich);
    assert.equal(store.chapter("c").revision, 7);
    assert.equal(store.chapter("c").approvedRevision, 7);
    assert.equal(store.chapter("c").changedSinceApproval, false);
    assert.equal(store.history("c").length, 1);
    assert.equal(store.history("c")[0].origin, "migration");
    assert.equal(store.history("c")[0].approvalOrigin, "migration");
    assert.equal(store.workshop("c").messages[0].id, "m");
    assert.equal(store.records("p")[0].id, "d");
    const before = store.history("c");
    db.close();
    db = openDatabase(path);
    store = new Store(db);
    assert.deepEqual(store.history("c"), before);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});
test("history API rejects missing revision checks, invalid targets, and attempts to approve through autosave", async () => {
  const f = fixture();
  const app = createApp(f.store, { aiConfigured: false });
  try {
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/chapters/${f.chapter.id}`,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/chapters/${f.chapter.id}/restore`,
          payload: { savedRevision: 0 },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/chapters/${f.chapter.id}`,
          payload: { revision: 0, status: "Approved" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/chapters/${f.chapter.id}/restore`,
          payload: { savedRevision: 999, revision: 0 },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await app.inject("/api/chapters/missing/history")).statusCode,
      404,
    );
    assert.equal(f.store.history(f.chapter.id).length, 1);
  } finally {
    await app.close();
    f.db.close();
  }
});

test("history insertion failure rolls back the document save and preserves the approved revision", () => {
  const f = fixture();
  try {
    const approved = f.store.approveChapter(f.chapter.id, 0),
      history = f.store.history(approved.id);
    f.db.exec(
      "CREATE TRIGGER simulate_history_failure BEFORE INSERT ON chapter_revisions BEGIN SELECT RAISE(ABORT,'Simulated history failure'); END;",
    );
    assert.throws(
      () =>
        f.store.updateChapter(approved.id, {
          revision: approved.revision,
          content: rich,
        }),
      /Simulated/,
    );
    assert.deepEqual(f.store.chapter(approved.id), approved);
    assert.deepEqual(f.store.history(approved.id), history);
    f.db.exec("DROP TRIGGER simulate_history_failure");
    assert.equal(
      f.store.updateChapter(approved.id, {
        revision: approved.revision,
        content: rich,
      }).changedSinceApproval,
      true,
    );
  } finally {
    f.db.close();
  }
});
test("history database constraints reject another project's ownership and status proposal approval retains its source", () => {
  const f = fixture();
  try {
    const other = f.store.createProject("Other", "");
    assert.throws(
      () =>
        f.db
          .prepare(
            "INSERT INTO chapter_revisions (chapter_id,revision,project_id,title,content,status,created_at,origin) VALUES (?,?,?,?,?,?,?,?)",
          )
          .run(
            f.chapter.id,
            999,
            other.id,
            "Wrong",
            JSON.stringify(textDoc("Wrong")),
            "Exploring",
            "now",
            "manual",
          ),
      /FOREIGN KEY/,
    );
    const w = f.store.workshop(f.chapter.id),
      m = f.store.addMessage(
        w.conversationId,
        "assistant",
        "Approve the current design",
      );
    const p = f.store.addProposal(
      w.conversationId,
      m.id,
      f.project.id,
      {
        kind: "change_status",
        chapterId: f.chapter.id,
        title: "Approval",
        content: "",
        proposedStatus: "Approved",
        reason: "Review current design",
      },
      0,
    );
    f.store.reviewProposal(p.id, "accept");
    const version = f.store.history(f.chapter.id)[0];
    assert.equal(version.proposalId, p.id);
    assert.equal(version.approvalOrigin, "proposal");
    assert.equal(
      f.store.chapter(f.chapter.id).approvedRevision,
      version.revision,
    );
    assert.throws(
      () => f.store.reviewProposal(p.id, "accept"),
      /already been reviewed/,
    );
  } finally {
    f.db.close();
  }
});
