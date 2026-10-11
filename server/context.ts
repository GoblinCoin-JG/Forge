import {
  docText,
  textDoc,
  type Chapter,
  type Message,
  type Workflow,
} from "../shared/types.js";
import type { AIContext } from "./ai.js";
import type { Store } from "./store.js";

// Character budgets keep requests bounded independently of book/history size.
// Excerpts retain maturity labels; full revision snapshots never come from excerpts.
export function buildContext(
  store: Store,
  chapterId: string,
  messages: Message[],
  workflow: Workflow | null = null,
): AIContext {
  const active = store.chapter(chapterId),
    project = store.project(active.projectId);
  const all = store.chapters(project.id),
    records = store.records(project.id);
  let remaining = 32000,
    truncated = false;
  const clip = (text: string, limit: number) => {
    const n = Math.max(0, Math.min(limit, remaining));
    remaining -= Math.min(n, text.length);
    if (text.length > n) truncated = true;
    return text.slice(0, n);
  };
  const excerpt = (c: Chapter, limit: number) => ({
    ...c,
    content: textDoc(clip(docText(c.content), limit)),
  });
  const projectContext = { ...project, premise: clip(project.premise, 4000) };
  const activeContext = excerpt(active, 10000);
  const vision = all.find(
    (c) => c.title.toLowerCase() === "game vision" && c.id !== active.id,
  );
  const visionContext = vision ? excerpt(vision, 5000) : null;
  const workshop = store.workshop(chapterId);
  const recent: Message[] = [];
  let historyBudget = 8000;
  for (const m of messages
    .filter(
      (m) =>
        m.state === "complete" && m.conversationId === workshop.conversationId,
    )
    .slice(-20)
    .reverse()) {
    if (historyBudget <= 0) {
      truncated = true;
      break;
    }
    const content = m.content.slice(-Math.min(4000, historyBudget));
    if (content.length < m.content.length) truncated = true;
    recent.unshift({ ...m, content });
    historyBudget -= content.length;
  }
  if (messages.length > recent.length) truncated = true;
  const terms = new Set(
    (
      active.title +
      " " +
      recent
        .slice(-3)
        .map((m) => m.content)
        .join(" ")
    )
      .toLowerCase()
      .match(/[a-z]{4,}/g) ?? [],
  );
  const lineage: { id: string; title: string }[] = [];
  const visited = new Set<string>();
  let ancestor = active.parentId
    ? all.find((c) => c.id === active.parentId)
    : undefined;
  while (ancestor && !visited.has(ancestor.id)) {
    visited.add(ancestor.id);
    lineage.unshift({ id: ancestor.id, title: ancestor.title });
    ancestor = ancestor.parentId
      ? all.find((c) => c.id === ancestor!.parentId)
      : undefined;
  }
  const score = (c: Chapter) =>
    (lineage.some((parent) => parent.id === c.id)
      ? 10000 + lineage.findIndex((parent) => parent.id === c.id)
      : 0) +
    (c.title + " " + docText(c.content).slice(0, 5000))
      .toLowerCase()
      .split(/\W+/)
      .reduce((sum, t) => sum + (terms.has(t) ? 1 : 0), 0);
  const candidates = all
    .filter((c) => c.id !== active.id && c.id !== vision?.id)
    .sort((a, b) => score(b) - score(a));
  // Use the last explicitly approved document, not newer unreviewed prose.
  const approved = [
    ...(active.changedSinceApproval ? [active] : []),
    ...(vision?.changedSinceApproval ? [vision] : []),
    ...candidates,
  ]
    .filter((c) => c.approvedRevision !== null)
    .slice(0, 4)
    .map((c) => excerpt(store.approvedChapter(c.id)!, 2500));
  const relevant = candidates
    .filter((c) => c.status !== "Approved" && score(c) > 0)
    .slice(0, 3)
    .map((c) => excerpt(c, 2000));
  if (all.length > 2 + approved.length + relevant.length) truncated = true;
  const selectedRecords = records
    .filter(
      (r) =>
        r.status !== "resolved" && (r.kind !== "decision" || r.authoritative),
    )
    .sort(
      (a, b) =>
        Number(b.relatedChapterIds.includes(active.id)) -
        Number(a.relatedChapterIds.includes(active.id)),
    )
    .slice(0, 12)
    .map((r) => ({
      ...r,
      text: clip(r.text, 1200),
      rationale: clip(r.rationale, 500),
    }));
  return {
    lineage: lineage.slice(-8),
    children: all
      .filter((c) => c.parentId === active.id)
      .slice(0, 20)
      .map((c) => ({ id: c.id, title: c.title })),
    project: projectContext,
    active: activeContext,
    vision: visionContext,
    approved,
    relevant,
    records: selectedRecords,
    pending: workshop.proposals
      .filter((p) => p.status === "pending")
      .slice(-5)
      .map((p) => ({
        kind: p.kind,
        title: p.title,
        reason: clip(p.reason, 300),
      })),
    messages: recent,
    workflow,
    activeTruncated: docText(active.content).length > 10000,
    truncated,
  };
}
