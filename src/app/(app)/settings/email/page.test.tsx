// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import EmailSettingsPage from "./page";

/**
 * BP-469. What the screen says after a test message failed, and why the two wordings are not
 * interchangeable: the route answers 502 only when a mail server was reached and refused, and every
 * other refusal — no server configured, no address, a request that never arrived — never got that
 * far. "The mail server refused it" over any of those sends an admin to read logs that have nothing
 * in them.
 *
 * The e2e (`e2e/mail-test-send.spec.ts`) drives the two states a run can arrange for real. The
 * states in between are here, where a status is a number rather than something to provoke.
 */

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

const auth = {
  user: { _id: "u1", username: "admin", email: "admin@example.test" } as {
    _id: string;
    username: string;
    email: string;
  } | null,
  isAdmin: true,
  isLoading: false,
};

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

const CONFIGURED = {
  configured: true,
  host: "smtp.example.test",
  port: 2525,
  user: "mailer",
  from: "Board Planner <noreply@example.test>",
};

function refusalWith(status: number | undefined, message: string) {
  return Object.assign(new Error(message), status === undefined ? {} : { status });
}

/**
 * Rendered and then waited on with `findBy`, rather than inside `await act(async () => …)`: the
 * load effect's promise is awaited by act, and a rejected one — the failed-read case below — never
 * lets it return. `findBy` wraps its own polling in act, so the warnings that would otherwise
 * follow do not appear either.
 */
async function openTheScreen() {
  render(<EmailSettingsPage />);
  await screen.findByRole("heading", { name: "Email" });
}

async function pressSend() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Send a test message/ }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { _id: "u1", username: "admin", email: "admin@example.test" };
  api.get.mockResolvedValue(CONFIGURED);
});
afterEach(cleanup);

describe("the mail screen, once it has a mail server", () => {
  it("prints the server as one address, not two fields", async () => {
    await openTheScreen();

    expect(screen.getByText("smtp.example.test:2525")).toBeTruthy();
    expect(screen.getByText("mailer")).toBeTruthy();
    expect(screen.queryByText("No mail server is configured.")).toBeNull();
  });

  it("offers no button to an admin with no address of their own", async () => {
    auth.user = { _id: "u1", username: "admin", email: "" };

    await openTheScreen();

    expect(screen.getByRole("button", { name: /Send a test message/ })).toHaveProperty(
      "disabled",
      true
    );
    expect(screen.getByText(/Add an address to/)).toBeTruthy();
  });

  it("names the address a message was accepted for", async () => {
    api.post.mockResolvedValue({ to: "admin@example.test" });

    await openTheScreen();
    await pressSend();

    expect(screen.getByText("Accepted for delivery to admin@example.test")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  // The one status that means a mail server was reached and said no
  it("blames the mail server on a 502, and quotes it", async () => {
    api.post.mockRejectedValue(
      refusalWith(502, "550 5.7.1 Rejected: sender not permitted to relay")
    );

    await openTheScreen();
    await pressSend();

    const panel = screen.getByRole("alert");
    expect(panel.textContent).toContain("The mail server refused it");
    expect(panel.textContent).toContain("550 5.7.1 Rejected");
  });

  // Nothing was contacted. "The mail server refused it" above "No mail server is configured" is
  // nonsense, and this is the status the route uses to say exactly that.
  it("does not blame a mail server the request never reached, on a 409", async () => {
    api.post.mockRejectedValue(refusalWith(409, "No mail server is configured"));

    await openTheScreen();
    await pressSend();

    const panel = screen.getByRole("alert");
    expect(panel.textContent).toContain("Nothing was sent");
    expect(panel.textContent).not.toContain("The mail server refused it");
    expect(panel.textContent).toContain("No mail server is configured");
  });

  it("does not blame a mail server for a refusal of our own, on a 400", async () => {
    api.post.mockRejectedValue(refusalWith(400, "Add an address to your own profile first"));

    await openTheScreen();
    await pressSend();

    expect(screen.getByRole("alert").textContent).toContain("Nothing was sent");
  });

  // A request that never arrived carries no status at all, which is the case a `status >= 500`
  // reading of the same condition would get wrong
  it("does not blame a mail server for a failure with no status", async () => {
    api.post.mockRejectedValue(refusalWith(undefined, "Failed to fetch"));

    await openTheScreen();
    await pressSend();

    expect(screen.getByRole("alert").textContent).toContain("Nothing was sent");
  });

  // A second attempt after a failure must not read as both answers at once
  it("clears the previous answer before the next attempt", async () => {
    api.post.mockRejectedValueOnce(refusalWith(502, "550 5.7.1 Rejected"));

    await openTheScreen();
    await pressSend();
    expect(screen.getByRole("alert")).toBeTruthy();

    api.post.mockResolvedValue({ to: "admin@example.test" });
    await pressSend();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Accepted for delivery to admin@example.test")).toBeTruthy();
  });
});

describe("the mail screen when it cannot read its settings", () => {
  // Telling an admin whose SMTP works to set three environment variables and restart is an
  // instruction given on no evidence
  it("does not fall back to saying there is no mail server", async () => {
    api.get.mockRejectedValue(new Error("boom"));

    await openTheScreen();

    expect(screen.queryByText("No mail server is configured.")).toBeNull();
    expect(screen.getByTestId("email-settings-error")).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("Failed to read the mail settings", "error");
  });
});
