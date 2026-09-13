// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { ApiUser, ApiWorker } from "@/types";
import type { AuthState } from "@/hooks/use-auth";

const { api, toast, replace, auth } = vi.hoisted(() => ({
  api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
  toast: vi.fn(),
  replace: vi.fn(),
  // Annotated, so a field added to AuthState fails here instead of reaching the component as
  // undefined with the suite green — this mock used to carry a `loading` field that isn't part
  // of AuthState at all, so `isLoading` was always undefined and the spinner branch untested
  auth: {
    user: null as ApiUser | null,
    isAdmin: true,
    isLoading: false as boolean,
    outage: false as boolean,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    onUnauthorized: vi.fn(),
    noteApiStatus: vi.fn(),
  } satisfies AuthState,
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
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
    name: "owner-mac",
    host: "mac.home",
    platform: "darwin",
    version: "1.0.0",
    protocolVersion: 1,
    repos: [],
    owner: { _id: "u1", username: "owner", fullName: "Owner Name" },
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
  auth.isLoading = false;
});

afterEach(cleanup);

// The mock used to carry a field AuthState doesn't have, so isLoading was always undefined and
// this branch ran untested — `authLoading` here really is what the console decides nothing on.
describe("while auth is still loading", () => {
  it("shows the spinner and asks the fleet for nothing yet", () => {
    auth.isLoading = true;

    render(<WorkersPage />);

    expect(api.get).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

/**
 * BP-358: the owner is the whole of what a machine may reach, and an ownerless one is
 * indistinguishable from a healthy idle machine — no binding error, no failed heartbeat, an empty
 * assignment list. The console was the only place that could say so and did not.
 */
describe("the fleet console's owner column", () => {
  it("names whose machine each one is", async () => {
    api.get.mockResolvedValue([worker()]);

    render(<WorkersPage />);

    expect(await screen.findByText("Owner Name")).toBeTruthy();
  });

  it("falls back to the username when that account has no display name", async () => {
    api.get.mockResolvedValue([worker({ owner: { _id: "u1", username: "owner", fullName: "" } })]);

    render(<WorkersPage />);

    expect(await screen.findByText("owner")).toBeTruthy();
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

    await screen.findByText("Owner Name");
    expect(screen.queryByTestId("worker-no-owner")).toBeNull();
  });

  // The stored per-worker approved list went with the admin approval step (BP-358). A console that
  // still offered its toggles would be writing a field the claim no longer reads.
  it("offers no per-project approval toggles", async () => {
    api.get.mockResolvedValue([worker()]);

    render(<WorkersPage />);

    await screen.findByText("Owner Name");
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
    expect(dialog.textContent).toContain("owner-mac");
    expect(dialog.textContent).toContain("Owner Name");
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

/**
 * BP-606. A machine running the agent unconfined passes its preflight — the operator set the
 * escape hatch and the worker honours it — so the row read `ready · owner`, exactly like a machine
 * whose sandbox works, with the difference in a tooltip. The instance admin reading the fleet is
 * not the person who accepted that cost.
 */
describe("a check that passed at a cost", () => {
  const preflight = (checks: { name: string; ok: boolean; warn?: boolean; detail: string }[]) => ({
    ok: true,
    account: "owner",
    checks,
    reportedAt: new Date().toISOString(),
  });

  const UNCONFINED =
    "CP_ALLOW_UNCONFINED_AGENT is set — the agent runs with nothing confining its writes";

  it("says it where the table does not have to be scrolled to reach it", async () => {
    api.get.mockResolvedValue([
      worker({ preflight: preflight([{ name: "sandbox", ok: true, warn: true, detail: UNCONFINED }]) }),
    ]);

    render(<WorkersPage />);

    // The full-width line under the worker, because the Preflight column is the eighth of twelve
    // in a table that scrolls sideways — measured off the right edge of a 1280px viewport.
    const line = await screen.findByTestId("preflight-warning");
    expect(line.textContent).toContain("sandbox");
    expect(line.textContent).toContain("nothing confining its writes");
    expect(line.className).toContain("text-warning");
    // The word, so the amber is not the only thing saying this is a warning
    expect(line.textContent).toContain("Warning:");
    // And the line that proves it left the Preflight column: only the full-width row spans the table
    expect(line.closest("td")?.colSpan).toBe(12);
  });

  it("still opens the preflight cell with ready, and names the check in amber", async () => {
    api.get.mockResolvedValue([
      worker({ preflight: preflight([{ name: "sandbox", ok: true, warn: true, detail: UNCONFINED }]) }),
    ]);

    render(<WorkersPage />);

    // Still ready, and still allowed to take work: a permanently red row is one people read past.
    const cell = await screen.findByText(/^ready/);
    // The mark as well as the amber, so the check's name does not read as one more field
    expect(cell.textContent).toBe("ready · owner · ⚠ sandbox");
    expect(cell.querySelector(".text-warning")?.textContent).toContain("sandbox");
  });

  it("leaves an ordinary pass exactly as it was", async () => {
    api.get.mockResolvedValue([
      worker({
        preflight: preflight([
          { name: "sandbox", ok: true, detail: "the agent can only write inside its own worktree" },
        ]),
      }),
    ]);

    render(<WorkersPage />);

    expect(await screen.findByText(/^ready/)).toBeTruthy();
    expect(screen.queryByTestId("preflight-warning")).toBeNull();
  });

  it("keeps a failing check red, warning or not", async () => {
    api.get.mockResolvedValue([
      worker({
        preflight: {
          ...preflight([{ name: "sandbox", ok: false, detail: "there is no sandbox here" }]),
          ok: false,
        },
      }),
    ]);

    render(<WorkersPage />);

    expect(await screen.findByText(/there is no sandbox here/)).toBeTruthy();
    expect(screen.queryByTestId("preflight-warning")).toBeNull();
  });

  // The "or not" above is the half with no warn on it at all. This is the other half, and the one
  // `c.ok &&` is there for: the heartbeat route strips a warn off a failing check, so a report
  // carrying both is either an older worker or a route that stopped stripping — and the screen
  // must not then say "ready, with a caution" about a machine that is red (found in review).
  it("keeps it red when the failing check carries a warning too", async () => {
    api.get.mockResolvedValue([
      worker({
        preflight: {
          ...preflight([
            { name: "sandbox", ok: false, warn: true, detail: "there is no sandbox here" },
          ]),
          ok: false,
        },
      }),
    ]);

    render(<WorkersPage />);

    expect(await screen.findByText(/there is no sandbox here/)).toBeTruthy();
    expect(screen.queryByTestId("preflight-warning")).toBeNull();
    expect(screen.queryByText(/^ready/)).toBeNull();
  });
});
