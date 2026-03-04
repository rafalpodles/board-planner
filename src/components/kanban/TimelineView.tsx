"use client";

import { useMemo, useRef, useEffect } from "react";
import { ApiTask, STATUS_LABELS } from "@/types";

interface TimelineViewProps {
  tasks: ApiTask[];
  projectKey: string;
  onTaskClick: (taskId: string) => void;
}

const ROW_HEIGHT = 36;
const DAY_WIDTH = 40;
const HEADER_HEIGHT = 50;
const LEFT_LABEL_WIDTH = 220;
const PADDING_DAYS_BEFORE = 14;
const PADDING_DAYS_AFTER = 28;

const STATUS_COLORS: Record<string, string> = {
  planned: "#6b7280",
  todo: "#3b82f6",
  in_progress: "#f59e0b",
  in_review: "#8b5cf6",
  needs_human_review: "#ec4899",
  ready_to_test: "#06b6d4",
  done: "#22c55e",
};

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

function formatMonth(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export function TimelineView({ tasks, projectKey, onTaskClick }: TimelineViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const timelineStart = useMemo(() => addDays(today, -PADDING_DAYS_BEFORE), [today]);
  const timelineEnd = useMemo(() => addDays(today, PADDING_DAYS_AFTER), [today]);
  const totalDays = diffDays(timelineEnd, timelineStart);

  // Sort tasks: by dueDate (nulls last), then by createdAt
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      if (a.dueDate && b.dueDate) return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }, [tasks]);

  // Build task index for dependency arrows
  const taskIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    sortedTasks.forEach((t, i) => map.set(t._id, i));
    return map;
  }, [sortedTasks]);

  // Scroll to today on mount
  useEffect(() => {
    if (scrollRef.current) {
      const todayX = PADDING_DAYS_BEFORE * DAY_WIDTH;
      scrollRef.current.scrollLeft = Math.max(0, todayX - 200);
    }
  }, []);

  const svgWidth = totalDays * DAY_WIDTH;
  const svgHeight = HEADER_HEIGHT + sortedTasks.length * ROW_HEIGHT + 20;

  // Generate day columns
  const days: { date: Date; x: number }[] = [];
  for (let i = 0; i < totalDays; i++) {
    days.push({ date: addDays(timelineStart, i), x: i * DAY_WIDTH });
  }

  // Generate month labels
  const months: { label: string; x: number; width: number }[] = [];
  let currentMonth = "";
  let monthStart = 0;
  for (let i = 0; i <= totalDays; i++) {
    const d = addDays(timelineStart, i);
    const label = formatMonth(d);
    if (label !== currentMonth) {
      if (currentMonth) {
        months.push({ label: currentMonth, x: monthStart * DAY_WIDTH, width: (i - monthStart) * DAY_WIDTH });
      }
      currentMonth = label;
      monthStart = i;
    }
  }
  if (currentMonth) {
    months.push({ label: currentMonth, x: monthStart * DAY_WIDTH, width: (totalDays - monthStart) * DAY_WIDTH });
  }

  const todayX = diffDays(today, timelineStart) * DAY_WIDTH;

  if (tasks.length === 0) return null;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex">
        {/* Left labels */}
        <div className="shrink-0 border-r border-border bg-bg-card" style={{ width: LEFT_LABEL_WIDTH }}>
          <div className="h-[50px] border-b border-border flex items-end px-3 pb-1">
            <span className="text-xs font-medium text-text-muted">Task</span>
          </div>
          {sortedTasks.map((task) => (
            <div
              key={task._id}
              className="flex items-center gap-2 px-3 border-b border-border/50 cursor-pointer hover:bg-bg-hover transition-colors"
              style={{ height: ROW_HEIGHT }}
              onClick={() => onTaskClick(task._id)}
            >
              <span className="text-[10px] font-mono text-text-muted whitespace-nowrap">
                {projectKey}-{task.taskNumber}
              </span>
              <span className="text-xs truncate flex-1">{task.title}</span>
            </div>
          ))}
        </div>

        {/* Timeline area */}
        <div ref={scrollRef} className="flex-1 overflow-x-auto">
          <svg width={svgWidth} height={svgHeight} className="block">
            {/* Month headers */}
            {months.map((m, i) => (
              <g key={i}>
                <rect x={m.x} y={0} width={m.width} height={22} className="fill-bg-input" />
                <text x={m.x + 8} y={16} className="fill-text-muted text-[11px]">{m.label}</text>
                <line x1={m.x} y1={0} x2={m.x} y2={HEADER_HEIGHT} className="stroke-border" />
              </g>
            ))}

            {/* Day headers */}
            {days.map((d, i) => {
              const day = d.date.getDate();
              const isWeekend = d.date.getDay() === 0 || d.date.getDay() === 6;
              return (
                <g key={i}>
                  {isWeekend && (
                    <rect x={d.x} y={HEADER_HEIGHT} width={DAY_WIDTH} height={svgHeight - HEADER_HEIGHT} className="fill-bg-input/30" />
                  )}
                  <text
                    x={d.x + DAY_WIDTH / 2}
                    y={42}
                    textAnchor="middle"
                    className={`text-[10px] ${isWeekend ? "fill-text-muted/50" : "fill-text-muted"}`}
                  >
                    {day}
                  </text>
                  <line x1={d.x} y1={HEADER_HEIGHT} x2={d.x} y2={svgHeight} className="stroke-border/30" />
                </g>
              );
            })}

            {/* Header bottom line */}
            <line x1={0} y1={HEADER_HEIGHT} x2={svgWidth} y2={HEADER_HEIGHT} className="stroke-border" />

            {/* Row separators */}
            {sortedTasks.map((_, i) => (
              <line
                key={i}
                x1={0}
                y1={HEADER_HEIGHT + (i + 1) * ROW_HEIGHT}
                x2={svgWidth}
                y2={HEADER_HEIGHT + (i + 1) * ROW_HEIGHT}
                className="stroke-border/30"
              />
            ))}

            {/* Dependency arrows */}
            {sortedTasks.map((task, taskIdx) => {
              if (!task.blockedBy || task.blockedBy.length === 0) return null;
              return task.blockedBy.map((dep) => {
                const depId = typeof dep === "object" ? dep._id : dep;
                const depIdx = taskIndexMap.get(depId);
                if (depIdx === undefined) return null;

                const depTask = sortedTasks[depIdx];
                const depEndDate = depTask.dueDate ? new Date(depTask.dueDate) : new Date(depTask.createdAt);
                const taskStartDate = new Date(task.createdAt);

                const x1 = Math.max(0, diffDays(depEndDate, timelineStart)) * DAY_WIDTH;
                const y1 = HEADER_HEIGHT + depIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
                const x2 = Math.max(0, diffDays(taskStartDate, timelineStart)) * DAY_WIDTH;
                const y2 = HEADER_HEIGHT + taskIdx * ROW_HEIGHT + ROW_HEIGHT / 2;

                return (
                  <g key={`${depId}-${task._id}`}>
                    <line
                      x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke="#f59e0b"
                      strokeWidth={1.5}
                      strokeDasharray="4 2"
                      opacity={0.6}
                    />
                    {/* Arrowhead */}
                    <circle cx={x2} cy={y2} r={3} fill="#f59e0b" opacity={0.6} />
                  </g>
                );
              });
            })}

            {/* Task bars */}
            {sortedTasks.map((task, i) => {
              const y = HEADER_HEIGHT + i * ROW_HEIGHT + 8;
              const barHeight = ROW_HEIGHT - 16;
              const color = STATUS_COLORS[task.status] || STATUS_COLORS.planned;
              const created = new Date(task.createdAt);

              if (task.dueDate) {
                const due = new Date(task.dueDate);
                const startX = Math.max(0, diffDays(created, timelineStart)) * DAY_WIDTH;
                const endX = Math.max(startX + DAY_WIDTH / 2, diffDays(due, timelineStart) * DAY_WIDTH);
                const barWidth = Math.max(8, endX - startX);

                return (
                  <g key={task._id} className="cursor-pointer" onClick={() => onTaskClick(task._id)}>
                    <rect
                      x={startX}
                      y={y}
                      width={barWidth}
                      height={barHeight}
                      rx={4}
                      fill={color}
                      opacity={0.8}
                    />
                    <title>{`${projectKey}-${task.taskNumber}: ${task.title}\n${STATUS_LABELS[task.status]}`}</title>
                  </g>
                );
              }

              // No due date — show as diamond marker
              const x = Math.max(0, diffDays(created, timelineStart)) * DAY_WIDTH + DAY_WIDTH / 2;
              return (
                <g key={task._id} className="cursor-pointer" onClick={() => onTaskClick(task._id)}>
                  <rect
                    x={x - 6}
                    y={y + barHeight / 2 - 6}
                    width={12}
                    height={12}
                    rx={2}
                    fill={color}
                    opacity={0.7}
                    transform={`rotate(45 ${x} ${y + barHeight / 2})`}
                  />
                  <title>{`${projectKey}-${task.taskNumber}: ${task.title}\n${STATUS_LABELS[task.status]} (no due date)`}</title>
                </g>
              );
            })}

            {/* Today line */}
            <line
              x1={todayX}
              y1={HEADER_HEIGHT}
              x2={todayX}
              y2={svgHeight}
              stroke="#ef4444"
              strokeWidth={2}
              strokeDasharray="6 3"
              opacity={0.7}
            />
            <text x={todayX + 4} y={HEADER_HEIGHT + 14} className="fill-[#ef4444] text-[10px] font-medium">
              Today
            </text>
          </svg>
        </div>
      </div>
    </div>
  );
}
