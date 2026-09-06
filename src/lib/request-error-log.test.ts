import { describe, it, expect } from "vitest";
import { describeRequestError } from "./request-error-log";

const ACCESS_TOKEN = "cpat_" + "a".repeat(64);

function request(over: Partial<Parameters<typeof describeRequestError>[1]> = {}) {
  return {
    path: "/oauth/token",
    method: "POST",
    headers: { "content-type": "application/json" } as Record<string, string | string[]>,
    ...over,
  };
}

describe("describeRequestError", () => {
  it("names the request the error came out of", () => {
    const line = describeRequestError(
      new TypeError('Content-Type was not one of "multipart/form-data" …'),
      request(),
      { routePath: "/oauth/token", routeType: "route" }
    );

    expect(line).toContain("POST /oauth/token");
    expect(line).toContain("content-type=application/json");
    expect(line).toContain("TypeError: Content-Type was not one of");
  });

  it("says which kind of credential was presented", () => {
    const kinds: [Record<string, string>, string][] = [
      [{ authorization: `Bearer ${ACCESS_TOKEN}` }, "credential=bearer cpat_"],
      [{ authorization: "Bearer cp_00000000deadbeef" }, "credential=bearer cp_"],
      [{ authorization: "Bearer whatever" }, "credential=bearer of no known kind"],
      [{ authorization: "Basic dXNlcjpwdw==" }, "credential=basic header"],
      [{ cookie: "bp_session=cps_secret" }, "credential=cookie"],
      [{}, "credential=none"],
    ];

    for (const [headers, expected] of kinds) {
      expect(describeRequestError(new Error("boom"), request({ headers }))).toContain(expected);
    }
  });

  it("never prints the credential itself, from any of the three places it can appear", () => {
    const line = describeRequestError(
      new Error(`Cast to ObjectId failed for value "${ACCESS_TOKEN}"`),
      request({
        path: `/oauth/token?refresh_token=cprt_${"b".repeat(64)}&client_id=cpc_1`,
        headers: { authorization: `Bearer ${ACCESS_TOKEN}`, cookie: "bp_session=cps_secret" },
      })
    );

    expect(line).not.toContain("a".repeat(64));
    expect(line).not.toContain("b".repeat(64));
    expect(line).not.toContain("cps_secret");
    expect(line).toContain("query=refresh_token,client_id");
    expect(line).toContain('Cast to ObjectId failed for value "cpat_***"');
  });

  it("caps a message that would otherwise be a body dump", () => {
    const line = describeRequestError(new Error("x".repeat(5000)), request());

    expect(line.length).toBeLessThan(600);
  });

  it("describes something thrown that is not an Error at all", () => {
    expect(describeRequestError("just a string", request())).toContain("string: just a string");
  });
});
