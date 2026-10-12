import {
  docText,
  type Chapter,
  type Message,
  type Workflow,
} from "../shared/types.js";
import type { AIContext } from "./ai.js";
import { AppError, type Store } from "./store.js";
import {
  contextLimits,
  bytes,
  prepareProviderRequest,
  requestFits,
  verifyPreparedRequest,
} from "./context-budget.js";
import {
  containsPhrase,
  relevance,
  terms,
  retrievalKnowledge,
  sectionExcerpt,
  sectionIndex,
  traverseRelationships,
} from "./context-retrieval.js";
import type {
  ContextSource,
  ContextOmission,
  ContextLimits,
  ContextAuthority,
} from "../shared/context.js";

export function buildContext(
  store: Store,
  chapterId: string,
  messages: Message[],
  workflow: Workflow | null = null,
  overrides: Partial<ContextLimits> = {},
): AIContext {
  const start = performance.now(),
    active = store.chapter(chapterId),
    project = store.project(active.projectId),
    all = store.chapters(project.id),
    anchor = store.context.anchor(project.id),
    knowledge = retrievalKnowledge(store, project.id),
    workshop = store.workshop(chapterId),
    limits = contextLimits(overrides);
  const scoped = messages.filter(
    (m) =>
      m.conversationId === workshop.conversationId && m.state === "complete",
  );
  const current = scoped.at(-1)?.role === "user" ? scoped.at(-1) : undefined;
  if (current && current.content.length > 20000)
    throw new AppError(
      400,
      "The current message exceeds the supported 20,000-character limit. No instructions were truncated.",
    );
  const instruction = current?.content ?? "",
    query = terms(instruction),
    context: AIContext = {
      project,
      active: {
        ...active,
        content: { type: "doc", content: [{ type: "paragraph" }] },
      },
      vision: null,
      approved: [],
      relevant: [],
      records: [],
      pending: [],
      messages: current ? [current] : [],
      workflow,
      lineage: [],
      children: [],
      knowledge: {
        projectId: project.id,
        concepts: [],
        relationships: [],
        records: [],
      },
      truncated: false,
      activeTruncated: true,
      retrieval: { outline: [], evidence: [], earlier: [], anchor },
    };
  const recentTopic = scoped
    .slice(0, current ? -1 : undefined)
    .slice(-2)
    .map((m) => m.content)
    .join("\n");
  const continuityQuery = terms(recentTopic);
  const historicalRequest =
    /\b(history|historical|previous|earlier|archived|retired|resolved|superseded)\b/i.test(
      instruction,
    );
  const sources: ContextSource[] = [],
    omissions: ContextOmission[] = [],
    undo: (() => void)[] = [];
  const source = (
    kind: ContextSource["kind"],
    value: any,
    authority: ContextAuthority,
    reason: string,
    coverage: ContextSource["coverage"] = "complete",
  ): ContextSource => ({
    key: `${kind}:${value.id}:${value.revision ?? "current"}:${authority}`,
    kind,
    id: value.id,
    label: String(
      value.title ?? value.name ?? value.text ?? value.type ?? project.title,
    ).slice(0, 160),
    revision: value.revision ?? null,
    authority,
    maturity: value.supersededBy
      ? "Superseded"
      : value.archivedAt
        ? "Archived"
        : value.retiredAt
          ? "Retired"
          : value.status
            ? String(value.status).charAt(0).toUpperCase() +
              String(value.status).slice(1)
            : "Identity",
    coverage,
    reason,
  });
  const omit = (
    kind: ContextOmission["kind"],
    reason: string,
    id?: string,
    label?: string,
    count = 1,
  ) => omissions.push({ kind, reason, id, label: label?.slice(0, 160), count });
  if (current)
    sources.push({
      ...source(
        "message",
        current,
        "discussion",
        "Complete current developer instructions",
      ),
      key: `message:${current.id}`,
      chapterId,
      conversationId: current.conversationId,
      label: "Current developer message",
      maturity: "Current instructions",
    });
  sources.push(
    source("project", project, "identity", "Project identity and premise"),
  );
  const capacity = Math.min(
    limits.contextBytes,
    Math.max(0, limits.requestBytes - 26000),
  );
  let detailPhase = true;
  let otherChapterCost = 0;
  const categoryCosts = new Map<string, number>();
  const estimate = () =>
    bytes({ ...context, providerRequest: undefined, manifest: undefined });
  const add = (
    s: ContextSource,
    value: any,
    apply: () => void,
    revert: () => void,
  ) => {
    const categoryShare =
      s.kind === "concept"
        ? 0.3
        : s.kind === "relationship"
          ? 0.18
          : ["decision", "question"].includes(s.kind)
            ? 0.2
            : 1;
    const sourceCost = bytes(value) * 2 + bytes(s);
    if (
      (categoryCosts.get(s.kind) ?? 0) + sourceCost >
      capacity * categoryShare
    ) {
      omit(
        s.kind,
        "Detail category reservation protects other relevant sources",
        s.id,
        s.label,
      );
      return false;
    }
    apply();
    sources.push(s);
    context.retrieval!.evidence.push({ source: s, value });
    if (
      estimate() >
      capacity - (detailPhase ? Math.min(22000, Math.floor(capacity * 0.2)) : 0)
    ) {
      revert();
      sources.pop();
      context.retrieval!.evidence.pop();
      omit(
        s.kind,
        "Context budget cannot fit this complete source",
        s.id,
        s.label,
      );
      return false;
    }
    undo.push(() => {
      revert();
      sources.splice(sources.indexOf(s), 1);
      context.retrieval!.evidence = context.retrieval!.evidence.filter(
        (e) => e.source !== s,
      );
      omit(s.kind, "Final provider/model budget", s.id, s.label);
    });
    categoryCosts.set(s.kind, (categoryCosts.get(s.kind) ?? 0) + sourceCost);
    return true;
  };
  if (!anchor.chapterId)
    omit(
      "anchor",
      "No reliable Game Vision association; establish it in Project details",
    );
  // Reserve recent complete exchange before project details compete for space.
  for (const m of scoped.slice(0, current ? -1 : undefined).slice(-4)) {
    if (bytes(m) > 12000) {
      omit("message", "Recent message too large to supply completely", m.id);
      continue;
    }
    context.messages.splice(context.messages.length - (current ? 1 : 0), 0, m);
    sources.push({
      ...source(
        "message",
        m,
        "discussion",
        "Immediate conversational continuity",
      ),
      key: `message:${m.id}`,
      chapterId,
      conversationId: m.conversationId,
      label: `Recent ${m.role} message`,
      maturity: "Conversation evidence",
    });
  }
  const associated = new Set(
    knowledge.concepts
      .filter((c) => c.chapterIds.includes(active.id) && !c.archivedAt)
      .map((c) => c.id),
  );
  const conceptScores = new Map<string, number>();
  const rankConcept = (c: (typeof knowledge.concepts)[number]) => {
    if (!conceptScores.has(c.id))
      conceptScores.set(
        c.id,
        (instruction.includes(c.id) ? 1000 : 0) +
          (c.normalizedName && containsPhrase(instruction, c.normalizedName)
            ? 500
            : 0) +
          (associated.has(c.id) ? 100 : 0) +
          (containsPhrase(recentTopic, c.normalizedName) ? 120 : 0) +
          (historicalRequest && c.archivedAt ? 40 : 0) +
          relevance(query, c.name + " " + c.description) * 10 +
          relevance(continuityQuery, c.name + " " + c.description) * 3 +
          Number(c.authoritative) * 2,
      );
    return conceptScores.get(c.id)!;
  };
  const rankedConcepts = [...knowledge.concepts].sort(
    (a, b) => rankConcept(b) - rankConcept(a) || a.id.localeCompare(b.id),
  );
  const explicitEdges = knowledge.relationships
    .filter(
      (r) =>
        instruction.includes(r.id) ||
        (/\bretired\b/i.test(instruction) && r.retiredAt),
    )
    .slice(0, 10);
  const graph = traverseRelationships(
    [
      ...new Set([
        ...explicitEdges.flatMap((r) => [r.sourceConceptId, r.targetConceptId]),
        ...rankedConcepts
          .filter((c) => !c.archivedAt && rankConcept(c) > 2)
          .slice(0, 16)
          .map((c) => c.id),
      ]),
    ],
    knowledge.relationships,
  );
  if (graph.limited)
    omit(
      "relationship",
      "Bounded two-hop/40-concept/60-edge traversal excludes additional documented relationships",
    );
  const ancestors = new Set<string>();
  let ancestor = active.parentId;
  while (ancestor && !ancestors.has(ancestor)) {
    ancestors.add(ancestor);
    ancestor = all.find((c) => c.id === ancestor)?.parentId ?? null;
  }
  const chapterScores = new Map<string, number>();
  const rankChapter = (c: Chapter) => {
    if (!chapterScores.has(c.id))
      chapterScores.set(
        c.id,
        (ancestors.has(c.id) ? 1000 : 0) +
          (instruction.includes(c.id) ? 1000 : 0) +
          (containsPhrase(instruction, c.title) ? 100 : 0) +
          relevance(query, c.title + " " + docText(c.content)) * 10 +
          relevance(continuityQuery, c.title + " " + docText(c.content)) * 3 +
          Number(
            knowledge.concepts.some(
              (k) => graph.conceptIds.has(k.id) && k.chapterIds.includes(c.id),
            ),
          ) *
            100,
      );
    return chapterScores.get(c.id)!;
  };
  const chapters = [...all].sort(
    (a, b) => rankChapter(b) - rankChapter(a) || a.id.localeCompare(b.id),
  );
  const chapterAuthority = (c: Chapter): ContextAuthority =>
    c.status === "Approved"
      ? "current-approved"
      : c.approvedRevision !== null && c.changedSinceApproval
        ? "unreviewed"
        : "exploratory";
  const addChapter = (
    c: Chapter,
    budget: number,
    role: "active" | "vision" | "approved" | "relevant",
    authority = chapterAuthority(c),
    reason = "Relevant canonical chapter sections",
  ) => {
    const view = sectionExcerpt(c.content, budget, instruction, recentTopic),
      value = { ...c, content: view.document },
      s = source(
        "chapter",
        value,
        authority,
        reason,
        view.receipt.complete ? "complete" : "partial",
      );
    const cost = bytes(value) * 2;
    if (
      role !== "active" &&
      otherChapterCost + cost > Math.floor(capacity * 0.35)
    ) {
      omit("chapter", "Chapter detail category reservation", c.id, c.title);
      return false;
    }
    s.chapterId = c.id;
    s.blockIndexes = view.receipt.includedBlockIndexes;
    s.sections = sectionIndex(c.content)
      .filter((section) =>
        s.blockIndexes!.some((i) => i >= section.start && i < section.end),
      )
      .map((section) => ({
        ...section,
        complete: Array.from(
          { length: section.end - section.start },
          (_, i) => section.start + i,
        ).every((i) => s.blockIndexes!.includes(i)),
      }));
    s.key += `:${role}`;
    if (!view.receipt.complete)
      omit(
        "chapter",
        "Rich source only partially supplied; edit coverage remains restricted",
        c.id,
        c.title,
      );
    const previous = context.active,
      receipt = context.documentReceipt,
      vision = context.vision;
    const included = add(
      s,
      value,
      () => {
        if (role === "active") {
          context.active = value;
          context.documentReceipt = view.receipt;
          context.activeTruncated = !view.receipt.complete;
        } else if (role === "vision") context.vision = value;
        else context[role].push(value);
      },
      () => {
        if (role === "active") {
          context.active = previous;
          context.documentReceipt = receipt;
          context.activeTruncated = true;
        } else if (role === "vision") context.vision = vision;
        else context[role] = context[role].filter((x) => x !== value);
      },
    );
    if (included && role !== "active") otherChapterCost += cost;
    return included;
  };
  const rankRecord = (r: (typeof knowledge.records)[number]) =>
    (instruction.includes(r.id) ? 1000 : 0) +
    (r.relatedChapterIds.includes(active.id) ? 100 : 0) +
    (r.relatedConceptIds.some((id) => graph.conceptIds.has(id)) ? 80 : 0) +
    relevance(query, r.text + " " + r.rationale) * 10 +
    relevance(continuityQuery, r.text + " " + r.rationale) * 3 +
    (historicalRequest && (r.supersededBy || r.status === "resolved")
      ? 40
      : 0) +
    Number(r.authoritative) * 5;
  const rankedRecords = [...knowledge.records].sort(
    (a, b) =>
      Number(b.authoritative) - Number(a.authoritative) ||
      rankRecord(b) - rankRecord(a) ||
      a.id.localeCompare(b.id),
  );
  const recordCandidates = [
    ...new Map(
      [
        ...rankedRecords.filter((r) => r.authoritative).slice(0, 8),
        ...rankedRecords
          .filter(
            (r) =>
              r.kind === "question" &&
              r.status !== "resolved" &&
              rankRecord(r) > 5,
          )
          .slice(0, 6),
        ...rankedRecords
          .filter(
            (r) =>
              !r.authoritative &&
              (r.kind === "decision" || r.status === "resolved") &&
              rankRecord(r) > 5,
          )
          .slice(0, 6),
      ].map((r) => [r.id, r]),
    ).values(),
  ];
  for (const r of recordCandidates) {
    const authority: ContextAuthority = r.authoritative
        ? "current-approved"
        : r.kind === "decision"
          ? "historical"
          : r.status === "resolved"
            ? "resolved"
            : "unresolved",
      s = source(
        r.kind,
        r,
        authority,
        r.authoritative
          ? "Current approved unsuperseded decision"
          : "Associated, text-relevant or historical evidence",
      );
    add(
      s,
      r,
      () => {
        context.knowledge!.records.push(r);
        if (
          r.status !== "resolved" &&
          (r.kind !== "decision" || r.authoritative)
        )
          context.records.push(r);
      },
      () => {
        context.knowledge!.records = context.knowledge!.records.filter(
          (x) => x !== r,
        );
        context.records = context.records.filter((x) => x !== r);
      },
    );
  }
  addChapter(
    active,
    Math.max(1000, Math.floor((capacity - estimate()) / 2.5)),
    "active",
    chapterAuthority(active),
    "Current saved chapter and exact document editing coverage",
  );
  if (!context.documentReceipt)
    context.documentReceipt = {
      complete: false,
      includedBlockIndexes: [],
      completeSections: [],
    };
  const vision = all.find((c) => c.id === anchor.chapterId);
  if (anchor.chapterId && !vision)
    omit("anchor", "Game Vision is archived or unavailable", anchor.chapterId);
  if (vision && vision.id !== active.id)
    addChapter(
      vision,
      6000,
      "vision",
      chapterAuthority(vision),
      "Stable Game Vision association",
    );
  for (const c of [
    active,
    ...(vision ? [vision] : []),
    ...chapters.filter((c) => c.id !== active.id && c.id !== vision?.id),
  ]
    .filter(
      (c) =>
        c.approvedRevision !== null &&
        (c.changedSinceApproval || c.id !== active.id),
    )
    .slice(0, 6)) {
    const prior = store.approvedChapter(c.id);
    if (prior)
      addChapter(
        prior,
        6000,
        "approved",
        c.changedSinceApproval ? "previously-approved" : "current-approved",
        "Exact approved chapter revision, separate from newer narrative",
      );
  }
  for (const c of chapters
    .filter(
      (c) =>
        c.id !== active.id &&
        c.id !== vision?.id &&
        rankChapter(c) > 0 &&
        c.status !== "Approved",
    )
    .slice(0, 8))
    addChapter(
      c,
      Math.max(1000, Math.floor((capacity - estimate()) / 3)),
      "relevant",
      chapterAuthority(c),
      "Current or recent conversation, section text or concept association",
    );
  const historySnapshot = (kind: "concept" | "relationship", id: string) =>
    store.db
      .prepare(
        `SELECT snapshot FROM knowledge_changes WHERE project_id=? AND ${kind}_id=? ORDER BY revision DESC`,
      )
      .all(project.id, id)
      .map((r) => JSON.parse(String(r.snapshot)))
      .find((v) => v.status === "Approved" && !v.archivedAt && !v.retiredAt);
  for (const c of rankedConcepts
    .filter((c) => graph.conceptIds.has(c.id) || rankConcept(c) > 2)
    .slice(0, 40)) {
    const authority: ContextAuthority = c.archivedAt
        ? "historical"
        : c.authoritative
          ? "current-approved"
          : c.approvedRevision !== null
            ? "unreviewed"
            : "exploratory",
      s = source(
        "concept",
        c,
        authority,
        associated.has(c.id)
          ? "Associated with active chapter"
          : containsPhrase(recentTopic, c.normalizedName) &&
              !containsPhrase(instruction, c.normalizedName)
            ? "Recent conversational subject"
            : graph.conceptIds.has(c.id)
              ? "Referenced subject or relationship neighbor"
              : "Current message relevance",
      );
    add(
      s,
      c,
      () => context.knowledge!.concepts.push(c),
      () => {
        context.knowledge!.concepts = context.knowledge!.concepts.filter(
          (x) => x !== c,
        );
      },
    );
    if (!c.authoritative && c.approvedRevision !== null) {
      const prior = historySnapshot("concept", c.id);
      if (prior)
        add(
          source(
            "concept",
            prior,
            "previously-approved",
            "Exact last approved concept snapshot; newer live content is separate",
          ),
          { ...prior, authoritative: false },
          () => {},
          () => {},
        );
    }
  }
  const includedConcepts = new Set(
    context.knowledge!.concepts.map((c) => c.id),
  );
  for (const edge of graph.edges) {
    const r = edge.relationship;
    if (
      !includedConcepts.has(r.sourceConceptId) ||
      !includedConcepts.has(r.targetConceptId)
    ) {
      omit("relationship", "Endpoint details omitted", r.id);
      continue;
    }
    add(
      source(
        "relationship",
        r,
        r.authoritative
          ? "current-approved"
          : r.status === "Needs Revision"
            ? "unreviewed"
            : "exploratory",
        `Documented ${edge.direction} ${r.type} edge; traversal hop ${edge.hop}`,
      ),
      r,
      () => context.knowledge!.relationships.push(r),
      () => {
        context.knowledge!.relationships =
          context.knowledge!.relationships.filter((x) => x !== r);
      },
    );
    if (!r.authoritative) {
      const prior = historySnapshot("relationship", r.id);
      if (prior)
        add(
          source(
            "relationship",
            prior,
            "previously-approved",
            "Exact prior approved relationship; current edge remains unreviewed",
          ),
          { ...prior, authoritative: false },
          () => {},
          () => {},
        );
    }
  }
  for (const r of knowledge.relationships
    .filter(
      (r) =>
        r.retiredAt &&
        (instruction.includes(r.id) ||
          (historicalRequest &&
            (graph.conceptIds.has(r.sourceConceptId) ||
              graph.conceptIds.has(r.targetConceptId)))),
    )
    .slice(0, 10))
    add(
      source(
        "relationship",
        r,
        "historical",
        "Retired documented relationship requested as historical evidence",
      ),
      r,
      () => {},
      () => {},
    );
  detailPhase = false;
  if (
    /\b(history|historical|previous|earlier|why|evidence|source)\b/i.test(
      instruction,
    )
  ) {
    const selectedIds = new Set(
      [
        ...context.knowledge!.concepts,
        ...context.knowledge!.relationships,
        ...context.knowledge!.records,
      ].map((v) => v.id),
    );
    const provenance = store.db
      .prepare(
        "SELECT s.*,h.concept_id,h.relationship_id,h.record_id FROM knowledge_sources s JOIN knowledge_changes h ON h.id=s.change_id WHERE s.project_id=? ORDER BY h.created_at DESC,s.id",
      )
      .all(project.id)
      .filter((r) =>
        selectedIds.has(
          String(r.concept_id ?? r.relationship_id ?? r.record_id),
        ),
      )
      .slice(0, 10);
    const seenEvidence = new Set<string>();
    for (const row of provenance) {
      if (row.chapter_id !== null) {
        const key = `chapter:${row.chapter_id}:${row.chapter_revision}:historical:provenance`;
        if (seenEvidence.has(key)) continue;
        seenEvidence.add(key);
        const base = store.chapter(String(row.chapter_id), true),
          saved = store
            .history(base.id)
            .find((h) => h.revision === Number(row.chapter_revision));
        if (!saved) {
          omit(
            "chapter",
            "Historical knowledge source revision is unavailable",
            base.id,
            base.title,
          );
          continue;
        }
        const view = sectionExcerpt(saved.content, 6000, instruction),
          value = {
            ...base,
            title: saved.title,
            content: view.document,
            revision: saved.revision,
            status: saved.status,
            parentId: saved.parentId,
            approvedAt: saved.approvedAt,
            updatedAt: saved.createdAt,
            changedSinceApproval: false,
            approvedRevision: saved.approvedAt ? saved.revision : null,
          },
          s = source(
            "chapter",
            value,
            "historical",
            "Exact chapter evidence recorded by structured knowledge provenance",
            view.receipt.complete ? "complete" : "partial",
          );
        s.key = key;
        s.chapterId = base.id;
        s.blockIndexes = view.receipt.includedBlockIndexes;
        s.sections = sectionIndex(saved.content)
          .filter((section) =>
            view.receipt.includedBlockIndexes.some(
              (i) => i >= section.start && i < section.end,
            ),
          )
          .map((section) => ({
            ...section,
            complete: Array.from(
              { length: section.end - section.start },
              (_, i) => section.start + i,
            ).every((i) => view.receipt.includedBlockIndexes.includes(i)),
          }));
        add(
          s,
          value,
          () => {},
          () => {},
        );
      }
      if (row.message_id !== null) {
        const key = `message:${row.message_id}`;
        if (sources.some((s) => s.key === key) || seenEvidence.has(key))
          continue;
        seenEvidence.add(key);
        const m = store.db
          .prepare(
            "SELECT m.*,c.chapter_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.project_id=? AND m.state='complete'",
          )
          .get(String(row.message_id), project.id);
        if (!m) {
          omit(
            "message",
            "Recorded discussion source is unavailable",
            String(row.message_id),
          );
          continue;
        }
        const value = {
            id: String(m.id),
            conversationId: String(m.conversation_id),
            chapterId: String(m.chapter_id),
            role: String(m.role),
            content: String(m.content),
            createdAt: String(m.created_at),
            state: "complete",
          },
          s: ContextSource = {
            ...source(
              "message",
              value,
              "discussion",
              "Exact discussion evidence recorded by knowledge provenance",
            ),
            key,
            label: "Recorded knowledge source discussion",
            chapterId: value.chapterId,
            conversationId: value.conversationId,
          };
        add(
          s,
          value,
          () => context.retrieval!.earlier.push(value),
          () => {
            context.retrieval!.earlier = context.retrieval!.earlier.filter(
              (v: any) => v.id !== value.id,
            );
          },
        );
      }
    }
  }
  const outlineCandidates: any[] = [
    ...rankedConcepts
      .filter((c) => !c.archivedAt)
      .map((c) => ({
        kind: "concept",
        id: c.id,
        name: c.name,
        category: c.category,
        status: c.status,
        revision: c.revision,
        chapterIds: c.chapterIds,
      })),
    ...chapters.map((c) => ({
      kind: "chapter",
      id: c.id,
      title: c.title,
      parentId: c.parentId,
      status: c.status,
      revision: c.revision,
      approvedRevision: c.approvedRevision,
      sections: sectionIndex(c.content).map((s) => ({
        heading: s.heading,
        level: s.level,
        path: s.path,
      })),
    })),
    ...knowledge.relationships
      .filter((r) => !r.retiredAt)
      .map((r) => ({
        kind: "relationship",
        id: r.id,
        type: r.type,
        sourceConceptId: r.sourceConceptId,
        targetConceptId: r.targetConceptId,
        status: r.status,
        revision: r.revision,
      })),
    ...rankedRecords
      .filter((r) => r.authoritative || r.status === "open")
      .map((r) => ({
        kind: r.kind,
        id: r.id,
        text:
          r.text.length <= 180
            ? r.text
            : `${r.kind === "decision" ? "Decision" : "Question"} statement requires detail retrieval; full text is not supplied in this overview.`,
        status: r.status,
        revision: r.revision,
      })),
  ];
  const outlineGroups = [
    "concept",
    "chapter",
    "relationship",
    "decision",
    "question",
  ].map((kind) => outlineCandidates.filter((o) => o.kind === kind));
  const interleaved: any[] = [];
  for (let i = 0; i < Math.max(0, ...outlineGroups.map((g) => g.length)); i++)
    for (const group of outlineGroups) if (group[i]) interleaved.push(group[i]);
  let outlineCost = 0,
    outlineOmitted = 0;
  for (const o of interleaved) {
    const cost = bytes(o);
    if (outlineCost + cost > 14000 || estimate() + cost > capacity) {
      outlineOmitted++;
      continue;
    }
    const key = `overview:${o.kind}:${o.id}`;
    context.retrieval!.outline.push({ ...o, key });
    sources.push({
      key,
      kind: "outline",
      id: o.id,
      label: String(o.name ?? o.title ?? o.text ?? o.type).slice(0, 160),
      revision: o.revision,
      authority: "identity",
      maturity: o.status,
      coverage: "overview",
      reason: `Project discovery overview of ${o.kind}; full detail not necessarily supplied`,
    });
    outlineCost += cost;
  }
  if (outlineOmitted)
    omit(
      "outline",
      "Project discovery inventory budget; some subjects are not visible",
      undefined,
      undefined,
      outlineOmitted,
    );
  const recentIds = new Set(
    [...context.messages, ...(context.retrieval!.earlier as Message[])].map(
      (m) => m.id,
    ),
  );
  const earlier = store.db
    .prepare(
      "SELECT m.*,c.chapter_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.project_id=? AND m.state='complete' ORDER BY m.created_at,m.id",
    )
    .all(project.id)
    .filter((m: any) => !recentIds.has(m.id))
    .map((m: any) => ({
      id: m.id,
      conversationId: m.conversation_id,
      chapterId: m.chapter_id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
      state: m.state,
    }))
    .filter(
      (m) => relevance(query, m.content) >= 2 || instruction.includes(m.id),
    )
    .sort(
      (a, b) =>
        relevance(query, b.content) - relevance(query, a.content) ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.id.localeCompare(b.id),
    );
  for (const m of earlier.slice(0, 6)) {
    const s: ContextSource = {
      ...source(
        "message",
        m,
        "discussion",
        "Direct relevance to current request; discussion is not approved design",
      ),
      key: `message:${m.id}`,
      label: `Earlier ${m.role} discussion`,
      chapterId: m.chapterId,
      conversationId: m.conversationId,
      maturity: "Historical discussion evidence",
    };
    add(
      s,
      m,
      () => context.retrieval!.earlier.push(m),
      () => {
        context.retrieval!.earlier = context.retrieval!.earlier.filter(
          (x: any) => x.id !== m.id,
        );
      },
    );
  }
  if (earlier.length > 6)
    omit(
      "message",
      "Historical discussion relevance/selection cap",
      undefined,
      undefined,
      earlier.length - 6,
    );
  for (const [kind, count] of [
    ["concept", knowledge.concepts.length - context.knowledge!.concepts.length],
    [
      "relationship",
      knowledge.relationships.length - context.knowledge!.relationships.length,
    ],
    [
      "chapter",
      all.length -
        new Set(sources.filter((s) => s.kind === "chapter").map((s) => s.id))
          .size,
    ],
    [
      "decision",
      knowledge.records.filter((r) => r.kind === "decision").length -
        context.knowledge!.records.filter((r) => r.kind === "decision").length,
    ],
    [
      "question",
      knowledge.records.filter((r) => r.kind === "question").length -
        context.knowledge!.records.filter((r) => r.kind === "question").length,
    ],
  ] as const)
    if (count > 0)
      omit(
        kind,
        "Lower relevance/history details omitted; overview may still reference them",
        undefined,
        undefined,
        count,
      );
  if (scoped.length > context.messages.length)
    omit(
      "message",
      "Older conversation not supplied wholesale; relevant evidence selected separately",
      undefined,
      undefined,
      scoped.length - context.messages.length,
    );
  const pending = workshop.proposals.filter((p) => p.status === "pending");
  if (pending.length > 5)
    omit(
      "outline",
      "Older pending suggestions not supplied",
      undefined,
      undefined,
      pending.length - 5,
    );
  for (const p of pending.slice(-5)) {
    const item = { kind: p.kind, title: p.title, reason: p.reason },
      s: ContextSource = {
        key: `pending:${p.id}`,
        kind: "outline",
        id: p.id,
        label: `Pending suggestion: ${p.title}`,
        revision: null,
        authority: "exploratory",
        maturity: "Pending proposal",
        coverage: "overview",
        reason: "Unreviewed pending suggestion, not established design",
      };
    add(
      s,
      { id: p.id, ...item, status: "pending" },
      () => context.pending.push(item),
      () => {
        context.pending = context.pending.filter((v) => v !== item);
      },
    );
  }
  const byId = new Map(all.map((c) => [c.id, c]));
  let parent = active.parentId;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const c = byId.get(parent);
    if (!c) break;
    context.lineage.unshift({ id: c.id, title: c.title });
    parent = c.parentId;
  }
  if (context.lineage.length > 8) {
    omit(
      "chapter",
      "Only the closest eight ancestor references are supplied",
      undefined,
      undefined,
      context.lineage.length - 8,
    );
    context.lineage = context.lineage.slice(-8);
  }
  const childCount = all.filter((c) => c.parentId === active.id).length;
  if (childCount > 20)
    omit(
      "chapter",
      "Direct child references are limited to twenty; overview may include others",
      undefined,
      undefined,
      childCount - 20,
    );
  context.children = all
    .filter((c) => c.parentId === active.id)
    .map((c) => ({ id: c.id, title: c.title }))
    .slice(0, 20);
  let prepared = prepareProviderRequest(context, limits);
  if (!requestFits(prepared) && context.retrieval!.outline.length) {
    for (const o of context.retrieval!.outline) {
      const i = sources.findIndex((s) => s.key === (o as any).key);
      if (i >= 0) sources.splice(i, 1);
    }
    omit(
      "outline",
      "Final provider/model capacity omitted overview",
      undefined,
      undefined,
      context.retrieval!.outline.length,
    );
    context.retrieval!.outline = [];
    prepared = prepareProviderRequest(context, limits);
  }
  while (!requestFits(prepared) && undo.length) {
    undo.pop()!();
    prepared = prepareProviderRequest(context, limits);
  }
  if (!context.documentReceipt)
    context.documentReceipt = {
      complete: false,
      includedBlockIndexes: [],
      completeSections: [],
    };
  context.truncated = omissions.length > 0;
  prepared = prepareProviderRequest(context, limits);
  verifyPreparedRequest(context, prepared);
  for (const reference of [...context.lineage, ...context.children])
    if (
      !sources.some(
        (s) =>
          s.id === reference.id &&
          (s.kind === "chapter" || s.key.startsWith("overview:chapter:")),
      )
    )
      sources.push({
        key: `hierarchy:${reference.id}`,
        kind: "outline",
        id: reference.id,
        chapterId: reference.id,
        label: reference.title,
        revision: null,
        authority: "identity",
        maturity: "Hierarchy reference",
        coverage: "overview",
        reason:
          "Ancestor or child chapter reference; no chapter body or revision supplied in this reference",
      });
  context.providerRequest = prepared;
  context.manifest = {
    version: 1,
    providerFormat: prepared.format,
    projectId: project.id,
    chapterId,
    sources,
    omissions,
    limits,
    contextBytes: prepared.contextBytes,
    requestBytes: prepared.requestBytes,
    estimatedInputTokens: prepared.estimatedInputTokens,
    tokenMethod: prepared.tokenMethod,
    contextDigest: prepared.contextDigest,
    requestDigest: prepared.requestDigest,
    retrievalMs: Math.round((performance.now() - start) * 100) / 100,
  };
  return context;
}
