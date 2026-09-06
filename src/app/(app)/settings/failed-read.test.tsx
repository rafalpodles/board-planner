// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

/**
 * BP-577. Each of these screens swallowed a failed read into an empty result and then made a
 * positive claim about the data: nothing recorded, nothing finished, no mail server configured.
 * The read failing is not evidence for any of the three.
 */

const { api, router } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  // One object for the life of the file: a fresh one per render is a new effect dependency, and
  // the load these pages run on mount would fire again on every render
  router: { replace: vi.fn(), push: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAdmin: true, isLoading: false, user: { email: "a@b.c" } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { default: AuditPage } = await import("./audit/page");
const { default: RunsPage } = await import("./workers/runs/page");
const { default: EmailPage } = await import("./email/page");

beforeEach(() => {
  api.get.mockReset();
});

afterEach(cleanup);

const screens = [
  {
    name: "the instance audit log",
    Page: AuditPage,
    testId: "instance-audit-error",
    claim: "Nothing recorded yet.",
  },
  {
    name: "the run history",
    Page: RunsPage,
    testId: "fleet-runs-error",
    claim: "Nothing has finished yet.",
  },
] as const;

describe.each(screens)("$name when the read fails", ({ Page, testId, claim }) => {
  it("says the read failed instead of the claim, and offers Retry", async () => {
    api.get.mockImplementation(() => Promise.reject(new Error("network")));
    render(<Page />);

    await waitFor(() => expect(screen.getByTestId(testId)).toBeTruthy());
    expect(screen.queryByText(claim)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("reads again on Retry and shows the data when it answers", async () => {
    api.get
      .mockImplementationOnce(() => Promise.reject(new Error("network")))
      .mockResolvedValue([]);
    render(<Page />);

    await waitFor(() => expect(screen.getByTestId(testId)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByText(claim)).toBeTruthy());
    expect(screen.queryByTestId(testId)).toBeNull();
  });

  // Without this control the failure branch could be rendering unconditionally
  it("still reads as empty when the read answers with nothing", async () => {
    api.get.mockResolvedValue([]);
    render(<Page />);

    await waitFor(() => expect(screen.getByText(claim)).toBeTruthy());
    expect(screen.queryByTestId(testId)).toBeNull();
  });
});

describe("the email settings screen when the read fails", () => {
  const UNCONFIGURED = /No mail server is configured/;

  it("never tells an administrator to set SMTP_HOST and restart", async () => {
    api.get.mockImplementation(() => Promise.reject(new Error("network")));
    render(<EmailPage />);

    await waitFor(() => expect(screen.getByTestId("email-settings-error")).toBeTruthy());
    expect(screen.queryByText(UNCONFIGURED)).toBeNull();
    expect(screen.queryByText(/SMTP_HOST/)).toBeNull();
  });

  it("shows the server once a Retry answers", async () => {
    api.get
      .mockImplementationOnce(() => Promise.reject(new Error("network")))
      .mockResolvedValue({ configured: true, host: "mail.example", port: 587, user: "u", from: "f" });
    render(<EmailPage />);

    await waitFor(() => expect(screen.getByTestId("email-settings-error")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByText("mail.example:587")).toBeTruthy());
  });

  // The genuinely unconfigured instance must still get the instruction
  it("still says the mail server is unconfigured when the read says so", async () => {
    api.get.mockResolvedValue({ configured: false, host: "", port: 0, user: "", from: "" });
    render(<EmailPage />);

    await waitFor(() => expect(screen.getByText(UNCONFIGURED)).toBeTruthy());
    expect(screen.queryByTestId("email-settings-error")).toBeNull();
  });
});
