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

## Authentik + Nginx Proxy Manager (forward mode)

This is the recommended setup: NPM authenticates admins against Authentik and
forwards their identity to the worker, which checks the `ADMIN_GROUP`.

**1. Authentik — Provider, Application, Group**
- Create a group, e.g. `pfdb-admin`, and add yourself to it.
- Create a **Proxy Provider** (forward auth, single application):
  - External host: `https://pfdb-api.cjmlax.com`
  - Mode: *Forward auth (single application)*
- Create an **Application** bound to that provider.
- Make sure your outpost (embedded is fine) serves it.

**2. Authentik — exempt the public endpoints (important)**

Forward auth protects the *whole* host by default, which means it will also
intercept `POST /api/submit` and redirect it to login — the browser can't follow
that cross-origin redirect, so submissions fail with a `302`. Exempt the public
paths at the provider so they bypass auth entirely:

- Provider → **Edit** → **Advanced protocol settings** → **Unauthenticated Paths**
  (a.k.a. *Unauthenticated URLs*), one regex per line:

  ```
  ^/api/submit$
  ^/api/types$
  ^/healthz$
  ```

This is the reliable way to keep the public API open while still gating
`/api/admin/`. (Doing it purely via nginx `location` precedence in NPM is fragile
because NPM owns the generated `location /` block — prefer the setting above.)

**3. Nginx Proxy Manager**
- Add a Proxy Host for `pfdb-api.cjmlax.com` → `pfdb-submissions:8080` (on the
  shared `nginx_proxy_network` Docker network). Enable websockets + SSL.
- In the host's **Advanced** tab, paste the forward-auth snippet — use the
  up-to-date one **Authentik publishes for Nginx Proxy Manager** as the source of
  truth (it wires the `/outpost.goauthentik.io` location and the `auth_request`).
  The only worker-specific additions you need are forwarding the identity headers
  to the backend (and, optionally, the anti-spoofing secret):

  ```nginx
  proxy_set_header X-authentik-username $authentik_username;
  proxy_set_header X-authentik-groups   $authentik_groups;
  # Optional anti-spoofing secret (must equal TRUST_PROXY_SECRET):
  proxy_set_header X-Proxy-Secret "REPLACE_WITH_TRUST_PROXY_SECRET";
  ```

  > With the Unauthenticated Paths from step 2 in place, you do **not** also need a
  > separate `location ~ ^/(api/submit|...)` bypass — Authentik already lets those
  > through. If you ever stop using Unauthenticated Paths, add a bypass location
  > with `auth_request off;` for the public paths instead.

**4. Worker**
- `AUTH_MODE=forward`, `ADMIN_GROUP=pfdb-admin`, and (recommended)
  `TRUST_PROXY_SECRET` matching the value in the snippet above.

**Verify** (from the host, after deploying):

```bash
curl -i https://pfdb-api.cjmlax.com/healthz             # 200 {"ok":true,...}
curl -i -X POST https://pfdb-api.cjmlax.com/api/submit  # 400 (reached the worker) — NOT 302
```

A `302` on those means auth is still intercepting the public paths (revisit step 2).
Also confirm `ALLOWED_ORIGIN` matches your website origin, or the browser will
block reading the response even once the request gets through.

### Fallbacks
- `AUTH_MODE=oidc` — the worker runs the OIDC code flow itself (set the
  `OIDC_*` vars; redirect URI `https://pfdb-api.cjmlax.com/api/auth/callback`).
- `AUTH_MODE=password` — a single password login at `/api/auth/login`. Easiest
  for local testing; least preferred in production.

## Screenshots

Uploaded screenshots are stored on the worker and shown in the review UI so you
can verify a combo before approving. Auto-attaching the image to the Teable
record on approval is a planned enhancement; for now the image lives in the
`/data/uploads` volume and the combo record is created without it.
