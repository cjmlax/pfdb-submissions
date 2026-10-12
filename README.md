# pfdb-submissions

A small self-hosted worker that lets visitors to **pfdatabase.com** submit
potential data (Chroma/Glass combinations, frog stats, mutation completions),
holds each submission for your review, and — once you approve it — pushes it
into Teable using a privileged token that **never leaves the server**.

```
website form ──POST /api/submit──▶  worker  ──store PENDING──▶  Postgres (+ screenshots in Garage)
                                       │
   you (admin role, /api/admin/) ──────┴── approve ──pushDown──▶  Teable
```

## Why it exists

A static site can't keep a secret, so it can't safely hold a Teable write token.
This worker is the thing that holds it. Visitors submit freely; nothing reaches
your live tables until you approve it.

## Design: adding new submission types

Everything generic (storage, auth, review UI, approve/reject, rate limiting) is
written once. Per-type knowledge lives in a single handler implementing
`SubmissionHandler` (`src/handlers/combo.ts` is the reference). To add weekly-set
submissions later:

1. Create `src/handlers/weeklySet.ts` with `schema`, `summarize`, `pushDown`.
2. Add it to the list in `src/handlers/registry.ts`.
3. Add a matching form on the website that POSTs `type: "weeklySet"`.

No other worker code changes.

## Deployment

The worker runs in the `pfdb-app` stack of the high-availability cluster
(`pfdb-infra`), on the active node only. It keeps no local state: the queue,
users, badges and alerts live in Postgres (reached through the node's HAProxy on
port 5000, which always points at the primary), and screenshots live in the
Garage bucket `pfdb-submissions`. After a failover the worker starts on the other
node with everything intact. The changelog and weekly-sets pollers need no
coordination, since only one worker runs at a time.

HAProxy routes `pfdatabase.com/api/*` to the worker on port 8090. Requests reach
it through cloudflared and HAProxy, so the visitor's address is taken from
`CF-Connecting-IP` (see `src/clientIp.ts`).

## Configuration

Copy `.env.example` to `.env` (deployed: `stacks/pfdb-app/worker.env`) and fill
it in. Key variables:

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string; tables are created on first start |
| `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Garage endpoint and the `worker-key` |
| `ZITADEL_SERVICE_TOKEN` | PAT of the `pfdb-worker` machine user, for account linking |
| `ZITADEL_IDP_DISCORD` / `_TWITCH` / `_GOOGLE` | Zitadel identity provider ids |
| `TEABLE_TOKEN` | Privileged Teable token (server-side only) |
| `TEABLE_BASE_ID` | Teable base; tables are resolved by name |
| `ALLOWED_ORIGIN` | Your website origin(s), for CORS |
| `IP_HASH_SECRET` | Salt for hashed submitter IPs (falls back to `COOKIE_SECRET`) |

## Run

### Local dev
```bash
npm install
cp .env.example .env      # point DATABASE_URL and S3_* at a local Postgres and S3
npm run dev               # http://localhost:8090
```

### Docker
The image is published to `ghcr.io/cjmlax/pfdb-submissions` on every `v*` tag.
Its compose service and env file live in `pfdb-infra` (`stacks/pfdb-app`).

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/submit` | public (rate-limited) | accept a submission |
| POST | `/api/submit/batch` | public (rate-limited) | accept many items of one type; per-item results |
| GET  | `/api/frog-stats/pending` | public | frog ids with a stats submission awaiting review |
| GET  | `/api/types` | public | list accepted submission types |
| GET  | `/api/me` | user | own profile, badges and linked platforms |
| POST | `/api/me/links/:provider` | user | start linking Discord / Twitch / Google |
| GET  | `/api/me/links/callback` | link cookie | finish linking; redirects to `/account` |
| DELETE | `/api/me/links/:provider` | user | unlink a provider (never the last one) |
| GET  | `/api/admin/pending` | admin | pending queue as JSON |
| POST | `/api/admin/:id/approve` | admin | push downstream |
| POST | `/api/admin/:id/reject` | admin | discard the submission |
| POST | `/api/admin/batch/:batchId/approve` | admin | push every pending item of a batch; per-item results |
| POST | `/api/admin/batch/:batchId/reject` | admin | discard every pending item of a batch |
| GET  | `/healthz` | public | health check |

## Reviewing without the web UI

```bash
npm run review            # interactive approve/reject in the terminal
npm run review -- --list  # just print the queue
# deployed, on the active node:
docker compose exec worker node dist/cli/review.js
```

## Auth (single bearer-token model, same-origin)

There is **no cookie/session login**. Everything authenticates with the
signed-in SPA user's **OIDC id_token** (Bearer), issued by the Zitadel app
`pfdb-web` (project `pfdb-site`) at `https://auth.pfdatabase.com`. The worker
verifies it (`userAuth.ts`) and gates each route:

- **Public** — `/api/types`, `/api/submit`, `/api/export*`, `/healthz` (open)
- **Signed-in user** — `requireUser` (e.g. `/api/me`)
- **Admin** — `requireUserAdmin`, which additionally requires the `admins` role
  (`/api/admin/*`: submission review, badges, alerts)
- **Mod** — `requireUserMod`, which requires the `mods` role (`/api/mod/*`)

Roles come from the `urn:zitadel:iam:org:project:roles` claim, an object keyed
by role name. The project needs **Assert roles on authentication** and the app
**User roles inside ID Token** turned on, or the claim is missing and every
admin call returns `403`.

## Account linking

People sign in only through external providers. Zitadel links a provider to an
existing account automatically when its verified email matches; for anything
else, the Account page runs Zitadel's intent flow through the worker
(`src/routes/links.ts`). The worker reads each user's links with the
`pfdb-worker` machine user (`src/zitadel.ts`) and stores the platform names, so
users can pick one as their public display name. A provider account that has
already signed in on its own is a separate PFDB account and can't be linked.

## Screenshots

Uploaded screenshots are stored in Garage and shown in the review UI so you can
verify a submission before approving. On approval the image is attached to the
Frog Pairs record (a pair carries one screenshot per mutation submitted).
