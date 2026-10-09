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
const FREE = { name: "Acme", cloud: true, plan: "free", planEndsAt: null, trial: false };
const live = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  available: true,
  launchOpen: false,
  subscription: { status: "active", interval: "month", launch: false, extraMembers: 0, currentPeriodEnd: PERIOD_END, cancelAtPeriodEnd: false, ...over },
  memberPrice: null,
  upcoming: null,
  ...extra,
});

let assign: ReturnType<typeof vi.fn>;
let replaceState: ReturnType<typeof vi.fn>;
const setLocation = (search = "") => {
  assign = vi.fn();
  replaceState = vi.fn();
  Object.defineProperty(window, "location", { value: { assign, search, pathname: "/settings/organisation", hash: "" }, writable: true, configurable: true });
  Object.defineProperty(window, "history", { value: { replaceState }, writable: true, configurable: true });
};
const DAY = 86_400_000;
const endsIn = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const shown = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

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
    expect(screen.getByRole("group", { name: "Billing period" })).toBeTruthy();
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
    expect(m.api.post).toHaveBeenCalledWith("/api/admin/billing/checkout", { interval: "month" }, { relayed: true });
  });

  it("starts a yearly checkout when Yearly is chosen", async () => {
    m.api.post.mockResolvedValue({ url: "https://checkout.stripe.test/c/2" });
    render(<Subscription />);

    fireEvent.click(await screen.findByLabelText("Yearly"));
    fireEvent.click(screen.getByTestId("subscription-checkout"));

    await waitFor(() => expect(m.api.post).toHaveBeenCalledWith("/api/admin/billing/checkout", { interval: "year" }, { relayed: true }));
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
    expect(screen.getByTestId("subscription-period").textContent).toBe(shown(PERIOD_END));
    expect(details.textContent).toContain("Yearly");
    expect(details.textContent).toContain("Launch price");
    expect(screen.getByTestId("subscription-billed").textContent).toBe("4");
    expect(screen.getByText("Renews")).toBeTruthy();
    expect(screen.queryByTestId("subscription-checkout")).toBeNull();

    fireEvent.click(screen.getByTestId("subscription-manage"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://billing.stripe.test/p/1"));
    expect(m.api.post).toHaveBeenCalledWith("/api/admin/billing/portal", {}, { relayed: true });
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

    expect((await screen.findByTestId("subscription-cancelling")).textContent).toMatch(/ends with the paid period.*Free plan.*no data is removed/);
    expect(screen.getByTestId("subscription-cancelling").textContent).not.toMatch(/14 days/);
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

  it("shows a trialing subscription as a running one", async () => {
    m.api.get.mockResolvedValue(live({ status: "trialing" }));
    render(<Subscription />);

    expect(await screen.findByTestId("subscription-manage")).toBeTruthy();
  });

  it("offers a subscription to an organisation whose Pro is in its grace days or ending, as the sidebar's Renew does", async () => {
    for (const planEndsAt of [endsIn(-3), endsIn(10)]) {
      cleanup();
      m.organisation.current = { ...FREE, plan: "pro", planEndsAt };
      render(<Subscription />);
      expect(await screen.findByTestId("subscription-checkout"), planEndsAt).toBeTruthy();
    }
  });

  it("shows nothing for Pro an operator holds with time left", async () => {
    m.organisation.current = { ...FREE, plan: "pro", planEndsAt: endsIn(200) };
    const { container } = render(<Subscription />);

    await waitFor(() => expect(m.api.get).toHaveBeenCalled());
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("takes the thank-you parameter off the address, keeping the others, so a reload does not repeat it", async () => {
    setLocation("?tab=plan&checkout=success");
    render(<Subscription />);
    await act(async () => {});

    expect(replaceState).toHaveBeenCalledWith(null, "", "/settings/organisation?tab=plan");
  });

  it("says the subscription is active once it is, and stops following the plan when it is Pro", async () => {
    vi.useFakeTimers();
    setLocation("?checkout=success");
    m.api.get.mockResolvedValue(live());
    const { rerender } = render(<Subscription />);
    await act(async () => {});
    m.organisation.current = { ...FREE, plan: "pro", planEndsAt: endsIn(30) };
    rerender(<Subscription />);
    await act(async () => {});

    expect(screen.getByTestId("subscription-returned").textContent).toBe("Your subscription is active.");
    m.reload.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(m.reload).not.toHaveBeenCalled();
  });

  it("keeps following a trial that has subscribed until the trial is over, though it was already Pro", async () => {
    vi.useFakeTimers();
    setLocation("?checkout=success");
    const trial = { ...FREE, plan: "pro", planEndsAt: endsIn(5), trial: true };
    m.organisation.current = trial;
    m.api.get.mockResolvedValue(live());
    const { rerender } = render(<Subscription />);
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(m.reload).toHaveBeenCalledTimes(1);

    m.organisation.current = { ...FREE, plan: "pro", planEndsAt: endsIn(30), trial: false };
    rerender(<Subscription />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(m.reload).toHaveBeenCalledTimes(1);
  });

  it("keeps following Pro in its last days until its end moves", async () => {
    vi.useFakeTimers();
    setLocation("?checkout=success");
    const ending = endsIn(10);
    m.organisation.current = { ...FREE, plan: "pro", planEndsAt: ending };
    m.api.get.mockResolvedValue(live());
    const { rerender } = render(<Subscription />);
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(m.reload).toHaveBeenCalledTimes(1);

    m.organisation.current = { ...FREE, plan: "pro", planEndsAt: endsIn(40) };
    rerender(<Subscription />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(m.reload).toHaveBeenCalledTimes(1);
  });

  it("speaks of keeping Pro, not upgrading to it, to an organisation that is already Pro", async () => {
    m.organisation.current = { ...FREE, plan: "pro", planEndsAt: endsIn(10) };
    render(<Subscription />);

    expect(await screen.findByText(/Subscribe to keep Pro when this plan ends/)).toBeTruthy();
    expect(screen.queryByText(/Upgrade to Pro/)).toBeNull();
  });

  it("keeps following the plan while the subscription is recorded and the key has not yet arrived", async () => {
    vi.useFakeTimers();
    setLocation("?checkout=success");
    m.api.get.mockResolvedValue(live());
    render(<Subscription />);
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(m.reload).toHaveBeenCalledTimes(1);
  });

  it("holds the payment button while a payment is being confirmed, and gives it back, with the truth, when it is not", async () => {
    vi.useFakeTimers();
    setLocation("?checkout=success");
    render(<Subscription />);
    await act(async () => {});

    expect((screen.getByTestId("subscription-checkout") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(screen.getByTestId("subscription-returned").textContent).toMatch(/taking longer than usual/);
    expect((screen.getByTestId("subscription-checkout") as HTMLButtonElement).disabled).toBe(false);
  });

  it("stops following the plan when the page goes away", async () => {
    vi.useFakeTimers();
    setLocation("?checkout=success");
    const { unmount } = render(<Subscription />);
    await act(async () => {});
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(m.reload).not.toHaveBeenCalled();
  });

  it("keeps what it showed when the service cannot be reached for a moment, and hides only for a service that takes no payments", async () => {
    vi.useFakeTimers();
    setLocation("?checkout=success");
    m.api.get.mockResolvedValueOnce(live()).mockResolvedValue({ available: false, unreachable: true });
    render(<Subscription />);
    await act(async () => {});
    expect(screen.getByTestId("subscription-details")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByTestId("subscription-details")).toBeTruthy();

    m.api.get.mockResolvedValue({ available: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.queryByTestId("subscription")).toBeNull();
  });

  it("reads the subscription again when the service says the page was out of date", async () => {
    m.api.post.mockRejectedValue(new Error("This organisation already has a subscription"));
    render(<Subscription />);
    fireEvent.click(await screen.findByTestId("subscription-checkout"));
    await waitFor(() => expect(m.toast).toHaveBeenCalled());

    await waitFor(() => expect(m.api.get).toHaveBeenCalledTimes(2));
  });

  it("is not stuck on Opening… when the browser restores the page after Back from Stripe", async () => {
    m.api.post.mockReturnValue(new Promise(() => {}));
    render(<Subscription />);
    fireEvent.click(await screen.findByTestId("subscription-checkout"));
    expect(screen.getByTestId("subscription-checkout").textContent).toBe("Opening…");

    await act(async () => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    });

    expect(screen.getByTestId("subscription-checkout").textContent).toBe("Continue to payment");
  });

  describe("what is bought (BP-980)", () => {
    const usd = (amount: number) => ({ amount, currency: "usd" });
    const offered = (over: Record<string, unknown> = {}) => ({
      available: true,
      launchOpen: true,
      subscription: null,
      memberPrice: null,
      upcoming: null,
      offer: { launch: true, includedMembers: 10, month: { base: usd(2900), member: usd(300) }, year: { base: usd(29000), member: usd(3000) }, ...over },
    });

    it("says the price of each period, what a year saves, what is included and what a member above it costs, and the button names the amount", async () => {
      m.api.get.mockResolvedValue(offered());
      render(<Subscription />);

      expect((await screen.findByTestId("subscription-price-month")).textContent).toBe("$29 per month");
      expect(screen.getByTestId("subscription-price-year").textContent).toBe("$290 per year");
      expect(screen.getByTestId("subscription-saving").textContent).toBe("Saves $58 a year");
      expect(screen.getByTestId("subscription-includes").textContent).toBe("Pro for the whole organisation: 10 members included, then $3 per member per month.");
      expect(screen.getByText("Prices are in USD. Tax is added at checkout where it applies.")).toBeTruthy();
      expect(screen.getByTestId("subscription-checkout").textContent).toBe("Continue to payment · $29 per month");
    });

    it("follows the period that is chosen: the member price and the button name the year, and the checkout is for it", async () => {
      m.api.post.mockResolvedValue({ url: "https://checkout.stripe.test/c/3" });
      m.api.get.mockResolvedValue(offered());
      render(<Subscription />);

      fireEvent.click(await screen.findByRole("radio", { name: /Yearly/ }));

      expect(screen.getByTestId("subscription-includes").textContent).toBe("Pro for the whole organisation: 10 members included, then $30 per member per year.");
      expect(screen.getByTestId("subscription-checkout").textContent).toBe("Continue to payment · $290 per year");
      fireEvent.click(screen.getByTestId("subscription-checkout"));
      await waitFor(() => expect(m.api.post).toHaveBeenCalledWith("/api/admin/billing/checkout", { interval: "year" }, { relayed: true }));
    });

    it("shows the standard prices when that is what a checkout would charge, and no saving where a year saves nothing", async () => {
      m.api.get.mockResolvedValue({ ...offered({ launch: false, month: { base: usd(4900), member: usd(500) }, year: { base: usd(58800), member: usd(6000) } }), launchOpen: false });
      render(<Subscription />);

      expect((await screen.findByTestId("subscription-price-month")).textContent).toBe("$49 per month");
      expect(screen.getByTestId("subscription-price-year").textContent).toBe("$588 per year");
      expect(screen.queryByTestId("subscription-saving")).toBeNull();
      expect(screen.queryByText(/launch price/i)).toBeNull();
    });

    it("shows no saving when a year costs more than twelve months, and says 1 member, not 1 members", async () => {
      m.api.get.mockResolvedValue(offered({ includedMembers: 1, year: { base: usd(35000), member: usd(3000) } }));
      render(<Subscription />);

      expect((await screen.findByTestId("subscription-price-year")).textContent).toBe("$350 per year");
      expect(screen.queryByTestId("subscription-saving")).toBeNull();
      expect(screen.getByTestId("subscription-includes").textContent).toContain("1 member included");
    });

    it("shows the cents a price has, and only those", async () => {
      m.api.get.mockResolvedValue(offered({ month: { base: usd(2950), member: usd(325) } }));
      render(<Subscription />);

      expect((await screen.findByTestId("subscription-price-month")).textContent).toBe("$29.50 per month");
      expect(screen.getByTestId("subscription-includes").textContent).toContain("then $3.25 per member");
    });

    it("names no price it was not given, and still starts a checkout", async () => {
      m.api.post.mockResolvedValue({ url: "https://checkout.stripe.test/c/4" });
      m.api.get.mockResolvedValue({ ...offered(), offer: null });
      render(<Subscription />);

      const button = await screen.findByTestId("subscription-checkout");
      expect(button.textContent).toBe("Continue to payment");
      expect(screen.queryByTestId("subscription-price-month")).toBeNull();
      expect(screen.queryByTestId("subscription-includes")).toBeNull();
      expect(screen.queryByText(/Tax is added/)).toBeNull();
      fireEvent.click(button);
      await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.test/c/4"));
    });
  });

  describe("members and the next invoice (BP-949)", () => {
    const priced = { memberPrice: { amount: 300, currency: "usd" }, upcoming: { amount: 5400, currency: "usd" } };

    it("shows the people there are, what is included, what is billed above it at what price, and what the next invoice is", async () => {
      m.organisation.current = { ...FREE, plan: "pro", planEndsAt: endsIn(20), members: 14 };
      m.api.get.mockResolvedValue(live({ interval: "year", extraMembers: 4 }, priced));
      render(<Subscription />);

      expect((await screen.findByTestId("subscription-members")).textContent).toBe("14, 10 included");
      expect(screen.getByTestId("subscription-billed").textContent).toBe("4 × $3.00 per year");
      expect(screen.getByTestId("subscription-next-invoice").textContent).toBe(`$54.00 on ${shown(PERIOD_END)}`);
    });

    it("says nothing is billed above ten when nobody is, and names no price it was not given", async () => {
      m.organisation.current = { ...FREE, plan: "pro", planEndsAt: endsIn(20), members: 8 };
      m.api.get.mockResolvedValue(live());
      render(<Subscription />);

      expect((await screen.findByTestId("subscription-billed")).textContent).toBe("None");
      expect(screen.queryByTestId("subscription-next-invoice")).toBeNull();
    });

    it("shows no next invoice for a subscription that is ending, and no members where the count is not known", async () => {
      m.organisation.current = { ...FREE, plan: "pro", planEndsAt: endsIn(20) };
      m.api.get.mockResolvedValue(live({ cancelAtPeriodEnd: true }, priced));
      render(<Subscription />);

      await screen.findByTestId("subscription-details");
      expect(screen.queryByTestId("subscription-next-invoice")).toBeNull();
      expect(screen.queryByTestId("subscription-members")).toBeNull();
    });
  });
});
