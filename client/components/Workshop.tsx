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
  FilePlus2,
  FilePenLine,
  PanelRightClose,
} from "lucide-react";
import {
  docText,
  type Chapter,
  type Proposal,
  type Workshop as WorkshopData,
} from "../../shared/types";
import { api, chat } from "../api";
import { Modal } from "./Modal";

export function Workshop({
  chapter,
  chapters,
  configured,
  flush,
  onReviewed,
  onSetup,
  onClose,
}: {
  chapter: Chapter;
  chapters: Chapter[];
  configured: boolean;
  flush: () => Promise<boolean>;
  onReviewed: () => Promise<void>;
  onSetup: () => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<WorkshopData>(),
    [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(false),
    [stream, setStream] = useState(""),
    [error, setError] = useState(""),
    [review, setReview] = useState<Proposal>(),
    [reviewing, setReviewing] = useState(false);
  const controller = useRef<AbortController | null>(null),
    bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    api<WorkshopData>(`/chapters/${chapter.id}/workshop`)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      controller.current?.abort();
    };
  }, [chapter.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [stream, data?.messages.length]);
  const send = async () => {
    if (!prompt.trim() || busy || !data) return;
    if (!(await flush())) {
      setError("Save this chapter before discussing it in the Workshop.");
      return;
    }
    const text = prompt;
    setBusy(true);
    setError("");
    setStream("");
    setPrompt("");
    controller.current = new AbortController();
    try {
      await chat(
        chapter.id,
        text,
        controller.current.signal,
        (event, value) => {
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
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
      else setError("Response stopped. Your conversation is saved.");
      try {
        setData(await api<WorkshopData>(`/chapters/${chapter.id}/workshop`));
      } catch {
        /* Keep the current conversation visible. */
      }
    } finally {
      setBusy(false);
      setStream("");
    }
  };
  const decide = async (decision: "accept" | "reject") => {
    if (!review || reviewing) return;
    setReviewing(true);
    setError("");
    try {
      if (decision === "accept" && !(await flush()))
        throw new Error("Save your current edits before accepting a proposal.");
      await api(`/proposals/${review.id}/review`, "POST", { decision });
      setData(await api<WorkshopData>(`/chapters/${chapter.id}/workshop`));
      setReview(undefined);
      if (decision === "accept") await onReviewed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReviewing(false);
    }
  };
  const pending = data?.proposals.filter((p) => p.status === "pending") ?? [];
  const before = review?.chapterId
    ? chapters.find((c) => c.id === review.chapterId)
    : undefined;
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
        <span className="context-title">{chapter.title}</span>
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
        {pending.map((p) => (
          <button
            key={p.id}
            className="proposal-card"
            onClick={() => setReview(p)}
          >
            {p.chapterId ? <FilePenLine size={17} /> : <FilePlus2 size={17} />}
            <div>
              <span className="eyebrow">
                PROPOSED {p.chapterId ? "REVISION" : "CHAPTER"}
              </span>
              <strong>{p.title}</strong>
              <span>Review before applying</span>
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
              </span>
            </div>
          ))}
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div ref={bottom} />
      </div>
      <div className="composer-area">
        {!data?.messages.length && (
          <div className="prompt-suggestions">
            <button
              disabled={!configured}
              onClick={() =>
                setPrompt("Help me explore the core experience of this game.")
              }
            >
              Explore the core idea
            </button>
            <button
              disabled={!configured}
              onClick={() =>
                setPrompt("What questions should we answer about this chapter?")
              }
            >
              Find open questions
            </button>
          </div>
        )}
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
      {review && (
        <Modal
          title="Review proposed change"
          wide
          onClose={() => {
            if (!reviewing) setReview(undefined);
          }}
        >
          <div className="proposal-summary">
            <span className="eyebrow">
              {review.chapterId
                ? "REPLACE CHAPTER CONTENT"
                : "ADD A NEW CHAPTER"}
            </span>
            <h3>{review.title}</h3>
            <p>{review.reason}</p>
          </div>
          <div className="proposal-comparison">
            {before && (
              <section>
                <span className="eyebrow">CURRENT · {before.status}</span>
                <div className="proposal-prose">
                  {docText(before.content) || "This chapter is blank."}
                </div>
              </section>
            )}
            <section>
              <span className="eyebrow">PROPOSED · REQUIRES YOUR APPROVAL</span>
              <div className="proposal-prose">{docText(review.content)}</div>
            </section>
          </div>
          <p className="muted">
            Accepting saves this {review.chapterId ? "revision" : "new chapter"}{" "}
            with Proposed maturity. You decide when it becomes Approved.
          </p>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button disabled={reviewing} onClick={() => void decide("reject")}>
              Reject change
            </button>
            <button
              className="primary"
              disabled={reviewing}
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
