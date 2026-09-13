// @vitest-environment happy-dom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TokensPage from "./page";

/**
 * BP-601. The lists this page seeds are not a read-only repaint: the reader revokes rows out of
 * them. Under Strict Mode two mount reads are in flight, so without a guard the superseded one
 * lands after a revoke and puts the revoked token back on screen — which is the one row a person
 * on this screen most needs to be able to believe.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isAdmin: false }) }));
vi.mock("@/hooks/use-projects", () => ({ useProjects: () => ({ projects: [] }) }));

const TOKEN = {
  _id: "t1",
  name: "a token the reader revokes",
  prefix: "cp_abc",
  allowedProjects: [],
  lastUsedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const answerFor = (path: string) => (path === "/api/tokens" ? [TOKEN] : []);

beforeEach(() => {
  vi.clearAllMocks();
  api.del.mockResolvedValue({});
});
afterEach(cleanup);

describe("the tokens page while its load effect is running twice", () => {
  it("does not let a superseded read put a revoked token back on screen", async () => {
    let releaseSuperseded!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseSuperseded = resolve;
    });

    let call = 0;
    api.get.mockImplementation((path: string) => {
      call += 1;
      return call <= 2
        ? held.then(() => answerFor(path))
        : Promise.resolve(answerFor(path));
    });

    render(
      <StrictMode>
        <TokensPage />
      </StrictMode>
    );

    await screen.findByText(TOKEN.name);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    });
    expect(api.del).toHaveBeenCalledWith("/api/tokens", { id: "t1" });
    expect(screen.queryByText(TOKEN.name)).toBeNull();

    await act(async () => {
      releaseSuperseded();
      await held;
    });

    await waitFor(() => expect(screen.queryByText(TOKEN.name)).toBeNull());
  });

  it("still lists the tokens when the superseded read is the one that failed", async () => {
    let call = 0;
    api.get.mockImplementation((path: string) => {
      call += 1;
      return call <= 2
        ? Promise.reject(new Error("the read that was replaced"))
        : Promise.resolve(answerFor(path));
    });

    render(
      <StrictMode>
        <TokensPage />
      </StrictMode>
    );

    await screen.findByText(TOKEN.name);
  });
});
