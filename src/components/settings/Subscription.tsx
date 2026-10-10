"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useOrganisation } from "@/hooks/use-organisation";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { formatPlanDate, planNotice } from "@/lib/plan-notice";
import { LEGAL_NOTICE_URL, PRIVACY_URL, TERMS_URL } from "@/lib/legal-seller";
import { INCLUDED_MEMBERS, withdrawableUntil, type BillingSummary, type Money, type OfferSummary, type SubscriptionSummary } from "@/lib/subscription-summary";

const LIVE = ["active", "trialing", "past_due", "unpaid"];
const POLL_MS = 3_000;
const POLL_TIMES = 10;

type Interval = "month" | "year";
type Buyer = "business" | "consumer";
type Available = Extract<BillingSummary, { available: true }>;

export const ORDER_BUTTON_LABEL = "Subscribe with an obligation to pay";
/** The licence service's confirmation e-mail repeats these words as the request the consumer made */
export const IMMEDIATE_START_CONSENT =
  "I ask for Pro to start immediately, before the 14-day withdrawal period ends. I understand that if I withdraw I pay for the time used until then, and that I lose the right of withdrawal once the service has been fully provided.";

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

function BuyerChoice({ buyer, onChange, disabled }: { buyer: Buyer | null; onChange: (value: Buyer) => void; disabled: boolean }) {
  return (
    <fieldset className="space-y-2" disabled={disabled} data-testid="subscription-buyer">
      <legend className="mb-2 text-sm font-medium">
        Who is buying? <span className="text-text-muted">(required)</span>
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["business", "A business", "A company, or a person buying for their trade or profession"],
            ["consumer", "A consumer", "A private person, not for their trade or profession"],
          ] as const
        ).map(([value, label, hint]) => (
          <label
            key={value}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-4 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary"
          >
            <input type="radio" name="billing-buyer" className="mt-1" required checked={buyer === value} onChange={() => onChange(value)} />
            <span className="min-w-0">
              <span className="block font-medium">{label}</span>
              <span className="block text-text-muted">{hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function OrderInformation({ billing, interval, members }: { billing: Available; interval: Interval; members: number | undefined }) {
  const { offer, seller, termsVersion } = billing;
  const per = interval;
  const tax = offer?.taxInclusive ? "including VAT" : "plus VAT where it applies, which Stripe adds and shows before you pay";
  const extra = members === undefined ? 0 : Math.max(0, members - (offer?.includedMembers ?? INCLUDED_MEMBERS));
  const total = offer ? { amount: offer[interval].base.amount + extra * offer[interval].member.amount, currency: offer[interval].base.currency } : null;
  const link = "text-primary underline underline-offset-2";
  return (
    <div className="space-y-2 rounded-lg border border-border bg-bg-input/40 p-4 text-sm" data-testid="subscription-order-information">
      <h4 className="font-medium">Before you order</h4>
      <ul className="list-disc space-y-1.5 pl-5">
        <li data-testid="subscription-seller">
          Seller: {seller ? `${seller.name}, ${seller.address}. ` : ""}
          <a className={link} href={LEGAL_NOTICE_URL} target="_blank" rel="noreferrer">
            Legal notice
          </a>
          . Stripe processes the payment and the VAT through Link; your contract for the Service is with the seller.
        </li>
        <li>Board Planner Pro for the whole organisation, billed {interval === "year" ? "yearly" : "monthly"}.</li>
        {offer && total && (
          <li data-testid="subscription-price">
            {priceLabel(offer[interval].base)} per {per} ({offer[interval].base.currency.toUpperCase()}), {tax}, with {offer.includedMembers} {offer.includedMembers === 1 ? "member" : "members"} included, then {priceLabel(offer[interval].member)} per member per {per}.
            {members !== undefined && ` For your ${members} ${members === 1 ? "member" : "members"}: ${priceLabel(total)} per ${per}.`}
          </li>
        )}
        <li>Renews automatically every {per} at the price then current, until you cancel.</li>
        <li>Cancel any time under Manage subscription on this page; it takes effect at the end of the period already paid.</li>
        <li data-testid="subscription-withdrawal-right">
          A consumer may withdraw within 14 days of buying, without giving a reason, with Withdraw from the contract on this page. As Pro starts at once, you then pay for the
          time used and the rest is refunded through Stripe.
        </li>
        {termsVersion && (
          <li data-testid="subscription-terms">
            By ordering you accept the{" "}
            <a className={link} href={TERMS_URL} target="_blank" rel="noreferrer">
              Terms
            </a>{" "}
            (version {termsVersion}); how we use personal data is in the{" "}
            <a className={link} href={PRIVACY_URL} target="_blank" rel="noreferrer">
              Privacy Policy
            </a>
            .
          </li>
        )}
      </ul>
    </div>
  );
}

function Withdrawal({ until, busy, onWithdraw }: { until: Date; busy: boolean; onWithdraw: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-3 rounded-lg border border-border p-4 text-sm" data-testid="subscription-withdrawal">
      <p>
        You bought Pro as a consumer, so you may withdraw from the contract until {formatPlanDate(until.toISOString())}. The subscription then ends at once, Pro ends at the end of
        the day, and the part of your payment for the time not used is refunded through Stripe.
      </p>
      <Button variant="secondary" onClick={() => setConfirming(true)} disabled={busy} data-testid="subscription-withdraw">
        Withdraw from the contract
      </Button>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={onWithdraw}
        title="Withdraw from the contract?"
        message="Your subscription ends now and nothing more is charged. Pro ends at the end of today and the organisation continues on the Free plan; no data is removed. The part of your payment for the time not used is refunded through Stripe, and we confirm the withdrawal by e-mail."
        confirmLabel="Withdraw"
        loadingLabel="Withdrawing…"
        loading={busy}
      />
    </div>
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
        {subscription.launch && <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary-on-tint">Launch price</span>}
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
  const [busy, setBusy] = useState<"checkout" | "portal" | "withdraw" | null>(null);
  const [buyer, setBuyer] = useState<Buyer | null>(null);
  const [consented, setConsented] = useState(false);
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
      const answer = await api.post(`/api/admin/billing/${action}`, action === "checkout" ? { interval, buyer, immediateStart: buyer === "consumer" && consented } : {}, { relayed: true });
      window.location.assign(answer.url);
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "Could not reach the payment service", "error");
      setBusy(null);
      // "Already subscribed" or "nothing to manage" means the page was out of date
      void load();
    }
  }

  async function withdraw() {
    setBusy("withdraw");
    try {
      await api.post("/api/admin/billing/withdraw", {}, { relayed: true });
      toast("You have withdrawn from the contract. A confirmation is on its way by e-mail.", "success");
      void reload();
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "Could not reach the payment service", "error");
    }
    setBusy(null);
    void load();
  }

  if (!billing || !billing.available || !organisation) return null;
  const notice = planNotice(organisation);
  // Pro that nobody pays for through here, and that is not about to end, has nothing to subscribe to: an operator holds it
  const operatorManaged = !live && organisation.plan === "pro" && organisation.trial !== true && notice.kind === "pro";
  if (operatorManaged) return null;
  const confirming = returned === "success" && !live && !pollEnded;
  const canWithdrawUntil = live ? withdrawableUntil(subscription) : null;
  const ordered = buyer === "business" || (buyer === "consumer" && consented);

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
          {canWithdrawUntil && <Withdrawal until={canWithdrawUntil} busy={busy !== null} onWithdraw={() => void withdraw()} />}
        </>
      ) : (
        <>
          {billing.withdrawal && (
            <p role="status" className="rounded-lg border border-border p-4 text-sm" data-testid="subscription-withdrawn">
              You withdrew from the contract on {formatPlanDate(billing.withdrawal.at)}. {money(billing.withdrawal.refunded)} is refunded through Stripe to the payment method you
              used.
            </p>
          )}
          <p className="text-sm text-text-muted">
            {organisation.trial
              ? "Subscribe to keep Pro when the trial ends."
              : organisation.plan === "pro"
                ? "Subscribe to keep Pro when this plan ends."
                : "Upgrade to Pro: more than 10 members, more than one machine, managed AI and the rest of the Pro features."}
            {billing.launchOpen && " The launch price is open: a subscription that starts at it keeps it for as long as it runs without a gap."}
          </p>
          <PeriodChoice offer={billing.offer} interval={interval} onChange={setInterval} disabled={busy !== null || confirming} />
          <BuyerChoice
            buyer={buyer}
            disabled={busy !== null || confirming}
            onChange={(value) => {
              setBuyer(value);
              if (value === "business") setConsented(false);
            }}
          />
          <OrderInformation billing={billing} interval={interval} members={organisation.members} />
          {buyer === "consumer" && (
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 text-sm" data-testid="subscription-consent">
              <input type="checkbox" className="mt-1" required checked={consented} onChange={(event) => setConsented(event.target.checked)} disabled={busy !== null || confirming} />
              <span>{IMMEDIATE_START_CONSENT}</span>
            </label>
          )}
          {!ordered && (
            <p className="text-xs text-text-muted" data-testid="subscription-order-hint">
              {buyer === "consumer" ? "Tick the request above to continue." : "Choose who is buying to continue."}
            </p>
          )}
          <Button onClick={() => go("checkout")} disabled={busy !== null || confirming || !ordered} aria-busy={busy === "checkout"} data-testid="subscription-checkout">
            {ORDER_BUTTON_LABEL}
          </Button>
        </>
      )}
    </section>
  );
}
