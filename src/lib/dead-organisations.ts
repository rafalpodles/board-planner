import type { Types } from "mongoose";
import { APP_NAME } from "@/lib/brand";
import { connectDB } from "@/lib/db";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email-template";
import { scoped } from "@/lib/db-scope";
import { getOrganisation, licenceOf } from "@/lib/organisation";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";
import { organisationDomain, organisationOrigin } from "@/lib/organisation-host";
import { claimDeletion, deleteOrganisationData, settledSince, setSuspended } from "@/lib/organisation-life-cycle";
import { logPlatformAudit } from "@/lib/platform-route";
import { Organisation } from "@/models/organisation";

const DAY_MS = 24 * 60 * 60 * 1000;

/** From the notice to the deletion */
export const DEAD_NOTICE_DAYS = 30;
/** How long before the deletion the administrators are reminded, once */
export const DEAD_REMINDER_DAYS = 7;
/** How long past its period a notice stays good, before it is given again */
export const DEAD_STALE_DAYS = 3;
const NOTICE_LEASE_MS = 10 * 60 * 1000;
/** A delete that began and has not finished for this long is dead, and only then is it taken up again */
const STALLED_DELETE_MS = 60 * 60 * 1000;
export const DEAD_REASON = "dead organisation: nobody signed in after the plan ended";
export const SWEEP_KEY = "dead-organisation-sweep";

let warned = false;

export const MIN_DEAD_DAYS = 30;
export const DEFAULT_DEAD_DAYS = 60;

/**
 * 60 days in the cloud unless somebody sets otherwise, and never fewer than 30 (a typo of 6 must not mean
 * six days). 0 is off, and so is everything outside the cloud, where there is one organisation and it is never swept.
 */
export function deadOrganisationDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DEAD_ORGANISATION_DAYS?.trim();
  if (!raw) return organisationDomain() ? DEFAULT_DEAD_DAYS : 0;
  const value = Number(raw);
  if (Number.isInteger(value) && (value === 0 || value >= MIN_DEAD_DAYS)) return value;
  if (!warned) {
    warned = true;
    console.warn(`DEAD_ORGANISATION_DAYS="${raw}" is not 0 or a whole number of at least ${MIN_DEAD_DAYS} days; the dead-organisation sweep stays off`);
  }
  return 0;
}

export interface DeadFacts {
  now: number;
  days: number;
  /** An organisation holding a Pro plan, a trial or a payment's grace is not dead */
  planIsPro: boolean;
  /** When the plan last ended: its key's expiry, else when the organisation was made */
  endedAt: Date;
  /** The latest sign-in of any person in it, else when the first of them was made */
  lastActiveAt: Date;
  noticeAt: Date | null;
  reminderAt: Date | null;
  suspendedAt: Date | null;
  suspendedByTheSweep: boolean;
}

export type DeadStep = "alive" | "clear" | "notice" | "remind" | "wait" | "suspend" | "delete";

/** Dead is: no plan, which ended and which nobody has signed in since, for a whole period each. What to do about it follows from how far the notice has got. */
export function deadStep(f: DeadFacts): DeadStep {
  const period = f.days * DAY_MS;
  const dead = !f.planIsPro && f.now - f.endedAt.getTime() >= period && f.now - f.lastActiveAt.getTime() >= period;
  if (!dead) return f.noticeAt || f.suspendedByTheSweep ? "clear" : "alive";
  if (!f.noticeAt) return "notice";
  // A notice nothing followed for days (the sweep was off, or an operator resumed the organisation) is told again
  if (!f.suspendedAt && f.now - f.noticeAt.getTime() >= (DEAD_NOTICE_DAYS + DEAD_STALE_DAYS) * DAY_MS) return "notice";
  const sinceNotice = f.now - f.noticeAt.getTime();
  if (sinceNotice < DEAD_NOTICE_DAYS * DAY_MS) {
    const reminderDue = sinceNotice >= (DEAD_NOTICE_DAYS - DEAD_REMINDER_DAYS) * DAY_MS;
    return reminderDue && !f.reminderAt && !f.suspendedAt ? "remind" : "wait";
  }
  if (!f.suspendedAt) return "suspend";
  return f.suspendedByTheSweep && settledSince(f.suspendedAt, f.now) ? "delete" : "wait";
}

async function adminAddresses(organisation: Types.ObjectId): Promise<string[]> {
  const db = scoped(organisation);
  const admins = await db.User.find({ role: "admin", kind: { $ne: "machine" }, deactivatedAt: null, email: { $nin: [null, ""] } })
    .select("email")
    .lean<{ email: string }[]>();
  return [...new Set(admins.map((a) => a.email))];
}

/**
 * The latest sign of anybody using the organisation: a sign-in, a browser session in use (they last up to 90
 * days, so a person who signed in months ago may use it daily), an API token, a worker, a refreshed connected
 * app. An organisation with nobody in it is as old as it is.
 */
async function lastActiveOf(organisation: Types.ObjectId, madeAt: Date): Promise<Date> {
  const db = scoped(organisation);
  const latest = async (read: PromiseLike<unknown>, field: string): Promise<number> => {
    const value = ((await read) as Record<string, unknown> | null)?.[field];
    return value instanceof Date ? value.getTime() : 0;
  };
  const times = await Promise.all([
    latest(db.User.findOne({ kind: { $ne: "machine" } }).sort({ lastSignInAt: -1 }).select("lastSignInAt").lean(), "lastSignInAt"),
    latest(db.User.findOne({ kind: { $ne: "machine" } }).sort({ createdAt: -1 }).select("createdAt").lean(), "createdAt"),
    latest(db.Session.findOne({}).sort({ lastUsedAt: -1 }).select("lastUsedAt").lean(), "lastUsedAt"),
    latest(db.ApiToken.findOne({}).sort({ lastUsedAt: -1 }).select("lastUsedAt").lean(), "lastUsedAt"),
    latest(db.Worker.findOne({}).sort({ lastSeenAt: -1 }).select("lastSeenAt").lean(), "lastSeenAt"),
    latest(db.OAuthToken.findOne({}).sort({ createdAt: -1 }).select("createdAt").lean(), "createdAt"),
  ]);
  return new Date(Math.max(...times) || madeAt.getTime());
}

const dayOf = (at: Date) => at.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const utcDayNumber = (at: number) => Math.floor(at / DAY_MS);
/** The last calendar day that is still over before the suspension everywhere on Earth, down to UTC−12 */
const LAST_DAY_MARGIN_MS = 36 * 60 * 60 * 1000;

function daysLeft(deleteOn: Date, now: number): string {
  const days = utcDayNumber(deleteOn.getTime()) - utcDayNumber(now);
  if (days > 1) return `${days} days left`;
  return days === 1 ? "1 day left" : "less than a day left";
}

export function deadOrganisationEmail(kind: "notice" | "reminder", label: string, origin: string | null, deleteOn: Date, now: number) {
  const date = dayOf(deleteOn);
  const lastDay = dayOf(new Date(deleteOn.getTime() - LAST_DAY_MARGIN_MS));
  const { html, text } = renderEmail({
    preheader: `${label} will be suspended and deleted on ${date} unless somebody signs in or chooses a plan by ${lastDay}.`,
    kicker: kind === "notice" ? "Your organisation" : `Reminder: ${daysLeft(deleteOn, now)}`,
    heading: `${label} will be deleted on ${date}`,
    intro: [
      kind === "notice"
        ? `Nobody has used this ${APP_NAME} organisation for a long while, and it has no plan.`
        : `We wrote earlier that nobody had used this ${APP_NAME} organisation for a long while. Nobody has since, and it still has no plan.`,
      `Signing in, or choosing a plan, by ${lastDay} cancels the deletion.`,
      "To keep a copy of everything in it, download the export from Settings → Export.",
    ],
    alert: {
      tone: "warning",
      lines: [`On ${date} the organisation is suspended, and it is deleted with everything in it soon after. Nobody can sign in to a suspended organisation.`],
    },
    rows: [
      { label: "Organisation", value: label },
      { label: "Suspended and deleted", value: date },
    ],
    button: origin ? { label: `Sign in to ${APP_NAME}`, url: `${origin}/login` } : undefined,
    secondaryButton: origin ? { label: "Download the export", url: `${origin}/settings/export` } : undefined,
    footer: ["Sent to the administrators of an organisation with no plan and no recent use. This notice cannot be turned off."],
  });
  const subject = kind === "notice" ? `${label} will be suspended and deleted on ${date}` : `Reminder: ${label} will be suspended and deleted on ${date}`;
  return { subject, html, text };
}

async function mailAdmins(
  kind: "notice" | "reminder",
  organisation: Types.ObjectId,
  name: string,
  slug: string | undefined,
  deleteOn: Date,
  now: number
): Promise<number> {
  const to = await adminAddresses(organisation);
  const mail = deadOrganisationEmail(kind, name || slug || "Your organisation", await organisationOrigin(organisation), deleteOn, now);
  let sent = 0;
  for (const address of to) {
    if (await sendEmail({ to: address, ...mail })) sent += 1;
  }
  return sent;
}

export interface SweepSummary {
  looked: number;
  noticed: number;
  reminded: number;
  cleared: number;
  suspended: number;
  deleted: number;
}

async function finishDeletion(row: { _id: Types.ObjectId; slug?: string }, summary: SweepSummary): Promise<void> {
  if (!(await claimDeletion(row._id))) return;
  await logPlatformAudit({ action: "organisation_delete_started", keyId: SWEEP_KEY, subject: row._id, detail: row.slug ?? "" }, { strict: true });
  const removed = await deleteOrganisationData(row._id);
  await logPlatformAudit({ action: "organisation_deleted", keyId: SWEEP_KEY, subject: row._id, detail: `${row.slug ?? ""}: ${JSON.stringify(removed)}` });
  summary.deleted += 1;
}

/**
 * One pass, run daily. Per organisation: tell its administrators, give them 30 days, remind them a week
 * before the end, and only then suspend and delete it. Signing in, or a plan, at any point before the
 * deletion cancels it. The default organisation and an operator's own suspension are never touched.
 */
export async function sweepDeadOrganisations(now: number = Date.now(), days: number = deadOrganisationDays()): Promise<SweepSummary> {
  const summary: SweepSummary = { looked: 0, noticed: 0, reminded: 0, cleared: 0, suspended: 0, deleted: 0 };
  if (days <= 0 || !organisationDomain()) return summary;
  await connectDB();
  const rows = await Organisation.find({ _id: { $ne: DEFAULT_ORGANISATION_ID }, deletedAt: null })
    .select("name slug licenceKey suspendedAt suspendedReason deadNoticeAt deadReminderAt deletingAt")
    .lean();
  for (const row of rows) {
    summary.looked += 1;
    try {
      const byTheSweep = !!row.suspendedAt && row.suspendedReason === DEAD_REASON;
      // A delete that died halfway is finished by whoever began it: the sweep's own, never an operator's
      if (row.deletingAt) {
        if (byTheSweep && now - row.deletingAt.getTime() >= STALLED_DELETE_MS) await finishDeletion(row, summary);
        continue;
      }
      // Somebody else's suspension is not ours to build on
      if (row.suspendedAt && !byTheSweep) continue;

      const check = licenceOf({ _id: row._id, licenceKey: row.licenceKey }, now);
      // A key that is stored and does not verify is a plan nobody can read (a rotated public key, a bad deploy), not no plan
      if (row.licenceKey?.trim() && !check?.payload) continue;

      const organisation = await getOrganisation(row._id);
      // An id minted with a clock in the future would otherwise make the organisation younger than everything
      const madeAt = new Date(Math.min(row._id.getTimestamp().getTime(), now));
      const endedAt = check?.payload ? new Date(check.payload.expiresAt) : madeAt;
      const noticeAt = row.deadNoticeAt ?? null;
      const step = deadStep({
        now,
        days,
        planIsPro: organisation.entitlements.plan === "pro",
        endedAt,
        lastActiveAt: await lastActiveOf(row._id, madeAt),
        noticeAt,
        reminderAt: row.deadReminderAt ?? null,
        suspendedAt: row.suspendedAt ?? null,
        suspendedByTheSweep: byTheSweep,
      });

      if (step === "notice") {
        if (!isEmailConfigured()) continue;
        // A lease on the sending, not the notice: a process that dies mid-send leaves a lease that runs out and no
        // notice, so nothing is ever suspended that nobody was told about
        const taken = await Organisation.updateOne(
          { _id: row._id, $or: [{ deadNoticeClaimedAt: null }, { deadNoticeClaimedAt: { $lte: new Date(now - NOTICE_LEASE_MS) } }] },
          { $set: { deadNoticeClaimedAt: new Date(now) } }
        );
        if (taken.modifiedCount !== 1) continue;
        let sent = 0;
        try {
          sent = await mailAdmins("notice", row._id, row.name, row.slug, new Date(now + DEAD_NOTICE_DAYS * DAY_MS), now);
        } finally {
          await Organisation.updateOne(
            { _id: row._id },
            sent > 0 ? { $set: { deadNoticeAt: new Date(now), deadReminderAt: null, deadNoticeClaimedAt: null } } : { $set: { deadNoticeClaimedAt: null } }
          );
        }
        if (sent === 0) continue;
        await logPlatformAudit({ action: "organisation_dead_noticed", keyId: SWEEP_KEY, subject: row._id, detail: `${row.slug ?? ""}: ${sent} administrator(s) told` });
        summary.noticed += 1;
      } else if (step === "remind" && noticeAt) {
        if (!isEmailConfigured()) continue;
        // Recorded before it is sent, so a process that dies mid-send leaves a reminder that never went out rather than one that goes out twice
        const remindedAt = new Date(now);
        const taken = await Organisation.updateOne(
          { _id: row._id, deadNoticeAt: noticeAt, deadReminderAt: null, suspendedAt: null },
          { $set: { deadReminderAt: remindedAt } }
        );
        if (taken.modifiedCount !== 1) continue;
        let sent = 0;
        try {
          sent = await mailAdmins("reminder", row._id, row.name, row.slug, new Date(noticeAt.getTime() + DEAD_NOTICE_DAYS * DAY_MS), now);
        } finally {
          if (sent === 0) await Organisation.updateOne({ _id: row._id, deadReminderAt: remindedAt }, { $set: { deadReminderAt: null } });
        }
        if (sent === 0) continue;
        await logPlatformAudit({ action: "organisation_dead_reminded", keyId: SWEEP_KEY, subject: row._id, detail: `${row.slug ?? ""}: ${sent} administrator(s) reminded` });
        summary.reminded += 1;
      } else if (step === "clear") {
        await Organisation.updateOne({ _id: row._id }, { $set: { deadNoticeAt: null, deadReminderAt: null } });
        if (byTheSweep) await setSuspended(row._id, false);
        await logPlatformAudit({ action: "organisation_dead_cleared", keyId: SWEEP_KEY, subject: row._id, detail: row.slug ?? "" });
        summary.cleared += 1;
      } else if (step === "suspend") {
        await setSuspended(row._id, true, DEAD_REASON);
        await logPlatformAudit({ action: "organisation_suspended", keyId: SWEEP_KEY, subject: row._id, detail: DEAD_REASON });
        summary.suspended += 1;
      } else if (step === "delete") {
        await finishDeletion(row, summary);
      }
    } catch (error) {
      console.error(`Dead-organisation sweep failed for ${row._id.toHexString()}:`, error);
    }
  }
  return summary;
}
