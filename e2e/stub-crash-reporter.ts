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
 */
export default class StubCrashReporter implements Reporter {
  private readonly crashes: string[] = [];
  // A crash spans several lines and arrives in chunks that split anywhere, so the marker's own
  // line is reassembled rather than searched for inside whatever a chunk happened to contain.
  private pending = "";

  printsToStdio() {
    return true;
  }

  private scan(chunk: string | Buffer) {
    this.pending += chunk.toString();
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.includes(CRASH_MARKER)) this.crashes.push(line.trim());
    }
  }

  onStdOut(chunk: string | Buffer) {
    this.scan(chunk);
  }

  onStdErr(chunk: string | Buffer) {
    this.scan(chunk);
  }

  async onEnd(result: FullResult) {
    // The tail, in case the last line never got its newline
    if (this.pending.includes(CRASH_MARKER)) this.crashes.push(this.pending.trim());
    if (this.crashes.length === 0) return;

    const lines = [
      "",
      `${this.crashes.length} stub crash${this.crashes.length === 1 ? "" : "es"} during this run:`,
      ...this.crashes.map((crash) => `  ${crash}`),
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
