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
  api.get.mockImplementation(async () => ({ pmAvailable: true, defaults: { aiModel: "openai/one-model" }, projects: [ROW] }));
});
afterEach(cleanup);

// BP-652: the banner says what would fix it, and a fix that is not a server setting is not told as one
describe("the banner when no agent can run", () => {
  const answer = (over: Record<string, unknown>) =>
    api.get.mockImplementation(async () => ({ pmAvailable: false, defaults: { aiModel: "m" }, projects: [ROW], ...over }));

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

  it("says the operator has switched its key off, with the own key as the way on, and not that no key is configured", async () => {
    answer({ pmLocked: true });
    render(<AdminAgentsPage />);

    expect(await screen.findByText(/the operator has switched its AI key off for this organisation/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add your own key" }).getAttribute("href")).toBe("/settings/ai-keys");
    expect(screen.queryByText(/No OpenRouter key is configured/)).toBeNull();
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

// BP-1006: AI task drafting and the PM agent run on one model, so there is one field for it
describe("the instance model", () => {
  it("is one field, shared by AI task drafting and the PM agent, with no second default beside it", async () => {
    render(<AdminAgentsPage />);

    expect(((await screen.findByLabelText("Model", { exact: true })) as HTMLInputElement).value).toBe("openai/one-model");
    expect(screen.getAllByLabelText("Model", { exact: true })).toHaveLength(1);
    expect(screen.queryByText("PM agent defaults")).toBeNull();
    expect(screen.queryByText("Default model")).toBeNull();
  });

  it("is what a project that names no model of its own will run", async () => {
    render(<AdminAgentsPage />);

    expect(((await screen.findByLabelText("PM model for BP — Board")) as HTMLInputElement).placeholder).toBe("openai/one-model");
  });

  it("is saved as aiModel, and nothing else is sent", async () => {
    api.put.mockResolvedValue({});
    render(<AdminAgentsPage />);

    fireEvent.change(await screen.findByLabelText("Model", { exact: true }), { target: { value: "  openai/next  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings", { aiModel: "openai/next" }));
  });

  it("sends nothing when a project's model is left as it was saved, or typed and put back", async () => {
    api.get.mockImplementation(async () => ({ pmAvailable: true, defaults: { aiModel: "openai/one-model" }, projects: [{ ...ROW, model: "x/saved" }] }));
    render(<AdminAgentsPage />);
    const model = await screen.findByLabelText("PM model for BP — Board");

    fireEvent.blur(model);
    fireEvent.change(model, { target: { value: "x/other" } });
    fireEvent.change(model, { target: { value: "x/saved" } });
    fireEvent.blur(model);

    await act(async () => {});
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("shows the model a bare instance name will run as", async () => {
    api.get.mockImplementation(async () => ({ pmAvailable: true, defaults: { aiModel: "gpt-4o-mini" }, projects: [ROW] }));
    render(<AdminAgentsPage />);

    expect(((await screen.findByLabelText("PM model for BP — Board")) as HTMLInputElement).placeholder).toBe("openai/gpt-4o-mini");
  });

  it("saves a project's own model when it is typed, and clears it when it is emptied", async () => {
    api.patch.mockResolvedValue({ ...ROW, model: "x/own" });
    render(<AdminAgentsPage />);
    const model = await screen.findByLabelText("PM model for BP — Board");

    fireEvent.change(model, { target: { value: "x/own" } });
    fireEvent.blur(model);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/admin/agents/p1", { model: "x/own" }));

    api.patch.mockResolvedValue({ ...ROW, model: "" });
    fireEvent.change(model, { target: { value: "" } });
    fireEvent.blur(model);
    await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith("/api/admin/agents/p1", { model: "" }));
  });
});
