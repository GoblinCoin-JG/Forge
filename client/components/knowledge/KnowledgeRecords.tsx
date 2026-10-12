import { useEffect, useRef, useState } from "react";
import type { DesignRecord } from "../../../shared/types";
import {
  chapterLabel,
  conceptLabel,
  readableDate,
  type KnowledgeController,
} from "../../knowledge";
import {
  KnowledgeForm,
  KnowledgeStatus,
  ReferencePicker,
} from "./KnowledgeForms";
import { EvidenceList, KnowledgeHistory } from "./KnowledgeEvidence";

export function KnowledgeRecords({
  controller,
  kind,
  onSelectConcept,
  onNavigateChapter,
  conceptId,
  chapterId,
  includeHistorical = false,
  focusId,
}: {
  controller: KnowledgeController;
  kind: "decision" | "question";
  onSelectConcept: (id: string) => void;
  onNavigateChapter: (id: string) => void;
  conceptId?: string;
  chapterId?: string;
  includeHistorical?: boolean;
  focusId?: string;
}) {
  const [action, setAction] = useState<{
      mode: "create" | "supersede" | "resolve" | "reopen" | "links";
      record?: DesignRecord;
    }>(),
    [history, setHistory] = useState<DesignRecord>();
  const focused = useRef<HTMLElement>(null);
  useEffect(() => {
    focused.current?.scrollIntoView({ block: "nearest" });
  }, [focusId, controller.data]);
  const records =
    controller.data?.records.filter(
      (r) =>
        r.kind === kind &&
        (!conceptId || r.relatedConceptIds.includes(conceptId)) &&
        (!chapterId || r.relatedChapterIds.includes(chapterId)) &&
        (includeHistorical || !r.supersededBy),
    ) ?? [];
  const newDisabled = Boolean(
    conceptId &&
    controller.data?.concepts.find((c) => c.id === conceptId)?.archivedAt,
  );
  return (
    <section className="knowledge-records">
      <header className="knowledge-section-heading">
        <h3>
          {kind === "decision" ? "Design decisions" : "Questions & answers"}
        </h3>
        <button
          className="quiet-button"
          disabled={newDisabled || controller.loading}
          onClick={() => setAction({ mode: "create" })}
        >
          {kind === "decision" ? "New decision" : "New question"}
        </button>
      </header>
      {!records.length && (
        <div className="knowledge-empty small">
          <p>
            {kind === "decision"
              ? "No design decisions here yet. Record a deliberate choice and the reasoning behind it."
              : "No questions here yet. Capture an uncertainty worth returning to."}
          </p>
        </div>
      )}
      {records.map((record) => (
        <article
          ref={record.id === focusId ? focused : undefined}
          aria-current={record.id === focusId ? "true" : undefined}
          key={record.id}
          className={`knowledge-record ${record.supersededBy ? "historical" : ""}`}
        >
          <KnowledgeStatus
            label={
              record.kind === "decision"
                ? record.supersededBy
                  ? "Historical · Superseded"
                  : "Approved decision"
                : record.status === "open"
                  ? "Open question"
                  : "Resolved question"
            }
            reviewed={record.authoritative}
            historical={Boolean(record.supersededBy)}
          />
          <h4>{record.text}</h4>
          {record.rationale && (
            <p className="knowledge-prose">{record.rationale}</p>
          )}
          {record.supersededBy && (
            <p className="muted">
              Replaced by:{" "}
              {controller.data?.records.find(
                (r) => r.id === record.supersededBy,
              )?.text ?? "A newer decision"}
            </p>
          )}
          {record.resolution && (
            <div className="knowledge-answer">
              <strong>Recorded answer</strong>
              <p className="knowledge-prose">{record.resolution}</p>
              <small>{readableDate(record.resolvedAt)}</small>
            </div>
          )}
          {record.status === "resolved" && !record.resolution && (
            <p className="muted">
              The original answer was not recorded. Earlier evidence remains in
              history.
            </p>
          )}
          <div className="knowledge-links">
            {record.relatedConceptIds.map((id) => (
              <button
                className="knowledge-pill"
                key={id}
                onClick={() => onSelectConcept(id)}
              >
                {conceptLabel(controller, id)}
              </button>
            ))}
            {record.relatedChapterIds.map((id) => (
              <button
                className="quiet-button"
                key={id}
                onClick={() => onNavigateChapter(id)}
              >
                {chapterLabel(controller, id)}
                {controller.chapters.find((c) => c.id === id)?.archivedAt
                  ? " · Archived"
                  : ""}
              </button>
            ))}
          </div>
          {!!record.unavailableChapterReferences.length && (
            <p className="muted">
              {record.unavailableChapterReferences.length} earlier chapter
              link(s) are unavailable. Their references are preserved as
              historical evidence.
            </p>
          )}
          <div className="knowledge-actions">
            {record.authoritative && (
              <button onClick={() => setAction({ mode: "supersede", record })}>
                Supersede decision
              </button>
            )}
            {record.kind === "question" && (
              <button
                onClick={() =>
                  setAction({
                    mode: record.status === "open" ? "resolve" : "reopen",
                    record,
                  })
                }
              >
                {record.status === "open"
                  ? "Resolve question"
                  : "Reopen question"}
              </button>
            )}
            <button
              className="quiet-button"
              onClick={() => setAction({ mode: "links", record })}
            >
              Edit associations
            </button>
            <button className="quiet-button" onClick={() => setHistory(record)}>
              History
            </button>
          </div>
          <EvidenceList
            sources={record.sources}
            controller={controller}
            onNavigateChapter={onNavigateChapter}
          />
        </article>
      ))}
      {action && (
        <RecordAction
          key={`${action.mode}-${action.record?.id ?? "new"}`}
          {...action}
          kind={kind}
          controller={controller}
          conceptId={conceptId}
          chapterId={chapterId}
          onClose={() => setAction(undefined)}
        />
      )}
      {history && (
        <KnowledgeHistory
          subject="record"
          id={history.id}
          title={history.text}
          controller={controller}
          onClose={() => setHistory(undefined)}
          onNavigateChapter={onNavigateChapter}
        />
      )}
    </section>
  );
}
function RecordAction({
  mode,
  record,
  kind,
  controller,
  conceptId,
  chapterId,
  onClose,
}: {
  mode: "create" | "supersede" | "resolve" | "reopen" | "links";
  record?: DesignRecord;
  kind: "decision" | "question";
  controller: KnowledgeController;
  conceptId?: string;
  chapterId?: string;
  onClose: () => void;
}) {
  const [text, setText] = useState(
      mode === "supersede" ? (record?.text ?? "") : "",
    ),
    [rationale, setRationale] = useState(
      mode === "supersede" ? (record?.rationale ?? "") : "",
    ),
    [answer, setAnswer] = useState("");
  const [concepts, setConcepts] = useState(
      record?.relatedConceptIds ?? (conceptId ? [conceptId] : []),
    ),
    [chapters, setChapters] = useState(
      record?.relatedChapterIds ?? (chapterId ? [chapterId] : []),
    );
  const titles = {
    create:
      kind === "decision"
        ? "Record a design decision"
        : "Create an open question",
    supersede: "Supersede decision",
    resolve: "Resolve question",
    reopen: "Reopen question",
    links: "Edit knowledge associations",
  };
  const labels = {
    create:
      kind === "decision" ? "Create approved decision" : "Create open question",
    supersede: "Approve replacement decision",
    resolve: "Save answer",
    reopen: "Reopen question",
    links: "Save associations",
  };
  const description =
    mode === "supersede"
      ? "This creates a new approved decision and preserves the previous statement in history."
      : mode === "create" && kind === "decision"
        ? "Recording this decision establishes an approved design choice. Include the reasoning you want to preserve."
        : mode === "reopen"
          ? "Reopening keeps earlier answers in history and marks the question unresolved again."
          : "Keep the choice, question and its related design subjects understandable.";
  return (
    <KnowledgeForm
      title={titles[mode]}
      submitLabel={labels[mode]}
      description={description}
      controller={controller}
      onClose={onClose}
      onSubmit={() => {
        if (mode === "resolve")
          return controller.mutate(`/questions/${record!.id}/resolve`, "POST", {
            revision: record!.revision,
            answer,
          });
        if (mode === "reopen")
          return controller.mutate(`/questions/${record!.id}/reopen`, "POST", {
            revision: record!.revision,
          });
        if (mode === "links")
          return controller.mutate(`/records/${record!.id}/links`, "PUT", {
            revision: record!.revision,
            chapterIds: chapters,
            conceptIds: concepts,
          });
        return controller.mutate(
          mode === "supersede"
            ? `/decisions/${record!.id}/supersede`
            : kind === "decision"
              ? "/decisions"
              : "/questions",
          "POST",
          {
            text,
            rationale,
            chapterIds: chapters,
            conceptIds: concepts,
            ...(mode === "supersede" ? { revision: record!.revision } : {}),
          },
        );
      }}
    >
      {record && <p className="knowledge-prose">{record.text}</p>}
      {(mode === "create" || mode === "supersede") && (
        <>
          <label>
            {kind === "decision" ? "Decision statement" : "Question"}
            <textarea
              aria-label={
                kind === "decision" ? "Decision statement" : "Question"
              }
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
              maxLength={100000}
            />
          </label>
          <label>
            {kind === "decision" ? "Reasoning" : "Why it matters"}
            <textarea
              aria-label="Knowledge rationale"
              rows={3}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              maxLength={10000}
            />
          </label>
        </>
      )}
      {mode === "resolve" && (
        <label>
          Resolution answer
          <textarea
            aria-label="Resolution answer"
            rows={4}
            required
            maxLength={20000}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </label>
      )}
      {!["resolve", "reopen"].includes(mode) && (
        <>
          <ReferencePicker
            label="Related concepts"
            selected={concepts}
            onChange={setConcepts}
            options={(controller.data?.concepts ?? []).map((c) => ({
              id: c.id,
              label: c.name,
              archived: Boolean(c.archivedAt),
            }))}
          />
          <ReferencePicker
            label="Related chapters"
            selected={chapters}
            onChange={setChapters}
            options={controller.chapters.map((c) => ({
              id: c.id,
              label: c.title,
              archived: Boolean(c.archivedAt),
            }))}
          />
        </>
      )}
    </KnowledgeForm>
  );
}
