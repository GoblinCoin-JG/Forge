import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronRight,
  CircleHelp,
  Loader2,
  MessageSquare,
  Sparkles,
  Square,
  X,
  FilePenLine,
  PanelRightClose,
} from "lucide-react";
import {
  docText,
  type Chapter,
  type Project,
  type Proposal,
  type Workshop as WorkshopData,
  type Workflow,
} from "../../shared/types";
import { chapterOutline } from "../../shared/chapter-tree";
import { lineDiff } from "../../shared/diff";
import { api, chat } from "../api";
import { Modal } from "./Modal";
import { KnowledgeProposalReview } from "./knowledge/KnowledgeProposalReview";
import type {
  AppliedKnowledge,
  ReviewOutcome,
} from "../../shared/knowledge-proposals";

export function Workshop({
  chapter,
  project,
  chapters,
  configured,
  flush,
  onReviewed,
  onSetup,
  onClose,
  onOpenKnowledge,
}: {
  chapter: Chapter;
  project: Project;
  chapters: Chapter[];
  configured: boolean;
  flush: () => Promise<boolean>;
  onReviewed: () => Promise<void>;
  onSetup: () => void;
  onClose: () => void;
  onOpenKnowledge?: (result: AppliedKnowledge) => void;
}) {
  const [data, setData] = useState<WorkshopData>(),
    [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(false),
    [stream, setStream] = useState(""),
    [error, setError] = useState(""),
    [review, setReview] = useState<Proposal>(),
    [reviewTarget, setReviewTarget] = useState<Chapter>(),
    [proposalParent, setProposalParent] = useState<string | null>(null),
    [reviewing, setReviewing] = useState(false);
  const controller = useRef<AbortController | null>(null),
    bottom = useRef<HTMLDivElement>(null),
    alive = useRef(true),
    sending = useRef(false);
  const load = () => api<WorkshopData>(`/chapters/${chapter.id}/workshop`);
  useEffect(() => {
    alive.current = true;
    load()
      .then((d) => {
        if (alive.current) setData(d);
      })
      .catch((e) => {
        if (alive.current) setError(e.message);
      });
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, [chapter.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [stream, data?.messages.length]);
  const send = async (text = prompt, workflow?: Workflow) => {
    if (!text.trim() || sending.current || !data) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!(await flush()))
        throw new Error(
          "Save this chapter before discussing it in the Workshop.",
        );
      if (!alive.current) return;
      setStream("");
      setPrompt("");
      controller.current = new AbortController();
      await chat(
        chapter.id,
        text,
        controller.current.signal,
        (event, value) => {
          if (!alive.current) return;
          if (event === "user")
            setData((d) =>
              d ? { ...d, messages: [...d.messages, value] } : d,
            );
          if (event === "reply") setStream(value.text);
          if (event === "error") setError(value.error);
          if (event === "complete") {
            setData(value);
            setStream("");
          }
        },
        workflow,
      );
    } catch (e) {
      if (alive.current) {
        setError(
          (e as Error).name === "AbortError"
            ? "Response stopped. Your conversation is saved."
            : (e as Error).message,
        );
        try {
          const d = await load();
          if (alive.current) setData(d);
        } catch {
          /* retain conversation */
        }
      }
    } finally {
      sending.current = false;
      if (alive.current) {
        setBusy(false);
        setStream("");
      }
    }
  };
  const openReview = async (proposal: Proposal) => {
    setError("");
    try {
      const latest = proposal.chapterId
        ? await api<Chapter>(`/chapters/${proposal.chapterId}`)
        : undefined;
      if (alive.current) {
        setReviewTarget(latest);
        setProposalParent(proposal.parentId);
        setReview(proposal);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  };
  const reviewGuard = useRef(false);
  const decide = async (
    decision: "accept" | "reject",
    outcome?: ReviewOutcome,
  ) => {
    if (!review || reviewGuard.current) return;
    reviewGuard.current = true;
    setReviewing(true);
    setError("");
    let committed = false;
    try {
      if (decision === "accept" && !(await flush()))
        throw new Error("Save your current edits before accepting a proposal.");
      const accepted = await api<Proposal>(
        `/proposals/${review.id}/review`,
        "POST",
        {
          decision,
          ...(outcome ? { outcome } : {}),
          ...(review.kind === "create_chapter" ||
          review.kind === "create_subchapter"
            ? { parentId: proposalParent }
            : {}),
        },
      );
      committed = true;
      setData((d) =>
        d
          ? {
              ...d,
              proposals: d.proposals.map((p) =>
                p.id === accepted.id ? accepted : p,
              ),
            }
          : d,
      );
      setReview(undefined);
      setData(await load());
      if (decision === "accept") await onReviewed();
    } catch (e) {
      setError(
        committed
          ? `Your review was saved, but refreshing failed. Reopen the Workshop to refresh. ${(e as Error).message}`
          : (e as Error).message,
      );
      if (review.chapterId) {
        try {
          setReviewTarget(await api<Chapter>(`/chapters/${review.chapterId}`));
        } catch {
          /* retain original review and error */
        }
      }
    } finally {
      reviewGuard.current = false;
      setReviewing(false);
    }
  };
  const localTarget = review?.chapterId
    ? chapters.find((c) => c.id === review.chapterId)
    : undefined;
  const target =
    reviewTarget &&
    reviewTarget.id === review?.chapterId &&
    (!localTarget || reviewTarget.revision >= localTarget.revision)
      ? reviewTarget
      : localTarget;
  const stale = Boolean(
    review?.chapterId && (!target || target.revision !== review.baseRevision),
  );
  const isCreation =
    review?.kind === "create_chapter" || review?.kind === "create_subchapter";
  const before = review?.before;
  const isRecord =
    review?.kind === "record_decision" || review?.kind === "record_question";
  const isStatus = review?.kind === "change_status";
  const actions: { mode: Workflow; label: string; prompt: string }[] = [
    {
      mode: "extract",
      label: "Extract Design Knowledge",
      prompt: `Extract meaningful design knowledge from ${chapter.title} and our conversation. Reuse existing concepts; propose only supported concepts, relationships, decisions or questions for individual review. Do not apply changes.`,
    },
    {
      mode: "explore",
      label: "Explore this chapter",
      prompt: `Help me develop ${chapter.title} around the player's experience, building on what is documented.`,
    },
    {
      mode: "gaps",
      label: "Identify missing details",
      prompt: `Identify the most consequential missing detail in ${chapter.title} and help me resolve it.`,
    },
    {
      mode: "challenge",
      label: "Challenge this design",
      prompt: `Challenge ${chapter.title}: identify a concrete weakness or contradiction with our design direction and explain a tradeoff.`,
    },
    {
      mode: "improve",
      label: "Suggest improvements",
      prompt: `Suggest a focused improvement to ${chapter.title}, preserving our approved direction.`,
    },
    {
      mode: "organize",
      label: "Organize these notes",
      prompt: prompt.trim()
        ? `Organize these notes into concepts and propose where they belong in the book: ${prompt}`
        : "Help me organize design notes. Ask me for the notes to work with.",
    },
  ];
  return (
    <aside className="workshop">
      <div className="workshop-header">
        <div>
          <Sparkles size={17} />
          <h2>AI Workshop</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Hide Workshop"
          onClick={onClose}
        >
          <PanelRightClose size={17} />
        </button>
      </div>
      <div className="workshop-context">
        <span className="tiny-dot" />
        <span>In context</span>
        <span
          className="context-title"
          title={`${project.title} · ${chapter.title}`}
        >
          {project.title} · {chapter.title}
        </span>
      </div>
      <div className="conversation-scroll">
        {!data?.messages.length && (
          <div className="workshop-intro">
            <div className="sparkle-mark">
              <Sparkles size={24} />
            </div>
            <h3>
              A partner for the
              <br />
              possibilities.
            </h3>
            <p>
              Explore your ideas, find the right questions, and shape your
              game's design.
            </p>
            <div className="workshop-principle">
              <CircleHelp size={15} />
              <span>
                You direct. AI suggests.
                <br />
                Your book changes only with your approval.
              </span>
            </div>
          </div>
        )}
        {!configured && (
          <div className="connection-card">
            <span className="eyebrow">WORKSHOP CONNECTION</span>
            <h4>Ready when you are.</h4>
            <p>
              Connect your OpenAI API key to start a conversation. You can keep
              writing and organizing your book meanwhile.
            </p>
            <button className="quiet-button amber" onClick={onSetup}>
              Set up AI <ChevronRight size={14} />
            </button>
          </div>
        )}
        {data?.messages.map((m) => (
          <div key={m.id} className={`message ${m.role}`}>
            <div className="message-label">
              {m.role === "user" ? (
                <>
                  <span className="avatar">Y</span>You
                </>
              ) : (
                <>
                  <Sparkles size={13} />
                  Forge
                </>
              )}
              <span>{m.state === "complete" ? "" : m.state}</span>
            </div>
            <p>{m.content}</p>
          </div>
        ))}
        {busy && (
          <div className="message assistant">
            <div className="message-label">
              <Sparkles size={13} />
              Forge
              <Loader2 size={12} className="spin" />
            </div>
            <p>{stream || "Thinking through your design…"}</p>
          </div>
        )}
        {data?.proposals
          .filter((p) => p.status === "pending")
          .map((p) => (
            <button
              key={p.id}
              className="proposal-card"
              onClick={() => void openReview(p)}
            >
              <FilePenLine size={17} />
              <div>
                <span className="eyebrow">
                  PROPOSED{" "}
                  {(p.knowledge?.payload.action ?? p.kind)
                    .replaceAll("_", " ")
                    .toUpperCase()}
                </span>
                <strong>{p.title}</strong>
                <span>{p.description}</span>
                {!!p.knowledge?.dependencies.length && (
                  <span>
                    Requires{" "}
                    {p.knowledge.dependencies.map((d) => d.title).join(", ")}
                  </span>
                )}
              </div>
              <ChevronRight size={16} />
            </button>
          ))}
        {data?.proposals
          .filter((p) => p.status !== "pending")
          .map((p) => (
            <div className="review-record" key={p.id}>
              {p.status === "accepted" ? <Check size={13} /> : <X size={13} />}
              <span>
                {p.title} · {p.status}
                {p.appliedResult
                  ? ` · ${p.appliedResult.outcome === "approve" ? "Approved" : p.appliedResult.outcome === "exploring" ? "Exploring" : "Reviewed"}`
                  : ""}
              </span>
              {p.appliedResult && onOpenKnowledge && (
                <button onClick={() => onOpenKnowledge(p.appliedResult!)}>
                  Open in Design Knowledge
                </button>
              )}
            </div>
          ))}
        {!!data?.records.length && (
          <details className="design-records">
            <summary>
              Decisions & open questions ({data.records.length})
            </summary>
            {data.records.map((r) => (
              <div key={r.id} className="design-record">
                <span className="eyebrow">
                  {r.kind === "decision"
                    ? r.supersededBy
                      ? "SUPERSEDED DECISION"
                      : "APPROVED DECISION"
                    : r.status === "resolved"
                      ? "RESOLVED QUESTION"
                      : "OPEN QUESTION"}
                </span>
                <p>{r.text}</p>
                <small>{r.rationale}</small>
                {r.kind === "question" && r.status === "open" && (
                  <button
                    className="quiet-button"
                    onClick={async () => {
                      try {
                        const answer = window.prompt(
                          "What resolves this design question?",
                        );
                        if (!answer?.trim()) return;
                        await api(
                          `/projects/${project.id}/questions/${r.id}/resolve`,
                          "POST",
                          { revision: r.revision, answer },
                        );
                        setData(await load());
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Mark resolved
                  </button>
                )}
              </div>
            ))}
          </details>
        )}
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div ref={bottom} />
      </div>
      <div className="composer-area">
        <details className="workflow-actions">
          <summary>Design together</summary>
          <div className="prompt-suggestions">
            {actions.map((a) => (
              <button
                key={a.mode}
                disabled={!configured || busy || !data}
                onClick={() => void send(a.prompt, a.mode)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </details>
        <form
          className={`composer ${!configured ? "disconnected" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            aria-label="Message the AI Workshop"
            placeholder={
              configured
                ? "Explore an idea or ask a question…"
                : "Connect AI to start exploring…"
            }
            value={prompt}
            disabled={!configured || busy}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-footer">
            <span>
              {busy
                ? "Exploring your idea…"
                : "Enter to send · Shift + Enter for a new line"}
            </span>
            {busy ? (
              <button
                type="button"
                aria-label="Stop response"
                onClick={() => controller.current?.abort()}
              >
                <Square size={13} />
              </button>
            ) : (
              <button
                className="send"
                aria-label="Send message"
                disabled={!configured || !prompt.trim() || !data}
                type="submit"
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </form>
        <p className="workshop-footnote">
          <MessageSquare size={11} />
          Exploration stays separate from decisions.
        </p>
      </div>
      {review?.knowledge && (
        <KnowledgeProposalReview
          proposal={review}
          proposals={data?.proposals ?? []}
          chapters={chapters}
          busy={reviewing}
          error={error}
          onClose={() => setReview(undefined)}
          onDecide={(decision, outcome) => void decide(decision, outcome)}
          onRegenerate={() => {
            const p = review;
            setReview(undefined);
            void send(
              `Regenerate the knowledge proposal "${p.title}" against current knowledge. Intended change: ${p.description}. Reason: ${p.reason}. Reuse accepted prerequisite concepts and supply current target revisions. Propose the change for review; do not apply it.`,
              "extract",
            );
          }}
        />
      )}
      {review && !review.knowledge && (
        <Modal
          title="Review proposed change"
          wide
          onClose={() => {
            if (!reviewing) setReview(undefined);
          }}
        >
          <div className="proposal-summary">
            <span className="eyebrow">
              {review.kind.replaceAll("_", " ").toUpperCase()}
            </span>
            <h3>{review.title}</h3>
            <p>{review.description}</p>
            <p>
              <strong>Why:</strong> {review.reason}
            </p>
            <p className="muted">
              Target:{" "}
              {target?.title ??
                (proposalParent
                  ? `New sub-chapter under ${chapters.find((c) => c.id === proposalParent)?.title ?? "parent chapter"}`
                  : "New top-level chapter")}
              {review.section ? ` · ${review.section}` : ""}
            </p>
          </div>
          {isCreation && (
            <label className="chapter-location">
              Place under
              <select
                aria-label="Proposal parent chapter"
                disabled={reviewing}
                value={proposalParent ?? ""}
                onChange={(e) => setProposalParent(e.target.value || null)}
              >
                <option value="">Top-level chapter</option>
                {chapterOutline(chapters).map((row) => (
                  <option key={row.chapter.id} value={row.chapter.id}>
                    {row.number} · {row.chapter.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {stale && (
            <p className="inline-error" role="alert">
              This chapter changed after the proposal was generated. Reject it
              or regenerate and review a fresh proposal.
            </p>
          )}
          {isStatus ? (
            <p className="proposal-prose">
              Maturity: {before?.status ?? target?.status} →{" "}
              {review.proposedStatus}
            </p>
          ) : isRecord ? (
            <div className="proposal-prose">{docText(review.content)}</div>
          ) : (
            <>
              <div className="proposal-comparison">
                {before && (
                  <section>
                    <span className="eyebrow">ORIGINAL · {before.status}</span>
                    <div className="proposal-prose">
                      {docText(before.content) || "This chapter is blank."}
                    </div>
                  </section>
                )}
                <section>
                  <span className="eyebrow">PROPOSED · REQUIRES APPROVAL</span>
                  <div className="proposal-prose">
                    {docText(review.content)}
                  </div>
                </section>
              </div>
              {before && (
                <details className="proposal-diff" open>
                  <summary>Changes · − removed · + added</summary>
                  {lineDiff(
                    docText(before.content),
                    docText(review.content),
                  ).map((line, i) => (
                    <div key={i} className={`diff-line ${line.kind}`}>
                      <span aria-hidden="true">
                        {line.kind === "added"
                          ? "+ "
                          : line.kind === "removed"
                            ? "− "
                            : "  "}
                      </span>
                      {line.text || " "}
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
          <p className="muted">
            {isRecord
              ? "Accepting records this decision as Approved or this question as Open. Chapter content stays unchanged."
              : isStatus
                ? "Accepting changes only chapter maturity."
                : "Accepting saves the proposed content with Proposed maturity."}
          </p>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <div className="modal-actions">
            {stale && (
              <button
                disabled={reviewing || busy}
                onClick={() => {
                  const p = review;
                  setReview(undefined);
                  void send(
                    `Regenerate the ${p.kind} proposal "${p.title}" using current chapter content. Intended change: ${p.description}. Previously proposed: ${docText(p.content)}. Produce a fresh proposal for review; do not apply it.`,
                    "improve",
                  );
                }}
              >
                Regenerate proposal
              </button>
            )}
            <button disabled={reviewing} onClick={() => void decide("reject")}>
              Reject change
            </button>
            <button
              className="primary"
              disabled={reviewing || stale}
              onClick={() => void decide("accept")}
            >
              {reviewing ? "Saving…" : "Accept change"}
            </button>
          </div>
        </Modal>
      )}
    </aside>
  );
}
