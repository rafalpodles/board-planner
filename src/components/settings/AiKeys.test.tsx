// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AiKeys } from "./AiKeys";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

const NOTHING = { set: false, hint: "", included: false };
const FREE_CLOUD = { hosted: true, plan: "free", providers: { openrouter: NOTHING, openai: NOTHING } };

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(FREE_CLOUD);
});
afterEach(cleanup);

describe("Settings → AI keys", () => {
  it("says a Free cloud organisation without a key gets no AI, for each provider", async () => {
    render(<AiKeys />);

    expect(await screen.findAllByText(/it does not run on the Free plan/)).toHaveLength(2);
  });

  it("says a plan that includes managed AI covers an organisation with no key of its own", async () => {
    api.get.mockResolvedValue({
      ...FREE_CLOUD,
      plan: "pro",
      providers: { openrouter: { ...NOTHING, included: true }, openai: { ...NOTHING, included: true } },
    });
    render(<AiKeys />);

    expect(await screen.findAllByText(/runs on ours, which your plan includes/)).toHaveLength(2);
  });

  it("shows a stored key by its last four characters only, and offers to replace or remove it", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, providers: { openrouter: { set: true, hint: "abcd", included: false }, openai: NOTHING } });
    render(<AiKeys />);

    expect(await screen.findByText("abcd")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove key" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Save key" })).toHaveLength(1);
  });

  it("saves the key typed, trimmed, and shows what the server says is stored without keeping the key", async () => {
    api.put.mockResolvedValue({ ...FREE_CLOUD, providers: { openrouter: { set: true, hint: "6789", included: false }, openai: NOTHING } });
    render(<AiKeys />);
    const [openrouter] = (await screen.findAllByLabelText("Add your key")) as HTMLInputElement[];

    fireEvent.change(openrouter, { target: { value: "  sk-or-v1-0123456789  " } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save key" })[0]);

    await waitFor(() => expect(screen.getByText("6789")).toBeTruthy());
    expect(api.put).toHaveBeenCalledWith("/api/settings/ai-keys", { openrouterKey: "sk-or-v1-0123456789" });
    expect(toast).toHaveBeenCalledWith("OpenRouter key saved", "success");
    expect(document.body.textContent).not.toContain("sk-or-v1-0123456789");
  });

  it("offers nothing to save until something is typed", async () => {
    render(<AiKeys />);
    await screen.findAllByLabelText("Add your key");

    for (const button of screen.getAllByRole("button", { name: "Save key" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("removes a key by sending null for that provider only", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, providers: { openrouter: NOTHING, openai: { set: true, hint: "wxyz", included: false } } });
    api.put.mockResolvedValue(FREE_CLOUD);
    render(<AiKeys />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings/ai-keys", { openaiKey: null }));
    expect(toast).toHaveBeenCalledWith("OpenAI key removed", "success");
  });

  it("says why a save was refused, and keeps what was typed", async () => {
    api.put.mockRejectedValue(new Error("openrouterKey must be 8 to 300 characters with no spaces"));
    render(<AiKeys />);
    const [openrouter] = (await screen.findAllByLabelText("Add your key")) as HTMLInputElement[];

    fireEvent.change(openrouter, { target: { value: "bad key" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save key" })[0]);

    expect(await screen.findByText(/must be 8 to 300 characters/)).toBeTruthy();
    expect(openrouter.value).toBe("bad key");
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not paint an empty state over a page it failed to load", async () => {
    api.get.mockRejectedValue(new Error("boom"));
    render(<AiKeys />);

    expect(await screen.findByTestId("ai-keys-error")).toBeTruthy();
    expect(screen.queryByText(/it does not run on the Free plan/)).toBeNull();
  });

  it("describes a self-hosted server's own key, not a plan", async () => {
    api.get.mockResolvedValue({
      hosted: false,
      plan: "free",
      providers: { openrouter: { ...NOTHING, included: true }, openai: NOTHING },
    });
    render(<AiKeys />);

    expect(await screen.findByText(/runs on the key this server was set up with/)).toBeTruthy();
    expect(screen.getByText(/no key was set on the server/)).toBeTruthy();
    expect(screen.queryByText(/Free plan/)).toBeNull();
  });
});
