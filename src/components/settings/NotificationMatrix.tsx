"use client";

import { NOTIFICATION_TYPES, NotificationMatrix, NotificationType } from "@/types";

const ROW_LABEL: Record<NotificationType, string> = {
  task_assigned: "A task is assigned to you",
  mentioned: "Somebody mentions you",
  status_changed: "A task you follow changes column",
  comment_added: "A task you follow gets a comment",
};

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
}: {
  value: NotificationMatrix;
  onChange: (next: NotificationMatrix) => void;
  disabled?: boolean;
  /** No personal webhook configured: ticking the column would deliver nowhere, which fails silently */
  chatDisabled?: boolean;
  chatDisabledHint?: string;
}) {
  function toggle(type: NotificationType, column: (typeof COLUMNS)[number]["key"]) {
    onChange({ ...value, [type]: { ...value[type], [column]: !value[type][column] } });
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
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {NOTIFICATION_TYPES.map((type) => (
            <tr key={type} className="border-b border-border last:border-0">
              <td className="py-2.5 pr-4">{ROW_LABEL[type]}</td>
              {COLUMNS.map((c) => {
                const off = disabled || (c.key === "chat" && chatDisabled);
                return (
                  <td key={c.key} className="py-2.5 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${ROW_LABEL[type]} — ${c.label}`}
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

      {chatDisabled && chatDisabledHint && (
        <p className="mt-3 text-xs text-text-muted">{chatDisabledHint}</p>
      )}
    </div>
  );
}
