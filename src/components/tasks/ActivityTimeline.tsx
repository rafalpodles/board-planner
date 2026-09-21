"use client";

import { useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { ApiActivityLog, LinkDirection, STATUS_LABELS, TaskStatus } from "@/types";
import { timeAgo } from "@/lib/time";
import { describeLinkChange } from "@/lib/link-phrasing";

interface ActivityTimelineProps {
  projectId: string;
  taskId: string;
  hideHeading?: boolean;
  onCountChange?: (count: number | null) => void;
  // Bumped by the parent when something outside this component wrote an activity entry
  refreshKey?: number;
}

function actionIcon(action: string) {
  switch (action) {
    case "created":
      return "+";
    case "status_changed":
      return "↔";
    case "updated":
      return "✎";
    case "comment_added":
      return "#";
    case "comment_edited":
      return "✎";
    case "comment_deleted":
      return "×";
    // From the set the rest of this table already proves renders at 12px: the branch and
    // erase-left glyphs both came out as tofu next to it.
    case "pr_linked":
      return "↗";
    case "pr_unlinked":
      return "×";
    // The same glyph as pr_linked, and for the same reason: a link appeared. `⚯` rendered, but its
    // bridge disappears into the antialiasing at 12px and it reads as two loose rings.
    case "link_added":
      return "↗";
    case "link_removed":
      return "×";
    default:
      return "•";
  }
}

function actionColor(action: string) {
  switch (action) {
    case "created":
      return "text-success";
    case "status_changed":
      return "text-primary";
    case "comment_deleted":
    case "pr_unlinked":
    case "link_removed":
      return "text-danger";
    default:
      return "text-text-muted";
  }
}

function formatFieldLabel(field: string): string {
  switch (field) {
    case "checklist":
      return "checklist";
    default:
      return field;
  }
}

function formatValue(field: string, value: string): string {
  if (field === "status" && value in STATUS_LABELS) {
    return STATUS_LABELS[value as TaskStatus];
  }
  if (!value) return "(empty)";
  if (value.length > 60) return value.slice(0, 60) + "…";
  return value;
}

// A link's address, shortened from the front. `formatValue` cuts the tail, which on a pull request
// url is the repository and the number — the only part worth reading.
function linkLabel(url: string): string {
  if (!url) return "a pull request";
  const bare = url.replace(/^https?:\/\//, "");
  return bare.length > 60 ? `…${bare.slice(-59)}` : bare;
}

// The only two actions ever written without an actor, which is what lets an absent one be read as
// the scheduled sync rather than as a deleted account (BP-628)
const SYNC_ACTIONS = new Set(["pr_linked", "pr_unlinked"]);

function actorName(log: ApiActivityLog): string {
  if (log.user && typeof log.user === "object") return log.user.fullName;
  if (!log.user && SYNC_ACTIONS.has(log.action)) return "The repository sync";
  // A deleted user also arrives as null, and null is an object to `typeof` — which is why the
  // check above leads with the value itself. For every other action that is what an absence means.
  return "Unknown";
}

function describeAction(log: ApiActivityLog): string {
  const userName = actorName(log);

  switch (log.action) {
    case "created":
      return `${userName} created this task`;
    case "status_changed":
      return `${userName} changed status from ${formatValue("status", log.oldValue)} to ${formatValue("status", log.newValue)}`;
    case "updated":
      if (log.field === "assignee") {
        const from = log.oldValue || "unassigned";
        const to = log.newValue || "unassigned";
        return `${userName} changed assignee from ${from} to ${to}`;
      }
      // createNextRecurrence writes a sentence into newValue rather than a before/after pair,
      // so reading it as one would claim the recurrence config had been edited
      if (log.field === "recurrence" && !log.oldValue && log.newValue) {
        return `${userName} — ${log.newValue}`;
      }
      // Too long for the sentence, and the first sixty characters of a before and an after usually
      // match, so the row said "from X… to X…". The text it replaced is offered below the row.
      if (log.field === "description") {
        return log.oldValue ? `${userName} edited the description` : `${userName} added a description`;
      }
      // A field entry that carries values says what changed; one that does not still reads.
      // Project fields are the reason this matters — "updated Difficulty" alone tells you nothing.
      if (log.oldValue || log.newValue) {
        return `${userName} changed ${formatFieldLabel(log.field)} from ${formatValue(log.field, log.oldValue)} to ${formatValue(log.field, log.newValue)}`;
      }
      return `${userName} updated ${formatFieldLabel(log.field)}`;
    case "comment_added":
      return `${userName} added a comment`;
    case "comment_edited":
      return `${userName} edited a comment`;
    case "comment_deleted":
      return `${userName} deleted a comment`;
    // The address, not the number: a task can hold links to two repositories, and after a repoint
    // the numbers collide (BP-631)
    case "pr_linked":
      return `${userName} linked ${linkLabel(log.newValue)}`;
    case "pr_unlinked":
      return `${userName} unlinked ${linkLabel(log.oldValue)}`;
    // Written at both ends of one link, so `field` is the relation as THIS task experiences it —
    // the parent's row and the child's row describe the same write from opposite sides (BP-658).
    case "link_added":
      return describeLinkChange({
        actor: userName,
        action: "added",
        direction: log.field as LinkDirection,
        self: "this task",
        other: log.newValue,
      });
    case "link_removed":
      return describeLinkChange({
        actor: userName,
        action: "removed",
        direction: log.field as LinkDirection,
        self: "this task",
        other: log.oldValue,
      });
    default:
      return `${userName} performed an action`;
  }
}

export function ActivityTimeline({
  projectId,
  taskId,
  hideHeading,
  onCountChange,
  refreshKey = 0,
}: ActivityTimelineProps) {
  const [logs, setLogs] = useState<ApiActivityLog[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  // "No history yet" is a claim about this task, and a read still in flight supports none — the
  // same reason Comments next door has one (BP-577)
  const [reading, setReading] = useState(true);
  const api = useApi();
  const loadSeq = useRef(0);

  function load() {
    // A task switch reconciles this panel in place, so the previous task's read is still in
    // flight and would otherwise land as this task's history (BP-586, the shape BP-577 gave
    // Comments next door)
    const seq = ++loadSeq.current;
    api
      .get(`/api/projects/${projectId}/tasks/${taskId}/activity`)
      .then((data: ApiActivityLog[]) => {
        if (seq !== loadSeq.current) return;
        setLogs(data);
        setFailed(false);
        onCountChange?.(data.length);
      })
      .catch(() => {
        if (seq !== loadSeq.current) return;
        setFailed(true);
        // Same as Comments next door: the tab's number is a claim about the read that just failed
        onCountChange?.(null);
      })
      .finally(() => {
        if (seq === loadSeq.current) setReading(false);
      });
  }

  useEffect(() => {
    // A different task is a different history: what is on screen belongs to the one just left,
    // and so does the count this panel last reported
    setLogs([]);
    setFailed(false);
    setReading(true);
    setExpanded(false);
    onCountChange?.(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    // A refresh keeps what is on screen: the rows are this task's either way
    if (refreshKey === 0) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const displayLogs = expanded ? logs : logs.slice(0, 5);

  return (
    <div>
      {!hideHeading && (
        <h3 className="font-semibold mb-3">History ({logs.length})</h3>
      )}

      {failed && (
        // The same control the comments panel offers: a withdrawn count and a bare sentence left
        // the reader nothing to do but change task or post something (BP-582 review)
        <LoadFailed
          testId="history-error"
          variant={logs.length ? "row" : "block"}
          className={logs.length ? "mb-2" : "py-4"}
          message="Could not load this task's history."
          onRetry={() => {
            setReading(true);
            load();
          }}
        />
      )}

      {!failed && !reading && logs.length === 0 && (
        <p className="text-sm text-text-muted">
          No history yet — changes to this task will be recorded here.
        </p>
      )}

      <div className="space-y-2">
        {displayLogs.map((log) => (
          <div
            key={log._id}
            className="flex items-start gap-2 text-sm"
          >
            <span
              aria-hidden="true"
              className={`flex-shrink-0 w-5 h-5 flex items-center justify-center text-xs rounded-full bg-bg-input ${actionColor(log.action)}`}
            >
              {actionIcon(log.action)}
            </span>
            <span className="flex-1 min-w-0 text-text-muted">
              {describeAction(log)}
              {log.action === "updated" && log.field === "description" && log.oldValue && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-primary">What it said before</summary>
                  <p className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-bg-input p-2 text-xs text-text">
                    {log.oldValue}
                  </p>
                </details>
              )}
            </span>
            <time
              dateTime={log.createdAt}
              title={new Date(log.createdAt).toLocaleString()}
              className="flex-shrink-0 text-xs text-text-muted"
            >
              {timeAgo(log.createdAt)}
            </time>
          </div>
        ))}
      </div>

      {logs.length > 5 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-primary hover:underline mt-2"
        >
          {expanded ? "Show less" : `Show all ${logs.length} entries`}
        </button>
      )}
    </div>
  );
}
