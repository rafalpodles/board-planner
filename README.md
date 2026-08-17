# Board Planner

A self-hosted project board — kanban, sprints, task detail, search — with an API and an MCP server
so coding agents can read and move the same work items you do.

## Run it

You need Docker. Nothing else — no Node, no MongoDB.

```bash
docker compose up -d --build
```

Open <http://localhost:3000>. The first account you create on the sign-in page becomes the instance
admin; every account after that is created from Settings → Users.

Stop it with `docker compose down`. The database lives in the `mongo-data` volume and survives that;
`docker compose down -v` deletes it.

### Options

Everything is optional. Put overrides in a `.env` file next to `docker-compose.yml`:

| Variable | Default | What it does |
| --- | --- | --- |
| `APP_PORT` | `3000` | Host port the app is published on |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:${APP_PORT}` | Public URL used in notification and webhook links |
| `MONGODB_URI` | `mongodb://mongo:27017/boardplanner` | Point the app at your own MongoDB instead of the bundled one |
| `COOKIE_ALLOW_INSECURE` | `1` (compose only) | Set to `1` to issue the session cookie without `Secure` and without the `__Host-` prefix, for an instance served over plain HTTP |
| `APP_ORIGIN` | `http://localhost:${APP_PORT}` | Comma-separated list of origins the app is served from, used to reject cross-site writes |
| `PUBLIC_ORIGIN` | `http://localhost:${APP_PORT}` (compose); otherwise `APP_ORIGIN` when it names exactly one origin | The one address this instance calls its own. Required for the MCP endpoint and PM OAuth |
| `TRUSTED_PROXY_HOPS` | `0` | How many proxies append to `X-Forwarded-For` in front of this app. At `0` the header is ignored and the login throttle counts every anonymous caller together |
| `OPENAI_API_KEY` | — | AI task generation |
| `OPENROUTER_API_KEY`, `PM_MODEL`, `PM_MAX_TOKENS`, `PM_DAILY_TURN_CAP`, `PM_SCHEDULER_TICK_MS` | — | PM agent |
| `ENCRYPTION_KEY` | — | 32 bytes (hex or base64) encrypting stored integration tokens at rest. Without it those tokens cannot be saved at all |
| `ENCRYPTION_KEYS_OLD` | — | Comma-separated retired encryption keys, kept so a rotation can still read what they wrote |
| `WEBHOOK_SIGNING_SECRET` | — | Signs outgoing webhook deliveries so a receiver can tell them from anyone else who learned the URL |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | — | Email notifications |

`COOKIE_ALLOW_INSECURE` and `APP_ORIGIN` are **runtime** values, read on every request. The compose
file turns `COOKIE_ALLOW_INSECURE` on because it publishes the app on `http://localhost`, where a
browser silently discards a `Secure` cookie and every request after login fails with a 401. **Remove
it once the instance is behind TLS** — the app's own default is the secure, `__Host-`-prefixed cookie,
and nothing but this variable turns that off.

`APP_ORIGIN` is **required whenever `COOKIE_ALLOW_INSECURE=1`**, and the app refuses to start
otherwise. Writes are rejected unless the browser proves the request came from the app's own origin,
and over plain HTTP at anything other than `localhost` the browser sends no `Sec-Fetch-Site` header,
so the only remaining proof is `Origin` matching this list. Set it to the URL users actually open —
`https://board.example.com`, or `http://192.168.1.10:3000` for a LAN self-host — with no trailing
path.

`TRUSTED_PROXY_HOPS` decides whether `X-Forwarded-For` means anything here. It is the only thing
the failed-login throttle can key on, and the header is a header: with nothing in front of the app,
a caller who varies it gets a fresh counter every request and the throttle never bites. So the
default is `0` — the header is not read at all, and anonymous callers share one bucket at a raised
threshold. **Behind a reverse proxy, set it to the number of proxies that append to that header**
(`1` for a single nginx or Caddy in front, `2` if there is a CDN in front of that).

Getting the number wrong has consequences in both directions, so it is worth being right. Set it
**too high** and the header is refused as not matching what you described — every caller then shares
the anonymous bucket, which is bounded but shared. Set it **too low** and the address counted is one
your proxy chain writes rather than the client's, so every request on earth may land in the same
bucket — and because that bucket looks to the app like a genuine address, it is metered at the
*tight* per-address ceilings rather than the raised anonymous ones. Too low is therefore the worse
mistake of the two: it throttles the whole world as though it were one caller.

`ENCRYPTION_KEY` encrypts the GitHub, GitLab, Coda and MCP credentials the app stores. Generate one
with `openssl rand -hex 32`. Without it those fields simply cannot be saved — the app answers the
save with an error rather than writing the token in cleartext, and says so at startup. A key that is
set but is not 32 bytes **stops the app from starting**: a fumbled variable is not the same as an
absent one and must not be treated as one.

To rotate: put the new key in `ENCRYPTION_KEY` and move the old one to `ENCRYPTION_KEYS_OLD`
(comma-separated, so several generations can coexist). Each stored value names the key that wrote it,
so old and new secrets are readable side by side; anything re-saved is written with the new key. Drop
a retired key from the list only once nothing still refers to it — the app names the missing key id
when it meets one it cannot read.

`NEXT_PUBLIC_APP_URL` is a **build-time** value: Next.js inlines `NEXT_PUBLIC_*` into the bundle, so
it is passed as a build argument and baked into the image. Changing it means rebuilding —
`docker compose up -d --build`. The image is therefore built per deployment, which is what the
compose file does; there is no runtime override.

`PUBLIC_ORIGIN` exists because the other two cannot answer "what is this instance's own address".
`APP_ORIGIN` is a list, and nothing says which entry is the public one — the compose default lists
`localhost`, and a deployment that also accepts a LAN origin has no reason to put the public one
first. `NEXT_PUBLIC_APP_URL` is baked into the image, so in the running container it is whatever the
*build machine* had, which is why it is not consulted at all: as a fallback it was always set and
always wrong, and it silently replaced the intended failure with a discovery document naming
`localhost`.

So **an instance reachable at anything other than the compose default must set `PUBLIC_ORIGIN`.**
The MCP endpoint, both `/.well-known` documents and the PM agent's OAuth `redirect_uri` are built
from it and answer **500** when it resolves to nothing — deliberately, because the value they used
to fall back to was a request header (BP-316). It must be an `http`/`https` URL; `board.example.com:8443`
is not one, however much it looks like it.

MongoDB is pinned to **4.4** and is not published on a host port — only the app container reaches it.
The aggregations deliberately avoid operators that only exist from 5.0, and pinning the version is
what keeps that true.

## Run it without Docker

Needs Node 22 and a MongoDB 4.4+ you provision yourself.

```bash
npm install
MONGODB_URI=mongodb://localhost:27017/boardplanner npm run build
MONGODB_URI=mongodb://localhost:27017/boardplanner npm start
```

`npm run dev` for the development server. Copy `.env.example` to `.env.local` for a place to keep
the variables above.

## MCP server

The HTTP endpoint at `/api/mcp` is part of the app and needs nothing extra — point an MCP client at
`<your-url>/api/mcp`. The package in `mcp-server/` is a separate stdio server for clients that
cannot speak HTTP; it builds on its own and is not part of the Docker image:

```bash
cd mcp-server && npm install && npm run build
```

## Development

```bash
npm test           # unit tests (vitest)
npm run test:e2e   # end-to-end tests (playwright)
npx tsc --noEmit   # types
```
