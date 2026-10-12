import { useEffect, useState } from "react";
import type {
  KnowledgeChange,
  KnowledgeSource,
  KnowledgeSourceDetail,
} from "../../../shared/knowledge";
import { Modal } from "../Modal";
import { DocumentPreview } from "../DocumentPreview";
import {
  chapterLabel,
  conceptLabel,
  readableDate,
  relationshipLabels,
  type KnowledgeController,
} from "../../knowledge";

const sourceLabels = {
  manual: "Developer entry",
  chapter: "Design Book source",
  workshop: "Workshop conversation",
  proposal: "Accepted Workshop proposal",
  legacy: "Legacy record · origin not recorded",
};
const availabilityLabels = {
  available: "Available",
  historical: "Historical source",
  missing: "Source evidence missing",
  unknown: "Origin unknown",
};
const operationLabels: Record<string, string> = {
  create: "Created",
  approve: "Approved",
  update: "Edited",
  archive: "Archived",
  restore: "Returned",
  retire: "Retired",
  retire_for_concept_archive: "Retired when a concept was archived",
  set_chapters: "Chapter links changed",
  set_links: "Associations changed",
  resolve: "Question resolved",
  reopen: "Question reopened",
  supersede: "Decision superseded",
  migration_baseline: "Preserved legacy baseline",
};
export function EvidenceList({
  sources,
  controller,
  onNavigateChapter,
}: {
  sources: KnowledgeSource[];
  controller: KnowledgeController;
  onNavigateChapter: (id: string) => void;
}) {
  const [selected, setSelected] = useState<KnowledgeSource>();
  return (
    <>
      <details className="knowledge-evidence">
        <summary>Sources & provenance ({sources.length})</summary>
        {!sources.length && <p className="muted">No source recorded.</p>}
        <div>
          {sources.map((source) => (
            <article key={source.id}>
              <strong>{sourceLabels[source.kind]}</strong>
              <span className="muted">
                {availabilityLabels[source.availability]} ·{" "}
                {readableDate(source.createdAt)}
              </span>
              {source.chapterId && (
                <span>
                  {chapterLabel(controller, source.chapterId)} · saved version{" "}
                  {source.chapterRevision}
                </span>
              )}
              <p>{source.details}</p>
              {source.kind !== "legacy" && source.kind !== "manual" && (
                <button
                  className="quiet-button"
                  onClick={() => setSelected(source)}
                >
                  Inspect source
                </button>
              )}
            </article>
          ))}
        </div>
      </details>
      {selected && (
        <SourceDialog
          source={selected}
          controller={controller}
          onClose={() => setSelected(undefined)}
          onNavigateChapter={onNavigateChapter}
        />
      )}
    </>
  );
}
function SourceDialog({
  source,
  controller,
  onClose,
  onNavigateChapter,
}: {
  source: KnowledgeSource;
  controller: KnowledgeController;
  onClose: () => void;
  onNavigateChapter: (id: string) => void;
}) {
  const [data, setData] = useState<KnowledgeSourceDetail>(),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    controller
      .read<KnowledgeSourceDetail>(`/knowledge/sources/${source.id}`)
      .then((value) => {
        if (live) setData(value);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [source.id, controller.projectId]);
  return (
    <Modal title="Knowledge source" wide onClose={onClose}>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">Loading source…</p>}
      {data && (
        <div className="knowledge-source-view">
          <span className="eyebrow">
            {sourceLabels[data.source.kind]} ·{" "}
            {availabilityLabels[data.source.availability]}
          </span>
          <p>{data.source.details}</p>
          {data.chapter && (
            <p>
              Source chapter:{" "}
              <strong>
                {data.chapterRevision?.title ?? data.chapter.title}
              </strong>
              {data.chapter.archivedAt ? " · Archived" : ""}
            </p>
          )}
          {data.proposal && (
            <section>
              <h3>{data.proposal.title}</h3>
              <p>Reviewed proposal · {data.proposal.status}</p>
              <p>{data.proposal.reason}</p>
            </section>
          )}
          {data.message && (
            <section>
              <h3>
                {data.message.role === "assistant"
                  ? "Workshop response"
                  : "Developer message"}
              </h3>
              <p className="knowledge-prose">{data.message.content}</p>
              <small>{readableDate(data.message.createdAt)}</small>
            </section>
          )}
          {data.chapterRevision && (
            <section>
              <h3>Saved chapter version {data.chapterRevision.revision}</h3>
              <DocumentPreview content={data.chapterRevision.content} />
            </section>
          )}
          {data.chapter && (
            <button
              className="quiet-button"
              onClick={() => {
                onClose();
                onNavigateChapter(data.chapter!.id);
              }}
            >
              Open source chapter
            </button>
          )}
        </div>
      )}
      <div className="modal-actions">
        <button onClick={onClose}>Close source</button>
      </div>
    </Modal>
  );
}
export function KnowledgeHistory({
  subject,
  id,
  title,
  controller,
  onClose,
  onNavigateChapter,
  initialRevision,
}: {
  subject: "concept" | "relationship" | "record";
  id: string;
  title: string;
  controller: KnowledgeController;
  onClose: () => void;
  onNavigateChapter: (id: string) => void;
  initialRevision?: number;
}) {
  const [history, setHistory] = useState<KnowledgeChange[]>([]),
    [selected, setSelected] = useState<number>(),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const collection = subject === "record" ? "records" : `${subject}s`;
    controller
      .read<KnowledgeChange[]>(`/${collection}/${id}/history`)
      .then((value) => {
        if (live) {
          setHistory(value);
          setSelected(initialRevision ?? value[0]?.revision);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [id, subject, controller.projectId]);
  const change = history.find((h) => h.revision === selected),
    snapshot = change?.snapshot;
  const chapterLinks = snapshot?.chapterIds ?? snapshot?.relatedChapterIds;
  return (
    <Modal title={`Knowledge history · ${title}`} wide onClose={onClose}>
      <p className="modal-intro">
        Saved evidence is kept exactly as recorded. Viewing an earlier version
        does not change current knowledge.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {!history.length && !error && <p role="status">Loading history…</p>}
      {!!history.length && (
        <label>
          Saved version
          <select
            aria-label="Knowledge version"
            value={selected ?? ""}
            onChange={(e) => setSelected(Number(e.target.value))}
          >
            {history.map((h) => (
              <option key={h.id} value={h.revision}>
                Version {h.revision} ·{" "}
                {operationLabels[h.operation] ??
                  h.operation.replaceAll("_", " ")}{" "}
                · {readableDate(h.createdAt)}
              </option>
            ))}
          </select>
        </label>
      )}
      {change && snapshot && (
        <article className="knowledge-history-snapshot">
          <span className="eyebrow">
            Historical snapshot ·{" "}
            {operationLabels[change.operation] ?? change.operation} ·{" "}
            {change.actor === "migration"
              ? "Legacy baseline"
              : change.actor === "proposal"
                ? "Reviewed proposal"
                : "Developer action"}
          </span>
          <h3>{String(snapshot.name ?? snapshot.text ?? title)}</h3>
          <p>
            {String(snapshot.status ?? "")}
            {snapshot.archivedAt ? " · Archived" : ""}
            {snapshot.retiredAt ? " · Retired" : ""}
            {snapshot.supersededBy ? " · Superseded" : ""}
          </p>
          {snapshot.category != null && (
            <p>Category: {String(snapshot.category)}</p>
          )}
          {snapshot.description != null && (
            <p className="knowledge-prose">{String(snapshot.description)}</p>
          )}
          {snapshot.rationale != null && (
            <p className="knowledge-prose">{String(snapshot.rationale)}</p>
          )}
          {snapshot.type != null && (
            <p>
              {conceptLabel(controller, String(snapshot.sourceConceptId))}{" "}
              {relationshipLabels[
                snapshot.type as keyof typeof relationshipLabels
              ] ?? String(snapshot.type)}{" "}
              {conceptLabel(controller, String(snapshot.targetConceptId))}
              <small> · Connected names shown as they appear now.</small>
            </p>
          )}
          {snapshot.resolution != null && (
            <section>
              <h4>Recorded answer</h4>
              <p className="knowledge-prose">{String(snapshot.resolution)}</p>
              <small>
                {readableDate(String(snapshot.resolvedAt ?? change.createdAt))}
              </small>
            </section>
          )}
          {Array.isArray(chapterLinks) && (
            <p>
              Chapter links at this version (current names):{" "}
              {chapterLinks
                .map((id) => chapterLabel(controller, String(id)))
                .join(", ") || "None"}
            </p>
          )}
          {Array.isArray(snapshot.relatedConceptIds) && (
            <p>
              Concept links at this version (current names):{" "}
              {(snapshot.relatedConceptIds as string[])
                .map((id) => conceptLabel(controller, id))
                .join(", ") || "None"}
            </p>
          )}
          <EvidenceList
            sources={change.sources}
            controller={controller}
            onNavigateChapter={onNavigateChapter}
          />
        </article>
      )}
      <div className="modal-actions">
        <button onClick={onClose}>Close knowledge history</button>
      </div>
    </Modal>
  );
}
