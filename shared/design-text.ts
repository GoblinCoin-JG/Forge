import type { Doc } from "./types.js";

type Node = Record<string, unknown>;

// Convert the design text conventions into editor nodes, never HTML.
// Also tolerate AI headings like ##Gameplay Direction without a space.
function inline(text: string): Node[] {
  const nodes: Node[] = [];
  const pattern = /`([^`]+)`|(\*\*|__)(\S(?:.*?\S)?)\2/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    if (index > start)
      nodes.push({ type: "text", text: text.slice(start, index) });
    nodes.push({
      type: "text",
      text: match[1] ?? match[3],
      marks: [{ type: match[1] ? "code" : "bold" }],
    });
    start = index + match[0].length;
  }
  if (start < text.length)
    nodes.push({ type: "text", text: text.slice(start) });
  return nodes;
}

export function designTextDoc(text: string): Doc {
  const content: Node[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      content.push({
        type: "paragraph",
        content: inline(paragraph.join("\n")),
      });
      paragraph = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]))
        code.push(lines[i]);
      content.push({
        type: "codeBlock",
        content: code.length ? [{ type: "text", text: code.join("\n") }] : [],
      });
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})(?!#)\s*(\S.*?)\s*$/);
    if (heading) {
      flush();
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: inline(heading[2].replace(/\s+#+\s*$/, "")),
      });
      continue;
    }
    const item = line.match(/^\s*(?:([-+*])\s+|(\d+)\.\s+)(.+)$/);
    if (item) {
      flush();
      const type = item[2] ? "orderedList" : "bulletList";
      let list = content.at(-1);
      if (list?.type !== type) {
        list = {
          type,
          ...(item[2] ? { attrs: { start: Number(item[2]) } } : {}),
          content: [],
        };
        content.push(list);
      }
      (list.content as Node[]).push({
        type: "listItem",
        content: [{ type: "paragraph", content: inline(item[3]) }],
      });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return { type: "doc", content };
}

export function formatPlainDesignText(doc: Doc): Doc {
  if (!doc.content) return doc;
  const content = doc.content.flatMap((node) => {
    if (
      node.type !== "paragraph" ||
      !Array.isArray(node.content) ||
      !node.content.every((n) => n.type === "text" && !n.marks?.length)
    )
      return [node];
    const text = node.content.map((n) => n.text).join("");
    if (
      !/(^|\n) {0,3}#{1,6}(?!#)\s*\S|\*\*\S.*?\*\*|__\S.*?__|(^|\n)\s*(?:[-+*]|\d+\.)\s+\S|(^|\n)\s*```/.test(
        text,
      )
    )
      return [node];
    return designTextDoc(text).content ?? [];
  });
  return { ...doc, content };
}
