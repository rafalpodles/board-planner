// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
import { EnrolWorkerModal } from "./EnrolWorkerModal";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(), upload: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
const auth = vi.hoisted(() => ({ user: { role: "member" } as { role: string } | null }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));

const DOWNLOAD = "https://board-planner.com/docs/ai/execution-workers/#getting-the-software";

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("EnrolWorkerModal", () => {
  it("points at the download before a token is minted", () => {
    render(<EnrolWorkerModal open onClose={() => {}} />);

    const link = screen.getByRole("link", { name: "Getting the software" });
    expect(link.getAttribute("href")).toBe(DOWNLOAD);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("makes installing the worker the first step on the machine once a token is minted", async () => {
    api.post.mockResolvedValue({
      token: "cpe_abc",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    render(<EnrolWorkerModal open onClose={() => {}} />);

    await act(async () => {
      screen.getByRole("button", { name: "Mint token" }).click();
    });

    expect(screen.getByText("cpe_abc")).toBeTruthy();
    const firstStep = screen.getAllByRole("listitem")[0];
    expect(
      within(firstStep).getByRole("link", { name: "Getting the software" }).getAttribute("href")
    ).toBe(DOWNLOAD);
  });

  it("asks the machine for the enrolment token and no second credential", async () => {
    api.post.mockResolvedValue({
      token: "cpe_abc",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    render(<EnrolWorkerModal open onClose={() => {}} />);

    await act(async () => {
      screen.getByRole("button", { name: "Mint token" }).click();
    });

    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[1].textContent).toContain("CP_ENROLMENT_TOKEN_FILE");
    expect(steps[1].textContent).toContain("chmod 600");
    expect(screen.getByRole("dialog").textContent).not.toContain("CP_API_TOKEN");
  });
});

// BP-989
describe("EnrolWorkerModal on a Free organisation with its one machine connected", () => {
  const LIMIT = "This organisation is on the Free plan, which connects one machine for workers and agents, and one is already connected. Pro connects any number.";
  const refused = () =>
    Object.assign(new Error(LIMIT), { status: 402, body: { error: LIMIT, feature: "workers.multiple", plan: "free" } });

  it("says why in the dialog, not in a toast, and tells a member to ask an admin", async () => {
    auth.user = { role: "member" };
    api.post.mockRejectedValue(refused());
    render(<EnrolWorkerModal open onClose={() => {}} />);

    await act(async () => {
      screen.getByRole("button", { name: "Mint token" }).click();
    });

    expect(screen.getByRole("alert").textContent).toBe(`${LIMIT} Ask an admin to upgrade to Pro.`);
    expect(toast).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Upgrade" })).toBeNull();
  });

  it("gives an admin the way to upgrade", async () => {
    auth.user = { role: "admin" };
    api.post.mockRejectedValue(refused());
    render(<EnrolWorkerModal open onClose={() => {}} />);

    await act(async () => {
      screen.getByRole("button", { name: "Mint token" }).click();
    });

    expect(screen.getByRole("link", { name: "Upgrade" }).getAttribute("href")).toBe("/settings/organisation");
  });

  it("forgets the refusal once closed, so opening it again starts clean", async () => {
    auth.user = { role: "member" };
    api.post.mockRejectedValue(refused());
    const { rerender } = render(<EnrolWorkerModal open onClose={() => {}} />);
    await act(async () => {
      screen.getByRole("button", { name: "Mint token" }).click();
    });

    await act(async () => {
      screen.getByRole("button", { name: "Cancel" }).click();
    });
    rerender(<EnrolWorkerModal open onClose={() => {}} />);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still toasts any other refusal", async () => {
    api.post.mockRejectedValue(Object.assign(new Error("too many enrolment tokens, try again later"), { status: 429, body: {} }));
    render(<EnrolWorkerModal open onClose={() => {}} />);

    await act(async () => {
      screen.getByRole("button", { name: "Mint token" }).click();
    });

    expect(toast).toHaveBeenCalledWith("too many enrolment tokens, try again later", "error");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("mints for the owner of the connected machine and says the token only reconnects it", async () => {
    auth.user = { role: "member" };
    api.post.mockResolvedValue({ token: "cpe_abc", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reconnectOnly: true });
    render(<EnrolWorkerModal open onClose={() => {}} />);

    await act(async () => {
      screen.getByRole("button", { name: "Mint token" }).click();
    });

    expect(screen.getByText("cpe_abc")).toBeTruthy();
    expect(screen.getByTestId("reconnect-only").textContent).toContain("this token can only connect that machine again");
  });
});
