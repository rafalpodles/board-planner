"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { STATUS_LABELS, TaskStatus } from "@/types";
import { useToast } from "@/components/ui/Toast";
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
  emptyMessage,
}: {
  data: Record<string, number>;
  colors: Record<string, string>;
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
    return { key, value, pct, dashArray, rotation, color: colors[key] || "#6b7280" };
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
            <span className="text-text-muted">{STATUS_LABELS[seg.key as TaskStatus] || seg.key}</span>
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
  // px, not %: each column sizes to its content, and a percentage height against
  // an auto-height parent resolves to zero — every bar then collapsed to its minimum
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

export default function DashboardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const api = useApi();
  const { toast } = useToast();

  const [stats, setStats] = useState<Stats | null>(null);
  const [projectName, setProjectName] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get(`/api/projects/${projectId}/stats`),
      api.get(`/api/projects/${projectId}`),
    ])
      .then(([s, p]) => {
        setStats(s);
        setProjectName(p.name);
      })
      .catch(() => toast("Failed to load dashboard", "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (loading || !stats) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const completionPct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader title="Dashboard" subtitle={projectName} />

      {/* Summary cards */}
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
          <p className="text-2xl font-bold text-status-in-progress">{stats.statusBreakdown.in_progress || 0}</p>
        </div>
        <div className="bg-bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-text-muted">Completion</p>
          <p className="text-2xl font-bold">{completionPct}%</p>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 mb-8">
        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">Status Breakdown</h2>
          <DonutChart
            data={stats.statusBreakdown}
            colors={STATUS_COLORS}
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
            colors={CATEGORY_COLORS}
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
