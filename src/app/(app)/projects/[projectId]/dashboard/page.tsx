"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiProject, ROLE_LABELS, STATUS_LABELS, TaskStatus } from "@/types";
import { columnIdsWithRole, effectiveColumns } from "@/lib/columns";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/shell/PageHeader";

interface Stats {
  total: number;
  done: number;
  statusBreakdown: Record<string, number>;
  categoryBreakdown: Record<string, number>;
  assigneeBreakdown: Record<string, number>;
  difficultyBreakdown: Record<string, number>;
  velocity: { week: string; count: number }[];
  createdOverTime: { week: string; created: number; completed: number }[];
}

const STATUS_COLORS: Record<string, string> = {
  planned: "#6b7280",
  todo: "#3b82f6",
  in_progress: "#f59e0b",
  in_review: "#8b5cf6",
  needs_human_review: "#f43f5e",
  ready_to_test: "#06b6d4",
  done: "#22c55e",
};

const CATEGORY_COLORS: Record<string, string> = {
  bug: "#ef4444",
  doc: "#3b82f6",
  "user-story": "#22c55e",
  idea: "#f59e0b",
};

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-32 items-center justify-center rounded border border-dashed border-border px-4">
      <p className="text-center text-xs text-text-muted">{message}</p>
    </div>
  );
}

function DonutChart({
  data,
  colors,
  labels,
  emptyMessage,
}: {
  data: Record<string, number>;
  colors: Record<string, string>;
  labels?: Record<string, string>;
  emptyMessage: string;
}) {
  const entries = Object.entries(data).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return <EmptyChart message={emptyMessage} />;

  const size = 120;
  const strokeWidth = 24;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  const segments = entries.map(([key, value]) => {
    const pct = value / total;
    const dashArray = `${pct * circumference} ${circumference}`;
    const rotation = offset * 360;
    offset += pct;
    return {
      key,
      label: labels?.[key] ?? STATUS_LABELS[key as TaskStatus] ?? key,
      value,
      pct,
      dashArray,
      rotation,
      color: colors[key] || "#6b7280",
    };
  });

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} className="flex-shrink-0">
        {segments.map((seg) => (
          <circle
            key={seg.key}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={seg.color}
            strokeWidth={strokeWidth}
            strokeDasharray={seg.dashArray}
            strokeDashoffset={0}
            transform={`rotate(${seg.rotation - 90} ${size / 2} ${size / 2})`}
          />
        ))}
        <text x={size / 2} y={size / 2} textAnchor="middle" dy="0.35em" className="fill-text text-lg font-bold">
          {total}
        </text>
      </svg>
      <div className="space-y-1">
        {segments.map((seg) => (
          <div key={seg.key} className="flex items-center gap-2 text-xs">
            <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: seg.color }} />
            <span className="text-text-muted">{seg.label}</span>
            <span className="font-medium">{seg.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const BAR_TRACK_PX = 112;
const MIN_VISIBLE_BAR_PX = 4;

function BarChart({
  data,
  label,
  emptyMessage,
}: {
  data: { label: string; value: number }[];
  label: string;
  emptyMessage: string;
}) {
  if (!data.some((d) => d.value > 0)) return <EmptyChart message={emptyMessage} />;

  const max = Math.max(...data.map((d) => d.value), 1);
  const barHeight = (value: number) =>
    value > 0 ? Math.max(Math.round((value / max) * BAR_TRACK_PX), MIN_VISIBLE_BAR_PX) : 0;

  return (
    <div>
      <div className="flex items-end gap-1">
        {data.map((d, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <span className="text-[10px] text-text-muted">{d.value || ""}</span>
            <div
              className="w-full bg-primary rounded-t transition-all"
              style={{ height: barHeight(d.value) }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-1 mt-1">
        {data.map((d, i) => (
          <span key={i} className="flex-1 text-[9px] text-text-muted text-center truncate">
            {d.label}
          </span>
        ))}
      </div>
      <p className="text-xs text-text-muted text-center mt-2">{label}</p>
    </div>
  );
}

function HorizontalBars({
  data,
  colors,
  emptyMessage,
}: {
  data: Record<string, number>;
  colors?: Record<string, string>;
  emptyMessage: string;
}) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map(([, v]) => v), 1);

  if (entries.length === 0) return <EmptyChart message={emptyMessage} />;

  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-center gap-2">
          <span className="text-xs text-text-muted w-24 truncate text-right">{key}</span>
          <div className="flex-1 h-5 bg-bg-input rounded overflow-hidden">
            <div
              className="h-full rounded transition-all"
              style={{
                width: `${(value / max) * 100}%`,
                backgroundColor: colors?.[key] || "var(--color-primary)",
              }}
            />
          </div>
          <span className="text-xs font-medium w-6 text-right">{value}</span>
        </div>
      ))}
    </div>
  );
}

function CreatedVsCompletedChart({ data }: { data: Stats["createdOverTime"] }) {
  if (!data.some((d) => d.created > 0 || d.completed > 0)) {
    return (
      <EmptyChart message="Nothing created or completed in the last 8 weeks — new and finished tasks show up here." />
    );
  }

  const max = Math.max(...data.map((d) => Math.max(d.created, d.completed)), 1);

  return (
    <div className="space-y-1">
      <div className="flex items-end gap-1 h-32">
        {data.map((d, i) => (
          <div key={i} className="flex-1 flex gap-px items-end h-full">
            <div
              className="flex-1 bg-primary/60 rounded-t"
              style={{ height: `${(d.created / max) * 100}%`, minHeight: d.created > 0 ? 4 : 0 }}
            />
            <div
              className="flex-1 bg-status-done rounded-t"
              style={{ height: `${(d.completed / max) * 100}%`, minHeight: d.completed > 0 ? 4 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-1">
        {data.map((d, i) => (
          <span key={i} className="flex-1 text-[9px] text-text-muted text-center truncate">
            {d.week}
          </span>
        ))}
      </div>
      <div className="flex gap-4 justify-center mt-2">
        <span className="flex items-center gap-1 text-xs text-text-muted">
          <span className="w-3 h-3 rounded-sm bg-primary/60" /> Created
        </span>
        <span className="flex items-center gap-1 text-xs text-text-muted">
          <span className="w-3 h-3 rounded-sm bg-status-done" /> Completed
        </span>
      </div>
    </div>
  );
}

function whyItFailed(reason: unknown): string {
  const { status, message } = (reason ?? {}) as { status?: number; message?: string };
  if (status === 403) return "You do not have access to this board.";
  if (status === 404) return "There is no board here — the link may be stale.";
  return message
    ? `The dashboard could not be loaded: ${message}`
    : "The dashboard could not be loaded.";
}

export default function DashboardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const api = useApi();

  const [stats, setStats] = useState<Stats | null>(null);
  const [project, setProject] = useState<ApiProject | null>(null);
  const projectName = project?.name ?? "";
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [settingsFailed, setSettingsFailed] = useState(false);

  const generation = useRef(0);

  const load = useCallback(() => {
    const mine = (generation.current += 1);
    setLoading(true);
    Promise.allSettled([
      api.get(`/api/projects/${projectId}/stats`),
      api.get(`/api/projects/${projectId}`),
    ])
      .then(([s, p]) => {
        if (mine !== generation.current) return;
        setProject(p.status === "fulfilled" ? p.value : null);
        setSettingsFailed(p.status === "rejected");
        setStats(s.status === "fulfilled" ? s.value : null);
        setFailure(s.status === "rejected" ? whyItFailed(s.reason) : "");
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(load, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <PageHeader title="Dashboard" subtitle={projectName} />
        <div
          data-testid="dashboard-error"
          className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-6 text-center"
        >
          <p className="text-sm">{failure || "The dashboard could not be loaded."}</p>
          <Button variant="secondary" className="mt-4" onClick={load}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const completionPct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

  const columns = effectiveColumns(project?.columns);
  const columnLabels = Object.fromEntries(columns.map((c) => [c.id, c.label]));
  const columnColors = {
    ...STATUS_COLORS,
    ...Object.fromEntries(columns.map((c) => [c.id, c.color])),
  };
  const categoryColors = {
    ...CATEGORY_COLORS,
    ...Object.fromEntries((project?.categories ?? []).map((c) => [c.name, c.color])),
  };
  const activeIds = project ? columnIdsWithRole(project, "active") : null;
  const noActiveColumn = activeIds !== null && activeIds.length === 0;
  const inFlight =
    activeIds && activeIds.length > 0
      ? activeIds.reduce((n, id) => n + (stats.statusBreakdown[id] || 0), 0)
      : null;

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader title="Dashboard" subtitle={projectName} />

      {noActiveColumn && (
        <div
          data-testid="dashboard-no-active-column"
          className="mb-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
        >
          This board has no column meaning {ROLE_LABELS.active.label}, so In Progress cannot be
          counted. Give a column that role in Settings → Board.
        </div>
      )}

      {settingsFailed && (
        <div
          data-testid="dashboard-settings-warning"
          className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
        >
          <span>
            The board&apos;s own settings could not be loaded. Columns and categories show default
            names and colours, and In Progress cannot be counted without them.
          </span>
          <Button variant="secondary" size="sm" onClick={load}>
            Try again
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <div className="bg-bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-text-muted">Total Tasks</p>
          <p className="text-2xl font-bold">{stats.total}</p>
        </div>
        <div className="bg-bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-text-muted">Completed</p>
          <p className="text-2xl font-bold text-status-done">{stats.done}</p>
        </div>
        <div className="bg-bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-text-muted">In Progress</p>
          <p className="text-2xl font-bold text-status-in-progress">{inFlight ?? "—"}</p>
        </div>
        <div className="bg-bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-text-muted">Completion</p>
          <p className="text-2xl font-bold">{completionPct}%</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 mb-8">
        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">Status Breakdown</h2>
          <DonutChart
            data={stats.statusBreakdown}
            colors={columnColors}
            labels={columnLabels}
            emptyMessage="No tasks on the board yet — every task counts towards its column here."
          />
        </div>

        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">Velocity (tasks done/week)</h2>
          <BarChart
            data={stats.velocity.map((v) => ({ label: v.week, value: v.count }))}
            label="Last 8 weeks"
            emptyMessage="No tasks completed in the last 8 weeks — each week a task reaches Done adds a bar."
          />
        </div>

        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">By Category</h2>
          <HorizontalBars
            data={stats.categoryBreakdown}
            colors={categoryColors}
            emptyMessage="No tasks yet — categories appear as soon as the board has tasks."
          />
        </div>

        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">By Assignee</h2>
          <HorizontalBars
            data={stats.assigneeBreakdown}
            emptyMessage="Nobody is assigned yet — assign a task to see the split per person."
          />
        </div>

        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">By Difficulty</h2>
          <HorizontalBars
            data={stats.difficultyBreakdown}
            emptyMessage="No tasks yet — the S/M/L/XL split shows up once tasks exist."
          />
        </div>

        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">Created vs Completed</h2>
          <CreatedVsCompletedChart data={stats.createdOverTime} />
        </div>
      </div>
    </div>
  );
}
