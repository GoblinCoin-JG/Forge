import type { Doc } from "./document.js";
import {
  documentSections,
  type DocumentReceipt,
} from "./document-proposals.js";

// Keep whole canonical blocks. Never truncate text, links or JSON mid-node.
// Coverage is backend-generated and accompanies the exact supplied document.
export function documentExcerpt(
  original: Doc,
  budget: number,
  instruction = "",
): { document: Doc; receipt: DocumentReceipt } {
  const nodes = original.content ?? [],
    sections = documentSections(original);
  if (JSON.stringify(original).length <= budget)
    return {
      document: original,
      receipt: {
        complete: true,
        includedBlockIndexes: nodes.map((_, i) => i),
        completeSections: sections.map((s) => s.heading),
      },
    };
  const included = new Set<number>();
  let remaining = Math.max(0, budget - 100);
  const addRange = (start: number, end: number) => {
    const cost = nodes
      .slice(start, end)
      .reduce(
        (sum, node, i) =>
          sum + (included.has(start + i) ? 0 : JSON.stringify(node).length + 1),
        0,
      );
    if (cost > remaining) return;
    for (let i = start; i < end; i++) included.add(i);
    remaining -= cost;
  };
  const requested = sections.filter(
    (s) =>
      s.heading.trim() &&
      instruction.toLowerCase().includes(s.heading.toLowerCase()),
  );
  for (const s of requested) addRange(s.start, s.end);
  for (let i = 0; i < nodes.length; i++) addRange(i, i + 1);
  const indexes = [...included].sort((a, b) => a - b);
  return {
    document: {
      type: "doc",
      content: indexes.length
        ? indexes.map((i) => nodes[i])
        : [{ type: "paragraph" }],
    },
    receipt: {
      complete: false,
      includedBlockIndexes: indexes,
      completeSections: sections
        .filter((s) =>
          Array.from({ length: s.end - s.start }, (_, i) => s.start + i).every(
            (i) => included.has(i),
          ),
        )
        .map((s) => s.heading),
    },
  };
}
