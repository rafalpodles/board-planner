import { APP_NAME } from "@/lib/brand";
import { connectDB } from "@/lib/db";
import { scoped } from "@/lib/db-scope";
import { adminAddresses } from "@/lib/dead-organisations";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email-template";
import { organisationDomain, organisationOrigin } from "@/lib/organisation-host";
import { Organisation } from "@/models/organisation";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long before a trial ends the administrators of an organisation that set up single sign-on are told it stops with it */
export const SSO_TRIAL_NOTICE_DAYS = 7;

type Notified = { _id: import("mongoose").Types.ObjectId; name?: string; slug?: string };

const day = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

async function tell(organisation: Notified, endsAt: Date): Promise<number> {
  const to = await adminAddresses(organisation._id);
  const origin = await organisationOrigin(organisation._id);
  const label = organisation.name || organisation.slug || "Your organisation";
  const date = day(endsAt);
  let sent = 0;
  for (const address of to) {
    const { html, text } = renderEmail({
      preheader: `Single sign-on for ${label} stops being offered when the trial ends on ${date}.`,
      kicker: "Your trial",
      heading: `Your trial ends on ${date}`,
      intro: [
        `${label} has single sign-on with your own identity provider. It is part of Pro and of the trial, so it stops being offered when the trial ends, unless you choose Pro.`,
        "What you entered stays saved and comes back with Pro. Until then people sign in with an e-mailed code and a password; anyone who only ever signed in through single sign-on sets one with Forgot password.",
      ],
      rows: [
        { label: "Organisation", value: label },
        { label: "Trial ends", value: date },
      ],
      button: origin ? { label: "Choose Pro", url: `${origin}/settings/organisation` } : undefined,
      footer: ["Sent to the administrators of an organisation whose trial includes single sign-on."],
    });
    if (await sendEmail({ to: address, subject: `Single sign-on stops when your trial ends on ${date}`, text, html })) sent += 1;
  }
  return sent;
}

/**
 * One pass, run daily: an organisation whose trial ends within a week and that set up its own sign-in provider is
 * told once, because that provider is switched off at the end of the trial. A trial that becomes Pro is no longer a
 * trial and is left alone.
 */
export async function noticeEndingTrials(now: number = Date.now(), days: number = SSO_TRIAL_NOTICE_DAYS): Promise<{ looked: number; noticed: number }> {
  const summary = { looked: 0, noticed: 0 };
  if (!organisationDomain() || !isEmailConfigured()) return summary;
  await connectDB();
  const rows = await Organisation.find({
    deletedAt: null,
    suspendedAt: null,
    "entitlements.trial": true,
    "entitlements.expiresAt": { $gt: new Date(now), $lte: new Date(now + days * DAY_MS) },
  })
    .select("name slug entitlements ssoTrialNoticeFor")
    .lean();
  for (const row of rows) {
    summary.looked += 1;
    try {
      const endsAt = row.entitlements?.expiresAt;
      if (!endsAt) continue;
      if (row.ssoTrialNoticeFor && row.ssoTrialNoticeFor.getTime() === endsAt.getTime()) continue;
      if (!(await scoped(row._id).Settings.findOne({}, "sso").lean())?.sso) continue;
      // Claimed before sending, so two processes do not both write: the claim is let go when nobody could be reached
      const claimed = await Organisation.updateOne({ _id: row._id, ssoTrialNoticeFor: { $ne: endsAt } }, { $set: { ssoTrialNoticeFor: endsAt } });
      if (claimed.modifiedCount !== 1) continue;
      if ((await tell(row, endsAt)) > 0) {
        summary.noticed += 1;
      } else {
        await Organisation.updateOne({ _id: row._id, ssoTrialNoticeFor: endsAt }, { $set: { ssoTrialNoticeFor: null } });
      }
    } catch (error) {
      console.error(`Single sign-on trial notice for ${row._id} failed:`, error);
    }
  }
  return summary;
}
