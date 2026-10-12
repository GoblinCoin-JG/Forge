import { changeSchema, documentChangeSchema } from "../../server/ai.js";
import { documentPayloadSchema } from "../../shared/document-proposals.js";
import { designTextDoc } from "../../shared/design-text.js";
import type { z } from "zod";

// Converts old test fixture descriptions into canonical response fixtures.
// This is test-only; runtime generation never converts document text.
export function canonicalOffer(input: z.input<typeof changeSchema>) {
  const kind =
    input.kind ?? (input.chapterId ? "update_chapter" : "create_chapter");
  if (
    ![
      "create_chapter",
      "create_subchapter",
      "update_chapter",
      "add_section",
      "revise_section",
    ].includes(kind)
  )
    return changeSchema.parse(input);
  const document = documentPayloadSchema.parse(
    kind === "add_section" || kind === "revise_section"
      ? {
          version: 2,
          action: kind,
          heading: input.section,
          body: designTextDoc(input.content).content ?? [],
          ...(kind === "add_section" ? { level: 2 } : {}),
        }
      : { version: 2, action: kind, document: designTextDoc(input.content) },
  );
  return documentChangeSchema.parse({
    kind: "document",
    chapterId: input.chapterId,
    parentId: input.parentId,
    title: input.title,
    reason: input.reason,
    description: input.description ?? input.reason,
    relatedChapterIds: input.relatedChapterIds,
    proposedStatus: input.proposedStatus ?? null,
    document,
  });
}
