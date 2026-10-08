// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { Subscription } from "./Subscription";

const m = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  toast: vi.fn(),
  reload: vi.fn(),
  organisation: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => m.api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: m.toast, dismiss: vi.fn() }) }));
vi.mock("@/hooks/use-organisation", () => ({ useOrganisation: () => ({ organisation: m.organisation.current, reload: m.reload }) }));

const PERIOD_END = "2026-11-08T21:00:00.000Z";
const FREE = { name: "Acme", cloud: true, plan: "free", trial: false };
const live = (over: Record<string, unknown> = {}) => ({
  available: true,
  launchOpen: false,
  subscription: { status: "active", interval: "month", launch: false, extraMembers: 0, currentPeriodEnd: PERIOD_END, cancelAtPeriodEnd: false, ...over },
});

let assign: ReturnType<typeof vi.fn>;
const setLocation = (search = "") => {
  assign = vi.fn();
  Object.defineProperty(window, "location", { value: { assign, search }, writable: true, configurable: true });
};

beforeEach(() => {
  vi.clearAllMocks();
  m.organisation.current = FREE;
  m.api.get.mockResolvedValue({ available: true, launchOpen: true, subscription: null });
  setLocation();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// BP-676
describe("Subscription", () => {
  it("shows nothing where the payment service is off", async () => {
    m.api.get.mockResolvedValue({ available: false });
    const { container } = render(<Subscription />);

    await waitFor(() => expect(m.api.get).toHaveBeenCalled());
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("shows nothing for an organisation an operator holds on Pro, which has no subscription to start or manage", async () => {
    m.organisation.current = { ...FREE, plan: "pro" };
    const { container } = render(<Subscription />);

    await waitFor(() => expect(m.api.get).toHaveBeenCalled());
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("offers a Free organisation monthly or yearly, and says the launch price is open", async () => {
    render(<Subscription />);

    expect(await screen.findByText(/Upgrade to Pro/)).toBeTruthy();
    expect(screen.getByText(/The launch price is open/)).toBeTruthy();
    expect((screen.getByLabelText("Monthly") as HTMLInputElement).checked).toBe(true);
  });

  it("does not mention the launch price once it is closed", async () => {
    m.api.get.mockResolvedValue({ available: true, launchOpen: false, subscription: null });
    render(<Subscription />);

    await screen.findByText(/Upgrade to Pro/);
    expect(screen.queryByText(/launch price/i)).toBeNull();
  });

  it("asks a trial to subscribe to keep Pro", async () => {
    m.organisation.current = { ...FREE, plan: "pro", trial: true };
    render(<Subscription />);

    expect(await screen.findByText(/Subscribe to keep Pro when the trial ends/)).toBeTruthy();
  });

  it("starts a monthly checkout and goes to the page Stripe gives", async () => {
    m.api.post.mockResolvedValue({ url: "https://checkout.stripe.test/c/1" });
    render(<Subscription />);

    fireEvent.click(await screen.findByTestId("subscription-checkout"));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.test/c/1"));
    expect(m.api.post).toHaveBeenCalledWith("/api/admin/billing/checkout", { interval: "month" });
  });

  it("starts a yearly checkout when Yearly is chosen", async () => {
    m.api.post.mockResolvedValue({ url: "https://checkout.stripe.test/c/2" });
    render(<Subscription />);

    fireEvent.click(await screen.findByLabelText("Yearly"));
    fireEvent.click(screen.getByTestId("subscription-checkout"));

    await waitFor(() => expect(m.api.post).toHaveBeenCalledWith("/api/admin/billing/checkout", { interval: "year" }));
  });

  it("says what went wrong and gives the button back when no payment page comes", async () => {
    m.api.post.mockRejectedValue(new Error("Could not reach the payment service. Try again in a moment."));
    render(<Subscription />);

    fireEvent.click(await screen.findByTestId("subscription-checkout"));

    await waitFor(() => expect(m.toast).toHaveBeenCalledWith("Could not reach the payment service. Try again in a moment.", "error"));
    expect(assign).not.toHaveBeenCalled();
    expect((screen.getByTestId("subscription-checkout") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a running subscription with its period, the launch price and the members above ten, and opens the portal", async () => {
    m.api.get.mockResolvedValue(live({ interval: "year", launch: true, extraMembers: 4 }));
    m.api.post.mockResolvedValue({ url: "https://billing.stripe.test/p/1" });
    render(<Subscription />);

    const details = await screen.findByTestId("subscription-details");
    expect(details.textContent).toContain("Yearly");
    expect(details.textContent).toContain("Launch price");
    expect(details.textContent).toContain("4 above the 10 included");
    expect(screen.getByText("Renews")).toBeTruthy();
    expect(screen.queryByTestId("subscription-checkout")).toBeNull();

    fireEvent.click(screen.getByTestId("subscription-manage"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://billing.stripe.test/p/1"));
    expect(m.api.post).toHaveBeenCalledWith("/api/admin/billing/portal", {});
  });

  it("says a failed payment is to be fixed in the portal, with the grace that follows", async () => {
    m.api.get.mockResolvedValue(live({ status: "past_due" }));
    render(<Subscription />);

    expect((await screen.findByTestId("subscription-past-due")).textContent).toMatch(/Manage subscription.*14 days/);
  });

  it("says the same of a subscription Stripe has stopped collecting on", async () => {
    m.api.get.mockResolvedValue(live({ status: "unpaid" }));
    render(<Subscription />);

    expect((await screen.findByTestId("subscription-past-due")).textContent).toMatch(/Manage subscription/);
    expect(screen.queryByTestId("subscription-checkout")).toBeNull();
  });

  it("says a cancelled subscription ends with the paid period, and that nothing is removed", async () => {
    m.api.get.mockResolvedValue(live({ cancelAtPeriodEnd: true }));
    render(<Subscription />);

    expect((await screen.findByTestId("subscription-cancelling")).textContent).toMatch(/ends with the paid period.*no data is removed/);
    expect(screen.getByText("Ends")).toBeTruthy();
  });

  it("offers checkout again once the subscription has ended", async () => {
    m.api.get.mockResolvedValue(live({ status: "canceled" }));
    render(<Subscription />);

    expect(await screen.findByTestId("subscription-checkout")).toBeTruthy();
    expect(screen.queryByTestId("subscription-manage")).toBeNull();
  });

  it("thanks the person back from a payment and follows the plan until it changes", async () => {
    vi.useFakeTimers();
    setLocation("?checkout=success");
    render(<Subscription />);
    await act(async () => {});

    expect(screen.getByTestId("subscription-returned").textContent).toMatch(/Thank you/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(m.reload).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(m.reload).toHaveBeenCalledTimes(10);
  });

  it("says a cancelled checkout charged nothing, and does not poll", async () => {
    vi.useFakeTimers();
    setLocation("?checkout=cancelled");
    render(<Subscription />);
    await act(async () => {});

    expect(screen.getByTestId("subscription-returned").textContent).toMatch(/Nothing was charged/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(m.reload).not.toHaveBeenCalled();
  });
});
