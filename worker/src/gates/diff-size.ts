import { Gate } from "../types.js";

export function diffSizeGate(maxLines: number, maxFiles: number): Gate {
  return {
    name: "diff-size",
    async run({ diff }) {
      if (diff.changedLines > maxLines) {
        return { ok: false, reason: `diff is ${diff.changedLines} lines, limit is ${maxLines}` };
      }
      if (diff.changedFiles.length > maxFiles) {
        return {
          ok: false,
          reason: `diff touches ${diff.changedFiles.length} files, limit is ${maxFiles}`,
        };
      }
      return { ok: true, reason: "" };
    },
  };
}
