import type { Store } from "./store.js";
import type {
  ProjectKnowledge,
  DesignRelationship,
} from "../shared/knowledge.js";
import { docText, type Doc } from "../shared/types.js";
import {
  documentSections,
  type DocumentReceipt,
} from "../shared/document-proposals.js";
import { documentExcerpt } from "../shared/document-context.js";
const stop = new Set(
  "the and this that with from have what when where should would could about into does design game chapter system please only keep explain".split(
    " ",
  ),
);
export const normalize = (s: string) => s.normalize("NFKC").toLowerCase();
export function containsPhrase(text: string, phrase: string) {
  if (!phrase.trim()) return false;
  const escaped = normalize(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`,
    "u",
  ).test(normalize(text));
}
export const terms = (s: string) =>
  new Set(
    (normalize(s).match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(
      (t) => !stop.has(t),
    ),
  );
export function relevance(query: Set<string>, text: string) {
  const words = terms(text);
  return [...query].filter((t) => words.has(t)).length;
}
export function sectionIndex(doc: Doc) {
  const stack: { heading: string; level: number }[] = [];
  return documentSections(doc).map((s) => {
    while (stack.length && stack.at(-1)!.level >= s.level) stack.pop();
    stack.push(s);
    return { ...s, path: stack.map((x) => x.heading) };
  });
}
export function sectionExcerpt(
  doc: Doc,
  budget: number,
  instruction: string,
  recentTopic = "",
): { document: Doc; receipt: DocumentReceipt } {
  if (Buffer.byteLength(JSON.stringify(doc), "utf8") <= budget)
    return documentExcerpt(doc, budget, instruction);
  const query = terms(instruction),
    continuityQuery = terms(recentTopic),
    nodes = doc.content ?? [],
    sections = sectionIndex(doc),
    ranked = sections
      .map((s) => ({
        s,
        score:
          (s.heading.trim() && containsPhrase(instruction, s.heading)
            ? 100
            : 0) +
          relevance(query, s.heading) * 5 +
          (containsPhrase(recentTopic, s.heading) ? 40 : 0) +
          relevance(
            continuityQuery,
            docText({ type: "doc", content: nodes.slice(s.start, s.end) }),
          ) +
          relevance(
            query,
            docText({ type: "doc", content: nodes.slice(s.start, s.end) }),
          ),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.s.start - b.s.start);
  const included = new Set<number>();
  let used = 40;
  for (const { s } of ranked) {
    const missing = nodes
      .slice(s.start, s.end)
      .map((n, i) => ({ n, i: s.start + i }))
      .filter((x) => !included.has(x.i));
    const cost = missing.reduce(
      (sum, x) => sum + Buffer.byteLength(JSON.stringify(x.n), "utf8") + 1,
      0,
    );
    if (used + cost <= budget) {
      missing.forEach((x) => included.add(x.i));
      used += cost;
    }
  }
  if (!included.size) {
    for (let i = 0; i < nodes.length; i++) {
      const cost = Buffer.byteLength(JSON.stringify(nodes[i]), "utf8") + 1;
      if (used + cost <= budget) {
        included.add(i);
        used += cost;
      }
    }
  }
  const indexes = [...included].sort((a, b) => a - b);
  return {
    document: {
      type: "doc",
      content: indexes.length
        ? indexes.map((i) => nodes[i])
        : [{ type: "paragraph" }],
    },
    receipt: {
      complete: indexes.length === nodes.length,
      includedBlockIndexes: indexes,
      completeSections: sections
        .filter((s) =>
          Array.from({ length: s.end - s.start }, (_, i) => s.start + i).every(
            (i) => included.has(i),
          ),
        )
        .map((s) => s.heading),
    },
  };
}
export function traverseRelationships(
  seeds: string[],
  relationships: DesignRelationship[],
  options = { hops: 2, concepts: 40, edges: 60 },
) {
  const visited = new Set(seeds.slice(0, options.concepts)),
    edges: {
      relationship: DesignRelationship;
      direction: string;
      hop: number;
    }[] = [],
    seen = new Set<string>(),
    ordered = [...relationships].sort((a, b) => a.id.localeCompare(b.id));
  let frontier = [...visited];
  for (let hop = 1; hop <= options.hops && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const r of ordered) {
        if (
          r.retiredAt ||
          ![r.sourceConceptId, r.targetConceptId].includes(id) ||
          seen.has(r.id)
        )
          continue;
        if (edges.length >= options.edges) break;
        const other =
          r.sourceConceptId === id ? r.targetConceptId : r.sourceConceptId;
        if (!visited.has(other) && visited.size >= options.concepts) continue;
        edges.push({
          relationship: r,
          direction: ["interacts_with", "conflicts_with"].includes(r.type)
            ? "symmetric"
            : r.sourceConceptId === id
              ? "outgoing"
              : "incoming",
          hop,
        });
        seen.add(r.id);
        if (!visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    frontier = next;
  }
  return {
    conceptIds: visited,
    edges,
    limited: relationships.some(
      (r) =>
        !r.retiredAt &&
        !seen.has(r.id) &&
        (visited.has(r.sourceConceptId) || visited.has(r.targetConceptId)),
    ),
  };
}
export function retrievalKnowledge(
  store: Store,
  projectId: string,
): ProjectKnowledge {
  store.project(projectId);
  const db = store.db;
  const links = (table: string, key: string, column: string) => {
    const map = new Map<string, string[]>();
    for (const r of db
      .prepare(
        `SELECT ${key},${column} FROM ${table} WHERE project_id=? ORDER BY ${column}`,
      )
      .all(projectId)) {
      const id = String(r[key]);
      map.set(id, [...(map.get(id) ?? []), String(r[column])]);
    }
    return map;
  };
  const cc = links("concept_chapters", "concept_id", "chapter_id"),
    rc = links("record_chapters", "record_id", "chapter_id"),
    rr = links("record_concepts", "record_id", "concept_id");
  const concepts = db
    .prepare("SELECT * FROM design_concepts WHERE project_id=? ORDER BY id")
    .all(projectId)
    .map((r: any) => ({
      id: r.id,
      projectId,
      name: r.name,
      normalizedName: r.normalized_name,
      description: r.description,
      category: r.category,
      status: r.status,
      revision: r.revision,
      approvedRevision: r.approved_revision,
      authoritative: r.status === "Approved" && !r.archived_at,
      archivedAt: r.archived_at,
      chapterIds: cc.get(r.id) ?? [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      sources: [],
    }));
  const live = new Set(concepts.filter((c) => !c.archivedAt).map((c) => c.id));
  const relationships = db
    .prepare(
      "SELECT * FROM design_relationships WHERE project_id=? ORDER BY id",
    )
    .all(projectId)
    .map((r: any) => ({
      id: r.id,
      projectId,
      sourceConceptId: r.source_concept_id,
      targetConceptId: r.target_concept_id,
      type: r.type,
      rationale: r.rationale,
      status: r.status,
      revision: r.revision,
      authoritative:
        r.status === "Approved" &&
        !r.retired_at &&
        live.has(r.source_concept_id) &&
        live.has(r.target_concept_id),
      retiredAt: r.retired_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      sources: [],
    }));
  const records = db
    .prepare("SELECT * FROM design_records WHERE project_id=? ORDER BY id")
    .all(projectId)
    .map((r: any) => ({
      id: r.id,
      projectId,
      kind: r.kind,
      text: r.text,
      rationale: r.rationale,
      status: r.status,
      revision: r.revision,
      supersededBy: r.superseded_by,
      resolution: r.resolution,
      resolvedAt: r.resolved_at,
      authoritative:
        r.kind === "decision" && r.status === "approved" && !r.superseded_by,
      relatedChapterIds: rc.get(r.id) ?? [],
      relatedConceptIds: rr.get(r.id) ?? [],
      unavailableChapterReferences: [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      sources: [],
    }));
  return { projectId, concepts, relationships, records };
}
