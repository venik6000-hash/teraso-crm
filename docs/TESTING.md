# Testing

The goal of this template's tests is to show future agents where behavior should be verified and how to keep E2E broad enough to protect valuable behavior without turning it into exhaustive matrices.

## Pyramid

- Contracts/unit: shared Zod schema matrices, env parsing, JWTs, password hashing, client API refresh/retry behavior, and token cleanup.
- Backend integration: refresh-token rotation and replay detection, one-time password reset and session revocation, auth/role guards, profile updates, serialized administrator role changes, duplicate registration, concurrency, and stable error shapes through real routes and PostgreSQL.
- Webapp Playwright: valuable browser flows through a real backend and Vite UI.
- Mobile Maestro: lives on the `mobile` branch with the runnable Expo app.

Client E2E should cover valuable user journeys, including non-happy-path states that protect real product behavior, when they can stay stable. Important edge cases must be covered at some automated level; choosing integration, contract, or unit coverage instead of E2E is not permission to skip them. Negative validation matrices, combinatorial edge cases, concurrency, and pure rules belong in unit/integration tests.

## Choosing Test Level

Default to the highest useful behavioral boundary:

- Use E2E when the risk is user-visible and crosses client/backend boundaries: critical journeys, auth/session restore, persistence, navigation, high-risk regressions, and important empty/error states.
- Use backend integration for API/auth/persistence/contracts, stable error shapes, validation behavior, concurrency, and database-backed domain rules.
- Use contract/unit tests selectively for shared schema matrices, pure rules with many branches, env parsing, security/token helpers, password hashing, and client retry/cache/token cleanup behavior that would be brittle or expensive in E2E.

For TDD-first work, list the expected behavior and important edge cases before implementation, then write the first failing test at the boundary that best catches the regression. Important edge cases include validation boundaries, permission failures, expired sessions, empty data, duplicate or conflicting writes, retry/recovery paths, and persistence after refresh or restart.

Do not add E2E coverage just because a branch exists. Add it when it prevents a plausible product regression and can stay stable through explicit setup, stable selectors/test IDs, isolated test data, and deterministic assertions. Do not skip important edge cases just because they are not E2E-worthy; cover them through integration, contract, or unit tests. Keep exhaustive validation matrices and combinatorial edge cases out of E2E.

## Backend

```bash
docker compose version
docker info
cp backend/.env.example backend/.env
docker compose --env-file backend/.env up -d postgres
bun run test
bun run test:contracts
bun run test:backend
bun run test:backend:integration
bun run test:webapp
bun run --cwd backend prisma:validate
bun run smoke:backend:docker
```

Contract tests live in `packages/contracts/src/*.test.ts` and protect shared request/response/error schemas used by backend and webapp. Webapp unit tests live in `webapp/tests` and cover API refresh/retry behavior that would be too expensive and brittle to fully exercise in E2E. The `mobile` branch extends this same contract/testing model for Expo.

Backend tests live next to their owning product modules. Integration tests exercise auth and users/admin RBAC through application/transport boundaries and real PostgreSQL persistence. The integration runner starts `postgres_test`, applies migrations, and covers session rotation, role guards, profile validation, last-admin/concurrent-demotion safety, role-change session revocation, seed idempotence, and stable error shapes. By default, the test database port is derived from the absolute repository path so parallel checkouts do not collide, and `TEST_DATABASE_URL` is derived from that port. Set `POSTGRES_TEST_PORT` and `TEST_DATABASE_URL` only when a fixed test database is required. Local database startup, credentials, and reset behavior are documented in [LOCAL_DATABASE.md](LOCAL_DATABASE.md).

The integration and Docker smoke runners refuse database names that do not end with `_test` unless an override is set intentionally. This protects `teraso_crm` development data from test writes.

The Docker smoke test builds the backend image, starts it against `postgres_test`, waits for `/health/ready`, and removes only the smoke container it created.

`.github/workflows/ci.yml` runs typecheck, deployment/script tests, contract tests, webapp client tests, backend tests, and the webapp Playwright smoke flow on pushes to `main` and `master` plus pull requests.

## Webapp E2E

Playwright is configured in `webapp/playwright.config.ts`.

First-time setup:

```bash
docker compose version
docker info
cp backend/.env.example backend/.env
bun run --cwd webapp e2e:install
bun run e2e:webapp
```

If `docker compose version` or `docker info` fails, install/start Docker first by following [LOCAL_DATABASE.md](LOCAL_DATABASE.md). Do not replace this with native PostgreSQL for new users.

The webapp E2E flow:

- starts `docker compose up -d postgres_test` unless `E2E_SKIP_DOCKER=1` is set;
- chooses repository-derived ports by default, and automatically moves to the nearest free ports if those are already occupied;
- generates the Prisma client and applies migrations;
- seeds a login-capable E2E administrator without exposing its credentials to the browser bundle;
- uses `TEST_DATABASE_URL` as the primary database URL, then passes that value to the backend as `DATABASE_URL` inside the test run;
- starts the backend on `E2E_BACKEND_PORT`, which defaults to a repository-derived port;
- starts Vite on `E2E_WEB_PORT`, which defaults to a repository-derived port;
- stops its `postgres_test` compose project and removes the test volume after the run unless `E2E_KEEP_DOCKER=1` is set;
- runs the user path: validation -> register -> `/app` sidebar -> refresh -> profile persistence -> logout/login safe return;
- runs the administrator path: seeded login -> `/admin` sidebar -> cross-role redirects -> search/promotion -> target session revocation -> admin login;
- restores one logical browser session concurrently in two tabs, propagates confirmed logout and bootstrap-error recovery, and converges both tabs on the winning session after competing account changes.

Useful env:

```bash
TEST_DATABASE_URL="postgresql://superuser:superpassword@localhost:<test-port>/teraso_crm_test?schema=public"
POSTGRES_TEST_PORT=<test-port>
E2E_BACKEND_PORT=<backend-port>
E2E_WEB_PORT=<web-port>
E2E_SKIP_DOCKER=1
E2E_KEEP_DOCKER=1
```

By default, Playwright computes `POSTGRES_TEST_PORT` from the absolute repository path and refuses to run against a database that does not use the `_test` suffix. This prevents E2E from accidentally writing to development or production data. Use `DATABASE_URL` only as a low-level override; `TEST_DATABASE_URL` is the documented test entry point.

Playwright artifacts live in `webapp/e2e/.artifacts/` and are not committed. For interactive debugging:

```bash
bun run --cwd webapp e2e:ui
```

## Mobile Maestro E2E

The default branch intentionally does not contain the runnable Expo app or Maestro runner. Use the `mobile` branch for mobile E2E setup, dev-client guidance, stable React Native `testID` selectors, and `bun run --cwd mobile e2e:maestro:audit`.

## Current Upstream Documentation

For testing questions, consult the current upstream documentation linked here first. This document describes this repository's testing contract; upstream docs are authoritative for runner behavior.

- Playwright intro: https://playwright.dev/docs/intro
- Playwright `webServer`: https://playwright.dev/docs/test-webserver
- Playwright `baseURL`, traces, screenshots, and video: https://playwright.dev/docs/test-use-options
- Playwright CLI and browser install: https://playwright.dev/docs/test-cli and https://playwright.dev/docs/browsers
- Docker Compose: https://docs.docker.com/compose/
- PostgreSQL Docker Official Image: https://hub.docker.com/_/postgres
