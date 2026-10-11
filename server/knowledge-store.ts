import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, type Store } from "./store.js";
import { docText, type DesignRecord } from "../shared/types.js";
import {
  conceptInput,
  conceptUpdate,
  conceptRestore,
  revisionAction,
  relationshipInput,
  relationshipUpdate,
  recordInput,
  recordLinksInput,
  supersedeInput,
  questionResolution,
  sourceInput,
  symmetricRelationships,
  normalizedConceptName,
  type SourceInput,
  type DesignConcept,
  type DesignRelationship,
  type KnowledgeSource,
  type KnowledgeChange,
  type ProjectKnowledge,
} from "../shared/knowledge.js";

type Row = Record<string, any>;
type Subject = "concept" | "relationship" | "record";
type Evidence = {
  kind: KnowledgeSource["kind"];
  chapterId?: string;
  chapterRevision?: number;
  conversationId?: string;
  messageId?: string;
  proposalId?: string;
  details?: string;
  missingReason?: string;
};
const now = () => new Date().toISOString();

// Domain operations share the existing Store's DB and transaction boundary.
export class KnowledgeStore {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }
  private owned(projectId: string) {
    this.store.project(projectId);
  }
  private checkRevision(current: { revision: number }, revision: number) {
    if (current.revision !== revision)
      throw new AppError(
        409,
        "This knowledge changed elsewhere. Reload it before applying your change.",
      );
  }
  private citation(projectId: string, input?: SourceInput): Evidence {
    const source = sourceInput.parse(input ?? { kind: "manual" });
    if (source.kind === "manual")
      return { kind: "manual", details: "Explicit developer operation." };
    if (source.kind === "chapter") {
      const c = this.store.chapter(source.chapterId, true);
      if (c.projectId !== projectId)
        throw new AppError(400, "Source chapter belongs to another project");
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM chapter_revisions WHERE chapter_id=? AND revision=? AND project_id=?",
          )
          .get(c.id, source.revision, projectId)
      )
        throw new AppError(404, "Source chapter revision not found");
      return {
        kind: "chapter",
        chapterId: c.id,
        chapterRevision: source.revision,
        details: "Developer entry citing an exact saved chapter revision.",
      };
    }
    const conversation = this.db
      .prepare("SELECT * FROM conversations WHERE id=?")
      .get(source.conversationId);
    if (!conversation || conversation.project_id !== projectId)
      throw new AppError(
        400,
        "Source conversation belongs to another project or does not exist",
      );
    if (
      source.messageId &&
      !this.db
        .prepare(
          "SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND state='complete'",
        )
        .get(source.messageId, source.conversationId)
    )
      throw new AppError(
        400,
        "Source message must be complete and belong to this conversation",
      );
    return {
      kind: "workshop",
      conversationId: source.conversationId,
      messageId: source.messageId,
      details: "Developer entry citing Workshop evidence; not an AI approval.",
    };
  }
  private sourcesForRows(rows: Row[]): KnowledgeSource[] {
    return rows.map((r) => {
      let availability: KnowledgeSource["availability"] =
        r.kind === "legacy"
          ? "unknown"
          : r.missing_reason
            ? "missing"
            : "available";
      if (!r.missing_reason && r.chapter_id) {
        const c = this.store.chapter(r.chapter_id, true);
        if (c.archivedAt || c.revision !== r.chapter_revision)
          availability = "historical";
      } else if (r.conversation_id) {
        const c = this.db
          .prepare(
            "SELECT c.archived_at FROM chapters c JOIN conversations w ON w.chapter_id=c.id WHERE w.id=?",
          )
          .get(r.conversation_id);
        if (c?.archived_at && availability === "available")
          availability = "historical";
      }
      return {
        id: r.id,
        changeId: r.change_id,
        projectId: r.project_id,
        kind: r.kind,
        chapterId: r.chapter_id,
        chapterRevision: r.chapter_revision,
        conversationId: r.conversation_id,
        messageId: r.message_id,
        proposalId: r.proposal_id,
        availability,
        details: [r.details, r.missing_reason].filter(Boolean).join(" "),
        createdAt: r.created_at,
      };
    });
  }
  private sources(subject: Subject, id: string): KnowledgeSource[] {
    return this.sourcesForRows(
      this.db
        .prepare(
          `SELECT s.* FROM knowledge_sources s JOIN knowledge_changes h ON h.id=s.change_id WHERE h.${subject}_id=? ORDER BY s.rowid`,
        )
        .all(id) as Row[],
    );
  }
  private evidence(
    subject: Subject,
    value: DesignConcept | DesignRelationship | DesignRecord,
    operation: string,
    source: Evidence,
    actor: "manual" | "proposal" = "manual",
  ) {
    const id = randomUUID(),
      date = now(),
      { sources, ...snapshot } = value;
    this.db
      .prepare(
        `INSERT INTO knowledge_changes(id,project_id,${subject}_id,revision,operation,actor,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        value.projectId,
        value.id,
        value.revision,
        operation,
        actor,
        JSON.stringify(snapshot),
        date,
      );
    this.db
      .prepare(
        "INSERT INTO knowledge_sources(id,change_id,project_id,kind,chapter_id,chapter_revision,conversation_id,message_id,proposal_id,details,missing_reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        id,
        value.projectId,
        source.kind,
        source.chapterId ?? null,
        source.chapterRevision ?? null,
        source.conversationId ?? null,
        source.messageId ?? null,
        source.proposalId ?? null,
        source.details ?? "",
        source.missingReason ?? null,
        date,
      );
    this.store.touch(value.projectId);
  }
  history(projectId: string, subject: Subject, id: string): KnowledgeChange[] {
    if (subject === "concept") this.concept(projectId, id);
    else if (subject === "relationship") this.relationship(projectId, id);
    else this.record(projectId, id);
    return (
      this.db
        .prepare(
          `SELECT * FROM knowledge_changes WHERE project_id=? AND ${subject}_id=? ORDER BY revision DESC`,
        )
        .all(projectId, id) as Row[]
    ).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      revision: r.revision,
      operation: r.operation,
      actor: r.actor,
      snapshot: JSON.parse(r.snapshot),
      createdAt: r.created_at,
      sources: this.sourcesForRows(
        this.db
          .prepare(
            "SELECT * FROM knowledge_sources WHERE change_id=? ORDER BY rowid",
          )
          .all(r.id) as Row[],
      ),
    }));
  }
  private nameAvailable(projectId: string, name: string, exceptId?: string) {
    const row = this.db
      .prepare(
        "SELECT id FROM design_concepts WHERE project_id=? AND normalized_name=? AND archived_at IS NULL",
      )
      .get(projectId, normalizedConceptName(name));
    if (row && row.id !== exceptId)
      throw new AppError(
        409,
        "An active concept with this normalized name already exists. Use the existing concept or choose another name.",
      );
  }
  concept(projectId: string, id: string, live = false): DesignConcept {
    this.owned(projectId);
    const r = this.db
      .prepare("SELECT * FROM design_concepts WHERE id=? AND project_id=?")
      .get(id, projectId);
    if (!r) throw new AppError(404, "Concept not found in this project");
    if (live && r.archived_at)
      throw new AppError(
        409,
        "Return this archived concept before changing it",
      );
    return {
      id: r.id as string,
      projectId,
      name: r.name as string,
      normalizedName: r.normalized_name as string,
      category: r.category as string,
      description: r.description as string,
      status: r.status as DesignConcept["status"],
      revision: r.revision as number,
      approvedRevision: r.approved_revision as number | null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      archivedAt: r.archived_at as string | null,
      authoritative: r.status === "Approved" && !r.archived_at,
      chapterIds: this.db
        .prepare(
          "SELECT chapter_id FROM concept_chapters WHERE concept_id=? ORDER BY rowid",
        )
        .all(id)
        .map((r) => String(r.chapter_id)),
      sources: this.sources("concept", id),
    };
  }
  concepts(
    projectId: string,
    includeArchived = false,
    search = "",
  ): DesignConcept[] {
    this.owned(projectId);
    const term = normalizedConceptName(search);
    return this.db
      .prepare(
        "SELECT id FROM design_concepts WHERE project_id=? ORDER BY rowid",
      )
      .all(projectId)
      .map((r) => this.concept(projectId, String(r.id)))
      .filter(
        (c) =>
          (includeArchived || !c.archivedAt) &&
          (!term || c.normalizedName.includes(term)),
      );
  }
  createConcept(projectId: string, input: z.input<typeof conceptInput>) {
    const v = conceptInput.parse(input);
    return this.store.transaction(() => {
      this.owned(projectId);
      this.nameAvailable(projectId, v.name);
      const source = this.citation(projectId, v.source),
        id = randomUUID(),
        date = now();
      this.db
        .prepare(
          "INSERT INTO design_concepts(id,project_id,name,normalized_name,category,description,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,'Exploring',0,?,?)",
        )
        .run(
          id,
          projectId,
          v.name,
          normalizedConceptName(v.name),
          v.category,
          v.description,
          date,
          date,
        );
      this.evidence("concept", this.concept(projectId, id), "create", source);
      return this.concept(projectId, id);
    });
  }
  updateConcept(
    projectId: string,
    id: string,
    input: z.input<typeof conceptUpdate>,
  ) {
    const v = conceptUpdate.parse(input);
    return this.store.transaction(() => {
      const c = this.concept(projectId, id, true);
      this.checkRevision(c, v.revision);
      const source = this.citation(projectId, v.source),
        name = v.name ?? c.name;
      this.nameAvailable(projectId, name, id);
      const material =
        name !== c.name ||
        (v.category ?? c.category) !== c.category ||
        (v.description ?? c.description) !== c.description;
      const status =
        v.status ??
        (material && c.status === "Approved" ? "Needs Revision" : c.status);
      this.db
        .prepare(
          "UPDATE design_concepts SET name=?,normalized_name=?,category=?,description=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?",
        )
        .run(
          name,
          normalizedConceptName(name),
          v.category ?? c.category,
          v.description ?? c.description,
          status,
          now(),
          id,
          projectId,
          v.revision,
        );
      this.evidence("concept", this.concept(projectId, id), "update", source);
      return this.concept(projectId, id);
    });
  }
  approveConcept(
    projectId: string,
    id: string,
    input: z.input<typeof revisionAction>,
  ) {
    const v = revisionAction.parse(input);
    return this.store.transaction(() => {
      const c = this.concept(projectId, id, true);
      this.checkRevision(c, v.revision);
      const source = this.citation(projectId, v.source);
      this.db
        .prepare(
          "UPDATE design_concepts SET status='Approved',revision=revision+1,approved_revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?",
        )
        .run(now(), id, projectId, v.revision);
      this.evidence("concept", this.concept(projectId, id), "approve", source);
      return this.concept(projectId, id);
    });
  }
  archiveConcept(
    projectId: string,
    id: string,
    input: z.input<typeof revisionAction>,
  ) {
    const v = revisionAction.parse(input);
    return this.store.transaction(() => {
      const c = this.concept(projectId, id, true);
      this.checkRevision(c, v.revision);
      const source = this.citation(projectId, v.source);
      const relationships = this.relationships(projectId).filter(
        (r) => r.sourceConceptId === id || r.targetConceptId === id,
      );
      for (const relationship of relationships)
        this.retireRelationship(
          projectId,
          relationship.id,
          { revision: relationship.revision, source: v.source },
          "retire_for_concept_archive",
        );
      this.db
        .prepare(
          "UPDATE design_concepts SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=? AND project_id=? AND revision=?",
        )
        .run(now(), now(), id, projectId, v.revision);
      this.evidence("concept", this.concept(projectId, id), "archive", source);
      return this.concept(projectId, id);
    });
  }
  restoreConcept(
    projectId: string,
    id: string,
    input: z.input<typeof conceptRestore>,
  ) {
    const v = conceptRestore.parse(input);
    return this.store.transaction(() => {
      const c = this.concept(projectId, id);
      this.checkRevision(c, v.revision);
      if (!c.archivedAt)
        throw new AppError(409, "This concept is not archived");
      const name = v.name ?? c.name;
      this.nameAvailable(projectId, name, id);
      const source = this.citation(projectId, v.source);
      this.db
        .prepare(
          "UPDATE design_concepts SET archived_at=NULL,name=?,normalized_name=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?",
        )
        .run(
          name,
          normalizedConceptName(name),
          c.approvedRevision === null ? "Exploring" : "Needs Revision",
          now(),
          id,
          projectId,
          v.revision,
        );
      this.evidence("concept", this.concept(projectId, id), "restore", source);
      return this.concept(projectId, id);
    });
  }
  private validateLinks(
    projectId: string,
    chapterIds: string[],
    conceptIds: string[],
    oldChapterIds: string[] = [],
    oldConceptIds: string[] = [],
  ) {
    for (const id of chapterIds) {
      const c = this.store.chapter(id, true);
      if (c.projectId !== projectId)
        throw new AppError(
          400,
          "Associated chapter belongs to another project",
        );
      if (c.archivedAt && !oldChapterIds.includes(id))
        throw new AppError(409, "New associations require live chapters");
    }
    for (const id of conceptIds) {
      const c = this.concept(projectId, id);
      if (c.archivedAt && !oldConceptIds.includes(id))
        throw new AppError(409, "New associations require live concepts");
    }
  }
  setConceptChapters(
    projectId: string,
    id: string,
    input: { revision: number; chapterIds: string[]; source?: SourceInput },
  ) {
    const v = recordLinksInput.omit({ conceptIds: true }).parse(input);
    return this.store.transaction(() => {
      const c = this.concept(projectId, id, true);
      this.checkRevision(c, v.revision);
      this.validateLinks(projectId, v.chapterIds, [], c.chapterIds);
      const source = this.citation(projectId, v.source);
      this.db
        .prepare(
          "DELETE FROM concept_chapters WHERE concept_id=? AND project_id=?",
        )
        .run(id, projectId);
      for (const chapterId of v.chapterIds)
        this.db
          .prepare("INSERT INTO concept_chapters VALUES(?,?,?)")
          .run(projectId, id, chapterId);
      const changed =
        c.chapterIds.length !== v.chapterIds.length ||
        c.chapterIds.some((id) => !v.chapterIds.includes(id));
      this.db
        .prepare(
          "UPDATE design_concepts SET revision=revision+1,status=?,updated_at=? WHERE id=? AND project_id=? AND revision=?",
        )
        .run(
          changed && c.status === "Approved" ? "Needs Revision" : c.status,
          now(),
          id,
          projectId,
          v.revision,
        );
      this.evidence(
        "concept",
        this.concept(projectId, id),
        "set_chapters",
        source,
      );
      return this.concept(projectId, id);
    });
  }
  relationship(
    projectId: string,
    id: string,
    live = false,
  ): DesignRelationship {
    this.owned(projectId);
    const r = this.db
      .prepare("SELECT * FROM design_relationships WHERE id=? AND project_id=?")
      .get(id, projectId) as Row | undefined;
    if (!r) throw new AppError(404, "Relationship not found in this project");
    if (live && r.retired_at)
      throw new AppError(409, "This relationship is retired");
    const endpointsLive =
      !this.concept(projectId, r.source_concept_id).archivedAt &&
      !this.concept(projectId, r.target_concept_id).archivedAt;
    return {
      id: r.id,
      projectId,
      sourceConceptId: r.source_concept_id,
      targetConceptId: r.target_concept_id,
      type: r.type,
      rationale: r.rationale,
      status: r.status,
      revision: r.revision,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      retiredAt: r.retired_at,
      authoritative: r.status === "Approved" && !r.retired_at && endpointsLive,
      sources: this.sources("relationship", id),
    };
  }
  relationships(projectId: string, includeRetired = false) {
    this.owned(projectId);
    return this.db
      .prepare(
        "SELECT id FROM design_relationships WHERE project_id=? ORDER BY rowid",
      )
      .all(projectId)
      .map((r) => this.relationship(projectId, String(r.id)))
      .filter((r) => includeRetired || !r.retiredAt);
  }
  private relationshipEndpoints(
    projectId: string,
    v: {
      sourceConceptId: string;
      targetConceptId: string;
      type: DesignRelationship["type"];
    },
    exceptId?: string,
  ) {
    this.concept(projectId, v.sourceConceptId, true);
    this.concept(projectId, v.targetConceptId, true);
    if (v.sourceConceptId === v.targetConceptId)
      throw new AppError(400, "A concept cannot relate to itself");
    const [from, to] = symmetricRelationships.has(v.type)
      ? [v.sourceConceptId, v.targetConceptId].sort()
      : [v.sourceConceptId, v.targetConceptId];
    const duplicate = this.db
      .prepare(
        "SELECT id FROM design_relationships WHERE project_id=? AND source_concept_id=? AND target_concept_id=? AND type=? AND retired_at IS NULL",
      )
      .get(projectId, from, to, v.type);
    if (duplicate && duplicate.id !== exceptId)
      throw new AppError(409, "This active relationship already exists");
    return [from, to];
  }
  createRelationship(
    projectId: string,
    input: z.input<typeof relationshipInput>,
  ) {
    const v = relationshipInput.parse(input);
    return this.store.transaction(() => {
      this.owned(projectId);
      const [from, to] = this.relationshipEndpoints(projectId, v),
        source = this.citation(projectId, v.source),
        id = randomUUID(),
        date = now();
      this.db
        .prepare(
          "INSERT INTO design_relationships(id,project_id,source_concept_id,target_concept_id,type,rationale,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,'Exploring',0,?,?)",
        )
        .run(id, projectId, from, to, v.type, v.rationale, date, date);
      this.evidence(
        "relationship",
        this.relationship(projectId, id),
        "create",
        source,
      );
      return this.relationship(projectId, id);
    });
  }
  updateRelationship(
    projectId: string,
    id: string,
    input: z.input<typeof relationshipUpdate>,
  ) {
    const v = relationshipUpdate.parse(input);
    return this.store.transaction(() => {
      const r = this.relationship(projectId, id, true);
      this.checkRevision(r, v.revision);
      const merged = {
        sourceConceptId: v.sourceConceptId ?? r.sourceConceptId,
        targetConceptId: v.targetConceptId ?? r.targetConceptId,
        type: v.type ?? r.type,
      };
      const [from, to] = this.relationshipEndpoints(projectId, merged, id),
        source = this.citation(projectId, v.source);
      const material =
        from !== r.sourceConceptId ||
        to !== r.targetConceptId ||
        merged.type !== r.type ||
        (v.rationale ?? r.rationale) !== r.rationale;
      this.db
        .prepare(
          "UPDATE design_relationships SET source_concept_id=?,target_concept_id=?,type=?,rationale=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?",
        )
        .run(
          from,
          to,
          merged.type,
          v.rationale ?? r.rationale,
          v.status ??
            (material && r.status === "Approved" ? "Needs Revision" : r.status),
          now(),
          id,
          projectId,
          v.revision,
        );
      this.evidence(
        "relationship",
        this.relationship(projectId, id),
        "update",
        source,
      );
      return this.relationship(projectId, id);
    });
  }
  approveRelationship(
    projectId: string,
    id: string,
    input: z.input<typeof revisionAction>,
  ) {
    const v = revisionAction.parse(input);
    return this.store.transaction(() => {
      const r = this.relationship(projectId, id, true);
      this.checkRevision(r, v.revision);
      this.relationshipEndpoints(projectId, r, id);
      const source = this.citation(projectId, v.source);
      this.db
        .prepare(
          "UPDATE design_relationships SET status='Approved',revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?",
        )
        .run(now(), id, projectId, v.revision);
      this.evidence(
        "relationship",
        this.relationship(projectId, id),
        "approve",
        source,
      );
      return this.relationship(projectId, id);
    });
  }
  retireRelationship(
    projectId: string,
    id: string,
    input: z.input<typeof revisionAction>,
    operation = "retire",
  ) {
    const v = revisionAction.parse(input);
    return this.store.transaction(() => {
      const r = this.relationship(projectId, id, true);
      this.checkRevision(r, v.revision);
      const source = this.citation(projectId, v.source);
      this.db
        .prepare(
          "UPDATE design_relationships SET retired_at=?,updated_at=?,revision=revision+1 WHERE id=? AND project_id=? AND revision=?",
        )
        .run(now(), now(), id, projectId, v.revision);
      this.evidence(
        "relationship",
        this.relationship(projectId, id),
        operation,
        source,
      );
      return this.relationship(projectId, id);
    });
  }
  record(projectId: string, id: string): DesignRecord {
    // Normalized associations are authoritative. The old JSON column is retained as migration/creation evidence only.
    this.owned(projectId);
    const r = this.db
      .prepare("SELECT * FROM design_records WHERE id=? AND project_id=?")
      .get(id, projectId) as Row | undefined;
    if (!r) throw new AppError(404, "Design record not found in this project");
    return {
      id: r.id,
      projectId,
      kind: r.kind,
      text: r.text,
      rationale: r.rationale,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      revision: r.revision,
      supersededBy: r.superseded_by,
      resolution: r.resolution,
      resolvedAt: r.resolved_at,
      authoritative:
        r.kind === "decision" && r.status === "approved" && !r.superseded_by,
      relatedChapterIds: this.db
        .prepare(
          "SELECT chapter_id FROM record_chapters WHERE record_id=? ORDER BY rowid",
        )
        .all(id)
        .map((r) => String(r.chapter_id)),
      relatedConceptIds: this.db
        .prepare(
          "SELECT concept_id FROM record_concepts WHERE record_id=? ORDER BY rowid",
        )
        .all(id)
        .map((r) => String(r.concept_id)),
      unavailableChapterReferences: this.db
        .prepare(
          "SELECT reference,reason FROM legacy_record_links WHERE record_id=? ORDER BY rowid",
        )
        .all(id)
        .map((r) => ({
          reference: String(r.reference),
          reason: String(r.reason),
        })),
      sources: this.sources("record", id),
    };
  }
  records(projectId: string): DesignRecord[] {
    this.owned(projectId);
    return this.db
      .prepare(
        "SELECT id FROM design_records WHERE project_id=? ORDER BY rowid",
      )
      .all(projectId)
      .map((r) => this.record(projectId, String(r.id)));
  }
  private insertRecord(
    projectId: string,
    kind: "decision" | "question",
    v: z.output<typeof recordInput>,
    source: Evidence,
    actor: "manual" | "proposal" = "manual",
    inherited?: DesignRecord,
  ) {
    this.validateLinks(
      projectId,
      v.chapterIds,
      v.conceptIds,
      inherited?.relatedChapterIds,
      inherited?.relatedConceptIds,
    );
    const id = randomUUID(),
      date = now();
    this.db
      .prepare(
        "INSERT INTO design_records(id,project_id,kind,text,rationale,related_chapter_ids,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        projectId,
        kind,
        v.text,
        v.rationale,
        JSON.stringify(v.chapterIds),
        kind === "decision" ? "approved" : "open",
        date,
        date,
      );
    for (const chapterId of v.chapterIds)
      this.db
        .prepare("INSERT INTO record_chapters VALUES(?,?,?)")
        .run(projectId, id, chapterId);
    for (const conceptId of v.conceptIds)
      this.db
        .prepare("INSERT INTO record_concepts VALUES(?,?,?)")
        .run(projectId, id, conceptId);
    this.evidence(
      "record",
      this.record(projectId, id),
      "create",
      source,
      actor,
    );
    return this.record(projectId, id);
  }
  createRecord(
    projectId: string,
    kind: "decision" | "question",
    input: z.input<typeof recordInput>,
  ) {
    const v = recordInput.parse(input);
    return this.store.transaction(() => {
      this.owned(projectId);
      return this.insertRecord(
        projectId,
        kind,
        v,
        this.citation(projectId, v.source),
      );
    });
  }
  createRecordFromProposal(proposalId: string) {
    return this.store.transaction(() => {
      const p = this.db
        .prepare("SELECT * FROM proposals WHERE id=? AND status='accepted'")
        .get(proposalId) as Row | undefined;
      if (!p || !["record_decision", "record_question"].includes(p.kind))
        throw new AppError(400, "An accepted record proposal is required");
      const already = this.db
        .prepare("SELECT 1 FROM knowledge_sources WHERE proposal_id=?")
        .get(proposalId);
      if (already)
        throw new AppError(
          409,
          "This proposal already created a design record",
        );
      const source: Evidence = {
        kind: "proposal",
        proposalId: p.id,
        conversationId: p.conversation_id,
        messageId: p.message_id,
        details: "Explicitly accepted Workshop record proposal.",
      };
      if (p.chapter_id && p.base_revision !== null) {
        if (
          this.db
            .prepare(
              "SELECT 1 FROM chapter_revisions WHERE chapter_id=? AND revision=? AND project_id=?",
            )
            .get(p.chapter_id, p.base_revision, p.project_id)
        ) {
          source.chapterId = p.chapter_id;
          source.chapterRevision = p.base_revision;
        } else
          source.missingReason =
            "The proposal's original chapter revision was unavailable before history tracking.";
      }
      const v = recordInput.parse({
        text: docText(JSON.parse(p.content)),
        rationale: p.reason,
        chapterIds: JSON.parse(p.related_chapter_ids),
        conceptIds: [],
      });
      return this.insertRecord(
        p.project_id,
        p.kind === "record_decision" ? "decision" : "question",
        v,
        source,
        "proposal",
      );
    });
  }
  setRecordLinks(
    projectId: string,
    id: string,
    input: z.input<typeof recordLinksInput>,
  ) {
    const v = recordLinksInput.parse(input);
    return this.store.transaction(() => {
      const r = this.record(projectId, id);
      this.checkRevision(r, v.revision);
      this.validateLinks(
        projectId,
        v.chapterIds,
        v.conceptIds,
        r.relatedChapterIds,
        r.relatedConceptIds,
      );
      const source = this.citation(projectId, v.source);
      this.db
        .prepare(
          "DELETE FROM record_chapters WHERE record_id=? AND project_id=?",
        )
        .run(id, projectId);
      this.db
        .prepare(
          "DELETE FROM record_concepts WHERE record_id=? AND project_id=?",
        )
        .run(id, projectId);
      for (const chapterId of v.chapterIds)
        this.db
          .prepare("INSERT INTO record_chapters VALUES(?,?,?)")
          .run(projectId, id, chapterId);
      for (const conceptId of v.conceptIds)
        this.db
          .prepare("INSERT INTO record_concepts VALUES(?,?,?)")
          .run(projectId, id, conceptId);
      this.db
        .prepare(
          "UPDATE design_records SET revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?",
        )
        .run(now(), id, projectId, v.revision);
      this.evidence("record", this.record(projectId, id), "set_links", source);
      return this.record(projectId, id);
    });
  }
  supersedeDecision(
    projectId: string,
    id: string,
    input: z.input<typeof supersedeInput>,
  ) {
    const v = supersedeInput.parse(input);
    return this.store.transaction(() => {
      const r = this.record(projectId, id);
      this.checkRevision(r, v.revision);
      if (r.kind !== "decision" || !r.authoritative)
        throw new AppError(
          409,
          "Only a current approved decision can be superseded",
        );
      const source = this.citation(projectId, v.source);
      const next = this.insertRecord(
        projectId,
        "decision",
        {
          ...v,
          chapterIds: v.chapterIds ?? r.relatedChapterIds,
          conceptIds: v.conceptIds ?? r.relatedConceptIds,
        },
        source,
        "manual",
        r,
      );
      this.db
        .prepare(
          "UPDATE design_records SET superseded_by=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?",
        )
        .run(next.id, now(), id, projectId, v.revision);
      this.evidence("record", this.record(projectId, id), "supersede", source);
      return { previous: this.record(projectId, id), replacement: next };
    });
  }
  resolveQuestion(
    projectId: string,
    id: string,
    input: z.input<typeof questionResolution>,
  ) {
    const v = questionResolution.parse(input);
    return this.store.transaction(() => {
      const r = this.record(projectId, id);
      this.checkRevision(r, v.revision);
      if (r.kind !== "question" || r.status !== "open")
        throw new AppError(409, "Only an open question can be resolved");
      const source = this.citation(projectId, v.source),
        date = now();
      this.db
        .prepare(
          "UPDATE design_records SET status='resolved',resolution=?,resolved_at=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?",
        )
        .run(v.answer, date, date, id, projectId, v.revision);
      this.evidence("record", this.record(projectId, id), "resolve", source);
      return this.record(projectId, id);
    });
  }
  reopenQuestion(
    projectId: string,
    id: string,
    input: z.input<typeof revisionAction>,
  ) {
    const v = revisionAction.parse(input);
    return this.store.transaction(() => {
      const r = this.record(projectId, id);
      this.checkRevision(r, v.revision);
      if (r.kind !== "question" || r.status !== "resolved")
        throw new AppError(409, "Only a resolved question can be reopened");
      const source = this.citation(projectId, v.source);
      this.db
        .prepare(
          "UPDATE design_records SET status='open',resolution=NULL,resolved_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?",
        )
        .run(now(), id, projectId, v.revision);
      this.evidence("record", this.record(projectId, id), "reopen", source);
      return this.record(projectId, id);
    });
  }
  projectKnowledge(
    projectId: string,
    includeHistorical = false,
  ): ProjectKnowledge {
    this.owned(projectId);
    return {
      projectId,
      concepts: this.concepts(projectId, includeHistorical),
      relationships: this.relationships(projectId, includeHistorical),
      records: this.records(projectId).filter(
        (r) => includeHistorical || !r.supersededBy,
      ),
    };
  }
}
