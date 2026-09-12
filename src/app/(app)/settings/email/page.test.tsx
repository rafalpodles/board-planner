// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import EmailSettingsPage from "./page";

/**
 * BP-469. What the screen says after a test message failed, and why the two wordings are not
 * interchangeable. The route spends 502 on whatever `sendEmailOrThrow` threw once a transport was
 * built — a refusal at DATA, but a connection timeout or a failed STARTTLS upgrade too
 * (`route.test.ts` pins that last one) — and answers 409, 400 or 403 for the refusals it made
 * itself, before anything was contacted. The screen reads 502 as "ask the mail server" and
 * everything else as "ask us", and sending an admin to read a mail log that has nothing in it is
 * what the distinction exists to prevent.
 *
 * The e2e (`e2e/mail-test-send.spec.ts`) drives the two states a run can arrange for real. The
 * states in between are here, where a status is a number rather than something to provoke.
 */

const { api, toast, router } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
  // One object for the whole file. `useRouter()`'s result is in the load effect's dependency
  // array, so a mock minting a fresh one per render re-runs the read after every state change —
  // an endless loop that `await act(async () => …)` waits out rather than returns from.
  router: { replace: vi.fn(), push: vi.fn() },
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
vi.mock("next/navigation", () => ({ useRouter: () => router }));

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

/** `findBy` rather than a bare render: the heading appears only once the load effect has answered. */
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

  /**
   * Everything that is not a 502, on the one branch they share. Listed rather than written out
   * once, because each of the four is a real answer with a different reason to be here — and
   * because only the 503 separates `status === 502` from a `status >= 500` reading of it. A
   * failure names the case, so the list costs nothing a single test would have saved.
   */
  const notTheMailServer = [
    // The route's own answer for "no mail server configured". "The mail server refused it" above
    // "No mail server is configured" is nonsense, and this status exists to prevent it.
    [409, "No mail server is configured"],
    // The route's own refusal: the caller has no address to send to
    [400, "Add an address to your own profile first"],
    // A proxy or a restarting instance, with no mail server anywhere near it
    [503, "Service Unavailable"],
    // A request that never arrived carries no status at all
    [undefined, "Failed to fetch"],
  ] as const;

  for (const [status, message] of notTheMailServer) {
    it(`does not blame a mail server for ${status ?? "a failure with no status"}`, async () => {
      api.post.mockRejectedValue(refusalWith(status, message));

      await openTheScreen();
      await pressSend();

      const panel = screen.getByRole("alert");
      expect(panel.textContent).toContain("Nothing was sent");
      expect(panel.textContent).not.toContain("The mail server refused it");
      // The reason travels too, or the panel says only that something went wrong
      expect(panel.textContent).toContain(message);
    });
  }

  /**
   * Measured while the second attempt is still in flight, which is the only window in which the
   * two versions differ: the answer that lands afterwards overwrites the panel either way, so an
   * assertion made after it passes with `setResult(null)` deleted. What a reader must not be shown
   * is last attempt's refusal sitting under a button that says "Sending…".
   */
  it("takes the previous answer down before the next attempt, not after it", async () => {
    api.post.mockRejectedValueOnce(refusalWith(502, "550 5.7.1 Rejected"));

    await openTheScreen();
    await pressSend();
    expect(screen.getByRole("alert")).toBeTruthy();

    let accept!: (answer: { to: string }) => void;
    api.post.mockReturnValueOnce(
      new Promise<{ to: string }>((resolve) => {
        accept = resolve;
      })
    );
    await pressSend();

    expect(screen.getByRole("button", { name: "Sending…" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      accept({ to: "admin@example.test" });
    });

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
