FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY migrations ./migrations
COPY schemas ./schemas
COPY scripts ./scripts
COPY specification ./specification
COPY agents ./agents
COPY tests ./tests
RUN pnpm install --no-frozen-lockfile
RUN pnpm typecheck && pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
COPY --from=build /app /app
COPY ops/entrypoint.sh /usr/local/bin/agent-foundry-entrypoint
RUN chmod +x /usr/local/bin/agent-foundry-entrypoint
ENTRYPOINT ["/usr/local/bin/agent-foundry-entrypoint"]
CMD ["pnpm","--filter","@agent-foundry/api","start"]
