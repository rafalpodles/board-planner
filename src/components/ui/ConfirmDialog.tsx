"use client";

import { Modal } from "./Modal";
import { Button } from "./Button";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  /**
   * What the confirm button says while the write it started is running. Defaults to "Deleting…"
   * because deleting is what this dialog was written for, but it is not the only thing it confirms
   * — a forced *move* asking "Deleting…" describes the wrong act (BP-588 review).
   */
  loadingLabel?: string;
  loading?: boolean;
  error?: string;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Delete",
  loadingLabel = "Deleting...",
  loading = false,
  error,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} closeDisabled={loading} title={title}>
      <p className="text-sm text-text-muted mb-6">{message}</p>
      {error && (
        <p role="alert" className="text-sm text-danger -mt-3 mb-6">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-3">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={onConfirm}
          disabled={loading}
        >
          {loading ? loadingLabel : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
