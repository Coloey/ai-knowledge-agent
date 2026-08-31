FROM node:24.14.0-bookworm-slim AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/package.json
RUN pnpm install --frozen-lockfile --filter @agent/backend...

FROM dependencies AS build
COPY apps/backend apps/backend
RUN pnpm --filter @agent/backend build

FROM node:24.14.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /workspace

COPY --from=dependencies /workspace/node_modules ./node_modules
COPY --from=dependencies /workspace/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=build /workspace/apps/backend/dist ./apps/backend/dist
COPY --from=build /workspace/apps/backend/drizzle ./apps/backend/drizzle
COPY --from=build /workspace/apps/backend/package.json ./apps/backend/package.json

WORKDIR /workspace/apps/backend
USER node
EXPOSE 8000
CMD ["node", "dist/main.js"]
