// Synthetic, in-memory workload only; never reads .env or the user's database.
import { writeFileSync } from "node:fs";
import { openDatabase } from "../server/db.js";
import { Store } from "../server/store.js";
import { buildContext } from "../server/context.js";
import { representativeProject } from "../tests/fixtures/context-project.js";
const workloads = [
  {
    name: "small",
    chapters: 10,
    concepts: 30,
    relationships: 60,
    messages: 20,
  },
  {
    name: "medium",
    chapters: 100,
    concepts: 300,
    relationships: 900,
    messages: 200,
  },
  {
    name: "large",
    chapters: 300,
    concepts: 1500,
    relationships: 4500,
    messages: 1000,
  },
];
const measurements = [];
for (const workload of workloads) {
  const db = openDatabase(":memory:"),
    store = new Store(db);
  try {
    const f = representativeProject(store, workload),
      w = store.workshop(f.active.id),
      prior = store.addMessage(
        w.conversationId,
        "assistant",
        "Which return signal should tell the player the route is ready?",
      );
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const current = store.addMessage(
        w.conversationId,
        "user",
        "Explain Extraction, wormhole terrain stability, and our earlier discussion.",
      );
      const start = performance.now(),
        ctx = buildContext(store, f.active.id, [prior, current], null, {
          model: "gpt-4.1-mini",
        }),
        elapsed = performance.now() - start,
        id = store.context.capture(ctx, current.id),
        reply = store.addMessage(
          w.conversationId,
          "assistant",
          "Synthetic measurement response",
        );
      store.context.attach(id, reply.id);
      const stored = db
        .prepare(
          "SELECT length(CAST(context_json AS BLOB))+length(CAST(manifest_json AS BLOB))+length(CAST(request_json AS BLOB)) bytes FROM workshop_context_requests WHERE id=?",
        )
        .get(id)!;
      const expected = [
          f.extraction.id,
          f.terrain.id,
          f.relation.id,
          f.decision.id,
          f.remote.id,
          f.historical.id,
        ],
        retrieved = new Set(
          ctx
            .manifest!.sources.filter((s) => s.coverage !== "overview")
            .map((s) => s.id),
        );
      runs.push({
        retrievalMs: Number(elapsed.toFixed(2)),
        contextBytes: ctx.manifest!.contextBytes,
        requestBytes: ctx.manifest!.requestBytes,
        inputTokenEstimate: ctx.manifest!.estimatedInputTokens,
        tokenMethod: ctx.manifest!.tokenMethod,
        outputHeadroom: ctx.manifest!.limits.outputTokens,
        suppliedSources: ctx.manifest!.sources.length,
        omissionEntries: ctx.manifest!.omissions.length,
        expectedRelevantSources: expected.length,
        retrievedExpectedSources: expected.filter((id) => retrieved.has(id))
          .length,
        storedTextBytes: Number(stored.bytes),
        immediateExchangeRetained: ctx.messages.some((m) => m.id === prior.id),
      });
    }
    measurements.push({
      ...workload,
      actualConcepts: workload.concepts + 2,
      actualChapters: workload.chapters,
      runs,
      storageFor1000SimilarRequestsMiB: Number(
        (
          ((runs.reduce((sum, r) => sum + r.storedTextBytes, 0) / runs.length) *
            1000) /
          1024 /
          1024
        ).toFixed(2),
      ),
    });
  } finally {
    db.close();
  }
}
const report = {
  measuredAt: new Date().toISOString(),
  runtime: process.version,
  contextFormat: "forge-chat-context-v1",
  notes:
    "Synthetic in-memory fixtures. Text storage excludes SQLite page/index/WAL overhead. First run can include tokenizer initialization; timings are observations, not a production SLA.",
  measurements,
};
writeFileSync(
  "docs/MILESTONE_6_CONTEXT_MEASUREMENTS.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
