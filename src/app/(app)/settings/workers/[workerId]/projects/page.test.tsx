// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { LIST_REFRESH_FAILED } from "@/lib/list-refresh";
import MachineProjectsPage from "./page";

/**
 * BP-585. The catalogue was re-read under the same `try` as the PUT that saved it, so a failed
 * re-read painted "Could not save" beside the "Saved." the same handler had just set — one save,
 * two contradictory answers.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("next/navigation", () => ({ useParams: () => ({ workerId: "w1" }) }));

const VIEW = {
  worker: { _id: "w1", name: "Studio", host: "studio.local" },
  canEnableWorkers: true,
  catalogue: [
    {
      project: "p1",
      key: "BP",
      name: "Board Planner",
      repositoryUrl: "git@github.com:rafalpodles/board-planner.git",
      available: true,
      workersEnabled: true,
      servedHere: true,
      wanted: true,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(VIEW);
  api.put.mockResolvedValue({ leftDisabled: [] });
});
afterEach(cleanup);

async function saveOnce() {
  render(<MachineProjectsPage />);
  await screen.findByRole("button", { name: "Save" });
  await act(async () => {
    screen.getByRole("button", { name: "Save" }).click();
  });
}

describe("saving the machine's projects", () => {
  it("says the list is stale, not that the save failed, when only the re-read fails", async () => {
    api.get.mockResolvedValueOnce(VIEW).mockRejectedValueOnce(new Error("read timed out"));

    await saveOnce();

    await waitFor(() => expect(screen.getByText(LIST_REFRESH_FAILED)).toBeTruthy());
    // The save landed, and the screen still says so
    expect(screen.getByText(/^Saved\./)).toBeTruthy();
    expect(screen.queryByText("read timed out")).toBeNull();
    expect(screen.queryByText("Could not save")).toBeNull();
  });

  it("says the save failed, and claims nothing was saved, when the write fails", async () => {
    api.put.mockRejectedValueOnce(new Error("the machine is gone"));

    await saveOnce();

    await waitFor(() => expect(screen.getByText("the machine is gone")).toBeTruthy());
    expect(screen.queryByText(/^Saved\./)).toBeNull();
    expect(screen.queryByText(LIST_REFRESH_FAILED)).toBeNull();
    // The failed write is not followed by a read
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  // The control: nothing above would notice a handler that stopped saying anything at all
  it("says only that it saved when both calls land", async () => {
    await saveOnce();

    await waitFor(() => expect(screen.getByText(/^Saved\./)).toBeTruthy());
    expect(screen.queryByText(LIST_REFRESH_FAILED)).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  // The line that clears "Saved." exists for a second save, and every test above performs one
  // from a clean screen where there is nothing to clear
  it("does not leave the previous Saved. standing when a second save fails", async () => {
    await saveOnce();
    await waitFor(() => expect(screen.getByText(/^Saved\./)).toBeTruthy());

    api.put.mockRejectedValueOnce(new Error("the machine is gone"));
    await act(async () => {
      screen.getByRole("button", { name: "Save" }).click();
    });

    await waitFor(() => expect(screen.getByText("the machine is gone")).toBeTruthy());
    expect(screen.queryByText(/^Saved\./)).toBeNull();
  });

  // Both exits have to hand the button back; a save that leaves it disabled is a dead screen
  it("re-enables Save on both exits", async () => {
    api.get.mockResolvedValueOnce(VIEW).mockRejectedValueOnce(new Error("read timed out"));
    await saveOnce();
    await waitFor(() => expect(screen.getByText(LIST_REFRESH_FAILED)).toBeTruthy());
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);

    cleanup();
    api.get.mockResolvedValue(VIEW);
    api.put.mockRejectedValueOnce(new Error("the machine is gone"));
    await saveOnce();
    await waitFor(() => expect(screen.getByText("the machine is gone")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  // The stale-list caveat is not a failure, and the page's red is what a failure looks like
  it("says the list is stale in a different voice from a failure", async () => {
    api.get.mockResolvedValueOnce(VIEW).mockRejectedValueOnce(new Error("read timed out"));
    await saveOnce();

    const line = await screen.findByText(LIST_REFRESH_FAILED);
    expect(line.className).toContain("text-warning");
    expect(document.querySelectorAll(".text-danger")).toHaveLength(0);
  });

  // The warning is future tense — "Saving removes a checkout from this machine" — so it must not
  // outlive the save that did it. It is built from `view`, which a failed re-read leaves stale
  it("stops promising a removal that has already happened", async () => {
    api.get.mockResolvedValueOnce(VIEW).mockRejectedValueOnce(new Error("read timed out"));
    render(<MachineProjectsPage />);
    await screen.findByRole("button", { name: "Save" });

    await act(async () => {
      (screen.getByRole("checkbox") as HTMLInputElement).click();
    });
    expect(screen.getByText(/Saving removes/)).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: "Save" }).click();
    });

    await waitFor(() => expect(screen.getByText(LIST_REFRESH_FAILED)).toBeTruthy());
    expect(screen.queryByText(/Saving removes/)).toBeNull();
    expect(screen.queryByText("connected")).toBeNull();
  });
});
