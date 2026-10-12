import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Plus,
  Lightbulb,
} from "lucide-react";
import type { Chapter, Project } from "../../shared/types";
import { chapterOutline, isDescendant } from "../../shared/chapter-tree";

const preferenceKey = "forge.project-navigation";
interface NavigationState {
  closedProjects: string[];
  closedBooks: string[];
  closedChapters: string[];
}
function readPreferences(): NavigationState {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) ?? "null");
    if (
      value &&
      Array.isArray(value.closedProjects) &&
      Array.isArray(value.closedBooks) &&
      Array.isArray(value.closedChapters)
    )
      return {
        closedProjects: value.closedProjects.filter(
          (id: unknown) => typeof id === "string",
        ),
        closedBooks: value.closedBooks.filter(
          (id: unknown) => typeof id === "string",
        ),
        closedChapters: value.closedChapters.filter(
          (id: unknown) => typeof id === "string",
        ),
      };
  } catch {
    /* Navigation also works when local storage is unavailable. */
  }
  return { closedProjects: [], closedBooks: [], closedChapters: [] };
}
const toggleId = (ids: string[], id: string) =>
  ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];

export function DesignBookNav({
  projects,
  projectId,
  chapters,
  activeId,
  onOpenProject,
  onOpenChapter,
  onAddChapter,
  onReorder,
  projectView,
  onOpenBook,
  onOpenKnowledge,
}: {
  projects: Project[];
  projectId?: string;
  chapters: Chapter[];
  activeId?: string;
  onOpenProject: (project: Project) => Promise<void>;
  onOpenChapter: (id: string) => Promise<void>;
  onAddChapter: () => void;
  onReorder: (id: string, direction: number) => Promise<void>;
  projectView: "book" | "knowledge";
  onOpenBook: () => void;
  onOpenKnowledge: () => void;
}) {
  const [navigation, setNavigation] = useState(readPreferences);
  useEffect(() => {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(navigation));
    } catch {
      /* Keep session-only preferences. */
    }
  }, [navigation]);
  // Reveal an item selected via search or a different view, without preventing
  // the user from collapsing the branch containing the currently open editor.
  useEffect(() => {
    if (!activeId || !projectId) return;
    setNavigation((current) => ({
      ...current,
      closedProjects: current.closedProjects.filter((id) => id !== projectId),
      closedBooks: current.closedBooks.filter((id) => id !== projectId),
      closedChapters: current.closedChapters.filter(
        (id) => !isDescendant(chapters, activeId, id),
      ),
    }));
  }, [activeId, projectId]);
  const outline = chapterOutline(chapters);
  const openBook = async (project: Project) => {
    await onOpenProject(project);
    setNavigation((current) => ({
      ...current,
      closedProjects: current.closedProjects.filter((id) => id !== project.id),
      closedBooks: current.closedBooks.filter((id) => id !== project.id),
    }));
  };
  return (
    <nav aria-label="Project navigation" className="design-book-nav">
      <div className="project-list">
        {projects.map((project) => {
          const selected = project.id === projectId,
            expanded =
              selected && !navigation.closedProjects.includes(project.id),
            bookExpanded = !navigation.closedBooks.includes(project.id);
          return (
            <div key={project.id} className="book-branch">
              <div className="book-row">
                <button
                  className="nav-disclosure"
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${project.title} project`}
                  aria-expanded={expanded}
                  aria-controls={
                    selected ? `project-features-${project.id}` : undefined
                  }
                  onClick={() => {
                    if (!selected) void openBook(project);
                    else
                      setNavigation((current) => ({
                        ...current,
                        closedProjects: toggleId(
                          current.closedProjects,
                          project.id,
                        ),
                      }));
                  }}
                >
                  {expanded ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                </button>
                <button
                  className={`project-nav ${selected ? "current" : ""}`}
                  onClick={() => void openBook(project)}
                  title={project.title}
                >
                  <span className="project-initial">
                    {project.title.charAt(0).toUpperCase()}
                  </span>
                  <span>{project.title}</span>
                </button>
              </div>
              {selected && (
                <div
                  id={`project-features-${project.id}`}
                  className="book-list"
                  hidden={!expanded}
                >
                  <div className="book-row">
                    <button
                      className="nav-disclosure"
                      aria-label={`${bookExpanded ? "Collapse" : "Expand"} ${project.title} Design Book`}
                      aria-expanded={bookExpanded}
                      aria-controls={`book-chapters-${project.id}`}
                      onClick={() =>
                        setNavigation((current) => ({
                          ...current,
                          closedBooks: toggleId(
                            current.closedBooks,
                            project.id,
                          ),
                        }))
                      }
                    >
                      {bookExpanded ? (
                        <ChevronDown size={13} />
                      ) : (
                        <ChevronRight size={13} />
                      )}
                    </button>
                    <button
                      className={`feature-nav ${projectView === "book" ? "selected" : ""}`}
                      onClick={onOpenBook}
                    >
                      <BookOpen size={15} />
                      <span>Design Book</span>
                    </button>
                    <button
                      className="nav-add icon-button"
                      aria-label={`Add chapter to ${project.title}`}
                      onClick={onAddChapter}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <div
                    id={`book-chapters-${project.id}`}
                    className="chapter-list"
                    hidden={!bookExpanded}
                  >
                    {outline
                      .filter(
                        ({ chapter }) =>
                          !navigation.closedChapters.some((id) =>
                            isDescendant(chapters, chapter.id, id),
                          ),
                      )
                      .map(({ chapter, depth, number }) => {
                        const hasChildren = chapters.some(
                            (child) => child.parentId === chapter.id,
                          ),
                          closed = navigation.closedChapters.includes(
                            chapter.id,
                          );
                        const siblings = chapters.filter(
                            (sibling) => sibling.parentId === chapter.parentId,
                          ),
                          index = siblings.findIndex(
                            (sibling) => sibling.id === chapter.id,
                          );
                        return (
                          <div
                            key={chapter.id}
                            className={`chapter-nav-row ${depth ? "subchapter" : ""} ${projectView === "book" && activeId === chapter.id ? "selected" : ""}`}
                            style={{ marginLeft: depth * 12 }}
                          >
                            {hasChildren ? (
                              <button
                                className="nav-disclosure"
                                aria-label={`${closed ? "Expand" : "Collapse"} ${chapter.title} sub-chapters`}
                                aria-expanded={!closed}
                                onClick={() =>
                                  setNavigation((current) => ({
                                    ...current,
                                    closedChapters: toggleId(
                                      current.closedChapters,
                                      chapter.id,
                                    ),
                                  }))
                                }
                              >
                                {closed ? (
                                  <ChevronRight size={12} />
                                ) : (
                                  <ChevronDown size={12} />
                                )}
                              </button>
                            ) : (
                              <span className="nav-disclosure-spacer" />
                            )}
                            <button
                              className="chapter-nav"
                              aria-current={
                                projectView === "book" &&
                                activeId === chapter.id
                                  ? "page"
                                  : undefined
                              }
                              onClick={() => void onOpenChapter(chapter.id)}
                              title={`${number} ${chapter.title}`}
                            >
                              <span className="chapter-number">{number}</span>
                              <span>{chapter.title}</span>
                              <span
                                className={`chapter-status-dot ${chapter.status === "Approved" ? "green" : ""}`}
                                title={chapter.status}
                              />
                            </button>
                            <div className="reorder-controls">
                              <button
                                aria-label={`Move ${chapter.title} up`}
                                disabled={index === 0}
                                onClick={() => void onReorder(chapter.id, -1)}
                              >
                                <ArrowUp size={11} />
                              </button>
                              <button
                                aria-label={`Move ${chapter.title} down`}
                                disabled={index === siblings.length - 1}
                                onClick={() => void onReorder(chapter.id, 1)}
                              >
                                <ArrowDown size={11} />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    {!chapters.length && (
                      <button className="add-chapter" onClick={onAddChapter}>
                        <Plus size={13} />
                        Add chapter
                      </button>
                    )}
                  </div>
                  <button
                    className={`feature-nav knowledge-feature ${projectView === "knowledge" ? "selected" : ""}`}
                    onClick={onOpenKnowledge}
                  >
                    <Lightbulb size={15} />
                    <span>Design Knowledge</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {!projects.length && (
          <p className="sidebar-empty">
            Create a project to start your first Design Book.
          </p>
        )}
      </div>
    </nav>
  );
}
