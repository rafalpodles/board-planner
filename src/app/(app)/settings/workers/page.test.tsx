// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { ApiWorker } from "@/types";

const { api, toast, replace } = vi.hoisted(() => ({
  api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
  toast: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isAdmin: true, loading: false }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
// The real hook also runs on an interval and on visibility changes; here the first load is enough
vi.mock("@/hooks/use-poll-while-visible", async () => {
  const { useEffect } = await import("react");
  return {
    usePollWhileVisible: (cb: () => void, _ms: number, enabled = true) =>
      useEffect(() => {
        if (enabled) cb();
      }, [cb, enabled]),
  };
});
vi.mock("@/components/settings/EnrolWorkerModal", () => ({ EnrolWorkerModal: () => null }));

const { default: WorkersPage } = await import("./page");

function worker(over: Partial<ApiWorker> = {}): ApiWorker {
  return {
    _id: "w1",
    name: "rafal-mac",
    host: "mac.home",
    platform: "darwin",
    version: "1.0.0",
    protocolVersion: 1,
    repos: [],
    owner: { _id: "u1", username: "rpo", fullName: "Rafal Podles" },
    policy: { pollIntervalMs: 30_000 },
    policyOverrides: [],
    enabled: true,
    lockedByInstance: false,
    lastSeenAt: new Date().toISOString(),
    bindingError: "",
    preflight: null,
    command: "",
    commandIssuedAt: null,
    commandAckedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stale: false,
    ...over,
  } as ApiWorker;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

/**
 * BP-358: the owner is the whole of what a machine may reach, and an ownerless one is
 * indistinguishable from a healthy idle machine — no binding error, no failed heartbeat, an empty
 * assignment list. The console was the only place that could say so and did not.
 */
describe("the fleet console's owner column", () => {
  it("names whose machine each one is", async () => {
    api.get.mockResolvedValue([worker()]);

    render(<WorkersPage />);

    expect(await screen.findByText("Rafal Podles")).toBeTruthy();
  });

  it("falls back to the username when that account has no display name", async () => {
    api.get.mockResolvedValue([worker({ owner: { _id: "u1", username: "rpo", fullName: "" } })]);

    render(<WorkersPage />);

    expect(await screen.findByText("rpo")).toBeTruthy();
  });

  // Located by its own control rather than by wording: the row for a healthy machine renders the
  // owner's name in the same cell, so matching on text alone would pass with either on screen.
  it("says an ownerless machine claims nothing", async () => {
    api.get.mockResolvedValue([worker({ owner: null })]);

    render(<WorkersPage />);

    const flag = await screen.findByTestId("worker-no-owner");
    expect(flag.textContent).toMatch(/claims nothing/i);
  });

  it("flags nothing on a machine that has an owner", async () => {
    api.get.mockResolvedValue([worker()]);

    render(<WorkersPage />);

    await screen.findByText("Rafal Podles");
    expect(screen.queryByTestId("worker-no-owner")).toBeNull();
  });

  // The stored per-worker approved list went with the admin approval step (BP-358). A console that
  // still offered its toggles would be writing a field the claim no longer reads.
  it("offers no per-project approval toggles", async () => {
    api.get.mockResolvedValue([worker()]);

    render(<WorkersPage />);

    await screen.findByText("Rafal Podles");
    await waitFor(() => expect(screen.queryByText(/Approved for/i)).toBeNull());
  });
});

/**
 * Registration refuses to re-register a machine that belongs to somebody else, so without a way to
 * let one go, a machine whose owner has left could never be enrolled again under the same name and
 * host. Instance-admin only, and it clears — it never assigns.
 */
describe("releasing a machine from its owner", () => {
  it("offers it on a machine that has one", async () => {
    api.get.mockResolvedValue([worker()]);

    render(<WorkersPage />);

    expect(await screen.findByTestId("worker-release")).toBeTruthy();
  });

  it("offers nothing to release on a machine with no owner", async () => {
    api.get.mockResolvedValue([worker({ owner: null })]);

    render(<WorkersPage />);

    await screen.findByTestId("worker-no-owner");
    expect(screen.queryByTestId("worker-release")).toBeNull();
  });

  /**
   * It used to patch on the single click. The only way back is a fresh enrolment run on that
   * machine by whoever sits at it — the console cannot assign an owner — so a misclick here is
   * undoable from this screen and from every other one.
   */
  it("asks before clearing the owner, and writes nothing until the answer", async () => {
    api.get.mockResolvedValue([worker()]);

    render(<WorkersPage />);
    (await screen.findByTestId("worker-release")).click();

    // The name of the machine and of the person losing it: a dialog that named neither could be
    // confirming any row in the table
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("rafal-mac");
    expect(dialog.textContent).toContain("Rafal Podles");
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("clears the owner once it is confirmed, and asks for nothing else", async () => {
    api.get.mockResolvedValue([worker()]);
    api.patch.mockResolvedValue(worker({ owner: null }));

    render(<WorkersPage />);
    (await screen.findByTestId("worker-release")).click();
    (await within(await screen.findByRole("dialog")).findByRole("button", { name: "Release" })).click();

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/workers/w1", { owner: null }));
  });

  it("writes nothing when the answer is no", async () => {
    api.get.mockResolvedValue([worker()]);

    render(<WorkersPage />);
    (await screen.findByTestId("worker-release")).click();
    (await within(await screen.findByRole("dialog")).findByRole("button", { name: "Cancel" })).click();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.patch).not.toHaveBeenCalled();
  });
});
