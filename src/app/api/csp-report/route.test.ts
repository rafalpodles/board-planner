import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST } from "./route";
import { MAX_REPORT_BYTES, REPORTS_PER_MINUTE, resetCspReportWindow } from "@/lib/csp-report";

function report(body: string, type = "application/csp-report", headers: Record<string, string> = {}) {
  return new Request("https://app.example.com/api/csp-report", {
    method: "POST",
    headers: { "content-type": type, ...headers },
    body,
  });
}

const LEGACY = JSON.stringify({
  "csp-report": {
    "document-uri": "https://app.example.com/projects/p1?ticket=secret#frag",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "blocked-uri": "inline",
    "source-file": "https://app.example.com/projects/p1",
    "line-number": 12,
    disposition: "enforce",
  },
});

const REPORTING_API = JSON.stringify([
  {
    type: "csp-violation",
    age: 3,
    url: "https://app.example.com/login",
    user_agent: "x",
    body: {
      documentURL: "https://app.example.com/login?next=%2Fsettings",
      effectiveDirective: "script-src-elem",
      blockedURL: "https://evil.example/x.js?k=v",
      disposition: "enforce",
      lineNumber: 4,
      sample: "",
    },
  },
  { type: "deprecation", body: { id: "x" } },
]);

let warn: ReturnType<typeof vi.spyOn>;

function logged(): Record<string, unknown>[] {
  return warn.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])));
}

beforeEach(() => {
  resetCspReportWindow();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("POST /api/csp-report", () => {
  it("logs a legacy report-uri body as one structured line, query string stripped", async () => {
    const res = await POST(report(LEGACY));
    expect(res.status).toBe(204);
    expect(logged()).toEqual([
      {
        event: "csp-violation",
        documentUrl: "https://app.example.com/projects/p1",
        directive: "script-src-elem",
        blockedUrl: "inline",
        sourceFile: "https://app.example.com/projects/p1",
        lineNumber: 12,
        disposition: "enforce",
        sample: null,
      },
    ]);
  });

  it("logs the csp-violation entries of a Reporting API batch and ignores the rest", async () => {
    const res = await POST(report(REPORTING_API, "application/reports+json"));
    expect(res.status).toBe(204);
    expect(logged()).toEqual([
      {
        event: "csp-violation",
        documentUrl: "https://app.example.com/login",
        directive: "script-src-elem",
        blockedUrl: "https://evil.example/x.js",
        sourceFile: null,
        lineNumber: 4,
        disposition: "enforce",
        sample: null,
      },
    ]);
  });

  it("refuses a body over the cap, whether or not it declares its length", async () => {
    const huge = JSON.stringify({ "csp-report": { "document-uri": "a".repeat(MAX_REPORT_BYTES) } });
    expect((await POST(report(huge))).status).toBe(413);
    const chunked = new Request("https://app.example.com/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(huge));
          c.close();
        },
      }),
      // @ts-expect-error undici needs this for a streamed body
      duplex: "half",
    });
    expect((await POST(chunked)).status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a content type no browser sends a report as", async () => {
    expect((await POST(report(LEGACY, "text/plain"))).status).toBe(415);
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers garbage without throwing and without logging it", async () => {
    const bodies = [
      "not json",
      "null",
      "42",
      '"str"',
      "[]",
      "[null, 1, {}]",
      '{"csp-report": null}',
      '{"csp-report": "x"}',
      '[{"type":"csp-violation","body":null}]',
      '[{"type":"csp-violation","body":{"documentURL":{"toString":1},"lineNumber":"9"}}]',
    ];
    for (const body of bodies) {
      const res = await POST(report(body, "application/reports+json"));
      expect([204, 400], body).toContain(res.status);
    }
    for (const line of logged()) {
      expect(line.documentUrl).toBeNull();
      expect(line.lineNumber).toBeNull();
    }
  });

  it("truncates every field an attacker controls", async () => {
    const long = JSON.stringify({
      "csp-report": { "document-uri": "x".repeat(5000), "script-sample": "y".repeat(5000) },
    });
    await POST(report(long));
    const [line] = logged();
    expect(String(line.documentUrl).length).toBeLessThanOrEqual(300);
    expect(String(line.sample).length).toBeLessThanOrEqual(300);
  });

  it("stops logging past its per-minute budget, and says how many it dropped", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < REPORTS_PER_MINUTE + 5; i++) {
        expect((await POST(report(LEGACY))).status).toBe(204);
      }
      expect(logged()).toHaveLength(REPORTS_PER_MINUTE);
      vi.advanceTimersByTime(60_000);
      await POST(report(LEGACY));
      expect(logged().slice(-2)).toEqual([
        { event: "csp-violation-dropped", count: 5 },
        expect.objectContaining({ event: "csp-violation" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
