"use client";

import { NOTIFICATION_TYPES, NotificationMatrix, NotificationType } from "@/types";

const ROW_LABEL: Record<NotificationType, string> = {
  task_assigned: "A task is assigned to you",
  mentioned: "Somebody mentions you",
  status_changed: "A task you follow changes column",
  comment_added: "A task you follow gets a comment",
  task_linked: "A task you follow gains or loses a dependency",
  board_access: "You are added to a board, or your role on one changes",
  // Replaced on the project screen, where "a board" has an answer — see PROJECT_ROW_LABEL
  task_created: "Anybody creates a task on a board",
};

/** The rows whose wording depends on which screen the grid is on. */
const PROJECT_ROW_LABEL: Partial<Record<NotificationType, string>> = {
  task_created: "Anybody creates a task on this board",
  board_access: "Your role on this board changes",
};

const OFF = { inApp: false, email: false, chat: false };

export interface MailAvailability {
  server: boolean;
  address: boolean;
}

export function emailUnavailableHint(mail: MailAvailability | undefined): string | undefined {
  if (!mail) return undefined;
  if (!mail.server) return "This instance has no mail server, so nothing can be sent by e-mail.";
  if (!mail.address) return "Add an e-mail address on your profile before sending anything there.";
  return undefined;
}

const COLUMNS = [
  { key: "inApp", label: "In app" },
  { key: "email", label: "E-mail" },
  { key: "chat", label: "Chat" },
] as const;

export function NotificationMatrixEditor({
  value,
  onChange,
  disabled = false,
  chatDisabled = false,
  chatDisabledHint,
  emailDisabled = false,
  emailDisabledHint,
  scope = "global",
}: {
  value: NotificationMatrix;
  onChange: (next: NotificationMatrix) => void;
  disabled?: boolean;
  /** No personal webhook configured: ticking the column would deliver nowhere, which fails silently */
  chatDisabled?: boolean;
  chatDisabledHint?: string;
  /** No mail server on the instance, or no address on the account: the column would send nothing */
  emailDisabled?: boolean;
  emailDisabledHint?: string;
  /** Which board the grid is being read against, for the rows that say "a board" otherwise */
  scope?: "global" | "project";
}) {
  const labelOf = (type: NotificationType) =>
    (scope === "project" && PROJECT_ROW_LABEL[type]) || ROW_LABEL[type];

  function toggle(type: NotificationType, column: (typeof COLUMNS)[number]["key"]) {
    // Optional: a grid saved before a row existed has no entry for it, and a click must not be
    // the way that is discovered. The server fills the gap; this is the belt to that brace.
    onChange({ ...value, [type]: { ...OFF, ...value[type], [column]: !value[type]?.[column] } });
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="py-2 pr-4 text-left font-medium text-text-muted">Tell me when</th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="w-20 py-2 text-center font-medium text-text-muted">
                {c.label}
                {c.key === "chat" && chatDisabled && (
                  <span className="block text-[11px] font-normal">not connected</span>
                )}
                {c.key === "email" && emailDisabled && (
                  <span className="block text-[11px] font-normal">unavailable</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {NOTIFICATION_TYPES.map((type) => (
            <tr key={type} className="border-b border-border last:border-0">
              <td className="py-2.5 pr-4">{labelOf(type)}</td>
              {COLUMNS.map((c) => {
                const off =
                  disabled ||
                  (c.key === "chat" && chatDisabled) ||
                  (c.key === "email" && emailDisabled);
                return (
                  <td key={c.key} className="py-2.5 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${labelOf(type)} — ${c.label}`}
                      checked={!!value[type]?.[c.key]}
                      disabled={off}
                      onChange={() => toggle(type, c.key)}
                      className="focus-ring rounded border-border disabled:opacity-40"
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {emailDisabled && emailDisabledHint && (
        <p className="mt-3 text-xs text-text-muted">{emailDisabledHint}</p>
      )}
      {chatDisabled && chatDisabledHint && (
        <p className="mt-3 text-xs text-text-muted">{chatDisabledHint}</p>
      )}
    </div>
  );
}
