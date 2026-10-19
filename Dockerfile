FROM node:22.23.2-bookworm-slim AS dependencies

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace

RUN corepack enable \
  && corepack prepare pnpm@11.1.3 --activate \
  && groupadd --gid 10001 promptlab \
  && useradd --uid 10001 --gid promptlab --create-home --shell /usr/sbin/nologin promptlab

COPY . .

RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @promptlab/web build

FROM dependencies AS app-runtime

RUN apt-get update \
  && apt-get install --yes --no-install-recommends bubblewrap ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --no-audit --no-fund @openai/codex@0.160.1 \
  && mkdir -p /var/lib/promptlab/data /var/lib/promptlab/provider-ledger /home/promptlab/.local/share/promptlab/codex-auth \
  && install -o promptlab -g promptlab -m 0600 /workspace/docs/PROVIDER_SMOKE_LEDGER.json /var/lib/promptlab/provider-ledger/PROVIDER_SMOKE_LEDGER.json \
  && chown -R promptlab:promptlab /workspace/apps/web/.next /var/lib/promptlab /home/promptlab \
  && chmod 0700 /home/promptlab/.local/share/promptlab/codex-auth

ENV HOME=/home/promptlab \
  NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1

USER 10001:10001

FROM app-runtime AS web
WORKDIR /workspace/apps/web
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]

FROM app-runtime AS worker
WORKDIR /workspace/apps/worker
CMD ["node", "--import", "tsx/esm", "src/main.ts"]

FROM dependencies AS migrate
ENV HOME=/home/promptlab NODE_ENV=production
USER 10001:10001
WORKDIR /workspace/packages/db
CMD ["node", "--import", "tsx/esm", "src/migrate.ts"]
