"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

interface DangerActionProps {
  label: string;
  title: string;
  message: string;
  usage?: string;
  alternative?: { label: string; onSelect: () => void | Promise<void> };
  onConfirm: () => void | Promise<void>;
  confirmLabel?: string;
  disabled?: boolean;
}

export function DangerAction({
  label,
  title,
  message,
  usage,
  alternative,
  onConfirm,
  confirmLabel,
  disabled,
}: DangerActionProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(action: () => void | Promise<void>) {
    setBusy(true);
    try {
      await action();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="danger" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title={title}>
        <p className="mb-2 text-sm text-text-muted">{message}</p>
        {usage && (
          <p className="mb-6 rounded-lg border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm">
            {usage}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {alternative && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => run(alternative.onSelect)}
            >
              {alternative.label}
            </Button>
          )}
          <Button variant="danger" size="sm" disabled={busy} onClick={() => run(onConfirm)}>
            {busy ? "Working..." : (confirmLabel ?? label)}
          </Button>
        </div>
      </Modal>
    </>
  );
}
