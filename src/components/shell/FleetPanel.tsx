"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { usePollWhileVisible } from "@/hooks/use-poll-while-visible";
import { runLook } from "@/lib/run-state";
import { taskPath } from "@/lib/urls";
import type { ApiFleetMachine, FleetState } from "@/types";

// A third of the board's rate: the panel sits on every page, the board on one
export const FLEET_POLL_MS = 30_000;

const LABELS: Record<FleetState, string> = {
  running: "Working",
  quiet: "Quiet",
  idle: "Idle",
  paused: "Paused",
  offline: "Offline",
  off: "Switched off",
};

const AT_REST_DOT: Record<Exclude<FleetState, "running" | "quiet">, string> = {
  idle: "bg-success",
  paused: "bg-warning",
  offline: "bg-text-muted/50",
  off: "bg-text-muted/50",
};

function dotOf(state: FleetState): string {
  if (state === "running" || state === "quiet") return runLook(state === "quiet" ? "quiet" : "live").dot;
  return AT_REST_DOT[state];
}

function MachineRow({ machine }: { machine: ApiFleetMachine }) {
  const task = machine.task && !("hidden" in machine.task) ? machine.task : null;
  const detail = task
    ? `${task.key}${task.phase ? ` · ${task.phase}` : ""}`
    : machine.task
      ? "on a board you cannot open"
      : LABELS[machine.state];
  const body = (
    <>
      <span aria-hidden="true" className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotOf(machine.state)}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-text">{machine.name}</span>
        <span className="block truncate text-[11px] text-text-muted" title={task?.title ?? (machine.task ? "On a board you cannot open" : undefined)}>
          {task || machine.task ? `${LABELS[machine.state]} · ${detail}` : detail}
        </span>
      </span>
    </>
  );
  const className = "flex items-start gap-2 rounded-lg px-2.5 py-1.5";
  return (
    <li data-testid="fleet-machine" data-state={machine.state}>
      {task ? (
        <Link
          href={taskPath(task.projectKey, task.taskNumber)}
          title={task.title}
          className={`focus-ring ${className} transition-colors hover:bg-bg-hover`}
        >
          {body}
        </Link>
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  );
}

export function FleetPanel() {
  const api = useApi();
  const [machines, setMachines] = useState<ApiFleetMachine[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(true);
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    api
      .get("/api/fleet")
      .then((rows: ApiFleetMachine[]) => {
        if (mine !== seq.current) return;
        setMachines(rows);
        setFailed(false);
      })
      .catch(() => {
        if (mine === seq.current) setFailed(true);
      });
  }, [api]);

  usePollWhileVisible(load, FLEET_POLL_MS);

  const working = machines?.filter((m) => m.state === "running" || m.state === "quiet").length ?? 0;

  return (
    <section aria-labelledby="fleet-heading" data-testid="fleet-panel">
      <div className="mb-1.5 ml-2.5 flex items-center gap-1">
        <button
          type="button"
          id="fleet-heading"
          aria-expanded={open}
          aria-controls="fleet-list"
          onClick={() => setOpen((o) => !o)}
          className="focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded text-[10.5px] font-bold uppercase tracking-wider text-text-muted transition-colors hover:text-text md:min-h-0"
        >
          Machines
          {working > 0 && (
            <span className="rounded-full bg-bg-input px-1.5 text-[10px] font-semibold normal-case tracking-normal text-text">
              {working} working
            </span>
          )}
        </button>
      </div>
      {open && (
        <div id="fleet-list">
          {machines === null ? (
            failed ? (
              <p className="px-2.5 text-[12px] text-text-muted">Could not load machines.</p>
            ) : null
          ) : machines.length === 0 ? (
            <p className="px-2.5 text-[12px] text-text-muted">
              No machines connected.{" "}
              <Link href="/settings/machines" className="focus-ring rounded text-primary hover:underline">
                Connect one
              </Link>
            </p>
          ) : (
            <ul className="space-y-0.5">
              {machines.map((machine) => (
                <MachineRow key={machine._id} machine={machine} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
