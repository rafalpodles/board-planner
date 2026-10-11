// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
// BP-1024: and it is set next to the key, not here
describe("the instance model", () => {
  it("is not set on this page: a link says where it is, beside the key", async () => {
    render(<AdminAgentsPage />);

    const note = await screen.findByTestId("ai-model-moved");
    expect(within(note).getByRole("link", { name: "Settings → AI key" }).getAttribute("href")).toBe("/settings/ai-keys");
    expect(screen.queryByLabelText("Model", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save model" })).toBeNull();
  });

  it("is what a project that names no model of its own will run", async () => {
    render(<AdminAgentsPage />);

    expect(((await screen.findByLabelText("PM model for BP — Board")) as HTMLInputElement).placeholder).toBe("openai/one-model");
  });

  // On the platform's key only the allowed providers' models run, so a project picks from them
  describe("in the table, on the platform's key", () => {
    const CATALOGUE = {
      restricted: true,
      model: "openai/one-model",
      models: [{ id: "openai/gpt-4o", name: "OpenAI: GPT-4o" }, { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna" }],
      providers: [{ id: "openai", label: "OpenAI" }],
    };
    const AGENTS = { pmAvailable: true, defaults: { aiModel: "openai/one-model" }, projects: [ROW] };
    beforeEach(() => {
      api.get.mockImplementation(async (url: string) => (url === "/api/settings/ai-models" ? CATALOGUE : AGENTS));
    });

    it("is a list of those models, led by the default, and not a field to type in", async () => {
      render(<AdminAgentsPage />);

      const select = (await screen.findByLabelText("PM model for BP — Board")) as HTMLSelectElement;

      expect(select.tagName).toBe("SELECT");
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Default — openai/one-model", "OpenAI: GPT-4o", "OpenAI: GPT-6 Luna"]);
      expect(within(select).getByRole("group", { name: "OpenAI" })).toBeTruthy();
    });

    it("saves the model at once when one is picked, and clears it when the default is", async () => {
      api.patch.mockResolvedValue({ ...ROW, model: "openai/gpt-4o" });
      render(<AdminAgentsPage />);
      const select = await screen.findByLabelText("PM model for BP — Board");

      fireEvent.change(select, { target: { value: "openai/gpt-4o" } });
      await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/admin/agents/p1", { model: "openai/gpt-4o" }));

      api.patch.mockResolvedValue({ ...ROW, model: "" });
      fireEvent.change(select, { target: { value: "" } });
      await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith("/api/admin/agents/p1", { model: "" }));
    });

    it("keeps a model the platform's key does not run, saved earlier, as the choice shown, and says so", async () => {
      api.get.mockImplementation(async (url: string) =>
        url === "/api/settings/ai-models" ? CATALOGUE : { ...AGENTS, projects: [{ ...ROW, model: "anthropic/claude-haiku-5.5" }] }
      );
      render(<AdminAgentsPage />);

      const select = (await screen.findByLabelText("PM model for BP — Board")) as HTMLSelectElement;

      expect(select.value).toBe("anthropic/claude-haiku-5.5");
      expect(select.selectedOptions[0].textContent).toBe("anthropic/claude-haiku-5.5 — not available on our key");
    });
  });

  it("is a field to type in, with OpenRouter's models offered, on the organisation's own key", async () => {
    api.get.mockImplementation(async (url: string) =>
      url === "/api/settings/ai-models"
        ? { restricted: false, model: "openai/one-model", models: [{ id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5" }], providers: null }
        : { pmAvailable: true, defaults: { aiModel: "openai/one-model" }, projects: [ROW] }
    );
    render(<AdminAgentsPage />);

    const field = (await screen.findByLabelText("PM model for BP — Board")) as HTMLInputElement;

    expect(field.tagName).toBe("INPUT");
    expect(document.querySelector(`datalist#${CSS.escape(field.getAttribute("list") ?? "")} option`)?.getAttribute("value")).toBe("anthropic/claude-haiku-5.5");
  });

  it("is still a field to type in when the list of models cannot be read, and the page still loads", async () => {
    api.get.mockImplementation(async (url: string) => {
      if (url === "/api/settings/ai-models") throw new Error("down");
      return { pmAvailable: true, defaults: { aiModel: "openai/one-model" }, projects: [ROW] };
    });
    render(<AdminAgentsPage />);

    expect(((await screen.findByLabelText("PM model for BP — Board")) as HTMLInputElement).tagName).toBe("INPUT");
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
