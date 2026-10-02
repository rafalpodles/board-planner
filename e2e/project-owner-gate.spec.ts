import { test, expect, type APIRequestContext, type APIResponse, type Browser } from "@playwright/test";
import mongoose from "mongoose";
import { SAME_ORIGIN } from "./api";
import {
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  FIELDS,
  MEMBER_ID,
  MEMBER_USERNAME,
  OWNER_ID,
  OWNER_USERNAME,
  PROJECT_AGENT_ID,
  PROJECT_ID,
  PROJECT_KEY,
  seed,
  seedAgents,
  seedCustomFields,
  seedMachine,
} from "./seed";
import { signInContext } from "./session";
import { scanInlineOwnerChecks, scanOwnerGatedRoutes } from "./owner-gated-routes";

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

async function inDb<T>(work: (db: NonNullable<typeof mongoose.connection.db>) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

async function onProject(update: Record<string, unknown>) {
  await inDb((db) => db.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: update }));
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
  (method: "post" | "put" | "patch" | "delete", data: unknown) => (request: APIRequestContext, path: string) =>
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
  "GET /api/projects/[projectId]/invitations": { send: get, handled: { status: 200, body: JSON_ARRAY } },
  "POST /api/projects/[projectId]/invitations": {
    send: withBody("post", {}),
    handled: { status: 400, body: /Enter the address to invite/ },
  },
  "DELETE /api/projects/[projectId]/invitations/[invitationId]": {
    send: (request, path) => request.delete(path, { headers: SAME_ORIGIN }),
    handled: { status: 404, body: /Invitation not found/ },
  },
  "GET /api/projects/[projectId]/members/candidates": {
    // The instance admin holds no grant on the board, so the lookup must offer it
    send: (request, path) => request.get(`${path}?q=${ADMIN_USERNAME.slice(0, 3)}`),
    handled: { status: 200, body: new RegExp(`"username":"${ADMIN_USERNAME}"`) },
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
    .replace("[fieldId]", new mongoose.Types.ObjectId().toString())
    .replace("[invitationId]", new mongoose.Types.ObjectId().toString());
}

type Who = "owner" | "member";

async function signedIn(browser: Browser, baseURL: string | undefined, who: Who) {
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

// Both personas stand on the board through a grant alone, so the member's 403 below is the owner
// gate and not a missing grant
for (const [who, username] of [["owner", OWNER_USERNAME], ["member", MEMBER_USERNAME]] as const) {
  test(`the ${who} persona holds no instance standing, and reaches the board`, async ({ browser, baseURL }) => {
    const context = await signedIn(browser, baseURL, who);
    try {
      const me = await context.request.get("/api/auth/me");
      expect(me.status()).toBe(200);
      expect(await me.json()).toMatchObject({ username, role: "member" });

      const board = await context.request.get(`/api/projects/${PROJECT_KEY}`);
      expect(board.status(), await board.text()).toBe(200);
      expect((await board.json()).key).toBe(PROJECT_KEY);
    } finally {
      await context.close();
    }
  });
}

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

/**
 * BP-748. The owner-only behaviour a route decides inline — `check(…, "admin")` or
 * `administeredProjectIds` — rather than through `withProjectOwner`, scanned the same way and held
 * to the same rule. Not every one refuses: some only answer the owner differently, so each recipe
 * names what the member and the owner are each told, read from the field that decides it.
 */

type Answer = { status: number; body: RegExp };

type InlineRecipe = {
  setup?: () => Promise<void>;
  send: (request: APIRequestContext, path: string, who: Who) => Promise<APIResponse>;
  read?: (response: APIResponse) => Promise<string>;
  member: Answer;
  owner: Answer;
};

const field =
  <T>(pick: (body: T) => unknown) =>
  async (response: APIResponse): Promise<string> =>
    response.ok() ? JSON.stringify(pick(await response.json())) : response.text();

type Listed = { key?: string; project?: string; canEnable?: boolean; canAdmin?: boolean };
const onTheBoard = (list: Listed[]) => list.find((p) => p.key === PROJECT_KEY);

const OAUTH_STATE: Record<Who, string> = { member: "gate-state-member", owner: "gate-state-owner" };
const PERSONA_ID: Record<Who, mongoose.Types.ObjectId> = { member: MEMBER_ID, owner: OWNER_ID };
const REPOSITORY = "https://github.com/e2e/owner-gate";

const oauthStates = async () => {
  await inDb((db) =>
    db.collection("pmoauthstates").insertMany(
      (["member", "owner"] as const).map((who) => ({
        state: OAUTH_STATE[who],
        project: PROJECT_ID,
        serverName: PROBE_SERVER,
        codeVerifier: "gate-verifier",
        initiatedBy: PERSONA_ID[who],
        createdAt: new Date(),
      }))
    )
  );
};

const workersOff = () => onProject({ "worker.enabled": false, repositoryUrl: REPOSITORY });

async function personaMachines() {
  await seedMachine(REPOSITORY, { owner: MEMBER_ID });
  await seedMachine(REPOSITORY, { owner: OWNER_ID });
}

const machineOf = (who: Who) =>
  inDb(async (db) => {
    const machine = await db.collection("workers").findOne({ name: `laptop-${PERSONA_ID[who]}` });
    return String(machine!._id);
  });

async function enrolmentFor(request: APIRequestContext, who: Who): Promise<string> {
  const started = await request.post("/api/workers/enrolment/device", {
    headers: { ...SAME_ORIGIN, "x-cp-protocol": "1" },
    data: { name: `gate-${who}`, host: `gate-${who}.local` },
  });
  expect(started.status(), await started.text()).toBe(201);
  return (await started.json()).userCode;
}

const FORBIDDEN = /^\{"error":"Forbidden"\}$/;
const NO = /^false$/;
const YES = /^true$/;

const INLINE_RECIPES: Record<string, InlineRecipe> = {
  "GET /api/pm/oauth/callback": {
    // Each persona completes a flow it started itself, so only the grant tells the two apart
    setup: oauthStates,
    send: (request, path, who) => request.get(`${path}?state=${OAUTH_STATE[who]}`, { maxRedirects: 0 }),
    read: async (response) => response.headers()["location"] ?? "",
    member: { status: 302, body: /mcp_oauth=error%3Awrong_user$/ },
    owner: { status: 302, body: /mcp_oauth=error%3Amissing_code$/ },
  },
  "GET /api/projects": {
    send: get,
    read: field((list: Listed[]) => onTheBoard(list)?.canAdmin),
    member: { status: 200, body: NO },
    owner: { status: 200, body: YES },
  },
  "GET /api/projects/[projectId]": {
    send: get,
    read: field((project: Listed) => project.canAdmin),
    member: { status: 200, body: NO },
    owner: { status: 200, body: YES },
  },
  "PUT /api/projects/[projectId]": {
    // The wrapper refuses the member, so only the owner half reaches the inline check
    send: withBody("put", {}),
    read: field((project: Listed) => project.canAdmin),
    member: { status: 403, body: FORBIDDEN },
    owner: { status: 200, body: YES },
  },
  "PUT /api/projects/[projectId]/agent": {
    send: withBody("put", { agentId: "" }),
    member: { status: 403, body: /Only a project admin can change this/ },
    owner: { status: 200, body: /"ok":true/ },
  },
  "PATCH /api/projects/[projectId]/custom-fields/[fieldId]": {
    // Dropping a saved option is the one PATCH a member may not make
    setup: () => seedCustomFields(),
    send: withBody("patch", { options: [FIELDS.difficulty.options[0]] }),
    member: { status: 403, body: /Only a project owner can remove an option a field already has/ },
    owner: { status: 200, body: new RegExp(`^\\[(?!.*"${FIELDS.difficulty.options[1].id}").*"${FIELDS.difficulty.options[0].id}"`) },
  },
  "GET /api/projects/[projectId]/handover": {
    send: get,
    read: field((readiness: Listed) => readiness.canAdmin),
    member: { status: 200, body: NO },
    owner: { status: 200, body: YES },
  },
  "POST /api/agents": {
    // Only an agent for a project is the project's owner's to add
    send: withBody("post", { name: "Gate probe", projectId: String(PROJECT_ID) }),
    member: { status: 403, body: /Only a project admin can add an agent to a project/ },
    owner: { status: 201, body: new RegExp(`"scope":"project","projectId":"${PROJECT_ID}"`) },
  },
  "PUT /api/agents/[agentId]": {
    setup: seedAgents,
    send: withBody("put", { name: "Renamed by the owner gate" }),
    member: { status: 403, body: /Not yours to change/ },
    owner: { status: 200, body: /"name":"Renamed by the owner gate"/ },
  },
  "DELETE /api/agents/[agentId]": {
    setup: seedAgents,
    send: (request, path) => request.delete(path, { headers: SAME_ORIGIN }),
    member: { status: 403, body: /Not yours to delete/ },
    owner: { status: 200, body: /"ok":true/ },
  },
  "GET /api/workers/enrolment/device/[userCode]": {
    send: async (request, path, who) => request.get(path.replace("[userCode]", await enrolmentFor(request, who))),
    read: field((enrolment: { projects: Listed[] }) => onTheBoard(enrolment.projects)?.canEnable),
    member: { status: 200, body: NO },
    owner: { status: 200, body: YES },
  },
  "POST /api/workers/enrolment/device/[userCode]/approve": {
    // Both confirm their own machine; only the owner's confirmation switches the board's workers on
    setup: workersOff,
    send: async (request, path, who) =>
      request.post(path.replace("[userCode]", await enrolmentFor(request, who)), {
        headers: SAME_ORIGIN,
        data: { projectId: String(PROJECT_ID) },
      }),
    read: field((approved: { workersEnabled: boolean }) => approved.workersEnabled),
    member: { status: 200, body: NO },
    owner: { status: 200, body: YES },
  },
  "GET /api/workers/[workerId]/projects": {
    setup: personaMachines,
    send: async (request, path, who) => request.get(path.replace("[workerId]", await machineOf(who))),
    read: field((screen: { catalogue: Listed[] }) => onTheBoard(screen.catalogue)?.canEnable),
    member: { status: 200, body: NO },
    owner: { status: 200, body: YES },
  },
  "PUT /api/workers/[workerId]/projects": {
    setup: async () => {
      await workersOff();
      await personaMachines();
    },
    send: async (request, path, who) =>
      request.put(path.replace("[workerId]", await machineOf(who)), {
        headers: SAME_ORIGIN,
        data: { projects: [String(PROJECT_ID)] },
      }),
    read: field((picked: { projects: string[]; leftDisabled: string[] }) => [picked.projects, picked.leftDisabled]),
    member: { status: 200, body: new RegExp(`^\\[\\["${PROJECT_ID}"\\],\\["${PROJECT_KEY}"\\]\\]$`) },
    owner: { status: 200, body: new RegExp(`^\\[\\["${PROJECT_ID}"\\],\\[\\]\\]$`) },
  },
};

const INLINE = scanInlineOwnerChecks();

function concreteInline(path: string): string {
  return path
    .replace("[projectId]", PROJECT_KEY)
    .replace("[fieldId]", String(FIELDS.difficulty._id))
    .replace("[agentId]", String(PROJECT_AGENT_ID));
}

test("the scan found the inline owner checks, and every one of them has a recipe", () => {
  expect(INLINE.length, "the inline scan found nothing — every case below would be vacuous").toBeGreaterThanOrEqual(14);
  const scanned = INLINE.map((c) => c.key);
  expect(
    INLINE.filter((c) => !INLINE_RECIPES[c.key]).map((c) => `${c.key} (line ${c.line})`),
    "inline owner checks with no recipe here"
  ).toEqual([]);
  expect(Object.keys(INLINE_RECIPES).filter((key) => !scanned.includes(key)), "recipes for checks no longer inline").toEqual([]);
  expect(
    Object.entries(INLINE_RECIPES)
      .filter(([, r]) => r.member.status === r.owner.status && r.member.body.source === r.owner.body.source)
      .map(([key]) => key),
    "recipes that cannot tell the owner from the member"
  ).toEqual([]);
});

for (const site of INLINE) {
  test(`${site.key}: the board owner is answered as one, a plain member is not`, async ({ browser, baseURL }) => {
    const recipe = INLINE_RECIPES[site.key];
    expect(recipe, `no request recipe for ${site.key} (line ${site.line}) — add one to INLINE_RECIPES`).toBeDefined();
    await recipe.setup?.();

    const path = concreteInline(site.path);
    const read = recipe.read ?? ((response: APIResponse) => response.text());
    const member = await signedIn(browser, baseURL, "member");
    const owner = await signedIn(browser, baseURL, "owner");
    try {
      for (const [who, context] of [["member", member], ["owner", owner]] as const) {
        const response = await recipe.send(context.request, path, who);
        const body = await read(response);
        expect(response.status(), `${who}: ${body}`).toBe(recipe[who].status);
        expect(body, who).toMatch(recipe[who].body);
      }
    } finally {
      await member.close();
      await owner.close();
    }
  });
}
