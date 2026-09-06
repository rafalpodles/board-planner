import { Gate } from "../types.js";
import { isProtectedPath } from "./protected-paths.js";

const TEST_FILE = /\.(test|spec)\.[jt]sx?$/;
const NO_TEST_EXPECTED =
  /\.(md|mdx|txt|json|ya?ml|toml|lock|sum|css|scss|svg|png|jpe?g|gif|webp|ico)$/i;

const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|poetry\.lock|Pipfile\.lock|Gemfile\.lock|Cargo\.lock|composer\.lock|go\.sum)$/i;

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
