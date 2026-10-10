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

const NO_USAGE = { scope: "month", used: 0, limit: null, resetsAt: null, today: 0, dailyCeiling: null, ownTokens: 0, locked: false };
const FREE_CLOUD = { hosted: true, plan: "free", set: false, hint: "", unreadable: false, included: false, usage: NO_USAGE };

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(FREE_CLOUD);
});
afterEach(cleanup);

const keyField = (verb: "Add" | "Replace" = "Add") => screen.findByLabelText(`${verb} your OpenRouter key`) as Promise<HTMLInputElement>;

describe("Settings → AI key", () => {
  it("says it is one key, for the PM agent and for AI Assist", async () => {
    render(<AiKeys />);

    expect(await screen.findByText(/Runs the PM agent .* and AI Assist/)).toBeTruthy();
    expect(document.querySelectorAll("input[type=password]")).toHaveLength(1);
    expect(screen.queryByText(/OpenAI/)).toBeNull();
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
    api.get.mockResolvedValue({ ...FREE_CLOUD, plan: "pro" });
    render(<AiKeys />);

    expect(await screen.findByText(/this service has no key to offer/)).toBeTruthy();
    expect(screen.queryByText(/Free plan/)).toBeNull();
  });

  it("says a plan that includes managed AI covers an organisation with no key of its own", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, plan: "pro", included: true });
    render(<AiKeys />);

    expect(await screen.findByText(/runs on ours, which your plan includes/)).toBeTruthy();
  });

  it("does not claim the key is free of limits, which this screen does not decide", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, set: true, hint: "abcd" });
    render(<AiKeys />);
    await screen.findByText("abcd");

    expect(document.body.textContent).not.toMatch(/caps? it|uncapped|no limit/i);
  });

  it("shows a stored key by its last four characters only, and offers to replace or remove it", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, set: true, hint: "abcd" });
    render(<AiKeys />);

    expect(await screen.findByText("abcd")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove key" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save key" })).toBeNull();
  });

  it("does not print an empty hint when a key was stored without one", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, set: true, hint: "" });
    render(<AiKeys />);

    expect(await screen.findByText(/A key is stored\./)).toBeTruthy();
    expect(screen.queryByText(/ending in/)).toBeNull();
  });

  it("says a stored key that cannot be opened is broken, and asks for it again rather than showing it as set", async () => {
    api.get.mockResolvedValue({ ...FREE_CLOUD, set: true, hint: "abcd", unreadable: true });
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
    api.get.mockResolvedValue({ ...FREE_CLOUD, set: true, hint: "wxyz" });
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
    api.get.mockResolvedValue({ ...FREE_CLOUD, set: true, hint: "wxyz" });
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
    api.get.mockResolvedValue({ hosted: false, plan: "free", set: false, hint: "", unreadable: false, included: true, usage: NO_USAGE });
    render(<AiKeys />);

    expect(await screen.findByText(/runs on the key this server was set up with/)).toBeTruthy();
    expect(screen.getByText("Server key")).toBeTruthy();
    expect(screen.queryByText(/Free plan/)).toBeNull();
  });

  it("says a self-hosted server with no key anywhere does not run", async () => {
    api.get.mockResolvedValue({ hosted: false, plan: "free", set: false, hint: "", unreadable: false, included: false, usage: NO_USAGE });
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
    locked: false,
    ...over,
  });
  const PRO_CLOUD = { ...FREE_CLOUD, plan: "pro", included: true };

  it("says how much of the month's allowance is used and when it renews, with the bar and the share", async () => {
    api.get.mockResolvedValue({ ...PRO_CLOUD, usage: usage() });
    render(<AiKeys />);

    const month = await screen.findByTestId("ai-usage-month");
    expect(month.textContent).toBe("4,200,000 of 15,000,000 tokens used this month. It renews on 1 November 2026 (UTC).");
    expect(screen.getByText("28% used")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "AI tokens used this month" }).getAttribute("aria-valuenow")).toBe("4200000");
    expect(screen.getByTestId("ai-usage-today").textContent).toBe("Today (UTC): 900,000 tokens; one day may use at most 3,000,000.");
  });

  it("says a trial's allowance is for the trial, with nothing renewing", async () => {
    api.get.mockResolvedValue({ ...PRO_CLOUD, usage: usage({ scope: "trial", used: 3_000_000, limit: 3_000_000, resetsAt: null, dailyCeiling: 600_000 }) });
    render(<AiKeys />);

    expect((await screen.findByTestId("ai-usage-month")).textContent).toBe("3,000,000 of 3,000,000 tokens used in your trial.");
    expect(screen.getByText("100% used")).toBeTruthy();
  });

  it("counts and shows tokens where nothing limits them, with no bar", async () => {
    api.get.mockResolvedValue({ hosted: false, plan: "free", set: false, hint: "", unreadable: false, included: true, usage: usage({ limit: null, resetsAt: null, dailyCeiling: null, used: 12_345, today: 300 }) });
    render(<AiKeys />);

    expect((await screen.findByTestId("ai-usage-month")).textContent).toBe("12,345 tokens used this month, and nothing limits them.");
    expect(screen.getByText("Not limited")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("ai-usage-today").textContent).toBe("Today (UTC): 300 tokens.");
  });

  it("shows what an own key used apart, and says it is never limited, only when it used any", async () => {
    api.get.mockResolvedValue({ ...PRO_CLOUD, usage: usage({ ownTokens: 77_000 }) });
    render(<AiKeys />);
    expect((await screen.findByTestId("ai-usage-own")).textContent).toBe("Your own key: 77,000 tokens this month, counted and never limited.");

    cleanup();
    api.get.mockResolvedValue({ ...PRO_CLOUD, usage: usage({ ownTokens: 0 }) });
    render(<AiKeys />);
    await screen.findByTestId("ai-usage-month");
    expect(screen.queryByTestId("ai-usage-own")).toBeNull();
  });

  it("says on the key card too that ours is switched off, so it does not promise what the operator took away", async () => {
    api.get.mockResolvedValue({ ...PRO_CLOUD, usage: usage({ locked: true }) });
    render(<AiKeys />);

    expect(await screen.findByText(/the operator has switched ours off for this organisation/)).toBeTruthy();
    expect(screen.queryByText(/which your plan includes/)).toBeNull();
    expect(screen.queryByText("Included")).toBeNull();
  });

  it("does not take the own key's word away: a stored key still reads as used first while the lock is on", async () => {
    api.get.mockResolvedValue({ ...PRO_CLOUD, set: true, hint: "abcd", usage: usage({ locked: true }) });
    render(<AiKeys />);

    expect(await screen.findByText("Your own key")).toBeTruthy();
    expect(screen.getByText(/It is used first/)).toBeTruthy();
  });

  it("says the operator has switched the key off, and offers the own key as the way on", async () => {
    api.get.mockResolvedValue({ ...PRO_CLOUD, usage: usage({ locked: true }) });
    render(<AiKeys />);

    const alert = await screen.findByTestId("ai-usage-locked");
    expect(alert.textContent).toMatch(/The operator has switched off the use of its key for this organisation\. Add your own key below to keep going\./);
    expect(screen.getAllByText("Switched off")).toHaveLength(2);
  });
});
