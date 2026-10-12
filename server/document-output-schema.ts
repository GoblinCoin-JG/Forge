// Strict provider representation of the editor's recursive canonical JSON.
// Structure/attributes/mark compatibility are independently checked by Tiptap
// and the shared document validator after generation.
const string = { type: "string" };
const nullable = { type: ["string", "null"] };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const node = (type: string, properties: Record<string, unknown> = {}) =>
  object({ type: { type: "string", enum: [type] }, ...properties });
const array = (name: string) => ({
  type: "array",
  items: { $ref: `#/$defs/${name}` },
});
const marks = array("mark"),
  inline = array("inline"),
  blocks = array("block"),
  listItems = array("listItem");
const paragraph = node("paragraph", { content: inline });
const heading = node("heading", {
  attrs: object({ level: { type: "integer", enum: [1, 2, 3, 4, 5, 6] } }),
  content: inline,
});
export const documentOutputDefs = {
  mark: {
    anyOf: [
      ...["bold", "italic", "underline", "strike", "code"].map((type) =>
        node(type),
      ),
      node("link", {
        attrs: object({
          href: string,
          target: nullable,
          rel: nullable,
          class: nullable,
          title: nullable,
        }),
      }),
    ],
  },
  text: node("text", { text: string, marks }),
  inline: { anyOf: [{ $ref: "#/$defs/text" }, node("hardBreak", { marks })] },
  listItem: node("listItem", { content: blocks }),
  block: {
    anyOf: [
      paragraph,
      heading,
      node("bulletList", { content: listItems }),
      node("orderedList", {
        attrs: object({
          start: { type: "integer", minimum: 1 },
          type: {
            type: ["string", "null"],
            enum: ["1", "a", "A", "i", "I", null],
          },
        }),
        content: listItems,
      }),
      node("blockquote", { content: blocks }),
      node("codeBlock", {
        attrs: object({ language: nullable }),
        content: array("text"),
      }),
      node("horizontalRule"),
    ],
  },
  document: node("doc", { content: blocks }),
};
const base = { version: { type: "integer", enum: [2] } };
const action = (name: string, properties: Record<string, unknown>) =>
  object({ ...base, action: { type: "string", enum: [name] }, ...properties });
export const documentOutputSchema = object({
  kind: { type: "string", enum: ["document"] },
  title: string,
  description: string,
  reason: string,
  chapterId: nullable,
  parentId: nullable,
  content: { type: "string", enum: [""] },
  section: { type: "null" },
  proposedStatus: { type: "null" },
  relatedChapterIds: { type: "array", items: string },
  document: {
    anyOf: [
      ...["create_chapter", "create_subchapter", "update_chapter"].map((name) =>
        action(name, { document: { $ref: "#/$defs/document" } }),
      ),
      action("add_section", {
        heading: string,
        level: { type: "integer", enum: [1, 2, 3, 4, 5, 6] },
        body: blocks,
      }),
      action("revise_section", { heading: string, body: blocks }),
    ],
  },
});
