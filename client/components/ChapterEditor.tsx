import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Quote,
  Link,
  Heading2,
  Undo2,
  Redo2,
  Check,
  Loader2,
  Save,
  ChevronDown,
} from "lucide-react";
import {
  statuses,
  type Chapter,
  type Doc,
  type Maturity,
} from "../../shared/types";
import { api } from "../api";
import { Modal } from "./Modal";

export interface EditorHandle {
  flush: () => Promise<boolean>;
}
export const ChapterEditor = forwardRef<
  EditorHandle,
  {
    chapter: Chapter;
    onSaved: (chapter: Chapter) => void;
    onState: (state: string) => void;
  }
>(({ chapter, onSaved, onState }, ref) => {
  const [title, setTitle] = useState(chapter.title),
    [status, setStatus] = useState(chapter.status);
  const [saveState, setSaveState] = useState("Saved locally"),
    [error, setError] = useState(""),
    [linkOpen, setLinkOpen] = useState(false),
    [link, setLink] = useState("");
  const revision = useRef(chapter.revision),
    dirty = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const draft = useRef({
    title: chapter.title,
    status: chapter.status,
    content: chapter.content,
  });
  const callbacks = useRef({ onSaved, onState });
  callbacks.current = { onSaved, onState };
  const state = (s: string) => {
    setSaveState(s);
    callbacks.current.onState(s);
  };
  const save = useCallback(() => {
    clearTimeout(timer.current);
    queue.current = queue.current.then(async () => {
      if (!dirty.current) return true;
      const snapshot = { ...draft.current };
      dirty.current = false;
      state("Saving…");
      try {
        const updated = await api<Chapter>(`/chapters/${chapter.id}`, "PATCH", {
          ...snapshot,
          title: snapshot.title.trim() || "Untitled chapter",
          revision: revision.current,
        });
        revision.current = updated.revision;
        callbacks.current.onSaved(updated);
        setError("");
        if (!dirty.current) {
          setTitle(updated.title);
          draft.current.title = updated.title;
          state("Saved locally");
        }
        return true;
      } catch (e) {
        dirty.current = true;
        setError((e as Error).message);
        state("Not saved");
        return false;
      }
    });
    return queue.current;
  }, [chapter.id]);
  const changed = () => {
    dirty.current = true;
    state("Unsaved changes");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 900);
  };
  const editor = useEditor({
    shouldRerenderOnTransaction: true,
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          HTMLAttributes: { rel: "noopener noreferrer" },
        },
      }),
      Placeholder.configure({
        placeholder:
          "What should this chapter help you understand? Start writing…",
      }),
    ],
    content: chapter.content,
    editorProps: {
      attributes: {
        "aria-label": "Chapter content",
        role: "textbox",
        "aria-multiline": "true",
        spellcheck: "true",
      },
    },
    onUpdate: ({ editor }) => {
      draft.current.content = editor.getJSON() as Doc;
      changed();
    },
  });
  useImperativeHandle(
    ref,
    () => ({
      flush: async () => {
        const ok = await save();
        return ok && (!dirty.current || (await save()));
      },
    }),
    [save],
  );
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current || saveState === "Saving…") event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [saveState]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);
  if (!editor) return null;
  const reloadSaved = async () => {
    if (
      !window.confirm(
        "Discard the edits in this editor and reopen the saved chapter?",
      )
    )
      return;
    clearTimeout(timer.current);
    try {
      const c = await api<Chapter>(`/chapters/${chapter.id}`);
      editor.commands.setContent(c.content, { emitUpdate: false });
      draft.current = { title: c.title, content: c.content, status: c.status };
      revision.current = c.revision;
      dirty.current = false;
      setTitle(c.title);
      setStatus(c.status);
      setError("");
      callbacks.current.onSaved(c);
      state("Saved locally");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const tools = [
    {
      icon: Heading2,
      label: "Heading",
      active: editor.isActive("heading", { level: 2 }),
      action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      icon: Bold,
      label: "Bold",
      active: editor.isActive("bold"),
      action: () => editor.chain().focus().toggleBold().run(),
    },
    {
      icon: Italic,
      label: "Italic",
      active: editor.isActive("italic"),
      action: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      icon: List,
      label: "Bullet list",
      active: editor.isActive("bulletList"),
      action: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      icon: ListOrdered,
      label: "Numbered list",
      active: editor.isActive("orderedList"),
      action: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      icon: Quote,
      label: "Quote",
      active: editor.isActive("blockquote"),
      action: () => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      icon: Link,
      label: "Link",
      active: editor.isActive("link"),
      action: () => {
        setLink(editor.getAttributes("link").href || "");
        setLinkOpen(true);
      },
    },
  ];
  const words = editor.getText().trim().split(/\s+/).filter(Boolean).length;
  return (
    <>
      <div className="document-tools">
        <div
          className="format-tools"
          role="toolbar"
          aria-label="Text formatting"
        >
          {tools.map((t) => (
            <button
              key={t.label}
              className={`icon-button ${t.active ? "selected" : ""}`}
              title={t.label}
              aria-label={t.label}
              aria-pressed={t.active}
              onClick={t.action}
            >
              <t.icon size={16} />
            </button>
          ))}
          <span className="tool-divider" />
          <button
            className="icon-button"
            aria-label="Undo"
            disabled={!editor.can().undo()}
            onClick={() => editor.chain().focus().undo().run()}
          >
            <Undo2 size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Redo"
            disabled={!editor.can().redo()}
            onClick={() => editor.chain().focus().redo().run()}
          >
            <Redo2 size={16} />
          </button>
        </div>
        <button
          className="quiet-button save-button"
          onClick={() => void save()}
        >
          {saveState === "Saving…" ? (
            <Loader2 size={14} className="spin" />
          ) : saveState === "Saved locally" ? (
            <Check size={14} />
          ) : (
            <Save size={14} />
          )}
          <span>{saveState}</span>
        </button>
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error} Your edits remain in this editor.{" "}
          <button onClick={() => void save()}>Retry save</button>
          <button onClick={() => void reloadSaved()}>
            Reload saved chapter
          </button>
        </div>
      )}
      <div className="page-scroll">
        <article className="reading-page">
          <div className="chapter-meta">
            <span className="eyebrow">
              CHAPTER {String(chapter.position + 1).padStart(2, "0")}
            </span>
            <label
              className={`status-select ${status.toLowerCase().replaceAll(" ", "-")}`}
            >
              <span className="status-dot" />
              <select
                aria-label="Chapter maturity"
                value={status}
                onChange={(e) => {
                  const s = e.target.value as Maturity;
                  setStatus(s);
                  draft.current.status = s;
                  changed();
                }}
              >
                {statuses.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
          </div>
          <input
            className="chapter-title"
            aria-label="Chapter title"
            maxLength={120}
            value={title}
            placeholder="Untitled chapter"
            onChange={(e) => {
              setTitle(e.target.value);
              draft.current.title = e.target.value;
              changed();
            }}
          />
          <div className="page-rule" />
          <EditorContent editor={editor} />
          <footer className="page-footer">
            <span>
              {words} {words === 1 ? "word" : "words"}
            </span>
            <span>A living design. Room to evolve.</span>
          </footer>
        </article>
        <div className="reading-note">
          Design maturity reflects your creative decisions, independently of
          implementation.
        </div>
      </div>
      {linkOpen && (
        <Modal title="Add a link" onClose={() => setLinkOpen(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (link)
                editor
                  .chain()
                  .focus()
                  .extendMarkRange("link")
                  .setLink({ href: link })
                  .run();
              else editor.chain().focus().unsetLink().run();
              setLinkOpen(false);
            }}
          >
            <label>
              URL
              <input
                type="url"
                placeholder="https://…"
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
            </label>
            <p className="muted">Leave empty to remove the selected link.</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setLinkOpen(false)}>
                Cancel
              </button>
              <button className="primary" type="submit">
                Apply link
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
});
