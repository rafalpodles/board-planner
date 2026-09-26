// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, within } from "@testing-library/react";
import MachinesPage from "./page";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

function machine(over: Record<string, unknown> = {}) {
  return {
    _id: "6a7309535eb49af333b85a04",
    name: "MacBook",
    host: "ada.local",
    version: "1.1.3",
    lastSeenAt: new Date().toISOString(),
    state: "live",
    haltedBy: null,
    checkouts: 1,
    ...over,
  };
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

/**
 * BP-761. The API let any signed-in person mint an enrolment token, but the only button was on the
 * fleet console, which turns away everybody but an instance admin — so a member with a Linux box
 * had no way to connect it, and no page listing the machines they did connect.
 */
describe("Settings → Machines", () => {
  it("lists the reader's machines, each with the way to its projects", async () => {
    api.get.mockResolvedValue([machine()]);

    render(<MachinesPage />);

    const row = await screen.findByTestId("my-machine");
    expect(api.get).toHaveBeenCalledWith("/api/users/me/machines");
    expect(row.textContent).toContain("MacBook");
    expect(row.textContent).toContain("ada.local");
    expect(within(row).getByTestId("my-machine-state").textContent).toBe("Taking work");
    expect(within(row).getByRole("link", { name: "Choose projects" }).getAttribute("href")).toBe(
      "/settings/workers/6a7309535eb49af333b85a04/projects"
    );
  });

  it.each([
    [{ state: "stale" }, "Not reporting"],
    [{ state: "disabled" }, "Switched off by an instance admin"],
    [{ state: "paused", haltedBy: "machine" }, "Paused on the machine"],
    [{ state: "paused", haltedBy: "board" }, "Paused by an instance admin"],
    [{ state: "stopped", haltedBy: "machine" }, "Stopped on the machine"],
    [{ state: "stopped", haltedBy: "board" }, "Stopped by an instance admin"],
  ])("says %o as %s", async (over, text) => {
    api.get.mockResolvedValue([machine(over)]);

    render(<MachinesPage />);

    expect((await screen.findByTestId("my-machine-state")).textContent).toBe(text);
  });

  it("connects a machine from here, with the same single-use token the fleet console mints", async () => {
    api.get.mockResolvedValue([]);
    api.post.mockResolvedValue({ token: "cpe_abc", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

    render(<MachinesPage />);
    await screen.findByTestId("no-machines");
    await act(async () => screen.getByRole("button", { name: "Connect a machine" }).click());

    const dialog = screen.getByRole("dialog", { name: "Connect a machine" });
    await act(async () => within(dialog).getByRole("button", { name: "Mint token" }).click());

    expect(api.post).toHaveBeenCalledWith("/api/workers/enrolment", expect.any(Object));
    expect(within(dialog).getByText("cpe_abc")).toBeTruthy();
  });

  it("reads the list again once the dialog closes, so a machine that registered meanwhile shows", async () => {
    api.get.mockResolvedValueOnce([]).mockResolvedValue([machine()]);

    render(<MachinesPage />);
    await screen.findByTestId("no-machines");
    await act(async () => screen.getByRole("button", { name: "Connect a machine" }).click());
    await act(async () => screen.getByRole("button", { name: "Cancel" }).click());

    expect(await screen.findByTestId("my-machine")).toBeTruthy();
  });

  it("says when the list could not be read, and reads it again on Retry", async () => {
    api.get.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([machine()]);

    render(<MachinesPage />);

    expect((await screen.findByRole("alert")).textContent).toContain("Could not load your machines.");
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());
    await waitFor(() => expect(screen.getByTestId("my-machine")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the list it has when a later read answers after a newer one", async () => {
    let answerFirst: (rows: unknown) => void = () => {};
    api.get
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValue([machine({ name: "Newer" })]);

    render(<MachinesPage />);
    await act(async () => screen.getByRole("button", { name: "Connect a machine" }).click());
    await act(async () => screen.getByRole("button", { name: "Cancel" }).click());
    await screen.findByText("Newer");

    await act(async () => answerFirst([machine({ name: "Older" })]));

    expect(screen.getByText("Newer")).toBeTruthy();
    expect(screen.queryByText("Older")).toBeNull();
  });
});
