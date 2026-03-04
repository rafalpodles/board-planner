"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { STATUS_LABELS, TaskStatus } from "@/types";
import { useToast } from "@/components/ui/Toast";

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
  ready_to_test: "#06b6d4",
  done: "#22c55e",
};

const CATEGORY_COLORS: Record<string, string> = {
  bug: "#ef4444",
  doc: "#3b82f6",
  "user-story": "#22c55e",
  idea: "#f59e0b",
};

function DonutChart({ data, colors }: { data: Record<string, number>; colors: Record<string, string> }) {
  const entries = Object.entries(data).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return <p className="text-sm text-text-muted">No data</p>;

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

function BarChart({ data, label }: { data: { label: string; value: number }[]; label: string }) {
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div>
      <div className="flex items-end gap-1 h-32">
        {data.map((d, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <span className="text-[10px] text-text-muted">{d.value || ""}</span>
            <div
              className="w-full bg-primary rounded-t transition-all"
              style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value > 0 ? 4 : 0 }}
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

function HorizontalBars({ data, colors }: { data: Record<string, number>; colors?: Record<string, string> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map(([, v]) => v), 1);

  if (entries.length === 0) return <p className="text-sm text-text-muted">No data</p>;

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
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <button
          onClick={() => router.push(`/projects/${projectId}`)}
          className="text-text-muted hover:text-text transition-colors"
          title="Back to board"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-2xl font-bold">{projectName} — Dashboard</h1>
      </div>

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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">Status Breakdown</h2>
          <DonutChart data={stats.statusBreakdown} colors={STATUS_COLORS} />
        </div>

        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">Velocity (tasks done/week)</h2>
          <BarChart
            data={stats.velocity.map((v) => ({ label: v.week, value: v.count }))}
            label="Last 8 weeks"
          />
        </div>

        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">By Category</h2>
          <HorizontalBars data={stats.categoryBreakdown} colors={CATEGORY_COLORS} />
        </div>

        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">By Assignee</h2>
          <HorizontalBars data={stats.assigneeBreakdown} />
        </div>

        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">By Difficulty</h2>
          <HorizontalBars data={stats.difficultyBreakdown} />
        </div>

        <div className="bg-bg-card border border-border rounded-lg p-4">
          <h2 className="font-semibold mb-4">Created vs Completed</h2>
          <div className="space-y-1">
            <div className="flex items-end gap-1 h-32">
              {stats.createdOverTime.map((d, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                  <div className="w-full flex flex-col items-center gap-0.5" style={{ height: "100%" }}>
                    <div className="w-full flex gap-px flex-1 items-end">
                      <div
                        className="flex-1 bg-primary/60 rounded-t"
                        style={{
                          height: `${(d.created / Math.max(...stats.createdOverTime.map((x) => Math.max(x.created, x.completed)), 1)) * 100}%`,
                          minHeight: d.created > 0 ? 4 : 0,
                        }}
                      />
                      <div
                        className="flex-1 bg-status-done rounded-t"
                        style={{
                          height: `${(d.completed / Math.max(...stats.createdOverTime.map((x) => Math.max(x.created, x.completed)), 1)) * 100}%`,
                          minHeight: d.completed > 0 ? 4 : 0,
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-1">
              {stats.createdOverTime.map((d, i) => (
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
        </div>
      </div>
    </div>
  );
}
