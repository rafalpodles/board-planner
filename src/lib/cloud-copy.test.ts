import { describe, it, expect } from "vitest";
import { invitationNoMail, mailOff, noPasswordNoMail, pmNeedsKey, pmUnavailable, signUpNeedsProvider } from "./cloud-copy";

// BP-922. An organisation's admin cannot set an environment variable, restart anything or ask "the operator"
const OPERATOR_WORDS = /instance|environment variable|OPENROUTER|LICENCE_KEY|restart|operator|server log|ask an administrator/i;

describe("what each audience is told where the fix is the operator's", () => {
  const sentences = (cloud: boolean) => [
    pmUnavailable(cloud),
    pmNeedsKey(cloud),
    signUpNeedsProvider(cloud),
    invitationNoMail(cloud, "ada@example.com"),
    mailOff(cloud, true),
    mailOff(cloud, false),
    noPasswordNoMail(cloud),
  ];

  it("asks nothing of an organisation's admin that only an operator could do", () => {
    for (const sentence of sentences(true)) expect(sentence).not.toMatch(OPERATOR_WORDS);
  });

  it("still tells a self-hosted operator what to set, where it matters — the control", () => {
    expect(pmUnavailable(false)).toContain("OPENROUTER_API_KEY");
    expect(pmNeedsKey(false)).toContain("OPENROUTER_API_KEY");
    expect(signUpNeedsProvider(false)).toContain("this instance");
    expect(invitationNoMail(false, "ada@example.com")).toContain("no mail server");
    expect(mailOff(false, true)).toContain("daily digest");
    expect(noPasswordNoMail(false)).toContain("Ask an administrator");
  });

  it("leaves the digest out of a board's own grid and keeps it in the global one", () => {
    expect(mailOff(true, true)).toContain("the daily digest");
    expect(mailOff(true, false)).not.toContain("digest");
    expect(mailOff(false, false)).not.toContain("digest");
  });

  it("names the invitee in the link sentence either way", () => {
    expect(invitationNoMail(true, "ada@example.com")).toContain("ada@example.com");
    expect(invitationNoMail(false, "ada@example.com")).toContain("ada@example.com");
  });
});
