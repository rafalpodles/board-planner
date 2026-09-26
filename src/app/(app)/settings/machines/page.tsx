"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { usePollWhileVisible } from "@/hooks/use-poll-while-visible";
import { Button } from "@/components/ui/Button";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { EnrolWorkerModal } from "@/components/settings/EnrolWorkerModal";
import { GETTING_THE_SOFTWARE_URL } from "@/lib/docs-urls";
import { LIST_REFRESH_FAILED } from "@/lib/list-refresh";
import { timeAgo } from "@/lib/time";
import type { ApiMyMachine } from "@/types";

const POLL_MS = 15_000;

function describeState(machine: ApiMyMachine): { text: string; tone: string } {
  const byMachine = machine.haltedBy === "machine";
  switch (machine.state) {
    case "live":
      return machine.checkouts > 0
        ? { text: "Running", tone: "text-success" }
        : { text: "Running, no checkouts yet", tone: "text-text-muted" };
    case "failing":
      return { text: "Sandbox check failing — the menubar app says what to fix", tone: "text-danger" };
    case "stale":
      return { text: "Not reporting", tone: "text-danger" };
    case "disabled":
      return { text: "Switched off by an instance admin", tone: "text-danger" };
    case "paused":
      return {
        text: byMachine ? "Paused on the machine" : "Paused by an instance admin",
        tone: "text-warning",
      };
    case "stopped":
      return {
        text: byMachine ? "Stopped on the machine" : "Stopped by an instance admin",
        tone: "text-warning",
      };
  }
}

export default function MachinesPage() {
  const api = useApi();
  const [machines, setMachines] = useState<ApiMyMachine[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const latestRead = useRef(0);

  const load = useCallback(async () => {
    const read = ++latestRead.current;
    try {
      const rows: ApiMyMachine[] = await api.get("/api/users/me/machines");
      if (read !== latestRead.current) return;
      setMachines(rows);
      setFailed(false);
    } catch {
      if (read === latestRead.current) setFailed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePollWhileVisible(load, POLL_MS);

  function closeDialog() {
    setConnecting(false);
    void load();
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 grow basis-48">
          <h2 className="mb-1 text-lg font-semibold">Machines</h2>
          <p className="text-sm text-text-muted">
            The machines you connected. A machine takes only tasks you assigned to yourself — or asked
            the PM agent to assign to you — that name an agent, in projects you can reach.
          </p>
        </div>
        <Button onClick={() => setConnecting(true)}>Connect a machine</Button>
      </div>

      <p className="mb-6 text-sm text-text-muted">
        On a Mac, the menubar app connects the machine for you —{" "}
        <a href={GETTING_THE_SOFTWARE_URL} target="_blank" rel="noreferrer" className="text-primary underline">
          Getting the software
        </a>
        . A Linux box or a container is connected here, with a single-use token.
      </p>

      <EnrolWorkerModal open={connecting} onClose={closeDialog} title="Connect a machine" />

      {failed && machines !== null && (
        <p role="status" className="mb-3 text-sm text-warning">
          {LIST_REFRESH_FAILED}
        </p>
      )}

      {failed && machines === null ? (
        <LoadFailed message="Could not load your machines." onRetry={() => void load()} />
      ) : machines === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : machines.length === 0 ? (
        <p data-testid="no-machines" className="text-sm text-text-muted">
          You have not connected a machine yet.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-bg-card">
          {machines.map((machine) => {
            const state = describeState(machine);
            return (
              <li
                key={machine._id}
                data-testid="my-machine"
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm"
              >
                <div className="min-w-0 grow basis-48">
                  <p className="break-words font-medium">{machine.name}</p>
                  <p className="break-words text-xs text-text-muted">
                    {[
                      machine.host || "—",
                      machine.version && `worker ${machine.version}`,
                      machine.checkouts > 0 &&
                        `${machine.checkouts} checkout${machine.checkouts === 1 ? "" : "s"}`,
                      machine.lastSeenAt ? `last seen ${timeAgo(machine.lastSeenAt)}` : "never seen",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <span data-testid="my-machine-state" className={`text-xs ${state.tone}`}>
                  {state.text}
                </span>
                <Link
                  href={`/settings/workers/${machine._id}/projects`}
                  aria-label={`Choose projects for ${machine.name}`}
                  className="text-sm text-primary underline"
                >
                  Choose projects
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
