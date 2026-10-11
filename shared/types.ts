import { z } from "zod";

export const statuses = [
  "Exploring",
  "Proposed",
  "Approved",
  "Needs Revision",
] as const;
export type Maturity = (typeof statuses)[number];
export type Doc = { type: "doc"; content?: Record<string, unknown>[] };
const nodeTypes = new Set([
  "paragraph",
  "text",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "hardBreak",
  "horizontalRule",
  "codeBlock",
]);
function validNode(node: unknown, depth = 0): boolean {
  if (depth > 20 || !node || typeof node !== "object" || Array.isArray(node))
    return false;
  const n = node as Record<string, unknown>;
  if (typeof n.type !== "string" || !nodeTypes.has(n.type)) return false;
  if (n.type === "text" && (typeof n.text !== "string" || n.text.length === 0))
    return false;
  if (n.type !== "text" && n.text !== undefined) return false;
  if (
    n.attrs !== undefined &&
    (!n.attrs || typeof n.attrs !== "object" || Array.isArray(n.attrs))
  )
    return false;
  if (
    n.type === "heading" &&
    ![1, 2, 3, 4, 5, 6].includes((n.attrs as { level?: number })?.level ?? 0)
  )
    return false;
  if (
    n.content !== undefined &&
    (!Array.isArray(n.content) ||
      !n.content.every((child) => validNode(child, depth + 1)))
  )
    return false;
  if (
    n.marks !== undefined &&
    (!Array.isArray(n.marks) ||
      !n.marks.every((mark) => {
        if (!mark || typeof mark !== "object") return false;
        if (
          !["bold", "italic", "strike", "code", "underline", "link"].includes(
            mark.type,
          )
        )
          return false;
        return (
          mark.type !== "link" ||
          (typeof mark.attrs?.href === "string" &&
            /^(https?:|mailto:)/i.test(mark.attrs.href))
        );
      }))
  )
    return false;
  return true;
}
export const docSchema = z
  .object({
    type: z.literal("doc"),
    content: z.array(z.record(z.unknown())).optional(),
  })
  .strict()
  .refine((v) => JSON.stringify(v).length <= 500_000, "Chapter is too large")
  .refine(
    (v) => !v.content || v.content.every((n) => validNode(n)),
    "Invalid rich-text document",
  );
export const projectInput = z.object({
  title: z.string().trim().max(120).default(""),
  premise: z.string().trim().max(20000).default(""),
});
export const chapterInput = z.object({
  title: z.string().trim().min(1).max(120),
  content: docSchema.optional(),
  status: z.enum(statuses).optional(),
});
export const chapterUpdate = chapterInput
  .partial()
  .extend({ revision: z.number().int().nonnegative() });
export interface Project {
  id: string;
  title: string;
  premise: string;
  createdAt: string;
  updatedAt: string;
  chapterCount: number;
}
export interface Chapter {
  id: string;
  projectId: string;
  title: string;
  content: Doc;
  status: Maturity;
  position: number;
  revision: number;
  updatedAt: string;
}
export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  state: "complete" | "interrupted" | "failed";
  createdAt: string;
}
export interface Proposal {
  id: string;
  conversationId: string;
  messageId: string;
  projectId: string;
  chapterId: string | null;
  title: string;
  content: Doc;
  reason: string;
  baseRevision: number | null;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}
export interface Workshop {
  conversationId: string;
  messages: Message[];
  proposals: Proposal[];
}
export function textDoc(text: string): Doc {
  return {
    type: "doc",
    content: text
      .split(/\n\s*\n/)
      .filter(Boolean)
      .map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
  };
}
export function docText(doc: Doc): string {
  function walk(node: Record<string, unknown>): string {
    if (typeof node.text === "string") return node.text;
    if (!Array.isArray(node.content)) return "";
    return node.content
      .map((n) => walk(n as Record<string, unknown>))
      .join(
        ["doc", "bulletList", "orderedList"].includes(String(node.type))
          ? "\n\n"
          : "",
      );
  }
  return walk(doc);
}
