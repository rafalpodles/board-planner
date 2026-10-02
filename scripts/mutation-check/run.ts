/**
 * Deletes the code an e2e assertion watches and reports whether the assertion noticed (BP-712).
 *
 *   E2E_MONGODB_URI=mongodb://localhost:27712/bp712_e2e E2E_PORT=37120 \
 *     node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/mutation-check/run.ts \
 *     [--manifest e2e/mutations/manifest.json] [--only id,id] [--out file.md] [--restore]
 *
 * One `next dev` serves every mutation: a held Playwright run owns the web servers, and each
 * mutation's spec runs with `reuseExistingServer`. A mutation counts only once the dev server has
 * compiled it — every write carries a nonce comment, and the run waits until that nonce is in
 * `.next/dev` after requesting the mutation's `probe` path. Restores are proven the same way.
 *
 * Every original is journalled before its file is touched, and the journal is replayed on exit, on
 * SIGINT/SIGTERM/SIGHUP, and at the start of the next run (for SIGKILL). `--restore` only replays it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  applyEdits,
  classify,
  escapeRegExp,
  marked,
  parseManifest,
  renderTable,
  restoreAll,
  summarise,
  untrusted,
  type JournalEntry,
  type Mutation,
  type Result,
  type RunSummary,
} from "./lib.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CONFIG = "e2e/mutations/playwright.config.ts";
const WORK_DIR = path.join(ROOT, "e2e/mutations/.work");
const JOURNAL = path.join(WORK_DIR, "journal.json");
const DEV_OUTPUT = [path.join(ROOT, ".next/dev/server"), path.join(ROOT, ".next/dev/static")];
const BASE_URL = `http://localhost:${Number(process.env.E2E_PORT ?? 3987)}`;
const HOLD_READY = "Running 1 test";
const PICK_UP_TIMEOUT_MS = 120_000;
const HOLD_START_TIMEOUT_MS = 360_000;
const RUN_TIMEOUT_MS = 15 * 60_000;

const children = new Set<ChildProcess>();
let stopping = false;
let hold: ChildProcess | null = null;

const realFs = {
  read: (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8"),
  write: (file: string, content: string) => fs.writeFileSync(path.join(ROOT, file), content),
};

function readJournal(): JournalEntry[] {
  try {
    return JSON.parse(fs.readFileSync(JOURNAL, "utf8")) as JournalEntry[];
  } catch {
    return [];
  }
}

function writeJournal(entries: JournalEntry[]) {
  if (entries.length === 0) fs.rmSync(JOURNAL, { force: true });
  else fs.writeFileSync(JOURNAL, JSON.stringify(entries));
}

function replayJournal(reason: string, clear = true) {
  const { restored, leftAlone } = restoreAll(readJournal(), realFs);
  if (clear) writeJournal([]);
  if (restored.length) console.error(`[mutation-check] ${reason}: restored ${restored.join(", ")}`);
  for (const file of leftAlone) {
    console.error(`[mutation-check] ${reason}: left ${file} alone — it no longer carries the driver's marker, so it was edited since; its journal entry is dropped`);
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = Number.isFinite(ms) ? setTimeout(() => resolve(false), ms) : undefined;
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopChildren() {
  for (const child of children) killGroup(child, "SIGINT");
  for (const child of children) {
    if (!(await exited(child, 30_000))) killGroup(child, "SIGKILL");
  }
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.error(`\n[mutation-check] ${signal}: restoring and stopping`);
    replayJournal(signal, false);
    void stopChildren().finally(() => process.exit(code));
  });
}
process.on("exit", () => {
  replayJournal("exit");
  for (const child of children) killGroup(child, "SIGKILL");
});

function playwright(args: string[], env: Record<string, string>, log: string): ChildProcess {
  const out = fs.openSync(log, "w");
  const child = spawn("npx", ["playwright", "test", "--config", CONFIG, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", out, out],
  });
  fs.closeSync(out);
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startHold() {
  const log = path.join(WORK_DIR, "servers.log");
  hold = playwright([], { MUTATION_HOLD: "1" }, log);
  const deadline = Date.now() + HOLD_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (hold.exitCode !== null) throw new Error(`the web servers did not start; see ${log}`);
    if (fs.readFileSync(log, "utf8").includes(HOLD_READY)) return;
    await sleep(1_000);
  }
  throw new Error(`the web servers were not up after ${HOLD_START_TIMEOUT_MS / 1000}s; see ${log}`);
}

function compiledContains(nonce: string, since: number): boolean {
  for (const dir of DEV_OUTPUT) {
    if (!fs.existsSync(dir)) continue;
    for (const relative of fs.readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (!relative.endsWith(".js")) continue;
      const file = path.join(dir, relative);
      try {
        if (fs.statSync(file).mtimeMs < since) continue;
        if (fs.readFileSync(file, "utf8").includes(nonce)) return true;
      } catch {
        // replaced while being read; the next pass sees the new one
      }
    }
  }
  return false;
}

async function writeAndAwaitPickUp(file: string, content: string, label: string, probe: string): Promise<boolean> {
  const nonce = `mutation-check:${label}:${randomBytes(6).toString("hex")}`;
  const since = Date.now() - 1_000;
  if (stopping) throw new Error("stopping; no further writes");
  realFs.write(file, marked(content, nonce));
  const deadline = Date.now() + PICK_UP_TIMEOUT_MS;
  while (Date.now() < deadline && !stopping) {
    try {
      await fetch(`${BASE_URL}${probe}`, { redirect: "manual", signal: AbortSignal.timeout(PICK_UP_TIMEOUT_MS) });
    } catch {
      // a compile error answers badly or not at all; the scan below is what decides
    }
    if (compiledContains(nonce, since)) return true;
    await sleep(1_000);
  }
  return false;
}

async function runSpec(mutation: Mutation, label: string): Promise<RunSummary> {
  const json = path.join(WORK_DIR, `${label}.json`);
  fs.rmSync(json, { force: true });
  const child = playwright(
    [mutation.spec, "--grep", escapeRegExp(mutation.grep)],
    { MUTATION_JSON_OUTPUT: json },
    path.join(WORK_DIR, `${label}.log`)
  );
  if (!(await exited(child, RUN_TIMEOUT_MS))) {
    killGroup(child, "SIGINT");
    if (!(await exited(child, 30_000))) killGroup(child, "SIGKILL");
    return { passed: 0, failed: 0, skipped: 0, firstError: `no result within ${RUN_TIMEOUT_MS / 60_000} minutes` };
  }
  if (!fs.existsSync(json)) return { passed: 0, failed: 0, skipped: 0, firstError: "no report written" };
  return summarise(JSON.parse(fs.readFileSync(json, "utf8")));
}

function describe(summary: RunSummary): string {
  return summary.failed > 0 ? summary.firstError : `${summary.passed} passed`;
}

async function check(mutation: Mutation): Promise<Result> {
  const original = realFs.read(mutation.file);
  const mutated = applyEdits(original, mutation.edits);
  writeJournal([...readJournal(), { file: mutation.file, original }]);
  try {
    if (!(await writeAndAwaitPickUp(mutation.file, mutated, mutation.id, mutation.probe))) {
      return { mutation, outcome: "not-picked-up", detail: `nothing compiled after requesting ${mutation.probe}` };
    }
    const summary = await runSpec(mutation, mutation.id);
    return { mutation, outcome: classify(summary), detail: describe(summary) };
  } finally {
    const restoredCompiled = await writeAndAwaitPickUp(mutation.file, original, `restore-${mutation.id}`, mutation.probe);
    realFs.write(mutation.file, original);
    writeJournal(readJournal().filter((entry) => entry.file !== mutation.file));
    if (!restoredCompiled) throw new Error(`the dev server never compiled the restored ${mutation.file}; stopping`);
  }
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  replayJournal("left by an earlier run");
  if (process.argv.includes("--restore")) return;

  const manifestPath = path.join(ROOT, option("--manifest") ?? "e2e/mutations/manifest.json");
  const only = option("--only")?.split(",");
  const out = path.resolve(ROOT, option("--out") ?? path.join(WORK_DIR, "results.md"));
  const manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"));
  const unknown = only?.filter((id) => !manifest.some((m) => m.id === id)) ?? [];
  if (unknown.length) throw new Error(`--only names no mutation in the manifest: ${unknown.join(", ")}`);
  const mutations = manifest
    .filter((m) => !only || only.includes(m.id))
    .sort((a, b) => Number(b.control) - Number(a.control));
  for (const m of mutations) {
    if (!fs.existsSync(path.join(ROOT, m.spec))) throw new Error(`${m.id}: no spec at ${m.spec}`);
    applyEdits(realFs.read(m.file), m.edits);
  }

  await startHold();
  console.log(`[mutation-check] servers up at ${BASE_URL}; ${mutations.length} mutations`);

  const baselines = new Map<string, RunSummary>();
  const results: Result[] = [];
  for (const mutation of mutations) {
    const key = `${mutation.spec}\u0000${mutation.grep}`;
    if (!baselines.has(key)) {
      let baseline = await runSpec(mutation, `baseline-${mutation.id}`);
      if (classify(baseline) !== "survived") baseline = await runSpec(mutation, `baseline-retry-${mutation.id}`);
      baselines.set(key, baseline);
    }
    const baseline = baselines.get(key)!;
    const result: Result =
      classify(baseline) === "survived"
        ? await check(mutation)
        : { mutation, outcome: "baseline-red", detail: `unmutated: ${describe(baseline)}` };
    results.push(result);
    console.log(`[mutation-check] ${mutation.id}: ${result.outcome} — ${result.detail}`);
    if (mutation.control && result.outcome !== "caught") {
      console.error(`[mutation-check] the control ${mutation.id} was not caught; no other result can be trusted`);
      break;
    }
  }

  const table = renderTable(results);
  fs.writeFileSync(out, `${table}\n`);
  console.log(`\n${table}\n\nwritten to ${path.relative(ROOT, out)}`);
  const doubtful = untrusted(results);
  for (const r of doubtful) console.error(`[mutation-check] untrusted: ${r.mutation.id} (${r.outcome})`);
  process.exitCode = doubtful.length ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(`[mutation-check] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    replayJournal("finished");
    await stopChildren();
  });
