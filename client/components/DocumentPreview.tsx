import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { documentExtensions, validDocument } from "../../shared/document";
import type { Doc } from "../../shared/types";

// Render saved JSON directly. Never parse Markdown or save from a history view.
export function DocumentPreview({ content }: { content: Doc }) {
  const supported = Boolean(validDocument(content));
  if (!supported) {
    const empty =
      content?.type === "doc" &&
      !content.content?.length &&
      Object.keys(content).every((key) => key === "type" || key === "content");
    return (
      <div className="history-document history-document-source">
        {empty ? (
          <p className="muted">This saved document is empty.</p>
        ) : (
          <>
            <p role="alert" className="inline-error">
              This saved document has unsupported or invalid structure and
              cannot be rendered faithfully. Its original representation is
              retained without conversion.
            </p>
            <details>
              <summary>Inspect original stored representation</summary>
              <pre>{JSON.stringify(content, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
    );
  }
  return <RenderedDocument content={content} />;
}
function RenderedDocument({ content }: { content: Doc }) {
  const editor = useEditor({
    editable: false,
    extensions: documentExtensions(),
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
