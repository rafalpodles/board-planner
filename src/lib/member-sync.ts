import { askBilling } from "./billing-client";
import type { ScopedDb } from "./db-scope";
import { licencePullConfig } from "./licence-pull";
import { memberCounts } from "./member-limit";
import { getOrganisation, recordMemberSync } from "./organisation";
import { organisationDomain } from "./organisation-host";
import { forEachServedOrganisation } from "./organisation-jobs";

export type MemberSyncResult = "skipped" | "unchanged" | "sent" | "failed" | "waiting";

const DEFAULT_TICK_MS = 60 * 1000;
const MAX_TIMER_MS = 2_147_483_647;
const ANSWERS = ["updated", "unchanged", "no_subscription"];
const FIRST_WAIT_MS = 60 * 1000;
const MAX_WAIT_MS = 30 * 60 * 1000;

// Per organisation, in memory: a service that is down, or takes no payments, is asked less and less often, not every tick
const failures = new Map<string, { count: number; until: number }>();

export function forgetMemberSyncFailures(): void {
  failures.clear();
}

export function memberSyncTickMs(raw: string | undefined = process.env.MEMBER_SYNC_TICK_MS): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_TICK_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`MEMBER_SYNC_TICK_MS=${JSON.stringify(value)} is not a number of milliseconds; syncing every minute`);
    return DEFAULT_TICK_MS;
  }
  return parsed === 0 ? 0 : Math.min(Math.max(parsed, 1000), MAX_TIMER_MS);
}

/**
 * Tells the licence service how many people a Pro organisation has when that is not what it was last told, so it can set
 * the members above ten on the subscription. Comparing counts, rather than hooking each place a person is made or
 * removed, means none can be missed; the daily licence ask carries the count too. Billed are the people with access: an
 * invitation nobody has accepted is not.
 */
export async function syncMembersOf(db: ScopedDb, now: number = Date.now()): Promise<MemberSyncResult> {
  const id = db.organisation.toHexString();
  if ((failures.get(id)?.until ?? 0) > now) return "waiting";
  const organisation = await getOrganisation(id);
  if (organisation.entitlements.plan !== "pro" || organisation.entitlements.trial) return "skipped";
  const { active } = await memberCounts(db);
  if (organisation.memberSync?.members === active) return "unchanged";

  const answer = await askBilling("members", { organisation: id, members: active });
  if (answer.status === "ok" && ANSWERS.includes(String(answer.body.status))) {
    failures.delete(id);
    await recordMemberSync(db.organisation, active);
    return "sent";
  }
  // Not recorded, so it is tried again, later each time
  const count = (failures.get(id)?.count ?? 0) + 1;
  failures.set(id, { count, until: now + Math.min(FIRST_WAIT_MS * 2 ** (count - 1), MAX_WAIT_MS) });
  // A service that takes no payments is a configuration, not a failure to say every minute; the rest is said first and every eighth time
  if (answer.status !== "off" && (count === 1 || count % 8 === 0)) {
    console.warn(`Telling the licence service the members of an organisation failed (${count} times): ${answer.status}${answer.status === "ok" ? ` (${String(answer.body.status)})` : ""}`);
  }
  return "failed";
}

export async function runMemberSync(now: number = Date.now()): Promise<Record<MemberSyncResult, number>> {
  const done: Record<MemberSyncResult, number> = { skipped: 0, unchanged: 0, sent: 0, failed: 0, waiting: 0 };
  await forEachServedOrganisation("Member sync", async (db) => {
    done[await syncMembersOf(db, now)] += 1;
  });
  return done;
}

let started = false;

export function startMemberSync(): { started: boolean; reason?: string } {
  if (started) return { started: true };
  if (!organisationDomain()) return { started: false, reason: "organisations are not on subdomains" };
  if (!licencePullConfig()) return { started: false, reason: "LICENCE_SERVICE_URL and LICENCE_PULL_KEY are not set" };
  const tickMs = memberSyncTickMs();
  if (tickMs === 0) return { started: false, reason: "MEMBER_SYNC_TICK_MS is 0" };

  started = true;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runMemberSync()
      .catch((error) => console.error("Member sync failed:", error))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, tickMs).unref();
  return { started: true };
}
