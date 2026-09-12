import { readBody, serve } from "./stub-guard.mjs";

/**
 * A stand-in for GitHub's REST API, so the pull-request sync runs end to end without a network
 * call, a token or a rate limit. `GITHUB_API_BASE_URL` points `src/lib/github.ts` here, and
 * everything downstream of the answer — the key matcher, the check reduction, the pipeline that
 * replaces one provider's links, the badge — is the production path.
 *
 * Until BP-443 this could not be done at all: `api.github.com` was written into the URL, so
 * `e2e/seed.ts` planted the results of a sync by hand and no browser test ever drove one.
 *
 * What the stub serves is set by the spec, through `POST /control` with `{ pulls, checks }`:
 *
 *   pulls  — the array `GET /repos/:owner/:repo/pulls` answers, in GitHub's own shape
 *   checks — `{ [sha]: { check_runs: [...], status: {...} } }`, what each commit's checks say
 *
 * `GET /asked` returns every path the app has requested since the last reset, which is how a spec
 * asserts what was *not* asked about — the rate-limit rule, and the one about finished work.
 */

// Loopback only. This serves a project's pull requests and takes a bearer token; on a machine
// several agents share there is no reason for either to leave it.
const LOOPBACK = "127.0.0.1";

const PORT = Number(process.env.GITHUB_STUB_PORT ?? 3995);

let pulls = [];
let checks = {};
let asked = [];

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** No contexts and no runs: what GitHub answers about a commit nothing has posted about. */
const NOTHING_RAN = { check_runs: [], status: { state: "pending", statuses: [] } };

serve({
  name: "github stub",
  port: PORT,
  host: LOOPBACK,
  handler: async (req, res) => {
    const { pathname, searchParams } = new URL(req.url ?? "/", "http://localhost");

    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }

    if (pathname === "/control") {
      const body = JSON.parse((await readBody(req)) || "{}");
      pulls = body.pulls ?? [];
      checks = body.checks ?? {};
      asked = [];
      json(res, { ok: true });
      return;
    }

    if (pathname === "/asked") {
      json(res, asked);
      return;
    }

    if (pathname === "/reset") {
      pulls = [];
      checks = {};
      asked = [];
      json(res, { ok: true });
      return;
    }

    asked.push(pathname);

    // GET /repos/:owner/:repo/pulls — answered for either state, because the app asks twice and
    // filters by what it got rather than by which request it came from
    const listing = /^\/repos\/[^/]+\/[^/]+\/pulls$/.exec(pathname);
    if (listing) {
      const state = searchParams.get("state") ?? "open";
      json(
        res,
        pulls.filter((pull) => (state === "open" ? pull.state === "open" : pull.state !== "open"))
      );
      return;
    }

    const commit = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/(check-runs|status)$/.exec(pathname);
    if (commit) {
      const [, sha, what] = commit;
      const answer = checks[sha] ?? NOTHING_RAN;
      // A spec asks for this to drive the badge's `unknown`, which is the one state GitHub never
      // reports and the app invents when it could not read the checks
      if (answer === "refuse") {
        json(res, { message: "Bad credentials" }, 401);
        return;
      }
      json(
        res,
        what === "check-runs"
          ? { check_runs: answer.check_runs ?? [] }
          : (answer.status ?? NOTHING_RAN.status)
      );
      return;
    }

    json(res, { message: `github stub has no route for ${pathname}` }, 404);
  },
});
