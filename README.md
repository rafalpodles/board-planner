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
| `OPENAI_API_KEY` | — | AI task generation |
| `OPENROUTER_API_KEY`, `PM_MODEL`, `PM_MAX_TOKENS`, `PM_DAILY_TURN_CAP`, `PM_SCHEDULER_TICK_MS` | — | PM agent |
| `ENCRYPTION_KEY` | — | 32 bytes (hex or base64) encrypting stored GitHub/GitLab tokens at rest |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | — | Email notifications |

`NEXT_PUBLIC_APP_URL` is a **build-time** value: Next.js inlines `NEXT_PUBLIC_*` into the bundle, so
it is passed as a build argument and baked into the image. Changing it means rebuilding —
`docker compose up -d --build`. The image is therefore built per deployment, which is what the
compose file does; there is no runtime override.

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
