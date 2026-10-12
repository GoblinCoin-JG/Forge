import { useState } from "react";
import type { DesignConcept } from "../../../shared/knowledge";
import {
  chapterLabel,
  readableDate,
  type KnowledgeController,
} from "../../knowledge";
import {
  KnowledgeForm,
  KnowledgeStatus,
  ReferencePicker,
} from "./KnowledgeForms";
import { EvidenceList, KnowledgeHistory } from "./KnowledgeEvidence";
import { KnowledgeRelationships } from "./KnowledgeRelationships";
import { KnowledgeRecords } from "./KnowledgeRecords";

export function ConceptEditor({
  controller,
  concept,
  onClose,
  onCreated,
}: {
  controller: KnowledgeController;
  concept?: DesignConcept;
  onClose: () => void;
  onCreated?: (concept: DesignConcept) => void;
}) {
  const [name, setName] = useState(concept?.name ?? ""),
    [category, setCategory] = useState(concept?.category ?? "mechanic"),
    [description, setDescription] = useState(concept?.description ?? "");
  return (
    <KnowledgeForm
      controller={controller}
      title={concept ? "Edit concept" : "Create a design concept"}
      submitLabel={concept ? "Save concept" : "Create exploring concept"}
      onClose={onClose}
      description={
        concept?.authoritative
          ? "Changes to approved descriptions become unreviewed. The earlier approved version remains in history."
          : "Give a meaningful design subject a name. It starts as an exploratory idea you can refine and approve later."
      }
      onSubmit={async () => {
        const saved = await controller.mutate<DesignConcept>(
          concept ? `/concepts/${concept.id}` : "/concepts",
          concept ? "PATCH" : "POST",
          {
            name,
            category,
            description,
            ...(concept ? { revision: concept.revision } : {}),
          },
        );
        if (!concept) onCreated?.(saved);
      }}
    >
      <label>
        Concept name
        <input
          aria-label="Concept name"
          autoFocus
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Player Movement"
        />
      </label>
      <label>
        Category
        <input
          aria-label="Concept category"
          required
          maxLength={80}
          list="knowledge-categories"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="mechanic, system, world…"
        />
      </label>
      <datalist id="knowledge-categories">
        {Array.from(
          new Set([
            "mechanic",
            "system",
            "rule",
            "world",
            "progression",
            ...(controller.data?.concepts.map((c) => c.category) ?? []),
          ]),
        ).map((category) => (
          <option key={category} value={category} />
        ))}
      </datalist>
      <label>
        Description
        <textarea
          aria-label="Concept description"
          rows={5}
          maxLength={20000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What does this subject mean for the game and its players?"
        />
      </label>
    </KnowledgeForm>
  );
}
export function ConceptDetail({
  concept,
  controller,
  onSelectConcept,
  onNavigateChapter,
}: {
  concept: DesignConcept;
  controller: KnowledgeController;
  onSelectConcept: (id: string) => void;
  onNavigateChapter: (id: string) => void;
}) {
  const [action, setAction] = useState<
      "edit" | "approve" | "archive" | "restore" | "chapters"
    >(),
    [history, setHistory] = useState<{ revision?: number }>(),
    [historical, setHistorical] = useState(false);
  return (
    <article className="knowledge-concept-detail">
      <header className="knowledge-detail-heading">
        <div>
          <span className="eyebrow">{concept.category}</span>
          <h2>{concept.name}</h2>
          <KnowledgeStatus
            label={concept.archivedAt ? "Archived" : concept.status}
            reviewed={concept.authoritative}
            historical={Boolean(concept.archivedAt)}
          />
        </div>
        <button className="quiet-button" onClick={() => setHistory({})}>
          History
        </button>
      </header>
      {concept.approvedRevision !== null && !concept.authoritative && (
        <div className="approval-notice">
          <span>
            {concept.archivedAt
              ? "The approved evidence is retained with this archived subject."
              : `Current changes are unreviewed. Last approved version: ${concept.approvedRevision}.`}
          </span>
          <button
            className="quiet-button"
            onClick={() => setHistory({ revision: concept.approvedRevision! })}
          >
            Inspect approved version
          </button>
        </div>
      )}
      <p className="knowledge-prose concept-description">
        {concept.description ||
          "Add a description to capture this subject's role in your game."}
      </p>
      <div className="knowledge-actions">
        {concept.archivedAt ? (
          <button onClick={() => setAction("restore")}>Return concept</button>
        ) : (
          <>
            <button onClick={() => setAction("edit")}>Edit concept</button>
            {!concept.authoritative && (
              <button onClick={() => setAction("approve")}>
                Approve concept
              </button>
            )}
            <button
              className="quiet-button"
              onClick={() => setAction("archive")}
            >
              Archive concept
            </button>
          </>
        )}
      </div>
      <section>
        <header className="knowledge-section-heading">
          <h3>Design Book chapters</h3>
          <button
            className="quiet-button"
            disabled={Boolean(concept.archivedAt)}
            onClick={() => setAction("chapters")}
          >
            Edit chapter links
          </button>
        </header>
        {!concept.chapterIds.length && (
          <p className="muted">
            This concept stands on its own. Link it to chapters that describe it
            when useful.
          </p>
        )}
        <div className="knowledge-links">
          {concept.chapterIds.map((id) => (
            <button
              className="knowledge-pill"
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
      </section>
      <label className="knowledge-check">
        <input
          type="checkbox"
          checked={historical}
          onChange={(e) => setHistorical(e.target.checked)}
        />{" "}
        Include retired relationships and superseded decisions
      </label>
      <KnowledgeRelationships
        controller={controller}
        conceptId={concept.id}
        onSelectConcept={onSelectConcept}
        onNavigateChapter={onNavigateChapter}
        includeHistorical={historical}
      />
      <KnowledgeRecords
        controller={controller}
        kind="decision"
        conceptId={concept.id}
        includeHistorical={historical}
        onSelectConcept={onSelectConcept}
        onNavigateChapter={onNavigateChapter}
      />
      <KnowledgeRecords
        controller={controller}
        kind="question"
        conceptId={concept.id}
        onSelectConcept={onSelectConcept}
        onNavigateChapter={onNavigateChapter}
      />
      <EvidenceList
        sources={concept.sources}
        controller={controller}
        onNavigateChapter={onNavigateChapter}
      />
      <footer className="knowledge-dates">
        <span>Created {readableDate(concept.createdAt)}</span>
        <span>
          Updated {readableDate(concept.updatedAt)} · version {concept.revision}
        </span>
        {concept.authoritative && (
          <span>
            Reviewed knowledge · approved version {concept.approvedRevision}
          </span>
        )}
      </footer>
      {action === "edit" && (
        <ConceptEditor
          concept={concept}
          controller={controller}
          onClose={() => setAction(undefined)}
        />
      )}
      {action && action !== "edit" && (
        <ConceptAction
          mode={action}
          concept={concept}
          controller={controller}
          onClose={() => setAction(undefined)}
        />
      )}
      {history && (
        <KnowledgeHistory
          subject="concept"
          id={concept.id}
          title={concept.name}
          initialRevision={history.revision}
          controller={controller}
          onClose={() => setHistory(undefined)}
          onNavigateChapter={onNavigateChapter}
        />
      )}
    </article>
  );
}
function ConceptAction({
  mode,
  concept,
  controller,
  onClose,
}: {
  mode: "approve" | "archive" | "restore" | "chapters";
  concept: DesignConcept;
  controller: KnowledgeController;
  onClose: () => void;
}) {
  const [chapters, setChapters] = useState(concept.chapterIds),
    [name, setName] = useState(concept.name);
  const labels = {
    approve: "Approve concept",
    archive: "Archive concept",
    restore: "Return concept",
    chapters: "Save chapter links",
  };
  const description = {
    approve: "Mark this exact concept version as reviewed knowledge.",
    archive:
      "Archiving also retires its active relationships. Earlier versions and approved decisions remain available.",
    restore:
      "Return this subject as unreviewed knowledge. Its retired relationships remain in history. Choose another name if an active concept already uses this one.",
    chapters:
      "Link this subject to the chapters that describe it. Changed associations make approved concepts unreviewed until approved again.",
  };
  return (
    <KnowledgeForm
      title={labels[mode]}
      submitLabel={labels[mode]}
      description={description[mode]}
      controller={controller}
      onClose={onClose}
      onSubmit={() =>
        controller.mutate(
          `/concepts/${concept.id}/${mode === "chapters" ? "chapters" : mode}`,
          mode === "chapters" ? "PUT" : "POST",
          {
            revision: concept.revision,
            ...(mode === "restore"
              ? { name }
              : mode === "chapters"
                ? { chapterIds: chapters }
                : {}),
          },
        )
      }
    >
      <p>
        <strong>{concept.name}</strong>
      </p>
      {mode === "restore" && (
        <label>
          Concept name on return
          <input
            aria-label="Concept name on return"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
          />
        </label>
      )}
      {mode === "chapters" && (
        <ReferencePicker
          label="Linked chapters"
          options={controller.chapters.map((c) => ({
            id: c.id,
            label: c.title,
            archived: Boolean(c.archivedAt),
          }))}
          selected={chapters}
          onChange={setChapters}
        />
      )}
    </KnowledgeForm>
  );
}
