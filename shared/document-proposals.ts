import { z } from "zod";
import { docSchema, documentFragmentSchema, type Doc } from "./document.js";
import { canonicalDocument } from "./chapter-content.js";
import type { Proposal } from "./types.js";

const base = { version: z.literal(2) };
const heading = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => Boolean(value.trim()), "A section heading is required");
export const documentPayloadSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...base,
      action: z.literal("create_chapter"),
      document: docSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("create_subchapter"),
      document: docSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("update_chapter"),
      document: docSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("add_section"),
      heading,
      level: z.number().int().min(1).max(6),
      body: documentFragmentSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("revise_section"),
      heading,
      body: documentFragmentSchema,
    })
    .strict(),
]);
export type DocumentPayload = z.infer<typeof documentPayloadSchema>;
export interface DocumentReceipt {
  complete: boolean;
  includedBlockIndexes: number[];
  completeSections: string[];
}
export interface DocumentProposalData {
  payload: DocumentPayload;
  sourceChapterId: string;
  sourceRevision: number;
  receipt: DocumentReceipt;
}
const nodeText = (node: Record<string, unknown>): string =>
  typeof node.text === "string"
    ? node.text
    : Array.isArray(node.content)
      ? node.content.map(nodeText).join("")
      : "";
export function documentSections(doc: Doc) {
  const nodes = doc.content ?? [];
  return nodes.flatMap((node, index) => {
    if (node.type !== "heading") return [];
    const level = Number(
      (node.attrs as { level: number } | undefined)?.level ?? 1,
    );
    let end = index + 1;
    while (
      end < nodes.length &&
      !(
        nodes[end].type === "heading" &&
        Number(
          (nodes[end].attrs as { level: number } | undefined)?.level ?? 1,
        ) <= level
      )
    )
      end++;
    return [{ heading: nodeText(node), level, start: index, end }];
  });
}
export function materializeDocument(
  original: Doc | undefined,
  payload: DocumentPayload,
): Doc {
  const p = documentPayloadSchema.parse(payload);
  if ("document" in p) return p.document;
  if (!original)
    throw new Error("A saved source document is required for section editing.");
  docSchema.parse(original);
  const nodes = original.content ?? [],
    matches = documentSections(original).filter((s) => s.heading === p.heading);
  if (p.action === "add_section") {
    if (matches.length)
      throw new Error(
        "That section already exists. Propose a revision instead.",
      );
    if (
      p.body.some(
        (n) =>
          n.type === "heading" &&
          Number((n.attrs as { level: number } | undefined)?.level ?? 1) <=
            p.level,
      )
    )
      throw new Error(
        "A section body cannot introduce headings outside its hierarchy.",
      );
    return docSchema.parse({
      type: "doc",
      content: [
        ...nodes,
        {
          type: "heading",
          attrs: { level: p.level },
          content: [{ type: "text", text: p.heading }],
        },
        ...p.body,
      ],
    });
  }
  if (matches.length !== 1)
    throw new Error(
      "Section must match one unique existing heading. Clarify an ambiguous or missing section target.",
    );
  const section = matches[0];
  if (
    p.body.some(
      (n) =>
        n.type === "heading" &&
        Number((n.attrs as { level: number } | undefined)?.level ?? 1) <=
          section.level,
    )
  )
    throw new Error(
      "A section body cannot introduce headings outside the selected section.",
    );
  return docSchema.parse({
    type: "doc",
    content: [
      ...nodes.slice(0, section.start + 1),
      ...p.body,
      ...nodes.slice(section.end),
    ],
  });
}
export function documentProposalSafety(p: Proposal): {
  safe: boolean;
  legacy: boolean;
  reason: string;
} {
  const documentAction = [
    "create_chapter",
    "create_subchapter",
    "update_chapter",
    "add_section",
    "revise_section",
  ].includes(p.kind);
  if (!documentAction) return { safe: true, legacy: false, reason: "" };
  if (p.document) {
    try {
      if (p.kind !== p.document.payload.action)
        throw new Error("Document action mismatch");
      const expected = materializeDocument(
        p.before?.content,
        p.document.payload,
      );
      if (canonicalDocument(expected) !== canonicalDocument(p.content))
        return {
          safe: false,
          legacy: false,
          reason:
            "The saved proposal differs from its canonical operation. Regenerate it.",
        };
      if (p.kind === "update_chapter" && !p.document.receipt.complete)
        return {
          safe: false,
          legacy: false,
          reason: "Full replacement requires the complete source document.",
        };
      if (
        p.kind === "revise_section" &&
        !p.document.receipt.complete &&
        !p.document.receipt.completeSections.includes(p.section!)
      )
        return {
          safe: false,
          legacy: false,
          reason:
            "The AI did not receive this entire section. Request a narrower edit.",
        };
      return {
        safe: true,
        legacy: false,
        reason:
          "Rich document proposal. Section edits preserve unrelated content and formatting.",
      };
    } catch {
      return {
        safe: false,
        legacy: false,
        reason:
          "Invalid canonical document operation. Regenerate the proposal.",
      };
    }
  }
  if (p.kind === "update_chapter")
    return {
      safe: false,
      legacy: true,
      reason:
        "Legacy full replacement: formatting intent and complete rich source coverage cannot be verified. Regenerate using the canonical document contract.",
    };
  if (!docSchema.safeParse(p.content).success)
    return {
      safe: false,
      legacy: true,
      reason:
        "This legacy proposal contains unsupported or invalid document structure. Regenerate it.",
    };
  if (p.kind === "create_chapter" || p.kind === "create_subchapter")
    return {
      safe: true,
      legacy: true,
      reason:
        "Legacy stored proposal. Acceptance uses this exact saved rich JSON; no conversion will run.",
    };
  if (!p.before || !p.section)
    return {
      safe: false,
      legacy: true,
      reason:
        "This legacy section proposal has no reliable source snapshot or target. Regenerate it.",
    };
  const a = p.before.content.content ?? [],
    b = p.content.content ?? [];
  if (p.kind === "add_section") {
    const n = b[a.length];
    const safe =
      canonicalDocument(b.slice(0, a.length)) === canonicalDocument(a) &&
      n?.type === "heading" &&
      nodeText(n) === p.section &&
      !documentSections(p.before.content).some((s) => s.heading === p.section);
    return {
      safe,
      legacy: true,
      reason: safe
        ? "Legacy stored section proposal. Existing nodes remain exact; review the new rich section before accepting."
        : "This legacy addition cannot prove unrelated content is unchanged. Regenerate it.",
    };
  }
  const matches = documentSections(p.before.content).filter(
    (s) => s.heading === p.section,
  );
  if (matches.length !== 1)
    return {
      safe: false,
      legacy: true,
      reason:
        "This legacy section target is ambiguous or missing. Regenerate it.",
    };
  const s = matches[0],
    suffix = a.slice(s.end),
    bodyEnd = b.length - suffix.length;
  const safe =
    bodyEnd >= s.start + 1 &&
    canonicalDocument(b.slice(0, s.start + 1)) ===
      canonicalDocument(a.slice(0, s.start + 1)) &&
    canonicalDocument(b.slice(bodyEnd)) === canonicalDocument(suffix) &&
    b
      .slice(s.start + 1, bodyEnd)
      .every(
        (n) =>
          n.type !== "heading" ||
          Number((n.attrs as { level: number } | undefined)?.level ?? 1) >
            s.level,
      );
  return {
    safe,
    legacy: true,
    reason: safe
      ? "Legacy stored section proposal. Unrelated headings, formatting and links remain exact."
      : "This legacy revision may affect unrelated content. Regenerate it.",
  };
}
