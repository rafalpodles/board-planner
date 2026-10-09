"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useOrganisation } from "@/hooks/use-organisation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { formatPlanDate, planNotice } from "@/lib/plan-notice";
import { INCLUDED_MEMBERS, type BillingSummary, type Money, type OfferSummary, type SubscriptionSummary } from "@/lib/subscription-summary";

const LIVE = ["active", "trialing", "past_due", "unpaid"];
const POLL_MS = 3_000;
const POLL_TIMES = 10;

type Interval = "month" | "year";

export const isLiveSubscription = (subscription: SubscriptionSummary | null): subscription is SubscriptionSummary =>
  !!subscription && !!subscription.status && LIVE.includes(subscription.status);

const money = ({ amount, currency }: Money) => new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);

const priceLabel = ({ amount, currency }: Money) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: amount % 100 === 0 ? 0 : 2 }).format(amount / 100);

function PeriodChoice({ offer, interval, onChange, disabled }: { offer: OfferSummary | null; interval: Interval; onChange: (value: Interval) => void; disabled: boolean }) {
  const saving = offer ? 12 * offer.month.base.amount - offer.year.base.amount : 0;
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2" disabled={disabled}>
      <legend className="sr-only">Billing period</legend>
      {(["month", "year"] as const).map((value) => (
        <label
          key={value}
          className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-4 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary"
        >
          <input type="radio" name="billing-interval" className="mt-1" checked={interval === value} onChange={() => onChange(value)} />
          <span className="min-w-0">
            <span className="block font-medium">{value === "month" ? "Monthly" : "Yearly"}</span>
            {offer && (
              <span className="block tabular-nums" data-testid={`subscription-price-${value}`}>
                {priceLabel(offer[value].base)} per {value}
              </span>
            )}
            {offer && value === "year" && saving > 0 && (
              <span className="block text-text-muted" data-testid="subscription-saving">
                Saves {priceLabel({ amount: saving, currency: offer.year.base.currency })} a year
              </span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function Row({ label, testId, children }: { label: string; testId?: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 px-4 py-2">
      <dt className="w-24 shrink-0 text-text-muted sm:w-48">{label}</dt>
      <dd className="min-w-0" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

function Details({ subscription, members, memberPrice, upcoming }: { subscription: SubscriptionSummary; members: number | undefined; memberPrice: Money | null; upcoming: Money | null }) {
  const end = subscription.currentPeriodEnd ? formatPlanDate(subscription.currentPeriodEnd) : null;
  const per = subscription.interval === "year" ? "year" : "month";
  return (
    <dl className="divide-y divide-border rounded-lg border border-border text-sm" data-testid="subscription-details">
      <Row label="Billing">
        {subscription.interval === "year" ? "Yearly" : "Monthly"}
        {subscription.launch && <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">Launch price</span>}
      </Row>
      {members !== undefined && (
        <Row label="Members" testId="subscription-members">
          <span className="tabular-nums">{members}</span>, {INCLUDED_MEMBERS} included
        </Row>
      )}
      <Row label={`Billed above ${INCLUDED_MEMBERS}`} testId="subscription-billed">
        {subscription.extraMembers === 0 ? (
          "None"
        ) : (
          <span className="tabular-nums">
            {subscription.extraMembers}
            {memberPrice && ` × ${money(memberPrice)} per ${per}`}
          </span>
        )}
      </Row>
      <Row label={subscription.cancelAtPeriodEnd ? "Ends" : "Renews"} testId="subscription-period">
        {end ?? "—"}
      </Row>
      {upcoming && end && !subscription.cancelAtPeriodEnd && (
        <Row label="Next invoice" testId="subscription-next-invoice">
          {money(upcoming)} on {end}
        </Row>
      )}
    </dl>
  );
}

export function Subscription() {
  const api = useApi();
  const { toast } = useToast();
  const { organisation, reload } = useOrganisation();
  const [billing, setBilling] = useState<(BillingSummary & { unreachable?: boolean }) | null>(null);
  const [interval, setInterval] = useState<Interval>("month");
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);
  const [returned, setReturned] = useState<"success" | "cancelled" | null>(null);
  const [pollEnded, setPollEnded] = useState(false);

  const load = useCallback(async () => {
    try {
      const next: BillingSummary & { unreachable?: boolean } = await api.get("/api/admin/billing");
      // A service that cannot be reached for a moment is not one that takes no payments: keep what the page showed
      setBilling((previous) => (!next.available && next.unreachable && previous ? previous : next));
    } catch {
      setBilling((previous) => previous ?? { available: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
    const params = new URLSearchParams(window.location.search);
    const result = params.get("checkout");
    if (result === "success" || result === "cancelled") {
      setReturned(result);
      // Said once: a reload must not thank for a payment again
      params.delete("checkout");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }
  }, [load]);

  // The browser's Back from Stripe may show this page as it was left, with the button still busy
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(null);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  const subscription = billing?.available ? billing.subscription : null;
  const live = isLiveSubscription(subscription);

  // What the organisation was when the person came back, so "paid for" is the plan or its end changing, which
  // a trial or a Pro in its last days (already Pro) would otherwise never show
  const before = useRef<{ plan: string; planEndsAt: string | null } | null>(null);
  useEffect(() => {
    if (returned === "success" && organisation && !before.current) before.current = { plan: organisation.plan, planEndsAt: organisation.planEndsAt };
  }, [returned, organisation]);
  const changed = !!organisation && !!before.current && (organisation.plan !== before.current.plan || organisation.planEndsAt !== before.current.planEndsAt);
  const settled = live && changed && organisation?.plan === "pro";

  // The payment is Stripe's word reaching us through a webhook and then the key reaching the product, so the
  // plan follows the redirect by a few seconds
  useEffect(() => {
    if (returned !== "success" || pollEnded || settled) return;
    let times = 0;
    const timer = window.setInterval(() => {
      times += 1;
      void reload();
      void load();
      if (times >= POLL_TIMES) {
        window.clearInterval(timer);
        setPollEnded(true);
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [returned, pollEnded, settled, reload, load]);

  async function go(action: "checkout" | "portal") {
    setBusy(action);
    try {
      // A 502 here is the payment service failing, which says nothing about this instance's database (BP-607)
      const answer = await api.post(`/api/admin/billing/${action}`, action === "checkout" ? { interval } : {}, { relayed: true });
      window.location.assign(answer.url);
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "Could not reach the payment service", "error");
      setBusy(null);
      // "Already subscribed" or "nothing to manage" means the page was out of date
      void load();
    }
  }

  if (!billing || !billing.available || !organisation) return null;
  const notice = planNotice(organisation);
  // Pro that nobody pays for through here, and that is not about to end, has nothing to subscribe to: an operator holds it
  const operatorManaged = !live && organisation.plan === "pro" && organisation.trial !== true && notice.kind === "pro";
  if (operatorManaged) return null;
  const confirming = returned === "success" && !live && !pollEnded;

  return (
    <section data-testid="subscription" className="mb-6 space-y-3">
      <h3 className="text-base font-semibold">Subscription</h3>
      {returned === "success" && (
        <p role="status" className="rounded-lg border border-border p-4 text-sm" data-testid="subscription-returned">
          {live
            ? "Your subscription is active."
            : pollEnded
              ? "The payment is taking longer than usual to confirm. Reload this page in a few minutes."
              : "Thank you. The payment is being confirmed; this page updates in a moment."}
        </p>
      )}
      {returned === "cancelled" && (
        <p role="status" className="rounded-lg border border-border p-4 text-sm" data-testid="subscription-returned">
          Checkout was cancelled. Nothing was charged.
        </p>
      )}
      {live ? (
        <>
          {(subscription.status === "past_due" || subscription.status === "unpaid") && (
            <p role="alert" className="rounded-lg border border-danger p-4 text-sm text-danger" data-testid="subscription-past-due">
              The last payment failed. Update the payment method under Manage subscription: Pro stays on for 14 days after the paid period ends.
            </p>
          )}
          {subscription.cancelAtPeriodEnd && (
            <p role="status" className="rounded-lg border border-border p-4 text-sm" data-testid="subscription-cancelling">
              The subscription is cancelled and ends with the paid period. After that this organisation is on the Free plan; no data is removed.
            </p>
          )}
          <Details subscription={subscription} members={organisation.members} memberPrice={billing.available ? billing.memberPrice : null} upcoming={billing.available ? billing.upcoming : null} />
          <Button variant="secondary" onClick={() => go("portal")} disabled={busy !== null} data-testid="subscription-manage">
            {busy === "portal" ? "Opening…" : "Manage subscription"}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-text-muted">
            {organisation.trial
              ? "Subscribe to keep Pro when the trial ends."
              : organisation.plan === "pro"
                ? "Subscribe to keep Pro when this plan ends."
                : "Upgrade to Pro: more than 10 members, managed AI and the rest of the Pro features."}
            {billing.launchOpen && " The launch price is open: a subscription that starts at it keeps it for as long as it runs without a gap."}
          </p>
          <PeriodChoice offer={billing.offer} interval={interval} onChange={setInterval} disabled={busy !== null || confirming} />
          {billing.offer && (
            <div className="space-y-1 text-sm">
              <p data-testid="subscription-includes">
                <span className="font-medium">Pro</span> for the whole organisation: {billing.offer.includedMembers} {billing.offer.includedMembers === 1 ? "member" : "members"} included, then {priceLabel(billing.offer[interval].member)} per member per {interval}.
              </p>
              <p className="text-xs text-text-muted">Prices are in {billing.offer.month.base.currency.toUpperCase()}. Tax is added at checkout where it applies.</p>
            </div>
          )}
          <Button onClick={() => go("checkout")} disabled={busy !== null || confirming} data-testid="subscription-checkout">
            {busy === "checkout" ? "Opening…" : `Continue to payment${billing.offer ? ` · ${priceLabel(billing.offer[interval].base)} per ${interval}` : ""}`}
          </Button>
        </>
      )}
    </section>
  );
}
