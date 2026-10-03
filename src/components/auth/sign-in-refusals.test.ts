import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { SIGN_IN_REFUSALS } from "./ProviderButtons";

// BP-842. `linked` reached /login with no sentence for it, so the page fell back to "did not work"
describe("the refusals a provider sign-in can come back with", () => {
  it("each has its own sentence on the sign-in page", () => {
    const callback = readFileSync(
      join(process.cwd(), "src/app/api/auth/oidc/[provider]/callback/route.ts"),
      "utf8"
    );
    const refused = new Set([...callback.matchAll(/refused: "([a-z_]+)"/g)].map((m) => m[1]));
    const redirected = [...callback.matchAll(/\/login\?sso=([a-z_]+)/g)].map((m) => m[1]);
    const codes = [...new Set([...refused, ...redirected])];

    expect(codes).toContain("linked");
    expect(codes.filter((code) => !SIGN_IN_REFUSALS[code])).toEqual([]);
  });
});
