// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { AiKeys } from "./AiKeys";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

const NOTHING = { set: false, hint: "", unreadable: false, included: false };
const FREE_CLOUD = { hosted: true, plan: "free", providers: { openrouter: NOTHING, openai: NOTHING } };

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(FREE_CLOUD);
});
afterEach(cleanup);

const keyField = (provider: "OpenRouter" | "OpenAI", verb: "Add" | "Replace" = "Add") =>
  screen.findByLabelText(`${verb} your ${provider} key`) as Promise<HTMLInputElement>;

describe("Settings → AI keys", () => {
  it("says a Free cloud organisation without a key gets no AI, for each provider", async () => {
    render(<AiKeys />);

    expect(await screen.findAllByText(/it does not run on the Free plan/)).toHaveLength(2);
  });

  it("says a Pro organisation with no key of its own, on a service with none to offer, gets no AI either, without naming the Free plan", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, plan: "pro" });
    render(<AiKeys />);

    expect(await screen.findAllByText(/this service has no key to offer/)).toHaveLength(2);
    expect(screen.queryByText(/Free plan/)).toBeNull();
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

  it("does not claim the key is free of limits, which this screen does not decide", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, providers: { openrouter: { ...NOTHING, set: true, hint: "abcd" }, openai: NOTHING } });
    render(<AiKeys />);
    await screen.findByText("abcd");

    expect(document.body.textContent).not.toMatch(/caps? it|uncapped|no limit/i);
  });

  it("shows a stored key by its last four characters only, and offers to replace or remove it", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, providers: { openrouter: { ...NOTHING, set: true, hint: "abcd" }, openai: NOTHING } });
    render(<AiKeys />);

    expect(await screen.findByText("abcd")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove key" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Save key" })).toHaveLength(1);
  });

  it("does not print an empty hint when a key was stored without one", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, providers: { openrouter: { ...NOTHING, set: true, hint: "" }, openai: NOTHING } });
    render(<AiKeys />);

    expect(await screen.findByText(/A key is stored\./)).toBeTruthy();
    expect(screen.queryByText(/ending in/)).toBeNull();
  });

  it("says a stored key that cannot be opened is broken, and asks for it again rather than showing it as set", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, providers: { openrouter: { ...NOTHING, set: true, hint: "abcd", unreadable: true }, openai: NOTHING } });
    render(<AiKeys />);

    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be read, so every call fails/);
    expect(screen.getByText("Cannot be read")).toBeTruthy();
    expect(screen.queryByText("Your own key")).toBeNull();
  });

  it("saves the key typed, trimmed, empties the field, and keeps nothing of the key on the page", async () => {
    api.put.mockResolvedValue({ ...FREE_CLOUD, providers: { openrouter: { ...NOTHING, set: true, hint: "6789" }, openai: NOTHING } });
    render(<AiKeys />);
    const field = await keyField("OpenRouter");

    fireEvent.change(field, { target: { value: "  sk-or-v1-0123456789  " } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save key" })[0]);

    await waitFor(() => expect(screen.getByText("6789")).toBeTruthy());
    expect(api.put).toHaveBeenCalledWith("/api/settings/ai-keys", { openrouterKey: "sk-or-v1-0123456789" });
    expect(toast).toHaveBeenCalledWith("OpenRouter key saved", "success");
    // The field is a password input, whose value is not in textContent: ask the field
    expect((await keyField("OpenRouter", "Replace")).value).toBe("");
  });

  it("offers nothing to save until something is typed, and a field of spaces is nothing", async () => {
    render(<AiKeys />);
    const field = await keyField("OpenRouter");

    for (const button of screen.getAllByRole("button", { name: "Save key" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(field, { target: { value: "     " } });
    // An empty string reaches the server as "remove", so a blank must not be sent at all
    expect((screen.getAllByRole("button", { name: "Save key" })[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(field.closest("form")!);
    expect(api.put).not.toHaveBeenCalled();
  });

  it("asks before removing a key, and sends null for that provider only once confirmed", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, providers: { openrouter: NOTHING, openai: { ...NOTHING, set: true, hint: "wxyz" } } });
    api.put.mockResolvedValue(FREE_CLOUD);
    render(<AiKeys />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Remove the OpenAI key\?/)).toBeTruthy();
    expect(api.put).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings/ai-keys", { openaiKey: null }));
    expect(toast).toHaveBeenCalledWith("OpenAI key removed", "success");
  });

  it("leaves the key where it is when the removal is called off", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, providers: { openrouter: NOTHING, openai: { ...NOTHING, set: true, hint: "wxyz" } } });
    render(<AiKeys />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Cancel/ }));

    expect(api.put).not.toHaveBeenCalled();
  });

  it("says why a save was refused, in an alert tied to the field, keeps what was typed, and clears it on the next keystroke", async () => {
    api.put.mockRejectedValue(new Error("openrouterKey must be 20 to 300 printable characters with no spaces"));
    render(<AiKeys />);
    const field = await keyField("OpenRouter");

    fireEvent.change(field, { target: { value: "bad key" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save key" })[0]);

    const alert = await screen.findByText(/must be 20 to 300 printable characters/);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    expect(field.value).toBe("bad key");
    expect(toast).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "bad key 2" } });
    expect(screen.queryByText(/must be 20 to 300 printable characters/)).toBeNull();
  });

  it("keeps a password manager from filling the admin's own login into a key", async () => {
    render(<AiKeys />);
    const field = await keyField("OpenRouter");

    expect(field.type).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("new-password");
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
    expect(screen.getByText("Server key")).toBeTruthy();
    expect(screen.getByText(/no key was set on the server/)).toBeTruthy();
    expect(screen.queryByText(/Free plan/)).toBeNull();
  });
});
