import { z } from "zod";
import { relationshipTypes } from "./knowledge.js";

const ref = z.union([
  z.object({ id: z.string().uuid() }).strict(),
  z
    .object({ newConcept: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/) })
    .strict(),
]);
const refs = z.array(ref).max(20);
const chapters = z
  .array(z.string().uuid())
  .max(20)
  .refine((v) => new Set(v).size === v.length, "Duplicate chapters");
const revision = z.number().int().nonnegative();
const name = z.string().trim().min(1).max(120);
const fields = {
  name,
  category: z.string().trim().min(1).max(80),
  description: z.string().trim().max(20000),
};
const record = {
  text: z.string().trim().min(1).max(20000),
  rationale: z.string().trim().max(10000),
  chapterIds: chapters,
  concepts: refs,
};
const base = { version: z.literal(1) };
export const knowledgePayloadSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...base,
      action: z.literal("create_concept"),
      key: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
      ...fields,
      chapterIds: chapters,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("update_concept"),
      targetId: z.string().uuid(),
      revision,
      ...fields,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("associate_concept"),
      targetId: z.string().uuid(),
      revision,
      chapterIds: chapters,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("create_relationship"),
      source: ref,
      target: ref,
      type: z.enum(relationshipTypes),
      rationale: record.rationale,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("update_relationship"),
      targetId: z.string().uuid(),
      revision,
      source: ref,
      target: ref,
      type: z.enum(relationshipTypes),
      rationale: record.rationale,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("retire_relationship"),
      targetId: z.string().uuid(),
      revision,
    })
    .strict(),
  z
    .object({ ...base, action: z.literal("record_decision"), ...record })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("supersede_decision"),
      targetId: z.string().uuid(),
      revision,
      ...record,
    })
    .strict(),
  z
    .object({ ...base, action: z.literal("record_question"), ...record })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("resolve_question"),
      targetId: z.string().uuid(),
      revision,
      answer: z.string().trim().min(1).max(20000),
    })
    .strict(),
]);
export type KnowledgePayload = z.infer<typeof knowledgePayloadSchema>;
export type ConceptReference = z.infer<typeof ref>;
export type ReviewOutcome = "exploring" | "approve" | "accept";
export interface KnowledgeProposalData {
  payload: KnowledgePayload;
  before: Record<string, unknown> | null;
  guards: {
    entity: "concept" | "relationship" | "record" | "chapter";
    id: string;
    revision: number;
  }[];
  dependencies: { key: string; proposalId: string; title: string }[];
  labels: Record<string, string>;
  sourceChapterId: string;
  sourceRevision: number;
}
export interface AppliedKnowledge {
  entity: "concept" | "relationship" | "record";
  id: string;
  revision: number;
  outcome: ReviewOutcome;
}
export function conceptReferences(p: KnowledgePayload): ConceptReference[] {
  return "source" in p
    ? [p.source, p.target]
    : "concepts" in p
      ? p.concepts
      : [];
}
export function canExplore(p: KnowledgePayload) {
  return [
    "create_concept",
    "update_concept",
    "associate_concept",
    "create_relationship",
    "update_relationship",
  ].includes(p.action);
}
