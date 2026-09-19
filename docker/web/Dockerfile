# BrinnPay web — local development container (Phase 2).
#
# Runs `next dev` with the source mounted from the host for hot reload.

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

RUN pnpm install --frozen-lockfile

WORKDIR /app/apps/web

EXPOSE 3001

CMD ["pnpm", "dev"]