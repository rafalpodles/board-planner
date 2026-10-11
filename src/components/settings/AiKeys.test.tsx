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

const NO_USAGE = { scope: "month", used: 0, limit: null, resetsAt: null, today: 0, dailyCeiling: null, ownTokens: 0, calls: 0, ownCalls: 0, turns: null, locked: false, included: false };
const FREE_CLOUD = { hosted: true, plan: "free", set: false, hint: "", unreadable: false, included: false, usage: NO_USAGE };

// On the platform's key, which the key answers below do not replace, only the allowed providers' models run
const PLATFORM_MODELS = {
  restricted: true,
  model: "openai/gpt-6-luna",
  models: [{ id: "openai/gpt-4o", name: "OpenAI: GPT-4o" }, { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna" }],
  providers: [{ id: "openai", label: "OpenAI" }],
};
let models: unknown = PLATFORM_MODELS;
const answerKey = (key: unknown) => api.get.mockImplementation(async (url: string) => (url === "/api/settings/ai-models" ? models : key));

beforeEach(() => {
  models = PLATFORM_MODELS;
  vi.clearAllMocks();
  answerKey(FREE_CLOUD);
});
afterEach(cleanup);

const keyField = (verb: "Add" | "Replace" = "Add") => screen.findByLabelText(`${verb} your OpenRouter key`) as Promise<HTMLInputElement>;

describe("Settings → AI key", () => {
  it("says it is one key, for the PM agent and for AI Assist", async () => {
    render(<AiKeys />);

    expect(await screen.findByText(/Runs the PM agent .* and AI Assist/)).toBeTruthy();
    expect(document.querySelectorAll("input[type=password]")).toHaveLength(1);
    expect(screen.queryByText(/OpenAI key/)).toBeNull();
  });

  it("is headed in the singular", async () => {
    render(<AiKeys />);

    expect((await screen.findByRole("heading", { level: 2 })).textContent).toBe("AI key");
  });

  it("says a Free cloud organisation without a key gets no AI", async () => {
    render(<AiKeys />);

    expect(await screen.findByText(/it does not run on the Free plan/)).toBeTruthy();
  });

  it("says a Pro organisation with no key of its own, on a service with none to offer, gets no AI either, without naming the Free plan", async () => {
    answerKey({ ...FREE_CLOUD, plan: "pro" });
    render(<AiKeys />);

    expect(await screen.findByText(/this service has no key to offer/)).toBeTruthy();
    expect(screen.queryByText(/Free plan/)).toBeNull();
  });

  it("says a plan that includes managed AI covers an organisation with no key of its own", async () => {
    answerKey({ ...FREE_CLOUD, plan: "pro", included: true });
    render(<AiKeys />);

    expect(await screen.findByText(/runs on ours, which your plan includes/)).toBeTruthy();
  });

  it("does not claim the key is free of limits, which this screen does not decide", async () => {
    answerKey({ ...FREE_CLOUD, set: true, hint: "abcd" });
    render(<AiKeys />);
    await screen.findByText("abcd");

    expect(document.body.textContent).not.toMatch(/caps? it|uncapped|no limit/i);
  });

  it("shows a stored key by its last four characters only, and offers to replace or remove it", async () => {
    answerKey({ ...FREE_CLOUD, set: true, hint: "abcd" });
    render(<AiKeys />);

    expect(await screen.findByText("abcd")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove key" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save key" })).toBeNull();
  });

  it("does not print an empty hint when a key was stored without one", async () => {
    answerKey({ ...FREE_CLOUD, set: true, hint: "" });
    render(<AiKeys />);

    expect(await screen.findByText(/A key is stored\./)).toBeTruthy();
    expect(screen.queryByText(/ending in/)).toBeNull();
  });

  it("says a stored key that cannot be opened is broken, and asks for it again rather than showing it as set", async () => {
    answerKey({ ...FREE_CLOUD, set: true, hint: "abcd", unreadable: true });
    render(<AiKeys />);

    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be read, so every call fails/);
    expect(screen.getByText("Cannot be read")).toBeTruthy();
    expect(screen.queryByText("Your own key")).toBeNull();
  });

  it("saves the key typed, trimmed, empties the field, and keeps nothing of the key on the page", async () => {
    api.put.mockResolvedValue({ ...FREE_CLOUD, set: true, hint: "6789" });
    render(<AiKeys />);
    const field = await keyField();

    fireEvent.change(field, { target: { value: "  sk-or-v1-0123456789  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(screen.getByText("6789")).toBeTruthy());
    expect(api.put).toHaveBeenCalledWith("/api/settings/ai-keys", { openrouterKey: "sk-or-v1-0123456789" });
    expect(toast).toHaveBeenCalledWith("OpenRouter key saved", "success");
    // The field is a password input, whose value is not in textContent: ask the field
    expect((await keyField("Replace")).value).toBe("");
  });

  it("offers nothing to save until something is typed, and a field of spaces is nothing", async () => {
    render(<AiKeys />);
    const field = await keyField();

    expect((screen.getByRole("button", { name: "Save key" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "     " } });
    // An empty string reaches the server as "remove", so a blank must not be sent at all
    expect((screen.getByRole("button", { name: "Save key" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(field.closest("form")!);
    expect(api.put).not.toHaveBeenCalled();
  });

  it("asks before removing the key, and sends null only once confirmed", async () => {
    answerKey({ ...FREE_CLOUD, set: true, hint: "wxyz" });
    api.put.mockResolvedValue(FREE_CLOUD);
    render(<AiKeys />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Remove the OpenRouter key\?/)).toBeTruthy();
    expect(dialog.textContent).toMatch(/On the Free plan they do not run without one/);
    expect(api.put).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings/ai-keys", { openrouterKey: null }));
    expect(toast).toHaveBeenCalledWith("OpenRouter key removed", "success");
  });

  it("leaves the key where it is when the removal is called off", async () => {
    answerKey({ ...FREE_CLOUD, set: true, hint: "wxyz" });
    render(<AiKeys />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Cancel/ }));

    expect(api.put).not.toHaveBeenCalled();
  });

  it("says why a save was refused, in an alert tied to the field, keeps what was typed, and clears it on the next keystroke", async () => {
    api.put.mockRejectedValue(new Error("openrouterKey must be 20 to 300 printable characters with no spaces"));
    render(<AiKeys />);
    const field = await keyField();

    fireEvent.change(field, { target: { value: "bad key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

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
    const field = await keyField();

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
    answerKey({ hosted: false, plan: "free", set: false, hint: "", unreadable: false, included: true, usage: NO_USAGE });
    render(<AiKeys />);

    expect(await screen.findByText(/runs on the key this server was set up with/)).toBeTruthy();
    expect(screen.getByText("Server key")).toBeTruthy();
    expect(screen.queryByText(/Free plan/)).toBeNull();
  });

  it("says a self-hosted server with no key anywhere does not run", async () => {
    answerKey({ hosted: false, plan: "free", set: false, hint: "", unreadable: false, included: false, usage: NO_USAGE });
    render(<AiKeys />);

    expect(await screen.findByText(/no key was set on the server/)).toBeTruthy();
  });
});

// BP-680: what the organisation has used of what it may spend of the operator's key
describe("Settings → AI key: usage", () => {
  const usage = (over: Record<string, unknown> = {}) => ({
    scope: "month",
    used: 4_200_000,
    limit: 15_000_000,
    resetsAt: "2026-11-01T00:00:00.000Z",
    today: 900_000,
    dailyCeiling: 3_000_000,
    ownTokens: 0,
    calls: 1_340,
    ownCalls: 0,
    turns: 120,
    locked: false,
    included: true,
    ...over,
  });
  const PRO_CLOUD = { ...FREE_CLOUD, plan: "pro", included: true };

  it("says how much of the month's allowance is used and when it renews, with the bar and the share", async () => {
    answerKey({ ...PRO_CLOUD, usage: usage() });
    render(<AiKeys />);

    const month = await screen.findByTestId("ai-usage-month");
    expect(month.textContent).toBe("4,200,000 of 15,000,000 tokens used this month. It renews on 1 November 2026 (UTC).");
    expect(screen.getByText("28% used")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "AI tokens used this month" }).getAttribute("aria-valuenow")).toBe("4200000");
    expect(screen.getByTestId("ai-usage-today").textContent).toBe("Today (UTC): 900,000 tokens; one day may use at most 3,000,000.");
  });

  it("says how many PM turns and model calls the month held, beside the tokens, and in the singular for one", async () => {
    answerKey({ ...PRO_CLOUD, usage: usage() });
    const { unmount } = render(<AiKeys />);
    expect((await screen.findByTestId("ai-usage-activity")).textContent).toBe("120 PM turns this month, and 1,340 model calls on this service's key.");
    unmount();

    answerKey({ ...PRO_CLOUD, usage: usage({ turns: 1, calls: 1 }) });
    render(<AiKeys />);
    expect((await screen.findByTestId("ai-usage-activity")).textContent).toBe("1 PM turn this month, and 1 model call on this service's key.");
  });

  it("says a month with no PM turns had none, and counts the singular of each on its own number", async () => {
    answerKey({ ...PRO_CLOUD, usage: usage({ turns: 0, calls: 12 }) });
    const { unmount } = render(<AiKeys />);
    expect((await screen.findByTestId("ai-usage-activity")).textContent).toBe("0 PM turns this month, and 12 model calls on this service's key.");
    unmount();

    answerKey({ ...PRO_CLOUD, usage: usage({ turns: 1, calls: 2 }) });
    render(<AiKeys />);
    expect((await screen.findByTestId("ai-usage-activity")).textContent).toBe("1 PM turn this month, and 2 model calls on this service's key.");
  });

  it("says a trial's turns are the trial's", async () => {
    answerKey({ ...PRO_CLOUD, usage: usage({ scope: "trial", used: 100, limit: 3_000_000, resetsAt: null, dailyCeiling: 600_000, turns: 9, calls: 30 }) });
    render(<AiKeys />);

    expect((await screen.findByTestId("ai-usage-activity")).textContent).toBe("9 PM turns in your trial, and 30 model calls on this service's key.");
  });

  it("says what a turn and a call are, since the two are easily read as one", async () => {
    answerKey({ ...PRO_CLOUD, usage: usage() });
    render(<AiKeys />);

    expect(await screen.findByText(/A PM turn is up to 15 model calls; AI Assist makes one\./)).toBeTruthy();
  });

  it("says nothing of turns where the answer did not count them", async () => {
    answerKey({ ...PRO_CLOUD, usage: usage({ turns: null }) });
    render(<AiKeys />);

    await screen.findByTestId("ai-usage-month");
    expect(screen.queryByTestId("ai-usage-activity")).toBeNull();
  });

  it("says a trial's allowance is for the trial, with nothing renewing", async () => {
    answerKey({ ...PRO_CLOUD, usage: usage({ scope: "trial", used: 3_000_000, limit: 3_000_000, resetsAt: null, dailyCeiling: 600_000 }) });
    render(<AiKeys />);

    expect((await screen.findByTestId("ai-usage-month")).textContent).toBe("3,000,000 of 3,000,000 tokens used in your trial.");
    expect(screen.getByText("100% used")).toBeTruthy();
  });

  it("counts and shows tokens where nothing limits them, with no bar", async () => {
    answerKey({ hosted: false, plan: "free", set: false, hint: "", unreadable: false, included: true, usage: usage({ limit: null, resetsAt: null, dailyCeiling: null, used: 12_345, today: 300 }) });
    render(<AiKeys />);

    expect((await screen.findByTestId("ai-usage-month")).textContent).toBe("12,345 tokens used this month, and nothing limits them.");
    expect(screen.getByText("Not limited")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("ai-usage-today").textContent).toBe("Today (UTC): 300 tokens.");
  });

  it("shows what an own key used apart, and says it is never limited, only when it used any", async () => {
    answerKey({ ...PRO_CLOUD, usage: usage({ ownTokens: 77_000, ownCalls: 41 }) });
    render(<AiKeys />);
    expect((await screen.findByTestId("ai-usage-own")).textContent).toBe("Your own key: 77,000 tokens in 41 calls this month, counted and never limited.");

    cleanup();
    answerKey({ ...PRO_CLOUD, usage: usage({ ownTokens: 0 }) });
    render(<AiKeys />);
    await screen.findByTestId("ai-usage-month");
    expect(screen.queryByTestId("ai-usage-own")).toBeNull();
  });

  it("shows a Free cloud organisation no allowance, which it does not have, and no card at all while it has used no key of its own", async () => {
    answerKey({ ...FREE_CLOUD, usage: usage({ included: false, limit: null, dailyCeiling: null, resetsAt: null }) });
    render(<AiKeys />);

    await screen.findByText(/Without a key of your own it does not run on the Free plan/);
    expect(screen.queryByText("AI usage")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows only what its own key used, where the service's key is not one it may use", async () => {
    answerKey({ ...FREE_CLOUD, set: true, hint: "abcd", usage: usage({ included: false, limit: null, dailyCeiling: null, resetsAt: null, ownTokens: 4_000, ownCalls: 1, locked: true }) });
    render(<AiKeys />);

    expect((await screen.findByTestId("ai-usage-own")).textContent).toBe("Your own key: 4,000 tokens in 1 call this month, counted and never limited.");
    expect(screen.queryByTestId("ai-usage-month")).toBeNull();
    expect(screen.queryByTestId("ai-usage-today")).toBeNull();
    expect(screen.queryByTestId("ai-usage-activity")).toBeNull();
    expect(screen.queryByTestId("ai-usage-locked")).toBeNull();
    expect(screen.getAllByText("Your own key").length).toBe(2);
  });

  it("rounds the share down, so a month that is not yet spent is not shown as spent", async () => {
    answerKey({ ...PRO_CLOUD, usage: usage({ used: 14_950_000 }) });
    render(<AiKeys />);

    expect(await screen.findByText("99% used")).toBeTruthy();
  });

  it("says on the key card too that ours is switched off, so it does not promise what the operator took away", async () => {
    answerKey({ ...PRO_CLOUD, usage: usage({ locked: true }) });
    render(<AiKeys />);

    expect(await screen.findByText(/the operator has switched ours off for this organisation/)).toBeTruthy();
    expect(screen.queryByText(/which your plan includes/)).toBeNull();
    expect(screen.queryByText("Included")).toBeNull();
  });

  it("does not take the own key's word away: a stored key still reads as used first while the lock is on", async () => {
    answerKey({ ...PRO_CLOUD, set: true, hint: "abcd", usage: usage({ locked: true }) });
    render(<AiKeys />);

    expect(await screen.findByText("Your own key")).toBeTruthy();
    expect(screen.getByText(/It is used first/)).toBeTruthy();
  });

  it("says the operator has switched the key off, and offers the own key as the way on", async () => {
    answerKey({ ...PRO_CLOUD, usage: usage({ locked: true }) });
    render(<AiKeys />);

    const alert = await screen.findByTestId("ai-usage-locked");
    expect(alert.textContent).toMatch(/The operator has switched off the use of its key for this organisation\. Add your own key below to keep going\./);
    expect(screen.getAllByText("Switched off")).toHaveLength(2);
  });
});

// BP-1024: the model is chosen beside the key, from what the key in use runs
describe("Settings → AI key, the model", () => {
  const card = async () => within(await screen.findByTestId("ai-model-card"));

  it("is a list of what the platform's key runs, with a note that any other model needs the organisation's own key", async () => {
    render(<AiKeys />);

    const model = (await (await card()).findByLabelText("Model")) as HTMLSelectElement;

    expect(model.tagName).toBe("SELECT");
    expect(model.value).toBe("openai/gpt-6-luna");
    expect(Array.from(model.options).map((o) => o.textContent)).toEqual(["OpenAI: GPT-4o", "OpenAI: GPT-6 Luna"]);
    expect(screen.getByTestId("ai-model-note").textContent).toBe(
      "Board Planner's key runs only OpenAI models. To use any other model or provider, add your own OpenRouter key above."
    );
  });

  it("shows a model saved as a bare name, from before OpenRouter, as the option that carries it, and keeps Save off", async () => {
    models = { ...PLATFORM_MODELS, model: "gpt-4o" };
    render(<AiKeys />);

    const model = (await (await card()).findByLabelText("Model")) as HTMLSelectElement;

    expect(model.value).toBe("openai/gpt-4o");
    expect(model.selectedOptions[0].textContent).toBe("OpenAI: GPT-4o");
    expect((screen.getByRole("button", { name: "Save model" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the one chosen as aiModel, only once it differs from what is saved", async () => {
    api.put.mockResolvedValue({ aiModel: "openai/gpt-4o" });
    render(<AiKeys />);
    const model = await (await card()).findByLabelText("Model");
    const save = screen.getByRole("button", { name: "Save model" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(model, { target: { value: "openai/gpt-4o" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings", { aiModel: "openai/gpt-4o" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Model saved", "success"));
    expect(save.disabled).toBe(true);
  });

  it("says why when the server refuses the model, and keeps the choice unsaved", async () => {
    api.put.mockRejectedValue(new Error("OpenRouter has no model openai/gpt-9-typo. Check the name against openrouter.ai/models."));
    models = { ...PLATFORM_MODELS, restricted: false, providers: null };
    render(<AiKeys />);
    const model = await (await card()).findByLabelText("Model");

    fireEvent.change(model, { target: { value: "openai/gpt-9-typo" } });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));

    expect((await screen.findByText(/OpenRouter has no model openai\/gpt-9-typo/)).getAttribute("role")).toBe("alert");
    expect(toast).not.toHaveBeenCalledWith("Model saved", "success");
    expect((screen.getByRole("button", { name: "Save model" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("is a field with OpenRouter's models offered, and the own key said to run any, when the key in use is the organisation's own", async () => {
    models = { ...PLATFORM_MODELS, restricted: false, providers: null, models: [{ id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5" }] };
    render(<AiKeys />);

    const model = (await (await card()).findByLabelText("Model")) as HTMLInputElement;

    expect(model.tagName).toBe("INPUT");
    expect(document.querySelector(`datalist#${CSS.escape(model.getAttribute("list") ?? "")} option`)?.getAttribute("value")).toBe("anthropic/claude-haiku-5.5");
    expect(screen.getByTestId("ai-model-note").textContent).toMatch(/Any OpenRouter model runs on this key/);
  });

  it("is a field to type in when OpenRouter's list cannot be read", async () => {
    models = { ...PLATFORM_MODELS, models: null };
    render(<AiKeys />);

    expect(((await (await card()).findByLabelText("Model")) as HTMLInputElement).tagName).toBe("INPUT");
  });

  it("is read again once the key is saved, since which models run depends on the key", async () => {
    api.put.mockResolvedValue({ ...FREE_CLOUD, set: true, hint: "wxyz" });
    render(<AiKeys />);
    await card();
    const reads = () => api.get.mock.calls.filter(([url]) => url === "/api/settings/ai-models").length;
    expect(reads()).toBe(1);

    fireEvent.change(await keyField(), { target: { value: "sk-or-v1-0123456789abcdef" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(reads()).toBe(2));
  });

  it("says why a key cannot be removed while its model is in use, and keeps the key", async () => {
    answerKey({ ...FREE_CLOUD, plan: "pro", set: true, hint: "wxyz" });
    api.put.mockRejectedValue(new Error("Your own key is what runs anthropic/claude-haiku-5.5, and Board Planner's key does not. Choose a model it runs under Model, or keep your key."));
    render(<AiKeys />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove key" }));

    expect((await screen.findByText(/Your own key is what runs anthropic\/claude-haiku-5\.5/)).getAttribute("role")).toBe("alert");
    expect(screen.getByText(/A key ending in/)).toBeTruthy();
  });
});
