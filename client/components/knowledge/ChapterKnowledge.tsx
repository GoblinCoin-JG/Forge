import { useState } from "react";
import { Lightbulb } from "lucide-react";
import type { DesignConcept } from "../../../shared/knowledge";
import {
  conceptLabel,
  relationshipLabels,
  type KnowledgeController,
} from "../../knowledge";
import { KnowledgeForm } from "./KnowledgeForms";
import type { KnowledgeTab } from "./KnowledgeWorkspace";

export function ChapterKnowledge({
  chapterId,
  controller,
  onSelectConcept,
  onOpenWorkspace,
}: {
  chapterId: string;
  controller: KnowledgeController;
  onSelectConcept: (id: string) => void;
  onOpenWorkspace: (tab: KnowledgeTab) => void;
}) {
  const [link, setLink] = useState(false),
    [unlink, setUnlink] = useState<DesignConcept>();
  const concepts =
      controller.data?.concepts.filter(
        (c) => !c.archivedAt && c.chapterIds.includes(chapterId),
      ) ?? [],
    ids = new Set(concepts.map((c) => c.id));
  const relevant =
    controller.data?.records.filter(
      (r) =>
        r.relatedChapterIds.includes(chapterId) ||
        r.relatedConceptIds.some((id) => ids.has(id)),
    ) ?? [];
  const decisions = relevant.filter((r) => r.authoritative),
    questions = relevant.filter(
      (r) => r.kind === "question" && r.status === "open",
    );
  const relationships =
    controller.data?.relationships.filter(
      (r) =>
        !r.retiredAt &&
        (ids.has(r.sourceConceptId) || ids.has(r.targetConceptId)),
    ) ?? [];
  return (
    <details className="chapter-knowledge">
      <summary>
        <Lightbulb size={14} />
        <strong>Design Knowledge</strong>
        <span>
          {concepts.length} concepts · {questions.length} open questions
        </span>
      </summary>
      <div className="chapter-knowledge-body">
        {controller.error && (
          <div role="alert" className="inline-error">
            {controller.error}
            <button onClick={() => void controller.reload().catch(() => {})}>
              Reload knowledge
            </button>
          </div>
        )}
        {!controller.data && !controller.error && (
          <p role="status">Loading chapter knowledge…</p>
        )}
        <div className="knowledge-section-heading">
          <p>Subjects and choices connected to this chapter.</p>
          <button
            className="quiet-button"
            disabled={!controller.data || controller.loading}
            onClick={() => setLink(true)}
          >
            Associate concept
          </button>
          <button
            className="quiet-button"
            onClick={() => onOpenWorkspace("concepts")}
          >
            Browse Design Knowledge
          </button>
        </div>
        {!concepts.length && (
          <p className="muted">
            No concepts are associated yet. Link a subject when it helps explain
            the chapter.
          </p>
        )}
        <div className="knowledge-links">
          {concepts.map((c) => (
            <div className="knowledge-linked-subject" key={c.id}>
              <button
                className="knowledge-pill"
                onClick={() => onSelectConcept(c.id)}
              >
                {c.name} · {c.status}
              </button>
              <button
                className="icon-button"
                aria-label={`Disassociate ${c.name} from chapter`}
                onClick={() => setUnlink(c)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {!!decisions.length && (
          <section>
            <h4>Approved decisions</h4>
            {decisions.map((r) => (
              <p key={r.id}>{r.text}</p>
            ))}
            <button
              className="quiet-button"
              onClick={() => onOpenWorkspace("decisions")}
            >
              Inspect decisions
            </button>
          </section>
        )}
        {!!questions.length && (
          <section>
            <h4>Open questions</h4>
            {questions.map((r) => (
              <p key={r.id}>{r.text}</p>
            ))}
            <button
              className="quiet-button"
              onClick={() => onOpenWorkspace("questions")}
            >
              Inspect questions
            </button>
          </section>
        )}
        {!!relationships.length && (
          <section>
            <h4>Connections</h4>
            {relationships.map((r) => (
              <p key={r.id}>
                <button
                  className="text-button"
                  onClick={() => onSelectConcept(r.sourceConceptId)}
                >
                  {conceptLabel(controller, r.sourceConceptId)}
                </button>{" "}
                {relationshipLabels[r.type]}{" "}
                <button
                  className="text-button"
                  onClick={() => onSelectConcept(r.targetConceptId)}
                >
                  {conceptLabel(controller, r.targetConceptId)}
                </button>
                <small> · {r.authoritative ? "Reviewed" : "Exploratory"}</small>
              </p>
            ))}
          </section>
        )}
      </div>
      {link && (
        <AssociateConcept
          controller={controller}
          chapterId={chapterId}
          onClose={() => setLink(false)}
        />
      )}
      {unlink && (
        <KnowledgeForm
          title="Disassociate concept"
          submitLabel="Remove chapter association"
          description="This keeps the concept and its history. Changed chapter links require renewed approval of reviewed concepts."
          controller={controller}
          onClose={() => setUnlink(undefined)}
          onSubmit={() =>
            controller.mutate(`/concepts/${unlink.id}/chapters`, "PUT", {
              revision: unlink.revision,
              chapterIds: unlink.chapterIds.filter((id) => id !== chapterId),
            })
          }
        >
          <p>{unlink.name}</p>
        </KnowledgeForm>
      )}
    </details>
  );
}
function AssociateConcept({
  controller,
  chapterId,
  onClose,
}: {
  controller: KnowledgeController;
  chapterId: string;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState("");
  const choices =
    controller.data?.concepts.filter(
      (c) => !c.archivedAt && !c.chapterIds.includes(chapterId),
    ) ?? [];
  return (
    <KnowledgeForm
      title="Associate a design concept"
      submitLabel="Associate concept"
      controller={controller}
      onClose={onClose}
      description="Choose an existing subject. Associating a reviewed concept marks its changed links unreviewed."
      onSubmit={() => {
        const c = choices.find((c) => c.id === selected);
        if (!c) throw new Error("Choose a concept from this project.");
        return controller.mutate(`/concepts/${c.id}/chapters`, "PUT", {
          revision: c.revision,
          chapterIds: [...c.chapterIds, chapterId],
        });
      }}
    >
      {!choices.length ? (
        <p>
          Create a concept in Design Knowledge first, or inspect the subjects
          already linked here.
        </p>
      ) : (
        <label>
          Design concept
          <select
            aria-label="Design concept to associate"
            required
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Choose a concept</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </KnowledgeForm>
  );
}
