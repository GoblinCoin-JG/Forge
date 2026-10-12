import type { Doc } from "./document.js";
export type ContextKind =
  | "project"
  | "chapter"
  | "concept"
  | "relationship"
  | "decision"
  | "question"
  | "message"
  | "outline";
export type ContextAuthority =
  | "current-approved"
  | "previously-approved"
  | "exploratory"
  | "unreviewed"
  | "historical"
  | "unresolved"
  | "resolved"
  | "discussion"
  | "identity";
export interface ContextSource {
  key: string;
  kind: ContextKind;
  id: string;
  label: string;
  revision: number | null;
  chapterId?: string;
  conversationId?: string;
  authority: ContextAuthority;
  maturity: string;
  coverage: "complete" | "partial" | "overview";
  reason: string;
  blockIndexes?: number[];
  sections?: {
    heading: string;
    level: number;
    start: number;
    end: number;
    path: string[];
    complete: boolean;
  }[];
}
export interface ContextOmission {
  kind: ContextKind | "anchor";
  count: number;
  reason: string;
  id?: string;
  label?: string;
}
export interface ContextLimits {
  contextBytes: number;
  requestBytes: number;
  contextTokens: number;
  outputTokens: number;
  model: string;
  tokenizer: "o200k_base" | "cl100k_base" | "byte-bound";
}
export interface ContextManifest {
  version: 1;
  providerFormat: string;
  projectId: string;
  chapterId: string;
  sources: ContextSource[];
  omissions: ContextOmission[];
  limits: ContextLimits;
  contextBytes: number;
  requestBytes: number;
  estimatedInputTokens: number;
  tokenMethod: string;
  contextDigest: string;
  requestDigest: string;
  retrievalMs: number;
}
export interface PreparedRequest {
  serialized: string;
  contextSerialized: string;
  requestDigest: string;
  contextDigest: string;
  requestBytes: number;
  contextBytes: number;
  estimatedInputTokens: number;
  tokenMethod: string;
  limits: ContextLimits;
  format: string;
}
export interface ContextReference {
  requestId: string;
  available: boolean;
}
export interface ContextInspection {
  requestId: string;
  manifest: ContextManifest;
  createdAt: string;
}
export interface ContextSourceInspection {
  source: ContextSource;
  content: Doc | null;
  text: string;
  availability: "captured" | "missing";
  fields?: { label: string; value: string }[];
}
