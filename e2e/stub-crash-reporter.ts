import type { FullResult, Reporter } from "@playwright/test/reporter";
import { CRASH_MARKER } from "./stub-guard.mjs";

/**
 * BP-581. A stub that throws answers 500, prints `STUB CRASH` and keeps serving (BP-575). Usually
 * the 500 is enough: the spec that made the bad request fails on its own request. It is not enough
 * where the delivery is fire-and-forget — `webhook-receiver.mjs` is dispatched without an await,
 * so a crash there arrives as a *missing row* and the spec fails with "no delivery arrived",
 * naming the symptom rather than the cause.
 *
 * So the line is read rather than left for whoever scrolls back. The deliberate crash in
 * `stub-survives-a-throw.spec.ts` carries its own marker (`EXPECTED_CRASH_MARKER`) and never
 * reaches here.
 *
 * Two limits, both measured rather than assumed. A crash reported more than ~100ms after the last
 * test's request never arrives at all — the web servers are torn down first — so a fire-and-forget
 * failure caused by the *last* spec of a group is invisible here exactly as it was in the log.
 * And `--reporter=line` on the command line replaces this reporter rather than adding to it; CI
 * passes no `--reporter`, which is what keeps the check on.
 */
// A crash can repeat: `stub-guard`'s own docblock records a measured storm of 25,852 reports in
// under a second, and holding every line of that in the runner is no better than dropping them.
const MOST_TO_SHOW = 20;

export default class StubCrashReporter implements Reporter {
  private readonly crashes: string[] = [];
  private count = 0;
  // One buffer per stream: stdout and stderr interleave, and a line without its newline yet would
  // otherwise be glued to whatever the other stream said next.
  private pendingOut = "";
  private pendingErr = "";
  printsToStdio() {
    return true;
  }

  /**
   * A crash spans several lines and arrives in chunks that split anywhere, so the marker's own
   * line is reassembled rather than searched for inside whatever a chunk happened to contain.
   */
  private scan(pending: string, chunk: string | Buffer): string {
    const lines = (pending + chunk.toString()).split("\n");
    const tail = lines.pop() ?? "";
    for (const line of lines) this.record(line);
    return tail;
  }

  private record(line: string) {
    if (!line.includes(CRASH_MARKER)) return;
    this.count++;
    if (this.crashes.length < MOST_TO_SHOW) this.crashes.push(line.trim());
  }

  onStdOut(chunk: string | Buffer) {
    this.pendingOut = this.scan(this.pendingOut, chunk);
  }

  onStdErr(chunk: string | Buffer) {
    this.pendingErr = this.scan(this.pendingErr, chunk);
  }

  async onEnd(result: FullResult) {
    // The tails, in case a last line never got its newline
    this.record(this.pendingOut);
    this.record(this.pendingErr);
    if (this.count === 0) return;

    const lines = [
      "",
      `Failing this run: ${this.count} stub crash${this.count === 1 ? "" : "es"}.`,
      ...this.crashes.map((crash) => `  ${crash}`),
      ...(this.count > this.crashes.length ? [`  …and ${this.count - this.crashes.length} more`] : []),
      "",
      "A stub that throws answers 500 and keeps serving, so a crash on a fire-and-forget path",
      "(the webhook receiver) would otherwise only show up as something that never arrived.",
      "",
    ];
    process.stdout.write(lines.join("\n"));

    // Not `result.status = …`: a reporter that mutates the object is relying on Playwright reading
    // it back, and the documented channel is the return value.
    return { status: result.status === "passed" ? ("failed" as const) : result.status };
  }
}
