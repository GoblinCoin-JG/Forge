import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { Doc } from "../../shared/types";

// Render saved JSON directly. Never parse Markdown or save from a history view.
export function DocumentPreview({ content }: { content: Doc }) {
  const editor = useEditor({
    editable: false,
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          HTMLAttributes: { rel: "noopener noreferrer" },
        },
      }),
    ],
    content,
    editorProps: { attributes: { "aria-label": "Saved chapter content" } },
  });
  useEffect(() => {
    editor?.commands.setContent(content, { emitUpdate: false });
  }, [editor, content]);
  return (
    <div className="history-document">
      <EditorContent editor={editor} />
    </div>
  );
}
