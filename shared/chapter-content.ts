import type { Doc } from "./types.js";

// Object key order is not a document change. Node/mark order and attributes are.
export function canonicalDocument(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalDocument).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalDocument(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function sameChapterContent(
  a: { title: string; content: Doc },
  b: { title: string; content: Doc },
) {
  return (
    a.title === b.title &&
    canonicalDocument(a.content) === canonicalDocument(b.content)
  );
}
