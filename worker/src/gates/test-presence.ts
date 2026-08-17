import { Gate } from "../types.js";
import { isProtectedPath } from "./protected-paths.js";

const TEST_FILE = /\.(test|spec)\.[jt]sx?$/;
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
function exemptFromTests(file: string): boolean {
  if (!NO_TEST_EXPECTED.test(file)) return false;
  if (LOCKFILE.test(file)) return true;
  return !isProtectedPath(file);
}

function addsTestLines(patch: string): boolean {
  let inTestFile = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      inTestFile = TEST_FILE.test(line.slice(4));
      continue;
    }
    if (inTestFile && line.startsWith("+")) return true;
  }
  return false;
}

export function testPresenceGate(): Gate {
  return {
    name: "test-presence",
    async run({ diff }) {
      if (diff.changedFiles.length === 0) {
        return { ok: false, reason: "the branch has no committed changes" };
      }
      if (diff.changedFiles.every(exemptFromTests)) {
        return { ok: true, reason: "" };
      }

      const testFiles = diff.changedFiles.filter((file) => TEST_FILE.test(file));
      if (testFiles.length === 0) {
        return { ok: false, reason: "no test file was added or changed" };
      }
      if (!diff.truncated && !addsTestLines(diff.patch)) {
        return {
          ok: false,
          reason: `no test lines were added — ${testFiles.join(", ")} only lost lines`,
        };
      }
      return { ok: true, reason: "" };
    },
  };
}
