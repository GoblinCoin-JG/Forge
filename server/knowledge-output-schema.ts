// Provider strict JSON schema mirrors the versioned shared knowledge payload.
// Backend Zod/domain validation remains mandatory after provider validation.
const string = { type: "string" };
const revision = { type: "integer", minimum: 0 };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const reference = {
  anyOf: [object({ id: string }), object({ newConcept: string })],
};
const chapterIds = { type: "array", items: string };
const concepts = { type: "array", items: reference };
const fields = { name: string, category: string, description: string };
const record = { text: string, rationale: string, chapterIds, concepts };
const target = { targetId: string, revision };
const relationship = {
  source: reference,
  target: reference,
  type: {
    type: "string",
    enum: [
      "depends_on",
      "interacts_with",
      "affects",
      "part_of",
      "conflicts_with",
    ],
  },
  rationale: string,
};
const variants: Record<string, Record<string, unknown>> = {
  create_concept: { key: string, ...fields, chapterIds },
  update_concept: { ...target, ...fields },
  associate_concept: { ...target, chapterIds },
  create_relationship: relationship,
  update_relationship: { ...target, ...relationship },
  retire_relationship: target,
  record_decision: record,
  supersede_decision: { ...target, ...record },
  record_question: record,
  resolve_question: { ...target, answer: string },
};
export const knowledgeOutputSchema = object({
  kind: { type: "string", enum: ["knowledge"] },
  title: string,
  reason: string,
  description: string,
  knowledge: {
    anyOf: Object.entries(variants).map(([action, properties]) =>
      object({
        version: { type: "integer", enum: [1] },
        action: { type: "string", enum: [action] },
        ...properties,
      }),
    ),
  },
  chapterId: { type: "null" },
  parentId: { type: "null" },
  content: { type: "string", enum: [""] },
  section: { type: "null" },
  proposedStatus: { type: "null" },
  relatedChapterIds: { type: "array", items: string, maxItems: 0 },
});
