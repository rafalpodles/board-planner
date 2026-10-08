import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

const m = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("./licence-pull", () => ({ licencePullConfig: m.config }));

const { askBilling } = await import("./billing-client");
const { PLATFORM_HEADERS, platformSigningString } = await import("./platform-request");

const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
const KEY = { keyId: "pull-1", d: jwk.d!, x: jwk.x! };
const ORG = "0123456789abcdef01234567";

let fetchMock: ReturnType<typeof vi.fn>;
const answer = (status: number, body: unknown) => fetchMock.mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

beforeEach(() => {
  m.config.mockReset().mockReturnValue({ url: new URL("https://licence.example"), key: KEY });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

// BP-676
describe("askBilling", () => {
  it("signs the request the way the licence service verifies it, to the action's path, with the payload as the body", async () => {
    answer(200, { url: "https://checkout.stripe.test/c/1" });

    await askBilling("checkout", { organisation: ORG, interval: "month" });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit & { headers: Record<string, string> }];
    expect(url.toString()).toBe("https://licence.example/api/billing/checkout");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toEqual({ organisation: ORG, interval: "month" });
    const signing = platformSigningString("POST", "licence.example", "/api/billing/checkout", init.headers[PLATFORM_HEADERS.timestamp], init.headers[PLATFORM_HEADERS.nonce], init.body as Uint8Array);
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: KEY.x }, format: "jwk" });
    expect(init.headers[PLATFORM_HEADERS.keyId]).toBe("pull-1");
    expect(verify(null, Buffer.from(signing), publicKey, Buffer.from(init.headers[PLATFORM_HEADERS.signature], "base64url"))).toBe(true);
  });

  it("hands back what the service says on 200", async () => {
    answer(200, { launchOpen: true, subscription: null });

    expect(await askBilling("status", { organisation: ORG })).toEqual({ status: "ok", body: { launchOpen: true, subscription: null } });
  });

  it("is off with no licence service configured, or a configuration that is wrong, and calls nobody", async () => {
    m.config.mockReturnValue(null);
    expect(await askBilling("status", {})).toEqual({ status: "off" });
    m.config.mockImplementation(() => {
      throw new Error("LICENCE_SERVICE_URL and LICENCE_PULL_KEY go together");
    });
    expect(await askBilling("status", {})).toEqual({ status: "off" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is off when the service takes no payments, however it says so", async () => {
    answer(200, { billing: false });
    expect(await askBilling("status", {})).toEqual({ status: "off" });
    answer(503, { error: "Billing is not set up", billing: false });
    expect(await askBilling("checkout", {})).toEqual({ status: "off" });
  });

  it("keeps a refusal's status and body, so the page can tell 'already subscribed' from the rest", async () => {
    answer(409, { error: "This organisation already has a subscription", reason: "already_subscribed" });

    expect(await askBilling("checkout", {})).toEqual({ status: "refused", httpStatus: 409, body: { error: "This organisation already has a subscription", reason: "already_subscribed" } });
  });

  it("is unreachable when the service is down, fails, or answers with more than it should", async () => {
    answer(500, "boom");
    expect(await askBilling("portal", {})).toEqual({ status: "unreachable" });
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await askBilling("portal", {})).toEqual({ status: "unreachable" });
    answer(200, `{"url":"${"a".repeat(70_000)}"}`);
    expect(await askBilling("portal", {})).toEqual({ status: "unreachable" });
  });

  it("treats an answer that is not JSON as an empty one", async () => {
    answer(200, "<html>");

    expect(await askBilling("status", {})).toEqual({ status: "ok", body: {} });
  });
});
