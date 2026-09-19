import { test, expect, type APIRequestContext } from "@playwright/test";
import { MAX_ATTEMPTS, SHARED_SOURCE_ATTEMPTS } from "@/lib/rate-limit";
import { PROXIED_BASE_URL, RUN_PROXIED_SERVER } from "../playwright.config";
import { SAME_ORIGIN } from "./api";
import { MEMBER_PASSWORD, MEMBER_USERNAME, seedWithoutSessions } from "./seed";

/**
 * BP-409. `sessions-and-auth.spec.ts` pins `TRUSTED_PROXY_HOPS: "0"` for the whole suite — correct,
 * because that is what the documented docker-compose deployment runs, and it is what makes every
 * other login-throttle test deterministic. Its cost is that `getClientIp`'s other branch —
 * `entries.length < hops` and picking the hop-th entry from the right — is unreachable from
 * Playwright, and that is the branch the Railway deployment actually runs. This file exercises
 * that branch, against a second app server with its own `TRUSTED_PROXY_HOPS` and its own `.next`
 * output (see `PROXIED_BASE_URL` and `RUN_PROXIED_SERVER` in playwright.config.ts), so the pin
 * above stays untouched.
 *
 * Both thresholds are imported rather than copied, and the numbers below are the server's actual
 * off-by-one, checked against `src/lib/rate-limit.ts` rather than assumed:
 *
 * - The **account** key (`MAX_ATTEMPTS`, per address+username) is rechecked against its own
 *   just-recorded count inside the same request that fails, so the request that pushes the count
 *   to the threshold is the one that answers 429. `MAX_ATTEMPTS - 1` misses answer 401; the next
 *   one answers 429 — not the one after that.
 * - The **source** key (`SHARED_SOURCE_ATTEMPTS`, per address) is only rechecked on the *next*
 *   request's pre-check, never inside the request that filled it. `SHARED_SOURCE_ATTEMPTS` misses
 *   all answer 401 — including the one that fills the bucket — and the request after that is what
 *   answers 429.
 */

const SKIP_REASON =
  "needs the proxied app server — set E2E_PROXIED_SERVER=1 (see playwright.config.ts, PROXIED_BASE_URL)";
// test.skip()'s own message is a JSON/JUnit annotation only — the suite's configured `list`
// reporter never prints it, so "3 skipped" would otherwise say nothing about why. Logged at
// collection time so it survives in every reporter, `list` included.
if (!RUN_PROXIED_SERVER) console.log(`proxied-login-throttle.spec.ts: skipping — ${SKIP_REASON}`);
test.skip(!RUN_PROXIED_SERVER, SKIP_REASON);

const WRONG_PASSWORD = "not-the-password";

function loginAt(
  request: APIRequestContext,
  xForwardedFor: string,
  username: string,
  password: string
) {
  return request.post(`${PROXIED_BASE_URL}/api/auth/login`, {
    headers: { ...SAME_ORIGIN, "X-Forwarded-For": xForwardedFor },
    data: { username, password },
  });
}

/**
 * Fires `count` failed logins at the proxied server, batched for the same reason
 * `burnLoginAttempts` in sessions-and-auth.spec.ts is: each pays for a real bcrypt comparison, and
 * the atomic update pipeline behind the counter is safe under the concurrency this creates.
 * `xForwardedFor` and `credentials` are read per attempt so one helper drives both the
 * per-account and the per-source test below. Every status is asserted, so a request that never
 * reached the counter reads as a lost request rather than as a threshold that moved.
 */
async function burnAttempts(
  request: APIRequestContext,
  count: number,
  xForwardedFor: (n: number) => string,
  credentials: (n: number) => { username: string; password: string }
) {
  const batch = 8;
  for (let sent = 0; sent < count; sent += batch) {
    const size = Math.min(batch, count - sent);
    const answers = await Promise.all(
      Array.from({ length: size }, (_, i) => {
        const n = sent + i;
        const { username, password } = credentials(n);
        return loginAt(request, xForwardedFor(n), username, password);
      })
    );
    for (const answer of answers) {
      expect(answer.status(), await answer.text()).toBe(401);
    }
  }
}

test.beforeEach(async () => {
  await seedWithoutSessions();
});

test("a real login still succeeds through the proxied server", async ({ request }) => {
  const response = await loginAt(request, "198.51.100.10", MEMBER_USERNAME, MEMBER_PASSWORD);
  expect(response.status(), await response.text()).toBe(200);
});

test("forged X-Forwarded-For entries ahead of the trusted hop cannot open a fresh account bucket, and the threshold still trips", async ({
  request,
}) => {
  // The hop the server is configured to trust (TRUSTED_PROXY_HOPS=1) is the last entry — what a
  // real proxy in front of it would have appended. Everything to its left is exactly what BP-318
  // was about: caller-supplied noise. A different forged entry on every attempt must not matter.
  const TRUSTED_HOP = "198.51.100.20";
  const forgedPrefix = (n: number) => `203.0.113.${(n % 250) + 1}, ${TRUSTED_HOP}`;

  await burnAttempts(
    request,
    MAX_ATTEMPTS - 1,
    forgedPrefix,
    () => ({ username: MEMBER_USERNAME, password: WRONG_PASSWORD })
  );

  const tripping = await loginAt(
    request,
    forgedPrefix(MAX_ATTEMPTS),
    MEMBER_USERNAME,
    WRONG_PASSWORD
  );
  expect(tripping.status(), await tripping.text()).toBe(429);

  // The control this proves is not vacuous: a different account from the same trusted hop is
  // refused on its own credentials, not swept up by the first account's lockout.
  const otherAccount = await loginAt(request, forgedPrefix(0), "not-a-real-account", WRONG_PASSWORD);
  expect(otherAccount.status(), await otherAccount.text()).toBe(401);
});

test("a spray across usernames from one address is bucketed by source, independently of any one account", async ({
  request,
}) => {
  const SOURCE_IP = "198.51.100.30";
  await burnAttempts(
    request,
    SHARED_SOURCE_ATTEMPTS,
    () => SOURCE_IP,
    (n) => ({ username: `e2e-spray-${n}`, password: WRONG_PASSWORD })
  );

  // Same source, one more distinct account: the source bucket is what refuses this, since no
  // single account here has come anywhere near MAX_ATTEMPTS.
  const tripping = await loginAt(request, SOURCE_IP, "e2e-spray-tripping", WRONG_PASSWORD);
  expect(tripping.status(), await tripping.text()).toBe(429);

  // The control: the very same account, from a different address, is unaffected — the block is on
  // the source, not on a name the spray happened to use.
  const elsewhere = await loginAt(request, "198.51.100.31", "e2e-spray-tripping", WRONG_PASSWORD);
  expect(elsewhere.status(), await elsewhere.text()).toBe(401);
});
