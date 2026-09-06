// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { ApiUser, ApiWorker } from "@/types";
import type { AuthState } from "@/hooks/use-auth";

const { api, toast, replace, auth } = vi.hoisted(() => ({
  api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
  toast: vi.fn(),
  replace: vi.fn(),
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
  auth.isLoading = false;
});

afterEach(cleanup);

describe("while auth is still loading", () => {
  it("shows the spinner and asks the fleet for nothing yet", () => {
    auth.isLoading = true;

    render(<WorkersPage />);

    expect(api.get).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

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

  it("offers no per-project approval toggles", async () => {
    api.get.mockResolvedValue([worker()]);

    render(<WorkersPage />);

    await screen.findByText("Rafal Podles");
    await waitFor(() => expect(screen.queryByText(/Approved for/i)).toBeNull());
  });
});

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

  it("asks before clearing the owner, and writes nothing until the answer", async () => {
    api.get.mockResolvedValue([worker()]);

    render(<WorkersPage />);
    (await screen.findByTestId("worker-release")).click();

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
