import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import { Store } from "../server/store.js";
import { buildContext } from "../server/context.js";
import { representativeProject } from "./fixtures/context-project.js";

test("representative large project retains relevant sources and continuity within measured request/storage budgets", () => {
  const db = openDatabase(":memory:"),
    store = new Store(db);
  try {
    const f = representativeProject(store, {
        chapters: 300,
        concepts: 1500,
        relationships: 4500,
        messages: 1000,
      }),
      w = store.workshop(f.active.id),
      prior = store.addMessage(
        w.conversationId,
        "assistant",
        "Which route should announce the returning player?",
      ),
      current = store.addMessage(
        w.conversationId,
        "user",
        "Explain Extraction, wormhole terrain stability, and our earlier discussion.",
      );
    const started = performance.now(),
      ctx = buildContext(store, f.active.id, [prior, current]),
      elapsed = performance.now() - started,
      manifest = ctx.manifest!;
    assert.ok(elapsed < 8000, `Retrieval took ${elapsed.toFixed(0)}ms`);
    assert.ok(ctx.messages.some((m) => m.id === prior.id));
    assert.ok(ctx.knowledge!.concepts.some((c) => c.id === f.extraction.id));
    assert.ok(ctx.knowledge!.relationships.some((r) => r.id === f.relation.id));
    assert.ok(ctx.knowledge!.records.some((r) => r.id === f.decision.id));
    assert.ok(ctx.relevant.some((c) => c.id === f.remote.id));
    assert.ok(
      ctx.retrieval!.earlier.some((m: any) => m.id === f.historical.id),
    );
    assert.ok(manifest.contextBytes <= manifest.limits.contextBytes);
    assert.ok(manifest.requestBytes <= manifest.limits.requestBytes);
    assert.ok(manifest.omissions.some((o) => o.kind === "outline"));
    assert.ok(ctx.retrieval!.outline.some((o: any) => o.kind === "chapter"));
    assert.ok(ctx.retrieval!.outline.some((o: any) => o.kind === "concept"));
    const requestId = store.context.capture(ctx, current.id),
      response = store.addMessage(
        w.conversationId,
        "assistant",
        "Retained synthetic request",
      );
    store.context.attach(requestId, response.id);
    const row = db
      .prepare(
        "SELECT length(CAST(context_json AS BLOB))+length(CAST(manifest_json AS BLOB))+length(CAST(request_json AS BLOB)) cost FROM workshop_context_requests WHERE id=?",
      )
      .get(requestId)!;
    assert.ok(Number(row.cost) < 500000);
    assert.equal(
      manifest.sources.find(
        (s) => s.id === f.extraction.id && s.kind === "concept",
      )?.authority,
      "current-approved",
    );
  } finally {
    db.close();
  }
});
