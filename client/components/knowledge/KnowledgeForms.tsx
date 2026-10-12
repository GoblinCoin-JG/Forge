import { useRef, useState, type ReactNode } from "react";
import { Modal } from "../Modal";
import type { KnowledgeController } from "../../knowledge";

export function KnowledgeForm({
  title,
  description,
  submitLabel,
  controller,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  controller: KnowledgeController;
  onClose: () => void;
  onSubmit: () => Promise<unknown>;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sending = useRef(false);
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!sending.current) onClose();
      }}
    >
      {description && <p className="modal-intro">{description}</p>}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (sending.current) return;
          sending.current = true;
          setBusy(true);
          setError("");
          try {
            await onSubmit();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            sending.current = false;
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>{children}</fieldset>
        {error && (
          <div className="inline-error" role="alert">
            <p>{error}</p>
            <p>
              Your draft remains here. Review the saved information before
              retrying a conflicting change.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await controller.reload();
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Discard draft and reload
            </button>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function ReferencePicker({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { id: string; label: string; archived?: boolean }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="knowledge-reference-picker">
      <legend>{label}</legend>
      {!options.length && <p className="muted">Nothing to link yet.</p>}
      {options.map((option) => (
        <label key={option.id}>
          <input
            type="checkbox"
            checked={selected.includes(option.id)}
            disabled={Boolean(option.archived && !selected.includes(option.id))}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, option.id]
                  : selected.filter((id) => id !== option.id),
              )
            }
          />
          <span>
            {option.label}
            {option.archived ? " · Archived" : ""}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
export function KnowledgeStatus({
  label,
  reviewed = false,
  historical = false,
}: {
  label: string;
  reviewed?: boolean;
  historical?: boolean;
}) {
  return (
    <span
      className={`knowledge-status ${reviewed ? "reviewed" : ""} ${historical ? "historical" : ""}`}
    >
      {label}
    </span>
  );
}
