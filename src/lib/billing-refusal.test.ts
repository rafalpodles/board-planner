import { describe, it, expect } from "vitest";
import { billingRefusal } from "./billing-refusal";

const read = async (answer: Parameters<typeof billingRefusal>[0]) => {
  const response = billingRefusal(answer);
  return { status: response.status, body: await response.json() };
};

// BP-676
describe("billingRefusal", () => {
  it("says payment is not available where the service takes none", async () => {
    expect(await read({ status: "off" })).toEqual({ status: 404, body: { error: "Payment is not available here" } });
  });

  it("tells an organisation that already pays so, which is not an error to retry", async () => {
    expect(await read({ status: "refused", httpStatus: 409, body: {} })).toMatchObject({ status: 409, body: { alreadySubscribed: true } });
  });

  it("says there is nothing to manage for an organisation that never paid", async () => {
    expect(await read({ status: "refused", httpStatus: 404, body: {} })).toMatchObject({ status: 404, body: { error: "This organisation has no subscription to manage" } });
  });

  it("is a 502 for everything else, saying nothing of what the service said", async () => {
    for (const answer of [{ status: "unreachable" }, { status: "refused", httpStatus: 400, body: { error: "interval must be month or year" } }, { status: "ok", body: {} }] as const) {
      expect(await read(answer)).toEqual({ status: 502, body: { error: "Could not reach the payment service. Try again in a moment." } });
    }
  });
});
