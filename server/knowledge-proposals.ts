import { randomUUID } from "node:crypto";
import { AppError, type Store } from "./store.js";
import { knowledgeChangeSchema } from "./ai.js";
import {
  canExplore,
  conceptReferences,
  type AppliedKnowledge,
  type ConceptReference,
  type KnowledgeProposalData,
  type ReviewOutcome,
} from "../shared/knowledge-proposals.js";
import {
  normalizedConceptName,
  symmetricRelationships,
  type ProjectKnowledge,
} from "../shared/knowledge.js";
import type { Chapter, Proposal } from "../shared/types.js";
import type { z } from "zod";

type Offer = z.input<typeof knowledgeChangeSchema>;
export class KnowledgeProposals {
  constructor(private store: Store) {}
  addBatch(
    conversationId: string,
    messageId: string,
    active: Chapter,
    captured: ProjectKnowledge,
    inputs: Offer[],
  ) {
    if (!inputs.length) return;
    return this.store.transaction(() => {
      const source = this.store.db
        .prepare(
          "SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id=c.id WHERE c.id=? AND c.project_id=? AND c.chapter_id=? AND m.id=? AND m.role='assistant' AND m.state='complete'",
        )
        .get(conversationId, active.projectId, active.id, messageId);
      if (!source || captured.projectId !== active.projectId)
        throw new AppError(400, "Invalid knowledge proposal source");
      this.store.chapter(active.id);
      const offers = inputs.map((input) => ({
        id: randomUUID(),
        change: knowledgeChangeSchema.parse(input),
      }));
      const aliases = new Map<
        string,
        { id: string; title: string; name: string }
      >();
      const names = new Set(
        captured.concepts
          .filter((c) => !c.archivedAt)
          .map((c) => c.normalizedName),
      );
      for (const o of offers) {
        const p = o.change.knowledge;
        if (p.action === "create_concept") {
          if (aliases.has(p.key) || names.has(normalizedConceptName(p.name)))
            throw new AppError(
              409,
              "A concept or proposal with this name/key already exists. Reuse the existing concept.",
            );
          aliases.set(p.key, { id: o.id, title: o.change.title, name: p.name });
          names.add(normalizedConceptName(p.name));
        }
      }
      const edges = new Set<string>();
      for (const o of offers) {
        const p = o.change.knowledge;
        const metadata: KnowledgeProposalData = {
          payload: p,
          before: null,
          guards: [],
          dependencies: [],
          labels: {},
          sourceChapterId: active.id,
          sourceRevision: active.revision,
        };
        const guard = (
          entity: KnowledgeProposalData["guards"][number]["entity"],
          value: { id: string; revision: number },
          label: string,
        ) => {
          if (
            !metadata.guards.some(
              (g) => g.entity === entity && g.id === value.id,
            )
          )
            metadata.guards.push({
              entity,
              id: value.id,
              revision: value.revision,
            });
          metadata.labels[value.id] = label;
        };
        guard("chapter", active, active.title);
        if ("targetId" in p) {
          const entity = p.action.includes("concept")
            ? "concept"
            : p.action.includes("relationship")
              ? "relationship"
              : "record";
          const value =
            entity === "concept"
              ? captured.concepts.find(
                  (c) => c.id === p.targetId && !c.archivedAt,
                )
              : entity === "relationship"
                ? captured.relationships.find(
                    (r) => r.id === p.targetId && !r.retiredAt,
                  )
                : captured.records.find((r) => r.id === p.targetId);
          if (!value || value.revision !== p.revision)
            throw new AppError(
              409,
              "The proposed target or revision is unavailable in the captured project context.",
            );
          if (
            p.action === "supersede_decision" &&
            !(
              "authoritative" in value &&
              value.authoritative &&
              "kind" in value &&
              value.kind === "decision"
            )
          )
            throw new AppError(
              409,
              "Only a current approved decision can be superseded",
            );
          if (
            p.action === "resolve_question" &&
            !(
              "kind" in value &&
              value.kind === "question" &&
              value.status === "open"
            )
          )
            throw new AppError(409, "Only an open question can be resolved");
          metadata.before = JSON.parse(JSON.stringify(value));
          guard(
            entity,
            value,
            "name" in value
              ? value.name
              : "text" in value
                ? value.text
                : "Existing relationship",
          );
          if (entity === "relationship" && "sourceConceptId" in value)
            for (const id of [value.sourceConceptId, value.targetConceptId]) {
              const c = captured.concepts.find(
                (c) => c.id === id && !c.archivedAt,
              );
              if (!c)
                throw new AppError(409, "A relationship endpoint is archived");
              guard("concept", c, c.name);
            }
          if ("relatedConceptIds" in value)
            for (const id of value.relatedConceptIds) {
              const c = captured.concepts.find(
                (c) => c.id === id && !c.archivedAt,
              );
              if (!c)
                throw new AppError(
                  409,
                  "A record's associated concept is archived",
                );
              guard("concept", c, c.name);
            }
          if ("sourceConceptId" in value)
            metadata.labels[value.id] =
              `${metadata.labels[value.sourceConceptId]} ${value.type.replaceAll("_", " ")} ${metadata.labels[value.targetConceptId]}`;
          if ("relatedChapterIds" in value)
            for (const id of value.relatedChapterIds)
              metadata.labels[id] = this.store.chapter(id, true).title;
          if (
            p.action === "update_concept" &&
            captured.concepts.some(
              (c) =>
                !c.archivedAt &&
                c.id !== p.targetId &&
                c.normalizedName === normalizedConceptName(p.name),
            )
          )
            throw new AppError(409, "An active concept already has this name");
        }
        if ("chapterIds" in p)
          for (const id of p.chapterIds) {
            const c = this.store.chapter(id);
            if (c.projectId !== active.projectId)
              throw new AppError(
                400,
                "Related chapter belongs to another project",
              );
            // A source chapter uses the pre-request snapshot; others are captured at generation.
            guard("chapter", id === active.id ? active : c, c.title);
          }
        for (const reference of conceptReferences(p)) {
          if ("id" in reference) {
            const c = captured.concepts.find(
              (c) => c.id === reference.id && !c.archivedAt,
            );
            if (!c)
              throw new AppError(
                400,
                "Referenced concept is archived or outside this project",
              );
            guard("concept", c, c.name);
          } else {
            const prerequisite = aliases.get(reference.newConcept);
            if (!prerequisite || prerequisite.id === o.id)
              throw new AppError(
                400,
                "Unknown or invalid new-concept dependency",
              );
            if (
              !metadata.dependencies.some((d) => d.key === reference.newConcept)
            )
              metadata.dependencies.push({
                key: reference.newConcept,
                proposalId: prerequisite.id,
                title: prerequisite.title,
              });
            metadata.labels[reference.newConcept] = prerequisite.name;
          }
        }
        if ("source" in p) {
          const refKey = (r: ConceptReference) =>
            "id" in r ? r.id : `new:${r.newConcept}`;
          const pair = [refKey(p.source), refKey(p.target)];
          if (pair[0] === pair[1])
            throw new AppError(400, "A concept cannot relate to itself");
          if (symmetricRelationships.has(p.type)) pair.sort();
          const key = `${p.type}:${pair.join(":")}`;
          if (
            edges.has(key) ||
            captured.relationships.some(
              (r) =>
                !r.retiredAt &&
                !("targetId" in p && p.targetId === r.id) &&
                r.type === p.type &&
                (symmetricRelationships.has(p.type)
                  ? [r.sourceConceptId, r.targetConceptId].sort()
                  : [r.sourceConceptId, r.targetConceptId]
                ).join(":") === pair.join(":"),
            )
          )
            throw new AppError(
              409,
              "This relationship already exists or is proposed twice",
            );
          edges.add(key);
        }
        if (p.action === "record_decision" || p.action === "record_question")
          if (
            captured.records.some(
              (r) =>
                !r.supersededBy &&
                r.kind ===
                  (p.action === "record_decision" ? "decision" : "question") &&
                normalizedConceptName(r.text) === normalizedConceptName(p.text),
            )
          )
            throw new AppError(409, "This design record already exists");
        this.store.db
          .prepare(
            "INSERT INTO proposals(id,conversation_id,message_id,project_id,chapter_id,title,content,reason,status,created_at,kind,description,related_chapter_ids,knowledge_payload) VALUES(?,?,?,?,NULL,?,?,?,'pending',?,'knowledge',?,'[]',?)",
          )
          .run(
            o.id,
            conversationId,
            messageId,
            active.projectId,
            o.change.title,
            JSON.stringify({ type: "doc", content: [] }),
            o.change.reason,
            new Date().toISOString(),
            o.change.description,
            JSON.stringify(metadata),
          );
      }
      for (const o of offers) {
        const row = this.store.db
          .prepare("SELECT knowledge_payload FROM proposals WHERE id=?")
          .get(o.id)!;
        const data: KnowledgeProposalData = JSON.parse(
          String(row.knowledge_payload),
        );
        for (const d of data.dependencies)
          this.store.db
            .prepare("INSERT INTO proposal_dependencies VALUES(?,?,?)")
            .run(o.id, d.proposalId, d.key);
      }
    });
  }
  accept(p: Proposal, outcome?: ReviewOutcome): AppliedKnowledge {
    const data = p.knowledge!;
    const v = data.payload;
    const k = this.store.knowledge;
    if (canExplore(v)) {
      if (outcome !== "exploring" && outcome !== "approve")
        throw new AppError(
          400,
          "Choose Accept as Exploring or Approve explicitly",
        );
    } else if (
      v.action === "record_decision" ||
      v.action === "supersede_decision"
    ) {
      if (outcome !== "approve")
        throw new AppError(400, "Decisions require explicit approval");
    } else if (outcome !== "accept")
      throw new AppError(400, "This action requires explicit acceptance");
    for (const g of data.guards) {
      const current =
        g.entity === "concept"
          ? k.concept(p.projectId, g.id, true)
          : g.entity === "relationship"
            ? k.relationship(p.projectId, g.id, true)
            : g.entity === "record"
              ? k.record(p.projectId, g.id)
              : this.store.chapter(g.id);
      if (current.projectId !== p.projectId || current.revision !== g.revision)
        throw new AppError(
          409,
          "The knowledge or source changed after generation. Regenerate and review a fresh proposal.",
        );
    }
    const resolve = (ref: ConceptReference): string => {
      if ("id" in ref) {
        k.concept(p.projectId, ref.id, true);
        return ref.id;
      }
      const dependency = data.dependencies.find(
        (d) => d.key === ref.newConcept,
      );
      const row =
        dependency &&
        this.store.db
          .prepare(
            "SELECT status,project_id,applied_result FROM proposals WHERE id=?",
          )
          .get(dependency.proposalId);
      const result: AppliedKnowledge | null = row?.applied_result
        ? JSON.parse(String(row.applied_result))
        : null;
      if (
        !row ||
        row.project_id !== p.projectId ||
        row.status !== "accepted" ||
        result?.entity !== "concept"
      )
        throw new AppError(
          409,
          "Accept the prerequisite concept proposal first. No dependencies were accepted automatically.",
        );
      const c = k.concept(p.projectId, result.id, true);
      if (c.revision !== result.revision)
        throw new AppError(
          409,
          "A prerequisite concept changed after acceptance. Regenerate this dependent proposal.",
        );
      return c.id;
    };
    const conceptIds = "concepts" in v ? v.concepts.map(resolve) : [];
    if (new Set(conceptIds).size !== conceptIds.length)
      throw new AppError(400, "Duplicate concept references");
    const endpoints =
      "source" in v
        ? {
            sourceConceptId: resolve(v.source),
            targetConceptId: resolve(v.target),
          }
        : null;
    if (
      (v.action === "record_decision" || v.action === "record_question") &&
      k
        .records(p.projectId)
        .some(
          (r) =>
            !r.supersededBy &&
            r.kind ===
              (v.action === "record_decision" ? "decision" : "question") &&
            normalizedConceptName(r.text) === normalizedConceptName(v.text),
        )
    )
      throw new AppError(409, "This design record already exists");
    this.store.db
      .prepare("UPDATE proposals SET status='accepted' WHERE id=?")
      .run(p.id);
    return k.withAcceptedProposal(p.id, () => {
      let result: { id: string; revision: number };
      let entity: AppliedKnowledge["entity"];
      if (v.action === "create_concept") {
        result = k.createConcept(p.projectId, {
          name: v.name,
          category: v.category,
          description: v.description,
        });
        if (v.chapterIds.length)
          result = k.setConceptChapters(p.projectId, result.id, {
            revision: result.revision,
            chapterIds: v.chapterIds,
          });
        entity = "concept";
      } else if (v.action === "update_concept") {
        result = k.updateConcept(p.projectId, v.targetId, {
          revision: v.revision,
          name: v.name,
          category: v.category,
          description: v.description,
          status: "Exploring",
        });
        entity = "concept";
      } else if (v.action === "associate_concept") {
        result = k.setConceptChapters(p.projectId, v.targetId, {
          revision: v.revision,
          chapterIds: v.chapterIds,
        });
        if (outcome === "exploring")
          result = k.updateConcept(p.projectId, result.id, {
            revision: result.revision,
            status: "Exploring",
          });
        entity = "concept";
      } else if (v.action === "create_relationship") {
        result = k.createRelationship(p.projectId, {
          ...endpoints!,
          type: v.type,
          rationale: v.rationale,
        });
        entity = "relationship";
      } else if (v.action === "update_relationship") {
        result = k.updateRelationship(p.projectId, v.targetId, {
          revision: v.revision,
          ...endpoints!,
          type: v.type,
          rationale: v.rationale,
          status: "Exploring",
        });
        entity = "relationship";
      } else if (v.action === "retire_relationship") {
        result = k.retireRelationship(p.projectId, v.targetId, {
          revision: v.revision,
        });
        entity = "relationship";
      } else if (v.action === "resolve_question") {
        result = k.resolveQuestion(p.projectId, v.targetId, {
          revision: v.revision,
          answer: v.answer,
        });
        entity = "record";
      } else if (v.action === "supersede_decision") {
        result = k.supersedeDecision(p.projectId, v.targetId, {
          revision: v.revision,
          text: v.text,
          rationale: v.rationale,
          chapterIds: v.chapterIds,
          conceptIds,
        }).replacement;
        entity = "record";
      } else {
        result = k.createRecord(
          p.projectId,
          v.action === "record_decision" ? "decision" : "question",
          {
            text: v.text,
            rationale: v.rationale,
            chapterIds: v.chapterIds,
            conceptIds,
          },
        );
        entity = "record";
      }
      if (outcome === "approve" && entity === "concept")
        result = k.approveConcept(p.projectId, result.id, {
          revision: result.revision,
        });
      if (
        outcome === "approve" &&
        entity === "relationship" &&
        v.action !== "retire_relationship"
      )
        result = k.approveRelationship(p.projectId, result.id, {
          revision: result.revision,
        });
      const applied: AppliedKnowledge = {
        entity,
        id: result.id,
        revision: result.revision,
        outcome: outcome!,
      };
      this.store.db
        .prepare("UPDATE proposals SET applied_result=? WHERE id=?")
        .run(JSON.stringify(applied), p.id);
      return applied;
    });
  }
}
