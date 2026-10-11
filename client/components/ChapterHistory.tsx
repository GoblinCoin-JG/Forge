import { useEffect, useState } from "react";
import type { Chapter, ChapterRevision } from "../../shared/types";
import { api } from "../api";
import { Modal } from "./Modal";
import { DocumentPreview } from "./DocumentPreview";

export function ChapterHistory({
  chapter,
  onClose,
  onRestored,
}: {
  chapter: Chapter;
  onClose: () => void;
  onRestored: (chapter: Chapter) => Promise<void>;
}) {
  const [current, setCurrent] = useState(chapter),
    [history, setHistory] = useState<ChapterRevision[]>([]),
    [selected, setSelected] = useState<number>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [compare, setCompare] = useState(false);
  const load = async () => {
    const [c, versions] = await Promise.all([
      api<Chapter>(`/chapters/${chapter.id}`),
      api<ChapterRevision[]>(`/chapters/${chapter.id}/history`),
    ]);
    setCurrent(c);
    setHistory(versions);
    setSelected((value) => value ?? versions[0]?.revision);
    setError("");
  };
  useEffect(() => {
    let live = true;
    Promise.all([
      api<Chapter>(`/chapters/${chapter.id}`),
      api<ChapterRevision[]>(`/chapters/${chapter.id}/history`),
    ])
      .then(([c, versions]) => {
        if (live) {
          setCurrent(c);
          setHistory(versions);
          setSelected(versions[0]?.revision);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [chapter.id]);
  const version = history.find((h) => h.revision === selected);
  const approved = history.find((h) => h.revision === current.approvedRevision);
  const restore = async () => {
    if (!version) return;
    setBusy(true);
    setError("");
    try {
      const updated = await api<Chapter>(
        `/chapters/${chapter.id}/restore`,
        "POST",
        { savedRevision: version.revision, revision: current.revision },
      );
      setCurrent(updated);
      await onRestored(updated);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const unarchive = async () => {
    setBusy(true);
    setError("");
    try {
      const updated = await api<Chapter>(
        `/chapters/${chapter.id}/unarchive`,
        "POST",
        { revision: current.revision },
      );
      setCurrent(updated);
      await onRestored(updated);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Chapter history · ${chapter.title}`}
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="muted">
        Saved versions preserve their original formatting. Restoring creates a
        new, unreviewed version; earlier history and approvals stay intact.
      </p>
      {current.archivedAt && (
        <p className="approval-notice">
          Archived on {new Date(current.archivedAt).toLocaleString()}. Its
          document, history and Workshop evidence are preserved.
        </p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}{" "}
          <button
            disabled={busy}
            onClick={() => void load().catch((e) => setError(e.message))}
          >
            Reload history
          </button>
        </p>
      )}
      <label>
        Saved version
        <select
          aria-label="Saved version"
          value={selected ?? ""}
          disabled={!history.length || busy}
          onChange={(e) => setSelected(Number(e.target.value))}
        >
          {history.map((h) => (
            <option key={h.revision} value={h.revision}>
              Version {h.revision} · {new Date(h.createdAt).toLocaleString()} ·{" "}
              {h.origin}
              {h.approvedAt ? " · Approved" : ""}
            </option>
          ))}
        </select>
      </label>
      {approved && (
        <label className="history-compare">
          <input
            type="checkbox"
            checked={compare}
            onChange={(e) => setCompare(e.target.checked)}
          />{" "}
          Compare with last approved version ({approved.revision})
        </label>
      )}
      {version && (
        <div
          className={`history-previews ${compare && approved ? "comparing" : ""}`}
        >
          {compare && approved && (
            <section>
              <span className="eyebrow">
                LAST APPROVED · VERSION {approved.revision}
              </span>
              <h3>{approved.title}</h3>
              <DocumentPreview content={approved.content} />
            </section>
          )}
          <section>
            <span className="eyebrow">
              SAVED VERSION {version.revision} · {version.status}
            </span>
            <h3>{version.title}</h3>
            <p className="muted">
              {version.approvalOrigin === "migration"
                ? "Approval carried forward from the existing chapter label; earlier versions were not available."
                : version.approvedAt
                  ? `Explicitly approved ${new Date(version.approvedAt).toLocaleString()}.`
                  : "No approval recorded for this exact version."}
              {version.restoredFrom !== null
                ? ` Restored from version ${version.restoredFrom}.`
                : ""}
              {version.proposalId
                ? " Saved from an accepted Workshop proposal."
                : ""}
            </p>
            <DocumentPreview content={version.content} />
          </section>
        </div>
      )}
      <div className="modal-actions">
        <button disabled={busy} onClick={onClose}>
          Close history
        </button>
        {current.archivedAt ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() => void unarchive()}
          >
            Return chapter to book
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || !version || version.revision === current.revision}
            onClick={() => void restore()}
          >
            {busy ? "Restoring…" : "Restore selected version"}
          </button>
        )}
      </div>
    </Modal>
  );
}
