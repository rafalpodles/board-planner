const GMAIL = new Set(["gmail.com", "googlemail.com"]);

export interface Mailbox {
  /** The one spelling every alias of the same mailbox shares: `A.B+x@googlemail.com` is `ab@gmail.com` */
  canonical: string;
  domain: string;
}

/**
 * For counting, never for identity: it folds the ways one person writes several addresses that all
 * arrive in one inbox (a `+tag`, Gmail's dots and its second domain), so a limit on addresses is not
 * a limit on spellings. Two people on a provider that treats `a+b` as a different mailbox would count as
 * one, which costs them a slightly earlier limit. A local part the fold would empty keeps its original form,
 * so `+x@` and `+y@` stay two addresses.
 */
export function mailboxOf(address: string): Mailbox {
  const lowered = address.trim().toLowerCase();
  const at = lowered.lastIndexOf("@");
  if (at < 1) return { canonical: lowered, domain: "" };
  let local = lowered.slice(0, at);
  let domain = lowered.slice(at + 1);
  const original = local;
  local = local.split("+")[0];
  if (GMAIL.has(domain)) {
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }
  return { canonical: `${local || original}@${domain}`, domain };
}
