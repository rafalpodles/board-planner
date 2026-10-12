// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import NotFound from "./not-found";
import { DatabaseUnavailableError } from "@/lib/db-errors";

const host = vi.hoisted(() => ({ kind: "organisation" }));
const { resolveHost, refresh } = vi.hoisted(() => ({ resolveHost: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "example.test" }) }));
vi.mock("@/lib/organisation-host", () => ({ organisationOfRequest: (...args: unknown[]) => resolveHost(...args), platformSignInOrigin: () => "https://login.board-planner.com" }));
vi.mock("./(app)/layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div> }));
vi.mock("@/components/OrganisationSuspended", () => ({ OrganisationSuspended: () => <div data-testid="suspension" /> }));

afterEach(cleanup);

describe("unmatched routes (BP-262)", () => {
  beforeEach(() => { resolveHost.mockReset().mockResolvedValue(host); refresh.mockReset(); });
  it("offers a fresh host lookup during an outage without claiming an organisation is missing", async () => {
    resolveHost.mockRejectedValue(new DatabaseUnavailableError(new Error("connection refused")));
    render(await NotFound());
    expect(screen.getByRole("alert").textContent).toContain("trouble reaching its database");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("no-organisation-here")).toBeNull();
  });

  it("keeps unexpected programming failures visible to the error boundary", async () => {
    const error = new TypeError("unexpected bug");
    resolveHost.mockRejectedValue(error);
    await expect(NotFound()).rejects.toBe(error);
  });
  it("keeps the app shell and project recovery on a served organisation", async () => {
    host.kind = "organisation";
    render(await NotFound());
    expect(screen.getByTestId("app-shell").contains(screen.getByRole("link", { name: "Back to projects" }))).toBe(true);
  });

  it("never mounts the authenticated shell on unknown and suspended hosts", async () => {
    host.kind = "none";
    const { unmount } = render(await NotFound());
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(screen.getByRole("link", { name: "Find my organisation" }).getAttribute("href")).toBe("https://login.board-planner.com/?switch");
    unmount();
    host.kind = "suspended";
    render(await NotFound());
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(screen.getByTestId("suspension")).toBeTruthy();
  });

  it("takes a platform visitor back to sign-in rather than protected projects", async () => {
    host.kind = "platform";
    render(await NotFound());
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe("/?switch");
    expect(screen.queryByTestId("app-shell")).toBeNull();
  });
});
