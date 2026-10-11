import { buildContext } from "./context.js";
import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import {
  chapterInput,
  chapterUpdate,
  projectInput,
  workflows,
} from "../shared/types.js";
import { Store, AppError } from "./store.js";
import { openAIAssistant, answerSchema, type DesignAssistant } from "./ai.js";
import { registerKnowledgeRoutes } from "./knowledge-routes.js";
import { questionResolution } from "../shared/knowledge.js";

export function createApp(
  store: Store,
  options: {
    assistant?: DesignAssistant;
    aiConfigured?: boolean;
    staticRoot?: string;
  } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 600_000 });
  const assistant = options.assistant ?? openAIAssistant;
  const configured =
    options.aiConfigured ?? Boolean(process.env.OPENAI_API_KEY?.trim());
  const busy = new Set<string>();
  app.addHook("onRequest", async (request) => {
    // Local-only API: reject browser requests from other origins and DNS rebinding.
    const hostname = request.hostname;
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname))
      throw new AppError(403, "Forge accepts loopback requests only.");
    if (request.headers.origin) {
      const origin = new URL(request.headers.origin);
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
        !["http:", "https:"].includes(origin.protocol)
      )
        throw new AppError(403, "This origin cannot access Forge.");
      const allowedPorts = ["5173", String(process.env.PORT || 4310)];
      if (!allowedPorts.includes(origin.port))
        throw new AppError(403, "This origin cannot access Forge.");
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({ error: error.issues.map((i) => i.message).join("; ") });
    if (error instanceof AppError)
      return reply.code(error.status).send({ error: error.message });
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({ error: error.message });
    return reply.code(500).send({
      error:
        "Forge could not complete this operation. Your saved work is still available.",
    });
  });
  app.get("/api/health", async () => ({
    ok: true,
    aiConfigured: configured,
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  }));
  app.get("/api/projects", async () => store.projects());
  app.post("/api/projects", async (request) => {
    const input = projectInput.parse(request.body);
    return store.createProject(input.title, input.premise);
  });
  app.patch<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (request) => {
      const input = projectInput.parse(request.body);
      return store.updateProject(request.params.id, input.title, input.premise);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/chapters",
    async (request) => store.chapters(request.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/chapters",
    async (request) => {
      const input = chapterInput.parse(request.body);
      return store.createChapter(
        request.params.id,
        input.title,
        input.content,
        input.status,
        input.parentId,
      );
    },
  );
  app.put<{ Params: { id: string } }>(
    "/api/projects/:id/order",
    async (request) =>
      store.reorder(
        request.params.id,
        z.object({ ids: z.array(z.string().uuid()) }).parse(request.body).ids,
      ),
  );
  app.get<{ Params: { id: string } }>("/api/chapters/:id", async (request) =>
    store.chapter(request.params.id, true),
  );
  app.get<{ Params: { id: string } }>(
    "/api/chapters/:id/history",
    async (request) => store.history(request.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/archived-chapters",
    async (request) => store.chapters(request.params.id, true),
  );
  const revisionInput = z
    .object({ revision: z.number().int().nonnegative() })
    .strict();
  app.post<{ Params: { id: string } }>(
    "/api/chapters/:id/approve",
    async (request) =>
      store.approveChapter(
        request.params.id,
        revisionInput.parse(request.body).revision,
      ),
  );
  app.post<{ Params: { id: string } }>(
    "/api/chapters/:id/restore",
    async (request) => {
      const input = revisionInput
        .extend({ savedRevision: z.number().int().nonnegative() })
        .parse(request.body);
      return store.restoreChapter(
        request.params.id,
        input.savedRevision,
        input.revision,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/chapters/:id/unarchive",
    async (request) =>
      store.unarchiveChapter(
        request.params.id,
        revisionInput.parse(request.body).revision,
      ),
  );
  app.patch<{ Params: { id: string } }>(
    "/api/chapters/:id",
    async (request) => {
      const input = chapterUpdate.parse(request.body);
      if (
        input.status === "Approved" &&
        store.chapter(request.params.id).status !== "Approved"
      )
        throw new AppError(
          400,
          "Use Approve current version to approve an exact saved revision.",
        );
      return store.updateChapter(request.params.id, input);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/chapters/:id",
    async (request) => {
      const c = store.chapter(request.params.id);
      if (busy.has(c.projectId))
        throw new AppError(
          409,
          "Stop the Workshop response before archiving this chapter.",
        );
      store.archiveChapter(c.id, revisionInput.parse(request.body).revision);
      return { ok: true };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/chapters/:id/workshop",
    async (request) => store.workshop(request.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/records",
    async (request) => store.records(request.params.id),
  );
  app.post<{ Params: { id: string; recordId: string } }>(
    "/api/projects/:id/questions/:recordId/resolve",
    async (request) =>
      store.resolveQuestion(
        request.params.id,
        request.params.recordId,
        questionResolution.parse(request.body),
      ),
  );
  app.post<{ Params: { id: string } }>(
    "/api/proposals/:id/review",
    async (request) => {
      const input = z
        .object({
          decision: z.enum(["accept", "reject"]),
          parentId: z.string().uuid().nullable().optional(),
        })
        .strict()
        .parse(request.body);
      return store.reviewProposal(
        request.params.id,
        input.decision,
        input.parentId === undefined ? undefined : { parentId: input.parentId },
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/chapters/:id/chat",
    async (request, reply) => {
      if (!configured)
        throw new AppError(
          503,
          "Set OPENAI_API_KEY in the backend environment and restart Forge to connect the Workshop.",
        );
      const { content, workflow } = z
        .object({
          content: z.string().trim().min(1).max(20000),
          workflow: z.enum(workflows).optional(),
        })
        .parse(request.body);
      const active = store.chapter(request.params.id),
        project = store.project(active.projectId);
      if (busy.has(project.id))
        throw new AppError(
          409,
          "A Workshop response is already in progress for this project.",
        );
      const workshop = store.workshop(active.id);
      busy.add(project.id);
      const user = store.addMessage(workshop.conversationId, "user", content);
      const context = buildContext(
        store,
        active.id,
        [...workshop.messages, user],
        workflow ?? null,
      );
      const controller = new AbortController();
      const abort = () => controller.abort();
      reply.raw.on("close", abort);
      const timeout = setTimeout(abort, 120_000);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      const emit = (event: string, data: unknown) => {
        if (!reply.raw.destroyed)
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      let partial = "";
      emit("user", user);
      try {
        const result = answerSchema.parse(
          await assistant(context, controller.signal, (text) => {
            partial = text;
            emit("reply", { text });
          }),
        );
        if (controller.signal.aborted)
          throw new Error("The conversation was interrupted.");
        for (const p of result.proposals)
          if (p.chapterId && p.chapterId !== active.id)
            throw new Error(
              "The AI proposed a change outside the active chapter. Try again with a focused request.",
            );
        if (
          context.activeTruncated &&
          result.proposals.some(
            (p) => p.kind === "update_chapter" || (!p.kind && p.chapterId),
          )
        )
          throw new Error(
            "This chapter is too large for a safe full replacement. Ask for a section proposal instead.",
          );
        store.transaction(() => {
          const message = store.addMessage(
            workshop.conversationId,
            "assistant",
            result.reply,
          );
          result.proposals.forEach((p) =>
            store.addProposal(
              workshop.conversationId,
              message.id,
              project.id,
              p,
              p.chapterId ? active.revision : null,
              p.chapterId ? active : undefined,
            ),
          );
        });
        emit("complete", store.workshop(active.id));
      } catch (error) {
        const interrupted =
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError");
        store.addMessage(
          workshop.conversationId,
          "assistant",
          partial ||
            (interrupted
              ? "Response interrupted. You can continue this conversation."
              : "No response completed. Please try again."),
          interrupted ? "interrupted" : "failed",
        );
        const safe =
          error instanceof ZodError
            ? "The AI returned an invalid proposal. No book changes were made."
            : error instanceof Error
              ? error.message
              : "The Workshop could not complete this request.";
        emit("error", {
          error: interrupted
            ? "Response interrupted. No proposals were applied."
            : safe,
        });
        emit("complete", store.workshop(active.id));
      } finally {
        clearTimeout(timeout);
        reply.raw.off("close", abort);
        busy.delete(project.id);
        reply.raw.end();
      }
    },
  );
  registerKnowledgeRoutes(app, store);
  const root = options.staticRoot ?? resolve("dist");
  if (existsSync(root)) {
    app.register(staticFiles, { root });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "API route not found" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
