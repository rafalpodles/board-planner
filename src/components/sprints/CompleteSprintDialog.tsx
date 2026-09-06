"use client";

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
          <Button disabled={completing} onClick={() => onComplete(true)}>
            {completing ? "Completing..." : "Move to Backlog"}
          </Button>
          <Button variant="secondary" disabled={completing} onClick={() => onComplete(false)}>
            Keep in Sprint
          </Button>
          <Button variant="ghost" disabled={completing} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
