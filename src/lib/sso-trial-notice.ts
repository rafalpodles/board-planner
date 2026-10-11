import type { Types } from "mongoose";
import { APP_NAME } from "@/lib/brand";
import { adminAddresses } from "@/lib/dead-organisations";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email-template";
import { getOrganisation } from "@/lib/organisation";
import { forEachServedOrganisation } from "@/lib/organisation-jobs";
import { organisationDomain, organisationOrigin } from "@/lib/organisation-host";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long before a trial ends the administrators of an organisation that set up single sign-on are told it stops with it */
export const SSO_TRIAL_NOTICE_DAYS = 7;

const day = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

async function tell(organisation: Types.ObjectId, label: string, endsAt: Date): Promise<number> {
  const to = await adminAddresses(organisation);
  const origin = await organisationOrigin(organisation);
  const date = day(endsAt);
  let sent = 0;
  for (const address of to) {
    const { html, text } = renderEmail({
      preheader: `Single sign-on for ${label} stops being offered when the trial ends on ${date}.`,
      kicker: "Your trial",
      heading: `Your trial ends on ${date}`,
      intro: [
        `${label} has single sign-on with your own identity provider on ${APP_NAME}. It is part of Pro and of the trial, so it stops being offered when the trial ends, unless you choose Pro.`,
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
  await forEachServedOrganisation("Single sign-on trial notice", async (db) => {
    summary.looked += 1;
    const organisation = await getOrganisation(db.organisation);
    const { trial, expiresAt } = organisation.entitlements;
    if (!trial || !expiresAt) return;
    const endsAt = new Date(expiresAt);
    if (endsAt.getTime() <= now || endsAt.getTime() > now + days * DAY_MS) return;
    const settings = await db.Settings.findOne({}, "sso ssoTrialNoticeFor").lean();
    if (!settings?.sso) return;
    if (settings.ssoTrialNoticeFor && settings.ssoTrialNoticeFor.getTime() === endsAt.getTime()) return;
    // Claimed before sending, so two processes do not both write: the claim is let go when nobody could be reached
    const claimed = await db.Settings.updateOne({ ssoTrialNoticeFor: { $ne: endsAt } }, { $set: { ssoTrialNoticeFor: endsAt } });
    if (claimed.modifiedCount !== 1) return;
    if ((await tell(db.organisation, organisation.name || organisation.slug || "Your organisation", endsAt)) > 0) {
      summary.noticed += 1;
    } else {
      await db.Settings.updateOne({ ssoTrialNoticeFor: endsAt }, { $set: { ssoTrialNoticeFor: null } });
    }
  });
  return summary;
}
