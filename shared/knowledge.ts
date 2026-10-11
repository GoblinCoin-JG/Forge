import { z } from "zod";
import type { Maturity, DesignRecord } from "./types.js";

export const relationshipTypes = [
  "depends_on",
  "interacts_with",
  "affects",
  "part_of",
  "conflicts_with",
] as const;
export type RelationshipType = (typeof relationshipTypes)[number];
export const symmetricRelationships = new Set<RelationshipType>([
  "interacts_with",
  "conflicts_with",
]);
export const expectedRevision = z.number().int().nonnegative();
export const sourceInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z
    .object({
      kind: z.literal("chapter"),
      chapterId: z.string().uuid(),
      revision: expectedRevision,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workshop"),
      conversationId: z.string().uuid(),
      messageId: z.string().uuid().optional(),
    })
    .strict(),
]);
export type SourceInput = z.infer<typeof sourceInput>;
const name = z.string().trim().min(1).max(120);
const rationale = z.string().trim().max(10000);
const ids = z
  .array(z.string().uuid())
  .max(100)
  .refine((v) => new Set(v).size === v.length, "References must be unique");
const draftStatus = z.enum(["Exploring", "Proposed", "Needs Revision"]);
export const conceptInput = z
  .object({
    name,
    category: z.string().trim().min(1).max(80).default("mechanic"),
    description: z.string().trim().max(20000).default(""),
    source: sourceInput.optional(),
  })
  .strict();
export const conceptUpdate = conceptInput
  .omit({ source: true })
  .partial()
  .extend({
    revision: expectedRevision,
    status: draftStatus.optional(),
    source: sourceInput.optional(),
  })
  .strict();
export const revisionAction = z
  .object({ revision: expectedRevision, source: sourceInput.optional() })
  .strict();
export const conceptRestore = revisionAction
  .extend({ name: name.optional() })
  .strict();
export const associationInput = revisionAction
  .extend({ chapterIds: ids, conceptIds: ids.optional() })
  .strict();
export const relationshipInput = z
  .object({
    sourceConceptId: z.string().uuid(),
    targetConceptId: z.string().uuid(),
    type: z.enum(relationshipTypes),
    rationale: rationale.default(""),
    source: sourceInput.optional(),
  })
  .strict();
export const relationshipUpdate = relationshipInput
  .omit({ source: true })
  .partial()
  .extend({
    revision: expectedRevision,
    status: draftStatus.optional(),
    source: sourceInput.optional(),
  })
  .strict();
export const recordInput = z
  .object({
    text: z.string().trim().min(1).max(100000),
    rationale: rationale.default(""),
    chapterIds: ids.default([]),
    conceptIds: ids.default([]),
    source: sourceInput.optional(),
  })
  .strict();
export const supersedeInput = recordInput
  .omit({ chapterIds: true, conceptIds: true })
  .extend({
    revision: expectedRevision,
    chapterIds: ids.optional(),
    conceptIds: ids.optional(),
  })
  .strict();
export const recordLinksInput = revisionAction
  .extend({ chapterIds: ids, conceptIds: ids })
  .strict();
export const questionResolution = revisionAction
  .extend({ answer: z.string().trim().min(1).max(20000) })
  .strict();

export function normalizedConceptName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}
export interface KnowledgeSource {
  id: string;
  changeId: string;
  projectId: string;
  kind: "manual" | "chapter" | "workshop" | "proposal" | "legacy";
  chapterId: string | null;
  chapterRevision: number | null;
  conversationId: string | null;
  messageId: string | null;
  proposalId: string | null;
  availability: "available" | "historical" | "missing" | "unknown";
  details: string;
  createdAt: string;
}
export interface DesignConcept {
  id: string;
  projectId: string;
  name: string;
  normalizedName: string;
  category: string;
  description: string;
  status: Maturity;
  revision: number;
  approvedRevision: number | null;
  authoritative: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  chapterIds: string[];
  sources: KnowledgeSource[];
}
export interface DesignRelationship {
  id: string;
  projectId: string;
  sourceConceptId: string;
  targetConceptId: string;
  type: RelationshipType;
  rationale: string;
  status: Maturity;
  revision: number;
  authoritative: boolean;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
  sources: KnowledgeSource[];
}
export interface KnowledgeChange {
  id: string;
  projectId: string;
  revision: number;
  operation: string;
  actor: "manual" | "proposal" | "migration";
  snapshot: Record<string, unknown>;
  createdAt: string;
  sources: KnowledgeSource[];
}
export interface ProjectKnowledge {
  projectId: string;
  concepts: DesignConcept[];
  relationships: DesignRelationship[];
  records: DesignRecord[];
}
