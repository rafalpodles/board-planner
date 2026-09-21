import { readBody, serve } from "./stub-guard.mjs";

/**
 * A stand-in for GitLab's REST API (v4), so a task's GitLab activity and the merge-request sync run
 * end to end. Like Coda, the host is a per-project field (`gitlabHost`), so a spec points a
 * project at this stub rather than the app being told about it.
 *
 * `POST /control` sets what it serves, in GitLab's own shapes:
 *
 *   project       — the one `group/project` path this stub is GitLab for; any other is a 404
 *   token         — the PRIVATE-TOKEN it accepts; a missing or different one is a 401
 *   mergeRequests — what `/merge_requests` answers
 *   branches      — what `/repository/branches` answers
 *   commits       — what `/search?scope=commits` searches for the `search` parameter, by
 *                   substring of the message as GitLab does, so `GL-3` also finds `GL-30`
 *   fail          — any of "mergeRequests", "branches", "commits": that endpoint answers 500
 *
 * `GET /asked` returns `{ path, search, token }` for every API request since the last reset.
 */

const LOOPBACK = "127.0.0.1";
const PORT = Number(process.env.GITLAB_STUB_PORT ?? 3999);

const DEFAULTS = { project: "e2e-group/e2e-project", token: "glpat-e2e" };

let fixture = { ...DEFAULTS, mergeRequests: [], branches: [], commits: [], fail: [] };
let asked = [];

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function reset(body = {}) {
  fixture = {
    project: body.project ?? DEFAULTS.project,
    token: body.token ?? DEFAULTS.token,
    mergeRequests: body.mergeRequests ?? [],
    branches: body.branches ?? [],
    commits: body.commits ?? [],
    fail: body.fail ?? [],
  };
  asked = [];
}

serve({
  name: "gitlab stub",
  port: PORT,
  host: LOOPBACK,
  handler: async (req, res) => {
    const { pathname, searchParams } = new URL(req.url ?? "/", `http://${LOOPBACK}`);

    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }

    if (req.method === "POST" && (pathname === "/control" || pathname === "/reset")) {
      reset(pathname === "/control" ? JSON.parse((await readBody(req)) || "{}") : {});
      json(res, { ok: true });
      return;
    }

    if (pathname === "/asked") {
      json(res, asked);
      return;
    }

    const token = req.headers["private-token"] ?? null;
    asked.push({ path: pathname, search: searchParams.get("search"), token });

    const route = /^\/api\/v4\/projects\/([^/]+)\/(merge_requests|repository\/branches|search)$/.exec(
      pathname
    );
    if (req.method !== "GET" || !route) {
      json(res, { message: `gitlab stub has no route for ${req.method} ${pathname}` }, 404);
      return;
    }

    if (token !== fixture.token) {
      json(res, { message: "401 Unauthorized" }, 401);
      return;
    }

    if (decodeURIComponent(route[1]) !== fixture.project) {
      json(res, { message: "404 Project Not Found" }, 404);
      return;
    }

    const endpoint = {
      merge_requests: "mergeRequests",
      "repository/branches": "branches",
      search: "commits",
    }[route[2]];

    if (endpoint === "commits" && searchParams.get("scope") !== "commits") {
      json(res, { message: "scope does not have a valid value" }, 400);
      return;
    }

    if (fixture.fail.includes(endpoint)) {
      json(res, { message: "500 Internal Server Error" }, 500);
      return;
    }

    if (endpoint === "commits") {
      const search = (searchParams.get("search") ?? "").toLowerCase();
      json(
        res,
        fixture.commits.filter(
          (c) => search && (c.message ?? c.title).toLowerCase().includes(search)
        )
      );
      return;
    }

    json(res, fixture[endpoint]);
  },
});
