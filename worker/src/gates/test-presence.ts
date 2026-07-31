import { Gate } from "../types.js";

const TEST_FILE = /\.(test|spec)\.[jt]sx?$/;
const NO_TEST_EXPECTED =
  /\.(md|mdx|txt|json|ya?ml|toml|lock|css|scss|svg|png|jpe?g|gif|webp|ico)$/i;

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
      if (diff.changedFiles.every((file) => NO_TEST_EXPECTED.test(file))) {
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
