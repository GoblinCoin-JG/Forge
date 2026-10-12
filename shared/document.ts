import { z } from "zod";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

export type Doc = { type: "doc"; content?: Record<string, unknown>[] };
// The same content extensions and link attributes as the live editor/history.
export function documentExtensions() {
  return [
    StarterKit.configure({
      trailingNode: false,
      link: {
        openOnClick: false,
        HTMLAttributes: { rel: "noopener noreferrer" },
      },
    }),
  ];
}
export const editorDocumentSchema = getSchema(documentExtensions());
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
function validateTree(value: unknown, mark = false, depth = 0): boolean {
  if (depth > 20 || !object(value) || typeof value.type !== "string")
    return false;
  const spec = mark
    ? editorDocumentSchema.marks[value.type]
    : editorDocumentSchema.nodes[value.type];
  if (!spec) return false;
  const allowed = new Set(
    mark
      ? ["type", "attrs"]
      : value.type === "text"
        ? ["type", "text", "marks"]
        : ["type", "attrs", "content", "marks"],
  );
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (value.attrs !== undefined) {
    if (
      !object(value.attrs) ||
      Object.keys(value.attrs).some(
        (key) => !Object.hasOwn(spec.spec.attrs ?? {}, key),
      )
    )
      return false;
    for (const [key, item] of Object.entries(value.attrs)) {
      if (
        key === "level" &&
        (!Number.isInteger(item) || Number(item) < 1 || Number(item) > 6)
      )
        return false;
      if (key === "start" && (!Number.isInteger(item) || Number(item) < 1))
        return false;
      if (
        key !== "level" &&
        key !== "start" &&
        item !== null &&
        typeof item !== "string"
      )
        return false;
      if (
        value.type === "orderedList" &&
        key === "type" &&
        item !== null &&
        !["1", "a", "A", "i", "I"].includes(String(item))
      )
        return false;
    }
  }
  if (mark) {
    if (value.type === "link") {
      const href = object(value.attrs) ? value.attrs.href : undefined;
      if (
        typeof href !== "string" ||
        !/^(https?:|mailto:)/i.test(href) ||
        /[\u0000-\u001f\u007f]/.test(href)
      )
        return false;
      try {
        const url = new URL(href);
        if (!["http:", "https:", "mailto:"].includes(url.protocol))
          return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  if (
    value.type === "text" &&
    (typeof value.text !== "string" || !value.text.length)
  )
    return false;
  if (value.type !== "text" && value.text !== undefined) return false;
  if (
    value.marks !== undefined &&
    value.type !== "text" &&
    value.type !== "hardBreak"
  )
    return false;
  if (
    value.content !== undefined &&
    (!Array.isArray(value.content) ||
      !value.content.every((child) => validateTree(child, false, depth + 1)))
  )
    return false;
  if (
    value.marks !== undefined &&
    (!Array.isArray(value.marks) ||
      !value.marks.every((child) => validateTree(child, true, depth + 1)))
  )
    return false;
  return true;
}
export function validDocument(value: unknown): value is Doc {
  if (!object(value) || value.type !== "doc" || !validateTree(value))
    return false;
  try {
    if (JSON.stringify(value).length > 500000) return false;
    editorDocumentSchema.nodeFromJSON(value).check();
    return true;
  } catch {
    return false;
  }
}
// Validate without returning ProseMirror's normalized JSON: defaults and source
// attribute omissions remain exactly as submitted; unsupported data is rejected.
export const docSchema = z.custom<Doc>(
  validDocument,
  "Invalid canonical rich-text document",
);
export const documentFragmentSchema = z
  .array(z.record(z.unknown()))
  .refine(
    (nodes) =>
      validDocument({
        type: "doc",
        content: nodes.length ? nodes : [{ type: "paragraph" }],
      }),
    "Invalid rich-text section fragment",
  );
