import { useState } from "react";
import { ArrowRight, ArrowLeftRight } from "lucide-react";
import {
  relationshipTypes,
  symmetricRelationships,
  type DesignRelationship,
  type RelationshipType,
} from "../../../shared/knowledge";
import {
  conceptLabel,
  relationshipLabels,
  type KnowledgeController,
} from "../../knowledge";
import { KnowledgeForm, KnowledgeStatus } from "./KnowledgeForms";
import { KnowledgeHistory } from "./KnowledgeEvidence";

export function KnowledgeRelationships({
  controller,
  conceptId,
  onSelectConcept,
  onNavigateChapter,
  includeHistorical = false,
}: {
  controller: KnowledgeController;
  conceptId: string;
  onSelectConcept: (id: string) => void;
  onNavigateChapter: (id: string) => void;
  includeHistorical?: boolean;
}) {
  const [action, setAction] = useState<{
      mode: "create" | "edit" | "approve" | "retire";
      relationship?: DesignRelationship;
    }>(),
    [history, setHistory] = useState<DesignRelationship>();
  const relationships =
    controller.data?.relationships.filter(
      (r) =>
        (r.sourceConceptId === conceptId || r.targetConceptId === conceptId) &&
        (includeHistorical || !r.retiredAt),
    ) ?? [];
  const archived = controller.data?.concepts.find(
    (c) => c.id === conceptId,
  )?.archivedAt;
  return (
    <section>
      <header className="knowledge-section-heading">
        <h3>Connected concepts</h3>
        <button
          className="quiet-button"
          disabled={Boolean(archived) || controller.loading}
          onClick={() => setAction({ mode: "create" })}
        >
          Connect concept
        </button>
      </header>
      {!relationships.length && (
        <p className="muted">
          Connect this subject to the other parts of your game's design.
        </p>
      )}
      {relationships.map((r) => (
        <article key={r.id} className="knowledge-relationship">
          <div className="knowledge-relationship-line">
            <button onClick={() => onSelectConcept(r.sourceConceptId)}>
              {conceptLabel(controller, r.sourceConceptId)}
            </button>
            <span>{relationshipLabels[r.type]}</span>
            {symmetricRelationships.has(r.type) ? (
              <ArrowLeftRight size={14} />
            ) : (
              <ArrowRight size={14} />
            )}
            <button onClick={() => onSelectConcept(r.targetConceptId)}>
              {conceptLabel(controller, r.targetConceptId)}
            </button>
          </div>
          <div className="knowledge-relationship-meta">
            <span>
              {symmetricRelationships.has(r.type)
                ? "Shared · symmetric"
                : r.sourceConceptId === conceptId
                  ? "Outgoing · directional"
                  : "Incoming · directional"}
            </span>
            <KnowledgeStatus
              label={r.retiredAt ? "Retired" : r.status}
              reviewed={r.authoritative}
              historical={Boolean(r.retiredAt)}
            />
          </div>
          {r.rationale && <p className="knowledge-prose">{r.rationale}</p>}
          <div className="knowledge-actions">
            {!r.retiredAt && (
              <>
                {!r.authoritative && (
                  <button
                    onClick={() =>
                      setAction({ mode: "approve", relationship: r })
                    }
                  >
                    Approve relationship
                  </button>
                )}
                <button
                  className="quiet-button"
                  onClick={() => setAction({ mode: "edit", relationship: r })}
                >
                  Edit relationship
                </button>
                <button
                  className="quiet-button"
                  onClick={() => setAction({ mode: "retire", relationship: r })}
                >
                  Retire relationship
                </button>
              </>
            )}
            <button className="quiet-button" onClick={() => setHistory(r)}>
              History & sources
            </button>
          </div>
        </article>
      ))}
      {action && (
        <RelationshipAction
          key={`${action.mode}-${action.relationship?.id ?? "new"}`}
          {...action}
          conceptId={conceptId}
          controller={controller}
          onClose={() => setAction(undefined)}
        />
      )}
      {history && (
        <KnowledgeHistory
          subject="relationship"
          id={history.id}
          title="Concept relationship"
          controller={controller}
          onClose={() => setHistory(undefined)}
          onNavigateChapter={onNavigateChapter}
        />
      )}
    </section>
  );
}
function RelationshipAction({
  controller,
  conceptId,
  mode,
  relationship,
  onClose,
}: {
  controller: KnowledgeController;
  conceptId: string;
  mode: "create" | "edit" | "approve" | "retire";
  relationship?: DesignRelationship;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(relationship?.sourceConceptId ?? conceptId),
    [to, setTo] = useState(relationship?.targetConceptId ?? ""),
    [type, setType] = useState<RelationshipType>(
      relationship?.type ?? "depends_on",
    ),
    [rationale, setRationale] = useState(relationship?.rationale ?? "");
  const choices = controller.data?.concepts.filter((c) => !c.archivedAt) ?? [];
  const title = {
    create: "Connect design concepts",
    edit: "Edit relationship",
    approve: "Approve relationship",
    retire: "Retire relationship",
  }[mode];
  return (
    <KnowledgeForm
      controller={controller}
      title={title}
      submitLabel={
        mode === "create"
          ? "Create exploratory relationship"
          : mode === "edit"
            ? "Save relationship"
            : title
      }
      onClose={onClose}
      description={
        mode === "approve"
          ? "Approval marks this connection as reviewed knowledge."
          : mode === "retire"
            ? "Retired connections remain available in history."
            : "Choose how these subjects relate. A new connection starts as an exploratory idea."
      }
      onSubmit={() =>
        controller.mutate(
          mode === "create"
            ? "/relationships"
            : `/relationships/${relationship!.id}${mode === "approve" ? "/approve" : mode === "retire" ? "/retire" : ""}`,
          mode === "edit" ? "PATCH" : "POST",
          mode === "approve" || mode === "retire"
            ? { revision: relationship!.revision }
            : {
                sourceConceptId: from,
                targetConceptId: to,
                type,
                rationale,
                ...(relationship ? { revision: relationship.revision } : {}),
              },
        )
      }
    >
      {mode === "approve" || mode === "retire" ? (
        <p>
          {conceptLabel(controller, from)} {relationshipLabels[type]}{" "}
          {conceptLabel(controller, to)}.
        </p>
      ) : (
        <>
          <label>
            From concept
            <select
              aria-label="From concept"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
            >
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Relationship
            <select
              aria-label="Relationship type"
              value={type}
              onChange={(e) => setType(e.target.value as RelationshipType)}
            >
              {relationshipTypes.map((t) => (
                <option key={t} value={t}>
                  {relationshipLabels[t]} ·{" "}
                  {symmetricRelationships.has(t) ? "symmetric" : "directional"}
                </option>
              ))}
            </select>
          </label>
          <label>
            To concept
            <select
              aria-label="To concept"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            >
              <option value="">Choose a concept</option>
              {choices
                .filter((c) => c.id !== from)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Why they connect
            <textarea
              aria-label="Relationship rationale"
              rows={3}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              maxLength={10000}
            />
          </label>
        </>
      )}
    </KnowledgeForm>
  );
}
