"use client";

import { useState } from "react";
import { ApiSprint } from "@/types";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

interface CompleteSprintDialogProps {
  sprint: ApiSprint;
  completing: boolean;
  onComplete: (moveToBacklog: boolean) => void;
  onClose: () => void;
}

export function CompleteSprintDialog({
  sprint,
  completing,
  onComplete,
  onClose,
}: CompleteSprintDialogProps) {
  const incomplete = (sprint.taskCount ?? 0) - (sprint.doneCount ?? 0);
  const [pressed, setPressed] = useState<"backlog" | "keep" | null>(null);

  return (
    <Modal open onClose={onClose} closeDisabled={completing} title="Complete Sprint">
      <div className="space-y-4">
        <p className="text-sm">
          Completing <strong>{sprint.name}</strong>.
          {incomplete > 0 && (
            <> There {incomplete === 1 ? "is" : "are"}{" "}
            <strong>{incomplete}</strong> incomplete
            task{incomplete === 1 ? "" : "s"}.</>
          )}
        </p>
        <div className="flex gap-3">
          <Button
            disabled={completing}
            onClick={() => {
              setPressed("backlog");
              onComplete(true);
            }}
          >
            {completing && pressed === "backlog" ? "Completing..." : "Move to Backlog"}
          </Button>
          <Button
            variant="secondary"
            disabled={completing}
            onClick={() => {
              setPressed("keep");
              onComplete(false);
            }}
          >
            {completing && pressed === "keep" ? "Completing..." : "Keep in Sprint"}
          </Button>
          <Button variant="ghost" disabled={completing} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
