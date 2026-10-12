import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "./store.js";
import {
  conceptInput,
  conceptUpdate,
  conceptRestore,
  relationshipInput,
  relationshipUpdate,
  recordInput,
  recordLinksInput,
  supersedeInput,
  revisionAction,
  questionResolution,
} from "../shared/knowledge.js";
type Scope = { projectId: string; id: string };
const listQuery = z
  .object({
    includeHistorical: z.enum(["true", "false"]).default("false"),
    q: z.string().trim().max(120).default(""),
  })
  .strict();

export function registerKnowledgeRoutes(app: FastifyInstance, store: Store) {
  const knowledge = store.knowledge;
  app.get<{ Params: Scope }>(
    "/api/projects/:projectId/knowledge/sources/:id",
    async (req) => knowledge.sourceDetail(req.params.projectId, req.params.id),
  );
  app.get<{ Params: Scope }>(
    "/api/projects/:projectId/knowledge",
    async (req) =>
      knowledge.projectKnowledge(
        req.params.projectId,
        listQuery.parse(req.query).includeHistorical === "true",
      ),
  );
  app.get<{ Params: Scope }>(
    "/api/projects/:projectId/concepts",
    async (req) => {
      const q = listQuery.parse(req.query);
      return knowledge.concepts(
        req.params.projectId,
        q.includeHistorical === "true",
        q.q,
      );
    },
  );
  app.post<{ Params: Scope }>(
    "/api/projects/:projectId/concepts",
    async (req) =>
      knowledge.createConcept(
        req.params.projectId,
        conceptInput.parse(req.body),
      ),
  );
  app.get<{ Params: Scope }>(
    "/api/projects/:projectId/concepts/:id",
    async (req) => knowledge.concept(req.params.projectId, req.params.id),
  );
  app.patch<{ Params: Scope }>(
    "/api/projects/:projectId/concepts/:id",
    async (req) =>
      knowledge.updateConcept(
        req.params.projectId,
        req.params.id,
        conceptUpdate.parse(req.body),
      ),
  );
  app.post<{ Params: Scope }>(
    "/api/projects/:projectId/concepts/:id/approve",
    async (req) =>
      knowledge.approveConcept(
        req.params.projectId,
        req.params.id,
        revisionAction.parse(req.body),
      ),
  );
  app.post<{ Params: Scope }>(
    "/api/projects/:projectId/concepts/:id/archive",
    async (req) =>
      knowledge.archiveConcept(
        req.params.projectId,
        req.params.id,
        revisionAction.parse(req.body),
      ),
  );
  app.post<{ Params: Scope }>(
    "/api/projects/:projectId/concepts/:id/restore",
    async (req) =>
      knowledge.restoreConcept(
        req.params.projectId,
        req.params.id,
        conceptRestore.parse(req.body),
      ),
  );
  app.put<{ Params: Scope }>(
    "/api/projects/:projectId/concepts/:id/chapters",
    async (req) =>
      knowledge.setConceptChapters(
        req.params.projectId,
        req.params.id,
        recordLinksInput.omit({ conceptIds: true }).parse(req.body),
      ),
  );
  app.get<{ Params: Scope }>(
    "/api/projects/:projectId/concepts/:id/history",
    async (req) =>
      knowledge.history(req.params.projectId, "concept", req.params.id),
  );
  app.get<{ Params: Scope }>(
    "/api/projects/:projectId/relationships",
    async (req) =>
      knowledge.relationships(
        req.params.projectId,
        listQuery.parse(req.query).includeHistorical === "true",
      ),
  );
  app.post<{ Params: Scope }>(
    "/api/projects/:projectId/relationships",
    async (req) =>
      knowledge.createRelationship(
        req.params.projectId,
        relationshipInput.parse(req.body),
      ),
  );
  app.get<{ Params: Scope }>(
    "/api/projects/:projectId/relationships/:id",
    async (req) => knowledge.relationship(req.params.projectId, req.params.id),
  );
  app.patch<{ Params: Scope }>(
    "/api/projects/:projectId/relationships/:id",
    async (req) =>
      knowledge.updateRelationship(
        req.params.projectId,
        req.params.id,
        relationshipUpdate.parse(req.body),
      ),
  );
  app.post<{ Params: Scope }>(
    "/api/projects/:projectId/relationships/:id/approve",
    async (req) =>
      knowledge.approveRelationship(
        req.params.projectId,
        req.params.id,
        revisionAction.parse(req.body),
      ),
  );
  app.post<{ Params: Scope }>(
    "/api/projects/:projectId/relationships/:id/retire",
    async (req) =>
      knowledge.retireRelationship(
        req.params.projectId,
        req.params.id,
        revisionAction.parse(req.body),
      ),
  );
  app.get<{ Params: Scope }>(
    "/api/projects/:projectId/relationships/:id/history",
    async (req) =>
      knowledge.history(req.params.projectId, "relationship", req.params.id),
  );
  app.post<{ Params: Scope }>(
    "/api/projects/:projectId/decisions",
    async (req) =>
      knowledge.createRecord(
        req.params.projectId,
        "decision",
        recordInput.parse(req.body),
      ),
  );
  app.post<{ Params: Scope }>(
    "/api/projects/:projectId/questions",
    async (req) =>
      knowledge.createRecord(
        req.params.projectId,
        "question",
        recordInput.parse(req.body),
      ),
  );
  app.get<{ Params: Scope }>(
    "/api/projects/:projectId/records/:id",
    async (req) => knowledge.record(req.params.projectId, req.params.id),
  );
  app.get<{ Params: Scope }>(
    "/api/projects/:projectId/records/:id/history",
    async (req) =>
      knowledge.history(req.params.projectId, "record", req.params.id),
  );
  app.put<{ Params: Scope }>(
    "/api/projects/:projectId/records/:id/links",
    async (req) =>
      knowledge.setRecordLinks(
        req.params.projectId,
        req.params.id,
        recordLinksInput.parse(req.body),
      ),
  );
  app.post<{ Params: Scope }>(
    "/api/projects/:projectId/decisions/:id/supersede",
    async (req) =>
      knowledge.supersedeDecision(
        req.params.projectId,
        req.params.id,
        supersedeInput.parse(req.body),
      ),
  );
  app.post<{ Params: Scope }>(
    "/api/projects/:projectId/questions/:id/reopen",
    async (req) =>
      knowledge.reopenQuestion(
        req.params.projectId,
        req.params.id,
        revisionAction.parse(req.body),
      ),
  );
}
