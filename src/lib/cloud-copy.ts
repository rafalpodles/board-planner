/** What an organisation's admin is told where the fix is the operator's, not theirs: one sentence per audience. */

export const pmUnavailable = (cloud: boolean) =>
  cloud
    ? "The PM agent is unavailable right now. Try again in a moment, or ask an admin to add your own key under Settings → AI key."
    : "PM is not configured on the server (OPENROUTER_API_KEY missing).";

export const pmNeedsKey = (cloud: boolean) =>
  cloud
    ? "The PM agent is not available for this organisation right now. Ask an admin to add your own key under Settings → AI key, or try again later."
    : "Set the OPENROUTER_API_KEY environment variable on the server to enable the PM agent, or have an admin add a key in Settings → AI key.";

export const signUpNeedsProvider = (cloud: boolean) =>
  cloud
    ? "Needs single sign-on set up for this organisation, under Settings → Single sign-on."
    : "Needs single sign-on or Google sign-in configured on this instance.";

export const invitationNoMail = (cloud: boolean, email: string) =>
  cloud
    ? `No email was sent. Send this link to ${email} yourself.`
    : `No email was sent — this instance has no mail server. Send this link to ${email} yourself.`;

export const mailOff = (cloud: boolean, withDigest: boolean) => {
  const what = withDigest ? "e-mail and the daily digest are" : "e-mail is";
  return cloud
    ? `Mail is not available right now, so ${what} off.`
    : `This instance has no mail server, so ${what} off — ask an administrator.`;
};

export const noPasswordNoMail = (cloud: boolean) =>
  cloud
    ? "This account has no password, and mail is not available right now. Ask an admin to set one."
    : "This account has no password, and this instance sends no mail. Ask an administrator to set one.";
