export async function bootNode(): Promise<void> {
  // Read here so a fumbled value is one startup failure naming the variable, and so an operator
  // can see which answer the instance settled on — the throttle keys on it, and getting it wrong
  // is silent in both directions (BP-318). This lived in a second copy of this file under src/
  // that Next never loaded, so it had never once been printed (BP-356).
  const { trustedProxyHops } = await import("@/lib/client-ip");
  const hops = trustedProxyHops();
  console.log(
    hops === 0
      ? "TRUSTED_PROXY_HOPS=0 — X-Forwarded-For is ignored and anonymous callers share one throttle bucket"
      : `TRUSTED_PROXY_HOPS=${hops} — the client address is taken ${hops} entries from the right of X-Forwarded-For`
  );

  // A bad key is a line in the log and the Free plan, never a failed start
  const { currentLicence, describeLicenceAtStartup } = await import("@/lib/licence");
  const licence = currentLicence();
  const licenceLine = describeLicenceAtStartup(licence);
  if (licence && licence.verdict !== "valid") console.warn(licenceLine);
  else console.log(licenceLine);

  // Above the try for the same reason the hops are: a fumbled value has to be one startup
  // failure naming the variable. `assertEncryptionConfig` throws on a malformed key on purpose
  // (BP-282) — but every other path to this module goes through the PM scheduler, inside the
  // try below, whose catch reports it as a MongoDB connection failure and leaves the process
  // serving 500s from every route that touches a secret, with the schedulers never started.
  try {
    // The import is inside the try because the module asserts at evaluation time: in the bad
    // case it throws here and the explicit call below never runs. Kept anyway — it says what
    // this block is for, and survives the module-level call being removed.
    const { assertEncryptionConfig } = await import("@/lib/encryption");
    assertEncryptionConfig();
    // The same for the session cookie: an insecure cookie on an https origin used to throw only
    // when the login route first loaded the module, which read as a 500 on sign-in (BP-773)
    const { assertSessionConfig } = await import("@/lib/session");
    assertSessionConfig();
    // Passwords off with no provider is an instance nobody can sign in to (BP-830)
    const { assertSignInConfig } = await import("@/lib/password-sign-in");
    assertSignInConfig();
    const { assertOrganisationDomainConfig } = await import("@/lib/organisation-host");
    assertOrganisationDomainConfig();
  } catch (err) {
    // Exiting rather than throwing, and this is not belt-and-braces. `NextServer.prepare()`
    // awaits the real prepare only when `dev` (next/dist/server/next.js), so under `next start`
    // — Railway, and the standalone image — the rejection is caught into a memoised promise and
    // re-thrown per request instead: process up, port bound, every request 500 for ever, which
    // a container reports as healthy. Measured, not inferred. Exiting makes it a crash-loop an
    // operator can see, and makes true the sentence the README, .env.example, CLAUDE.md and
    // docker-compose.yml all carry.
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  await bootWhenDatabaseIsReady();
}

// A boot that finds the database down used to give up for the process's whole lifetime: nothing
// here ever ran again, so an instance that came up mid-outage served requests fine (connectDB is
// safely re-callable, per BP-362) but never got its seeding, its agent catalog backfill, or any of
// its three schedulers — PM autonomy, GitHub sync, the digest — until something redeployed it.
// Railway redeploys on every push, so this self-healed quietly, which is what made it worth fixing
// rather than luck (BP-366). Retried only for a database that is not answering yet: a genuine
// misconfiguration (a malformed MONGODB_URI, for instance) will not come right by waiting, so it
// keeps today's behaviour of logging once and leaving it for a person to fix.
const BOOT_DB_RETRY_MS = 30_000;

async function bootWhenDatabaseIsReady(): Promise<void> {
  const { connectDB, DatabaseUnavailableError } = await import("@/lib/db");
  try {
    await connectDB();
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      console.error(
        `Startup MongoDB connection failed — retrying in ${BOOT_DB_RETRY_MS}ms:`,
        err.message
      );
      setTimeout(() => {
        bootWhenDatabaseIsReady().catch((retryErr) =>
          console.error("Unexpected error retrying startup after a database outage:", retryErr)
        );
      }, BOOT_DB_RETRY_MS);
      return;
    }
    // Not a database outage — a misconfiguration will not come right by being retried, so this
    // keeps the pre-BP-366 behaviour: say so once and leave it, the same way instrumentation.ts
    // always has for anything below this line that is not a connection problem.
    console.error("Startup MongoDB connection failed (will retry on demand):", err);
    return;
  }

  try {
    console.log("MongoDB connected successfully");
    const { forEachServedOrganisation } = await import("@/lib/organisation-jobs");

    const { backfillOrganisations } = await import("@/lib/organisation-migration");
    const { default: mongoose } = await import("mongoose");
    const organisationless = await backfillOrganisations(mongoose.connection, { apply: false }).catch((error) => {
      console.error("Failed to count rows with no organisation:", error);
      return null;
    });
    if (organisationless && organisationless.total > 0) {
      console.error(
        `WARNING: ${organisationless.total} row(s) belong to no organisation and are invisible to every request; scripts/migrate-organisation.ts gives them one`
      );
    }

    // Said, not refused: the state can arise at runtime (a demotion, a deactivation, an unlink), and
    // exiting would turn a restart into an outage for every member, not only the administrators
    const { adminsLockedOut } = await import("@/lib/password-sign-in");
    await forEachServedOrganisation("Sign-in check", async (db) => {
      const lockedOut = await adminsLockedOut(db);
      if (lockedOut) console.error(`WARNING: ${lockedOut}`);
    });

    const { DEFAULT_PROJECT_CATEGORIES, DEFAULT_PROJECT_COLUMNS } = await import("@/types");
    await forEachServedOrganisation("Project defaults", async (db) => {
      const seeded = await db.Project.updateMany(
        { categories: { $exists: false } },
        { $set: { categories: DEFAULT_PROJECT_CATEGORIES } }
      );
      if (seeded.modifiedCount > 0) {
        console.log(`Seeded default categories on ${seeded.modifiedCount} project(s)`);
      }
      const seededColumns = await db.Project.updateMany(
        { columns: { $exists: false } },
        { $set: { columns: DEFAULT_PROJECT_COLUMNS } }
      );
      if (seededColumns.modifiedCount > 0) {
        console.log(`Seeded default columns on ${seededColumns.modifiedCount} project(s)`);
      }
    });

    // Caught here rather than left to the outer handler: the backfill and the PM scheduler are
    // below this line, so an unhandled seed failure would skip both — and be logged as a
    // connection problem, which it is not. An instance without the catalog cannot run a worker
    // but is otherwise usable.
    const { seedAgents } = await import("@/lib/agent-seed");
    await forEachServedOrganisation("Agent catalog seed", (db) =>
      seedAgents(db).catch((error) => {
        console.error("Failed to seed the agent catalog:", error);
      })
    );

    // The backfill that stood here set `worker.agent` to the shipped Default on every project
    // where it was null — on **every start**, not once. It existed so the task picker's first
    // suggestion always pointed at a real agent, and BP-458 makes that unnecessary: no default
    // is now a state the picker names ("No default — the task picker starts empty") and one a
    // project admin can deliberately choose. Left in place it undid that choice at the next
    // restart, because the schema defaults the field to null and a cleared project is therefore
    // indistinguishable from one that never had a default.
    //
    // Projects it already reached keep what it wrote; removing it unsets nothing.

    const { User } = await import("@/models/user");
    const { acrossOrganisations } = await import("@/lib/organisation-wall");
    // Printed now rather than on the first visit, so the operator finds it in the startup log
    const { setupCode } = await import("@/lib/setup-code");
    if ((await acrossOrganisations(User.countDocuments(), "the setup code exists only while the instance has no account at all")) === 0) setupCode();

    const { markPmAsMachine } = await import("@/lib/pm/pm-user");
    // Caught like the catalog seed: a name it could not repair must not keep the schedulers down
    const { repairMachineNames } = await import("@/lib/worker-user");
    await forEachServedOrganisation("Machine accounts", async (db) => {
      await markPmAsMachine(db);
      const repaired = await repairMachineNames(db).catch((error) => {
        console.error("Failed to repair machine names:", error);
        return 0;
      });
      if (repaired > 0) console.log(`Repaired the display name of ${repaired} machine(s)`);
    });

    const { startPmScheduler } = await import("@/lib/pm/scheduler");
    startPmScheduler();
    console.log("PM scheduler started");

    // Logged like its three siblings, so an operator can see which answer the instance settled
    // on — a fumbled GITHUB_SYNC_TICK_MS is otherwise silent in both directions
    const { startGithubSyncScheduler } = await import("@/lib/github-sync");
    const githubSync = startGithubSyncScheduler();
    console.log(
      githubSync.started
        ? `GitHub pull-request sync started — every ${githubSync.tickMs}ms`
        : githubSync.reason === "off"
          ? "GitHub pull-request sync is off (GITHUB_SYNC_TICK_MS=0)"
          : "GitHub pull-request sync was already running"
    );

    // Logged whichever way it went, like its two neighbours: "no mail server" is an ordinary
    // self-hosted configuration and "already running" is what a `next dev` reload produces, but
    // a digest that never goes out is otherwise silent in both directions (BP-660)
    const { startDigestScheduler, digestHour, digestTimezone } = await import("@/lib/digest");
    const digest = startDigestScheduler();
    console.log(
      digest.started
        ? `Digest scheduler started — ${digestHour()}:00 ${digestTimezone()}, every ${digest.tickMs}ms`
        : digest.reason === "no mail server"
          ? "Digest scheduler is off (no SMTP server configured)"
          : "Digest scheduler was already running"
    );
  } catch (err) {
    // Don't crash the server on a transient boot-time failure after connecting;
    // route handlers already work, only the seeding/backfill/schedulers above are at risk.
    console.error("Startup work after connecting to MongoDB failed:", err);
  }
}
