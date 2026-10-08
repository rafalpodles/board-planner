import { describe, it, expect } from "vitest";
import { paymentUrl } from "./payment-url";

// BP-676: the page navigates to whatever this returns, so a service that answered with anything but a web page must not get there
describe("paymentUrl", () => {
  it("takes an https address", () => {
    expect(paymentUrl("https://checkout.stripe.com/c/pay/cs_test_1#frag")).toBe("https://checkout.stripe.com/c/pay/cs_test_1#frag");
  });

  it("takes the long address a live Checkout session has, fragment and all", () => {
    const live = `https://checkout.stripe.com/c/pay/cs_live_a1#fid${"x".repeat(4000)}`;

    expect(paymentUrl(live)).toBe(live);
  });

  it.each([
    ["a script", "javascript:alert(1)"],
    ["a data page", "data:text/html,<script>1</script>"],
    ["plain http", "http://checkout.stripe.com/c/pay/cs_test_1"],
    ["credentials in the address", "https://user:pass@checkout.stripe.com/"],
    ["a path with no host", "/c/pay/cs_test_1"],
    ["a number", 5],
    ["nothing", undefined],
    ["an address too long to be one", `https://checkout.stripe.com/${"a".repeat(9000)}`],
  ])("refuses %s", (_why, value) => {
    expect(paymentUrl(value)).toBeNull();
  });
});
