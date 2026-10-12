import type { Doc } from "./types.js";
import { canonicalDocument } from "./chapter-content.js";

type Node = Record<string, unknown>;
export interface DocumentDifference {
  kind: "added" | "removed" | "modified";
  label: string;
  details: string[];
}
const labels: Record<string, string> = {
  paragraph: "Paragraph",
  heading: "Heading",
  bulletList: "Bullet list",
  orderedList: "Numbered list",
  listItem: "List item",
  blockquote: "Blockquote",
  codeBlock: "Code block",
  horizontalRule: "Divider",
  hardBreak: "Line break",
  text: "Text",
};
function label(node: Node) {
  const attrs = node.attrs as Record<string, unknown> | undefined;
  return node.type === "heading"
    ? `Heading ${attrs?.level ?? ""}`
    : (labels[String(node.type)] ?? "Document node");
}
function facts(node: Node, prefix: string): string[] {
  const out: string[] = [];
  if (typeof node.text === "string")
    out.push(
      `${prefix} text: ${node.text.length > 100 ? node.text.slice(0, 100) + "…" : node.text}`,
    );
  const attrs = node.attrs as Record<string, unknown> | undefined;
  if (node.type === "heading")
    out.push(`${prefix} heading level ${String(attrs?.level ?? 1)}`);
  if (node.type === "orderedList")
    out.push(
      `${prefix} numbered list starting at ${String(attrs?.start ?? 1)}`,
    );
  for (const mark of (node.marks ?? []) as Node[])
    out.push(
      mark.type === "link"
        ? `${prefix} link destination: ${String((mark.attrs as Record<string, unknown>)?.href)}`
        : `${prefix} formatting: ${String(mark.type)}`,
    );
  for (const child of (node.content ?? []) as Node[])
    out.push(...facts(child, prefix));
  return out;
}
function modifications(a: Node, b: Node, path: string, changes: string[]) {
  if (a.type !== b.type) changes.push(`${path}: ${label(a)} → ${label(b)}`);
  const aa = (a.attrs ?? {}) as Record<string, unknown>,
    ba = (b.attrs ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(aa), ...Object.keys(ba)]))
    if (canonicalDocument(aa[key]) !== canonicalDocument(ba[key])) {
      const name =
        key === "level"
          ? "heading level"
          : key === "start"
            ? "numbering starts at"
            : key === "language"
              ? "code language"
              : key;
      changes.push(
        `${path}: ${name} ${String(aa[key] ?? "default")} → ${String(ba[key] ?? "default")}`,
      );
    }
  if (a.text !== b.text) changes.push(`${path}: text changed`);
  const am = (a.marks ?? []) as Node[],
    bm = (b.marks ?? []) as Node[];
  const marks = (m: Node[]) =>
    m.map((v) => String(v.type)).join(", ") || "plain text";
  if (am.map((v) => v.type).join(",") !== bm.map((v) => v.type).join(","))
    changes.push(`${path}: formatting ${marks(am)} → ${marks(bm)}`);
  for (const type of new Set([...am, ...bm].map((v) => String(v.type)))) {
    const old = am.find((m) => m.type === type)?.attrs as
        Record<string, unknown> | undefined,
      next = bm.find((m) => m.type === type)?.attrs as
        Record<string, unknown> | undefined;
    if (canonicalDocument(old) !== canonicalDocument(next)) {
      if (type === "link" && old?.href !== next?.href)
        changes.push(
          `${path}: link destination ${String(old?.href ?? "none")} → ${String(next?.href ?? "none")}`,
        );
      else changes.push(`${path}: ${type} attributes changed`);
    }
  }
  const ac = (a.content ?? []) as Node[],
    bc = (b.content ?? []) as Node[];
  if (ac.length !== bc.length)
    changes.push(`${path}: child structure ${ac.length} → ${bc.length}`);
  for (let i = 0; i < Math.min(ac.length, bc.length); i++)
    if (canonicalDocument(ac[i]) !== canonicalDocument(bc[i]))
      modifications(
        ac[i],
        bc[i],
        `${path} / ${label(bc[i])} ${i + 1}`,
        changes,
      );
  for (const node of ac.slice(bc.length))
    changes.push(...facts(node, "Removed"));
  for (const node of bc.slice(ac.length)) changes.push(...facts(node, "Added"));
}

// A structural review aid only. It never patches or reconstructs documents.
// Exact unchanged blocks anchor a bounded LCS; changed gaps align by position.
export function documentDifferences(
  before: Doc,
  after: Doc,
): DocumentDifference[] {
  const a = before.content ?? [],
    b = after.content ?? [],
    ak = a.map(canonicalDocument),
    bk = b.map(canonicalDocument);
  const out: DocumentDifference[] = [];
  const changed = (
    old: Node | undefined,
    next: Node | undefined,
    index: number,
  ) => {
    if (old && next && canonicalDocument(old) === canonicalDocument(next))
      return;
    const details: string[] = [];
    if (old && next) modifications(old, next, "Block", details);
    else details.push(...facts(next ?? old!, next ? "Added" : "Removed"));
    out.push({
      kind: !old ? "added" : !next ? "removed" : "modified",
      label: `${label(next ?? old!)} · block ${index + 1}`,
      details: details.length
        ? details
        : [
            !old
              ? "Content and structure added"
              : !next
                ? "Content and structure removed"
                : "Document structure changed",
          ],
    });
  };
  if (a.length * b.length > 160000) {
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      changed(a[i], b[i], i);
    return out;
  }
  const rows = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      rows[i][j] =
        ak[i] === bk[j]
          ? rows[i + 1][j + 1] + 1
          : Math.max(rows[i + 1][j], rows[i][j + 1]);
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && ak[i] === bk[j]) {
      i++;
      j++;
      continue;
    }
    const oldStart = i,
      newStart = j;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && ak[i] === bk[j]) break;
      if (j >= b.length || (i < a.length && rows[i + 1][j] >= rows[i][j + 1]))
        i++;
      else j++;
    }
    for (let n = 0; n < Math.max(i - oldStart, j - newStart); n++)
      changed(
        n < i - oldStart ? a[oldStart + n] : undefined,
        n < j - newStart ? b[newStart + n] : undefined,
        newStart + n,
      );
  }
  return out;
}
