import { test, expect, type APIRequestContext, type APIResponse, type Browser } from "@playwright/test";
import mongoose from "mongoose";
import { SAME_ORIGIN } from "./api";
import { E2E_MONGODB_URI, OWNER_USERNAME, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signInContext } from "./session";
import { scanOwnerGatedRoutes } from "./owner-gated-routes";

/**
 * BP-699. Every `withProjectOwner` route + method, driven once by a genuine board owner (a Grant
 * `relation: "owner"`, no instance standing) and once by a plain member. The instance admin
 * bypasses grant resolution, so it is kept out: only the owner persona can exercise the
 * `grant === "owner"` branch these routes depend on.
 *
 * The list is scanned from `src/app/api/**\/route.ts` at collection time. A route with no recipe
 * below fails, so a new owner-gated route cannot join the product without joining this spec.
 *
 * Each recipe is the cheapest request that gets past the gate and makes the handler answer in its
 * own words — a validation 400, a read, or a refusal only the handler can compose — so a gate that
 * refused everybody fails here, and nothing leaves the rig.
 */

type Recipe = {
  setup?: () => Promise<void>;
  send: (request: APIRequestContext, path: string) => Promise<APIResponse>;
  handled: { status: number; body: RegExp };
};

async function onProject(update: Record<string, unknown>) {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    await mongoose.connection.db!.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: update });
  } finally {
    await mongoose.disconnect();
  }
}

const PROBE_SERVER = "gate-probe";

const probeServer = () =>
  onProject({
    "pm.mcpServers": [
      {
        name: PROBE_SERVER,
        url: "https://mcp.example.com/mcp",
        authType: "bearer",
        authToken: "",
        enabled: true,
        allowWrites: false,
        toolAllowlist: [],
        oauth: { status: "connected", accessToken: "", refreshToken: "", clientId: "" },
      },
    ],
  });

const get = (request: APIRequestContext, path: string) => request.get(path);
const withBody =
  (method: "post" | "put" | "delete", data: unknown) => (request: APIRequestContext, path: string) =>
    request[method](path, { headers: SAME_ORIGIN, data });

const JSON_ARRAY = /^\[/;

const RECIPES: Record<string, Recipe> = {
  "DELETE /api/projects/[projectId]": {
    // The one gated action with no validation to stop at. seed() runs before every test, so the
    // seeded board is the throwaway, and the member is always refused before the owner deletes it.
    send: (request, path) => request.delete(path, { headers: SAME_ORIGIN }),
    handled: { status: 200, body: /Project deleted/ },
  },
  "PUT /api/projects/[projectId]": {
    send: withBody("put", { icon: "not-a-project-icon" }),
    handled: { status: 400, body: /icon must be empty or one of the supported project icons/ },
  },
  "GET /api/projects/[projectId]/audit": { send: get, handled: { status: 200, body: JSON_ARRAY } },
  "DELETE /api/projects/[projectId]/categories": {
    send: withBody("delete", {}),
    handled: { status: 400, body: /name is required/ },
  },
  "POST /api/projects/[projectId]/coda/sync": {
    // The seeded board has no Coda doc, so the handler refuses before it would call out
    send: withBody("post", {}),
    handled: { status: 400, body: /Coda doc, table and token must be configured/ },
  },
  "GET /api/projects/[projectId]/columns": {
    send: get,
    handled: { status: 200, body: /"id":"in_progress"/ },
  },
  "PUT /api/projects/[projectId]/columns": {
    send: withBody("put", { columns: [] }),
    handled: { status: 400, body: /columns must be an array of 1-12 entries/ },
  },
  "DELETE /api/projects/[projectId]/custom-fields/[fieldId]": {
    // A well-formed id no field has: the handler answers with the board's fields and removes nothing
    send: (request, path) => request.delete(path, { headers: SAME_ORIGIN }),
    handled: { status: 200, body: JSON_ARRAY },
  },
  "GET /api/projects/[projectId]/members": {
    send: get,
    handled: { status: 200, body: new RegExp(`"username":"${OWNER_USERNAME}"[^}]*"relation":"owner"`) },
  },
  "PUT /api/projects/[projectId]/members": {
    send: withBody("put", {}),
    handled: { status: 400, body: /userId and a relation of owner or member are required/ },
  },
  "DELETE /api/projects/[projectId]/members": {
    send: (request, path) => request.delete(path, { headers: SAME_ORIGIN }),
    handled: { status: 400, body: /userId is required/ },
  },
  "GET /api/projects/[projectId]/members/candidates": {
    send: get,
    handled: { status: 200, body: /^\[\]$/ },
  },
  "GET /api/projects/[projectId]/notifications": { send: get, handled: { status: 200, body: JSON_ARRAY } },
  "POST /api/projects/[projectId]/notifications": {
    send: withBody("post", {}),
    handled: { status: 400, body: /Type must be one of/ },
  },
  "PUT /api/projects/[projectId]/notifications": {
    send: withBody("put", {}),
    handled: { status: 400, body: /channelId is required/ },
  },
  "DELETE /api/projects/[projectId]/notifications": {
    send: withBody("delete", {}),
    handled: { status: 400, body: /channelId is required/ },
  },
  "POST /api/projects/[projectId]/pm/mcp-oauth/disconnect": {
    // Clears the tokens of a server seeded for this test only; nothing is called
    setup: probeServer,
    send: withBody("post", { name: PROBE_SERVER }),
    handled: { status: 200, body: /"ok":true/ },
  },
  "POST /api/projects/[projectId]/pm/mcp-oauth/start": {
    // A bearer server is refused before discovery, which is the step that would reach the network
    setup: probeServer,
    send: withBody("post", { name: PROBE_SERVER }),
    handled: { status: 400, body: /does not use OAuth auth/ },
  },
  "POST /api/projects/[projectId]/pm/mcp-test": {
    // No url is refused before an McpClient is built
    send: withBody("post", { url: "" }),
    handled: { status: 400, body: /url must be a public https URL/ },
  },
  "POST /api/projects/[projectId]/pm/review": {
    // With the PM switched off the handler refuses before it takes a turn or calls the model
    setup: () => onProject({ "pm.enabled": false }),
    send: withBody("post", {}),
    handled: { status: 409, body: /PM agent is not enabled for this project/ },
  },
  "GET /api/projects/[projectId]/pm/usage": {
    send: get,
    handled: { status: 200, body: /"maxCallsPerTurn"/ },
  },
  "DELETE /api/projects/[projectId]/templates": {
    send: withBody("delete", {}),
    handled: { status: 400, body: /templateId is required/ },
  },
  "POST /api/projects/[projectId]/webhooks": {
    send: withBody("post", { url: "" }),
    handled: { status: 400, body: /A valid URL of at most \d+ characters is required/ },
  },
  "PUT /api/projects/[projectId]/webhooks": {
    send: withBody("put", {}),
    handled: { status: 400, body: /webhookId is required/ },
  },
  "DELETE /api/projects/[projectId]/webhooks": {
    send: withBody("delete", {}),
    handled: { status: 400, body: /webhookId is required/ },
  },
};

const ROUTES = scanOwnerGatedRoutes();

function concrete(path: string): string {
  return path
    .replace("[projectId]", PROJECT_KEY)
    .replace("[fieldId]", new mongoose.Types.ObjectId().toString());
}

async function signedIn(browser: Browser, baseURL: string | undefined, who: "owner" | "member") {
  const context = await browser.newContext({ baseURL });
  await signInContext(context, who);
  return context;
}

test.beforeEach(seed);

test("the scan found the owner-gated routes, and every one of them has a recipe", () => {
  expect(ROUTES.length, "the route scan found nothing — every case below would be vacuous").toBeGreaterThanOrEqual(20);
  const scanned = ROUTES.map((r) => r.key);
  expect(scanned.filter((key) => !RECIPES[key]), "owner-gated routes with no recipe here").toEqual([]);
  expect(Object.keys(RECIPES).filter((key) => !scanned.includes(key)), "recipes for routes no longer owner-gated").toEqual([]);
});

test("the owner persona holds no instance standing, only the board grant", async ({ browser, baseURL }) => {
  const owner = await signedIn(browser, baseURL, "owner");
  try {
    const me = await owner.request.get("/api/auth/me");
    expect(me.status()).toBe(200);
    expect(await me.json()).toMatchObject({ username: OWNER_USERNAME, role: "member" });
  } finally {
    await owner.close();
  }
});

for (const route of ROUTES) {
  test(`${route.key}: a plain member is refused, the board owner gets through`, async ({ browser, baseURL }) => {
    const recipe = RECIPES[route.key];
    expect(recipe, `no request recipe for ${route.key} — add one to RECIPES`).toBeDefined();
    await recipe.setup?.();

    const path = concrete(route.path);
    const member = await signedIn(browser, baseURL, "member");
    const owner = await signedIn(browser, baseURL, "owner");
    try {
      const refused = await recipe.send(member.request, path);
      expect(refused.status(), await refused.text()).toBe(403);
      expect(await refused.json()).toEqual({ error: "Forbidden" });

      const handled = await recipe.send(owner.request, path);
      const body = await handled.text();
      expect(handled.status(), body).toBe(recipe.handled.status);
      expect(body).toMatch(recipe.handled.body);
    } finally {
      await member.close();
      await owner.close();
    }
  });
}
