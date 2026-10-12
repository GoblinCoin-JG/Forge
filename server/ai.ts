import {
  prepareProviderRequest,
  verifyPreparedRequest,
} from "./context-budget.js";
import { z } from "zod";
import { knowledgePayloadSchema } from "../shared/knowledge-proposals.js";
import type { ProjectKnowledge } from "../shared/knowledge.js";
import {
  documentPayloadSchema,
  type DocumentReceipt,
} from "../shared/document-proposals.js";
import {
  proposalKinds,
  statuses,
  type DesignRecord,
  type Workflow,
  type Chapter,
  type Message,
  type Project,
} from "../shared/types.js";

export const changeSchema = z
  .object({
    kind: z
      .enum(
        proposalKinds.filter((k) => k !== "knowledge" && k !== "document") as [
          Exclude<(typeof proposalKinds)[number], "knowledge" | "document">,
          ...Exclude<
            (typeof proposalKinds)[number],
            "knowledge" | "document"
          >[],
        ],
      )
      .optional(),
    chapterId: z.string().uuid().nullable(),
    parentId: z.string().uuid().nullable().optional(),
    title: z.string().trim().min(1).max(120),
    content: z.string().max(100000),
    reason: z.string().trim().min(1).max(2000),
    description: z.string().trim().max(2000).optional(),
    section: z.string().trim().min(1).max(120).nullable().optional(),
    proposedStatus: z.enum(statuses).nullable().optional(),
    relatedChapterIds: z.array(z.string().uuid()).max(20).optional(),
  })
  .strict();
export const knowledgeChangeSchema = z
  .object({
    kind: z.literal("knowledge"),
    title: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(2000),
    description: z.string().trim().max(2000),
    knowledge: knowledgePayloadSchema,
    chapterId: z.null().default(null),
    parentId: z.null().optional(),
    content: z.literal("").default(""),
    section: z.null().optional(),
    proposedStatus: z.null().optional(),
    relatedChapterIds: z.array(z.string().uuid()).max(0).optional(),
  })
  .strict();
export const documentChangeSchema = z
  .object({
    kind: z.literal("document"),
    chapterId: z.string().uuid().nullable(),
    parentId: z.string().uuid().nullable().optional(),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000),
    reason: z.string().trim().min(1).max(2000),
    document: documentPayloadSchema,
    content: z.literal("").default(""),
    section: z.null().optional(),
    proposedStatus: z.null().optional(),
    relatedChapterIds: z.array(z.string().uuid()).max(20).optional(),
  })
  .strict();
export const answerSchema = z
  .object({
    reply: z.string().min(1).max(30000),
    proposals: z
      .array(
        z.union([changeSchema, knowledgeChangeSchema, documentChangeSchema]),
      )
      .max(10),
  })
  .strict();
export type Answer = z.infer<typeof answerSchema>;
export interface AIContext {
  manifest?: import("../shared/context.js").ContextManifest;
  providerRequest?: import("../shared/context.js").PreparedRequest;
  retrieval?: {
    outline: unknown[];
    evidence: {
      source: import("../shared/context.js").ContextSource;
      value: unknown;
    }[];
    earlier: unknown[];
    anchor: { chapterId: string | null; origin: string };
  };
  documentReceipt?: DocumentReceipt;
  knowledge?: ProjectKnowledge;
  project: Project;
  active: Chapter;
  lineage: { id: string; title: string }[];
  children: { id: string; title: string }[];
  vision: Chapter | null;
  approved: Chapter[];
  relevant: Chapter[];
  records: DesignRecord[];
  pending: { kind: string; title: string; reason: string }[];
  messages: Message[];
  workflow: Workflow | null;
  truncated: boolean;
  activeTruncated: boolean;
}
export type DesignAssistant = (
  context: AIContext,
  signal: AbortSignal,
  onReply: (text: string) => void,
) => Promise<Answer>;

// Decode only the reply field while the structured JSON is still arriving.
export function partialReply(raw: string): string {
  const start = raw.match(/"reply"\s*:\s*"/);
  if (!start) return "";
  const value = raw.slice(start.index! + start[0].length);
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '"') break;
    if (value[i] !== "\\") {
      out += value[i];
      continue;
    }
    const escaped = value[++i];
    if (!escaped) break;
    if (escaped === "u") {
      const hex = value.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else
      out +=
        (
          {
            n: "\n",
            r: "\r",
            t: "\t",
            b: "\b",
            f: "\f",
            '"': '"',
            "\\": "\\",
            "/": "/",
          } as Record<string, string>
        )[escaped] ?? "";
  }
  return out;
}

export const openAIAssistant: DesignAssistant = async (
  context,
  signal,
  onReply,
) => {
  const prepared = context.providerRequest ?? prepareProviderRequest(context);
  verifyPreparedRequest(context, prepared);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: prepared.serialized,
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "The AI key was not accepted. Check OPENAI_API_KEY and restart Forge."
        : response.status === 429
          ? "The AI service is busy or your account has reached its limit. Try again later."
          : `The AI service could not complete this request (${response.status}).`,
    );
  if (!response.body)
    throw new Error("The AI service returned an empty stream.");
  let buffer = "",
    raw = "",
    finish = "",
    refusal = "";
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith("data: ") || line.trim() === "data: [DONE]")
          continue;
        const event = JSON.parse(line.slice(6));
        const choice = event.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        refusal += choice.delta?.refusal ?? "";
        raw += choice.delta?.content ?? "";
        if (raw.length > 600_000)
          throw new Error(
            "The AI response was too large. Try a smaller request.",
          );
        onReply(partialReply(raw));
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (refusal)
    throw new Error(
      "The AI could not help with this request. Try a different design question.",
    );
  if (finish !== "stop")
    throw new Error(
      "The AI response was interrupted. No proposals were applied.",
    );
  return answerSchema.parse(JSON.parse(raw));
};
