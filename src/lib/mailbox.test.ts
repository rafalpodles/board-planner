import { describe, it, expect } from "vitest";
import { mailboxOf } from "./mailbox";

// BP-674: a limit on addresses has to survive the ways one inbox is written as several
describe("mailboxOf", () => {
  it("folds a +tag, the case and the surrounding space, on every domain", () => {
    expect(mailboxOf("  Jan+Shop@Corp.Example ").canonical).toBe("jan@corp.example");
    expect(mailboxOf("jan+a+b@corp.example").canonical).toBe("jan@corp.example");
  });

  it("folds Gmail's dots and its second domain, and only Gmail's", () => {
    expect(mailboxOf("J.a.n@gmail.com").canonical).toBe("jan@gmail.com");
    expect(mailboxOf("jan@googlemail.com").canonical).toBe("jan@gmail.com");
    expect(mailboxOf("j.a.n+x@googlemail.com").canonical).toBe("jan@gmail.com");
    expect(mailboxOf("j.a.n@corp.example").canonical).toBe("j.a.n@corp.example");
  });

  it("names the domain it counted under, in its folded form", () => {
    expect(mailboxOf("a@Corp.Example").domain).toBe("corp.example");
    expect(mailboxOf("a@googlemail.com").domain).toBe("gmail.com");
  });

  it("keeps an address whose local part the fold would empty as it was, so two such addresses are not one", () => {
    expect(mailboxOf("+x@corp.example").canonical).toBe("+x@corp.example");
    expect(mailboxOf("+x@corp.example").canonical).not.toBe(mailboxOf("+y@corp.example").canonical);
    expect(mailboxOf("..@gmail.com").canonical).toBe("..@gmail.com");
  });

  it("gives something with no @ back as it is, with no domain, so no domain limit is applied to it", () => {
    expect(mailboxOf("nobody")).toEqual({ canonical: "nobody", domain: "" });
  });
});
