import { useEffect, useRef, useState } from "react";
import {
  Anvil,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FolderOpen,
  Home,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  X,
  PanelRightOpen,
  Feather,
  ArrowUpRight,
  Loader2,
} from "lucide-react";
import { type Chapter, type Project } from "../shared/types";
import { api } from "./api";
import { Modal } from "./components/Modal";
import { ChapterEditor, type EditorHandle } from "./components/ChapterEditor";
import { Workshop } from "./components/Workshop";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState<Project>(),
    [chapters, setChapters] = useState<Chapter[]>([]),
    [activeId, setActiveId] = useState<string>();
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [online, setOnline] = useState(false),
    [configured, setConfigured] = useState(false),
    [workshop, setWorkshop] = useState(true),
    [mobileNav, setMobileNav] = useState(false),
    [saved, setSaved] = useState("Saved locally"),
    [editorGeneration, setEditorGeneration] = useState(0);
  const [modal, setModal] = useState<
      | "new-project"
      | "edit-project"
      | "new-chapter"
      | "delete-chapter"
      | "settings"
      | "search"
      | null
    >(null),
    [title, setTitle] = useState(""),
    [premise, setPremise] = useState(""),
    [search, setSearch] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const active = chapters.find((c) => c.id === activeId);
  const loadProjects = async () => {
    const p = await api<Project[]>("/projects");
    setProjects(p);
    return p;
  };
  useEffect(() => {
    Promise.all([loadProjects(), api<{ aiConfigured: boolean }>("/health")])
      .then(([, health]) => {
        setConfigured(health.aiConfigured);
        setOnline(true);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setSearch("");
        setModal("search");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const flush = async () =>
    editor.current ? await editor.current.flush() : true;
  const home = async () => {
    if (!(await flush())) return;
    setProject(undefined);
    setActiveId(undefined);
    setMobileNav(false);
    await loadProjects();
  };
  const openProject = async (p: Project) => {
    if (!(await flush())) return;
    try {
      const list = await api<Chapter[]>(`/projects/${p.id}/chapters`);
      setProject(p);
      setChapters(list);
      setEditorGeneration((g) => g + 1);
      setActiveId(list[0]?.id);
      setError("");
      setMobileNav(false);
      setSaved("Saved locally");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const openChapter = async (id: string) => {
    if (!(await flush())) return;
    setActiveId(id);
    setSaved("Saved locally");
    setMobileNav(false);
  };
  const openModal = (name: typeof modal) => {
    setTitle(name === "edit-project" ? project?.title || "" : "");
    setPremise(name === "edit-project" ? project?.premise || "" : "");
    setModal(name);
    setError("");
  };
  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      if (!(await flush()))
        throw new Error("Save the current chapter before continuing.");
      if (modal === "new-project") {
        const p = await api<Project>("/projects", "POST", { title, premise });
        await loadProjects();
        await openProject(p);
      }
      if (modal === "edit-project" && project) {
        const p = await api<Project>(`/projects/${project.id}`, "PATCH", {
          title,
          premise,
        });
        setProject(p);
        await loadProjects();
      }
      if (modal === "new-chapter" && project) {
        const c = await api<Chapter>(
          `/projects/${project.id}/chapters`,
          "POST",
          { title },
        );
        setChapters((cs) => [...cs, c]);
        setActiveId(c.id);
        await loadProjects();
      }
      if (modal === "delete-chapter" && active && project) {
        await api(`/chapters/${active.id}`, "DELETE");
        const list = await api<Chapter[]>(`/projects/${project.id}/chapters`);
        setChapters(list);
        setActiveId(list[0]?.id);
        await loadProjects();
      }
      setModal(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const reorder = async (index: number, direction: number) => {
    if (
      !project ||
      index + direction < 0 ||
      index + direction >= chapters.length
    )
      return;
    const ids = chapters.map((c) => c.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    try {
      setChapters(
        await api<Chapter[]>(`/projects/${project.id}/order`, "PUT", { ids }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const refreshAfterReview = async () => {
    if (!project) return;
    setChapters(await api<Chapter[]>(`/projects/${project.id}/chapters`));
    setEditorGeneration((g) => g + 1);
    await loadProjects();
  };
  const onSaved = (c: Chapter) => {
    setChapters((cs) => cs.map((old) => (old.id === c.id ? c : old)));
  };
  const filteredProjects = projects.filter((p) =>
    p.title.toLowerCase().includes(search.toLowerCase()),
  );
  const filteredChapters = chapters.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          className="brand"
          onClick={() => void home()}
          aria-label="Forge project home"
        >
          <Anvil size={23} />
          <span>FORGE</span>
          <span className="brand-divider" />
          <span className="brand-subtitle">Game development studio</span>
        </button>
        <button
          className="command-search"
          onClick={() => {
            setSearch("");
            setModal("search");
          }}
        >
          <Search size={14} />
          <span>Find a project or chapter…</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="local-indicator">
          <span className={`tiny-dot ${online ? "green" : ""}`} />
          <span>{online ? "Local workspace" : "Connecting…"}</span>
        </div>
      </header>
      <div className="shell-body">
        <nav className="activity-rail" aria-label="Workspace">
          <button
            aria-label="Project home"
            className={!project ? "active" : ""}
            onClick={() => void home()}
          >
            <Home size={20} />
          </button>
          <button
            aria-label="Design Book"
            className={project ? "active" : ""}
            disabled={!project}
            onClick={() => setMobileNav((v) => !v)}
          >
            <BookOpen size={20} />
          </button>
          <div className="rail-spacer" />
          <button aria-label="Settings" onClick={() => setModal("settings")}>
            <Settings2 size={19} />
          </button>
          <div className="director-avatar" title="Local director">
            D
          </div>
        </nav>
        <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
          <div className="sidebar-heading">
            <span className="eyebrow">WORKSPACE</span>
            <button
              className="icon-button"
              aria-label="Create project"
              onClick={() => openModal("new-project")}
            >
              <Plus size={16} />
            </button>
            <button
              className="icon-button mobile-only"
              aria-label="Close navigation"
              onClick={() => setMobileNav(false)}
            >
              <X size={16} />
            </button>
          </div>
          <button
            className={`sidebar-home ${!project ? "selected" : ""}`}
            onClick={() => void home()}
          >
            <FolderOpen size={16} />
            Projects<span>{projects.length}</span>
          </button>
          <div className="sidebar-projects">
            <div className="eyebrow sidebar-label">YOUR PROJECTS</div>
            {projects.map((p) => (
              <div key={p.id}>
                <button
                  className={`project-nav ${p.id === project?.id ? "current" : ""}`}
                  onClick={() => void openProject(p)}
                >
                  {p.id === project?.id ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                  <span className="project-initial">
                    {p.title.charAt(0).toUpperCase()}
                  </span>
                  <span>{p.title}</span>
                </button>
                {p.id === project?.id && (
                  <>
                    <div className="book-nav">
                      <BookOpen size={14} />
                      <span>Design Book</span>
                      <button
                        className="icon-button"
                        aria-label="Add chapter"
                        onClick={() => openModal("new-chapter")}
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    <div className="chapter-list">
                      {chapters.map((c, i) => (
                        <div
                          className={`chapter-nav-row ${activeId === c.id ? "selected" : ""}`}
                          key={c.id}
                        >
                          <button
                            className="chapter-nav"
                            onClick={() => void openChapter(c.id)}
                          >
                            <span className="chapter-number">
                              {String(i + 1).padStart(2, "0")}
                            </span>
                            <span>{c.title}</span>
                            <span
                              className={`chapter-status-dot ${c.status === "Approved" ? "green" : ""}`}
                              title={c.status}
                            />
                          </button>
                          <div className="reorder-controls">
                            <button
                              aria-label={`Move ${c.title} up`}
                              disabled={i === 0}
                              onClick={() => void reorder(i, -1)}
                            >
                              <ArrowUp size={11} />
                            </button>
                            <button
                              aria-label={`Move ${c.title} down`}
                              disabled={i === chapters.length - 1}
                              onClick={() => void reorder(i, 1)}
                            >
                              <ArrowDown size={11} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button
                      className="add-chapter"
                      onClick={() => openModal("new-chapter")}
                    >
                      <Plus size={13} />
                      Add chapter
                    </button>
                  </>
                )}
              </div>
            ))}
            {!projects.length && (
              <p className="sidebar-empty">
                Your games will find
                <br />a home here.
              </p>
            )}
          </div>
          <div className="sidebar-bottom">
            <span className="tiny-dot green" />
            <div>
              <strong>Made for your ideas.</strong>
              <p>Saved on your computer.</p>
            </div>
          </div>
        </aside>
        <main className="main-workspace">
          <div className="workspace-tab">
            <button
              className="mobile-only icon-button"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={18} />
            </button>
            <span>
              {project ? <BookOpen size={14} /> : <FolderOpen size={14} />}
            </span>
            <span>{project ? "Design Book" : "Projects"}</span>
            <span className="tab-dot" />
          </div>
          {error && !modal && (
            <div className="global-error" role="alert">
              {error}
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {project ? (
            <>
              <div className="book-heading">
                <div>
                  <div className="breadcrumb">
                    <button onClick={() => void home()}>Projects</button>
                    <ChevronRight size={12} />
                    <span>{project.title}</span>
                  </div>
                  <h1>
                    Design Book
                    <span className="book-heading-note">
                      A living record of your game.
                    </span>
                  </h1>
                </div>
                <div className="book-actions">
                  <button
                    className="quiet-button"
                    onClick={() => openModal("edit-project")}
                  >
                    <MoreHorizontal size={18} />
                    <span>Project details</span>
                  </button>
                  {!workshop && (
                    <button
                      className="quiet-button amber"
                      onClick={() => setWorkshop(true)}
                    >
                      <PanelRightOpen size={16} />
                      Workshop
                    </button>
                  )}
                </div>
              </div>
              <div
                className={`book-workspace ${!workshop ? "workshop-hidden" : ""}`}
              >
                <section className="document-pane">
                  {active ? (
                    <>
                      <div className="document-context">
                        <div>
                          <Feather size={14} />
                          <span>{active.title}</span>
                        </div>
                        <button
                          className="icon-button"
                          aria-label="Delete chapter"
                          onClick={() => openModal("delete-chapter")}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <ChapterEditor
                        key={`${active.id}-${editorGeneration}`}
                        ref={editor}
                        chapter={active}
                        onSaved={onSaved}
                        onState={setSaved}
                      />
                    </>
                  ) : (
                    <div className="blank-book">
                      <BookOpen size={35} />
                      <h2>A new chapter awaits.</h2>
                      <p>
                        Add a chapter to continue shaping your game's design.
                      </p>
                      <button
                        className="primary"
                        onClick={() => openModal("new-chapter")}
                      >
                        <Plus size={15} />
                        Add chapter
                      </button>
                    </div>
                  )}
                </section>
                {workshop && active && (
                  <Workshop
                    key={active.id}
                    chapter={active}
                    chapters={chapters}
                    configured={configured}
                    flush={flush}
                    onReviewed={refreshAfterReview}
                    onSetup={() => setModal("settings")}
                    onClose={() => setWorkshop(false)}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="home-scroll">
              <div className="home-content">
                <div className="home-breadcrumb">
                  <span className="eyebrow">YOUR CREATIVE WORKSPACE</span>
                  <span>FORGE / 01</span>
                </div>
                <section className="home-hero">
                  <div className="hero-copy">
                    <div className="hero-eyebrow">
                      <span className="tiny-dot" />
                      FROM THE FIRST SPARK
                    </div>
                    <h1>
                      Give your game a place
                      <br />
                      to take shape.
                    </h1>
                    <p>
                      A space to explore the possibilities, capture your vision,
                      <br className="desktop-break" /> and build a design that
                      grows with your game.
                    </p>
                    <button
                      className="primary"
                      disabled={!online}
                      onClick={() => openModal("new-project")}
                    >
                      <Plus size={16} />
                      Create a game project
                      <ArrowRight size={16} />
                    </button>
                    <span className="hero-footnote">
                      Start with a rough idea. Or a blank page.
                    </span>
                  </div>
                  <div className="book-illustration" aria-hidden="true">
                    <div className="illustration-orbit" />
                    <div className="illustration-book">
                      <div className="book-spine" />
                      <div className="illustration-cover">
                        <span className="eyebrow">THE DESIGN BOOK</span>
                        <Anvil size={42} strokeWidth={1} />
                        <div className="cover-line" />
                        <span>
                          Every world begins
                          <br />
                          with an idea.
                        </span>
                        <span className="cover-number">VOL. 01</span>
                      </div>
                    </div>
                    <div className="illustration-caption">
                      <Feather size={12} />
                      Imagine. Explore. Refine.
                    </div>
                  </div>
                </section>
                <div className="project-section-heading">
                  <div>
                    <h2>
                      Your projects<span>{projects.length}</span>
                    </h2>
                    <p>Pick up where your imagination left off.</p>
                  </div>
                  <button
                    className="quiet-button"
                    disabled={!online}
                    onClick={() => openModal("new-project")}
                  >
                    <Plus size={15} />
                    New project
                  </button>
                </div>
                {loading ? (
                  <div className="empty-projects">
                    <Loader2 className="spin" size={22} />
                    <p>Opening your local workspace…</p>
                  </div>
                ) : !projects.length ? (
                  <div className="empty-projects">
                    <div className="empty-book-icon">
                      <BookOpen size={23} />
                    </div>
                    <div>
                      <h3>The first page is yours.</h3>
                      <p>
                        Create a project to start your Game Vision chapter.
                        <br />
                        No templates to fill. No plans to commit to.
                      </p>
                    </div>
                    <button
                      className="text-button"
                      disabled={!online}
                      onClick={() => openModal("new-project")}
                    >
                      Begin your first project
                      <ArrowUpRight size={16} />
                    </button>
                  </div>
                ) : (
                  <div className="project-grid">
                    {projects.map((p) => (
                      <button
                        className="project-card"
                        key={p.id}
                        onClick={() => void openProject(p)}
                      >
                        <div className="project-card-top">
                          <span className="project-monogram">
                            {p.title.charAt(0).toUpperCase()}
                          </span>
                          <ArrowUpRight size={17} />
                        </div>
                        <h3>{p.title}</h3>
                        <p>
                          {p.premise ||
                            "An open page. A world of possibilities."}
                        </p>
                        <div className="project-card-footer">
                          <span>
                            <BookOpen size={12} />
                            {p.chapterCount}{" "}
                            {p.chapterCount === 1 ? "chapter" : "chapters"}
                          </span>
                          <span>
                            {new Date(p.updatedAt).toLocaleDateString(
                              undefined,
                              { month: "short", day: "numeric" },
                            )}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <div className="home-philosophy">
                  <div>
                    <span className="philosophy-number">01</span>
                    <div>
                      <strong>Your vision, in one place.</strong>
                      <p>
                        A living book, from first idea to creative direction.
                      </p>
                    </div>
                  </div>
                  <div>
                    <span className="philosophy-number">02</span>
                    <div>
                      <strong>A partner in exploration.</strong>
                      <p>AI helps you think. You make the decisions.</p>
                    </div>
                  </div>
                  <div>
                    <span className="philosophy-number">03</span>
                    <div>
                      <strong>A workspace of your own.</strong>
                      <p>Local by design. Always yours to edit.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
      <footer className="statusbar">
        <div>
          <Anvil size={11} />
          <span>Forge</span>
          <span className="status-divider" />
          <span className="tiny-dot green" />
          {online ? "Local database connected" : "Backend unavailable"}
        </div>
        <div>
          {project && (
            <>
              <Check size={11} />
              <span aria-live="polite">{saved}</span>
              <span className="status-divider" />
            </>
          )}
          <Sparkles size={11} />
          <button onClick={() => setModal("settings")}>
            {configured ? "Workshop connected" : "AI not connected"}
          </button>
        </div>
      </footer>
      {modal && (
        <Modal
          title={
            modal === "new-project"
              ? "A new game begins here."
              : modal === "edit-project"
                ? "Project details"
                : modal === "new-chapter"
                  ? "Add a chapter"
                  : modal === "delete-chapter"
                    ? "Delete this chapter?"
                    : modal === "search"
                      ? "Find your place"
                      : "Workshop connection"
          }
          onClose={() => {
            if (!submitting) {
              setModal(null);
              setError("");
            }
          }}
        >
          {["new-project", "edit-project", "new-chapter"].includes(modal) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <p className="modal-intro">
                {modal === "new-chapter"
                  ? "Give this part of your design a name. You can change it anytime."
                  : "A working title and a spark of an idea are all you need. Both are optional."}
              </p>
              <label>
                {modal === "new-chapter" ? "Chapter title" : "Working title"}
                <input
                  autoFocus
                  maxLength={120}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={
                    modal === "new-chapter"
                      ? "e.g. Core Gameplay"
                      : "Untitled game"
                  }
                  required={modal === "new-chapter"}
                />
              </label>
              {modal !== "new-chapter" && (
                <label>
                  The idea
                  <textarea
                    rows={5}
                    value={premise}
                    maxLength={20000}
                    onChange={(e) => setPremise(e.target.value)}
                    placeholder="A premise, an experience, a world you want to explore…"
                  />
                  <span className="field-help">
                    {modal === "new-project"
                      ? "Your notes become the first words of your Game Vision chapter."
                      : "Editing these notes leaves your chapter content as you wrote it."}
                  </span>
                </label>
              )}
              {error && (
                <p className="error-text" role="alert">
                  {error}
                </p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => setModal(null)}
                >
                  Cancel
                </button>
                <button className="primary" disabled={submitting} type="submit">
                  {submitting
                    ? "Saving…"
                    : modal === "new-project"
                      ? "Create project"
                      : modal === "new-chapter"
                        ? "Add chapter"
                        : "Save details"}
                  <ArrowRight size={14} />
                </button>
              </div>
            </form>
          )}
          {modal === "delete-chapter" && (
            <>
              <p>
                “{active?.title}” and its Workshop conversation will be
                permanently deleted from this project.
              </p>
              <p className="muted">This cannot be undone.</p>
              {error && <p className="error-text">{error}</p>}
              <div className="modal-actions">
                <button disabled={submitting} onClick={() => setModal(null)}>
                  Keep chapter
                </button>
                <button
                  className="danger"
                  disabled={submitting}
                  onClick={() => void submit()}
                >
                  {submitting ? "Deleting…" : "Delete chapter"}
                </button>
              </div>
            </>
          )}
          {modal === "settings" && (
            <div className="settings-content">
              <div className="settings-status">
                <span className={`tiny-dot ${configured ? "green" : ""}`} />
                {configured
                  ? "AI Workshop is connected"
                  : "AI Workshop is not connected"}
              </div>
              <p>
                Forge reads your API key on the local backend. Your key is never
                sent to the browser or stored in project data.
              </p>
              <ol>
                <li>
                  Copy <code>.env.example</code> to <code>.env</code> in the
                  Forge folder.
                </li>
                <li>
                  Add your key as <code>OPENAI_API_KEY=your-key</code>.
                </li>
                <li>Restart Forge, then reload this page.</li>
              </ol>
              <p className="muted">
                Optional model setting: <code>OPENAI_MODEL=gpt-4.1-mini</code>.
                All manual editing works without a connection.
              </p>
              <div className="settings-note">
                <BookOpen size={18} />
                <span>
                  Projects and chapters are saved in your local SQLite database.
                </span>
              </div>
              <div className="modal-actions">
                <button className="primary" onClick={() => setModal(null)}>
                  Done
                </button>
              </div>
            </div>
          )}
          {modal === "search" && (
            <div className="search-dialog">
              <div className="search-field">
                <Search size={17} />
                <input
                  autoFocus
                  aria-label="Search projects and chapters"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search projects and chapters…"
                />
              </div>
              <span className="eyebrow">PROJECTS</span>
              {filteredProjects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setModal(null);
                    void openProject(p);
                  }}
                >
                  <FolderOpen size={15} />
                  {p.title}
                  <ArrowRight size={14} />
                </button>
              ))}
              {project && (
                <>
                  <span className="eyebrow">
                    CHAPTERS IN {project.title.toUpperCase()}
                  </span>
                  {filteredChapters.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setModal(null);
                        void openChapter(c.id);
                      }}
                    >
                      <BookOpen size={15} />
                      {c.title}
                      <ArrowRight size={14} />
                    </button>
                  ))}
                </>
              )}
              {!filteredProjects.length && !filteredChapters.length && (
                <p className="muted">No matches. Try another name.</p>
              )}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
