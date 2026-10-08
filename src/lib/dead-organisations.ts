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
export const DEAD_NOTICE_DAYS = 14;
export const DEAD_REASON = "dead organisation: nobody signed in after the plan ended";
export const SWEEP_KEY = "dead-organisation-sweep";

let warned = false;

/** 0 is off, and it is the default: a job that deletes data is switched on by somebody who means it */
export function deadOrganisationDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DEAD_ORGANISATION_DAYS?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 0) return value;
  if (!warned) {
    warned = true;
    console.warn(`DEAD_ORGANISATION_DAYS="${raw}" is not a whole number of days; the dead-organisation sweep stays off`);
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
  suspendedAt: Date | null;
  suspendedByTheSweep: boolean;
}

export type DeadStep = "alive" | "clear" | "notice" | "wait" | "suspend" | "delete";

/** Dead is: no plan, which ended and which nobody has signed in since, for a whole period each. What to do about it follows from how far the notice has got. */
export function deadStep(f: DeadFacts): DeadStep {
  const period = f.days * DAY_MS;
  const dead = !f.planIsPro && f.now - f.endedAt.getTime() >= period && f.now - f.lastActiveAt.getTime() >= period;
  if (!dead) return f.noticeAt || f.suspendedByTheSweep ? "clear" : "alive";
  if (!f.noticeAt) return "notice";
  if (f.now - f.noticeAt.getTime() < DEAD_NOTICE_DAYS * DAY_MS) return "wait";
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

/** The latest sign-in or arrival of any person in it; an organisation with nobody in it is as old as it is */
async function lastActiveOf(organisation: Types.ObjectId, madeAt: Date): Promise<Date> {
  const db = scoped(organisation);
  const people = await db.User.find({ kind: { $ne: "machine" } }).select("lastSignInAt createdAt").lean<{ lastSignInAt?: Date | null; createdAt?: Date }[]>();
  let latest = 0;
  for (const p of people) latest = Math.max(latest, p.lastSignInAt?.getTime() ?? 0, p.createdAt?.getTime() ?? 0);
  return new Date(latest || madeAt.getTime());
}

async function sendNotice(organisation: Types.ObjectId, name: string, slug: string | undefined, deleteAfter: Date): Promise<number> {
  const to = await adminAddresses(organisation);
  const origin = await organisationOrigin(organisation);
  const date = deleteAfter.toUTCString().replace(/ \d\d:\d\d:\d\d.*/, "");
  let sent = 0;
  for (const address of to) {
    const { html, text } = renderEmail({
      preheader: `${name || slug || "Your organisation"} will be deleted after ${date} unless somebody signs in.`,
      kicker: "Your organisation",
      heading: `${name || slug || "Your organisation"} will be deleted`,
      intro: [
        `Nobody has signed in to this ${APP_NAME} organisation for a long while, and its plan has ended.`,
        `If nobody signs in before ${date}, the organisation and everything in it will be deleted. Signing in once is enough to keep it. Settings → Export downloads everything first.`,
      ],
      button: origin ? { label: `Sign in to ${APP_NAME}`, url: `${origin}/login` } : undefined,
      footer: ["Sent to the administrators of an organisation with no plan and no sign-in. This notice cannot be turned off."],
    });
    if (await sendEmail({ to: address, subject: `${name || slug || "Your organisation"} will be deleted unless somebody signs in`, text, html })) sent += 1;
  }
  return sent;
}

export interface SweepSummary {
  looked: number;
  noticed: number;
  cleared: number;
  suspended: number;
  deleted: number;
}

/**
 * One pass, run daily. Per organisation: tell its administrators, give them a fortnight, and only then
 * suspend and delete it. Signing in, or a plan, at any point before the deletion cancels it. The default
 * organisation and an operator's own suspension are never touched.
 */
export async function sweepDeadOrganisations(now: number = Date.now(), days: number = deadOrganisationDays()): Promise<SweepSummary> {
  const summary: SweepSummary = { looked: 0, noticed: 0, cleared: 0, suspended: 0, deleted: 0 };
  if (days <= 0 || !organisationDomain()) return summary;
  await connectDB();
  const rows = await Organisation.find({ _id: { $ne: DEFAULT_ORGANISATION_ID }, deletedAt: null, deletingAt: null })
    .select("name slug licenceKey suspendedAt suspendedReason deadNoticeAt")
    .lean();
  for (const row of rows) {
    summary.looked += 1;
    try {
      const byTheSweep = !!row.suspendedAt && row.suspendedReason === DEAD_REASON;
      // Somebody else's suspension is not ours to build on
      if (row.suspendedAt && !byTheSweep) continue;

      const organisation = await getOrganisation(row._id);
      const check = licenceOf({ _id: row._id, licenceKey: row.licenceKey }, now);
      // An id minted with a clock in the future would otherwise make the organisation younger than everything
      const madeAt = new Date(Math.min(row._id.getTimestamp().getTime(), now));
      const endedAt = check?.payload ? new Date(check.payload.expiresAt) : madeAt;
      const step = deadStep({
        now,
        days,
        planIsPro: organisation.entitlements.plan === "pro",
        endedAt,
        lastActiveAt: await lastActiveOf(row._id, madeAt),
        noticeAt: row.deadNoticeAt ?? null,
        suspendedAt: row.suspendedAt ?? null,
        suspendedByTheSweep: byTheSweep,
      });

      if (step === "notice") {
        const sent = isEmailConfigured() ? await sendNotice(row._id, row.name, row.slug, new Date(now + DEAD_NOTICE_DAYS * DAY_MS)) : 0;
        // Nothing is ever deleted that nobody was told about
        if (sent === 0) continue;
        await Organisation.updateOne({ _id: row._id, deadNoticeAt: null }, { $set: { deadNoticeAt: new Date(now) } });
        await logPlatformAudit({ action: "organisation_dead_noticed", keyId: SWEEP_KEY, subject: row._id, detail: `${row.slug ?? ""}: ${sent} administrator(s) told` });
        summary.noticed += 1;
      } else if (step === "clear") {
        await Organisation.updateOne({ _id: row._id }, { $set: { deadNoticeAt: null } });
        if (byTheSweep) await setSuspended(row._id, false);
        await logPlatformAudit({ action: "organisation_dead_cleared", keyId: SWEEP_KEY, subject: row._id, detail: row.slug ?? "" });
        summary.cleared += 1;
      } else if (step === "suspend") {
        await setSuspended(row._id, true, DEAD_REASON);
        await logPlatformAudit({ action: "organisation_suspended", keyId: SWEEP_KEY, subject: row._id, detail: DEAD_REASON });
        summary.suspended += 1;
      } else if (step === "delete") {
        if (!(await claimDeletion(row._id))) continue;
        await logPlatformAudit({ action: "organisation_delete_started", keyId: SWEEP_KEY, subject: row._id, detail: row.slug ?? "" }, { strict: true });
        const removed = await deleteOrganisationData(row._id);
        await logPlatformAudit({ action: "organisation_deleted", keyId: SWEEP_KEY, subject: row._id, detail: `${row.slug ?? ""}: ${JSON.stringify(removed)}` });
        summary.deleted += 1;
      }
    } catch (error) {
      console.error(`Dead-organisation sweep failed for ${row._id.toHexString()}:`, error);
    }
  }
  return summary;
}
