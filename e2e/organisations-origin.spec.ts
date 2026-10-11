import { test, expect, type APIRequestContext } from "@playwright/test";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { ACME, GLOBEX, ORGANISATIONS_API, PLATFORM_HOST, asOrganisation, bearer, hostOf, originOf, seedTwoOrganisations } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

/**
 * BP-923. A proxy that strips Sec-Fetch-* leaves a write with only its Origin to be judged by, and the
 * allowlist it was judged against was the platform's: it refused an organisation's own origin and
 * accepted the platform's on every organisation's host. Sent without Sec-Fetch-Site, as such a proxy does.
 */
const TITLE = "Written through a proxy that strips Fetch Metadata";

const write = (request: APIRequestContext, origin: string | null) =>
  request.post(`${ORGANISATIONS_API}/api/projects/${ACME.projectId}/tasks`, {
    headers: {
      host: hostOf(ACME),
      cookie: `__Host-bp_session=${ACME.sessionToken}`,
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    data: { title: TITLE },
  });

const titled = async (request: APIRequestContext) => {
  const listed = await request.get(`${ORGANISATIONS_API}/api/projects/${ACME.projectId}/tasks`, { headers: { ...asOrganisation(ACME), ...bearer(ACME) } });
  return ((await listed.json()) as { title: string }[]).filter((task) => task.title === TITLE).length;
};

test("a write is accepted with the origin of the organisation's own host, and with nothing else", async ({ request }) => {
  const accepted = await write(request, originOf(ACME));
  expect(accepted.status(), await accepted.text()).toBe(201);
  expect(await titled(request)).toBe(1);

  for (const [what, origin] of [
    ["the platform's origin, which PUBLIC_ORIGIN names", `http://${PLATFORM_HOST}`],
    ["another organisation's origin", originOf(GLOBEX)],
    ["no origin at all", null],
  ] as const) {
    expect((await write(request, origin)).status(), what).toBe(403);
  }
  expect(await titled(request), "a refused write stored nothing").toBe(1);
});
