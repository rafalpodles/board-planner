import { Gate } from "../types.js";
import { GateCommands, NPM_GATES, usesOwnCommands } from "./gate-commands.js";
import { protectedPaths } from "./protected-paths.js";

const NPM_TEST_FILE = /\.(test|spec)\.[jt]sx?$/;
// Only on a project's own commands: on the npm gates a `foo_test.py` is a file `npm test` never runs
const OWN_COMMANDS_TEST_FILE = new RegExp(
  [
    NPM_TEST_FILE,
    /(^|\/)test_[^/]+\.py$/,
    /_test\.(py|go|rb|exs|dart|cc|cpp)$/,
    /_spec\.rb$/,
    /(^|\/)tests\/.+\.(py|rs)$/,
    /(^|\/)src\/test\/.+\.(java|kt|groovy|scala)$/,
    /(Test|Tests)\.(java|kt|cs|php|swift)$/,
    /[a-z0-9]IT\.(java|kt)$/,
  ]
    .map((pattern) => pattern.source)
    .join("|")
);
const NO_TEST_EXPECTED =
  /\.(md|mdx|txt|json|ya?ml|toml|lock|sum|css|scss|svg|png|jpe?g|gif|webp|ico)$/i;

// A lockfile records the versions a resolver picked; the declaration that decides what runs is the
// manifest beside it, which is not exempt. So a dependency bump still passes with no new test —
// deliberately, and asserted — even though protected-paths guards these files, because there it is
// the install step reading them that matters and here it is whether a human needs to have written a
// test. This is the one place the two lists are meant to disagree.
const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|poetry\.lock|Pipfile\.lock|Gemfile\.lock|Cargo\.lock|composer\.lock|go\.sum)$/i;

// Otherwise, nothing that decides what gets executed may be waved through untested — and "what
// decides that" is one list, owned by protected-paths. Sharing it rather than restating it here is
// the point: the two restatements drifted, and the extensions were generic enough to hide it. `.toml`
// sat in NO_TEST_EXPECTED above while the old exception list named only package.json and .github/,
// so a change touching nothing but pyproject.toml needed no test at all (BP-333).
//
// This gate cannot rely on protected-paths having refused first. Since BP-331 a gate sequence is
// composed per agent, so an agent may carry test-presence without it — each gate holds its own
// ground.
function exemptFromTests(file: string, commands: GateCommands): boolean {
  if (!NO_TEST_EXPECTED.test(file)) return false;
  if (LOCKFILE.test(file)) return true;
  return protectedPaths([file], commands).length === 0;
}

function addsTestLines(patch: string, testFile: RegExp): boolean {
  let inTestFile = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      inTestFile = testFile.test(line.slice(4));
      continue;
    }
    if (inTestFile && line.startsWith("+")) return true;
  }
  return false;
}

export function testPresenceGate(commands: GateCommands = NPM_GATES): Gate {
  const testFile = usesOwnCommands(commands) ? OWN_COMMANDS_TEST_FILE : NPM_TEST_FILE;
  return {
    name: "test-presence",
    async run({ diff }) {
      if (diff.changedFiles.length === 0) {
        return { ok: false, reason: "the branch has no committed changes" };
      }
      if (diff.changedFiles.every((file) => exemptFromTests(file, commands))) {
        return { ok: true, reason: "" };
      }

      const testFiles = diff.changedFiles.filter((file) => testFile.test(file));
      if (testFiles.length === 0) {
        return { ok: false, reason: "no test file was added or changed" };
      }
      if (!diff.truncated && !addsTestLines(diff.patch, testFile)) {
        return {
          ok: false,
          reason: `no test lines were added — ${testFiles.join(", ")} only lost lines`,
        };
      }
      return { ok: true, reason: "" };
    },
  };
}
