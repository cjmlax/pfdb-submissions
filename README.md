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

## Authentik + Nginx Proxy Manager (oidc mode, same-origin)

The worker authenticates admins itself via Authentik (the OIDC code flow) and is
served **same-origin** with the website at `pfdb.cjmlax.com/api/*` — no separate
API subdomain, no Authentik proxy outpost, and no per-path auth whitelist. Each
route enforces its own access: `requireAdmin` for the admin panel, `requireUser`
for signed-in website users, and open for public endpoints.

**1. Authentik — Provider, Application, Group**
- Create a group, e.g. `pfdb-admins`, and add yourself to it.
- Create an **OAuth2 / OpenID Provider**:
  - Client type: **Confidential** (the worker holds the secret)
  - Redirect URI: `https://pfdb.cjmlax.com/api/auth/callback`
  - Signing key: your default certificate
- Create an **Application** bound to it with slug `pfdb-submissions` — the issuer
  becomes `https://authentik.cjmlax.com/application/o/pfdb-submissions/`.

**2. Nginx Proxy Manager**
- On the **website** host (`pfdb.cjmlax.com`), proxy the API to the worker over
  the shared Docker network — no forward-auth, no outpost:

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

  Because the API is same-origin with the site, the browser never issues a CORS
  preflight for `/api/*`.

**3. Worker**
- `AUTH_MODE=oidc` with the `OIDC_*` vars from `.env.example`:
  - `OIDC_ISSUER=https://authentik.cjmlax.com/application/o/pfdb-submissions/`
  - `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` from the provider
  - `OIDC_REDIRECT_URI=https://pfdb.cjmlax.com/api/auth/callback`
  - `OIDC_SCOPE=openid profile` (group names arrive in the `profile` claim)
- `ADMIN_GROUP=pfdb-admins` — must match a group you're in, or the login succeeds
  but the admin area is denied with `403`.

**Verify** (after deploying):

```bash
curl -i https://pfdb.cjmlax.com/api/types   # 200 — public endpoint, reaches the worker
```

Then open `https://pfdb.cjmlax.com/api/admin/` in a browser: it should redirect
you through Authentik and back, then render the admin panel (once you're in
`ADMIN_GROUP`).

### Signed-in website users
The public SPA uses its **own** Authentik OAuth2 application — a *public* PKCE
client — and sends its id_token as a Bearer token to user endpoints like
`/api/me`, which the worker verifies in `userAuth.ts`. That's independent of the
admin provider above and needs no proxy configuration.

### Other auth modes
- `AUTH_MODE=forward` — trust identity headers from an Authentik proxy outpost
  (the previous setup; needs the outpost plus a per-path whitelist).
- `AUTH_MODE=password` — a single password login at `/api/auth/login`. Easiest
  for local testing; least preferred in production.

## Screenshots

Uploaded screenshots are stored on the worker and shown in the review UI so you
can verify a combo before approving. Auto-attaching the image to the Teable
record on approval is a planned enhancement; for now the image lives in the
`/data/uploads` volume and the combo record is created without it.
