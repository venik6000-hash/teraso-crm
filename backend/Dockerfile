FROM oven/bun:1.3.14 AS build

WORKDIR /app

# Copy the repository instead of enumerating workspace manifests. The master branch
# intentionally has no mobile package, while the mobile branch does; this build must
# remain valid for both repository shapes.
COPY . .

RUN bun install --frozen-lockfile --filter @teraso-crm/backend

WORKDIR /app/backend

RUN DATABASE_URL="postgresql://superuser:superpassword@localhost:5432/teraso_crm?schema=public" bun run prisma:generate

FROM oven/bun:1.3.14 AS production-dependencies

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile --production --filter @teraso-crm/backend

FROM oven/bun:1.3.14 AS runtime

WORKDIR /app

COPY --from=build /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/backend ./backend

WORKDIR /app/backend

ENV NODE_ENV=production

USER bun

CMD ["bun", "src/index.ts"]
