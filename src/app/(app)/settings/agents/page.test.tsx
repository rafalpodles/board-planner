// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AdminAgentsPage from "./page";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isAdmin: true, isLoading: false }) }));
// One router for every render, as Next gives: a new object each time re-runs the page's load effect
const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const ROW = {
  _id: "p1",
  key: "BP",
  name: "Board",
  enabled: true,
  lockedByInstance: false,
  model: "",
  autonomy: { dailyReview: false, reviewIntervalHours: 24, handleNeedsHumanReview: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(async (url: string) =>
    url === "/api/settings"
      ? { aiModel: "" }
      : { pmAvailable: true, defaults: { pmDefaultModel: "", envModel: "m" }, projects: [ROW] }
  );
});
afterEach(cleanup);

// BP-652: the banner says what would fix it, and a fix that is not a server setting is not told as one
describe("the banner when no agent can run", () => {
  const answer = (over: Record<string, unknown>) =>
    api.get.mockImplementation(async (url: string) =>
      url === "/api/settings"
        ? { aiModel: "" }
        : { pmAvailable: false, defaults: { pmDefaultModel: "", envModel: "m" }, projects: [ROW], ...over }
    );

  it("offers a Free organisation its own key or Pro", async () => {
    answer({ pmNeedsPlan: true });
    render(<AdminAgentsPage />);

    expect(await screen.findByText(/on the Free plan the PM agent needs your own OpenRouter key/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add a key" }).getAttribute("href")).toBe("/settings/ai-keys");
    expect(screen.getByRole("link", { name: "upgrade to Pro" }).getAttribute("href")).toBe("/settings/organisation");
    expect(screen.queryByText(/No OpenRouter key is configured/)).toBeNull();
  });

  it("says a stored key that cannot be read has to be entered again", async () => {
    answer({ pmKeyUnreadable: true });
    render(<AdminAgentsPage />);

    expect(await screen.findByText(/the stored OpenRouter key cannot be read/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Enter it again" }).getAttribute("href")).toBe("/settings/ai-keys");
  });

  it("still says no key is configured where nothing else is the matter, and points at where one can be added", async () => {
    answer({});
    render(<AdminAgentsPage />);

    expect(await screen.findByText(/No OpenRouter key is configured/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add one here" }).getAttribute("href")).toBe("/settings/ai-keys");
  });
});

// BP-471: the row's save answered with every field as stored, and the merge took all of them
describe("a governance row while one field's save is in flight", () => {
  it("keeps the model typed meanwhile when the lock's save lands", async () => {
    let answerLock!: (row: unknown) => void;
    api.patch.mockImplementationOnce(() => new Promise((resolve) => (answerLock = resolve)));
    render(<AdminAgentsPage />);
    const model = (await screen.findByLabelText("PM model for BP — Board")) as HTMLInputElement;

    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    fireEvent.change(model, { target: { value: "e2e/governed-model" } });

    // The lock's answer carries the model as it was stored before the edit
    await act(async () => answerLock({ ...ROW, lockedByInstance: true, model: "" }));

    expect(model.value).toBe("e2e/governed-model");
    expect(screen.getByRole("button", { name: "Locked" })).toBeTruthy();
  });
});
