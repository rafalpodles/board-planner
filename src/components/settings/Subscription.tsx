"use client";

import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useOrganisation } from "@/hooks/use-organisation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { formatPlanDate } from "@/lib/plan-notice";
import type { BillingSummary, SubscriptionSummary } from "@/app/api/admin/billing/route";

const LIVE = ["active", "trialing", "past_due", "unpaid"];
const POLL_MS = 3_000;
const POLL_TIMES = 10;

type Interval = "month" | "year";

export const isLiveSubscription = (subscription: SubscriptionSummary | null): subscription is SubscriptionSummary =>
  !!subscription && !!subscription.status && LIVE.includes(subscription.status);

function Details({ subscription }: { subscription: SubscriptionSummary }) {
  const end = subscription.currentPeriodEnd ? formatPlanDate(subscription.currentPeriodEnd) : null;
  return (
    <dl className="divide-y divide-border rounded-lg border border-border text-sm" data-testid="subscription-details">
      <div className="flex gap-4 px-4 py-2">
        <dt className="w-24 shrink-0 text-text-muted sm:w-48">Billing</dt>
        <dd>
          {subscription.interval === "year" ? "Yearly" : "Monthly"}
          {subscription.launch && <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">Launch price</span>}
        </dd>
      </div>
      <div className="flex gap-4 px-4 py-2">
        <dt className="w-24 shrink-0 text-text-muted sm:w-48">{subscription.cancelAtPeriodEnd ? "Ends" : "Renews"}</dt>
        <dd data-testid="subscription-period">{end ?? "—"}</dd>
      </div>
      {subscription.extraMembers > 0 && (
        <div className="flex gap-4 px-4 py-2">
          <dt className="w-24 shrink-0 text-text-muted sm:w-48">Extra members</dt>
          <dd className="tabular-nums">{subscription.extraMembers} above the 10 included</dd>
        </div>
      )}
    </dl>
  );
}

export function Subscription() {
  const api = useApi();
  const { toast } = useToast();
  const { organisation, reload } = useOrganisation();
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [interval, setInterval] = useState<Interval>("month");
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);
  const [returned, setReturned] = useState<"success" | "cancelled" | null>(null);

  const load = useCallback(async () => {
    try {
      setBilling(await api.get("/api/admin/billing"));
    } catch {
      setBilling({ available: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
    const result = new URLSearchParams(window.location.search).get("checkout");
    if (result === "success" || result === "cancelled") setReturned(result);
  }, [load]);

  // The payment is Stripe's word reaching us through a webhook, so the plan follows the redirect by a few seconds
  useEffect(() => {
    if (returned !== "success") return;
    let times = 0;
    const timer = window.setInterval(() => {
      times += 1;
      void reload();
      void load();
      if (times >= POLL_TIMES) window.clearInterval(timer);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [returned, reload, load]);

  async function go(action: "checkout" | "portal") {
    setBusy(action);
    try {
      const answer = await api.post(`/api/admin/billing/${action}`, action === "checkout" ? { interval } : {});
      window.location.assign(answer.url);
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "Could not reach the payment service", "error");
      setBusy(null);
    }
  }

  if (!billing || !billing.available || !organisation) return null;
  const subscription = billing.subscription;
  const live = isLiveSubscription(subscription);
  const operatorManaged = !live && organisation.plan === "pro" && organisation.trial !== true;
  if (operatorManaged) return null;

  return (
    <section data-testid="subscription" className="mb-6 space-y-3">
      <h3 className="text-base font-semibold">Subscription</h3>
      {returned === "success" && (
        <p role="status" className="rounded-lg border border-border p-4 text-sm" data-testid="subscription-returned">
          Thank you. The payment is being confirmed; this page updates in a moment.
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
          <Details subscription={subscription} />
          <Button variant="secondary" onClick={() => go("portal")} disabled={busy !== null} data-testid="subscription-manage">
            {busy === "portal" ? "Opening…" : "Manage subscription"}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-text-muted">
            {organisation.trial ? "Subscribe to keep Pro when the trial ends." : "Upgrade to Pro: more than 10 members, managed AI and the rest of the Pro features."}
            {billing.launchOpen && " The launch price is open, and a subscription keeps it for as long as it runs."}
          </p>
          <fieldset className="flex flex-wrap gap-3" disabled={busy !== null}>
            <legend className="sr-only">Billing period</legend>
            {(["month", "year"] as const).map((value) => (
              <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-4 text-sm has-[:checked]:border-primary">
                <input type="radio" name="billing-interval" checked={interval === value} onChange={() => setInterval(value)} />
                {value === "month" ? "Monthly" : "Yearly"}
              </label>
            ))}
          </fieldset>
          <Button onClick={() => go("checkout")} disabled={busy !== null} data-testid="subscription-checkout">
            {busy === "checkout" ? "Opening…" : "Continue to payment"}
          </Button>
        </>
      )}
    </section>
  );
}
