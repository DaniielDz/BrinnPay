# BrinnPay API — local development container (Phase 2).
#
# Runs `nest start --watch` with the source mounted from the host for hot
# reload. node_modules is installed inside the image (the host mount overlaps
# only the source directories, not the workspace dependencies).

FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH

RUN corepack enable \
  && corepack prepare pnpm@12.4.1 --activate

WORKDIR /app

# Install workspace dependencies (lockfile is the single source of truth).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/prisma.config.ts

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @brinnpay/api prisma:generate

WORKDIR /app/apps/api

EXPOSE 3000

CMD ["pnpm", "dev"]