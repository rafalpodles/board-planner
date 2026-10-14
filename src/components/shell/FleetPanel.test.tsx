// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApiFleetMachine } from "@/types";

const api = { get: vi.fn() };
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));

const { FleetPanel, FLEET_POLL_MS } = await import("./FleetPanel");

const machine = (over: Partial<ApiFleetMachine>): ApiFleetMachine => ({ _id: "w1", name: "rpo-mbp", state: "idle", ...over });

beforeEach(() => {
  api.get.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function showing(rows: ApiFleetMachine[]) {
  api.get.mockResolvedValue(rows);
  render(<FleetPanel />);
  await act(async () => {});
}

describe("FleetPanel", () => {
  it("names the task a working machine holds, its phase, and opens it", async () => {
    await showing([
      machine({ state: "running", task: { key: "BP-7", title: "Ship it", phase: "agent", projectKey: "BP", taskNumber: 7 } }),
    ]);
    const link = screen.getByRole("link", { name: /rpo-mbp/ });
    expect(link.getAttribute("href")).toBe("/projects/BP/tasks/7");
    expect(link.textContent).toContain("Working · BP-7 · agent");
    expect(link.getAttribute("title")).toBe("Ship it");
    expect(screen.getByText("1 working")).toBeTruthy();
  });

  it("says a run has gone quiet", async () => {
    await showing([machine({ state: "quiet", task: { key: "BP-7", title: "t", projectKey: "BP", taskNumber: 7 } })]);
    expect(screen.getByTestId("fleet-machine").getAttribute("data-state")).toBe("quiet");
    expect(screen.getByText("Quiet · BP-7")).toBeTruthy();
  });

  it("names nothing about a task on a project the reader cannot open, and links nowhere", async () => {
    await showing([machine({ state: "running", task: { hidden: true } })]);
    expect(screen.getByText("Working · On a project you cannot open")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows an idle machine as idle", async () => {
    await showing([machine({ state: "idle" })]);
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.queryByText(/working/)).toBeNull();
  });

  it("says so when no machine is connected, rather than drawing an empty box", async () => {
    await showing([]);
    expect(screen.getByText(/No machines connected/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect one" }).getAttribute("href")).toBe("/settings/machines");
  });

  it("says a failed read failed", async () => {
    api.get.mockRejectedValue(new Error("down"));
    render(<FleetPanel />);
    await act(async () => {});
    expect(screen.getByText("Could not load machines.")).toBeTruthy();
  });

  it("folds away", async () => {
    await showing([machine({})]);
    fireEvent.click(screen.getByRole("button", { name: /Machines/ }));
    expect(screen.queryByText("rpo-mbp")).toBeNull();
  });

  it("reads again on its own slower clock, not the board's", async () => {
    vi.useFakeTimers();
    api.get.mockResolvedValue([]);
    render(<FleetPanel />);
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(10_000));
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(FLEET_POLL_MS - 10_000));
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(FLEET_POLL_MS).toBeGreaterThanOrEqual(30_000);
  });
});
