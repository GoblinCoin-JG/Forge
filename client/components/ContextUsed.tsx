import { useEffect, useState } from "react";
import type {
  ContextInspection,
  ContextSourceInspection,
  ContextReference,
  ContextSource,
} from "../../shared/context";
import { api } from "../api";
import { Modal } from "./Modal";
import { DocumentPreview } from "./DocumentPreview";
const authorityLabels = {
  "current-approved": "Current approved direction",
  "previously-approved": "Previously approved version",
  exploratory: "Exploratory",
  unreviewed: "Newer unreviewed content",
  historical: "Historical evidence",
  unresolved: "Unresolved question",
  resolved: "Recorded answer",
  discussion: "Discussion evidence",
  identity: "Project overview",
};
const kindLabels = {
  project: "Project",
  chapter: "Chapter",
  concept: "Concept",
  relationship: "Relationship",
  decision: "Decision",
  question: "Question",
  message: "Conversation",
  outline: "Overview",
};
export function ContextUsed({
  projectId,
  reference,
  onChapter,
  onConcept,
  responseState,
}: {
  projectId: string;
  reference?: ContextReference;
  onChapter?: (id: string) => void;
  onConcept?: (id: string) => void;
  responseState?: "complete" | "failed" | "interrupted";
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<ContextInspection>(),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<ContextSource>(),
    [detail, setDetail] = useState<ContextSourceInspection>(),
    [attempt, setAttempt] = useState(0),
    [allSources, setAllSources] = useState(false),
    [allOmissions, setAllOmissions] = useState(false);
  useEffect(() => {
    if (!open || !reference || data) return;
    let live = true;
    setError("");
    void api<ContextInspection>(
      `/projects/${projectId}/context/${reference.requestId}`,
    )
      .then((v) => {
        if (live) setData(v);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [open, reference?.requestId, projectId, data, attempt]);
  useEffect(() => {
    setDetail(undefined);
    if (!selected || !reference) return;
    let live = true;
    setError("");
    void api<ContextSourceInspection>(
      `/projects/${projectId}/context/${reference.requestId}/source?key=${encodeURIComponent(selected.key)}`,
    )
      .then((v) => {
        if (live) setDetail(v);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [selected, reference?.requestId, projectId, attempt]);
  if (!reference)
    return (
      <details className="context-used">
        <summary>Context Used</summary>
        <p>Context was not recorded for this older response.</p>
      </details>
    );
  return (
    <>
      <details
        className="context-used"
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary>Context Used</summary>
        <p>
          {responseState && responseState !== "complete"
            ? "Recorded context prepared for this AI attempt. Delivery is not confirmed for failed or interrupted requests."
            : "Information supplied to the AI for this response."}{" "}
          This does not prove which sources the model considered. Versions and
          authority reflect the time of this request.
        </p>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {error && (
          <button
            className="text-button"
            onClick={() => setAttempt((v) => v + 1)}
          >
            Retry context
          </button>
        )}
        {open && !data && !error && <p>Loading supplied context…</p>}
        {data && (
          <>
            <p className="muted">
              {data.manifest.sources.length} supplied sources ·{" "}
              {Math.ceil(data.manifest.requestBytes / 1024)} KiB request ·{" "}
              {data.manifest.estimatedInputTokens.toLocaleString()} estimated
              input tokens
            </p>
            <ul className="context-source-list">
              {data.manifest.sources
                .slice(0, allSources ? undefined : 12)
                .map((s) => (
                  <li key={s.key}>
                    <button
                      className="text-button"
                      onClick={() => setSelected(s)}
                    >
                      {s.label}
                    </button>
                    <span>
                      {kindLabels[s.kind]} ·{" "}
                      {s.revision === null
                        ? "recorded evidence"
                        : `version ${s.revision}`}{" "}
                      · {authorityLabels[s.authority]} · {s.maturity} ·{" "}
                      {s.coverage === "overview"
                        ? "Overview only"
                        : s.coverage === "partial"
                          ? "Partially supplied"
                          : "Fully supplied"}
                    </span>
                    <small>{s.reason}</small>
                    {s.sections?.length ? (
                      <small>
                        Sections:{" "}
                        {s.sections
                          .map(
                            (x) =>
                              `${x.path.join(" › ")}${x.complete ? "" : " (partial)"}`,
                          )
                          .join("; ")}
                      </small>
                    ) : null}
                  </li>
                ))}
            </ul>
            {data.manifest.sources.length > 12 && (
              <button
                className="text-button"
                onClick={() => setAllSources((v) => !v)}
              >
                {allSources
                  ? "Show fewer sources"
                  : `Show all ${data.manifest.sources.length} supplied sources`}
              </button>
            )}
            {!!data.manifest.omissions.length && (
              <div className="context-omissions">
                <strong>Incomplete or omitted context</strong>
                <ul>
                  {data.manifest.omissions
                    .slice(0, allOmissions ? undefined : 6)
                    .map((o, i) => (
                      <li key={i}>
                        {o.label
                          ? `${o.label}: `
                          : `${o.count} ${o.kind} source(s): `}
                        {o.reason}
                      </li>
                    ))}
                </ul>
                {data.manifest.omissions.length > 6 && (
                  <button
                    className="text-button"
                    onClick={() => setAllOmissions((v) => !v)}
                  >
                    {allOmissions
                      ? "Show fewer omissions"
                      : `Show all ${data.manifest.omissions.length} omission entries`}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </details>
      {selected && (
        <Modal title="Supplied source" onClose={() => setSelected(undefined)}>
          {error && (
            <p role="alert" className="inline-error">
              {error}{" "}
              <button
                className="text-button"
                onClick={() => setAttempt((v) => v + 1)}
              >
                Retry source
              </button>
            </p>
          )}
          <h3>{selected.label}</h3>
          <p>
            {authorityLabels[selected.authority]} ·{" "}
            {selected.coverage === "overview"
              ? "Overview only"
              : selected.coverage === "partial"
                ? "Partially supplied"
                : "Fully supplied"}
            {selected.revision !== null
              ? ` · saved version ${selected.revision}`
              : ""}
          </p>
          <p>
            This is captured evidence from this request, even if the source has
            since changed.
          </p>
          {!detail ? (
            <p>Loading source…</p>
          ) : (
            <>
              {detail.content && <DocumentPreview content={detail.content} />}
              <p className="context-captured-text">{detail.text}</p>
              {detail.fields?.map((f, i) => (
                <p key={i}>
                  <strong>{f.label}: </strong>
                  {f.value}
                </p>
              ))}
              {detail.availability === "missing" && (
                <p>Source content is unavailable.</p>
              )}
            </>
          )}
          {selected.chapterId && onChapter && (
            <button
              className="secondary-button"
              onClick={() => onChapter(selected.chapterId!)}
            >
              Open current chapter
            </button>
          )}
          {(selected.kind === "concept" ||
            selected.key.startsWith("overview:concept:")) &&
            onConcept && (
              <button
                className="secondary-button"
                onClick={() => onConcept(selected.id)}
              >
                Open current concept
              </button>
            )}
        </Modal>
      )}
    </>
  );
}
