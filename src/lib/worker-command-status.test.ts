import { describe, it, expect } from "vitest";
import { commandStatus, WorkerCommand } from "./worker-command-status";

const T0 = new Date("2026-08-02T12:00:00.000Z").getTime();

function worker(overrides: {
  command?: "" | WorkerCommand;
  commandIssuedAt?: string | null;
  commandAckedAt?: string | null;
  halt?: { paused: boolean; by: "board" | "machine" | null; command: "pause" | "stop" | null } | null;
}) {
  return {
    command: "pause" as const,
    commandIssuedAt: null,
    commandAckedAt: null,
    ...overrides,
  };
}

describe("commandStatus", () => {
  it("no command at all renders nothing", () => {
    const w = worker({ command: "", commandIssuedAt: new Date(T0).toISOString(), commandAckedAt: null });
    expect(commandStatus(w, T0 + 5_000)).toBeNull();
  });

  it("commandAckedAt null renders pending, never applied", () => {
    const w = worker({ commandIssuedAt: new Date(T0).toISOString(), commandAckedAt: null });
    expect(commandStatus(w, T0 + 5_000)).toEqual({ text: "Pausing…", tone: "pending" });
  });

  it("commandAckedAt equal to commandIssuedAt is not treated as applied", () => {
    const issuedAt = new Date(T0).toISOString();
    const w = worker({ commandIssuedAt: issuedAt, commandAckedAt: issuedAt });
    expect(commandStatus(w, T0 + 5_000)).toEqual({ text: "Pausing…", tone: "pending" });
  });

  it("commandAckedAt after commandIssuedAt renders applied", () => {
    const w = worker({
      commandIssuedAt: new Date(T0).toISOString(),
      commandAckedAt: new Date(T0 + 1_000).toISOString(),
    });
    expect(commandStatus(w, T0 + 5_000)).toEqual({ text: "Paused", tone: "applied" });
  });

  it("unacknowledged under 60s shows the pending label", () => {
    const w = worker({ command: "stop", commandIssuedAt: new Date(T0).toISOString(), commandAckedAt: null });
    expect(commandStatus(w, T0 + 30_000)).toEqual({ text: "Stopping…", tone: "pending" });
  });

  it("unacknowledged over 60s shows elapsed-seconds formatting", () => {
    const w = worker({ commandIssuedAt: new Date(T0).toISOString(), commandAckedAt: null });
    expect(commandStatus(w, T0 + 125_000)).toEqual({
      text: "not acknowledged for 125s",
      tone: "warning",
    });
  });

  it("exactly 60s unacknowledged already reads as the warning, not the pending label", () => {
    const w = worker({ commandIssuedAt: new Date(T0).toISOString(), commandAckedAt: null });
    expect(commandStatus(w, T0 + 60_000)).toEqual({
      text: "not acknowledged for 60s",
      tone: "warning",
    });
  });

  it.each([
    ["pause", "Pausing…", "Paused"],
    ["resume", "Resuming…", "Resumed"],
    ["stop", "Stopping…", "Stopped"],
  ] as const)("%s uses its own pending and applied labels", (command, pending, applied) => {
    const issuedAt = new Date(T0).toISOString();
    const pendingWorker = worker({ command, commandIssuedAt: issuedAt, commandAckedAt: null });
    expect(commandStatus(pendingWorker, T0 + 1_000)).toEqual({ text: pending, tone: "pending" });

    const appliedWorker = worker({
      command,
      commandIssuedAt: issuedAt,
      commandAckedAt: new Date(T0 + 1_000).toISOString(),
    });
    expect(commandStatus(appliedWorker, T0 + 2_000)).toEqual({ text: applied, tone: "applied" });
  });

  // BP-762. The fleet console said nothing of a pause made at the machine, and "Paused" of one the
  // machine had since resumed
  describe("what the machine says it is doing", () => {
    const acked = { commandIssuedAt: new Date(T0).toISOString(), commandAckedAt: new Date(T0 + 1_000).toISOString() };

    it.each([
      ["pause", "Paused on the machine"],
      ["stop", "Stopped on the machine"],
    ] as const)("a %s made at the machine shows with no board command behind it", (command, text) => {
      const w = worker({ command: "", halt: { paused: true, by: "machine", command } });
      expect(commandStatus(w, T0)).toEqual({ text, tone: "applied" });
    });

    it("a board pause the machine resumed reads as resumed there, not as paused", () => {
      const w = worker({ ...acked, halt: { paused: false, by: null, command: null } });
      expect(commandStatus(w, T0 + 2_000)).toEqual({ text: "Resumed on the machine", tone: "applied" });
    });

    it("a board command still on its way shows as on its way, whatever the machine did before it", () => {
      const w = worker({
        command: "stop",
        commandIssuedAt: new Date(T0).toISOString(),
        halt: { paused: true, by: "machine", command: "pause" },
      });
      expect(commandStatus(w, T0 + 1_000)).toEqual({ text: "Stopping…", tone: "pending" });
    });

    it("the board's own pause, reported as the board's, keeps the command's label", () => {
      const w = worker({ ...acked, halt: { paused: true, by: "board", command: "pause" } });
      expect(commandStatus(w, T0 + 2_000)).toEqual({ text: "Paused", tone: "applied" });
    });

    it("a resume the board issued and the machine applied stays Resumed", () => {
      const w = worker({ command: "resume", ...acked, halt: { paused: false, by: null, command: null } });
      expect(commandStatus(w, T0 + 2_000)).toEqual({ text: "Resumed", tone: "applied" });
    });
  });
});
