"use client";

import Link from "next/link";
import type { AgingTask, FinishedPoint, Insights, Spread } from "@/lib/insights";
import { formatDuration, formatWeek, niceCeiling } from "@/lib/insights-format";
import { taskPath } from "@/lib/urls";

export type Measure = "cycleTime" | "leadTime";

export const MEASURE_LABELS: Record<Measure, string> = {
  cycleTime: "Cycle time",
  leadTime: "Lead time",
};

const WIDTH = 480;
const HEIGHT = 220;
const PAD = { top: 14, right: 8, bottom: 26, left: 56 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
const DAY = 86_400_000;

function Panel({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="rounded-lg border border-border bg-bg-card p-4" data-testid={testId} aria-label={title}>
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="flex h-32 items-center justify-center rounded border border-dashed border-border px-4">
      <p className="text-center text-xs text-text-muted">{message}</p>
    </div>
  );
}

function AsTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="focus-ring w-fit cursor-pointer rounded text-text-muted hover:text-text">Show as table</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="text-text-muted">
              {head.map((h) => (
                <th key={h} scope="col" className="py-1 pr-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-border">
                {row.map((cell, j) => (
                  <td key={j} className="py-1 pr-3 tabular-nums">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function YAxis({ max, format, ticks = [0, 0.5, 1] }: { max: number; format: (v: number) => string; ticks?: number[] }) {
  return (
    <g>
      {ticks.map((f) => {
        const y = PAD.top + PLOT_H * (1 - f);
        return (
          <g key={f}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} className="stroke-border" strokeWidth={1} />
            <text x={PAD.left - 6} y={y} dy="0.32em" textAnchor="end" className="fill-text-muted text-[12px]">
              {f === 0 ? "0" : format(max * f)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function axisDays(max: number) {
  return niceCeiling(Math.max(max, DAY) / DAY) * DAY;
}

export function StatTiles({ insights, noDoneColumn }: { insights: Insights; noDoneColumn: boolean }) {
  const { summary, agingWip, window } = insights;
  const over = agingWip.referenceP85Ms === null ? null : agingWip.tasks.filter((t) => t.ageMs > agingWip.referenceP85Ms!).length;
  const tile = (label: string, value: string, note: string) => (
    <div className="rounded-lg border border-border bg-bg-card p-4">
      <p className="text-sm text-text-muted">{label}</p>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-text-muted">{note}</p>
    </div>
  );
  const spreadNote = (s: Spread | null) => (s ? `85% within ${formatDuration(s.p85Ms)}` : "Nothing finished yet");
  return (
    <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="insights-tiles">
      {tile("Cycle time (median)", formatDuration(summary.cycleTime?.medianMs), spreadNote(summary.cycleTime))}
      {tile("Lead time (median)", formatDuration(summary.leadTime?.medianMs), spreadNote(summary.leadTime))}
      {tile(
        "Throughput",
        noDoneColumn ? "—" : String(summary.throughput),
        noDoneColumn ? "No Done column" : `finished in ${window.weeks} ${window.weeks === 1 ? "week" : "weeks"}`
      )}
      {tile(
        "In progress",
        String(agingWip.tasks.length),
        over === null ? "No finished work to compare with" : `${over} older than 85% of finished work`
      )}
    </div>
  );
}

export function TrendChart({ insights, measure }: { insights: Insights; measure: Measure }) {
  const weeks = insights.weekly;
  const values = weeks.map((w) => w[measure]);
  const title = `${MEASURE_LABELS[measure]} per week`;
  if (!values.some(Boolean)) {
    return (
      <Panel title={title} testId="insights-trend">
        <EmptyPanel message="No task finished in this window, so there is no time to plot yet." />
      </Panel>
    );
  }
  const max = axisDays(Math.max(...values.map((v) => v?.p85Ms ?? 0)));
  const x = (i: number) => PAD.left + (weeks.length === 1 ? PLOT_W / 2 : (i / (weeks.length - 1)) * PLOT_W);
  const y = (ms: number) => PAD.top + PLOT_H * (1 - ms / max);
  const path = (pick: (s: Spread) => number) =>
    values
      .map((v, i) => (v ? `${values[i - 1] ? "L" : "M"}${x(i).toFixed(1)},${y(pick(v)).toFixed(1)}` : ""))
      .join("");
  const description = `${title}: median and 85th percentile for each of the last ${weeks.length} weeks.`;
  return (
    <Panel title={title} testId="insights-trend">
      <div className="mb-2 flex gap-4 text-xs text-text-muted">
        <span className="flex items-center gap-1">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" x2="18" y1="3" y2="3" className="stroke-primary" strokeWidth={2} />
          </svg>
          Median
        </span>
        <span className="flex items-center gap-1">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" x2="18" y1="3" y2="3" className="stroke-primary" strokeWidth={2} strokeDasharray="4 3" />
          </svg>
          85th percentile
        </span>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="img" aria-label={description}>
        <YAxis max={max} format={formatDuration} />
        <path d={path((s) => s.p85Ms)} fill="none" className="stroke-primary" strokeWidth={2} strokeDasharray="5 4" opacity={0.7} />
        <path d={path((s) => s.medianMs)} fill="none" className="stroke-primary" strokeWidth={2} />
        {values.map((v, i) =>
          v ? (
            <g key={i}>
              <circle cx={x(i)} cy={y(v.medianMs)} r={4} className="fill-primary stroke-bg-card" strokeWidth={2}>
                <title>{`Week of ${formatWeek(weeks[i].weekStart)}: median ${formatDuration(v.medianMs)}, 85% within ${formatDuration(v.p85Ms)}, ${v.count} finished`}</title>
              </circle>
            </g>
          ) : null
        )}
        {weeks.map((w, i) =>
          i % Math.ceil(weeks.length / 4) === 0 ? (
            <text key={i} x={x(i)} y={HEIGHT - 6} textAnchor="middle" className="fill-text-muted text-[12px]">
              {formatWeek(w.weekStart)}
            </text>
          ) : null
        )}
      </svg>
      <AsTable
        caption={description}
        head={["Week of", "Median", "85th percentile", "Finished"]}
        rows={weeks.map((w, i) => [
          formatWeek(w.weekStart),
          formatDuration(values[i]?.medianMs),
          formatDuration(values[i]?.p85Ms),
          values[i]?.count ?? 0,
        ])}
      />
    </Panel>
  );
}

export function ScatterChart({
  insights,
  measure,
  projectRef,
}: {
  insights: Insights;
  measure: Measure;
  projectRef: string;
}) {
  const title = `${MEASURE_LABELS[measure]} of each finished task`;
  const points = insights.finished.points.filter((p) => valueOf(p, measure) !== null);
  if (points.length === 0) {
    return (
      <Panel title={title} testId="insights-scatter">
        <EmptyPanel message="Each finished task becomes a dot here, placed by the day it finished." />
      </Panel>
    );
  }
  const from = Date.parse(insights.window.from);
  const to = Date.parse(insights.window.to);
  const summary = insights.summary[measure];
  const max = axisDays(Math.max(...points.map((p) => valueOf(p, measure)!), summary?.p85Ms ?? 0));
  const x = (iso: string) => PAD.left + ((Date.parse(iso) - from) / Math.max(1, to - from)) * PLOT_W;
  const y = (ms: number) => PAD.top + PLOT_H * (1 - ms / max);
  const description = `${title}: ${points.length} tasks, by finish date and ${MEASURE_LABELS[measure].toLowerCase()}.`;
  return (
    <Panel title={title} testId="insights-scatter">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="img" aria-label={description}>
        <YAxis max={max} format={formatDuration} />
        {summary &&
          ([
            ["50%", summary.medianMs],
            ["85%", summary.p85Ms],
          ] as const).map(([label, ms]) => (
            <g key={label}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(ms)}
                y2={y(ms)}
                className="stroke-text-muted"
                strokeWidth={1}
                strokeDasharray="4 3"
              />
              <text x={WIDTH - PAD.right} y={y(ms) - 4} textAnchor="end" className="fill-text-muted text-[12px]">
                {`${label}: ${formatDuration(ms)}`}
              </text>
            </g>
          ))}
        {points.map((p) => (
          <circle
            key={p.taskNumber}
            cx={x(p.finishedAt)}
            cy={y(valueOf(p, measure)!)}
            r={4}
            className="fill-primary stroke-bg-card"
            strokeWidth={2}
            opacity={0.85}
          >
            <title>{`${projectRef}-${p.taskNumber} ${p.title}: ${formatDuration(valueOf(p, measure))}, finished ${new Date(p.finishedAt).toLocaleDateString()}`}</title>
          </circle>
        ))}
      </svg>
      {insights.finished.truncated && (
        <p className="mt-2 text-xs text-text-muted">Showing the latest {points.length} tasks.</p>
      )}
      <AsTable
        caption={description}
        head={["Task", "Finished", MEASURE_LABELS[measure]]}
        rows={points.map((p) => [
          `${projectRef}-${p.taskNumber} ${p.title}`,
          new Date(p.finishedAt).toLocaleDateString(),
          formatDuration(valueOf(p, measure)),
        ])}
      />
    </Panel>
  );
}

function valueOf(point: FinishedPoint, measure: Measure): number | null {
  return measure === "cycleTime" ? point.cycleMs : point.leadMs;
}

export function ThroughputChart({ insights, noDoneColumn }: { insights: Insights; noDoneColumn: boolean }) {
  const weeks = insights.weekly;
  const title = "Throughput per week";
  if (noDoneColumn || !weeks.some((w) => w.throughput > 0)) {
    return (
      <Panel title={title} testId="insights-throughput">
        <EmptyPanel
          message={
            noDoneColumn
              ? "This board has no column meaning Done, so nothing can count as finished."
              : "No task finished in this window yet. Each week a task reaches Done adds to its bar."
          }
        />
      </Panel>
    );
  }
  const max = niceCeiling(Math.max(...weeks.map((w) => w.throughput)));
  const slot = PLOT_W / weeks.length;
  const barWidth = Math.max(4, slot - 6);
  const description = `${title}: tasks finished in each of the last ${weeks.length} weeks.`;
  return (
    <Panel title={title} testId="insights-throughput">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="img" aria-label={description}>
        <YAxis max={max} format={(v) => String(v)} ticks={max % 2 === 0 ? [0, 0.5, 1] : [0, 1]} />
        {weeks.map((w, i) => {
          const h = (w.throughput / max) * PLOT_H;
          const x = PAD.left + i * slot + (slot - barWidth) / 2;
          return (
            <g key={w.weekStart}>
              {w.throughput > 0 && (
                <rect x={x} y={PAD.top + PLOT_H - h} width={barWidth} height={h} rx={3} className="fill-primary">
                  <title>{`Week of ${formatWeek(w.weekStart)}: ${w.throughput} finished`}</title>
                </rect>
              )}
              {i % Math.ceil(weeks.length / 4) === 0 && (
                <text x={x + barWidth / 2} y={HEIGHT - 6} textAnchor="middle" className="fill-text-muted text-[12px]">
                  {formatWeek(w.weekStart)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <AsTable
        caption={description}
        head={["Week of", "Finished"]}
        rows={weeks.map((w) => [formatWeek(w.weekStart), w.throughput])}
      />
    </Panel>
  );
}

export function AgingList({
  insights,
  projectRef,
  linkTasks,
}: {
  insights: Insights;
  projectRef: string;
  linkTasks: boolean;
}) {
  const { tasks, referenceP85Ms } = insights.agingWip;
  const title = "Work in progress, oldest first";
  if (tasks.length === 0) {
    return (
      <Panel title={title} testId="insights-aging">
        <EmptyPanel message="Nothing is in progress. A task shows here from the moment it enters an In Progress column." />
      </Panel>
    );
  }
  const label = (t: AgingTask) => `${projectRef}-${t.taskNumber}`;
  return (
    <Panel title={title} testId="insights-aging">
      <ul className="divide-y divide-border">
        {tasks.slice(0, 15).map((t) => {
          const late = referenceP85Ms !== null && t.ageMs > referenceP85Ms;
          return (
            <li key={t.taskNumber} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
              {linkTasks ? (
                <Link href={taskPath(projectRef, t.taskNumber)} className="focus-ring shrink-0 rounded font-mono text-xs text-primary underline">
                  {label(t)}
                </Link>
              ) : (
                <span className="shrink-0 font-mono text-xs text-text-muted">{label(t)}</span>
              )}
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              <span className="shrink-0 tabular-nums">{formatDuration(t.ageMs)}</span>
              <span className={`w-full text-xs sm:w-auto ${late ? "font-medium text-warning" : "text-text-muted"}`}>
                {t.olderThanPercent === null
                  ? "No finished work to compare with"
                  : `${late ? "⚠ " : ""}Older than ${t.olderThanPercent}% of finished work`}
              </span>
            </li>
          );
        })}
      </ul>
      {tasks.length > 15 && <p className="mt-2 text-xs text-text-muted">And {tasks.length - 15} more in progress.</p>}
    </Panel>
  );
}

export function DeploymentsPanel() {
  return (
    <Panel title="Deployments (DORA)" testId="insights-dora">
      <EmptyPanel message="No deployments are connected to this board, so deployment frequency and lead time for changes cannot be measured yet." />
    </Panel>
  );
}
