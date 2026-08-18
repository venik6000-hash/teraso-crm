# Teraso CRM

Teraso CRM is the internal sales CRM for Teraso (teraso.com.ua), a Ukrainian decking company. One repository holds a Bun/Hono backend, a React CSR browser client (`webapp`), and shared API contracts. The interface language is Russian.

This repository was initialized from the [Vibe Coding Template](https://github.com/di-sukharev/vibe) by Dima Sukharev and keeps its Apache-2.0 [LICENSE](LICENSE) and [NOTICE](NOTICE) attribution. Setup is complete: this is a real project, not a fresh template checkout.

## Project Setup Decisions

- Project name and slug: `teraso-crm`. The development database is `teraso_crm`, the test database is `teraso_crm_test`, the refresh cookie prefix is `teraso_crm`, and the OpenAPI title is `Teraso CRM API`.
- Identifier separator convention, so new identifiers do not drift: use kebab + colon for cryptographic domain separators (`teraso-crm:refresh-rotation:v1`), and `teraso_crm_*` snake case for browser storage keys, cookies, and cache names (`teraso_crm_refresh`, `teraso_crm_theme`). Package scopes are kebab (`@teraso-crm/*`); PostgreSQL databases are snake (`teraso_crm`).
- Active surfaces are `webapp`, `backend` and `packages/contracts`.
- Deferred surfaces are `website` and `mobile`. They stay on disk untouched; do not configure, run, or extend them until they are explicitly requested.
- PostgreSQL runs locally through Docker Compose. Start the `postgres` service by hand; the `postgres_test` service belongs to the test runners and must never be started manually. See "Local PostgreSQL And The Compose Project Trap". There is no native PostgreSQL install and no cloud database in local development.
- The CRM is deployed. It runs on its own VPS behind `https://crm.teraso.com.ua`, released by copying the committed tree to the server and rebuilding there — not from DigitalOcean App Platform, whose `.do/` specs stay committed as one option for a later move. Production secrets were generated on the server and have never left it. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for what is running and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the App Platform path.
- The code is published as the **private** GitHub repository `venik6000-hash/teraso-crm`. Private is the requirement, not the default: `docs/` describes the production server's layout, backup schedule, rate limits and known weak spots.
- Validation scope for the active surfaces: `bun run test:contracts`, `bun run architecture:check`, `bun run test:deploy`, `bun run test:backend`, `bun run test:webapp`, and `bun run typecheck`. `test:deploy` is the only suite covering `scripts/repo-env.test.mjs` and `scripts/architecture-check.test.mjs`, and CI runs it.
- Business rules that apply repository-wide: all UI copy, stage labels, task types, loss reasons, and validation feedback are in Russian; the business time zone is Europe/Kyiv; money is stored as PostgreSQL `Decimal(14,2)` and exposed as decimal strings in UAH.
- A deal leaves the working funnel in one of two ways, and they are not interchangeable. **«Архив»** is the reversible one: the deal leaves the board and stops demanding a next step, while its amounts, tasks and timeline stay put, it remains findable by the «Этап: Архив» filter, and «Переоткрыть» returns it to «Новая заявка». It is deliberately neither a board column nor a funnel step, so archiving never shifts a conversion rate or a reported period's revenue. **«Удалить»** is the irreversible one and the only destructive action in the product: `DELETE /api/crm/deals/{dealId}` erases the deal, its tasks, its attribution, its ingestion receipts and its whole timeline, which also removes its payments from the dashboard and frees its `[source, externalId]` so a re-delivered lead would arrive as new. The client record always survives. Clients, and tasks or timeline entries on their own, still have no delete endpoint at all, and `ON DELETE RESTRICT` on `deal_activities` and `ingestion_receipts` still makes every *other* deletion path fail loudly — the delete endpoint steps through it explicitly inside one transaction. See [docs/OPERATIONS.md](docs/OPERATIONS.md).
- The CRM product surface is administrator-only; the account area is not. Deals, the funnel, tasks, the dashboard, deal cards and notifications require the `admin` role, enforced at the API with `requireAdmin` (a signed-in `user` gets `403`) and not only in the interface, which does not offer those sections. `/app`, `/app/profile` and `/app/settings` stay open to any signed-in account. Every role therefore lands on `/app` after signing in, but that means two different things: for the owner — the administrator of the only account a Teraso deployment really has — it is the entrance to the CRM, with `/admin` one click away in the sidebar for the rare account change; for anybody else it is the whole of what they can open.
- The dashboard's «Задач на сегодня» and «Просроченных задач» tiles count tasks (PRD 7.8) and link to `/app/tasks`. One deal can carry several tasks, so a deal-filtered list would show a different number from the one that was clicked.
- `backend/.env` and `webapp/.env` are local-only files created from their `.env.example` siblings. They are gitignored and must never be committed.

## What's Inside

- `backend` - Bun + Hono + Prisma + PostgreSQL, custom JWT auth, Zod validation, and OpenAPI output.
- `webapp` - React + Vite + TanStack Query/Form/Router CSR browser client with the baseline auth flow.
- `packages/contracts` - shared Zod schemas and TypeScript API types.
- `docker-compose.yml` - local PostgreSQL 18 through the official `postgres:18-alpine` image on port `54329`; test runners use a repository-derived port by default, or `POSTGRES_TEST_PORT` when set. PostgreSQL 18 is intentional because the backend schema uses strict database-generated UUIDv7 IDs.
- `docs/TESTING.md` - the backend and Playwright testing contract, including the CRM end-to-end journey.
- `docs/CRM_INTEGRATION.md` - the signed quiz-lead webhook contract for `teraso.com.ua`.
- `docs/OPERATIONS.md` - the operator runbook: production variable names, the scheduler, verifying the site integration, backups and incident recovery, and known defects.
- `docs/LOCAL_DATABASE.md` - cross-platform local PostgreSQL setup for Windows, macOS, and Linux.
- `website` - a separate Astro project for public SSG/SSR pages. **(deferred surface)**
- `mobile/README.md` - a pointer to the upstream template's Expo mobile line. **(deferred surface)** This repository has a single branch, `main`; the `mobile` branch it describes exists only in the upstream template repository, which is not configured as a remote here.
- `.do` - committed DigitalOcean App Platform spec templates. **(deployment is out of MVP scope)**
- `docs/STORAGE.md` - DigitalOcean Spaces, CDN, uploads, and image/media storage rules. **(deployment is out of MVP scope)**
- `docs/YANDEX_CLOUD.md` - optional Yandex Cloud deployment path. **(deployment is out of MVP scope)**

## Browser Surfaces: `webapp` Only

**This decision is already made. Build every screen in `webapp`.** Teraso CRM is an internal tool: every screen sits behind sign-in, nothing needs to be indexed by search engines or preview nicely when shared, so client-side rendering is the right and cheaper fit. Do not add pages to `website`, and do not weigh the two surfaces against each other when planning a feature.

`website` (Astro) is deferred and stays on disk unconfigured. The upstream template's rule for it — public, search-indexable, link-previewed pages belong in Astro; behind-login screens belong in React CSR — is recorded here only so a future public marketing site can be decided deliberately. Until someone explicitly asks for that site, the rule has no bearing on this project: there are no public pages in the MVP.

## Quick Start

Install dependencies first:

```bash
bun install
```

Docker runs the local PostgreSQL for this project, so check it before any database-backed work:

```bash
docker compose version
docker info
```

If either command fails, install and start Docker before continuing:

- Windows: install Docker Desktop, enable the WSL 2 backend, start Docker Desktop, then rerun `docker compose version` and `docker info`.
- macOS: install and start Docker Desktop, or another Docker Engine with Compose v2, then rerun `docker compose version` and `docker info`.
- Linux: install Docker Engine and the Docker Compose plugin, start the Docker service, then rerun `docker compose version` and `docker info`.

Do not switch to native PostgreSQL. The documented local path for this project is Docker Compose.

### Database, Migrations, And The Local Administrator

Create the backend env file:

```bash
# macOS, Linux, or Git Bash on Windows
cp backend/.env.example backend/.env
```

```powershell
# Windows PowerShell
Copy-Item backend/.env.example backend/.env
```

Then start PostgreSQL with that app-local env file. Start `postgres` and nothing else:

```bash
docker compose --env-file backend/.env pull postgres
docker compose --env-file backend/.env up -d postgres
```

Then generate the Prisma client and apply migrations. `prisma:generate` is required on a fresh checkout: without it the seed and every backend entrypoint fail with `Cannot find module './generated/prisma/client'`.

```bash
bun run --cwd backend prisma:generate
bun run --cwd backend prisma:deploy
```

There is no registration: the CRM serves one company, so accounts are created
against a deployment rather than by whoever reaches the sign-in page. The seeded
administrator is what opens the product. To make it usable, set
`ADMIN_SEED_PASSWORD` in `backend/.env`, then run the idempotent seed:

```bash
bun run --cwd backend prisma:seed
```

Without a seed password, `admin@example.com` is still created as `admin`, but its
password credential remains locked. Re-running the seed without a password never
clears an existing password hash; re-running it with the already configured
password preserves existing sessions.

### Local PostgreSQL And The Compose Project Trap

**Start `postgres` by hand. Never start `postgres_test` by hand.** Both services live in the same `docker-compose.yml`, but they are owned by different Docker Compose projects at runtime, and starting the test service manually breaks the test suite.

- `docker compose --env-file backend/.env ...` uses the **directory-derived** project name. In this checkout the directory is `CRM Teraso`, so the project is `crmteraso` and the dev container is `crmteraso-postgres-1` on port `54329`. The development data — applied migrations and the seeded administrator — lives in the `crmteraso_postgres_18_data` volume owned by that project.
- The test runners (`test:backend:integration`, `smoke:backend:docker`, `e2e:webapp`) use the **repository-hash-derived** project name from `scripts/repo-env.mjs`, currently `teraso-crm-<repohash>`. They bring up their own `postgres_test`, choose its port, apply migrations to `teraso_crm_test`, and own its lifecycle.

Two consequences worth internalizing:

- Running `docker compose --env-file backend/.env up -d postgres_test` binds host port `54330` under the `crmteraso` project. The runner then tries to bind the same port under its own project and dies with `Bind for 127.0.0.1:54330 failed: port is already allocated`. If you ever see that error, remove the container you created by mistake — and only that one: `docker compose --env-file backend/.env rm -f -s -v postgres_test`. This removes an anonymous-volume-free container you started in error; it is not the forbidden practice of killing a process to free a port. Never force-remove a container you did not start.
- Never pass an explicit `-p` flag to the manual dev commands. A different project name silently creates a *second, empty* development database with no error, and the seeded administrator appears to vanish.

To reset local development data, follow "Reset Local Data" in [docs/LOCAL_DATABASE.md](docs/LOCAL_DATABASE.md). Never run `docker compose down -v` against the dev project casually; it destroys the seeded administrator and every applied migration.

### Run The Active Surfaces

Start the surfaces you need in separate terminals:

```bash
bun run dev:backend
bun run dev:webapp
```

The webapp's login/session journey requires the backend and PostgreSQL, so run both together. `bun run dev:website` starts the deferred Astro surface and is not part of this project's workflow.

Create `webapp/.env` when the browser client should use a non-default API URL:

```bash
VITE_API_URL=http://localhost:3000
```

## Workspace Commands

- `bun run dev` - start all workspace projects in parallel dev mode.
- `bun run dev:backend` - start the backend API.
- `bun run dev:webapp` - start the Vite CSR webapp.
- `bun run dev:website` - start the Astro website project. **(deferred surface)**
- `bun run typecheck` - run TypeScript checks across workspaces.
- `bun run build` - run production build/typecheck/export scripts for workspaces that define them.
- `bun run test` - run contract, backend, and webapp unit/integration tests.
- `bun run test:contracts` - run shared Zod contract tests.
- `bun run test:backend` - run backend unit and integration tests.
- `bun run test:backend:integration` - run DB-backed auth tests through a runner-owned `postgres_test`.
- `bun run test:webapp` - run webapp client tests.
- `bun run test:website` - run Astro website tests. **(deferred surface)**
- `bun run deploy:do:specs` - generate concrete DigitalOcean specs under `.scratch/deploy`. **(deployment is out of MVP scope)**
- `bun run e2e:webapp` - run the Playwright suite (auth, RBAC, and the CRM quiz-lead journey) through backend + Vite.
- `bun run e2e:webapp -- --grep "quiz lead reaches success"` - run only the CRM end-to-end journey.
- `bun run --cwd backend prisma:generate` - generate the Prisma client. Required on a fresh checkout.
- `bun run --cwd backend prisma:migrate` - create/apply a Prisma migration in development.
- `bun run --cwd backend prisma:deploy` - apply existing Prisma migrations on a server.
- `bun run --cwd backend prisma:seed` - idempotently create or unlock the local administrator.
- `bun run seed:demo` - fill the local database with ten fictional leads and the history around them, so every screen has something to show. It writes through the real ingestion path and CRM services, is idempotent (a second run adds nothing), refuses to run with `NODE_ENV=production`, and creates two credential-less colleague accounts so the «ответственный» picker has people in it.
- `bun run --cwd backend db:deploy` - production pre-deploy: migrate, optionally bootstrap the first administrator, and require a login-capable administrator.

## Project READMEs

- [backend/README.md](backend/README.md) - API, auth, Prisma, and backend validation.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) - running the CRM: production variable names, the notification scheduler, verifying the site webhook, backups and incident recovery, and known defects.
- [docs/CRM_INTEGRATION.md](docs/CRM_INTEGRATION.md) - the signed quiz-lead webhook contract for the site.
- [docs/LOCAL_DATABASE.md](docs/LOCAL_DATABASE.md) - Docker Compose PostgreSQL setup and reset workflow.
- [webapp/README.md](webapp/README.md) - CSR browser client setup, env, and Playwright smoke.
- [packages/contracts/README.md](packages/contracts/README.md) - shared schema and DTO rules.
- [docs/STORAGE.md](docs/STORAGE.md) - DigitalOcean Spaces, CDN, uploads, and image/media storage rules. **(deployment is out of MVP scope)**
- [docs/YANDEX_CLOUD.md](docs/YANDEX_CLOUD.md) - optional Yandex Cloud deployment path. **(deployment is out of MVP scope)**
- [website/README.md](website/README.md) - Astro website commands, hybrid rendering, and publishing model. **(deferred surface)**
- [mobile/README.md](mobile/README.md) - pointer to the upstream template's mobile branch. **(deferred surface)**

## License

This project is licensed under the Apache License 2.0. If you distribute a fork, copy, or derivative work, keep both [LICENSE](LICENSE) and [NOTICE](NOTICE) with the attribution to Dima Sukharev, GitHub profile, and the original repository.

## Architecture Notes

API contracts live in `packages/contracts` and are imported by every active layer. The backend validates input with those Zod schemas, and the webapp client reuses the same schemas in TanStack Form and API calls. `UserDto.role` is the shared `user | admin` role contract; authorization uses the current database record rather than a role embedded in JWT claims.

The backend API flow is `route -> validation -> auth/session guard -> service -> Prisma -> DTO`. Routes stay thin, auth business logic lives in the feature service, and API, worker, and cron entrypoints share `src/runtime.ts` for env and Prisma setup.

Keep the default architecture monolithic. The rest of this paragraph describes production deployment, which is **out of MVP scope**; it is retained for a later release decision. For DigitalOcean production, the backend/API default is one `apps-s-1vcpu-1gb` App Platform container so a new project starts inside the expected low-cost budget with Managed PostgreSQL while retaining a clear scale-up path. Add backend worker or scheduled-job components from the same Docker image only when a concrete background or periodic task exists; the deployment generator refuses to deploy the empty worker placeholder. For real-time features, a single backend instance can own its local WebSocket connections. If the backend is horizontally scaled and users connected to different instances must receive the same chat, presence, or live events, add a managed Redis-compatible Pub/Sub broker between instances, using DigitalOcean Managed Valkey on the default path or Yandex Managed Service for Valkey when Yandex Cloud is explicitly selected.

Ongoing engineering guidance lives in [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/TESTING.md](docs/TESTING.md), and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Running the system — required variable names, the notification scheduler, verifying the site webhook, backups, and known defects — lives in [docs/OPERATIONS.md](docs/OPERATIONS.md). This README owns the project's durable decisions and local setup: see "Project Setup Decisions" and "Quick Start".

## Current Upstream Documentation

For framework, API, deployment, or testing questions, consult the current upstream documentation linked here first. The repository docs describe this project's conventions; the linked docs are the authoritative source for tool behavior and provider-specific changes.

- Runtime and package manager: [Bun docs](https://bun.sh/docs)
- Backend framework: [Hono docs](https://hono.dev/docs)
- Database ORM: [Prisma docs](https://www.prisma.io/docs) and [PostgreSQL docs](https://www.postgresql.org/docs/)
- Validation and contracts: [Zod docs](https://zod.dev/)
- JWT library: [jose documentation](https://github.com/panva/jose)
- Web stack: [React docs](https://react.dev/reference/react), [Vite guide](https://vite.dev/guide/), [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview), [TanStack Form](https://tanstack.com/form/latest/docs/framework/react/quick-start), and [TanStack Router](https://tanstack.com/router/latest/docs/overview)
- Testing: [Playwright docs](https://playwright.dev/docs/intro)
- Website: [Astro docs](https://docs.astro.build/en/getting-started/)
- Local infrastructure: [Docker Compose docs](https://docs.docker.com/compose/) and [PostgreSQL Docker Official Image](https://hub.docker.com/_/postgres)
- Deployment and storage: [DigitalOcean App Platform](https://docs.digitalocean.com/products/app-platform/), [DigitalOcean App specs](https://docs.digitalocean.com/products/app-platform/reference/app-spec/), [DigitalOcean Static Sites](https://docs.digitalocean.com/products/app-platform/how-to/manage-static-sites/), [DigitalOcean Managed Databases in App Platform](https://docs.digitalocean.com/products/app-platform/how-to/manage-databases/), [DigitalOcean Valkey](https://docs.digitalocean.com/products/databases/valkey/), [DigitalOcean Dockerfile builds](https://docs.digitalocean.com/products/app-platform/reference/dockerfile/), [DigitalOcean Bun buildpack](https://docs.digitalocean.com/products/app-platform/reference/buildpacks/bun/), [doctl](https://docs.digitalocean.com/reference/doctl/), [doctl apps spec validate](https://docs.digitalocean.com/reference/doctl/reference/apps/spec/validate/), [DigitalOcean Container Registry](https://docs.digitalocean.com/products/container-registry/), [DigitalOcean Spaces](https://docs.digitalocean.com/products/spaces/), [DigitalOcean Spaces CDN](https://docs.digitalocean.com/products/spaces/how-to/enable-cdn/), and [external CDN in front of App Platform](https://docs.digitalocean.com/products/app-platform/how-to/configure-external-cdn/)
- Optional Yandex Cloud path: [Yandex Cloud CLI](https://yandex.cloud/en/docs/cli/quickstart), [Yandex Serverless Containers](https://yandex.cloud/en/docs/serverless-containers/), [Yandex Container Registry](https://yandex.cloud/en/docs/container-registry/quickstart), [Yandex Managed PostgreSQL](https://yandex.cloud/en/docs/managed-postgresql/), [Yandex Managed Service for Valkey](https://yandex.cloud/en/docs/managed-redis/), [Yandex Object Storage static hosting](https://yandex.cloud/en/docs/storage/operations/hosting/setup), [Yandex Object Storage AWS CLI](https://yandex.cloud/en/docs/storage/tools/aws-cli), [Yandex Cloud CDN](https://yandex.cloud/en/docs/cdn/concepts/), and [Yandex Cloud Marketplace Image Resizer](https://yandex.cloud/en/marketplace/products/yc/image-resizer)
