import { test } from "node:test";
import assert from "node:assert/strict";
import { documentDifferences } from "../shared/document-diff.js";
import { textDoc, type Doc } from "../shared/types.js";

test("structural review exposes marks and link destinations when plain text is unchanged", () => {
  const before: Doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Same words",
            marks: [
              { type: "bold" },
              { type: "link", attrs: { href: "https://example.com/old" } },
            ],
          },
        ],
      },
    ],
  };
  const after: Doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Same words",
            marks: [
              { type: "italic" },
              { type: "link", attrs: { href: "https://example.com/new" } },
            ],
          },
        ],
      },
    ],
  };
  const changes = documentDifferences(before, after);
  assert.equal(changes[0].kind, "modified");
  assert.ok(
    changes[0].details.some((t) => t.includes("bold, link → italic, link")),
  );
  assert.ok(
    changes[0].details.some((t) =>
      t.includes("https://example.com/old → https://example.com/new"),
    ),
  );
});
test("structural review detects heading hierarchy, numbering, list type and nested content changes", () => {
  const before: Doc = {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Combat" }],
      },
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "First" }] },
            ],
          },
        ],
      },
    ],
  };
  const after: Doc = {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: "Combat" }],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Changed" }],
              },
            ],
          },
        ],
      },
    ],
  };
  const summary = documentDifferences(before, after)
    .flatMap((c) => c.details)
    .join(" ");
  assert.ok(summary.includes("heading level 2 → 3"));
  assert.ok(summary.includes("Numbered list → Bullet list"));
  assert.ok(summary.includes("text changed"));
});
test("structural comparison anchors unchanged blocks and identifies additions/removals without mutating inputs", () => {
  const before = textDoc("Keep\n\nRemove\n\nTail"),
    after = textDoc("Keep\n\nTail\n\nNew"),
    snapshot = JSON.stringify([before, after]);
  assert.deepEqual(
    documentDifferences(before, after).map((c) => c.kind),
    ["removed", "added"],
  );
  assert.equal(JSON.stringify([before, after]), snapshot);
  assert.deepEqual(documentDifferences(before, before), []);
});
