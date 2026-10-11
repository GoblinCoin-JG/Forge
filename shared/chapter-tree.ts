import type { Chapter } from "./types.js";

export function chapterOutline(chapters: Chapter[]) {
  const rows: { chapter: Chapter; depth: number; number: string }[] = [];
  const children = new Map<string | null, Chapter[]>();
  for (const chapter of chapters) {
    const group = children.get(chapter.parentId) ?? [];
    group.push(chapter);
    children.set(chapter.parentId, group);
  }
  const walk = (parentId: string | null, depth: number, prefix: string) => {
    (children.get(parentId) ?? []).forEach((chapter, index) => {
      const number = `${prefix}${String(index + 1).padStart(2, "0")}`;
      rows.push({ chapter, depth, number });
      walk(chapter.id, depth + 1, `${number}.`);
    });
  };
  walk(null, 0, "");
  return rows;
}

export function isDescendant(
  chapters: Chapter[],
  id: string,
  ancestorId: string,
): boolean {
  const visited = new Set<string>();
  let current = chapters.find((c) => c.id === id);
  while (current?.parentId && !visited.has(current.id)) {
    if (current.parentId === ancestorId) return true;
    visited.add(current.id);
    current = chapters.find((c) => c.id === current!.parentId);
  }
  return false;
}
