import { randomUUID } from "node:crypto";
import type { Store } from "../../server/store.js";
import { textDoc } from "../../shared/types.js";
import { richDesignDocument } from "./rich-document.js";

export function representativeProject(
  store: Store,
  size: {
    chapters: number;
    concepts: number;
    relationships: number;
    messages: number;
  },
) {
  const project = store.createProject(
      "Representative retrieval fixture",
      "A synthetic world with interconnected mechanics",
    ),
    active = store.chapters(project.id)[0];
  let remote = active;
  const conceptIds: string[] = [],
    chapterIds = [active.id];
  store.transaction(() => {
    for (let i = 1; i < size.chapters; i++) {
      const c = store.createChapter(
        project.id,
        `Region ${i}`,
        textDoc(
          `Regional rules ${i}. ` +
            "Environmental detail without relevant query words. ".repeat(35),
        ),
      );
      chapterIds.push(c.id);
      if (i === size.chapters - 1)
        remote = store.updateChapter(c.id, {
          revision: c.revision,
          content: richDesignDocument,
        });
    }
    const date = new Date().toISOString(),
      insert = store.db.prepare(
        "INSERT INTO design_concepts(id,project_id,name,normalized_name,category,description,status,revision,approved_revision,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,'Exploring',0,NULL,?,?,NULL)",
      );
    for (let i = 0; i < size.concepts; i++) {
      const id = randomUUID();
      conceptIds.push(id);
      insert.run(
        id,
        project.id,
        `Regional subject ${i}`,
        `regional subject ${i}`,
        "world",
        `Regional subject description ${i}. ` +
          "Environmental detail. ".repeat(25),
        date,
        date,
      );
      store.db
        .prepare("INSERT INTO concept_chapters VALUES(?,?,?)")
        .run(project.id, id, chapterIds[i % chapterIds.length]);
    }
    const edge = store.db.prepare(
      "INSERT OR IGNORE INTO design_relationships(id,project_id,source_concept_id,target_concept_id,type,rationale,status,revision,created_at,updated_at,retired_at) VALUES(?,?,?,?,?,'Documented regional dependency','Exploring',0,?,?,NULL)",
    );
    for (let i = 0; i < size.relationships; i++) {
      const a = conceptIds[i % conceptIds.length],
        b =
          conceptIds[
            (i + 1 + Math.floor(i / conceptIds.length)) % conceptIds.length
          ];
      if (a !== b)
        edge.run(randomUUID(), project.id, a, b, "depends_on", date, date);
    }
    const w = store.workshop(remote.id);
    for (let i = 0; i < size.messages; i++)
      store.addMessage(
        w.conversationId,
        i % 2 ? "assistant" : "user",
        `Earlier regional discussion ${i}: environmental detail, not an approved fact.`,
      );
  });
  let extraction = store.knowledge.createConcept(project.id, {
    name: "Extraction",
    description: "Return discoveries through wormhole events",
  });
  extraction = store.knowledge.setConceptChapters(project.id, extraction.id, {
    revision: extraction.revision,
    chapterIds: [remote.id],
  });
  extraction = store.knowledge.approveConcept(project.id, extraction.id, {
    revision: extraction.revision,
  });
  const terrain = store.knowledge.createConcept(project.id, {
      name: "Terrain Stability",
      description: "Wormhole terrain controls extraction routes",
    }),
    relation = store.knowledge.createRelationship(project.id, {
      sourceConceptId: extraction.id,
      targetConceptId: terrain.id,
      type: "depends_on",
      rationale: "Returning discoveries requires a stable path",
    }),
    decision = store.knowledge.createRecord(project.id, "decision", {
      text: "Extraction preserves discoveries only after terrain stabilizes.",
      conceptIds: [extraction.id],
      chapterIds: [remote.id],
    });
  const historical = store.addMessage(
    store.workshop(remote.id).conversationId,
    "assistant",
    "We explored wormhole extraction through stable terrain before approving the return rule.",
  );
  return {
    project,
    active,
    remote,
    extraction,
    terrain,
    relation,
    decision,
    historical,
  };
}
