import { randomUUID } from "node:crypto";
import { AppError, type Store } from "./store.js";
import type { AIContext } from "./ai.js";
import { digest, verifyPreparedRequest } from "./context-budget.js";
import type {
  ContextInspection,
  ContextSourceInspection,
  ContextManifest,
} from "../shared/context.js";
type Row = Record<string, any>;
export class ContextStore {
  constructor(private store: Store) {}
  anchor(projectId: string) {
    this.store.project(projectId);
    const row = this.store.db
      .prepare("SELECT * FROM project_context_anchors WHERE project_id=?")
      .get(projectId);
    return {
      chapterId: (row?.chapter_id as string | null) ?? null,
      origin: String(row?.origin ?? "unassigned"),
    };
  }
  setAnchor(projectId: string, chapterId: string | null, origin = "developer") {
    this.store.project(projectId);
    if (chapterId && this.store.chapter(chapterId).projectId !== projectId)
      throw new AppError(404, "Vision chapter not found in this project");
    this.store.db
      .prepare(
        "INSERT INTO project_context_anchors VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET chapter_id=excluded.chapter_id,origin=excluded.origin",
      )
      .run(projectId, chapterId, origin);
    return this.anchor(projectId);
  }
  capture(context: AIContext, userId: string) {
    const request = context.providerRequest,
      manifest = context.manifest;
    if (!request || !manifest)
      throw new Error("Context must be finalized before capture.");
    verifyPreparedRequest(context, request);
    if (
      manifest.requestDigest !== request.requestDigest ||
      manifest.contextDigest !== request.contextDigest ||
      manifest.providerFormat !== request.format
    )
      throw new Error(
        "Manifest does not describe the finalized provider request.",
      );
    const id = randomUUID();
    this.store.db
      .prepare(
        "INSERT INTO workshop_context_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        context.project.id,
        context.active.id,
        userId,
        request.contextSerialized,
        JSON.stringify(manifest),
        request.serialized,
        request.contextDigest,
        request.requestDigest,
        request.format,
        new Date().toISOString(),
      );
    return id;
  }
  attach(requestId: string, messageId: string) {
    this.store.db
      .prepare("INSERT INTO workshop_response_contexts VALUES(?,?)")
      .run(messageId, requestId);
  }
  private owned(projectId: string, requestId: string): Row {
    this.store.project(projectId);
    const row = this.store.db
      .prepare(
        "SELECT * FROM workshop_context_requests WHERE id=? AND project_id=?",
      )
      .get(requestId, projectId) as Row | undefined;
    if (!row) throw new AppError(404, "Recorded context not found");
    if (
      digest(row.context_json) !== row.context_digest ||
      digest(row.request_json) !== row.request_digest
    )
      throw new AppError(409, "Recorded context integrity check failed");
    return row;
  }
  inspection(projectId: string, requestId: string): ContextInspection {
    const row = this.owned(projectId, requestId);
    return {
      requestId,
      manifest: JSON.parse(row.manifest_json),
      createdAt: row.created_at,
    };
  }
  source(
    projectId: string,
    requestId: string,
    key: string,
  ): ContextSourceInspection {
    const row = this.owned(projectId, requestId),
      manifest = JSON.parse(row.manifest_json) as ContextManifest;
    const source = manifest.sources.find((s) => s.key === key);
    if (!source) throw new AppError(404, "Supplied source not found");
    const context = JSON.parse(row.context_json);
    const evidence = context.retrieval.evidence.find(
      (e: any) => e.source.key === key,
    );
    let value = evidence?.value;
    if (source.kind === "message")
      value =
        context.messages.find((m: any) => m.id === source.id) ??
        context.retrieval.earlier.find((m: any) => m.id === source.id);
    if (source.kind === "outline" && !value)
      value = context.retrieval.outline.find((o: any) => o.key === key);
    if (source.key.startsWith("hierarchy:"))
      value = [...context.lineage, ...context.children].find(
        (v: any) => v.id === source.id,
      );
    if (source.kind === "project") value = context.project;
    const readableLabels: Record<string, string> = {
      title: "Title",
      name: "Concept",
      category: "Category",
      status: "Maturity",
      type: "Relationship",
      rationale: "Rationale",
      resolution: "Recorded answer",
      sourceConceptId: "From concept",
      targetConceptId: "To concept",
      supersededBy: "Replaced by decision",
    };
    const readableValue = (label: string, v: unknown) => {
      if (label === "status" && value?.supersededBy)
        return "Superseded (previously approved)";
      if (label === "sourceConceptId" || label === "targetConceptId")
        return (
          context.knowledge?.concepts.find((c: any) => c.id === v)?.name ??
          context.retrieval.outline.find(
            (o: any) => o.kind === "concept" && o.id === v,
          )?.name ??
          "Concept reference (detail not supplied)"
        );
      if (label === "supersededBy")
        return (
          context.knowledge?.records.find((r: any) => r.id === v)?.text ??
          "Replacement reference (detail not supplied)"
        );
      if (label === "type") return String(v).replaceAll("_", " ");
      return String(v);
    };
    return {
      source,
      content: value?.content?.type === "doc" ? value.content : null,
      text:
        typeof value?.content === "string"
          ? value.content
          : (value?.description ??
            value?.text ??
            value?.rationale ??
            value?.reason ??
            value?.premise ??
            ""),
      availability: value ? "captured" : "missing",
      fields: value
        ? Object.entries(value)
            .filter(
              ([key, v]) =>
                [
                  "title",
                  "name",
                  "category",
                  "status",
                  "type",
                  "rationale",
                  "resolution",
                  "sourceConceptId",
                  "targetConceptId",
                  "supersededBy",
                ].includes(key) && typeof v === "string",
            )
            .map(([label, v]) => ({
              label: readableLabels[label] ?? label,
              value: readableValue(label, v),
            }))
        : [],
    };
  }
  recoverInterrupted() {
    // Startup only: retain the attempted request and explicitly record interruption.
    const rows = this.store.db
      .prepare(
        "SELECT r.id,u.conversation_id FROM workshop_context_requests r JOIN messages u ON u.id=r.user_message_id LEFT JOIN workshop_response_contexts a ON a.request_id=r.id WHERE a.message_id IS NULL",
      )
      .all() as Row[];
    this.store.transaction(() => {
      for (const row of rows) {
        const m = this.store.addMessage(
          row.conversation_id,
          "assistant",
          "The previous Workshop request ended before a response was saved. Its supplied context remains available.",
          "interrupted",
        );
        this.attach(row.id, m.id);
      }
    });
  }
}
