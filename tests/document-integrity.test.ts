import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docSchema, editorDocumentSchema } from "../shared/document.js";
import { canonicalDocument } from "../shared/chapter-content.js";
import { documentExcerpt } from "../shared/document-context.js";
import {
  documentSections,
  documentProposalSafety,
  materializeDocument,
  type DocumentPayload,
} from "../shared/document-proposals.js";
import { openDatabase } from "../server/db.js";
import { migrateDocumentProposals } from "../server/document-migration.js";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";
import { buildContext } from "../server/context.js";
import {
  answerSchema,
  documentChangeSchema,
  openAIAssistant,
} from "../server/ai.js";
import {
  richDesignDocument,
  movementRefinement,
} from "./fixtures/rich-document.js";
import { textDoc, docText, type Doc, type Proposal } from "../shared/types.js";

function fixture(path = ":memory:") {
  const db = openDatabase(path),
    store = new Store(db),
    project = store.createProject(
      "Document Lab",
      "Keep structured design direction",
    ),
    chapter = store.updateChapter(store.chapters(project.id)[0].id, {
      revision: 0,
      content: richDesignDocument,
    });
  return { db, store, project, chapter };
}
type Fixture = ReturnType<typeof fixture>;
function envelope(f: Fixture, payload: DocumentPayload) {
  return documentChangeSchema.parse({
    kind: "document",
    chapterId: payload.action.startsWith("create_") ? null : f.chapter.id,
    parentId: payload.action === "create_subchapter" ? f.chapter.id : null,
    title: "Game Vision",
    reason: "Preserve design fidelity",
    description: "A focused canonical document change",
    document: payload,
  });
}
function offer(
  f: Fixture,
  payload: DocumentPayload,
  receipt = documentExcerpt(f.chapter.content, 500000).receipt,
) {
  const source = f.store.chapter(f.chapter.id),
    w = f.store.workshop(source.id),
    m = f.store.addMessage(
      w.conversationId,
      "assistant",
      "Review the exact rich document.",
    );
  return f.store.addProposal(
    w.conversationId,
    m.id,
    f.project.id,
    envelope(f, payload),
    payload.action.startsWith("create_") ? null : source.revision,
    payload.action.startsWith("create_") ? undefined : source,
    receipt,
    source,
  );
}
test("canonical schema matches editor capabilities and preserves rich JSON without normalization", () => {
  const input = structuredClone(richDesignDocument),
    snapshot = JSON.stringify(input);
  assert.ok(docSchema.safeParse(input).success);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(
    canonicalDocument(editorDocumentSchema.nodeFromJSON(input).toJSON()),
    canonicalDocument(input),
  );
  const omittedDefaults: Doc = {
    type: "doc",
    content: [
      {
        type: "orderedList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "One" }] },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(docSchema.parse(omittedDefaults), omittedDefaults);
  assert.ok(
    docSchema.safeParse({ type: "doc", content: [{ type: "paragraph" }] })
      .success,
  );
});
test("canonical schema rejects invalid structures, attributes, marks, links and overlarge/deep documents", () => {
  const bad: unknown[] = [
    { type: "doc", content: [] },
    { type: "doc", content: [{ type: "text", text: "Outside paragraph" }] },
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "heading", attrs: { level: 2 } }],
        },
      ],
    },
    {
      type: "doc",
      content: [{ type: "bulletList", content: [{ type: "paragraph" }] }],
    },
    {
      type: "doc",
      content: [
        {
          type: "listItem",
          content: [{ type: "heading", attrs: { level: 2 } }],
        },
      ],
    },
    { type: "doc", content: [{ type: "heading", attrs: { level: 7 } }] },
    {
      type: "doc",
      content: [{ type: "paragraph", attrs: { invisible: "value" } }],
    },
    {
      type: "doc",
      content: [{ type: "image", attrs: { src: "https://example.com" } }],
    },
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "X", marks: [{ type: "unknown" }] }],
        },
      ],
    },
    {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "X", marks: [{ type: "bold" }] }],
        },
      ],
    },
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "X",
              marks: [{ type: "bold" }, { type: "code" }],
            },
          ],
        },
      ],
    },
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Link",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
      ],
    },
    textDoc("x".repeat(500001)),
  ];
  let deep: Record<string, unknown> = { type: "paragraph" };
  for (let i = 0; i < 24; i++) deep = { type: "blockquote", content: [deep] };
  bad.push({ type: "doc", content: [deep] });
  for (const value of bad)
    assert.equal(
      docSchema.safeParse(value).success,
      false,
      JSON.stringify(value).slice(0, 180),
    );
});
test("localized canonical revision preserves heading, unrelated nested lists, code, links and sections exactly", () => {
  const original = structuredClone(richDesignDocument),
    payload: DocumentPayload = {
      version: 2,
      action: "revise_section",
      heading: "Movement",
      body: movementRefinement(),
    };
  const revised = materializeDocument(original, payload),
    section = documentSections(original).find((s) => s.heading === "Movement")!;
  assert.deepEqual(
    revised.content!.slice(0, section.start + 1),
    original.content!.slice(0, section.start + 1),
  );
  assert.deepEqual(
    revised.content!.slice(section.start + 1 + payload.body.length),
    original.content!.slice(section.end),
  );
  assert.deepEqual(original, richDesignDocument);
  assert.throws(
    () =>
      materializeDocument(original, {
        ...payload,
        body: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Extraction" }],
          },
        ],
      }),
    /outside/,
  );
  assert.throws(
    () => materializeDocument(original, { ...payload, heading: "Missing" }),
    /unique/,
  );
  assert.throws(
    () =>
      materializeDocument(
        { ...original, content: [...original.content!, original.content![2]] },
        payload,
      ),
    /unique/,
  );
});
test("whole-node context retains canonical formatting and rejects incomplete chapter/section replacements", () => {
  const f = fixture();
  try {
    const full = buildContext(f.store, f.chapter.id, []);
    assert.deepEqual(full.active.content, richDesignDocument);
    assert.equal(full.documentReceipt!.complete, true);
    const partial = documentExcerpt(
      richDesignDocument,
      1800,
      "Rewrite Movement only",
    );
    assert.ok(docSchema.safeParse(partial.document).success);
    assert.equal(partial.receipt.complete, false);
    assert.ok(partial.receipt.completeSections.includes("Movement"));
    assert.throws(
      () =>
        offer(
          f,
          {
            version: 2,
            action: "update_chapter",
            document: textDoc("Lossy full replacement"),
          },
          partial.receipt,
        ),
      /complete original/,
    );
    assert.throws(
      () =>
        offer(
          f,
          {
            version: 2,
            action: "revise_section",
            heading: "Movement",
            body: movementRefinement(),
          },
          { complete: false, includedBlockIndexes: [], completeSections: [] },
        ),
      /entire target section/,
    );
    const p = offer(
      f,
      {
        version: 2,
        action: "revise_section",
        heading: "Movement",
        body: movementRefinement(),
      },
      partial.receipt,
    );
    assert.ok(documentProposalSafety(p).safe);
    const huge = f.store.updateChapter(f.chapter.id, {
      revision: f.chapter.revision,
      content: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Huge" }],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "x".repeat(80000) }],
          },
        ],
      },
    });
    const ctx = buildContext(f.store, huge.id, []);
    assert.equal(ctx.activeTruncated, true);
    assert.equal(ctx.documentReceipt!.complete, false);
  } finally {
    f.db.close();
  }
});
test("canonical full replacement, approval snapshots, exactly-once acceptance and restoration retain exact provenance", () => {
  const f = fixture();
  try {
    const approved = f.store.approveChapter(f.chapter.id, f.chapter.revision);
    f.chapter = approved;
    const changed = structuredClone(richDesignDocument);
    const paragraph = changed.content![3];
    (paragraph.content as any[])[0].marks = [{ type: "underline" }];
    (paragraph.content as any[])[3].marks[0].attrs.href =
      "https://example.com/changed";
    const p = offer(f, {
      version: 2,
      action: "update_chapter",
      document: changed,
    });
    assert.ok(documentProposalSafety(p).safe);
    assert.equal(f.store.chapter(f.chapter.id).status, "Approved");
    f.store.reviewProposal(p.id, "accept");
    const current = f.store.chapter(f.chapter.id);
    assert.deepEqual(current.content, changed);
    assert.equal(current.status, "Proposed");
    assert.equal(current.changedSinceApproval, true);
    assert.deepEqual(
      f.store.approvedChapter(current.id)!.content,
      richDesignDocument,
    );
    const h = f.store.history(current.id)[0];
    assert.equal(h.proposalId, p.id);
    assert.equal(h.origin, "proposal");
    assert.equal(p.document!.sourceRevision, approved.revision);
    assert.ok(p.conversationId && p.messageId);
    assert.throws(() => f.store.reviewProposal(p.id, "accept"), /already/);
    const restored = f.store.restoreChapter(
      current.id,
      approved.revision,
      current.revision,
    );
    assert.deepEqual(restored.content, richDesignDocument);
    assert.ok(restored.revision > current.revision);
    assert.ok(
      f.store.history(current.id).some((h) => h.revision === current.revision),
    );
  } finally {
    f.db.close();
  }
});
test("rejection, stale source edits, cross-project targets and history failures cannot mutate canonical documents", () => {
  const f = fixture();
  try {
    const p = offer(f, {
      version: 2,
      action: "revise_section",
      heading: "Movement",
      body: movementRefinement(),
    });
    f.store.reviewProposal(p.id, "reject");
    assert.deepEqual(f.store.chapter(f.chapter.id), f.chapter);
    const stale = offer(f, {
      version: 2,
      action: "update_chapter",
      document: textDoc("Proposed"),
    });
    f.store.updateChapter(f.chapter.id, {
      revision: f.chapter.revision,
      title: "Newer manual title",
    });
    assert.throws(() => f.store.reviewProposal(stale.id, "accept"), /changed/);
    f.chapter = f.store.chapter(f.chapter.id);
    const next = offer(f, {
      version: 2,
      action: "revise_section",
      heading: "Movement",
      body: movementRefinement(),
    });
    const before = f.store.chapter(f.chapter.id),
      history = f.store.history(before.id);
    f.db.exec(
      "CREATE TRIGGER fail_doc_history BEFORE INSERT ON chapter_revisions WHEN NEW.origin='proposal' BEGIN SELECT RAISE(ABORT,'History failure'); END;",
    );
    assert.throws(
      () => f.store.reviewProposal(next.id, "accept"),
      /History failure/,
    );
    assert.deepEqual(f.store.chapter(before.id), before);
    assert.deepEqual(f.store.history(before.id), history);
    assert.equal(
      f.store.workshop(before.id).proposals.find((p) => p.id === next.id)!
        .status,
      "pending",
    );
    f.db.exec("DROP TRIGGER fail_doc_history");
    const other = f.store.createProject("Other", "");
    const w = f.store.workshop(before.id),
      m = f.store.addMessage(w.conversationId, "assistant", "Foreign target");
    assert.throws(
      () =>
        f.store.addProposal(
          w.conversationId,
          m.id,
          f.project.id,
          {
            ...envelope(f, {
              version: 2,
              action: "update_chapter",
              document: textDoc("Wrong project"),
            }),
            chapterId: f.store.chapters(other.id)[0].id,
          },
          before.revision,
          before,
          documentExcerpt(before.content, 500000).receipt,
          before,
        ),
      /outside/,
    );
    assert.throws(
      () =>
        f.db
          .prepare("UPDATE proposals SET content='{}' WHERE id=?")
          .run(next.id),
      /immutable/,
    );
  } finally {
    f.db.close();
  }
});
test("legacy full replacements require regeneration, safe stored additions/revisions remain exact and unsafe scope is blocked", () => {
  const f = fixture();
  try {
    const w = f.store.workshop(f.chapter.id),
      m = f.store.addMessage(w.conversationId, "assistant", "Legacy response");
    const full = f.store.addProposal(
      w.conversationId,
      m.id,
      f.project.id,
      {
        kind: "update_chapter",
        chapterId: f.chapter.id,
        title: f.chapter.title,
        content: "Old flattened replacement",
        reason: "Legacy",
      },
      f.chapter.revision,
      f.chapter,
    );
    assert.equal(documentProposalSafety(full).safe, false);
    assert.throws(
      () => f.store.reviewProposal(full.id, "accept"),
      /Legacy full/,
    );
    assert.deepEqual(f.store.chapter(f.chapter.id).content, richDesignDocument);
    const addition = f.store.addProposal(
      w.conversationId,
      m.id,
      f.project.id,
      {
        kind: "create_chapter",
        chapterId: null,
        title: "World",
        content: "## World\n\n**Explore** carefully.",
        reason: "Legacy",
      },
      null,
    );
    const stored = JSON.stringify(addition.content);
    assert.ok(documentProposalSafety(addition).safe);
    f.store.reviewProposal(addition.id, "accept");
    assert.equal(
      JSON.stringify(
        f.store
          .workshop(f.chapter.id)
          .proposals.find((p) => p.id === addition.id)!.content,
      ),
      stored,
    );
    const section = f.store.addProposal(
      w.conversationId,
      m.id,
      f.project.id,
      {
        kind: "revise_section",
        chapterId: f.chapter.id,
        title: f.chapter.title,
        section: "Movement",
        content: "**Legacy** localized body.",
        reason: "Legacy",
      },
      f.chapter.revision,
      f.chapter,
    );
    assert.ok(documentProposalSafety(section).safe);
    const altered = {
      ...section,
      content: textDoc("Would remove unrelated chapters"),
    };
    assert.equal(documentProposalSafety(altered).safe, false);
    f.store.reviewProposal(section.id, "accept");
    const after = f.store.chapter(f.chapter.id);
    assert.deepEqual(
      after.content.content!.slice(-6),
      richDesignDocument.content!.slice(-6),
    );
    const unsupported = {
      ...addition,
      content: { type: "doc", content: [{ type: "image" }] } as Doc,
    };
    assert.equal(documentProposalSafety(unsupported).safe, false);
  } finally {
    f.db.close();
  }
});
test("streamed conversation generates canonical JSON proposals and acceptance preserves the complete saved document", async () => {
  const f = fixture(),
    app = createApp(f.store, {
      aiConfigured: true,
      assistant: async (ctx) => {
        assert.deepEqual(ctx.active.content, richDesignDocument);
        assert.equal(ctx.documentReceipt!.complete, true);
        return answerSchema.parse({
          reply: "Review this focused movement change.",
          proposals: [
            envelope(f, {
              version: 2,
              action: "revise_section",
              heading: "Movement",
              body: movementRefinement(),
            }),
          ],
        });
      },
    });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: {
        content: "Rewrite Movement only, keeping other sections and links.",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes("event: error"));
    const p = f.store.workshop(f.chapter.id).proposals[0];
    assert.equal(p.document!.payload.version, 2);
    assert.deepEqual(f.store.chapter(f.chapter.id).content, richDesignDocument);
    const accepted = await app.inject({
      method: "POST",
      url: `/api/proposals/${p.id}/review`,
      payload: { decision: "accept" },
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(
      f.store.chapter(f.chapter.id).content,
      materializeDocument(richDesignDocument, {
        version: 2,
        action: "revise_section",
        heading: "Movement",
        body: movementRefinement(),
      }),
    );
  } finally {
    await app.close();
    f.db.close();
  }
});
test("provider adapter sends actual rich JSON, recursive strict schema and parses canonical transport output", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  let seen = false;
  try {
    globalThis.fetch = async (_url, input) => {
      const body = JSON.parse(String(input!.body)),
        system = body.messages[1].content;
      assert.ok(system.includes('"type":"orderedList"'));
      assert.ok(system.includes("movement-old"));
      assert.ok(system.includes('"marks"'));
      assert.ok(body.response_format.json_schema.schema.$defs.document);
      const variant =
        body.response_format.json_schema.schema.properties.proposals.items.anyOf.find(
          (s: any) => s.properties.kind.enum[0] === "document",
        );
      assert.equal(variant.properties.document.anyOf.length, 5);
      seen = true;
      const result = JSON.stringify({
        reply: "Review the canonical change",
        proposals: [
          envelope(f, {
            version: 2,
            action: "revise_section",
            heading: "Movement",
            body: movementRefinement(),
          }),
        ],
      });
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: result }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    };
    const result = await openAIAssistant(
      buildContext(f.store, f.chapter.id, []),
      new AbortController().signal,
      () => {},
    );
    assert.equal(result.proposals[0].kind, "document");
    assert.ok(seen);
  } finally {
    globalThis.fetch = original;
    f.db.close();
  }
});
test("canonical proposals, applied rich content and approved original sources survive database reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-document-")),
    path = join(dir, "fixture.sqlite");
  let f = fixture(path);
  try {
    f.chapter = f.store.approveChapter(f.chapter.id, f.chapter.revision);
    const p = offer(f, {
      version: 2,
      action: "revise_section",
      heading: "Movement",
      body: movementRefinement(),
    });
    f.store.reviewProposal(p.id, "accept");
    const expected = f.store.chapter(f.chapter.id).content;
    f.db.close();
    const db = openDatabase(path),
      store = new Store(db);
    f = { ...f, db, store };
    assert.deepEqual(store.chapter(f.chapter.id).content, expected);
    assert.deepEqual(
      store.approvedChapter(f.chapter.id)!.content,
      richDesignDocument,
    );
    assert.equal(
      store.workshop(f.chapter.id).proposals[0].document!.payload.version,
      2,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM migrations WHERE version=7").get()!.n,
      1,
    );
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical creation, child creation and section addition apply exact JSON with saved source evidence", () => {
  const f = fixture();
  try {
    for (const action of ["create_chapter", "create_subchapter"] as const) {
      const doc: Doc = {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "New subject" }],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "A bold subject",
                marks: [{ type: "bold" }],
              },
            ],
          },
        ],
      };
      const p = offer(f, { version: 2, action, document: doc });
      assert.equal(p.before, null);
      f.store.reviewProposal(p.id, "accept");
      const c = f.store
        .chapters(f.project.id)
        .find(
          (c) =>
            c.id !== f.chapter.id &&
            c.parentId ===
              (action === "create_subchapter" ? f.chapter.id : null),
        )!;
      assert.deepEqual(c.content, doc);
      assert.equal(p.document!.sourceRevision, f.chapter.revision);
    }
    const p = offer(f, {
      version: 2,
      action: "add_section",
      heading: "Progression",
      level: 2,
      body: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Upgrade deliberately",
              marks: [{ type: "italic" }],
            },
          ],
        },
      ],
    });
    f.store.reviewProposal(p.id, "accept");
    const saved = f.store.chapter(f.chapter.id);
    assert.deepEqual(
      saved.content.content!.slice(0, richDesignDocument.content!.length),
      richDesignDocument.content,
    );
    assert.equal(saved.content.content!.at(-2)!.type, "heading");
  } finally {
    f.db.close();
  }
});

test("malformed and retired provider document operations roll back the whole response without overwriting data", async () => {
  const f = fixture();
  let mode = "invalid";
  const app = createApp(f.store, {
    aiConfigured: true,
    assistant: async () => {
      if (mode === "invalid")
        return {
          reply: "Bad document",
          proposals: [
            {
              ...envelope(f, {
                version: 2,
                action: "update_chapter",
                document: textDoc("Valid"),
              }),
              document: {
                version: 2,
                action: "update_chapter",
                document: {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "heading", attrs: { level: 2 } }],
                    },
                  ],
                },
              },
            },
          ],
        } as any;
      return {
        reply: "Retired format",
        proposals: [
          {
            kind: "update_chapter",
            chapterId: f.chapter.id,
            title: "Old output",
            content: "Flat text",
            reason: "Unsupported pipeline",
          },
        ],
      };
    },
  });
  try {
    for (const current of ["invalid", "legacy"]) {
      mode = current;
      const response = await app.inject({
        method: "POST",
        url: `/api/chapters/${f.chapter.id}/chat`,
        payload: { content: "Revise" },
      });
      assert.ok(response.body.includes("event: error"));
      assert.equal(f.store.workshop(f.chapter.id).proposals.length, 0);
      assert.deepEqual(
        f.store.chapter(f.chapter.id).content,
        richDesignDocument,
      );
    }
  } finally {
    await app.close();
    f.db.close();
  }
});

test("partial canonical context permits a supplied section but rejects full replacement through the chat route", async () => {
  const f = fixture();
  f.chapter = f.store.updateChapter(f.chapter.id, {
    revision: f.chapter.revision,
    content: {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Movement" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Responsive movement" }],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "World" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "x".repeat(80000) }],
        },
      ],
    },
  });
  let full = true;
  const app = createApp(f.store, {
    aiConfigured: true,
    assistant: async (ctx) => {
      assert.equal(ctx.documentReceipt!.complete, false);
      assert.ok(ctx.documentReceipt!.completeSections.includes("Movement"));
      return {
        reply: "A bounded edit",
        proposals: [
          envelope(
            f,
            full
              ? {
                  version: 2,
                  action: "update_chapter",
                  document: textDoc("Only what was seen"),
                }
              : {
                  version: 2,
                  action: "revise_section",
                  heading: "Movement",
                  body: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Refined controls" }],
                    },
                  ],
                },
          ),
        ],
      };
    },
  });
  try {
    const failed = await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Rewrite Movement" },
    });
    assert.ok(failed.body.includes("event: error"));
    assert.equal(f.store.workshop(f.chapter.id).proposals.length, 0);
    full = false;
    await app.inject({
      method: "POST",
      url: `/api/chapters/${f.chapter.id}/chat`,
      payload: { content: "Rewrite Movement only" },
    });
    const p = f.store.workshop(f.chapter.id).proposals[0];
    assert.ok(p.document && !p.document.receipt.complete);
    f.store.reviewProposal(p.id, "accept");
    assert.deepEqual(
      f.store.chapter(f.chapter.id).content.content!.slice(-2),
      f.chapter.content.content!.slice(-2),
    );
  } finally {
    await app.close();
    f.db.close();
  }
});

test("migration 7 preserves accepted/pending legacy evidence and all saved versions; failure rolls back and retries", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-document-migration-")),
    path = join(dir, "legacy.sqlite");
  const f = fixture(path);
  let db = f.db;
  try {
    const w = f.store.workshop(f.chapter.id),
      m = f.store.addMessage(
        w.conversationId,
        "assistant",
        "Original legacy evidence",
      ),
      pending = f.store.addProposal(
        w.conversationId,
        m.id,
        f.project.id,
        {
          kind: "update_chapter",
          chapterId: f.chapter.id,
          title: "Pending old replacement",
          content: "Legacy text",
          reason: "Legacy",
        },
        f.chapter.revision,
        f.chapter,
      ),
      accepted = f.store.addProposal(
        w.conversationId,
        m.id,
        f.project.id,
        {
          kind: "create_chapter",
          chapterId: null,
          title: "Already reviewed world",
          content: "**Existing** history",
          reason: "Legacy",
        },
        null,
      );
    f.store.reviewProposal(accepted.id, "accept");
    const snapshots = f.store.history(f.chapter.id),
      proposals = f.store.workshop(f.chapter.id).proposals,
      chapters = f.store.chapters(f.project.id);
    db.exec(
      "DROP TRIGGER document_proposal_immutable; DROP TRIGGER canonical_proposal_content_immutable; ALTER TABLE proposals DROP COLUMN document_payload; DELETE FROM migrations WHERE version=7; CREATE TRIGGER document_proposal_immutable BEFORE UPDATE OF title ON proposals BEGIN SELECT 1; END;",
    );
    assert.throws(() => migrateDocumentProposals(db), /already exists/);
    assert.equal(
      db.prepare("SELECT 1 FROM migrations WHERE version=7").get(),
      undefined,
    );
    assert.ok(
      !db
        .prepare("PRAGMA table_info(proposals)")
        .all()
        .some((r) => r.name === "document_payload"),
    );
    db.exec("DROP TRIGGER document_proposal_immutable");
    db.close();
    db = openDatabase(path);
    const store = new Store(db);
    assert.deepEqual(store.history(f.chapter.id), snapshots);
    assert.deepEqual(store.chapters(f.project.id), chapters);
    assert.deepEqual(store.workshop(f.chapter.id).proposals, proposals);
    assert.equal(
      store.workshop(f.chapter.id).proposals.find((p) => p.id === accepted.id)!
        .status,
      "accepted",
    );
    assert.throws(
      () => store.reviewProposal(pending.id, "accept"),
      /Legacy full replacement/,
    );
    migrateDocumentProposals(db);
    assert.equal(
      db.prepare("SELECT count(*) n FROM migrations WHERE version=7").get()!.n,
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
