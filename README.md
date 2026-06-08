# pfdb-submissions

A small self-hosted worker that lets visitors to **pfdb.cjmlax.com** submit
potential data (Chroma/Glass combinations today; weekly sets and more later),
holds each submission for your review, and — once you approve it — pushes it
into Teable using a privileged token that **never leaves the server**.

```
website form ──POST /api/submit──▶  worker  ──store PENDING──▶  SQLite (/data)
                                       │
   you (Authentik-gated /api/admin/) ──┴── approve ──pushDown──▶  Teable
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

## Configuration

Copy `.env.example` to `.env` and fill it in. Key variables:

| Var | Purpose |
| --- | --- |
| `AUTH_MODE` | `forward` (Authentik via NPM, recommended), `oidc`, or `password` |
| `ADMIN_GROUP` | Authentik group required for admin access (your "role") |
| `TRUST_PROXY_SECRET` | Shared secret NPM injects so the worker only trusts proxied requests |
| `TEABLE_TOKEN` | Privileged Teable token (server-side only) |
| `CHROMA_TABLE_ID` / `GLASS_TABLE_ID` | Target tables for approved combos |
| `ALLOWED_ORIGIN` | Your website origin(s), for CORS on `/api/submit` |
| `COOKIE_SECRET` | Signs admin session cookies (password/oidc modes) |

## Run

### Local dev
```bash
npm install
cp .env.example .env      # set AUTH_MODE=password + ADMIN_PASSWORD for easy local testing
npm run dev               # http://localhost:8080
```

### Docker
```bash
docker compose up -d --build
```
The container exposes port 8080 only on the internal `nginx_proxy_network`; NPM
reaches it by container name. Data (SQLite + uploaded screenshots) persists in
the `pfdb-submissions-data` volume.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/submit` | public (rate-limited) | accept a submission |
| GET  | `/api/types` | public | list accepted submission types |
| GET  | `/api/admin/` | admin | web review page |
| GET  | `/api/admin/pending` | admin | pending queue as JSON |
| POST | `/api/admin/:id/approve` | admin | push downstream |
| POST | `/api/admin/:id/reject` | admin | reject with optional note |
| GET  | `/healthz` | public | health check |

## Reviewing without the web UI

```bash
npm run review            # interactive approve/reject in the terminal
npm run review -- --list  # just print the queue
# in Docker:
docker compose exec pfdb-submissions node dist/cli/review.js
```

## Auth (single bearer-token model, same-origin)

There is **no cookie/session login**. Everything authenticates with the
signed-in SPA user's **OIDC id_token** (Bearer), issued by the public `pfdb`
Authentik app. The worker verifies it (`userAuth.ts`) and gates each route:

- **Public** — `/api/types`, `/api/submit`, `/api/export*`, `/healthz` (open)
- **Signed-in user** — `requireUser` (e.g. `/api/me`)
- **Admin** — `requireUserAdmin`, which additionally requires the admin group
  (`/api/admin/*`: submission review, badges)

The API is served **same-origin** with the site at `pfdb.cjmlax.com/api/*`, so
there's no separate subdomain, no Authentik proxy outpost, no per-path whitelist,
and no CORS preflight.

**1. Authentik** — one **OAuth2 / OpenID Provider** (public, PKCE) for the SPA,
bound to an Application with slug `pfdb` (issuer
`https://authentik.cjmlax.com/application/o/pfdb/`). Create a group `pfdb-admins`
and add your admins. The SPA scope mapping emits `pfdb_groups` with the `pfdb-`
prefix stripped, so membership in `pfdb-admins` arrives as `admins`.

**2. Nginx Proxy Manager** — on the **website** host (`pfdb.cjmlax.com`), proxy
the API to the worker over the shared Docker network:

```nginx
location /api/ {
    proxy_pass http://pfdb-submissions:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**3. Worker** — set the `USER_OIDC_*` vars (all have defaults in `config.ts`):
- `USER_OIDC_ISSUER=https://authentik.cjmlax.com/application/o/pfdb/`
- `USER_OIDC_CLIENT_ID=<the public SPA client id>`
- `USER_OIDC_ADMIN_GROUP=admins` — must match a group you're in (the stripped
  form of `pfdb-admins`), or admin calls return `403`.

**Verify** (after deploying):

```bash
curl -i https://pfdb.cjmlax.com/api/types   # 200 — public endpoint, reaches the worker
```

Then sign in on the website and open **/admin/submissions** — the React review
queue. Admin actions send your id_token automatically.

## Screenshots

Uploaded screenshots are stored on the worker and shown in the review UI so you
can verify a combo before approving. Auto-attaching the image to the Teable
record on approval is a planned enhancement; for now the image lives in the
`/data/uploads` volume and the combo record is created without it.
