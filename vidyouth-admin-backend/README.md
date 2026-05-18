# vidyouth-admin-backend

Standalone **Admin Control Panel** API — separate service, sibling to
`vidyouth-login-backend`. Implements the PRD §10 (Admin Control Panel),
§7.6 (Super Admin) and §16.1 (RBAC) **foundation**.

## Why separate

- Independent deploy / scale / blast-radius from the auth API.
- Its own port (default **8090**); login API stays on 8080.
- Shares the **platform Postgres + Redis** (reads `users` / `sessions` /
  `audit_events`, owns `feature_flags`).
- Verifies the **same** access tokens the login API issues — public key
  only, never signs. Honours force-logout via the shared Redis session set.

## Layout

```
vidyouth-admin-backend/
  app/
    src/
      config/env.ts          # own env (PORT 8090, DB, Redis, JWT public)
      db/{pg,redis}.ts       # shared platform DB + Redis
      services/jwt.ts        # verify-only (RS256, login API's public key)
      services/audit.ts      # writes shared audit_events
      services/permissions.ts# RBAC matrix (PRD §16.1)
      middleware/auth.ts     # Bearer + session-active gate
      middleware/rbac.ts     # requirePermission / requireAdminPanel
      repositories/feature-flags.ts
      routes/{health,admin}.ts
      server.ts
    tests/                   # node:test + tsx, app.inject()
  database/migrations/001_feature_flags.sql
```

## Endpoints (all gated: valid session → superadmin only)

- `GET  /livez` · `GET /healthz`
- `GET  /admin/me` — identity + resolved permissions
- `GET  /admin/dashboard/stats` — PRD §10.1 widgets
- `GET  /admin/audit` — PRD §7.6 audit log
- `GET  /admin/feature-flags` · `PATCH /admin/feature-flags/:key` — §10.2

## Run locally

```bash
cd app
npm install
# app/.env must provide: DATABASE_URL, REDIS_URL, JWT_PUBLIC_KEY,
# JWT_ISSUER, JWT_AUDIENCE  (point at the same Postgres/Redis the login
# API uses; JWT_PUBLIC_KEY = the login API's public key)
npm run dev          # http://localhost:8090
```

Apply the migration once against the shared DB **after** the login API's
migrations (it FKs `users.id`):

```
psql "$DATABASE_URL" -f ../database/migrations/001_feature_flags.sql
```

## Test

```bash
npm test   # node:test; mints a real RS256 superadmin session in the
           # shared DB+Redis (needs JWT_PRIVATE_KEY in app/.env for the
           # suite only — the service itself never signs)
```

## Next: the complete admin view

Foundation = auth + RBAC + dashboard stats + feature toggles + audit.
The full panel attaches to the same `requireAdminPanel` gate:
content CMS (§8.2), pricing/subscriptions, payments/refunds, org
approval workflow (§7.6), certification config, vendor management,
notification templates (§10.3), analytics (§17.3).
