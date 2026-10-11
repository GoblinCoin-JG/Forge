import { test } from "node:test";
import assert from "node:assert/strict";
import { designTextDoc, formatPlainDesignText } from "../shared/design-text.js";
import { docSchema, textDoc, docText, type Doc } from "../shared/types.js";
import { openDatabase } from "../server/db.js";
import { Store } from "../server/store.js";

test("AI headings with or without a space become actual editor headings", () => {
  for (const heading of ["##Gameplay Direction", "## Gameplay Direction"]) {
    const doc = designTextDoc(
      `${heading}\nPlay with **purpose**.\n\n### Player experience\nExplore.`,
    );
    assert.equal(docSchema.safeParse(doc).success, true);
    assert.deepEqual(doc.content![0], {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Gameplay Direction" }],
    });
    assert.equal(doc.content![1].type, "paragraph");
    assert.deepEqual((doc.content![1].content as any[])[1], {
      type: "text",
      text: "purpose",
      marks: [{ type: "bold" }],
    });
    assert.equal(doc.content![2].type, "heading");
    assert.doesNotMatch(docText(doc), /##|\*\*/);
  }
});

test("existing plain Markdown is repaired idempotently without changing rich text or code", () => {
  const formatted = {
    type: "paragraph",
    content: [
      { type: "text", text: "## Keep this literal", marks: [{ type: "code" }] },
    ],
  };
  const code = {
    type: "codeBlock",
    content: [{ type: "text", text: "## Code" }],
  };
  const doc: Doc = {
    type: "doc",
    content: [
      ...textDoc("##Gameplay Direction\n\n**Cooperative** salvage.").content!,
      formatted,
      code,
    ],
  };
  const repaired = formatPlainDesignText(doc);
  assert.equal(repaired.content![0].type, "heading");
  assert.deepEqual(repaired.content!.slice(-2), [formatted, code]);
  assert.deepEqual(formatPlainDesignText(repaired), repaired);
  assert.deepEqual(
    formatPlainDesignText(textDoc("C# and ordinary prose")),
    textDoc("C# and ordinary prose"),
  );
});

test("design text preserves code markers and treats HTML as plain text", () => {
  const doc = designTextDoc(
    "- **Discover** relics\n- Return home\n\n1. Scout\n2. Salvage\n\n```\n## literal heading\n**literal bold**\n```\n\n<script>alert('x')</script>",
  );
  assert.equal(docSchema.safeParse(doc).success, true);
  assert.equal(doc.content![0].type, "bulletList");
  assert.equal(doc.content![1].type, "orderedList");
  assert.equal(doc.content![2].type, "codeBlock");
  assert.match(docText(doc), /## literal heading/);
  assert.equal(doc.content![3].type, "paragraph");
});

test("accepted AI chapter and section proposals persist formatted nodes", () => {
  const db = openDatabase(":memory:"),
    store = new Store(db);
  try {
    const project = store.createProject("Salvage", "Curiosity"),
      chapter = store.chapters(project.id)[0],
      w = store.workshop(chapter.id),
      m = store.addMessage(
        w.conversationId,
        "assistant",
        "Review this direction",
      );
    const p = store.addProposal(
      w.conversationId,
      m.id,
      project.id,
      {
        kind: "update_chapter",
        chapterId: chapter.id,
        title: chapter.title,
        content: "##Gameplay Direction\n\n**Cooperative** discovery.",
        reason: "Clarify direction",
      },
      0,
    );
    assert.equal(p.content.content![0].type, "heading");
    assert.deepEqual(store.chapter(chapter.id).content, chapter.content);
    store.reviewProposal(p.id, "accept");
    assert.deepEqual(store.chapter(chapter.id).content, p.content);
    const section = store.addProposal(
      w.conversationId,
      m.id,
      project.id,
      {
        kind: "revise_section",
        chapterId: chapter.id,
        title: chapter.title,
        section: "Gameplay Direction",
        content: "**Shared** discovery.",
        reason: "Focus cooperation",
      },
      1,
    );
    store.reviewProposal(section.id, "accept");
    const nodes = store.chapter(chapter.id).content.content!;
    assert.equal(nodes[0].type, "heading");
    assert.deepEqual((nodes[1].content as any[])[0].marks, [{ type: "bold" }]);
  } finally {
    db.close();
  }
});
