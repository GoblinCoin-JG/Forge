// A bounded line diff for human review, never used to apply content.
export function lineDiff(
  before: string,
  after: string,
): { kind: "same" | "added" | "removed"; text: string }[] {
  const a = before.split("\n"),
    b = after.split("\n");
  if (a.length * b.length > 160000)
    return [
      { kind: "removed", text: before },
      { kind: "added", text: after },
    ];
  const rows = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      rows[i][j] =
        a[i] === b[j]
          ? rows[i + 1][j + 1] + 1
          : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const out: ReturnType<typeof lineDiff> = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: "same", text: a[i++] });
      j++;
    } else if (
      i < a.length &&
      (j === b.length || rows[i + 1][j] >= rows[i][j + 1])
    )
      out.push({ kind: "removed", text: a[i++] });
    else out.push({ kind: "added", text: b[j++] });
  }
  return out;
}
