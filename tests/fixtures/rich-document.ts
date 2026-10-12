import type { Doc } from "../../shared/types.js";

const text = (value: string, marks?: Record<string, unknown>[]) => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (value: string) => ({
  type: "paragraph",
  content: [text(value)],
});
export const richDesignDocument: Doc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [text("Game direction")] },
    paragraph("A readable design document with deliberate choices."),
    { type: "heading", attrs: { level: 2 }, content: [text("Movement")] },
    {
      type: "paragraph",
      content: [
        text("Responsive", [{ type: "bold" }, { type: "italic" }]),
        text(" arcade controls"),
        { type: "hardBreak" },
        text("Read the movement reference", [
          {
            type: "link",
            attrs: {
              href: "https://example.com/movement-old",
              target: "_blank",
              rel: "noopener noreferrer",
              class: null,
              title: "Movement reference",
            },
          },
          { type: "underline" },
        ]),
      ],
    },
    {
      type: "orderedList",
      attrs: { start: 3, type: "a" },
      content: [
        {
          type: "listItem",
          content: [
            paragraph("Choose a route"),
            {
              type: "bulletList",
              content: [
                { type: "listItem", content: [paragraph("Watch the terrain")] },
              ],
            },
          ],
        },
        { type: "listItem", content: [paragraph("Return safely")] },
      ],
    },
    { type: "heading", attrs: { level: 3 }, content: [text("Movement notes")] },
    {
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [
            text("Clarity over simulation", [{ type: "strike" }]),
            text(" · Use deliberate tradeoffs"),
          ],
        },
      ],
    },
    { type: "heading", attrs: { level: 2 }, content: [text("Combat")] },
    {
      type: "paragraph",
      content: [
        text("Call "),
        text("attack()", [{ type: "code" }]),
        text(" only after the player commits."),
      ],
    },
    {
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [text("if (ready) {\n  attack(); // ## keep literal\n}")],
    },
    { type: "horizontalRule" },
    { type: "heading", attrs: { level: 2 }, content: [text("Extraction")] },
    paragraph(
      "Return with discoveries; preserve this unrelated section exactly.",
    ),
  ],
};

export function movementRefinement(): Record<string, unknown>[] {
  return [
    {
      type: "paragraph",
      content: [
        text("Responsive", [{ type: "bold" }, { type: "underline" }]),
        text(" arcade controls during wormhole events."),
        { type: "hardBreak" },
        text("Read the movement reference", [
          {
            type: "link",
            attrs: {
              href: "https://example.com/movement-new",
              target: "_blank",
              rel: "noopener noreferrer",
              class: null,
              title: "Updated movement reference",
            },
          },
        ]),
      ],
    },
    {
      type: "orderedList",
      attrs: { start: 1, type: "1" },
      content: [
        { type: "listItem", content: [paragraph("Choose a readable route")] },
        { type: "listItem", content: [paragraph("Adjust to new terrain")] },
      ],
    },
    { type: "heading", attrs: { level: 3 }, content: [text("Movement notes")] },
    {
      type: "blockquote",
      content: [paragraph("Keep movement deliberate and responsive.")],
    },
  ];
}
