/**
 * BP-671: switch a COPY of a database to organisations on subdomains and check it from outside.
 *
 *   npx tsx scripts/rehearse-cloud.ts ./backups/<dump dir> [--keep]
 *
 * Prints check names, status codes and counts, never a document. With --keep it stays up at
 * http://app.rehearsal.localhost:3999 to sign in and look around.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import http from "node:http";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { scoped } from "../src/lib/db-scope";
import { DEFAULT_ORGANISATION_ID } from "../src/lib/organisation-field";
import { backfillOrganisations } from "../src/lib/organisation-migration";
import { signPlatformRequest } from "../src/lib/platform-request";
import { Organisation } from "../src/models/organisation";
import { DEFAULT_PROJECT_COLUMNS } from "../src/types";

const dumpDir = process.argv[2];
const keep = process.argv.includes("--keep");
const PORT = Number(process.env.REHEARSAL_PORT ?? 3999);
const MONGO_PORT = Number(process.env.REHEARSAL_MONGO_PORT ?? 27999);
const CONTAINER = "bp-rehearsal-mongo";
const DB = "rehearsal";
const DOMAIN = "rehearsal.localhost";
const DEFAULT_HOST = `app.${DOMAIN}`;
const PROBE_SLUG = "probe";
const MONGODB_URI = `mongodb://127.0.0.1:${MONGO_PORT}/${DB}`;

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function call(host: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method: "GET", headers: { host: `${host}:${PORT}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const json = (body: string) => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

async function waitForApp(server: ChildProcess) {
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error("the app exited while starting; run with REHEARSAL_VERBOSE=1 to see why");
    try {
      if ((await call(DEFAULT_HOST, "/api/auth/instance")).status > 0) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("the app did not answer within two minutes");
}

let server: ChildProcess | null = null;
function stop() {
  server?.kill("SIGTERM");
  execSync(`docker rm -fv ${CONTAINER} >/dev/null 2>&1 || true`, { shell: "/bin/sh" });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stop();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

async function main() {
  if (!dumpDir) throw new Error("Usage: npx tsx scripts/rehearse-cloud.ts <dump dir> [--keep]");

  console.log(`Copy: ${dumpDir} → ${CONTAINER} on port ${MONGO_PORT}`);
  execSync(`docker rm -fv ${CONTAINER} >/dev/null 2>&1 || true; docker run -d --name ${CONTAINER} -p 127.0.0.1:${MONGO_PORT}:27017 mongo:4.4 >/dev/null`, { stdio: "inherit", shell: "/bin/sh" });
  for (let i = 0; i < 30; i++) {
    try {
      execSync(`docker exec ${CONTAINER} mongo --quiet --eval "db.runCommand({ping:1})" >/dev/null 2>&1`, { shell: "/bin/sh" });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  // Its output is per-collection counts, but a failed insert's error would print a document
  try {
    execSync(`npx tsx scripts/dump-collections.ts restore "${dumpDir}"`, { stdio: "ignore", env: { ...process.env, MONGODB_URI, MONGODB_DB: DB } });
  } catch {
    throw new Error("the restore failed; nothing of the copy is printed, so run dump-collections.ts restore by hand against a scratch database to see why");
  }

  await mongoose.connect(MONGODB_URI, { autoIndex: false, autoCreate: false });
  const before = await backfillOrganisations(mongoose.connection, { apply: false });
  check("every document of the copy belongs to an organisation", before.total === 0, `${before.total} without`);
  const home = scoped(DEFAULT_ORGANISATION_ID);
  const homeProjects = await home.Project.countDocuments({});
  const homeUsers = await home.User.countDocuments({ kind: { $ne: "machine" }, deactivatedAt: null });
  check("the default organisation is there, with its boards", (await Organisation.exists({ _id: DEFAULT_ORGANISATION_ID })) !== null && homeProjects > 0, `${homeProjects} boards, ${homeUsers} people`);

  // A session for one of its administrators, made in the copy only, so the checks can sign in as them
  const admin = await home.User.findOne({ role: "admin", kind: { $ne: "machine" }, deactivatedAt: null }).select("_id").lean();
  if (!admin) throw new Error("the default organisation has no active administrator to rehearse as");
  const homeSession = `cps_${randomBytes(24).toString("hex")}`;
  const week = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await home.Session.create({ tokenHash: createHash("sha256").update(homeSession).digest("hex"), user: admin._id, expiresAt: week, absoluteExpiresAt: week, lastUsedAt: new Date() });

  const probeOrganisation = new mongoose.Types.ObjectId();
  await Organisation.create({ _id: probeOrganisation, name: "Rehearsal probe", slug: PROBE_SLUG });
  const probe = scoped(probeOrganisation);
  const probeUser = await probe.User.create({ username: "probe", fullName: "Rehearsal probe", email: "probe@rehearsal.localhost", role: "admin", kind: "human" });
  const probeToken = `cp_${randomBytes(16).toString("hex")}`;
  await probe.ApiToken.create({ user: probeUser._id, name: "rehearsal", tokenHash: bcrypt.hashSync(probeToken, 4), prefix: probeToken.slice(0, 11) });
  await probe.Project.create({ key: "PRB", name: "Probe board", columns: DEFAULT_PROJECT_COLUMNS, createdBy: probeUser._id });
  // Receivers are real addresses; the copy must not deliver to them
  await mongoose.connection.db!.collection("projects").updateMany({}, { $set: { webhooks: [], notificationChannels: [] } });
  await mongoose.connection.db!.collection("users").updateMany({}, { $set: { "notifications.chat.webhookUrl": "" } });
  await mongoose.disconnect();

  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const platformKey = { keyId: "rehearsal", d: jwk.d!, x: jwk.x! };

  console.log("Building the app (a few minutes)…");
  const DIST = ".next-rehearsal";
  execSync("npm run build", { stdio: process.env.REHEARSAL_VERBOSE ? "inherit" : "ignore", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NEXT_DIST_DIR: DIST, NODE_ENV: "production" } });
  const origin = `http://${DEFAULT_HOST}:${PORT}`;
  server = spawn("npx", ["next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    stdio: process.env.REHEARSAL_VERBOSE ? "inherit" : "ignore",
    // Only what it needs: a shell holding production's variables must not hand them to the copy
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NEXT_DIST_DIR: DIST,
      MONGODB_URI,
      ORGANISATION_DOMAIN: DOMAIN,
      ORGANISATION_DEFAULT_HOST: DEFAULT_HOST,
      PUBLIC_ORIGIN: origin,
      APP_ORIGIN: origin,
      PLATFORM_REQUEST_KEYS: `${platformKey.keyId}:${platformKey.x}`,
      ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      TRUSTED_PROXY_HOPS: "1",
      GITHUB_SYNC_TICK_MS: "0",
      PM_SCHEDULER_TICK_MS: "86400000",
      DIGEST_TICK_MS: "86400000",
      NODE_ENV: "production",
    },
  });

  try {
    await waitForApp(server!);
    const homeCookie = { cookie: `__Host-bp_session=${homeSession}` };
    const probeBearer = { authorization: `Bearer ${probeToken}` };
    const probeHost = `${PROBE_SLUG}.${DOMAIN}`;

    const me = await call(DEFAULT_HOST, "/api/auth/me", homeCookie);
    check("an administrator of the default organisation is signed in on app.", me.status === 200, `HTTP ${me.status}`);
    const boards = await call(DEFAULT_HOST, "/api/projects", homeCookie);
    const listed = (json(boards.body) as unknown[] | null)?.length ?? -1;
    check("app. lists the default organisation's boards, all of them", boards.status === 200 && listed === homeProjects, `HTTP ${boards.status}, ${listed} of ${homeProjects}`);
    check("their session is refused on another organisation's host", (await call(probeHost, "/api/auth/me", homeCookie)).status === 401);

    const probeBoards = await call(probeHost, "/api/projects", probeBearer);
    const probeListed = (json(probeBoards.body) as unknown[] | null)?.length ?? -1;
    check("another organisation sees its own board and none of the default organisation's", probeBoards.status === 200 && probeListed === 1, `HTTP ${probeBoards.status}, ${probeListed} board(s)`);
    check("another organisation's token is refused on app.", (await call(DEFAULT_HOST, "/api/projects", probeBearer)).status === 401);

    const resource = json((await call(DEFAULT_HOST, "/.well-known/oauth-protected-resource")).body)?.resource;
    check("an MCP client on app. is told app. is the resource", resource === origin, String(resource));
    check("app. is not the platform", (await call(DEFAULT_HOST, "/api/platform/organisations")).status === 404);

    const path = "/api/platform/organisations";
    const signed = await call(`login.${DOMAIN}`, path, signPlatformRequest({ method: "GET", host: `login.${DOMAIN}:${PORT}`, path, body: new Uint8Array() }, platformKey));
    const organisations = (json(signed.body)?.organisations ?? []) as { id: string; projects: number }[];
    const listedHome = organisations.find((row) => row.id === DEFAULT_ORGANISATION_ID.toHexString());
    check("the operator lists both organisations on login.", signed.status === 200 && organisations.length === 2 && listedHome?.projects === homeProjects, `HTTP ${signed.status}, ${organisations.length} organisations`);
  } finally {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    if (keep) {
      console.log(`\nStill running: open ${origin} in Chrome and sign in as usual. Ctrl-C stops it and removes the copy.`);
      process.exitCode = failed ? 1 : 0;
      await new Promise<void>((resolve) => server!.on("exit", () => resolve()));
    } else {
      stop();
      process.exitCode = failed ? 1 : 0;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  stop();
  process.exit(1);
});
