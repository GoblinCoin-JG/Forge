import { z } from "zod";
import type { KnowledgeSource } from "./knowledge.js";
import type {
  KnowledgeProposalData,
  AppliedKnowledge,
} from "./knowledge-proposals.js";

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
  parentId: z.string().uuid().nullable().optional(),
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
  parentId: string | null;
  title: string;
  content: Doc;
  status: Maturity;
  position: number;
  revision: number;
  updatedAt: string;
  approvedRevision: number | null;
  approvedAt: string | null;
  changedSinceApproval: boolean;
  archivedAt: string | null;
}
export interface ChapterRevision {
  chapterId: string;
  projectId: string;
  revision: number;
  title: string;
  content: Doc;
  status: Maturity;
  parentId: string | null;
  createdAt: string;
  origin:
    | "migration"
    | "create"
    | "manual"
    | "proposal"
    | "restore"
    | "archive"
    | "reparent"
    | "unarchive";
  proposalId: string | null;
  restoredFrom: number | null;
  approvedAt: string | null;
  approvalOrigin: "migration" | "manual" | "proposal" | null;
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
  knowledge?: KnowledgeProposalData | null;
  appliedResult?: AppliedKnowledge | null;
  id: string;
  conversationId: string;
  messageId: string;
  projectId: string;
  chapterId: string | null;
  parentId: string | null;
  title: string;
  content: Doc;
  reason: string;
  baseRevision: number | null;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  kind: ProposalKind;
  description: string;
  section: string | null;
  proposedStatus: Maturity | null;
  relatedChapterIds: string[];
  before: { title: string; content: Doc; status: Maturity } | null;
}
export const proposalKinds = [
  "create_chapter",
  "create_subchapter",
  "update_chapter",
  "add_section",
  "revise_section",
  "change_status",
  "record_decision",
  "record_question",
  "knowledge",
] as const;
export type ProposalKind = (typeof proposalKinds)[number];
export const workflows = [
  "explore",
  "gaps",
  "challenge",
  "improve",
  "organize",
  "extract",
] as const;
export type Workflow = (typeof workflows)[number];
export interface DesignRecord {
  id: string;
  projectId: string;
  kind: "decision" | "question";
  text: string;
  rationale: string;
  relatedChapterIds: string[];
  status: "approved" | "open" | "resolved";
  createdAt: string;
  updatedAt: string;
  revision: number;
  relatedConceptIds: string[];
  supersededBy: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  authoritative: boolean;
  unavailableChapterReferences: { reference: string; reason: string }[];
  sources: KnowledgeSource[];
}
export interface Workshop {
  conversationId: string;
  messages: Message[];
  proposals: Proposal[];
  records: DesignRecord[];
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
