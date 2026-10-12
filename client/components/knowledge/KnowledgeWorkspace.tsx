import { useState } from "react";
import { Search, Lightbulb, Plus } from "lucide-react";
import { normalizedConceptName } from "../../../shared/knowledge";
import { statuses } from "../../../shared/types";
import type { KnowledgeController } from "../../knowledge";
import { ConceptEditor, ConceptDetail } from "./KnowledgeConcept";
import { KnowledgeStatus } from "./KnowledgeForms";
import { KnowledgeRecords } from "./KnowledgeRecords";

export type KnowledgeTab = "concepts" | "decisions" | "questions";
export function KnowledgeWorkspace({
  controller,
  selectedId,
  onSelectConcept,
  onNavigateChapter,
  tab,
  onTab,
}: {
  controller: KnowledgeController;
  selectedId?: string;
  onSelectConcept: (id: string) => void;
  onNavigateChapter: (id: string) => void;
  tab: KnowledgeTab;
  onTab: (tab: KnowledgeTab) => void;
}) {
  const [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [maturity, setMaturity] = useState(""),
    [historical, setHistorical] = useState(false),
    [create, setCreate] = useState(false);
  const data = controller.data,
    selected = data?.concepts.find((c) => c.id === selectedId);
  const concepts =
    data?.concepts.filter(
      (c) =>
        (historical || !c.archivedAt) &&
        (!category || c.category === category) &&
        (!maturity || c.status === maturity) &&
        c.normalizedName.includes(normalizedConceptName(search)),
    ) ?? [];
  return (
    <div
      className="knowledge-workspace"
      aria-label="Design Knowledge workspace"
      aria-busy={controller.loading}
    >
      <header className="knowledge-workspace-top">
        <div>
          <Lightbulb size={20} />
          <p>
            A shared vocabulary for your game.
            <span>
              Explore its subjects, connections and deliberate choices.
            </span>
          </p>
        </div>
        <button
          className="primary"
          disabled={!data || controller.loading}
          onClick={() => setCreate(true)}
        >
          <Plus size={15} />
          New concept
        </button>
      </header>
      {controller.error && (
        <div className="inline-error" role="alert">
          {controller.error}
          <button onClick={() => void controller.reload().catch(() => {})}>
            Reload Design Knowledge
          </button>
        </div>
      )}
      <div
        className="knowledge-tabs"
        role="tablist"
        aria-label="Design Knowledge views"
      >
        {(["concepts", "decisions", "questions"] as const).map((view) => (
          <button
            role="tab"
            aria-selected={tab === view}
            key={view}
            onClick={() => onTab(view)}
          >
            {view === "concepts"
              ? "Concepts"
              : view === "decisions"
                ? "Decisions"
                : "Questions"}
            <span>
              {view === "concepts"
                ? (data?.concepts.filter((c) => !c.archivedAt).length ?? 0)
                : view === "decisions"
                  ? (data?.records.filter((r) => r.authoritative).length ?? 0)
                  : (data?.records.filter(
                      (r) => r.kind === "question" && r.status === "open",
                    ).length ?? 0)}
            </span>
          </button>
        ))}
      </div>
      {!data ? (
        <div className="knowledge-empty" role="status">
          {controller.error
            ? "Knowledge is unavailable until the project can be refreshed."
            : "Opening Design Knowledge…"}
        </div>
      ) : tab === "concepts" ? (
        <div className="knowledge-layout">
          <section
            className="knowledge-concept-list"
            aria-label="Design concepts"
          >
            <div className="knowledge-filters">
              <label className="knowledge-search">
                <Search size={14} />
                <input
                  aria-label="Search concepts"
                  placeholder="Search concepts…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <div>
                <label>
                  Category
                  <select
                    aria-label="Filter concept category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    <option value="">All categories</option>
                    {Array.from(new Set(data.concepts.map((c) => c.category)))
                      .sort()
                      .map((category) => (
                        <option key={category}>{category}</option>
                      ))}
                  </select>
                </label>
                <label>
                  Maturity
                  <select
                    aria-label="Filter concept maturity"
                    value={maturity}
                    onChange={(e) => setMaturity(e.target.value)}
                  >
                    <option value="">All maturity</option>
                    {statuses.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="knowledge-check">
                <input
                  type="checkbox"
                  checked={historical}
                  onChange={(e) => setHistorical(e.target.checked)}
                />{" "}
                Include archived concepts
              </label>
            </div>
            {!concepts.length && (
              <div className="knowledge-empty small">
                <Lightbulb size={25} />
                <h3>
                  {data.concepts.length
                    ? "No matching concepts"
                    : "Give an idea a name"}
                </h3>
                <p>
                  {data.concepts.length
                    ? "Try another search, category or maturity."
                    : "Start with a meaningful subject, such as movement, inventory or the world. Refine it as the design grows."}
                </p>
                <button
                  className="quiet-button"
                  onClick={() => setCreate(true)}
                >
                  Create a concept
                </button>
              </div>
            )}
            {concepts.map((c) => (
              <button
                className={`knowledge-concept-card ${selectedId === c.id ? "selected" : ""}`}
                aria-label={`Open concept ${c.name}`}
                aria-current={selectedId === c.id ? "true" : undefined}
                key={c.id}
                onClick={() => onSelectConcept(c.id)}
              >
                <div>
                  <strong>{c.name}</strong>
                  <KnowledgeStatus
                    label={c.archivedAt ? "Archived" : c.status}
                    reviewed={c.authoritative}
                    historical={Boolean(c.archivedAt)}
                  />
                </div>
                <small>
                  {c.category} · {c.chapterIds.length} linked chapter
                  {c.chapterIds.length === 1 ? "" : "s"}
                </small>
                <p>{c.description || "Ready to explore."}</p>
              </button>
            ))}
          </section>
          <div className="knowledge-detail-pane">
            {selected ? (
              <ConceptDetail
                key={selected.id}
                concept={selected}
                controller={controller}
                onSelectConcept={onSelectConcept}
                onNavigateChapter={onNavigateChapter}
              />
            ) : (
              <div className="knowledge-empty">
                <Lightbulb size={32} />
                <h2>Your design, connected</h2>
                <p>
                  Select a concept to explore its chapters, decisions and
                  relationships.
                </p>
                <p>
                  New concepts are exploratory. Approval is a deliberate step.
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="knowledge-record-workspace">
          {tab === "decisions" && (
            <label className="knowledge-check">
              <input
                type="checkbox"
                checked={historical}
                onChange={(e) => setHistorical(e.target.checked)}
              />{" "}
              Include superseded decisions
            </label>
          )}
          <KnowledgeRecords
            focusId={selectedId}
            controller={controller}
            kind={tab === "decisions" ? "decision" : "question"}
            includeHistorical={historical}
            onSelectConcept={onSelectConcept}
            onNavigateChapter={onNavigateChapter}
          />
        </div>
      )}
      {create && (
        <ConceptEditor
          controller={controller}
          onClose={() => setCreate(false)}
          onCreated={(concept) => {
            onTab("concepts");
            onSelectConcept(concept.id);
          }}
        />
      )}
    </div>
  );
}
