import { useEffect, useState } from "react";
import type { Chapter, Proposal } from "../../../shared/types";
import type { ProjectKnowledge } from "../../../shared/knowledge";
import {
  canExplore,
  type ConceptReference,
  type ReviewOutcome,
} from "../../../shared/knowledge-proposals";
import { api } from "../../api";
import { relationshipLabels } from "../../knowledge";
import { Modal } from "../Modal";

export function KnowledgeProposalReview({
  proposal,
  proposals,
  chapters,
  busy,
  error,
  onDecide,
  onClose,
  onRegenerate,
}: {
  proposal: Proposal;
  proposals: Proposal[];
  chapters: Chapter[];
  busy: boolean;
  error: string;
  onDecide: (decision: "accept" | "reject", outcome?: ReviewOutcome) => void;
  onClose: () => void;
  onRegenerate: () => void;
}) {
  const data = proposal.knowledge!,
    p = data.payload;
  const [latest, setLatest] = useState<ProjectKnowledge>(),
    [liveChapters, setChapters] = useState<Chapter[]>([]),
    [failure, setFailure] = useState("");
  useEffect(() => {
    let alive = true;
    Promise.all([
      api<ProjectKnowledge>(
        `/projects/${proposal.projectId}/knowledge?includeHistorical=true`,
      ),
      api<Chapter[]>(`/projects/${proposal.projectId}/chapters`),
    ])
      .then(([knowledge, items]) => {
        if (alive) {
          setLatest(knowledge);
          setChapters(items);
        }
      })
      .catch((e) => {
        if (alive) setFailure(e.message);
      });
    return () => {
      alive = false;
    };
  }, [proposal.id, proposal.projectId]);
  const label = (id: string) =>
    data.labels[id] ??
    chapters.find((c) => c.id === id)?.title ??
    latest?.concepts.find((c) => c.id === id)?.name ??
    "Unavailable subject";
  const refLabel = (r: ConceptReference) =>
    label("id" in r ? r.id : r.newConcept);
  const current = (g: (typeof data.guards)[number]) =>
    g.entity === "concept"
      ? latest?.concepts.find((c) => c.id === g.id)
      : g.entity === "relationship"
        ? latest?.relationships.find((r) => r.id === g.id)
        : g.entity === "record"
          ? latest?.records.find((r) => r.id === g.id)
          : liveChapters.find((c) => c.id === g.id);
  const stale = Boolean(
    latest &&
    data.guards.some((g) => {
      const c = current(g);
      return (
        !c ||
        c.revision !== g.revision ||
        ("archivedAt" in c && c.archivedAt) ||
        ("retiredAt" in c && c.retiredAt)
      );
    }),
  );
  const dependencies = data.dependencies.map((d) => ({
    ...d,
    proposal: proposals.find((p) => p.id === d.proposalId),
  }));
  const blocked = dependencies.some((d) => d.proposal?.status !== "accepted");
  const prerequisiteChanged = Boolean(
    latest &&
    dependencies.some((d) => {
      const result = d.proposal?.appliedResult;
      if (!result) return false;
      const c = latest.concepts.find((c) => c.id === result.id);
      return !c || c.archivedAt || c.revision !== result.revision;
    }),
  );
  const canAccept = Boolean(
    latest && !failure && !stale && !blocked && !prerequisiteChanged && !busy,
  );
  const old = data.before;
  const decision =
    p.action === "record_decision" || p.action === "supersede_decision";
  const rendered = () => (
    <>
      {"name" in p && (
        <>
          <h4>{p.name}</h4>
          <p>Category: {p.category}</p>
          <p className="knowledge-prose">
            {p.description || "No description supplied."}
          </p>
        </>
      )}
      {"source" in p && (
        <>
          <h4>
            {refLabel(p.source)} {relationshipLabels[p.type]}{" "}
            {refLabel(p.target)}
          </h4>
          <p>
            {["interacts_with", "conflicts_with"].includes(p.type)
              ? "Shared · symmetric"
              : "Source → target · directional"}
          </p>
          <p className="knowledge-prose">{p.rationale}</p>
        </>
      )}
      {"text" in p && (
        <>
          <h4>{p.text}</h4>
          <p className="knowledge-prose">{p.rationale}</p>
        </>
      )}
      {p.action === "resolve_question" && (
        <>
          <h4>Proposed answer</h4>
          <p className="knowledge-prose">{p.answer}</p>
        </>
      )}
      {p.action === "retire_relationship" && (
        <p>
          Retire this relationship while preserving its history and sources.
        </p>
      )}
      {"chapterIds" in p && (
        <p>
          <strong>Resulting chapter links:</strong>{" "}
          {p.chapterIds.map(label).join(", ") || "None"}
        </p>
      )}
      {"concepts" in p && (
        <p>
          <strong>Related concepts:</strong>{" "}
          {p.concepts.map(refLabel).join(", ") || "None"}
        </p>
      )}
    </>
  );
  return (
    <Modal
      title="Review knowledge proposal"
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="proposal-summary">
        <span className="eyebrow">{p.action.replaceAll("_", " ")}</span>
        <h3>{proposal.title}</h3>
        <p>{proposal.description}</p>
        <p>
          <strong>Why:</strong> {proposal.reason}
        </p>
        <p>
          <strong>Target:</strong>{" "}
          {"targetId" in p ? label(p.targetId) : "New knowledge"}
        </p>
      </div>
      {old && (
        <section className="knowledge-proposal-original">
          <span className="eyebrow">
            Original saved version · {String(old.status)} · version{" "}
            {String(old.revision)}
          </span>
          <h4>{String(old.name ?? old.text ?? "Relationship")}</h4>
          {old.description != null && (
            <p className="knowledge-prose">{String(old.description)}</p>
          )}
          {old.rationale != null && (
            <p className="knowledge-prose">{String(old.rationale)}</p>
          )}
          {old.category != null && <p>Category: {String(old.category)}</p>}
          {old.sourceConceptId != null && (
            <p>
              {label(String(old.sourceConceptId))}{" "}
              {relationshipLabels[old.type as keyof typeof relationshipLabels]}{" "}
              {label(String(old.targetConceptId))}
            </p>
          )}
          {Array.isArray(old.chapterIds) && (
            <p>
              Chapter links:{" "}
              {(old.chapterIds as string[]).map(label).join(", ") || "None"}
            </p>
          )}
          {old.resolution != null && (
            <p>Previous answer: {String(old.resolution)}</p>
          )}
          {Array.isArray(old.relatedChapterIds) && (
            <p>
              Chapter links:{" "}
              {(old.relatedChapterIds as string[]).map(label).join(", ") ||
                "None"}
            </p>
          )}
          {Array.isArray(old.relatedConceptIds) && (
            <p>
              Related concepts:{" "}
              {(old.relatedConceptIds as string[]).map(label).join(", ") ||
                "None"}
            </p>
          )}
        </section>
      )}
      <section className="knowledge-proposal-proposed">
        <span className="eyebrow">Proposed · awaiting your review</span>
        {rendered()}
      </section>
      {!!dependencies.length && (
        <section className="knowledge-proposal-dependencies">
          <h4>Prerequisite concepts</h4>
          {dependencies.map((d) => (
            <p key={d.key}>
              {label(d.key)} · {d.proposal?.status ?? "Unavailable"}
              {d.proposal?.appliedResult
                ? ` as ${d.proposal.appliedResult.outcome === "approve" ? "Approved" : "Exploring"}`
                : ""}
            </p>
          ))}
          <p>
            Review and accept each prerequisite separately. No proposals are
            accepted automatically.
          </p>
        </section>
      )}
      <p className="muted">
        {canExplore(p)
          ? "Accept as Exploring stores unreviewed knowledge. Approve records this exact proposed version as reviewed design direction. Earlier approvals stay in history."
          : decision
            ? "Approving records a binding design decision. Superseded statements and their sources remain historical."
            : p.action === "resolve_question"
              ? "Acceptance records this answer and resolves the question; it does not create a decision."
              : p.action === "record_question"
                ? "Acceptance records an open question, not approved design direction."
                : "Acceptance retires the relationship without deleting evidence."}
      </p>
      <p className="muted">
        Source: this Workshop response and {label(data.sourceChapterId)}, saved
        chapter version {data.sourceRevision}. Chapter prose stays unchanged.
      </p>
      {!latest && !failure && <p role="status">Checking current knowledge…</p>}
      {(stale || prerequisiteChanged) && (
        <p role="alert" className="inline-error">
          Knowledge or source revisions changed. Regenerate and review a fresh
          proposal.
        </p>
      )}
      {blocked && (
        <p role="alert" className="inline-error">
          Accept prerequisite concepts before this dependent proposal. Rejected
          prerequisites require regeneration.
        </p>
      )}
      {(error || failure) && (
        <p role="alert" className="inline-error">
          {error || failure}
        </p>
      )}
      <div className="modal-actions knowledge-proposal-actions">
        {(stale || prerequisiteChanged || blocked || error || failure) && (
          <button disabled={busy} onClick={onRegenerate}>
            Regenerate knowledge proposal
          </button>
        )}
        <button disabled={busy} onClick={() => onDecide("reject")}>
          Reject knowledge proposal
        </button>
        {canExplore(p) ? (
          <>
            <button
              disabled={!canAccept}
              onClick={() => onDecide("accept", "exploring")}
            >
              Accept as Exploring
            </button>
            <button
              className="primary"
              disabled={!canAccept}
              onClick={() => onDecide("accept", "approve")}
            >
              Approve knowledge
            </button>
          </>
        ) : (
          <button
            className="primary"
            disabled={!canAccept}
            onClick={() => onDecide("accept", decision ? "approve" : "accept")}
          >
            {busy
              ? "Saving…"
              : decision
                ? "Approve decision"
                : p.action === "record_question"
                  ? "Accept open question"
                  : p.action === "resolve_question"
                    ? "Accept resolution"
                    : "Retire relationship"}
          </button>
        )}
      </div>
    </Modal>
  );
}
