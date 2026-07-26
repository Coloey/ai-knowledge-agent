FROM node:20-alpine AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/smart-bar/package.json packages/smart-bar/package.json

RUN pnpm install --no-frozen-lockfile

COPY apps apps
COPY packages packages

ARG API_BASE_URL=/api
ENV API_BASE_URL=${API_BASE_URL}

RUN pnpm --filter @agent/web build

FROM nginx:1.27-alpine

COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
