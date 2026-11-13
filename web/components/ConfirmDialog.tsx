import { useEffect, useRef } from "react";
import styles from "./ConfirmDialog.module.css";

interface ConfirmDialogProps {
  open: boolean;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A modal question. The native <dialog> keeps focus inside, closes on Escape
 * and returns focus to where it was, so none of that is rebuilt here.
 */
export function ConfirmDialog({ open, message, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="confirm-message"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <p id="confirm-message" className={styles.message}>
        {message}
      </p>
      <div className={styles.buttons}>
        {/* Cancel first and focused first, so Enter does not destroy anything by accident. */}
        <button type="button" className="button" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button type="button" className="button button-danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
