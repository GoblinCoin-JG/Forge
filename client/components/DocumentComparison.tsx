import type { Doc } from "../../shared/types";
import { documentDifferences } from "../../shared/document-diff";
import { DocumentPreview } from "./DocumentPreview";
import { validDocument } from "../../shared/document";

export function DocumentComparison({
  before,
  after,
  beforeLabel = "Original saved document",
  afterLabel = "Proposed document",
}: {
  before?: Doc;
  after: Doc;
  beforeLabel?: string;
  afterLabel?: string;
}) {
  const emptyBefore =
    before?.type === "doc" &&
    !before.content?.length &&
    Object.keys(before).every((key) => key === "type" || key === "content");
  const comparable =
    validDocument(after) && (!before || emptyBefore || validDocument(before));
  const differences = comparable
    ? documentDifferences(before ?? { type: "doc", content: [] }, after)
    : [];
  return (
    <div className="rich-document-comparison">
      <div className="proposal-comparison">
        {before && (
          <section>
            <h4>{beforeLabel}</h4>
            <DocumentPreview content={before} />
          </section>
        )}
        <section>
          <h4>{afterLabel}</h4>
          <DocumentPreview content={after} />
        </section>
      </div>
      <details className="document-structural-diff" open>
        <summary>
          Document changes · content, structure, formatting and links
        </summary>
        {!comparable && (
          <p>
            Structural comparison is unavailable for unsupported stored
            structures. Inspect the retained original representation above.
          </p>
        )}
        {comparable && !differences.length && (
          <p>No document changes. Review the chapter title separately.</p>
        )}
        {differences.map((change, i) => (
          <section key={i} className={`document-change ${change.kind}`}>
            <strong>
              {change.kind === "added"
                ? "Added"
                : change.kind === "removed"
                  ? "Removed"
                  : "Modified"}
              : {change.label}
            </strong>
            <ul>
              {change.details.slice(0, 12).map((text, n) => (
                <li key={n}>{text}</li>
              ))}
            </ul>
            {change.details.length > 12 && (
              <p>
                {change.details.length - 12} more changes in this block; inspect
                the full rich previews above.
              </p>
            )}
          </section>
        ))}
      </details>
    </div>
  );
}
