/**
 * Measures which e2e groups call each route file directly, from the request logs a CI run's e2e
 * jobs uploaded (BP-1081; the method is in e2e/route-groups.ts).
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/route-groups.ts check <dir>
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/route-groups.ts write <dir>
 *
 * `<dir>` holds one directory per job, as `gh run download <run> -p 'request-log-*' -D <dir>` and
 * the `route_groups` CI job leave it. `check` fails when a spec calls a route from a group that a
 * change to that route would not run, which is what a pull request is held to. `write` replaces
 * e2e/route-groups.json with what the run measured, for a run of every group.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GROUP_NAMES } from "../e2e/groups.ts";
import { computeAffectedGroups } from "../e2e/affected-groups.ts";
import {
  groupsOf,
  measureCallers,
  routeResolver,
  unplannedCallers,
  type Caller,
  type LoggedRequest,
  type TestWindow,
} from "../e2e/route-groups.ts";

const ROOT = join(import.meta.dirname, "..");
const MAP = join(ROOT, "e2e", "route-groups.json");

function routeFiles(): string[] {
  return (readdirSync(join(ROOT, "src", "app"), { recursive: true }) as string[])
    .filter((file) => /(^|\/)route\.[jt]s$/.test(file))
    .map((file) => `src/app/${file}`)
    .sort();
}

function ndjson<T>(dir: string, prefix: string): T[] {
  return readdirSync(dir)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".ndjson"))
    .flatMap((file) =>
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    );
}

function jobDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const own = readdirSync(dir).some((file) => file.endsWith(".ndjson")) ? [dir] : [];
  const nested = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory());
  return [...own, ...nested];
}

function measure(dir: string): Map<string, Caller[]> {
  const routeFor = routeResolver(routeFiles());
  const all = new Map<string, Caller[]>();
  for (const job of jobDirs(dir)) {
    const callers = measureCallers(ndjson<LoggedRequest>(job, "requests-"), ndjson<TestWindow>(job, "tests-"), routeFor);
    for (const [file, found] of callers) {
      const known = all.get(file) ?? [];
      for (const caller of found) {
        if (!known.some((c) => c.group === caller.group && c.spec === caller.spec)) known.push(caller);
      }
      all.set(file, known);
    }
    console.log(`${relative(ROOT, job) || job}: ${callers.size} route files called directly`);
  }
  return all;
}

const [command, dir] = process.argv.slice(2);
if (!dir || (command !== "check" && command !== "write")) {
  console.error("usage: scripts/route-groups.ts check|write <dir>");
  process.exit(2);
}

const callers = measure(dir);

if (command === "write") {
  writeFileSync(MAP, `${JSON.stringify(groupsOf(callers, GROUP_NAMES), null, 2)}\n`);
  console.log(`wrote ${relative(ROOT, MAP)}: ${callers.size} route files`);
  process.exit(0);
}

const missing = unplannedCallers(callers, (file) => computeAffectedGroups([file]));
if (missing.length === 0) {
  console.log(`every direct caller of ${callers.size} route files is in its plan`);
  process.exit(0);
}

for (const { file, group, specs } of missing) {
  console.log(`::error file=${file}::${specs.join(", ")} (${group}) calls this route, and a change to it would not run ${group}`);
}
console.log(
  `\n${missing.length} route file × group pairs are missing from the plan. Add each group to the file's entry in` +
    " e2e/route-groups.json, or regenerate the whole map from a run of every group with `write`."
);
process.exit(1);
