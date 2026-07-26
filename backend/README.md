# Backend

The backend owns the API, authentication, integrations, persistence, and server-side business logic. Web and mobile clients rely on the shared data contract in `packages/contracts`.

## Stack

- Bun
- Hono
- Prisma 7
- PostgreSQL
- Zod
- jose JWT
- TypeScript

## Commands

Run these from the repository root:

```bash
docker compose version
docker info
cp backend/.env.example backend/.env
docker compose --env-file backend/.env pull postgres
docker compose --env-file backend/.env up -d postgres
bun run --cwd backend dev
bun run --cwd backend typecheck
bun run --cwd backend test
bun run --cwd backend test:unit
bun run --cwd backend test:integration
bun run --cwd backend start:api
bun run --cwd backend start:worker
bun run --cwd backend start:cron -- noop
bun run --cwd backend smoke:docker
bun run --cwd backend prisma:validate
bun run --cwd backend prisma:generate
bun run --cwd backend prisma:migrate
bun run --cwd backend prisma:deploy
bun run --cwd backend prisma:seed
bun run --cwd backend db:deploy
```

On Windows PowerShell, use `Copy-Item backend/.env.example backend/.env` instead of `cp`. Workspace aliases are also available from the repository root: `bun run dev:backend`, `bun run build:backend`, `bun run typecheck:backend`, and `bun run test:backend`.

`bun run test:integration` starts `postgres_test` from `../docker-compose.yml`, applies Prisma migrations to `teraso_crm_test`, and runs DB-backed auth API tests. If Docker is managed separately, set `TEST_SKIP_DOCKER=1` and `TEST_DATABASE_URL`. The test database name must end with `_test` unless `TEST_ALLOW_NON_TEST_DATABASE=1` is set intentionally.

`bun run smoke:docker` builds the backend Docker image, starts it against `postgres_test`, waits for `/health/ready`, and removes only the smoke container it created.

## Env

Copy `backend/.env.example` to `backend/.env` for local development and pass it to manual Compose commands with `docker compose --env-file backend/.env ...`. The example `DATABASE_URL` matches the Docker Compose `postgres` service documented in [../docs/LOCAL_DATABASE.md](../docs/LOCAL_DATABASE.md): database `teraso_crm`, user `superuser`, password `superpassword`, host port `54329`.

The example `TEST_DATABASE_URL` matches the Docker Compose `postgres_test` service: database `teraso_crm_test`, user `superuser`, password `superpassword`, manual host port `54330`. Automated runners may replace the port with a repository-derived value so parallel checkouts do not collide.

Keep an explicit username and password in Prisma connection URLs even on local native PostgreSQL installs. Peer-auth style URLs without a user can make Prisma schema-engine commands such as `migrate dev`, `migrate deploy`, and `db push` fail with an unhelpful generic engine error.

`JWT_SECRET` must be at least 32 characters locally. Production accepts the 64-or-more-character hexadecimal output of `openssl rand -hex 32`; do not use the `.env.example` placeholder, repeated characters, or human phrases.

`ADMIN_SEED_EMAIL` defaults to `admin@example.com` for local seeding.
`ADMIN_SEED_PASSWORD` is optional locally: without it, `bun run prisma:seed`
creates a new locked account with `passwordHash = null`; promoting an existing
account preserves its current password credential. With a password, the seed
hashes it with Argon2id and creates or unlocks the account. The seed is
idempotent and an empty password never erases an
existing hash; reusing the already configured password also preserves the hash
and active sessions. Production uses `bun run db:deploy`: it applies migrations,
optionally bootstraps the first administrator from a paired email/password, then
fails unless at least one administrator has a password credential.
Production bootstrap also rejects blank, known-placeholder, and repeated-pattern
passwords in addition to enforcing the 12–128 character limit.

`COOKIE_SECURE=false` is appropriate for local HTTP; production requires `COOKIE_SECURE=true` with exact HTTPS origins in `CORS_ORIGINS`. Production browser auth uses `SameSite=None; Secure` refresh cookies, so wildcard, empty, HTTP, or path-bearing CORS origins are invalid. Every cookie-backed auth write (`register`, `login`, `refresh`, and `logout`) also requires a trusted `Origin` in production cookie mode.

`WEBAPP_ORIGIN` is the public browser-app origin used to compose transactional links such as password reset. It defaults to the first `CORS_ORIGINS` entry. Email delivery is provider-neutral: `createApp` accepts an `EmailDelivery` adapter, while the committed runtime uses a disabled adapter until a project wires its chosen provider. With delivery disabled, password-reset requests still return the same generic accepted response and do not create tokens.

Auth and authenticated account-management writes are protected by `AUTH_BODY_LIMIT_BYTES` and a bounded in-process fixed-window limiter. `TRUST_PROXY=false` uses the direct Bun connection address. Behind a trusted proxy, set `TRUST_PROXY=true` together with the provider's authoritative `TRUSTED_PROXY_CLIENT_IP_HEADER`; use `TRUSTED_PROXY_CLIENT_IP_POSITION=last` only when the provider appends the client to a comma-separated chain. DigitalOcean App Platform uses `do-connecting-ip`, while the documented Yandex Serverless Containers path uses the last `X-Forwarded-For` value. The default App Platform shape is one API instance. Before horizontally scaling, move rate-limit state to a shared trusted store or edge/WAF layer.

`REFRESH_TOKEN_TTL_DAYS` is the sliding credential lifetime, while `SESSION_ABSOLUTE_TTL_DAYS` limits the total logical session lifetime. `REFRESH_REUSE_GRACE_SECONDS` tolerates a short concurrent refresh race; replaying the immediately previous credential after that window revokes the logical session. Keep the grace window short (the default is 10 seconds). Run `auth:sessions:cleanup` on a schedule to delete revoked, sliding-expired, and absolute-expired session rows after `SESSION_RETENTION_DAYS` and remove expired password-reset tokens.

Browser push env is optional and is validated as one group. Generate a pair once with `cd backend && bunx web-push generate-vapid-keys`, then set `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, and `VAPID_PRIVATE_KEY` together; a partial or malformed group fails at boot rather than at the first send. All three are server-only. The public key is served exclusively by the authenticated `GET /api/notifications/vapid-public-key`, and the private key never leaves the delivery adapter. Leaving the group blank is supported: the CRM still writes every notification and serves the in-app centre, which is the source of truth when a browser refuses push, and each send is recorded as `SKIPPED`.

Run `crm:notifications:dispatch` on a schedule to announce due tasks, tasks still unfinished past their escalation delay, and leads that spent their next-step window without a task. It writes only notification rows — never a deal, task, or activity — and every record is keyed on the instant its condition began, so repeated and overlapping runs collapse against the `[recipient_user_id, event_key]` unique index. Run it as often as the scheduler allows; note that DigitalOcean App Platform scheduled jobs support a minimum cadence of 15 minutes, so a per-minute cadence needs a scheduler that permits it. Each run looks back 24 hours, so a backlog after an outage is still delivered while older history is left to the critical-tasks list.

DigitalOcean Spaces env is optional. Leave `SPACES_*` blank until the product needs uploads, media, exports, or downloads. When storage is active, configure the complete Spaces group in `backend/.env` and follow [../docs/STORAGE.md](../docs/STORAGE.md).

## Runtime Entrypoints

The backend is one workspace with one Prisma schema and one Dockerfile, but it has separate runtime entrypoints:

- API: `bun run start:api`, backed by `src/index.ts`.
- Worker: `bun run start:worker`, backed by `src/worker.ts`. It is intentionally empty until a real long-running background handler is added, and deployment generation refuses to deploy this placeholder command as an App Platform worker.
- Cron: `bun run start:cron -- <task>`, backed by `src/cron.ts`. Available tasks are `noop`, `db:ping`, `auth:sessions:cleanup`, and `crm:notifications:dispatch`.

All entrypoints use `src/runtime.ts` for env loading, Prisma creation, and cleanup, so backend services can be shared without duplicating Prisma schema or database setup.

Primary keys use database-generated UUIDv7 values in PostgreSQL (`@default(dbgenerated("uuidv7()")) @db.Uuid`). Use UUIDv7 consistently for new primary keys and foreign-key references that point at them; do not introduce new `cuid()`, `uuid()`, `serial`, or `bigserial` IDs into this template. PostgreSQL 18+ is required anywhere the backend schema is applied so IDs are generated consistently through Prisma, raw SQL, imports, and future non-Prisma writers.

## Deployment

Production deployment for the backend uses DigitalOcean App Platform with DigitalOcean Managed PostgreSQL by default. Follow the shared runbook in [../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) instead of duplicating provider-specific steps here. The root `bun run deploy:do:specs` command generates concrete App Platform specs safely under `.scratch/deploy`; do not hand-substitute secrets or URLs into specs. If the user explicitly chooses Yandex Cloud, use [../docs/YANDEX_CLOUD.md](../docs/YANDEX_CLOUD.md).

## Auth API

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/token/register`
- `POST /api/auth/token/login`
- `POST /api/auth/token/refresh`
- `POST /api/auth/token/logout`
- `POST /api/auth/password-reset/request`
- `POST /api/auth/password-reset/confirm`
- `PATCH /api/users/me`
- `GET /api/admin/dashboard`
- `GET /api/admin/users`
- `PATCH /api/admin/users/:userId/role`
- `GET /openapi.json`
- `GET /health/live`
- `GET /health/ready`

Passwords are hashed through `Bun.password` with Argon2id. Access tokens are short-lived JWTs through `jose`. Initial refresh tokens are random; rotated successors are opaque, domain-separated HMAC values derived with the server secret so concurrent uses of the same credential receive the same successor. Only current and immediately previous SHA-256 hashes are stored in the database. Refresh atomically rotates the credential inside the same logical session, so another browser tab's still-valid access token is not revoked. Reuse of the previous credential after the short race-tolerance window revokes that session as potentially compromised.

Password reset uses a random 32-byte, 30-minute token. Only its SHA-256 hash is stored, requests are limited to one token per account per minute, and account lookup plus email delivery run after the generic response so response timing does not reveal whether an email exists. The API runtime drains accepted background tasks during graceful shutdown; every task has a deadline, server and task draining share one absolute shutdown deadline, and email adapters must honor the supplied `AbortSignal`. Timed-out work stays tracked while abort cleanup settles inside the remaining shutdown budget. Delivery remains best-effort across abrupt process loss, so clients keep the generic retryable experience. A failed reset email invalidates its token and is reported through the background-task error boundary. A successful confirmation atomically changes the Argon2id password hash, consumes every outstanding reset token, revokes every active session, clears the browser refresh cookie, and does not sign the user in automatically. Reset links place the raw token in the URL fragment so it is not sent in the initial HTTP request or referrer. Scheduled auth cleanup removes expired reset-token rows.

Every password registration and new social account is created with role `user`;
clients cannot submit a role. `UserDto` includes the current `user | admin` role,
but access JWTs do not. Authenticated requests load the active session and user
from PostgreSQL, so a role change takes effect without waiting for a token to
expire. All `/api/admin/*` routes apply the same server-side `403 FORBIDDEN`
guard.

The users module owns self-service profile updates, safe admin summaries,
dashboard counts, and role changes. A role change is serialized in PostgreSQL,
cannot demote the acting administrator or leave the system without an
administrator, and revokes every session of the affected user only when the role
actually changes. Role/bootstrap authority changes and existing-account session
issuance share a per-user fence; login re-reads the current user and re-verifies
the password before inserting a session.
Admin list responses expose only `id`, `email`, `displayName`,
`role`, and `createdAt`.

## Architecture

`src/index.ts` only starts the API server. `src/runtime.ts` loads env and creates the Prisma client for API, worker, and cron entrypoints. `src/app.ts` is the composition root. Product contexts live under `src/modules/<context>` and expose only `index.ts` across context boundaries. Auth is the authentication/principal golden path; the separate users context owns profiles, admin directory reads, and role policy. `transport` owns Hono/HTTP, `application` owns use cases and ports, optional `domain` code stays pure, and `infrastructure` owns Prisma and token/password adapters. Route factories capture dependencies in closures; request context contains only the authenticated principal. Run `bun run architecture:check` to enforce these dependency rules. `src/db.ts` normalizes DigitalOcean Managed PostgreSQL URLs that use `sslmode=require` so the Prisma PostgreSQL adapter uses libpq-compatible TLS handling.

The storage service lives in `src/storage` and wraps DigitalOcean Spaces through S3-compatible SDK calls. Product-specific upload routes should validate ownership and permissions, then delegate object key generation, presigned upload/download URLs, public CDN URL construction, and deletion to that service.

Prisma migration SQL is not written by hand. Change `prisma/schema.prisma`, then run `bun run prisma:migrate`.

## Current Upstream Documentation

For backend framework, ORM, auth, validation, and runtime questions, consult the current upstream documentation linked here first. This README describes this backend's conventions; upstream docs are authoritative for API behavior.

- [Bun docs](https://bun.sh/docs)
- [Hono docs](https://hono.dev/docs)
- [Hono Zod OpenAPI example](https://hono.dev/examples/zod-openapi)
- [Prisma docs](https://www.prisma.io/docs)
- [Prisma migrations](https://www.prisma.io/docs/orm/prisma-migrate)
- [PostgreSQL docs](https://www.postgresql.org/docs/)
- [Zod docs](https://zod.dev/)
- [jose documentation](https://github.com/panva/jose)
- [Docker Compose docs](https://docs.docker.com/compose/)
- [PostgreSQL Docker Official Image](https://hub.docker.com/_/postgres)
- [DigitalOcean Spaces docs](https://docs.digitalocean.com/products/spaces/)
- [DigitalOcean Spaces CDN docs](https://docs.digitalocean.com/products/spaces/how-to/enable-cdn/)
